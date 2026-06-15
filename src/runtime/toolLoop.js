import { chatMessage } from "../provider/provider.js"
import { truncateOutput } from "./truncation.js"
import { FileStateCache } from "./fileStateCache.js"
import { parseJsonObject } from "../lib/json.js"
import { reportNotices } from "../lib/notices.js"
import { agentWriteScopeDenial } from "../agents/writeGuard.js"

const TOOL_RESULT_MAX_LINES = 320
const TOOL_RESULT_MAX_BYTES = 16 * 1024
// Keep at most this many recent tool-result messages at full size in the
// rolling tool-loop history; older results collapse to a compact summary.
// Long background workflows can otherwise accumulate megabytes of tool output
// per batch, inflating per-step input tokens and heap usage.
const TOOL_RESULT_WINDOW_RECENT = 8
const TOOL_RESULT_COMPACTED_BYTES = 240
// Paired with TOOL_RESULT_WINDOW_RECENT: when an old tool result body is
// compacted, also compact the corresponding assistant tool-call arguments.
// The model has already seen its own arguments and the tool result by then.
// reasoning_content/content are not touched, and pending tool calls stay intact.
const ASSISTANT_ARGS_WINDOW_RECENT = 8
const ASSISTANT_ARGS_COMPACTED_BYTES = 240
// User confirmations are tiny but load-bearing. In init, a style-anchor answer
// may be followed by many read/search/write calls before the model writes
// tone.md; compacting the ask_user result makes the agent remember that it asked
// while losing what the reader actually picked.
const STICKY_TOOL_RESULTS = new Set(["ask_user"])
// Only compact arguments for tools whose args are themselves the payload
// (write/edit emit multi-KB content strings). Read/search/status tools emit
// small, useful arguments; keep those verbatim for debuggability.
const HEAVY_ARG_TOOLS = new Set(["write", "edit"])

