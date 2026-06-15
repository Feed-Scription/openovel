import assert from "node:assert/strict"
import test from "node:test"

import { assistantMessageForHistory, compactOldToolResults, executeToolCalls, injectQueuedContextMessages, isUsableJsonObject } from "../src/runtime/toolLoop.js"

test("isUsableJsonObject: gates the json-mode re-synthesis at natural termination", () => {
  // Clean envelope (with or without surrounding prose) → usable, no re-issue.
  assert.equal(isUsableJsonObject('{"status":"applied","inboxResolved":["x"]}'), true)
  assert.equal(isUsableJsonObject('Here is the result:\n{"status":"applied"}\nDone.'), true)
  // The regression cases that made the storykeeper turn "skip" and the inbox
  // pile up — free-form prose with no JSON object → must re-issue.
  assert.equal(isUsableJsonObject("I updated the character card and resolved the inbox."), false)
  assert.equal(isUsableJsonObject(""), false)
  assert.equal(isUsableJsonObject(null), false)
  // A bare array or empty object is not a usable envelope.
  assert.equal(isUsableJsonObject("[]"), false)
  assert.equal(isUsableJsonObject("{}"), false)
})

test("tool loop preserves reasoning_content for DeepSeek thinking mode", () => {
  // DeepSeek v4-pro thinking mode REQUIRES reasoning_content
  // be passed back as input on subsequent turns ("The `reasoning_content` in
  // the thinking mode must be passed back to the API."). Stripping it breaks
  // thinking-mode providers during multi-step tool loops.
  // Non-thinking models simply don't emit the field, so always preserving
  // it is safe across all providers.
  const message = {
    role: "assistant",
    content: "",
    reasoning_content: "internal chain-of-thought from previous step",
    reasoning: "alt-field name some providers emit",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
  }

  const historyMessage = assistantMessageForHistory(message)
  assert.equal(historyMessage.reasoning_content, "internal chain-of-thought from previous step")
  assert.equal(historyMessage.reasoning, "alt-field name some providers emit")
  assert.equal(historyMessage.tool_calls.length, 1)
  assert.equal(historyMessage.role, "assistant")
})

test("tool loop drops empty reasoning_content (non-thinking models)", () => {
  // v4-flash doesn't emit reasoning_content. The field is either absent or
  // empty. We should not pollute history with an empty string field.
  const message = { role: "assistant", content: "final answer", tool_calls: [{ id: "c1" }] }
  const historyMessage = assistantMessageForHistory(message)
  assert.equal("reasoning_content" in historyMessage, false)
  assert.equal("reasoning" in historyMessage, false)
})

test("compactOldToolResults shrinks old tool results to a stat line", () => {
  // Pathological scenario: 12 tool results, each ~16KB. The 4 oldest should
  // collapse to a compact stat line; the 8 most recent stay intact. The fix
  // is what keeps 75-step storykeeper batches from blowing node heap.
  const big = "x".repeat(15000)
  const working = []
  for (let i = 0; i < 12; i++) {
    working.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}` }] })
    working.push({
      role: "tool",
      tool_call_id: `c${i}`,
      content: `<tool_result tool="read" status="ok"><content>${big}</content></tool_result>`,
    })
  }

  compactOldToolResults(working, 8)

  const toolResults = working.filter((m) => m.role === "tool")
  assert.equal(toolResults.length, 12, "no messages dropped")
  const compactedCount = toolResults.filter((m) => m.content.includes('compacted="1"')).length
  const intactCount = toolResults.filter((m) => m.content.length > 1000).length
  assert.equal(compactedCount, 4, "4 oldest tool results compacted")
  assert.equal(intactCount, 8, "8 most recent tool results intact")

  // tool_call_id linkage preserved on compacted entries (chat API uses it to
  // associate tool results with their assistant call_id)
  const firstCompacted = toolResults[0]
  assert.equal(firstCompacted.tool_call_id, "c0")
  assert.match(firstCompacted.content, /<tool_result\s+tool="read"\s+status="ok"\s+compacted="1"/)
})

test("compactOldToolResults keeps ask_user answers intact outside the recent window", () => {
  const answer = "朱全后来想，那天的和歌山很会做人，风从山里出来，先把他的帽绳吹歪，再把他的计划吹得像一张没调好的表格。"
  const working = [
    { role: "assistant", content: "", tool_calls: [{ id: "ask1" }] },
    {
      role: "tool",
      tool_call_id: "ask1",
      content: `<tool_result tool="ask_user" status="ok"><arguments>${"x".repeat(600)}</arguments><content>${answer}</content></tool_result>`,
    },
  ]
  for (let i = 0; i < 12; i++) {
    working.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}` }] })
    working.push({
      role: "tool",
      tool_call_id: `c${i}`,
      content: `<tool_result tool="read" status="ok"><content>${"x".repeat(2000)}</content></tool_result>`,
    })
  }

  compactOldToolResults(working, 8)

  const askResult = working.find((m) => m.tool_call_id === "ask1")
  assert.ok(askResult.content.includes(answer), "reader's answer remains visible to the model")
  assert.equal(askResult.content.includes('compacted="1"'), false)
  const compactedReads = working
    .filter((m) => m.role === "tool" && m.tool_call_id !== "ask1")
    .filter((m) => m.content.includes('compacted="1"'))
  assert.ok(compactedReads.length > 0, "ordinary old tool results still compact")
})

