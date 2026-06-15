import { withRetry } from "../lib/retry.js"
import { toAnthropicBlocks, stripImagesToText } from "./multimodalContent.js"
import { runStreamingWithRecovery } from "./streamRecovery.js"

// Anthropic Messages API adapter. Same options + return shape as
// openaiCompatible.js's createChatMessage — the rest of openovel (tool loop,
// narrator, Storykeeper) only ever sees OpenAI-style messages, so this file is
// the translation boundary: OpenAI request shape → Anthropic /v1/messages, and
// Anthropic response/stream → an OpenAI-style assistant message.
//
// Dispatched from provider.js when a provider plugin declares kind:"anthropic".

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_CHUNK_TIMEOUT_MS = Number(process.env.OPENOVEL_CHUNK_TIMEOUT_MS) || 60_000
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
// Anthropic requires max_tokens; supply a sane floor if a caller omits it.
const DEFAULT_MAX_TOKENS = 1024

export async function createAnthropicMessage(options) {
  const maxAttempts = Number.isFinite(options?.maxAttempts) && options.maxAttempts >= 1 ? options.maxAttempts : undefined
  if (options?.stream) {
    // Role-driven recovery, identical to the openai-compatible path (provider.js
    // sets streamRecovery): background retries from scratch, foreground prose
    // resumes from the breakpoint, unset keeps the legacy pre-frame gate.
    return runStreamingWithRecovery({
      recovery: options.streamRecovery,
      maxAttempts,
      json: options.json,
      messages: options.messages,
      onDelta: options.onDelta,
      label: `anthropic:${options?.model || "?"}:stream`,
      runAttempt: ({ messages, progress, onDelta, attempt }) =>
        doCreate({ ...options, messages, onDelta, _retryAttempt: attempt, _streamProgress: progress }),
    })
  }
  return withRetry((attempt) => doCreate({ ...options, _retryAttempt: attempt }), {
    label: `anthropic:${options?.model || "?"}`,
    maxAttempts,
  })
}

export async function createAnthropicCompletion(options) {
  const message = await createAnthropicMessage(options)
  return message.content?.trim() || ""
}

