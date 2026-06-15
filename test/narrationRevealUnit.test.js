import test from "node:test"
import assert from "node:assert/strict"

import { nextRevealUnit, revealUnitDelayMs, insideRichFence } from "../src/runtime/sessionViewModel.js"

test("insideRichFence: true only between an ovl: fence open and its close", () => {
  const text = "散文开头。\n\n```ovl:terminal\n$ run\nok\n```\n\n后续散文。"
  const openIdx = text.indexOf("$ run")
  const afterClose = text.length
  // cursor right after opening fence line → inside
  assert.equal(insideRichFence(text.slice(0, openIdx + 3)), true)
  // before the fence → outside
  assert.equal(insideRichFence("散文开头。\n\n``"), false)
  // after the closing ``` → outside
  assert.equal(insideRichFence(text.slice(0, afterClose)), false)
  // a non-ovl code fence does NOT count
  assert.equal(insideRichFence("```js\nconst x=1"), false)
})

// Walk the whole string the way the revealer does and collect units.
function tokenize(text) {
  const units = []
  let i = 0
  while (i < text.length) {
    const u = nextRevealUnit(text, i)
    units.push({ text: text.slice(i, u.end), kind: u.kind })
    i = u.end
  }
  return units
}

test("Latin reveals one char at a time; spaces collapse; punctuation splits off", () => {
  const units = tokenize("Hi, 90.")
  assert.deepEqual(units, [
    { text: "H", kind: "char" },
    { text: "i", kind: "char" },
    { text: ",", kind: "other" },
    { text: " ", kind: "space" },
    { text: "9", kind: "char" },
    { text: "0", kind: "char" },
    { text: ".", kind: "other" },
  ])
})

test("identifiers/decimals reveal char-by-char (no word/connector batching)", () => {
  assert.deepEqual(tokenize("a_1"), [
    { text: "a", kind: "char" },
    { text: "_", kind: "char" },
    { text: "1", kind: "char" },
  ])
  // a '.' is punctuation, not glued into a word any more
  assert.deepEqual(tokenize("1.0"), [
    { text: "1", kind: "char" },
    { text: ".", kind: "other" },
    { text: "0", kind: "char" },
  ])
})

test("CJK reveals one glyph at a time", () => {
  const units = tokenize("神经网络")
  assert.equal(units.length, 4)
  assert.ok(units.every((u) => u.kind === "cjk"))
})

test("mixed CJK + Latin: both per-character", () => {
  const units = tokenize("没有AI。")
  assert.deepEqual(units, [
    { text: "没", kind: "cjk" },
    { text: "有", kind: "cjk" },
    { text: "A", kind: "char" },
    { text: "I", kind: "char" },
    { text: "。", kind: "other" },
  ])
})

test("delay: cjk and char both paced by cpm; space/punct on next frame", () => {
  const pacing = { cpm: 720, wpm: 240, frameMs: 33 }
  // 60000/720 = ~83ms per visible glyph, regardless of script
  assert.equal(revealUnitDelayMs("cjk", "网", pacing), 83)
  assert.equal(revealUnitDelayMs("char", "a", pacing), 83)
  // whitespace/punctuation advance on the next frame
  assert.equal(revealUnitDelayMs("space", " ", pacing), 33)
  assert.equal(revealUnitDelayMs("other", ".", pacing), 33)
})
