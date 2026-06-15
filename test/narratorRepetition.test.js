import test from "node:test"
import assert from "node:assert/strict"

import { narrationOpeningKey, previousNarrationOpeningKey, createRepetitionGate } from "../src/lib/narrator.js"

// Feed deltas into a gate and capture what reaches the UI + the verdict.
function runGate(prevOpening, deltas, { guard = true } = {}) {
  const shown = []
  const gate = createRepetitionGate({ prevOpening, guard, forward: (s) => shown.push(s) })
  for (const d of deltas) gate.onDelta({ content: d })
  const suppressed = gate.finalize()
  return { shown: shown.join(""), suppressed }
}

test("gate flushes immediately when the first char already differs", () => {
  const r = runGate("光标在屏幕上停了三秒", ["窗", "外传来音乐。"])
  assert.equal(r.suppressed, false)
  assert.equal(r.shown, "窗外传来音乐。") // nothing held back past the divergence
})

test("gate suppresses when the new prose re-matches the whole previous opening", () => {
  const prev = "光标在屏幕上停了三秒"
  const r = runGate(prev, ["光标在屏幕上", "停了三秒，他坐起来。"])
  assert.equal(r.suppressed, true)
  assert.equal(r.shown, "") // reader never saw the repeated attempt
})

test("gate holds the matching prefix, then flushes the whole run on divergence", () => {
  // shares 5 chars then diverges → not a repeat; the held prefix is released
  const r = runGate("光标在屏幕上停了三秒", ["光标在屏幕", "前他猛地坐起来。"])
  assert.equal(r.suppressed, false)
  assert.equal(r.shown, "光标在屏幕前他猛地坐起来。")
})

test("gate is pure passthrough on the final attempt (guard=false)", () => {
  const r = runGate("光标在屏幕上停了三秒", ["光标在屏幕上停了三秒", "（仍然重复，但已用尽重试）"], { guard: false })
  assert.equal(r.suppressed, false)
  assert.equal(r.shown, "光标在屏幕上停了三秒（仍然重复，但已用尽重试）")
})

test("gate with empty prevOpening never gates", () => {
  const r = runGate("", ["任意", "内容"])
  assert.equal(r.suppressed, false)
  assert.equal(r.shown, "任意内容")
})

test("narrationOpeningKey trims and takes the first N chars", () => {
  assert.equal(narrationOpeningKey("  hello world  ", 5), "hello")
  assert.equal(narrationOpeningKey("夜色压低了屋檐", 4), "夜色压低")
  assert.equal(narrationOpeningKey("", 50), "")
  assert.equal(narrationOpeningKey(null, 50), "")
})

test("previousNarrationOpeningKey pulls the last narration block, header stripped", () => {
  const snap = {
    chapters: [
      "**读者选择**：开门",
      "",
      "他推开门，光线涌进来。",
      "",
      "**读者选择**：环顾四周",
      "",
      "夜色压低了屋檐。他猛地坐起来。",
    ].join("\n"),
  }
  // last block's narration, header "**读者选择**：环顾四周" stripped
  assert.equal(previousNarrationOpeningKey(snap, 8), "夜色压低了屋檐。")
})

test("previousNarrationOpeningKey is empty with no prior canon (first turn)", () => {
  assert.equal(previousNarrationOpeningKey({}, 50), "")
  assert.equal(previousNarrationOpeningKey({ chapters: "" }, 50), "")
  assert.equal(previousNarrationOpeningKey({ chapters: "   \n  " }, 50), "")
})

test("repetition detection: equal openings match, divergent openings don't", () => {
  // prev narration is comfortably longer than the 20-char window so the key
  // is a true 20-char prefix (not the whole short string).
  const prev = previousNarrationOpeningKey(
    { chapters: "**读者选择**：开始\n\n光标在屏幕上停了三秒，他猛地坐起来，后脑勺撞上了挡板，疼痛窜过头皮。" },
    20,
  )
  assert.equal(prev.length, 20)
  // a new narration that re-opens with the same 20 chars → match → would retry
  const repeat = narrationOpeningKey("光标在屏幕上停了三秒，他猛地坐起来，后脑勺撞上了挡板，但这次他没有动。", 20)
  assert.equal(repeat, prev)
  // a new narration that opens differently → keys diverge → accepted
  const fresh = narrationOpeningKey("窗外传来广播体操的音乐，他睁开眼，盯着天花板剥落的石灰。", 20)
  assert.notEqual(fresh, prev)
})
