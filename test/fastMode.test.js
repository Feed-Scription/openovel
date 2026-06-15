import assert from "node:assert/strict"
import test from "node:test"

import { foregroundNarratorContract } from "../src/prompts/agentContracts.js"
import { buildNarratorMessages, optionsSystemPrompt, proseCharCount, previousNarrationProseChars } from "../src/lib/narrator.js"
import {
  buildStorykeeperTurnContext,
  renderStorykeeperTurnContextMarkdown,
  storyModeContextNote,
} from "../src/workflows/storykeeperContext.js"

test("fast narrator contract states the register and keeps the no-options rule", () => {
  const fast = foregroundNarratorContract({ fast: true })
  const base = foregroundNarratorContract()
  assert.match(fast, /FAST REGISTER/)
  assert.match(fast, /300 to 500/)
  assert.match(fast, /decision/i)
  // The default contract carries none of it.
  assert.ok(!base.includes("FAST REGISTER"))
  // Fast mode keeps (and reinforces) the no-choice-menu rule.
  assert.match(fast, /choice menu/)
  // Comic wins over fast: the panel-script register has its own pacing.
  const comic = foregroundNarratorContract({ comic: true, fast: true })
  assert.ok(!comic.includes("FAST REGISTER"))
  assert.match(comic, /panel script/)
})

test("model-facing fast-mode strings carry no em dash (LLM tell)", () => {
  const strings = [
    foregroundNarratorContract({ fast: true }),
    optionsSystemPrompt({ fastMode: true }),
    storyModeContextNote("fast") || "",
    buildNarratorMessages({ action: "走", compiledContext: {}, fastMode: true })[0].content,
  ]
  for (const s of strings) {
    // Only the NEW fast-mode lines are under our control; check them rather
    // than legacy lines: every fast-gated addition mentions its register.
    const fastLines = s.split("\n").filter((l) => /fast mode|fast register|fast pacing/i.test(l))
    assert.ok(fastLines.length >= 1)
    for (const line of fastLines) assert.ok(!line.includes("—"), `em dash in: ${line.slice(0, 80)}`)
  }
})

test("fast narrator messages flip the progression default to montage compression", () => {
  const fast = buildNarratorMessages({ action: "走", compiledContext: {}, fastMode: true })[0].content
  const base = buildNarratorMessages({ action: "走", compiledContext: {} })[0].content
  assert.match(fast, /FAST REGISTER/)
  assert.match(fast, /montage-style compression toward the next meaningful decision is the default/)
  // The default beat-by-beat progression rule is replaced, not duplicated.
  assert.ok(!fast.includes("stay within the continuous present moment and advance beat by beat"))
  assert.match(base, /stay within the continuous present moment and advance beat by beat/)
  assert.ok(!base.includes("FAST REGISTER"))
  // Comic mode is unchanged by the fast flag.
  const comic = buildNarratorMessages({ action: "走", compiledContext: {}, comicMode: true, fastMode: true })[0].content
  assert.ok(!comic.includes("FAST REGISTER"))
  assert.match(comic, /ovl:panel/)
})

test("options system prompt carries the fast addendum only in fast mode", () => {
  const fast = optionsSystemPrompt({ fastMode: true })
  const base = optionsSystemPrompt()
  assert.match(fast, /FAST REGISTER/)
  assert.match(fast, /strategy-level decisions/)
  assert.ok(!base.includes("FAST REGISTER"))
  // Mechanics stay shared between the two.
  for (const s of [fast, base]) {
    assert.match(s, /Return strict JSON only/)
    assert.match(s, /SPOILER RULE/)
  }
})

test("storykeeper turn context renders a Story Mode section only for fast stories", () => {
  const base = { action: "走", foreground: {}, snapshot: { contextReport: null }, memorySnapshot: null, registry: null }
  const fastMd = renderStorykeeperTurnContextMarkdown(buildStorykeeperTurnContext({ ...base, storyMode: "fast" }))
  const proseMd = renderStorykeeperTurnContextMarkdown(buildStorykeeperTurnContext(base))
  assert.match(fastMd, /Story Mode/)
  assert.match(fastMd, /FAST MODE/)
  assert.match(fastMd, /not thin prose/)
  assert.ok(!proseMd.includes("FAST MODE"))
  // The note is fast-only; other modes stay silent.
  assert.equal(storyModeContextNote("comic"), null)
  assert.equal(storyModeContextNote(""), null)
})

test("fast mode echoes the length budget at the end of the user capsule", () => {
  const fast = buildNarratorMessages({ action: "走", compiledContext: {}, fastMode: true })
  const base = buildNarratorMessages({ action: "走", compiledContext: {} })
  const comic = buildNarratorMessages({ action: "走", compiledContext: {}, comicMode: true, fastMode: true })
  const fastUser = fast[1].content
  assert.match(fastUser, /Fast Register Reminder/)
  assert.match(fastUser, /300 to 500/)
  assert.match(fastUser, /hard ceiling 600/)
  // Last-position instruction: the reminder sits AFTER the reader action.
  assert.ok(fastUser.indexOf("Fast Register Reminder") > fastUser.indexOf("Reader Action"))
  // No measured-feedback line without an overrun.
  assert.ok(!fastUser.includes("Measured feedback"))
  assert.ok(!base[1].content.includes("Fast Register Reminder"))
  // Comic mode has its own pacing register; no fast reminder.
  assert.ok(!comic[1].content.includes("Fast Register Reminder"))
  // Model-facing fast strings stay em-dash-free (LLM tell).
  for (const line of fastUser.split("\n")) {
    if (/fast register|measured feedback/i.test(line)) assert.ok(!line.includes("—"), `em dash in: ${line.slice(0, 80)}`)
  }
})

test("fast mode carries measured overrun feedback into the next capsule", () => {
  const fast = buildNarratorMessages({ action: "走", compiledContext: {}, fastMode: true, fastOverrunChars: 882 })
  const user = fast[1].content
  assert.match(user, /Measured feedback/)
  assert.match(user, /882 characters/)
  assert.match(user, /Come in shorter/)
  for (const line of user.split("\n")) {
    if (/measured feedback/i.test(line)) assert.ok(!line.includes("—"), `em dash in: ${line.slice(0, 80)}`)
  }
})

test("proseCharCount excludes control fences and whitespace", () => {
  const text = [
    "```ovl:hud",
    "时序: 贞观末年",
    "```",
    "正文十个字正文十个字。",
    "```ovl:bg",
    "set: story/includes/bg/x.jpg",
    "```",
  ].join("\n")
  assert.equal(proseCharCount(text), 11)
  // A trailing unclosed fence (stream cut) is stripped, not counted as prose.
  assert.equal(proseCharCount("正文。\n```ovl:hud\n时序: 截断"), 3)
  assert.equal(proseCharCount(""), 0)
})

test("previousNarrationProseChars measures the last turn's prose from chapters", () => {
  const chapters = [
    "**读者选择**：开始",
    "",
    "第一回合的旧正文，很长很长。",
    "",
    "**读者选择**：继续",
    "",
    "```ovl:hud",
    "时序: 次日",
    "```",
    "最新回合正文八个字。",
  ].join("\n")
  assert.equal(previousNarrationProseChars({ chapters }), 10)
  // No turns yet → 0 (the opening turn gets no measured-feedback line).
  assert.equal(previousNarrationProseChars({ chapters: "" }), 0)
  assert.equal(previousNarrationProseChars(null), 0)
})
