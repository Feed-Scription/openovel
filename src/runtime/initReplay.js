// Replay a recorded story-init run as a deterministic demo. The "recording" is
// the init transcript the VM already writes to story/agents/init-<runId>.json
// (#persistInitTranscript) — { messages:[{id,role,text,meta,at}], depth, usage,
// summary, story }, where `messages` is the serialized state.initChat.messages
// (roles: system / user / user-answer / agent / tool-call / ask-user / summary).
//
// `buildReplaySteps` is PURE (fs-free) so it unit-tests; the VM driver applies
// the steps to state.initChat at a fixed demo pace (typing reveal, auto-answer).
// Replaying NEVER runs the model or writes files — it only re-renders a record.

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

// Roles whose text is long-form prose worth a typing reveal.
const TYPED_ROLES = new Set(["agent", "system", "summary"])
const TYPE_MIN_CHARS = 24 // shorter than this → just pop it, no typing

// Find the newest parseable init-*.json under the agents dir. Returns the
// transcript object (with a `messages` array) or null. `requireMessages`
// (default true) keeps the replay semantics: a recording with no conversation
// has no replay value. The init-RESUME path passes false — a transcript whose
// messages were lost (e.g. an old cancel write that raced state teardown)
// still carries the phase + intent needed to put the story back into init.
export async function loadInitTranscript(agentsDir, { requireMessages = true } = {}) {
  let entries = []
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch {
    return null
  }
  // runId encodes an ISO datetime, so a lexical sort is chronological.
  const inits = entries
    .filter((e) => e.isFile() && /^init-.*\.json$/i.test(e.name))
    .map((e) => e.name)
    .sort()
  for (let i = inits.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(await readFile(path.join(agentsDir, inits[i]), "utf8"))
      if (obj && Array.isArray(obj.messages) && (obj.messages.length || !requireMessages)) return obj
    } catch {
      // skip the unreadable one and try the next-newest
    }
  }
  return null
}

// Cheap "does this story have a replay?" check for the library button.
export async function hasInitTranscript(agentsDir) {
  return Boolean(await loadInitTranscript(agentsDir))
}

// An init run that began but never reached a terminal phase: the transcript is
// written with phase "start" the moment the run launches, and rewritten with
// "completed" / "failed" / "cancelled" at the end — so a transcript still at
// "start" means the app was closed (or crashed) mid-init. The VM uses this on
// story open to restore the init-chat and continue the run automatically.
export function isInterruptedInitTranscript(transcript) {
  return Boolean(
    transcript
    && transcript.phase === "start"
    && String(transcript.intent || "").trim(),
  )
}

// An init that began but never produced a finished story: any phase other than
// "complete" (start = app died mid-run; cancelled / failed = the run ended
// without a usable story). Reopening such a story should land back in the init
// flow (auto-resuming only the interrupted case), never on a blank pane or a
// half-built scaffold's auto-opening.
export function isUnfinishedInitTranscript(transcript) {
  if (!transcript || !String(transcript.intent || "").trim()) return false
  // The success path writes "complete"; "completed" accepted defensively
  // (older docs/tests use that spelling).
  return transcript.phase !== "complete" && transcript.phase !== "completed"
}

// Story name + depth from a recording, for the replay's init-chat header.
export function replayMeta(transcript) {
  return {
    storyName: String(transcript?.story?.displayName || transcript?.story?.id || ""),
    depth: String(transcript?.depth?.effective || transcript?.depth?.requested || "standard"),
  }
}

// PURE: transcript → ordered replay steps. Each step is one of:
//   { kind:"message", message, typed }                  push a message
//   { kind:"tool", message }                            a real tool call: the
//        driver plays it running → done so the viewer sees the individual row
//        before it folds into the agent's count (not an instant "done").
//   { kind:"ask", message, pendingAskUser }             show the question box
//   { kind:"answer", message }                          push the recorded answer
//   { kind:"complete", summary, usageTokens }           final state
// Every step carries `usageTokens` — a running target the token readout climbs
// toward as the run plays.
export function buildReplaySteps(transcript) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : []
  const totalTokens = resolveTotalTokens(transcript)
  // The "thinking"/tool steps carry the token climb (the user + system echoes
  // don't cost anything visible).
  const costingIdx = messages
    .map((m, i) => (m.role === "agent" || m.role === "tool-call" || m.role === "summary" ? i : -1))
    .filter((i) => i >= 0)
  const tokenAt = new Map()
  costingIdx.forEach((idx, n) => {
    tokenAt.set(idx, Math.round((totalTokens * (n + 1)) / Math.max(1, costingIdx.length)))
  })

  const steps = []
  let runningTokens = 0
  messages.forEach((m, i) => {
    if (tokenAt.has(i)) runningTokens = tokenAt.get(i)
    const message = sanitizeMessage(m)
    if (m.role === "ask-user") {
      steps.push({ kind: "ask", message, pendingAskUser: askUserFromMessage(message), usageTokens: runningTokens })
    } else if (m.role === "user-answer") {
      steps.push({ kind: "answer", message, usageTokens: runningTokens })
    } else if (m.role === "tool-call" && m.meta?.tool && m.meta.tool !== "explain") {
      // A real tool call (not an `explain` status note): play it running→done so
      // the row shows for a beat instead of folding into the count immediately.
      steps.push({ kind: "tool", message, usageTokens: runningTokens })
    } else {
      const typed = TYPED_ROLES.has(m.role) && message.text.length >= TYPE_MIN_CHARS
      steps.push({ kind: "message", message, typed, usageTokens: runningTokens })
    }
  })
  steps.push({ kind: "complete", summary: String(transcript?.summary || ""), usageTokens: totalTokens })
  return steps
}

function sanitizeMessage(m) {
  return {
    role: String(m?.role || "system"),
    text: String(m?.text ?? ""),
    meta: m?.meta && typeof m.meta === "object" ? m.meta : undefined,
  }
}

// Reconstruct the pendingAskUser payload (the question box) from the recorded
// ask-user message's meta, mirroring the live agent.ask_user.requested handler.
function askUserFromMessage(message) {
  const meta = message.meta || {}
  const options = Array.isArray(meta.options)
    ? meta.options
        .map((o) => ({ label: String(o?.label || "").trim(), description: String(o?.description || "").trim() }))
        .filter((o) => o.label)
    : []
  return {
    id: String(meta.questionId || ""),
    question: message.text,
    header: String(meta.header || ""),
    options,
    multiSelect: Boolean(meta.multiSelect) && options.length > 0,
  }
}

function resolveTotalTokens(transcript) {
  const u = transcript?.usage || {}
  const total = Number(u.totalTokens ?? Number(u.inputTokens || 0) + Number(u.outputTokens || 0))
  return Number.isFinite(total) && total > 0 ? Math.round(total) : 0
}
