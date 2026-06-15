import test from "node:test"
import assert from "node:assert/strict"

import { createChatMessage } from "../src/provider/openaiCompatible.js"
import { createAnthropicMessage } from "../src/provider/anthropic.js"

// Regression: a non-streaming request (stream:false) whose endpoint replies
// with an SSE body anyway used to throw
//   "Unexpected token 'd', \"data: {\"id\"... is not valid JSON"
// from response.json(). Some user-configured custom OpenAI-compatible proxies
// ignore stream:false and always stream. The client must tolerate that by
// aggregating the SSE frames instead of trusting the requested mode.

function sseResponse(body, { contentType = "text/event-stream" } = {}) {
  return {
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    async text() { return body },
    async json() { return JSON.parse(body) },
  }
}

function withMockFetch(fn, response) {
  const original = globalThis.fetch
  globalThis.fetch = async () => (typeof response === "function" ? response() : response)
  return fn().finally(() => { globalThis.fetch = original })
}

const COMMON = {
  baseUrl: "https://proxy.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-x",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
  maxAttempts: 1,
}

test("non-stream request tolerates an SSE body (content-type event-stream)", async () => {
  const body = [
    'data: {"id":"r1","choices":[{"delta":{"role":"assistant","content":"Hello"}}]}',
    '',
    'data: {"id":"r1","choices":[{"delta":{"content":", world"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join("\n")
  const message = await withMockFetch(() => createChatMessage(COMMON), sseResponse(body))
  assert.equal(message.content, "Hello, world")
  assert.equal(message._apiTelemetry.response.id, "r1")
})

test("non-stream request still parses a plain JSON body", async () => {
  const body = JSON.stringify({ id: "r2", choices: [{ message: { role: "assistant", content: "plain" }, finish_reason: "stop" }] })
  const message = await withMockFetch(() => createChatMessage(COMMON), sseResponse(body, { contentType: "application/json" }))
  assert.equal(message.content, "plain")
})

test("non-stream SSE is sniffed even when content-type lies (application/json)", async () => {
  const body = 'data: {"id":"r3","choices":[{"delta":{"content":"sniffed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'
  const message = await withMockFetch(() => createChatMessage(COMMON), sseResponse(body, { contentType: "application/json" }))
  assert.equal(message.content, "sniffed")
})

test("anthropic non-stream request tolerates an SSE body", async () => {
  const body = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    '',
  ].join("\n")
  const message = await withMockFetch(
    () => createAnthropicMessage({ baseUrl: "https://gw.example.com", apiKey: "sk", model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, maxAttempts: 1 }),
    sseResponse(body),
  )
  assert.equal(message.content, "Hi there")
})

test("non-stream SSE aggregates streamed tool_calls", async () => {
  const body = [
    'data: {"id":"r4","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"websearch","arguments":"{\\"q"}}]}}]}',
    '',
    'data: {"id":"r4","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":1}"}}]},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join("\n")
  const message = await withMockFetch(() => createChatMessage(COMMON), sseResponse(body))
  assert.equal(message.tool_calls[0].function.name, "websearch")
  assert.equal(message.tool_calls[0].function.arguments, '{"q":1}')
})
