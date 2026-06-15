// Raw model-call recorder (opt-in, default OFF).
//
// When OPENOVEL_RECORD_CALLS is on, every model call that goes through the
// single provider funnel (src/provider/provider.js chatMessage) appends a
// complete input->output record to a JSONL file. Each line is a full training
// pair: the exact messages array sent (system prompt + history + user turn),
// the tool schemas actually sent, the call params, AND the full assistant
// response (content + tool_calls + any reasoning + finish_reason + usage).
//
// This is the one place that captures verbatim request/response bytes — the
// usage profile (usageProfile.js) only keeps counts, and the agent thread.jsonl
// ledgers omit the system prompt and the foreground narrator entirely. With
// this on, the whole call stream (narrator, every resident agent, the tool
// loop, signal/memory/summary calls) becomes extractable as training data.
//
// Default file: <storyRoot>/packets/calls.jsonl. Override with
// OPENOVEL_RECORD_CALLS_FILE to collect into one absolute path across stories.

import path from "node:path"
import { appendJsonl } from "../lib/files.js"
import { storyPaths } from "../lib/workspacePaths.js"
import { reportNotices } from "../lib/notices.js"

const TRUTHY = new Set(["1", "true", "yes", "on"])

export function isCallRecordingEnabled(env = process.env) {
  return TRUTHY.has(String(env?.OPENOVEL_RECORD_CALLS || "").toLowerCase())
}

function resolveCallLogPath(env = process.env) {
  const override = String(env?.OPENOVEL_RECORD_CALLS_FILE || "").trim()
  if (override) return path.isAbsolute(override) ? override : path.resolve(override)
  return path.join(storyPaths({ env }).packets, "calls.jsonl")
}

// Copy enumerable own props off the returned message (role, content,
// tool_calls, and any provider-specific extras like reasoning_content). The
// _apiTelemetry handle is non-enumerable so it is intentionally excluded here
// and read separately by the caller.
function snapshotResponseMessage(message) {
  if (!message || typeof message !== "object") return { role: "assistant", content: "" }
  return { ...message }
}

// Append one complete request/response record. Best-effort and fire-and-forget:
// never throws into the hot path, never blocks the response. A write failure is
// operator-facing only (stderr/bus) — it must not reach the model context.
export async function recordRawCall(entry = {}, { env = process.env } = {}) {
  if (!isCallRecordingEnabled(env)) return
  try {
    const {
      role,
      modelProfile,
      provider,
      model,
      params,
      messages,
      tools,
      toolChoice,
      message,
      telemetry,
    } = entry
    const record = {
      at: new Date().toISOString(),
      role,
      modelProfile,
      provider,
      model,
      params: params || {},
      messages: Array.isArray(messages) ? messages : [],
      tools: Array.isArray(tools) ? tools : [],
      toolChoice: toolChoice ?? undefined,
      response: {
        message: snapshotResponseMessage(message),
        finishReason: telemetry?.response?.finishReason,
        usage: telemetry?.usage || {},
      },
    }
    await appendJsonl(resolveCallLogPath(env), record)
  } catch (error) {
    reportNotices([`call recorder: failed to append (${error?.message || error})`], {
      prefix: "callRecorder",
    })
  }
}
