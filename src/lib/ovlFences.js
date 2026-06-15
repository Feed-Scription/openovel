// Pure, renderer-safe helpers for the narrator's `ovl:<kind>` fenced blocks
// (no Node APIs; bundled into the Electron renderer like includePaths.js).
//
// Every rich channel keys off the fence LANGUAGE and parses only the fence
// BODY; anything else on the opening line is invisible to the parsers. Models
// drift into exactly that shape (the opening line carrying the key/value data
// inline, body empty), which silently blanks the HUD / block slots. Per the
// never-silently-discard convention we do not drop that data: both the runtime
// (narrator output, before persisting) and the renderer (defense for old saves
// and live streams) run normalizeOvlFences, which moves an opening-line
// payload down into the body where the parsers can see it.

// A fence opener that carries a payload after the kind. CommonMark allows up
// to 3 leading spaces for a fence; the kind grammar mirrors KIND_RE in
// formatContract.js (lowercase-kebab).
const PAYLOAD_FENCE_RE = /^(\s{0,3})```ovl:([a-z][a-z0-9-]*)[ \t]+(\S.*)$/

const ANY_OVL_FENCE_RE = /```ovl:([a-z][a-z0-9-]*)/g

// Best-effort split of an inline payload like `date: x place: y` into one
// body line per pair, breaking before a short key token followed by an ASCII
// colon + whitespace or a fullwidth colon (the two separators parseFence
// accepts). A colon NOT followed by whitespace (https://...) never splits, so
// paths and URLs survive. When no boundary exists the payload stays one line.
function splitInlinePayload(payload) {
  const parts = payload.split(/[ \t]+(?=[^\s:：]{1,16}(?::[ \t]|：))/)
  if (parts.length < 2) return [payload]
  return parts.map((p) => p.trim()).filter(Boolean)
}

// Rewrite malformed `ovl:` fence openers so the payload sits in the body.
// Returns { text, fixes } where fixes lists the kind of each rewritten fence
// (empty array = nothing changed, text === input). Idempotent and total:
// never throws, tolerates partial (mid-stream) input.
export function normalizeOvlFences(text) {
  const s = String(text ?? "")
  if (!s.includes("```ovl:")) return { text: s, fixes: [] }
  const fixes = []
  const out = []
  for (const line of s.split("\n")) {
    const m = line.match(PAYLOAD_FENCE_RE)
    if (!m) {
      out.push(line)
      continue
    }
    const [, indent, kind, payload] = m
    out.push(`${indent}\`\`\`ovl:${kind}`)
    for (const bodyLine of splitInlinePayload(payload.trim())) out.push(indent + bodyLine)
    fixes.push(kind)
  }
  return fixes.length ? { text: out.join("\n"), fixes } : { text: s, fixes }
}

// Unique `ovl:<kind>` fence kinds present in `text`, in first-seen order.
// Used by the runtime to warn when narration emits a kind that is neither a
// reserved channel nor a contract block (it would render as a plain code box).
export function listOvlFenceKinds(text) {
  const s = String(text ?? "")
  const kinds = []
  const seen = new Set()
  let m
  ANY_OVL_FENCE_RE.lastIndex = 0
  while ((m = ANY_OVL_FENCE_RE.exec(s))) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      kinds.push(m[1])
    }
  }
  return kinds
}

// The reserved control-channel kinds (mirrors RESERVED_KINDS in
// formatContract.js, which is not renderer-safe to import from here).
// panel/synopsis are the comic-mode (experimental) panel-script channels —
// parsed by lib/comicScript.js, rendered by ComicStrip, never contract blocks.
export const RESERVED_OVL_KINDS = ["hud", "music", "include", "bg", "panel", "synopsis"]