export async function runToolLoop({
  messages,
  model,
  registry,
  bus,
  temperature = 0.4,
  maxTokens = 900,
  json = false,
  maxSteps = 4,
  includeDangerous = false,
  includeTools = null,
  excludeTools = null,
  context = {},
  toolConcurrency = 4,
  role = "background",
  modelProfile = role,
  drainQueuedContext,
  // Per-workflow override for the rolling-window size used by
  // compactOldToolResults / compactOldAssistantToolCallArgs. Default 8
  // (TOOL_RESULT_WINDOW_RECENT) is tuned for short storykeeper / memory
  // workflows. Long deep-init runs benefit from a wider window so the
  // agent can still reason about earlier research results.
  toolResultWindow = TOOL_RESULT_WINDOW_RECENT,
  assistantArgsWindow = ASSISTANT_ARGS_WINDOW_RECENT,
}) {
  const working = [...messages]
  const tools = registry.openAITools({ includeDangerous, includeTools, excludeTools })
  // response_format: json_object and tool-calling conflict on OpenAI-compatible
  // providers: when the model is told "your reply must be a JSON object" it
  // emits the answer envelope on step 0 instead of first calling read/grep/glob
  // to gather context. Observed on the storykeeper loop — it returned a patch
  // every turn without ever using its discovery tools. So we only force JSON on
  // calls that DON'T offer tools (the final no-tools synthesis below, and
  // genuinely tool-less json workflows). During tool steps we leave json off;
  // the system prompt still demands JSON and parseJsonObject extracts it
  // leniently, so the final envelope still parses.
  const stepJson = tools.length ? false : json
  const loopContext = {
    ...context,
    readFileState: context.readFileState || new FileStateCache(),
    readResultState: context.readResultState || new Map(),
    toolResultOrdinalCounter: context.toolResultOrdinalCounter || 0,
    compactedToolResultOrdinal: context.compactedToolResultOrdinal || 0,
  }

  // Live progress events. Renderers (e.g. the init-chat panel in the
  // Electron UI) subscribe to surface a token counter next to the "agent
  // working" indicator. `tool.loop.stream` fires per streamed content chunk
  // (cheap, char-granular); `tool.loop.step` fires once per chat call with
  // real completion_tokens from the provider's usage block.
  const streamMeta = {
    workflow: loopContext.workflow,
    agent: loopContext.agent,
    turnId: loopContext.turnId,
  }
  // Live progress hook. mergeDelta calls this for content, reasoning,
  // reasoning_content, AND tool_call (arguments + name) chunks — we sum
  // them all into a single char count so the renderer's token approximation
  // ticks during tool-heavy phases (init agent writes huge file content as
  // tool arguments — the visual "stuck" pattern was content being empty
  // while tool args streamed). `kind` is informational only here.
  const onStreamDelta = bus
    ? (delta = {}) => {
        const chars =
          (typeof delta.content === "string" ? delta.content.length : 0) +
          (typeof delta.reasoning_content === "string" ? delta.reasoning_content.length : 0) +
          (typeof delta.reasoning === "string" ? delta.reasoning.length : 0) +
          (typeof delta.tool_arguments === "string" ? delta.tool_arguments.length : 0) +
          (typeof delta.tool_name === "string" ? delta.tool_name.length : 0)
        if (!chars) return
        bus.publish?.("tool.loop.stream", { ...streamMeta, chars, kind: delta.kind || "content" })
      }
    : undefined
  const publishStepUsage = (message) => {
    const usage = message?._apiTelemetry?.usage
    if (!bus || !usage) return
    bus.publish?.("tool.loop.step", {
      ...streamMeta,
      completionTokens: Number(usage.completion_tokens || 0),
      promptTokens: Number(usage.prompt_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
    })
  }

  for (let step = 0; step < maxSteps; step++) {
    await injectQueuedContextMessages(working, { drainQueuedContext, context: loopContext, bus, step })
    const message = await chatMessage({
      model,
      role,
      modelProfile,
      messages: working,
      tools,
      toolChoice: "auto",
      temperature,
      maxTokens,
      json: stepJson,
      // Stream reasoning/tool-call generations so long structured outputs keep
      // flowing over the wire. timeoutMs falls back to the provider default.
      stream: true,
      onDelta: onStreamDelta,
    })
    publishStepUsage(message)

    const toolCalls = message.tool_calls || []
    if (toolCalls.length === 0) {
      const content = message.content?.trim() || ""
      // json+tools workflows run tool steps with json mode OFF (stepJson) so
      // tool-calling isn't suppressed. But the model's natural-termination
      // answer here is then NOT json-constrained, so it often isn't a clean
      // JSON object — which made the storykeeper envelope parse as {} and the
      // whole turn get "skipped" (inbox never drained). If json was requested
      // but suppressed during the loop, and this free-form answer isn't usable
      // JSON, do one final json-mode synthesis to force a clean envelope.
      if (json && !stepJson && !isUsableJsonObject(content)) {
        const jsonFinal = await chatMessage({
          model,
          role,
          modelProfile,
          messages: working.concat(message),
          temperature,
          maxTokens,
          json: true,
          stream: true,
          onDelta: onStreamDelta,
        })
        publishStepUsage(jsonFinal)
        // If even the forced json synthesis isn't a usable envelope, downstream
        // parseJsonObject falls back to {} and the whole turn silently no-ops
        // (all the model's work is lost). Surface it instead of swallowing.
        if (!isUsableJsonObject(jsonFinal.content)) {
          reportNotices(
            ["json-mode synthesis did not return a usable JSON envelope; this turn will be treated as a no-op (model output not applied)"],
            { bus, event: "envelope.synthesis_failed", prefix: modelProfile || role },
          )
        }
        return {
          content: jsonFinal.content?.trim() || content,
          messages: working.concat(message, jsonFinal),
          steps: step + 2,
        }
      }
      return { content, messages: working.concat(message), steps: step + 1 }
    }

    working.push(assistantMessageForHistory(message, toolCalls))

    const results = await executeToolCalls(toolCalls, {
      registry,
      bus,
      context: loopContext,
      concurrency: toolConcurrency,
    })
    working.push(...results)
    compactOldToolResults(working, toolResultWindow)
    compactOldAssistantToolCallArgs(working, assistantArgsWindow)
    loopContext.compactedToolResultOrdinal = Math.max(
      loopContext.compactedToolResultOrdinal || 0,
      (loopContext.toolResultOrdinalCounter || 0) - toolResultWindow,
    )
  }

  await injectQueuedContextMessages(working, { drainQueuedContext, context: loopContext, bus, step: maxSteps })
  const final = await chatMessage({
    model,
    role,
    modelProfile,
    messages: working,
    temperature,
    maxTokens,
    json,
    // Stream the final fallback too; long synthesis output is normal for
    // background workflows.
    stream: true,
    onDelta: onStreamDelta,
  })
  publishStepUsage(final)
  return { content: final.content?.trim() || "", messages: working.concat(final), steps: maxSteps + 1 }
}

export async function injectQueuedContextMessages(working, { drainQueuedContext, context = {}, bus = null, step = 0 } = {}) {
  if (typeof drainQueuedContext !== "function") return []
  let messages = []
  try {
    messages = await drainQueuedContext({ context, working, step })
  } catch (error) {
    bus?.publish?.("tool.context.inject_error", {
      agent: context.agent,
      workflow: context.workflow,
      turnId: context.turnId,
      error: error.message || String(error),
    })
    return []
  }
  const valid = Array.isArray(messages)
    ? messages.filter((message) => message && typeof message === "object" && ["user", "assistant", "tool", "system"].includes(message.role))
    : []
  if (!valid.length) return []
  working.push(...valid)
  bus?.publish?.("tool.context.injected", {
    count: valid.length,
    agent: context.agent,
    workflow: context.workflow,
    turnId: context.turnId,
  })
  return valid
}

// Compact tool-result messages older than the most recent K to a short summary
// to keep memory + per-step model input bounded. Mutates `working` in place.
// Why only tool results: assistant messages carry the model's reasoning and
// must remain intact for tool_call_id ↔ tool_result linkage in the chat API.
// Replacing a tool result's content with a brief stat line preserves that
// linkage (tool_call_id stays the same) while dropping the body — the agent
// can still see which tool it called and that it succeeded, just not the
// full output. Empirically the model rarely needs old tool output verbatim;
// it has acted on it already by writing/editing/deciding next step.
export function compactOldToolResults(working, keepRecent) {
  if (!Array.isArray(working) || working.length === 0) return
  // Collect indices of tool-result messages (chat API role: "tool").
  const toolIndices = []
  for (let i = 0; i < working.length; i++) {
    if (working[i] && working[i].role === "tool") toolIndices.push(i)
  }
  if (toolIndices.length <= keepRecent) return
  const cutoff = toolIndices.length - keepRecent
  for (let n = 0; n < cutoff; n++) {
    const idx = toolIndices[n]
    const msg = working[idx]
    const original = String(msg?.content || "")
    if (!original) continue
    if (original.length <= TOOL_RESULT_COMPACTED_BYTES) continue // already small
    // Pull tool name + status out of the tag if present (we wrap results in
    // <tool_result tool="X" status="ok">...). Both attributes are guaranteed
    // by formatToolResult above.
    const tagMatch = original.match(/<tool_result\s+tool="([^"]*)"\s+status="([^"]*)"/)
    const toolName = tagMatch?.[1] || "unknown"
    const status = tagMatch?.[2] || "ok"
    if (STICKY_TOOL_RESULTS.has(toolName)) continue
    working[idx] = {
      ...msg,
      content: `<tool_result tool="${toolName}" status="${status}" compacted="1" original_bytes="${original.length}"/>`,
    }
  }
}

// Compact older assistant messages' tool_calls[i].function.arguments to short
// stubs once their corresponding tool results are already in working[].
//
// Safety rules:
//   1. Do NOT touch reasoning_content / content / name / id. DeepSeek
//      thinking requires reasoning_content "fully passed back"; the model's
//      content carries continuity; id/name are required by the API.
//   2. Do NOT touch a PENDING tool_call (one whose tool result has not yet
//      landed in working[]) — the immediate next chat call may still inspect
//      the arguments. Pending = no role:"tool" message with matching
//      tool_call_id later in the slice.
//   3. Only compact when the assistant message is OUTSIDE the keepRecent
//      window AND has all tool_calls fully resolved by trailing tool
//      messages. Otherwise leave it alone.
//
// Storykeeper's `write` tool emits multi-KB content as an `arguments` JSON
// payload. Long batches can otherwise accumulate many assistant messages with
// large arguments plus reasoning_content; compacting resolved arguments keeps
// memory bounded while preserving the model's own reasoning/content.
export function compactOldAssistantToolCallArgs(working, keepRecent) {
  if (!Array.isArray(working) || working.length === 0) return
  // Collect assistant indices that have tool_calls.
  const assistantIndices = []
  for (let i = 0; i < working.length; i++) {
    const msg = working[i]
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      assistantIndices.push(i)
    }
  }
  if (assistantIndices.length <= keepRecent) return
  const cutoff = assistantIndices.length - keepRecent
  // Walk older assistants. For each, check that EVERY tool_call has a
  // matching tool message later in working[] (i.e. fully resolved). If yes,
  // collapse each arguments string to a stub. If not (pending), skip.
  for (let n = 0; n < cutoff; n++) {
    const idx = assistantIndices[n]
    const msg = working[idx]
    const calledIds = msg.tool_calls.map((c) => c?.id).filter(Boolean)
    if (!calledIds.length) continue
    const resolved = new Set()
    for (let i = idx + 1; i < working.length; i++) {
      const next = working[i]
      if (next?.role === "tool" && next.tool_call_id) resolved.add(next.tool_call_id)
    }
    if (!calledIds.every((id) => resolved.has(id))) continue
    // All fully resolved — compact large arguments strings on tools where
    // arguments are themselves the heavy payload (write/edit). Other tools'
    // arguments stay verbatim; the heap saving is negligible and the
    // debuggability cost is real.
    let calls = null
    for (let c = 0; c < msg.tool_calls.length; c++) {
      const call = msg.tool_calls[c]
      const toolName = call?.function?.name || ""
      if (!HEAVY_ARG_TOOLS.has(toolName)) continue
      const args = typeof call?.function?.arguments === "string" ? call.function.arguments : ""
      if (!args || args.length <= ASSISTANT_ARGS_COMPACTED_BYTES) continue
      if (!calls) calls = msg.tool_calls.map((entry) => ({ ...entry, function: { ...entry.function } }))
      calls[c].function.arguments = `{"_compacted":true,"original_bytes":${args.length},"tool":"${toolName}"}`
    }
    if (calls) working[idx] = { ...msg, tool_calls: calls }
  }
}