test("compactOldToolResults is a no-op when below the window", () => {
  const working = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "<tool_result>...</tool_result>" },
  ]
  const before = JSON.stringify(working)
  compactOldToolResults(working, 8)
  assert.equal(JSON.stringify(working), before, "unchanged when ≤ keepRecent tool results")
})

test("tool loop omits tool_calls when there are none (avoids empty array)", () => {
  const message = { role: "assistant", content: "final answer" }
  const historyMessage = assistantMessageForHistory(message)
  assert.equal(historyMessage.content, "final answer")
  assert.equal("tool_calls" in historyMessage, false)
})

test("tool loop honors per-action concurrencySafe function (memory.read parallel, memory.add serial)", async () => {
  // memory/monitor/loop have action-dependent concurrency safety —
  // "read" / "list" / "get" can run in parallel batches; mutating actions
  // remain barriers. Test the function-form concurrencySafe path.
  const concurrent = []
  let inFlight = 0
  let maxInFlight = 0
  const registry = {
    get(name) {
      return {
        destructive: false,
        concurrencySafe: (args) => args?.action === "read",
        name,
      }
    },
    async execute(_name, args) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      concurrent.push(args.action)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight--
      return { output: `done ${args.action}` }
    },
  }
  await executeToolCalls(
    [
      { id: "c1", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "read" }) } },
      { id: "c2", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "read" }) } },
      { id: "c3", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "add" }) } },
      { id: "c4", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "read" }) } },
    ],
    { registry, concurrency: 4 },
  )
  // Both reads in the first batch fan out; the mutating add forms a barrier;
  // then the trailing read runs alone.
  assert.equal(maxInFlight, 2, "two parallel reads expected before the add barrier")
})

test("tool loop wraps tool results in compact structured context", async () => {
  const registry = {
    get() {
      return { concurrencySafe: true }
    },
    async execute() {
      return {
        title: "Read story file",
        metadata: { filePath: "story/canon/chapters.md" },
        output: "line 1\nline 2",
      }
    },
  }
  const results = await executeToolCalls(
    [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{\"filePath\":\"story/canon/chapters.md\"}" },
      },
    ],
    { registry, concurrency: 1 },
  )

  assert.match(results[0].content, /<tool_result tool="read" status="ok">/)
  assert.match(results[0].content, /<metadata>/)
  assert.match(results[0].content, /story\/canon\/chapters\.md/)
  assert.match(results[0].content, /line 1/)
})

test("a non-throwing tool failure (isError) renders status=error, not ok", async () => {
  const registry = {
    get() { return { concurrencySafe: true } },
    async execute() {
      // e.g. a denied write — returns without throwing.
      return { isError: true, output: "Refusing to modify story/BRIEF.md: read-only." }
    },
  }
  const results = await executeToolCalls(
    [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }],
    { registry, concurrency: 1 },
  )
  assert.match(results[0].content, /<tool_result tool="write" status="error">/)
  assert.match(results[0].content, /Refusing to modify/)
})

test("tool loop injects queued context only at a safe message boundary", async () => {
  const working = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "<tool_result tool=\"read\" status=\"ok\"/>" },
  ]
  const injected = await injectQueuedContextMessages(working, {
    context: { agent: "storykeeper", turnId: "turn_old" },
    drainQueuedContext: async () => [{ role: "user", content: "<foreground_updates>new turn</foreground_updates>" }],
  })

  assert.equal(injected.length, 1)
  assert.equal(working.at(-1).role, "user")
  assert.match(working.at(-1).content, /foreground_updates/)
  assert.equal(working[1].role, "tool", "tool result remains directly after its assistant tool call")
})
