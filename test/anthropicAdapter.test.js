import test from "node:test"
import assert from "node:assert/strict"

import {
  toAnthropicRequest,
  anthropicResponseToMessage,
  newAnthropicStreamState,
  applyAnthropicEvent,
  finalizeAnthropicStream,
} from "../src/provider/anthropic.js"
import { providerRegistry } from "../src/provider/registry.js"

// ── Request translation ─────────────────────────────────────────────────────

test("toAnthropicRequest: system extracted; tool_calls + tool results mapped; turns coalesce", () => {
  const messages = [
    { role: "system", content: "You are a narrator." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
    { role: "tool", tool_call_id: "t1", content: "file body" },
    { role: "user", content: "thanks" },
  ]
  const body = toAnthropicRequest({ model: "claude-x", messages, maxTokens: 256 })

  assert.equal(body.model, "claude-x")
  assert.equal(body.max_tokens, 256)
  assert.equal(body.system, "You are a narrator.")
  assert.equal(body.messages.length, 3)
  // user
  assert.deepEqual(body.messages[0], { role: "user", content: [{ type: "text", text: "hello" }] })
  // assistant tool_use (empty text dropped)
  assert.deepEqual(body.messages[1], {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } }],
  })
  // tool_result + following user text coalesced into ONE user turn
  assert.equal(body.messages[2].role, "user")
  assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "t1", content: "file body" })
  assert.deepEqual(body.messages[2].content[1], { type: "text", text: "thanks" })
})

test("toAnthropicRequest: max_tokens always present (required by Anthropic)", () => {
  const body = toAnthropicRequest({ model: "claude-x", messages: [{ role: "user", content: "hi" }] })
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0)
})

test("toAnthropicRequest: tools → input_schema; toolChoice mapped", () => {
  const body = toAnthropicRequest({
    model: "claude-x",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    toolChoice: "required",
  })
  assert.deepEqual(body.tools, [{ name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }])
  assert.deepEqual(body.tool_choice, { type: "any" })
})

test("toAnthropicRequest: json mode appends a JSON-only system instruction (no response_format)", () => {
  const body = toAnthropicRequest({ model: "claude-x", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }], json: true })
  assert.match(body.system, /Be terse\./)
  assert.match(body.system, /ONLY a single valid JSON/i)
  assert.equal("response_format" in body, false)
})

// ── Response translation ─────────────────────────────────────────────────────

test("anthropicResponseToMessage: text + tool_use + thinking → OpenAI message", () => {
  const { message, finishReason, usage } = anthropicResponseToMessage({
    id: "msg_1",
    content: [
      { type: "thinking", thinking: "let me see" },
      { type: "text", text: "Hi there." },
      { type: "tool_use", id: "tu1", name: "read", input: { path: "x" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  })
  assert.equal(message.content, "Hi there.")
  assert.equal(message.reasoning_content, "let me see")
  assert.deepEqual(message.tool_calls, [{ id: "tu1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }])
  assert.equal(finishReason, "tool_calls")
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

// ── Streaming ────────────────────────────────────────────────────────────────

test("applyAnthropicEvent + finalize: text + tool input_json_delta accumulate; onDelta shape", () => {
  const state = newAnthropicStreamState()
  const deltas = []
  const onDelta = (d) => deltas.push(d)
  applyAnthropicEvent(state, { type: "message_start", message: { id: "m1", usage: { input_tokens: 3 } } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_start", index: 0, content_block: { type: "text" } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "read" } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } }, onDelta)
  applyAnthropicEvent(state, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"a"}' } }, onDelta)
  applyAnthropicEvent(state, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }, onDelta)

  const { message, finishReason, usage } = finalizeAnthropicStream(state)
  assert.equal(message.content, "Hello")
  assert.deepEqual(message.tool_calls, [{ id: "tu1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }])
  assert.equal(finishReason, "tool_calls")
  assert.equal(usage.prompt_tokens, 3)
  assert.equal(usage.completion_tokens, 7)
  // onDelta carries the same keys openovel consumers read.
  assert.deepEqual(deltas.filter((d) => d.content).map((d) => d.content), ["Hel", "lo"])
  assert.ok(deltas.some((d) => d.tool_name === "read"))
  assert.ok(deltas.some((d) => d.tool_arguments === '{"pa'))
})

test("applyAnthropicEvent: error event throws", () => {
  const state = newAnthropicStreamState()
  assert.throws(
    () => applyAnthropicEvent(state, { type: "error", error: { type: "overloaded_error", message: "busy" } }),
    /Anthropic stream error/,
  )
})

// ── Provider registration / dispatch ─────────────────────────────────────────

test("anthropic + custom-anthropic providers are registered with kind:anthropic", () => {
  assert.equal(providerRegistry.get("anthropic")?.kind, "anthropic")
  assert.equal(providerRegistry.get("custom-anthropic")?.kind, "anthropic")
})