export function assistantMessageForHistory(message, toolCalls = message.tool_calls || []) {
  // Thinking-mode providers can require reasoning_content to be passed back on
  // subsequent calls. Keep it when present; non-thinking models simply do not
  // emit the field. Internal telemetry is still dropped from history.
  const out = {
    role: "assistant",
    content: message.content || "",
  }
  if (toolCalls && toolCalls.length) out.tool_calls = toolCalls
  if (typeof message.name === "string") out.name = message.name
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    out.reasoning_content = message.reasoning_content
  }
  if (typeof message.reasoning === "string" && message.reasoning) {
    out.reasoning = message.reasoning
  }
  return out
}

export async function executeToolCalls(toolCalls, { registry, bus, context = {}, concurrency = 4 }) {
  const results = new Array(toolCalls.length)
  let safeBatch = []

  async function flushSafeBatch() {
    if (!safeBatch.length) return
    const batch = safeBatch
    safeBatch = []
    bus?.publish?.("tool.batch.started", { count: batch.length, mode: "parallel" })
    await runLimited(batch, concurrency, async (item) => {
      results[item.index] = await executeOneToolCall(item.call, { registry, bus, context })
    })
    bus?.publish?.("tool.batch.completed", { count: batch.length, mode: "parallel" })
  }

  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index]
    const args = parseArgs(call.function?.arguments)
    if (isParallelSafe(registry, call.function?.name, args)) {
      safeBatch.push({ call, index })
      continue
    }
    await flushSafeBatch()
    results[index] = await executeOneToolCall(call, { registry, bus, context })
  }
  await flushSafeBatch()

  // Expand image follow-ups: a tool message carrying `mediaFollowup` is emitted
  // as the tool message PLUS a user message with the image right after it (kept
  // in tool-call order, so tool_call_id linkage and same-turn coalescing hold).
  const expanded = []
  for (const r of results) {
    if (!r) continue
    const followup = r.mediaFollowup
    if (followup) delete r.mediaFollowup
    expanded.push(r)
    if (followup) expanded.push(followup)
  }
  return expanded
}

