// Role-aware recovery for a stalled / interrupted streaming model response.
//
// A streaming call can abort mid-flight (no bytes for chunkTimeoutMs, a dropped
// socket, a 5xx). How we recover depends on WHO is calling:
//
//   - background agents: the onDelta stream only feeds progress/telemetry, never
//     reader-visible prose, so the safe move is to retry the whole request from
//     scratch with exponential backoff (the returned message is always clean —
//     only duplicated progress ticks, which are cosmetic).
//
//   - the foreground narrator: the reader has ALREADY seen the streamed prose, so
//     restarting would visibly replay/duplicate it. Instead we resume from the
//     breakpoint ("断点续写"): prefill the partial as an assistant turn, ask the
//     model to continue, and stitch the continuation onto what was shown. On
//     exhaustion we keep the partial the reader saw, trimmed to its last complete
//     paragraph, rather than losing the turn.
//
// The provider stream readers cooperate by attaching error._partial.content
// (everything accumulated before the abort) to the thrown error.

import {
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  isTransientError,
  withRetry,
} from "../lib/retry.js"
import { reportNotices } from "../lib/notices.js"

// Trailing user turn appended after an assistant-prefill of the partial when we
// resume a stalled foreground generation. Generic and language-neutral: the
// model continues in whatever language its own partial was already in.
export const CONTINUE_INSTRUCTION =
  "Your previous response was cut off before it finished. Continue it from the exact point where it stopped. Do not repeat, restate, or rephrase any text you already produced; output only the remaining continuation."

