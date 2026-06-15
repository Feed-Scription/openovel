import { withRetry } from "../lib/retry.js"
import { runStreamingWithRecovery } from "./streamRecovery.js"
import { toOpenAIContent, stripImagesToText } from "./multimodalContent.js"

// Convert internal multimodal parts (a message `content` that is an array) into
// OpenAI wire shape; strip images when the model has no vision input. String
// content (the common case) passes through untouched. Exported for unit tests.
export function prepareOpenAIMessages(messages, imageInput) {
  if (!Array.isArray(messages)) return messages
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m
    const parts = imageInput ? m.content : stripImagesToText(m.content)
    return { ...m, content: toOpenAIContent(parts) }
  })
}

// Reasoning models can take minutes to generate long structured outputs.
// Keep the default aligned with mature agent runtimes rather than short chat UI
// timeouts, which can abort Storykeeper and Initializer work prematurely.
const DEFAULT_TIMEOUT_MS = 300_000
// Chunk-stall guard: abort a streaming response if no SSE data arrives for
// this long. 60s covers reasoning models that take long to emit a first
// token (MiMo v2.5-pro, DeepSeek v4-pro with high effort, Kimi-thinking)
// even on slower regional endpoints, while still catching truly hung
// connections within a minute. Override via OPENOVEL_CHUNK_TIMEOUT_MS for
// providers that need even more room.
const DEFAULT_CHUNK_TIMEOUT_MS = Number(process.env.OPENOVEL_CHUNK_TIMEOUT_MS) || 60_000

export async function createChatMessage(options) {
  // Retry transient API errors such as AbortError, 5xx, rate limits, DNS
  // failures, and fetch failures. Streaming retries are only safe before the
  // first SSE frame is consumed; mid-stream aborts are handled by the recovery
  // policy so content is not double-delivered to onDelta.
  //
  // Callers (Settings → Test connection) may pass maxAttempts: 1 to bypass
  // retries — diagnostic flows want failures surfaced immediately rather
  // than hidden behind 30s of exponential backoff.
  const maxAttempts = Number.isFinite(options?.maxAttempts) && options.maxAttempts >= 1
    ? options.maxAttempts
    : undefined
  if (options?.stream) {
    // Recovery policy is role-driven (provider.js sets streamRecovery): background
    // retries from scratch on a mid-stream stall, foreground prose resumes from the
    // breakpoint. Unset (eval/test-connection callers) keeps the legacy pre-frame gate.
    return runStreamingWithRecovery({
      recovery: options.streamRecovery,
      maxAttempts,
      json: options.json,
      messages: options.messages,
      onDelta: options.onDelta,
      label: `chat:${options?.model || "?"}:stream`,
      runAttempt: ({ messages, progress, onDelta, attempt }) =>
        doCreateChatMessage({
          ...options,
          messages,
          onDelta,
          _retryAttempt: attempt,
          _streamProgress: progress,
        }),
    })
  }
  return withRetry((attempt) => doCreateChatMessage({ ...options, _retryAttempt: attempt }), {
    label: `chat:${options?.model || "?"}`,
    maxAttempts,
  })
}

