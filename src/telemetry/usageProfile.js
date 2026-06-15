import { AsyncLocalStorage } from "node:async_hooks"
import { performance } from "node:perf_hooks"
import path from "node:path"
import { writeJson } from "../lib/files.js"
import { paths } from "../lib/storyStore.js"
import { bus } from "../runtime/bus.js"

const storage = new AsyncLocalStorage()

const MODEL_PRICING_PER_M = {
  "deepseek-v4-flash": {
    input: 0.14,
    cacheRead: 0.0028,
    output: 0.28,
    source: "DeepSeek official pricing, per 1M tokens",
  },
  "deepseek-v4-pro": {
    input: 0.435,
    cacheRead: 0.003625,
    output: 0.87,
    source: "DeepSeek official promotional pricing through 2026-05-31 15:59 UTC",
  },
}

export function createUsageProfile({ action = "", turnId = "", kind = "story-turn" } = {}) {
  const profile = {
    id: `profile_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    kind,
    action,
    turnId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    modelCalls: [],
    toolCalls: [],
    timeline: [],
    notes: [],
  }
  Object.defineProperty(profile, "_startedAtPerfMs", {
    value: performance.now(),
    enumerable: false,
    writable: true,
  })
  return profile
}

export async function runWithUsageProfile(profile, fn) {
  return storage.run(profile, fn)
}

export function currentUsageProfile() {
  return storage.getStore() || null
}

export function recordProfileEvent({ name, category = "turn", atMs, durationMs, metadata } = {}) {
  const profile = currentUsageProfile()
  if (!profile || !name) return null
  if (!Array.isArray(profile.timeline)) profile.timeline = []
  const base = Number(profile._startedAtPerfMs)
  const now = performance.now()
  const event = {
    name: String(name),
    category: String(category || "turn"),
    atMs: roundMs(Number.isFinite(atMs) ? atMs : (Number.isFinite(base) ? now - base : 0)),
  }
  if (Number.isFinite(durationMs)) event.durationMs = roundMs(durationMs)
  const cleanMetadata = sanitizeMetadata(metadata)
  if (cleanMetadata && Object.keys(cleanMetadata).length) event.metadata = cleanMetadata
  profile.timeline.push(event)
  return event
}

export function recordModelCall({
  role,
  modelProfile,
  provider,
  model,
  telemetry,
  ok = true,
  error = "",
  attempt = 1,
} = {}) {
  const profile = currentUsageProfile()
  if (!profile) return null
  const usage = normalizeUsage(telemetry?.usage)
  const cost = estimateCostUSD({ model, usage })
  const call = {
    id: `model_${profile.modelCalls.length + 1}`,
    at: new Date().toISOString(),
    role,
    modelProfile: modelProfile || role,
    provider,
    model,
    attempt,
    ok,
    error,
    durationMs: telemetry?.durationMs ?? 0,
    responseHeadersMs: telemetry?.responseHeadersMs,
    firstFrameMs: telemetry?.firstFrameMs,
    firstContentMs: telemetry?.firstContentMs,
    lastFrameMs: telemetry?.lastFrameMs,
    frameCount: telemetry?.frameCount,
    streamed: telemetry?.streamed ?? false,
    usage,
    cost,
    request: telemetry?.request || {},
    response: telemetry?.response || {},
  }
  profile.modelCalls.push(call)
  // Emit a live event so observers (sidebar aggregate counter, telemetry
  // dashboards) can tick on each call instead of waiting until the whole
  // job's UsageProfile is summarized. Without this, a long-running
  // Storykeeper drain with 20+ model calls shows $0 / 0 tokens in the UI
  // for the entire duration of the job.
  bus.publish("model.call.completed", {
    kind: profile.kind,
    action: profile.action,
    turnId: profile.turnId,
    role,
    modelProfile: modelProfile || role,
    provider,
    model,
    ok,
    usage,
    cost,
    durationMs: call.durationMs,
  })
  return call
}

export async function recordToolCall({ id, input, ok, output, error, durationMs }) {
  const profile = currentUsageProfile()
  if (!profile) return null
  const call = {
    id: `tool_${profile.toolCalls.length + 1}`,
    at: new Date().toISOString(),
    tool: id,
    ok,
    durationMs,
    inputSummary: summarize(input),
    outputChars: typeof output === "string" ? output.length : JSON.stringify(output || "").length,
    error: error || "",
  }
  profile.toolCalls.push(call)
  return call
}

export function completeUsageProfile(profile) {
  if (!profile.completedAt) profile.completedAt = new Date().toISOString()
  return summarizeUsageProfile(profile)
}

export function summarizeUsageProfile(profile) {
  const calls = profile.modelCalls || []
  const tools = profile.toolCalls || []
  const totals = calls.reduce(
    (acc, call) => {
      const usage = call.usage || {}
      acc.inputTokens += usage.inputTokens || 0
      acc.outputTokens += usage.outputTokens || 0
      acc.reasoningTokens += usage.reasoningTokens || 0
      acc.cacheReadInputTokens += usage.cacheReadInputTokens || 0
      acc.cacheMissInputTokens += usage.cacheMissInputTokens || 0
      acc.totalTokens += usage.totalTokens || 0
      acc.estimatedCostUSD += call.cost?.estimatedUSD || 0
      acc.modelDurationMs += call.durationMs || 0
      if (call.firstFrameMs !== undefined) {
        acc.firstFrameSamples.push(call.firstFrameMs)
      }
      if (call.lastFrameMs !== undefined) {
        acc.lastFrameSamples.push(call.lastFrameMs)
      }
      return acc
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
      modelDurationMs: 0,
      firstFrameSamples: [],
      lastFrameSamples: [],
    },
  )
  const toolDurationMs = tools.reduce((sum, call) => sum + (call.durationMs || 0), 0)
  const preFirstChunk = summarizePreFirstChunk(profile.timeline || [])
  return {
    ...profile,
    summary: {
      modelCalls: calls.length,
      toolCalls: tools.length,
      modelDurationMs: totals.modelDurationMs,
      toolDurationMs,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      cacheMissInputTokens: totals.cacheMissInputTokens,
      totalTokens: totals.totalTokens,
      estimatedCostUSD: Number(totals.estimatedCostUSD.toFixed(8)),
      firstFrameMs: percentile(totals.firstFrameSamples, 0.5),
      lastFrameMs: percentile(totals.lastFrameSamples, 0.5),
      byRole: summarizeBy(calls, "role"),
      byModelProfile: summarizeBy(calls, "modelProfile"),
      byModel: summarizeBy(calls, "model"),
      byTool: summarizeTools(tools),
      ...(preFirstChunk ? { preFirstChunk } : {}),
    },
  }
}

export async function persistUsageProfile(profile) {
  const completed = completeUsageProfile(profile)
  await writeJson(paths.latestProfile, completed)
  const file = path.join(paths.profiles, `${completed.id}.json`)
  await writeJson(file, completed)
  return completed
}

export function normalizeUsage(raw = {}) {
  const promptTokens = number(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens)
  const completionTokens = number(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens)
  const cacheReadInputTokens = number(
    raw.prompt_cache_hit_tokens ??
      raw.cache_read_input_tokens ??
      raw.cacheReadInputTokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.inputTokenDetails?.cacheReadTokens,
  )
  const cacheMissInputTokens = number(
    raw.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheReadInputTokens),
  )
  const reasoningTokens = number(
    raw.completion_tokens_details?.reasoning_tokens ??
      raw.output_tokens_details?.reasoning_tokens ??
      raw.reasoning_tokens ??
      raw.reasoningTokens,
  )
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    reasoningTokens,
    cacheReadInputTokens,
    cacheMissInputTokens,
    totalTokens: number(raw.total_tokens ?? raw.totalTokens ?? promptTokens + completionTokens),
    raw,
  }
}

export function estimateCostUSD({ model, usage }) {
  const pricing = MODEL_PRICING_PER_M[model]
  if (!pricing) {
    return {
      estimatedUSD: 0,
      knownPricing: false,
      source: "unknown model pricing",
    }
  }
  const inputMiss = usage.cacheMissInputTokens || Math.max(0, (usage.inputTokens || 0) - (usage.cacheReadInputTokens || 0))
  const inputHit = usage.cacheReadInputTokens || 0
  const output = usage.outputTokens || 0
  const estimatedUSD = (inputMiss * pricing.input + inputHit * pricing.cacheRead + output * pricing.output) / 1_000_000
  return {
    estimatedUSD: Number(estimatedUSD.toFixed(8)),
    knownPricing: true,
    currency: "USD",
    source: pricing.source,
    ratesPerMTokens: {
      input: pricing.input,
      cacheRead: pricing.cacheRead,
      output: pricing.output,
    },
  }
}

function summarizeBy(calls, field) {
  const out = {}
  for (const call of calls) {
    const key = call[field] || "unknown"
    const usage = call.usage || {}
    if (!out[key]) {
      out[key] = {
        calls: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadInputTokens: 0,
        cacheMissInputTokens: 0,
        estimatedCostUSD: 0,
        firstFrameMs: undefined,
        lastFrameMs: undefined,
        streamedCalls: 0,
      }
    }
    out[key].calls++
    if (call.streamed) out[key].streamedCalls++
    out[key].durationMs += call.durationMs || 0
    if (call.firstFrameMs !== undefined) out[key].firstFrameMs = minDefined(out[key].firstFrameMs, call.firstFrameMs)
    if (call.lastFrameMs !== undefined) out[key].lastFrameMs = maxDefined(out[key].lastFrameMs, call.lastFrameMs)
    out[key].inputTokens += usage.inputTokens || 0
    out[key].outputTokens += usage.outputTokens || 0
    out[key].reasoningTokens += usage.reasoningTokens || 0
    out[key].cacheReadInputTokens += usage.cacheReadInputTokens || 0
    out[key].cacheMissInputTokens += usage.cacheMissInputTokens || 0
    out[key].estimatedCostUSD = Number((out[key].estimatedCostUSD + (call.cost?.estimatedUSD || 0)).toFixed(8))
  }
  return out
}

function summarizeTools(tools) {
  const out = {}
  for (const call of tools) {
    const key = call.tool || "unknown"
    if (!out[key]) out[key] = { calls: 0, errors: 0, durationMs: 0, outputChars: 0 }
    out[key].calls++
    if (!call.ok) out[key].errors++
    out[key].durationMs += call.durationMs || 0
    out[key].outputChars += call.outputChars || 0
  }
  return out
}

function number(value) {
  const next = Number(value)
  return Number.isFinite(next) && next > 0 ? next : 0
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      out[key] = item
      continue
    }
    if (typeof item === "number") {
      if (Number.isFinite(item)) out[key] = roundMs(item)
      continue
    }
    if (Array.isArray(item)) {
      out[key] = item
        .filter((x) => x == null || ["string", "number", "boolean"].includes(typeof x))
        .slice(0, 20)
      continue
    }
    out[key] = String(item).slice(0, 500)
  }
  return out
}

function summarizePreFirstChunk(timeline) {
  const events = Array.isArray(timeline) ? timeline : []
  const firstChunk = events.find((event) => event?.name === "first_foreground_chunk")
  if (!firstChunk) return null
  const spans = events
    .filter((event) => event?.category === "pre_first_chunk" && Number.isFinite(event.durationMs))
    .map((event) => ({
      name: event.name,
      durationMs: event.durationMs,
      atMs: event.atMs,
    }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 8)
  return {
    atMs: firstChunk.atMs,
    sinceSubmitMs: firstChunk.metadata?.sinceSubmitMs,
    chunkChars: firstChunk.metadata?.chunkChars,
    topSpans: spans,
  }
}

function summarize(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {})
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function percentile(values, p) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[index]
}

function minDefined(current, next) {
  return current === undefined ? next : Math.min(current, next)
}

function maxDefined(current, next) {
  return current === undefined ? next : Math.max(current, next)
}