async function executeOneToolCall(call, { registry, bus, context }) {
  const name = call.function?.name
  const args = parseArgs(call.function?.arguments)
  const toolResultOrdinal = (context.toolResultOrdinalCounter = (context.toolResultOrdinalCounter || 0) + 1)
  // Emit per-call lifecycle events so UI surfaces can show "currently
  // running" tool calls in real time. Payload is intentionally minimal —
  // arguments/results are large and would flood subscribers.
  const argsSummary = summarizeToolArgs(name, args)
  // Agent attribution: depth 0 = the top-level agent, depth > 0 = a nested
  // subagent spawned via the `task` tool. agentType names the subagent
  // (research / continuity / planner / …). UIs use these to indent and label
  // nested calls so a subagent's tool stream is visually distinct from its
  // parent's instead of one flat, unattributable list.
  const agentDepth = context?.depth || 0
  const agentType = context?.agentType || null
  bus?.publish?.("tool.call.started", {
    id: call.id,
    name,
    argsSummary,
    jobId: context?.jobId,
    agent: context?.agent,
    depth: agentDepth,
    agentType,
    at: new Date().toISOString(),
  })
  let content
  let ok = true
  let errorMessage = ""
  // A tool may return image bytes via a structured `mediaParts` channel (the
  // text summary stays in `content`; base64 NEVER rides the truncating text
  // path). We build the follow-up user message here, inside the try where the
  // tool `result` is in scope, and attach it to the tool message below.
  let mediaFollowup = null
  try {
    // Write-scope guard: a resident sub-agent may only write inside its own file
    // domain. A denial short-circuits into a non-throwing tool error so the model
    // sees it as a normal failure (no-op for unregistered/unscoped agents).
    const denial = agentWriteScopeDenial({ name, args, context })
    const result = denial
      ? { isError: true, output: denial }
      : await registry.execute(name, args, {
          ...context,
          bus,
          callID: call.id,
          toolResultOrdinal,
        })
    // A tool may report a non-throwing failure (e.g. a denied write returns
    // { isError: true, output: <reason> }). Treat that as an error status so
    // the model isn't told "ok" while the content says it was rejected.
    ok = !result?.isError
    if (!ok) errorMessage = String(result?.output || "tool reported an error").slice(0, 240)
    content = await formatToolResult({ name, args, result, error: ok ? null : { message: result.output }, ok })
    const mediaParts = ok && Array.isArray(result?.mediaParts) ? result.mediaParts.filter((p) => p && p.dataBase64) : []
    if (mediaParts.length) {
      mediaFollowup = {
        role: "user",
        content: [
          { type: "text", text: `(image returned by ${name}${result?.title ? ` — ${result.title}` : ""})` },
          ...mediaParts.map((p) => ({ type: "image", mediaType: p.mediaType, dataBase64: p.dataBase64 })),
        ],
      }
    }
  } catch (error) {
    ok = false
    errorMessage = String(error?.message || error || "unknown error").slice(0, 240)
    content = await formatToolResult({ name, args, error, ok: false })
  }
  bus?.publish?.("tool.call.completed", {
    id: call.id,
    name,
    argsSummary,
    jobId: context?.jobId,
    agent: context?.agent,
    depth: agentDepth,
    agentType,
    ok,
    error: errorMessage,
    at: new Date().toISOString(),
  })
  const toolMessage = {
    role: "tool",
    tool_call_id: call.id,
    content,
  }
  // The follow-up user message (built above, where `result` was in scope) carries
  // the image so a vision model sees it; the provider adapter strips it for
  // non-vision models. `executeToolCalls` expands it into a sibling message.
  if (mediaFollowup) toolMessage.mediaFollowup = mediaFollowup
  return toolMessage
}