async function doCreate({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens = DEFAULT_MAX_TOKENS,
  json = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chunkTimeoutMs = DEFAULT_CHUNK_TIMEOUT_MS,
  path = "/v1/messages",
  headers = {},
  // thinking hint is accepted but deferred in v1 (extended thinking has
  // temperature/budget constraints we'll wire up later); kept so the call
  // signature matches the OpenAI client and provider.js can pass it through.
  // eslint-disable-next-line no-unused-vars
  thinking,
  imageInput = false,
  stream = false,
  onDelta,
  _streamProgress,
}) {
  const reqHeaders = anthropicHeaders(apiKey, headers)
  if (!reqHeaders["x-api-key"] && !reqHeaders["X-Api-Key"]) throw new Error("Missing provider API key")
  if (!baseUrl) throw new Error("Missing provider base URL")
  if (!model) throw new Error("Missing provider model")

  const controller = new AbortController()
  const startedAt = Date.now()
  let stallTimer = null
  // Overall timeout guards connecting + time-to-first-token; once the stream is
  // producing frames it is RETIRED (see onStreamFrame) so a long-but-live
  // generation isn't killed mid-stream — the inter-token stall timer guards it.
  let overallTimer = setTimeout(() => controller.abort(new Error(`overall timeout after ${timeoutMs}ms`)), timeoutMs)
  const disarmOverall = () => {
    if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
  }
  const hasStallGuard = stream && chunkTimeoutMs > 0
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer)
    if (!hasStallGuard) return
    stallTimer = setTimeout(() => controller.abort(new Error(`stream stalled for ${chunkTimeoutMs}ms`)), chunkTimeoutMs)
  }
  const onStreamFrame = () => {
    if (hasStallGuard) disarmOverall()
    resetStallTimer()
  }
  if (stream) resetStallTimer()
  try {
    const body = toAnthropicRequest({ model, messages, tools, toolChoice, temperature, maxTokens, json, stream, imageInput })
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${normalizePath(path)}`, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      const error = new Error(`Provider API ${response.status}: ${text.slice(0, 500)}`)
      error.status = response.status
      throw error
    }

    let message
    let usage = {}
    let finishReason
    let responseId
    let streamTelemetry
    if (stream) {
      const out = await readAnthropicStream(response, startedAt, onDelta, onStreamFrame, _streamProgress)
      message = out.message
      usage = out.usage
      finishReason = out.finishReason
      responseId = out.id
      streamTelemetry = out._streamTelemetry
    } else {
      // An endpoint may ignore stream:false and reply with an SSE body anyway;
      // response.json() would throw on "event:/data:" framing. Read text and
      // aggregate the SSE events when present, else parse JSON normally. Real
      // fetch always has .text(); fall back to .json() for bare mocks.
      const out = await readNonStreamingAnthropic(response, startedAt)
      message = out.message
      usage = out.usage
      finishReason = out.finishReason
      responseId = out.id
      streamTelemetry = out._streamTelemetry
    }

    Object.defineProperty(message, "_apiTelemetry", {
      value: {
        durationMs: Date.now() - startedAt,
        responseHeadersMs: streamTelemetry?.responseHeadersMs,
        firstFrameMs: streamTelemetry?.firstFrameMs,
        firstContentMs: streamTelemetry?.firstContentMs,
        lastFrameMs: streamTelemetry?.lastFrameMs,
        frameCount: streamTelemetry?.frameCount,
        streamed: stream,
        usage,
        request: {
          messageCount: Array.isArray(messages) ? messages.length : 0,
          toolCount: Array.isArray(tools) ? tools.length : 0,
          inputChars: JSON.stringify(messages || []).length,
          json,
          timeoutMs,
          stream,
        },
        response: { id: responseId, finishReason },
      },
      enumerable: false,
    })
    return message
  } finally {
    disarmOverall()
    if (stallTimer) clearTimeout(stallTimer)
  }
}

function normalizePath(path) {
  const value = path || "/v1/messages"
  return value.startsWith("/") ? value : `/${value}`
}

// Ensure content-type + anthropic-version are always present, and add x-api-key
// from apiKey when the resolved provider headers didn't already carry it.
function anthropicHeaders(apiKey, headers = {}) {
  const out = { "content-type": "application/json", "anthropic-version": DEFAULT_ANTHROPIC_VERSION, ...headers }
  const hasKey = Object.keys(out).some((k) => k.toLowerCase() === "x-api-key")
  if (!hasKey && apiKey) out["x-api-key"] = apiKey
  return out
}

// ── Request translation (pure) ─────────────────────────────────────────────

export function toAnthropicRequest({ model, messages, tools, toolChoice, temperature, maxTokens, json, stream, imageInput = false }) {
  const { system, messages: msgs } = splitOpenAIMessages(messages, { json, imageInput })
  const body = {
    model,
    // Required by Anthropic — never omit.
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
    messages: msgs,
    stream: Boolean(stream),
  }
  if (system) body.system = system
  if (temperature !== undefined && temperature !== null) body.temperature = temperature
  if (Array.isArray(tools) && tools.length) body.tools = tools.map(toAnthropicTool).filter(Boolean)
  const tc = toAnthropicToolChoice(toolChoice)
  if (tc && Array.isArray(body.tools) && body.tools.length) body.tool_choice = tc
  return body
}

// OpenAI-style messages[] → { system, messages } in Anthropic shape. Collects
// system text to the top level, maps assistant tool_calls → tool_use blocks and
// role:"tool" results → tool_result blocks, and coalesces consecutive same-role
// turns (Anthropic requires strict user/assistant alternation).
// A message content that is an array → Anthropic blocks (images stripped for a
// non-vision model). A plain string stays a single text block / string.
function asBlocks(content, imageInput) {
  return toAnthropicBlocks(imageInput ? content : stripImagesToText(content))
}

function splitOpenAIMessages(messages = [], { json = false, imageInput = false } = {}) {
  const systemParts = []
  const turns = []
  const pushBlocks = (role, blocks) => {
    if (!blocks.length) return
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue
    if (m.role === "system") {
      const text = contentToText(m.content)
      if (text) systemParts.push(text)
      continue
    }
    if (m.role === "tool") {
      pushBlocks("user", [{
        type: "tool_result",
        tool_use_id: m.tool_call_id || m.toolCallId || "",
        content: Array.isArray(m.content) ? asBlocks(m.content, imageInput) : contentToText(m.content),
      }])
      continue
    }
    if (m.role === "assistant") {
      const blocks = []
      const text = contentToText(m.content)
      if (text) blocks.push({ type: "text", text })
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        blocks.push({
          type: "tool_use",
          id: call.id || "",
          name: call.function?.name || "",
          input: parseJsonLoose(call.function?.arguments),
        })
      }
      pushBlocks("assistant", blocks.length ? blocks : [{ type: "text", text: "" }])
      continue
    }
    // user (and any other role) → user blocks (image-aware when content is an array)
    pushBlocks("user", Array.isArray(m.content) ? asBlocks(m.content, imageInput) : [{ type: "text", text: contentToText(m.content) }])
  }
  if (json) {
    systemParts.push(
      "Output ONLY a single valid JSON object — no prose, no markdown code fences, no commentary before or after.",
    )
  }
  return { system: systemParts.join("\n\n").trim(), messages: turns }
}

function toAnthropicTool(tool) {
  const fn = tool?.function || tool
  if (!fn?.name) return null
  return {
    name: fn.name,
    description: fn.description || "",
    input_schema: fn.parameters || fn.input_schema || { type: "object", properties: {} },
  }
}

function toAnthropicToolChoice(toolChoice) {
  if (!toolChoice) return null
  if (toolChoice === "required") return { type: "any" }
  if (toolChoice === "auto" || toolChoice === "none") return { type: "auto" }
  if (typeof toolChoice === "object" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name }
  }
  return { type: "auto" }
}

function contentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("")
  }
  if (content == null) return ""
  return String(content)
}

function parseJsonLoose(text) {
  if (text == null) return {}
  if (typeof text === "object") return text
  try { return JSON.parse(text) } catch { return {} }
}

// ── Response translation (pure) ─────────────────────────────────────────────

export function anthropicResponseToMessage(data = {}) {
  const blocks = Array.isArray(data.content) ? data.content : []
  let content = ""
  let reasoning = ""
  const toolCalls = []
  for (const b of blocks) {
    if (b?.type === "text") content += b.text || ""
    else if (b?.type === "thinking") reasoning += b.thinking || ""
    else if (b?.type === "tool_use") {
      toolCalls.push({
        id: b.id || "",
        type: "function",
        function: { name: b.name || "", arguments: JSON.stringify(b.input ?? {}) },
      })
    }
  }
  const message = { role: "assistant", content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, finishReason: mapStopReason(data.stop_reason), usage: normalizeUsage(data.usage) }
}

function mapStopReason(stop) {
  if (stop === "tool_use") return "tool_calls"
  if (stop === "max_tokens") return "length"
  if (stop === "end_turn" || stop === "stop_sequence") return "stop"
  return stop || undefined
}

function normalizeUsage(usage = {}) {
  const prompt = Number(usage.input_tokens) || 0
  const completion = Number(usage.output_tokens) || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

// ── Streaming (SSE) ─────────────────────────────────────────────────────────

export function newAnthropicStreamState() {
  return { blocks: new Map(), usage: {}, id: undefined, stopReason: undefined }
}

// Apply one parsed Anthropic SSE event to the accumulator + emit onDelta in the
// SAME shape openovel's consumers read (narrator gate reads `content`; the
// init token counter reads `tool_arguments`/`tool_name`/`chars`).
export function applyAnthropicEvent(state, ev, onDelta) {
  const type = ev?.type
  if (type === "message_start") {
    state.id = ev.message?.id
    if (ev.message?.usage) state.usage = { ...state.usage, ...ev.message.usage }
  } else if (type === "content_block_start") {
    const cb = ev.content_block || {}
    state.blocks.set(ev.index, { type: cb.type, text: [], thinking: [], toolId: cb.id, toolName: cb.name, json: [] })
    if (cb.type === "tool_use" && onDelta) {
      onDelta({ tool_name: cb.name || "", kind: "tool_call", chars: (cb.name || "").length })
    }
  } else if (type === "content_block_delta") {
    const b = state.blocks.get(ev.index)
    if (!b) return
    const d = ev.delta || {}
    if (d.type === "text_delta") {
      b.text.push(d.text || "")
      onDelta?.({ content: d.text || "", chars: (d.text || "").length })
    } else if (d.type === "thinking_delta") {
      b.thinking.push(d.thinking || "")
      onDelta?.({ reasoning_content: d.thinking || "", chars: (d.thinking || "").length })
    } else if (d.type === "input_json_delta") {
      b.json.push(d.partial_json || "")
      onDelta?.({ tool_arguments: d.partial_json || "", tool_name: b.toolName || "", kind: "tool_call", chars: (d.partial_json || "").length })
    }
  } else if (type === "message_delta") {
    if (ev.delta?.stop_reason) state.stopReason = ev.delta.stop_reason
    if (ev.usage) state.usage = { ...state.usage, ...ev.usage }
  } else if (type === "error") {
    const err = new Error(`Anthropic stream error: ${ev.error?.message || ev.error?.type || "unknown"}`)
    err._anthropicStreamError = true
    throw err
  }
}

export function finalizeAnthropicStream(state) {
  let content = ""
  let reasoning = ""
  const toolCalls = []
  for (const [, b] of [...state.blocks.entries()].sort((a, z) => a[0] - z[0])) {
    if (b.type === "text") content += b.text.join("")
    else if (b.type === "thinking") reasoning += b.thinking.join("")
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.toolId || "",
        type: "function",
        function: { name: (Array.isArray(b.toolName) ? b.toolName.join("") : b.toolName) || "", arguments: b.json.join("") || "{}" },
      })
    }
  }
  const message = { role: "assistant", content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, finishReason: mapStopReason(state.stopReason), usage: normalizeUsage(state.usage), id: state.id }
}

// Non-streaming read that tolerates an SSE body (an endpoint ignoring
// stream:false). Mirrors the openai-compatible reader. Returns the same
// { message, usage, finishReason, id } shape as the JSON path.
async function readNonStreamingAnthropic(response, startedAt) {
  if (typeof response.text !== "function") {
    const data = await response.json()
    const mapped = anthropicResponseToMessage(data)
    return { ...mapped, id: data.id }
  }
  const contentType = response.headers?.get?.("content-type") || ""
  const text = await response.text()
  const looksLikeSse = /^\s*(event:|data:)/.test(text) || /\bevent:\s*\w/.test(text)
  if (!contentType.includes("text/event-stream") && !looksLikeSse) {
    const data = JSON.parse(text)
    const mapped = anthropicResponseToMessage(data)
    return { ...mapped, id: data.id }
  }
  // Replay the buffered SSE frames through the same state machine the live
  // stream uses, so content blocks + tool_use accumulate identically.
  const state = newAnthropicStreamState()
  for (const frame of text.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue
    const data = parseSseData(frame)
    if (data == null || data._parseError) continue
    applyAnthropicEvent(state, data, undefined)
  }
  const out = finalizeAnthropicStream(state)
  out._streamTelemetry = { responseHeadersMs: Date.now() - startedAt, frameCount: 0 }
  return out
}

async function readAnthropicStream(response, startedAt, onDelta, resetStallTimer, streamProgress) {
  if (!response.body) throw new Error("Provider stream response has no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const state = newAnthropicStreamState()
  const telemetry = {
    responseHeadersMs: Date.now() - startedAt,
    firstFrameMs: undefined,
    firstContentMs: undefined,
    lastFrameMs: undefined,
    frameCount: 0,
  }
  let buffer = ""
  const handle = (frame) => {
    const data = parseSseData(frame)
    if (data == null || data._parseError) return
    telemetry.frameCount++
    telemetry.firstFrameMs ??= Date.now() - startedAt
    telemetry.lastFrameMs = Date.now() - startedAt
    if (streamProgress) streamProgress.framesReceived++
    const before = state.blocks.size
    applyAnthropicEvent(state, data, onDelta)
    if (telemetry.firstContentMs === undefined && (data.type === "content_block_delta" || state.blocks.size > before)) {
      telemetry.firstContentMs = Date.now() - startedAt
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (typeof resetStallTimer === "function") resetStallTimer()
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ""
      for (const frame of frames) handle(frame)
    }
  } catch (error) {
    // Surface the prose streamed before the abort so the recovery layer can
    // resume from the breakpoint instead of discarding the turn (mirrors the
    // openai-compatible reader). state is local, so the partial is lost otherwise.
    if (error && typeof error === "object" && !error._partial) {
      error._partial = {
        content: finalizeAnthropicStream(state).message.content || "",
        framesReceived: streamProgress?.framesReceived || 0,
      }
    }
    throw error
  }
  const tail = decoder.decode()
  if (tail) buffer += tail
  if (buffer.trim()) handle(buffer)
  const out = finalizeAnthropicStream(state)
  out._streamTelemetry = telemetry
  return out
}

// Extract + JSON-parse the `data:` payload of one SSE frame (ignores the
// `event:` line — the Anthropic data object carries its own `type`).
function parseSseData(frame) {
  const data = String(frame)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
  if (!data) return null
  try { return JSON.parse(data) } catch { return { _parseError: true } }
}
