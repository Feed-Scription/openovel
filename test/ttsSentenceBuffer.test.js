import test from "node:test"
import assert from "node:assert/strict"

import { createSentenceBuffer } from "../src/tts/sentenceBuffer.js"

test("emits a CJK sentence as soon as its terminator arrives", () => {
  const sb = createSentenceBuffer()
  assert.deepEqual(sb.push("她推开"), [])
  assert.deepEqual(sb.push("了门。剩"), ["她推开了门。"])
  assert.equal(sb.pending(), "剩")
})

test("splits multiple sentences in one delta", () => {
  const sb = createSentenceBuffer()
  const out = sb.push("第一句话来了。第二句话也来了！还有第三句吗？")
  assert.deepEqual(out, ["第一句话来了。", "第二句话也来了！", "还有第三句吗？"])
  assert.equal(sb.pending(), "")
})

test("merges a too-short fragment forward into the next clause", () => {
  const sb = createSentenceBuffer({ minLength: 6 })
  // "好！" is below minLength, so it should not flush on its own.
  assert.deepEqual(sb.push("好！"), [])
  const out = sb.push("他终于答应了下来。")
  assert.deepEqual(out, ["好！他终于答应了下来。"])
})

test("keeps trailing closing quote with the sentence", () => {
  const sb = createSentenceBuffer({ minLength: 1 })
  const out = sb.push('他喊道："快跑！"然后转身。')
  assert.deepEqual(out, ['他喊道："快跑！"', "然后转身。"])
})

test("Latin punctuation and newline boundaries work", () => {
  const sb = createSentenceBuffer({ minLength: 1 })
  assert.deepEqual(sb.push("Run!\n"), ["Run!\n"])
  assert.deepEqual(sb.push("She turned. "), ["She turned."])
  assert.equal(sb.pending().trim(), "")
})

test("flush returns the remainder even if shorter than minLength", () => {
  const sb = createSentenceBuffer({ minLength: 6 })
  sb.push("末尾没有标点的残句")
  assert.deepEqual(sb.flush(), ["末尾没有标点的残句"])
  assert.deepEqual(sb.flush(), [])
})

test("reset clears pending buffer", () => {
  const sb = createSentenceBuffer()
  sb.push("半句话")
  sb.reset()
  assert.equal(sb.pending(), "")
})