async function formatToolResult({ name, args, result, error, ok }) {
  const output = ok ? result.output : `Tool ${name} failed: ${error.message || String(error)}`
  const truncated = await truncateOutput(output, {
    maxLines: TOOL_RESULT_MAX_LINES,
    maxBytes: TOOL_RESULT_MAX_BYTES,
    direction: "head",
  })
  const payload = [
    `<tool_result tool="${escapeAttribute(name)}" status="${ok ? "ok" : "error"}">`,
    result?.title ? `<summary>${escapeText(result.title)}</summary>` : "",
    `<arguments>${escapeText(JSON.stringify(args || {}))}</arguments>`,
    result?.metadata && Object.keys(result.metadata).length
      ? `<metadata>${escapeText(JSON.stringify(result.metadata))}</metadata>`
      : "",
    truncated.truncated
      ? `<truncated full_output_path="${escapeAttribute(truncated.outputPath || "")}">true</truncated>`
      : "",
    "<content>",
    truncated.content,
    "</content>",
    "</tool_result>",
  ].filter(Boolean)
  return payload.join("\n")
}

function isParallelSafe(registry, name, args) {
  const tool = registry.get(name)
  if (!tool || tool.destructive || tool.dangerous) return false
  if (typeof tool.concurrencySafe === "function") {
    try {
      return Boolean(tool.concurrencySafe(args))
    } catch {
      return false
    }
  }
  return tool.concurrencySafe === true
}