async function doCreateChatMessage({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens = 700,
  json = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chunkTimeoutMs = DEFAULT_CHUNK_TIMEOUT_MS,
  path = "/chat/completions",
  headers = {},
  maxTokensField = "max_tokens",
  bodyTransform,
  thinking,
  stream = false,
  streamOptions = true,
  imageInput = false,
  onDelta,
  _retryAttempt,
  _streamProgress,
}) {
  if (!apiKey) throw new Error("Missing provider API key")
  if (!baseUrl) throw new Error("Missing provider base URL")
  if (!model) throw new Error("Missing provider model")

  // Two-tier timeout. The overall timer is the absolute deadline. For streaming
  // responses, a separate chunk-stall timer resets on each SSE frame, so a long
  // live reasoning generation is not killed while a stalled upstream still is.
  const controller = new AbortController()
  const startedAt = Date.now()
  let stallTimer = null
  // The overall timeout guards the part the stall timer can't see: connecting
  // and time-to-first-token. Once the stream is actually producing frames it is
  // RETIRED (see onStreamFrame), so a long-but-live generation is never killed
  // mid-stream — from then on the inter-token stall timer is the guard.
  let overallTimer = setTimeout(() => {
    controller.abort(new Error(`overall timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  const disarmOverall = () => {
    if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
  }
  const hasStallGuard = stream && chunkTimeoutMs > 0
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer)
    if (!hasStallGuard) return
    stallTimer = setTimeout(() => {
      controller.abort(new Error(`stream stalled for ${chunkTimeoutMs}ms`))
    }, chunkTimeoutMs)
  }
  // Per received frame: the stream is alive, so retire the overall cap (only
  // when a stall guard exists to take over) and re-arm the stall timer.
  const onStreamFrame = () => {
    if (hasStallGuard) disarmOverall()
    resetStallTimer()
  }
  if (stream) resetStallTimer()
  try {
    const body = {
      model,
      messages: prepareOpenAIMessages(messages, imageInput),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined && maxTokens !== null ? { [maxTokensField]: maxTokens } : {}),
      stream,
      ...(stream && streamOptions ? { stream_options: { include_usage: true } } : {}),
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }
    // Pass the per-call thinking hint ("enabled"/"disabled"/undefined) into the
    // provider's bodyTransform so it applies thinking with the provider-correct
    // shape (and its own model-capability knowledge — e.g. deepseek-v4-flash
    // stays non-thinking even when hinted on). Providers without a thinking
    // notion ignore the hint.
    const transformedBody = bodyTransform ? bodyTransform(body, { thinking }) : body
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${normalizePath(path)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...defaultAuthHeaders(apiKey, headers),
        ...headers,
      },
      body: JSON.stringify(transformedBody),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      const error = new Error(`Provider API ${response.status}: ${text.slice(0, 500)}`)
      error.status = response.status
      throw error
    }

    const data = stream
      ? await readChatCompletionStream(response, startedAt, onDelta, onStreamFrame, _streamProgress)
      : await readNonStreamingCompletion(response, startedAt)
    const message = data.choices?.[0]?.message || { role: "assistant", content: "" }
    Object.defineProperty(message, "_apiTelemetry", {
      value: {
        durationMs: Date.now() - startedAt,
        responseHeadersMs: data._streamTelemetry?.responseHeadersMs,
        firstFrameMs: data._streamTelemetry?.firstFrameMs,
        firstContentMs: data._streamTelemetry?.firstContentMs,
        lastFrameMs: data._streamTelemetry?.lastFrameMs,
        frameCount: data._streamTelemetry?.frameCount,
        streamed: stream,
        usage: data.usage || {},
        request: {
          messageCount: Array.isArray(messages) ? messages.length : 0,
          toolCount: Array.isArray(tools) ? tools.length : 0,
          inputChars: JSON.stringify(messages || []).length,
          json,
          timeoutMs,
          stream,
        },
        response: {
          id: data.id,
          finishReason: data.choices?.[0]?.finish_reason,
        },
      },
      enumerable: false,
    })
    return message
  } finally {
    disarmOverall()
    if (stallTimer) clearTimeout(stallTimer)
  }
}

// Read a NON-streaming chat completion. Some OpenAI-compatible endpoints
// (notably user-configured proxies/gateways) ignore `stream: false` and reply
// with an SSE body anyway. `response.json()` on that throws
// "Unexpected token 'd', \"data: {…\" is not valid JSON" and kills the turn.
// So: read the text, and if it's SSE (by content-type or by sniffing a
// leading `data:` frame), aggregate the frames into one OpenAI-style
// completion instead of trusting the requested non-stream mode.
async function readNonStreamingCompletion(response, startedAt) {
  // A real fetch Response always has .text(); only call .json() (consuming the
  // body once, the other path) when text() is unavailable. Never call both on
  // one response — that throws "body already read".
  if (typeof response.text !== "function") return response.json()
  const contentType = response.headers?.get?.("content-type") || ""
  const text = await response.text()
  const looksLikeSse = /^\s*(data:|event:|:\s)/.test(text) || /\bdata:\s*[[{]/.test(text)
  if (!contentType.includes("text/event-stream") && !looksLikeSse) {
    return JSON.parse(text)
  }
  return aggregateSseBody(text, startedAt)
}

// Aggregate a complete SSE body (already fully buffered, not streamed) into
// the same shape readChatCompletionStream returns. Reuses parseSseEvent +
// mergeDelta so delta/message and tool-call accumulation behave identically.
function aggregateSseBody(text, startedAt) {
  const message = { role: "assistant", content: "" }
  const streamBufs = { content: [], reasoning_content: [], reasoning: [], toolCalls: new Map() }
  const telemetry = { responseHeadersMs: 0, firstFrameMs: undefined, firstContentMs: undefined, lastFrameMs: undefined, frameCount: 0 }
  let usage = {}
  let responseId
  let finishReason
  for (const event of text.split(/\r?\n\r?\n/)) {
    if (!event.trim()) continue
    const parsed = parseSseEvent(event)
    if (!parsed || parsed === "[DONE]" || parsed._streamParseError) continue
    telemetry.frameCount++
    telemetry.firstFrameMs ??= Date.now() - startedAt
    telemetry.lastFrameMs = Date.now() - startedAt
    responseId ||= parsed.id
    if (parsed.usage) usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    if (mergeDelta(message, choice.delta || choice.message || {}, undefined, streamBufs)) {
      telemetry.firstContentMs ??= Date.now() - startedAt
    }
  }
  if (streamBufs.content.length) message.content = streamBufs.content.join("")
  if (streamBufs.reasoning_content.length) message.reasoning_content = streamBufs.reasoning_content.join("")
  if (streamBufs.reasoning.length) message.reasoning = streamBufs.reasoning.join("")
  if (streamBufs.toolCalls.size && Array.isArray(message.tool_calls)) {
    for (const [idx, entry] of streamBufs.toolCalls) {
      const slot = message.tool_calls[idx]
      if (!slot) continue
      if (entry.name.length) slot.function.name = entry.name.join("")
      if (entry.arguments.length) slot.function.arguments = entry.arguments.join("")
    }
  }
  return { id: responseId, usage, choices: [{ message, finish_reason: finishReason }], _streamTelemetry: telemetry }
}

export async function createChatCompletion(options) {
  const message = await createChatMessage(options)
  return message.content?.trim() || ""
}

function normalizePath(path) {
  const value = path || "/chat/completions"
  return value.startsWith("/") ? value : `/${value}`
}

function defaultAuthHeaders(apiKey, headers) {
  const keys = Object.keys(headers || {}).map((key) => key.toLowerCase())
  if (keys.includes("authorization") || keys.includes("api-key")) return {}
  return { Authorization: `Bearer ${apiKey}` }
}

async function readChatCompletionStream(response, startedAt, onDelta, resetStallTimer, streamProgress) {
  if (!response.body) throw new Error("Provider stream response has no body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  // Accumulate per-channel deltas into arrays and join once at the end. Naive
  // string concatenation builds V8 cons-strings that later flatten at full size,
  // which is expensive for long reasoning_content/tool-call streams.
  const message = { role: "assistant", content: "" }
  // tool_calls bufs are per-index because OpenAI-compatible streams interleave
  // partial chunks across multiple parallel tool calls (function.arguments
  // streams piece by piece per slot). Storykeeper's write tool can emit
  // multi-KB content as its arguments payload; cons-string accumulation there
  // has the same flatten cost as content/reasoning_content.
  const streamBufs = {
    content: [],
    reasoning_content: [],
    reasoning: [],
    toolCalls: new Map(),
  }
  const telemetry = {
    responseHeadersMs: Date.now() - startedAt,
    firstFrameMs: undefined,
    firstContentMs: undefined,
    lastFrameMs: undefined,
    frameCount: 0,
  }
  let buffer = ""
  let usage = {}
  let responseId
  let finishReason

  try {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // Every received byte resets the stall timer. Long reasoning generations
    // stream steadily; only true upstream stalls trip abort.
    if (typeof resetStallTimer === "function") resetStallTimer()
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ""
    for (const event of events) {
      const parsed = parseSseEvent(event)
      if (!parsed) continue
      if (parsed === "[DONE]") {
        telemetry.lastFrameMs = Date.now() - startedAt
        continue
      }
      // Skip frames that failed JSON.parse. They are parse failures, not real
      // model frames, so do not count them in telemetry.
      if (parsed._streamParseError) continue
      telemetry.frameCount++
      telemetry.firstFrameMs ??= Date.now() - startedAt
      telemetry.lastFrameMs = Date.now() - startedAt
      // Signal to the retry layer that content has begun flowing. Any error
      // after this point is non-retryable without recovery handling.
      if (streamProgress) streamProgress.framesReceived++
      responseId ||= parsed.id
      if (parsed.usage) usage = parsed.usage
      const choice = parsed.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      if (mergeDelta(message, choice.delta || choice.message || {}, onDelta, streamBufs)) {
        telemetry.firstContentMs ??= Date.now() - startedAt
      }
    }
  }

  const tail = decoder.decode()
  if (tail) buffer += tail
  const parsed = parseSseEvent(buffer)
  if (parsed && parsed !== "[DONE]" && !parsed._streamParseError) {
    telemetry.frameCount++
    telemetry.firstFrameMs ??= Date.now() - startedAt
    telemetry.lastFrameMs = Date.now() - startedAt
    responseId ||= parsed.id
    if (parsed.usage) usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (choice && mergeDelta(message, choice.delta || choice.message || {}, onDelta, streamBufs)) {
      telemetry.firstContentMs ??= Date.now() - startedAt
    }
  }
  } catch (error) {
    // Surface the prose accumulated before the abort so the recovery layer can
    // resume from the breakpoint (foreground) instead of discarding the turn.
    // streamBufs is local to this function, so without this the partial is lost.
    if (error && typeof error === "object" && !error._partial) {
      error._partial = {
        content: streamBufs.content.join(""),
        framesReceived: streamProgress?.framesReceived || 0,
      }
    }
    throw error
  }

  // Finalize each per-channel array into its target string exactly once. The
  // onDelta callback already saw each chunk in real time; this is the moment
  // the accumulated string materializes for downstream consumers.
  if (streamBufs.content.length) message.content = streamBufs.content.join("")
  if (streamBufs.reasoning_content.length) message.reasoning_content = streamBufs.reasoning_content.join("")
  if (streamBufs.reasoning.length) message.reasoning = streamBufs.reasoning.join("")
  if (streamBufs.toolCalls.size && Array.isArray(message.tool_calls)) {
    for (const [idx, entry] of streamBufs.toolCalls) {
      const slot = message.tool_calls[idx]
      if (!slot) continue
      if (entry.name.length) slot.function.name = entry.name.join("")
      if (entry.arguments.length) slot.function.arguments = entry.arguments.join("")
    }
  }

  return {
    id: responseId,
    usage,
    choices: [{ message, finish_reason: finishReason }],
    _streamTelemetry: telemetry,
  }
}

function parseSseEvent(event) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
  if (!data) return null
  if (data === "[DONE]") return data
  // Tolerate a malformed SSE frame by skipping it and keeping the stream alive.
  // The two-tier timer still catches truly stuck streams.
  try {
    return JSON.parse(data)
  } catch (error) {
    return { _streamParseError: error.message || String(error), _raw: data.slice(0, 200) }
  }
}

export function mergeDelta(message, delta, onDelta, bufs) {
  let hasContent = false
  if (delta.role) message.role = delta.role
  if (typeof delta.content === "string") {
    // O(1) push when called from the stream loop; fall back to string concat
    // when no bufs are passed to preserve the standalone API.
    if (bufs) bufs.content.push(delta.content)
    else message.content = `${message.content || ""}${delta.content}`
    if (delta.content) hasContent = true
    if (delta.content && onDelta) onDelta({ content: delta.content, message })
  }
  if (typeof delta.reasoning_content === "string") {
    if (bufs) bufs.reasoning_content.push(delta.reasoning_content)
    else message.reasoning_content = `${message.reasoning_content || ""}${delta.reasoning_content}`
    if (delta.reasoning_content) hasContent = true
    // Surface reasoning streams to onDelta too so live token counters tick
    // during the model's thinking phase, not just content writing. The
    // `kind` field lets observers separate channels — most just sum lengths.
    if (delta.reasoning_content && onDelta) {
      onDelta({ reasoning_content: delta.reasoning_content, kind: "reasoning", message })
    }
  }
  if (typeof delta.reasoning === "string") {
    if (bufs) bufs.reasoning.push(delta.reasoning)
    else message.reasoning = `${message.reasoning || ""}${delta.reasoning}`
    if (delta.reasoning) hasContent = true
    if (delta.reasoning && onDelta) {
      onDelta({ reasoning: delta.reasoning, kind: "reasoning", message })
    }
  }
  // OpenAI-compatible streams emit tool_calls as partial chunks indexed by
  // .index. id + function.name typically arrive first, then function.arguments
  // streams piece by piece. Accumulate per index; when streaming, push chunks
  // into arrays and join once at the end.
  if (Array.isArray(delta.tool_calls)) {
    message.tool_calls = message.tool_calls || []
    for (const partial of delta.tool_calls) {
      const idx = Number.isInteger(partial?.index) ? partial.index : message.tool_calls.length
      const slot = message.tool_calls[idx] || { id: "", type: "function", function: { name: "", arguments: "" } }
      if (partial.id) slot.id = partial.id
      if (partial.type) slot.type = partial.type
      if (bufs) {
        let entry = bufs.toolCalls.get(idx)
        if (!entry) {
          entry = { name: [], arguments: [] }
          bufs.toolCalls.set(idx, entry)
        }
        // The function NAME arrives complete (id + name come in the first
        // tool_call delta; only `arguments` stream in fragments). Some
        // providers redundantly re-send the full name on later deltas — naive
        // concatenation then doubles it ("websearch" → "websearchwebsearch"),
        // which also fails to resolve as a tool. Only append genuinely new
        // trailing content. Arguments DO stream and must concatenate.
        if (partial.function?.name && !entry.name.join("").endsWith(partial.function.name)) {
          entry.name.push(partial.function.name)
        }
        if (partial.function?.arguments) entry.arguments.push(partial.function.arguments)
      } else {
        if (partial.function?.name && !(slot.function.name || "").endsWith(partial.function.name)) {
          slot.function.name = `${slot.function.name || ""}${partial.function.name}`
        }
        if (partial.function?.arguments) slot.function.arguments = `${slot.function.arguments || ""}${partial.function.arguments}`
      }
      message.tool_calls[idx] = slot
      hasContent = true
      // Tool-call argument bytes are by far the biggest output channel
      // during write/edit-heavy phases (init agent writes whole files via
      // tool args). Surface them to onDelta so live token counters don't
      // appear "stuck" while the model is busy emitting structured output.
      if (onDelta && (partial.function?.arguments || partial.function?.name)) {
        const argChars = partial.function?.arguments ? partial.function.arguments.length : 0
        const nameChars = partial.function?.name ? partial.function.name.length : 0
        onDelta({
          tool_arguments: partial.function?.arguments || "",
          tool_name: partial.function?.name || "",
          chars: argChars + nameChars,
          kind: "tool_call",
          message,
        })
      }
    }
  }
  return hasContent
}
