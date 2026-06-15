import test from "node:test"
import assert from "node:assert/strict"

import { mergeDelta } from "../src/provider/openaiCompatible.js"

// Regression: some OpenAI-compatible providers re-send the COMPLETE function
// name on every tool_calls delta (only `arguments` are meant to stream). Naive
// concatenation doubled it — "websearch" + "websearch" → "websearchwebsearch"
// — which then failed to resolve as a tool and surfaced in the UI fold.

function toolDelta(idx, { id, name, args } = {}) {
  const fn = {}
  if (name !== undefined) fn.name = name
  if (args !== undefined) fn.arguments = args
  const partial = { index: idx, function: fn }
  if (id) partial.id = id
  if (id) partial.type = "function"
  return { tool_calls: [partial] }
}

test("buffered stream path: repeated full name is not doubled; arguments concatenate", () => {
  const message = {}
  const bufs = { content: [], reasoning_content: [], reasoning: [], toolCalls: new Map() }
  // Provider sends the full name twice (deltas 1 & 2), args in pieces.
  mergeDelta(message, toolDelta(0, { id: "c1", name: "websearch", args: '{"qu' }), null, bufs)
  mergeDelta(message, toolDelta(0, { name: "websearch", args: 'ery":' }), null, bufs)
  mergeDelta(message, toolDelta(0, { args: '"x"}' }), null, bufs)
  const entry = bufs.toolCalls.get(0)
  assert.equal(entry.name.join(""), "websearch")
  assert.equal(entry.arguments.join(""), '{"query":"x"}')
})

test("direct (non-buffered) path: repeated full name is not doubled", () => {
  const message = {}
  mergeDelta(message, toolDelta(0, { id: "c1", name: "websearch", args: "" }), null, null)
  mergeDelta(message, toolDelta(0, { name: "websearch", args: '{"q":1}' }), null, null)
  assert.equal(message.tool_calls[0].function.name, "websearch")
  assert.equal(message.tool_calls[0].function.arguments, '{"q":1}')
})

test("a genuinely chunked name still assembles correctly", () => {
  const message = {}
  const bufs = { content: [], reasoning_content: [], reasoning: [], toolCalls: new Map() }
  mergeDelta(message, toolDelta(0, { id: "c1", name: "web" }), null, bufs)
  mergeDelta(message, toolDelta(0, { name: "search" }), null, bufs)
  assert.equal(bufs.toolCalls.get(0).name.join(""), "websearch")
})