async function runLimited(items, limit, worker) {
  const max = Math.max(1, Number(limit) || 1)
  let cursor = 0
  const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

// Does this content already contain a usable JSON object? Uses the same
// lenient parse the workflows use (first {...} block), so if the model emitted
// a clean envelope on its own we skip the extra json-mode synthesis call.
export function isUsableJsonObject(content) {
  if (!content) return false
  const parsed = parseJsonObject(content, null)
  return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0)
}

function parseArgs(value) {
  if (!value) return {}
  if (typeof value === "object") return value
  try {
    return JSON.parse(value)
  } catch {
    return { value }
  }
}

function escapeAttribute(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}

function escapeText(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

// Produce a short human-readable summary of the key argument(s) for a tool
// call so the activity feed can show "edit chen-guangming/CARD.md" instead
// of bare "edit". Kept compact — sub-pane rows ellipse-truncate anything long.
// Avoids dumping the full args (which can be huge for write/edit content).
export function summarizeToolArgs(name, args) {
  if (!args || typeof args !== "object") return ""
  const shortPath = (p) => String(p || "").replace(/^\.\//, "").replace(/^story\//, "")
  const truncate = (s, n) => {
    const v = String(s || "")
    return v.length <= n ? v : v.slice(0, n - 1) + "…"
  }
  switch (name) {
    case "explain":
      // The full sentence is the payload (rendered as reader-facing narration),
      // so keep it intact rather than clipping at the generic 60-char fallback.
      return truncate(args.text || "", 280)
    case "read":
    case "write":
    case "edit":
      return shortPath(args.filePath)
    case "glob":
      return args.path
        ? `${args.pattern || ""} in ${shortPath(args.path)}`
        : String(args.pattern || "")
    case "grep": {
      const pattern = `"${truncate(args.pattern || "", 40)}"`
      const where = args.path ? ` in ${shortPath(args.path)}` : ""
      return `${pattern}${where}`
    }
    case "websearch":
      return `"${truncate(args.query || "", 60)}"`
    case "webfetch":
      return truncate(args.url || "", 60)
    case "task":
      return `${args.subagent_type || "subagent"} · ${truncate(args.description || args.prompt || "", 50)}`
    case "task_status":
      return String(args.task_id || "")
    case "ask_user": {
      const count = Array.isArray(args.options) ? args.options.length : 0
      const suffix = count ? ` · ${count} options` : ""
      return `${truncate(args.question || "", 60)}${suffix}`
    }
    case "memory":
      return `${args.action || ""} ${truncate(args.target || "", 40)}`.trim()
    case "monitor":
    case "loop":
      return String(args.id || args.command || "")
    case "bash":
      return `$ ${truncate(args.command || "", 60)}`
    default: {
      // Generic fallback: first string value, truncated.
      for (const k of Object.keys(args)) {
        if (typeof args[k] === "string") return truncate(args[k], 60)
      }
      return ""
    }
  }
}
