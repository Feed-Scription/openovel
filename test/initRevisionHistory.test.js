import test from "node:test"
import assert from "node:assert/strict"

import { initConversationHistory } from "../src/runtime/sessionViewModel.js"

// The init agent used to receive only the latest revision sentence, so it
// "forgot" the original brief + prior dialogue on every revision. The VM now
// flattens the transcript into conversation turns to carry that memory.

test("flattens reader turns + agent reports, drops UI-only rows", () => {
  const messages = [
    { role: "system", text: "What kind of story should X become?" }, // greeting → dropped
    { role: "user", text: "一个发生在苏州的悬疑故事" },               // original brief
    { role: "tool-call", text: "FG_template.md", meta: { tool: "read" } }, // dropped
    { role: "summary", text: "草稿：苏州雨夜，侦探陆衡……" },          // agent report
    { role: "ask-user", text: "主角用真名还是化名？" },               // ask echo → dropped
    { role: "user-answer", text: "用化名" },                          // reader answer
    { role: "user", text: "把主角改老十岁" },                          // a revision
  ]
  assert.deepEqual(initConversationHistory(messages), [
    { role: "user", content: "一个发生在苏州的悬疑故事" },
    { role: "assistant", content: "草稿：苏州雨夜，侦探陆衡……" },
    { role: "user", content: "用化名" },
    { role: "user", content: "把主角改老十岁" },
  ])
})

test("a fresh story (greeting only) yields no history", () => {
  assert.deepEqual(
    initConversationHistory([{ role: "system", text: "greeting" }]),
    [],
  )
})

test("is total over empty / missing / blank input", () => {
  assert.deepEqual(initConversationHistory(), [])
  assert.deepEqual(initConversationHistory(null), [])
  assert.deepEqual(initConversationHistory([{ role: "user", text: "   " }]), [])
})
