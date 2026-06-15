// Unified "something was dropped / truncated / rejected" channel.
//
// The framework drops input in many places — sanitizers strip CSS, the envelope
// caps arrays, budgets truncate context, parsers skip corrupt lines. Each such
// site used to invent its own silent return (or its own ad-hoc warning string
// that nobody surfaced), which is exactly how silent-discard bugs creep back in
// every time a feature or setting is added. This module is the ONE way to
// record a discard, with one shape and two routes:
//
//   - MODEL-FACING (return channel): collect notices, then renderNotices() them
//     into a tool result / envelope `warnings` the model actually reads.
//   - OBSERVABILITY (fire-and-forget): reportNotices() to the bus + stderr for
//     drops the operator needs to see (corrupt data, swallowed write failures).
//
// Convention: if your code drops, truncates, rejects, or skips something the
// caller did not explicitly ask to lose, record it here. Never `return ""` /
// `continue` / `.catch(() => {})` a discard silently.

// A lightweight accumulator. Pass one through a transform that may drop things;
// the caller drains it into a return value.
export function createNotices(scope = "") {
  const items = []
  const api = {
    // Generic add. level ∈ "drop" | "truncate" | "reject" | "info".
    add(message, meta = {}) {
      const text = String(message || "").trim()
      if (text) items.push({ scope, level: "info", ...meta, message: text })
      return api
    },
    drop(message, meta = {}) { return api.add(message, { ...meta, level: "drop" }) },
    reject(message, meta = {}) { return api.add(message, { ...meta, level: "reject" }) },
    truncate(what, { kept, dropped } = {}, meta = {}) {
      return api.add(`${what}: kept ${kept}, dropped ${dropped}`, { ...meta, level: "truncate", kept, dropped })
    },
    items: () => items.slice(),
    messages: () => items.map((i) => i.message),
    get size() { return items.length },
    isEmpty() { return items.length === 0 },
  }
  return api
}

// Coerce a string[] OR Notice[] (OR a createNotices sink) to a flat message
// list — so existing `issues: string[]` arrays flow through the same renderer.
function toMessages(input) {
  if (!input) return []
  const arr = typeof input.messages === "function" ? input.messages() : input
  return (Array.isArray(arr) ? arr : [])
    .map((n) => (typeof n === "string" ? n : n && n.message))
    .filter(Boolean)
}

// Consistent human rendering for model-facing surfaces (tool output, lints).
// Returns "" when empty, else a leading-newline block; dedupes and caps.
export function renderNotices(input, { header = "Notices:", cap = 8, bullet = "⚠" } = {}) {
  const unique = [...new Set(toMessages(input))]
  if (!unique.length) return ""
  const lines = ["", header]
  for (const m of unique.slice(0, cap)) lines.push(`  ${bullet} ${m}`)
  if (unique.length > cap) lines.push(`  … and ${unique.length - cap} more`)
  return `\n${lines.join("\n")}`
}

// Observability route: publish a bus event AND write to stderr. For discards the
// operator (not the model) needs to know about. Safe to call with an empty list
// (no-op) and with no bus.
export function reportNotices(input, { bus, event = "notice", prefix = "" } = {}) {
  const messages = toMessages(input)
  if (!messages.length) return
  try { bus?.publish?.(event, { notices: messages }) } catch {}
  for (const m of messages) {
    try { process.stderr.write(`[notice]${prefix ? ` ${prefix}` : ""} ${m}\n`) } catch {}
  }
}