// Trim a partial generation back to its last COMPLETE paragraph so a recovered-
// but-incomplete narration never commits a dangling half-sentence. Prefers a
// blank-line paragraph break; falls back to the last sentence-ending
// punctuation; keeps the text whole when neither boundary exists.
export function trimToLastParagraph(text) {
  const value = String(text || "").replace(/\s+$/, "")
  if (!value) return value
  const paragraphBreak = value.lastIndexOf("\n\n")
  if (paragraphBreak > 0) return value.slice(0, paragraphBreak).replace(/\s+$/, "")
  const sentence = value.match(/^[\s\S]*[。．.!?！？…]["」』”’')）\]】]*/)
  if (sentence && sentence[0].length) return sentence[0]
  return value
}

// Continuation hygiene. A resumed model does not always continue: some
// (observed with gpt-5.5 behind OpenAI-compatible relays) ignore the prefill
// and re-emit the whole answer, so blind stitching commits the same scene two
// or three times into canon. Every chunk appended after round 1 therefore goes
// through mergeContinuation(): trim the overlap a model produces when it backs
// up a little before resuming, and drop the chunk outright when most of its
// material lines already exist in the assembled text (a rewrite, not a
// continuation). Drops are reported through notices, never silent.
// 6 chars is already distinctive in CJK prose (where models resume mid-
// sentence) while staying long enough that an accidental suffix==prefix
// match in latin text is unlikely.
const MIN_OVERLAP = 6
const MAX_OVERLAP_SCAN = 4000
const REWRITE_MIN_LINES = 5
const REWRITE_DUPLICATE_RATIO = 0.5
const MATERIAL_LINE_LENGTH = 12

// Longest suffix of `assembled` that is also a prefix of `continuation`, so a
// model that restarts a few sentences back stitches without doubling them.
function overlapLength(assembled, continuation) {
  const max = Math.min(assembled.length, continuation.length, MAX_OVERLAP_SCAN)
  for (let k = max; k >= MIN_OVERLAP; k--) {
    if (assembled.endsWith(continuation.slice(0, k))) return k
  }
  return 0
}

// Merge one continuation chunk onto the assembled text.
//   { content, overlapTrimmed, rewriteDropped, duplicateLines, materialLines }
// rewriteDropped means the chunk was a re-answer and content is assembled
// unchanged; the caller decides how to finish (and reports the drop).
export function mergeContinuation(assembled, continuation) {
  const base = String(assembled || "")
  let next = String(continuation || "")
  if (!base || !next) {
    return { content: base + next, overlapTrimmed: 0, rewriteDropped: false, duplicateLines: 0, materialLines: 0 }
  }
  const overlapTrimmed = overlapLength(base, next)
  if (overlapTrimmed) next = next.slice(overlapTrimmed)
  const materialLines = next
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= MATERIAL_LINE_LENGTH)
  const duplicateLines = materialLines.filter((line) => base.includes(line)).length
  const rewriteDropped =
    materialLines.length >= REWRITE_MIN_LINES &&
    duplicateLines / materialLines.length >= REWRITE_DUPLICATE_RATIO
  return {
    content: rewriteDropped ? base : base + next,
    overlapTrimmed,
    rewriteDropped,
    duplicateLines,
    materialLines: materialLines.length,
  }
}

function reportMerge(label, merged) {
  const notices = []
  if (merged.rewriteDropped) {
    notices.push(
      `${label}: resumed stream re-answered instead of continuing (${merged.duplicateLines}/${merged.materialLines} lines already shown); dropped the duplicate continuation`,
    )
  } else if (merged.overlapTrimmed) {
    notices.push(`${label}: trimmed ${merged.overlapTrimmed} overlapping chars from the resumed stream`)
  }
  reportNotices(notices, { prefix: "stream-recovery" })
}

// original messages + an assistant prefill of everything streamed so far + a user
// nudge to resume. Valid for both the OpenAI-compatible and Anthropic message
// shapes (assistant text turn followed by a user turn).
function continuationMessages(messages, assembled) {
  return [
    ...(Array.isArray(messages) ? messages : []),
    { role: "assistant", content: assembled },
    { role: "user", content: CONTINUE_INSTRUCTION },
  ]
}

function backoffDelay(attempt) {
  return Math.min(DEFAULT_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
}

// Wrap one streaming attempt with the recovery policy for its role.
//   recovery: "retry"    -> background: retry from scratch on ANY transient error
//                           (including a mid-stream stall), exponential backoff.
//             "continue" -> foreground prose (json:false): resume from the partial
//                           already streamed; keep the trimmed partial on exhaustion.
//             other      -> legacy gate: retry only transients that fired before the
//                           first frame (preserves behavior for callers that don't opt in).
// runAttempt({ messages, progress, onDelta, attempt }) runs a single streamed call
//   and returns the provider's assistant MESSAGE object. `progress` is the
//   { framesReceived } counter the stream reader mutates. On a mid-stream abort the
//   thrown error must carry error._partial.content.
export async function runStreamingWithRecovery({
  recovery = "default",
  maxAttempts,
  label = "stream",
  messages,
  json = false,
  onDelta,
  runAttempt,
}) {
  if (recovery === "continue" && !json) {
    return continueFromBreakpoint({ maxAttempts, label, messages, onDelta, runAttempt })
  }
  const progress = { framesReceived: 0 }
  const isRetryable =
    recovery === "retry"
      ? (error) => isTransientError(error)
      : (error) => progress.framesReceived === 0 && isTransientError(error)
  return withRetry((attempt) => runAttempt({ messages, progress, onDelta, attempt }), {
    label,
    maxAttempts,
    isRetryable,
  })
}

async function continueFromBreakpoint({ maxAttempts, label, messages, onDelta, runAttempt }) {
  const rounds =
    Number.isFinite(maxAttempts) && maxAttempts >= 1 ? maxAttempts : DEFAULT_RETRY_MAX_ATTEMPTS
  // Everything streamed across prior rounds; already delivered to onDelta, so it
  // is NOT re-emitted — only stitched onto the final/returned content.
  let assembled = ""
  let current = messages
  let lastError
  for (let attempt = 1; attempt <= rounds; attempt++) {
    const progress = { framesReceived: 0 }
    try {
      const message = await runAttempt({ messages: current, progress, onDelta, attempt })
      if (assembled && message) {
        const merged = mergeContinuation(assembled, message.content)
        reportMerge(label, merged)
        // A dropped rewrite means the assembled partial was already a complete
        // answer; finish it the same way the exhaustion path does (trimmed to
        // its last whole paragraph, which also sheds the garbage tokens a
        // degenerating stream dribbles before the stall).
        message.content = merged.rewriteDropped ? trimToLastParagraph(assembled) : merged.content
      }
      return message
    } catch (error) {
      lastError = error
      const partial = String(error?._partial?.content || "")
      const transient = isTransientError(error)
      // Salvage whatever streamed this round exactly once (deduped, so a
      // re-answering round cannot snowball into the next round's prefill).
      if (partial) {
        const merged = assembled ? mergeContinuation(assembled, partial) : null
        if (merged) reportMerge(label, merged)
        assembled = merged ? merged.content : partial
      }
      if (transient && progress.framesReceived > 0 && partial) {
        // Mid-stream stall with usable prose: resume from the breakpoint.
        current = continuationMessages(messages, assembled)
      } else if (transient && !partial) {
        // Pre-frame transient: retry from scratch, carrying any prior prefix.
        current = assembled ? continuationMessages(messages, assembled) : messages
      } else {
        // Non-transient error: stop and keep whatever we salvaged.
        break
      }
      if (attempt < rounds) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)))
      }
    }
  }
  // Exhausted (or non-transient). Keep the prose the reader already saw, trimmed
  // to its last complete paragraph, rather than losing the turn. Only surface the
  // error for provider failover when there is nothing usable to keep.
  if (assembled) {
    const message = { role: "assistant", content: trimToLastParagraph(assembled) }
    Object.defineProperty(message, "_apiTelemetry", {
      value: { streamed: true, recovered: true, truncated: true, usage: {} },
      enumerable: false,
    })
    return message
  }
  throw lastError
}
