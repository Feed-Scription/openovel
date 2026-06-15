import test from "node:test"
import assert from "node:assert/strict"

import { stripReaderChoiceHeaders } from "../src/context/contextCompiler.js"

test("strips reader-choice headers, leaving continuous prose", () => {
  const canon = [
    "**读者选择**：醒来",
    "",
    "他睁开眼，天还没亮。",
    "",
    "**读者选择**：推开窗",
    "",
    "冷风灌进来。",
  ].join("\n")
  const out = stripReaderChoiceHeaders(canon)
  assert.doesNotMatch(out, /读者选择/)
  assert.equal(out, "他睁开眼，天还没亮。\n\n冷风灌进来。")
})

test("handles the leading blank-line separator from appendChapterText", () => {
  // chapters.md begins with "\n\n" before the first block (see appendChapterText).
  const canon = "\n\n**读者选择**：开始\n\n第一段。"
  assert.equal(stripReaderChoiceHeaders(canon), "第一段。")
})

test("accepts both full-width and half-width colons", () => {
  assert.equal(stripReaderChoiceHeaders("**读者选择**:go\n\nprose"), "prose")
  assert.equal(stripReaderChoiceHeaders("**读者选择**：去\n\n散文"), "散文")
})

test("leaves marker-free prose unchanged (aside from leading trim)", () => {
  assert.equal(stripReaderChoiceHeaders("just prose, no markers"), "just prose, no markers")
})

test("is total over empty / null input", () => {
  assert.equal(stripReaderChoiceHeaders(""), "")
  assert.equal(stripReaderChoiceHeaders(null), "")
  assert.equal(stripReaderChoiceHeaders(undefined), "")
})
