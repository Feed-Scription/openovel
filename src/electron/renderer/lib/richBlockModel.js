// Pure (DOM-free) model behind <RichBlock>. Kept separate so the streaming
// safety contract — NEVER throw on partial `code`, render what parses — is
// unit-testable without a renderer.
//
// A fenced `ovl:<kind>` block carries free text in `code`; the contract's
// per-kind `parse` mode maps it into slot values that the template's HTML text
// placeholders (`{{name}}`) pull from. Everything here tolerates truncated input
// (mid-stream).

import {
  assetUrl,
  classifyInclude,
  isUnderIncludes,
  isUnsafeIncludePath,
  parseIncludeDirectives,
} from "../../../lib/includePaths.js"
import { normalizeOvlFences } from "../../../lib/ovlFences.js"

// Every text-level strip/parse below first repairs the known model drift of a
// fence opener carrying its payload inline (the runtime persists normalized
// text, but old saves and live streams still arrive raw). Idempotent + cheap.
function norm(text) {
  return normalizeOvlFences(text).text
}

// Index of the first key/value separator on a line: ASCII ":" / "=", OR the
// fullwidth "：" (U+FF1A). A CJK narrator naturally types the fullwidth colon
// (界面：深色), and some older saves drifted to `key=value`; both should fill
// the same reserved channels. All separators are single UTF-16 units, so
// callers' slice(idx + 1) stays correct.
function firstColon(seg) {
  const found = [seg.indexOf(":"), seg.indexOf("："), seg.indexOf("=")].filter((idx) => idx >= 0)
  return found.length ? Math.min(...found) : -1
}

// Parse the fence body into { raw, pairs } per mode. `raw` is always the full
// (possibly partial) text; `pairs` is [[key, value], ...] for keyvalue mode.
// A trailing incomplete line (no ":"/"：" yet, or empty) is simply ignored — so a
// half-streamed "HP: 4" renders HP=4 and a bare "HP" renders nothing for it.
export function parseFence(code, mode = "raw") {
  const raw = String(code ?? "")
  if (mode !== "keyvalue") return { raw, pairs: [] }
  const pairs = []
  for (const line of raw.split(/\r?\n/)) {
    const seg = line.trim()
    if (!seg) continue
    const colon = firstColon(seg)
    if (colon < 0) continue // incomplete / non-pair line — skip, don't throw
    const key = seg.slice(0, colon).trim()
    const value = seg.slice(colon + 1).trim()
    if (key) pairs.push([key, value])
  }
  return { raw, pairs }
}

// Fill a template's text placeholders from the parsed fence. A placeholder is
// `{{name}}` appearing in an HTML text node:
//   - {{body}} / {{raw}} → in a body-mode block (no keyvalue pairs), the whole
//     (possibly partial) fence body. In a KEYVALUE block they resolve like any
//     other key: the narrator's `body:` / `raw:` line fills them — templates
//     mix named slots with a {{body}} message slot (observed chat-slip), and
//     returning the whole raw there leaked every `key:` line into the render.
//     A keyvalue parse with pairs but no such line renders "" (consistent with
//     named slots), never the raw dump.
//   - {{<key>}}          → the keyvalue pair value for that key ("" if absent)
// Values are inserted as PLAIN TEXT by the renderer (never as HTML/attributes),
// so a slot value can never inject markup. A name that matches nothing becomes
// "" — so a half-streamed fence simply leaves its not-yet-arrived slots blank.
// Total over partial input; never throws.
const SLOT_PLACEHOLDER_RE = /\{\{\s*([^\s{}]+)\s*\}\}/g

export function fillSlots(text, parsed) {
  const str = String(text ?? "")
  if (!str.includes("{{")) return str
  const raw = typeof parsed?.raw === "string" ? parsed.raw : ""
  const pairs = Array.isArray(parsed?.pairs) ? parsed.pairs : []
  return str.replace(SLOT_PLACEHOLDER_RE, (_, name) => {
    const hit = pairs.find(([k]) => k === name)
    if (hit) return hit[1]
    if (name === "body" || name === "raw") return pairs.length ? "" : raw
    return ""
  })
}

// Render-time @include channel: the narrator emits a reserved ```ovl:include```
// fence whose body is `@include story/includes/<path>` lines (one per file).
// Resolve each into a renderable descriptor. Total function over partial input:
// a half-streamed path simply yields a descriptor whose error/kind reflect what
// has arrived so far — the caller renders nothing for it until the fence closes.
//
// `allow` is the contract's optional kind allowlist (null = all kinds). Every
// descriptor is one of:
//   { rel, kind, src, alt, caption } — renderable; src is the ovl-asset:// URL,
//                                      alt/caption are the optional plain-text
//                                      attribute lines ("" when absent)
//   { rel, kind:"unknown", error }   — rejected (unsafe path / unsupported type
//                                      / not permitted by the contract)
export function parseIncludeFence(code, { allow = null } = {}) {
  return parseIncludeDirectives(code).map(({ rel, attrs }) => {
    const alt = String(attrs?.alt || "")
    const caption = String(attrs?.caption || "")
    if (isUnsafeIncludePath(rel) || !isUnderIncludes(rel)) {
      return { rel, kind: "unknown", src: null, alt, caption, error: "path must be inside story/includes/ (no .., no absolute path)" }
    }
    const kind = classifyInclude(rel)
    if (kind === "unknown") {
      return { rel, kind, src: null, alt, caption, error: "unsupported file type" }
    }
    if (Array.isArray(allow) && !allow.includes(kind)) {
      return { rel, kind, src: null, alt, caption, error: `${kind} includes are not permitted by this story's contract` }
    }
    return { rel, kind, src: assetUrl(rel), alt, caption, error: null }
  })
}

// HUD data channel: the narrator emits a reserved ```ovl:hud``` fence carrying
// `key: value` lines. The renderer hides it inline and routes its values to the
// persistent HUD panel. Values merge PER KEY across fences (the narrator is
// told "emit only what you are updating; values persist until changed", so a
// fence that omits a key must NOT blank that slot): later fences override
// earlier ones key by key, a key with an explicit empty value clears its slot
// (the Hud hides empty slots). Total functions.
const CLOSED_HUD_FENCE_RE = /```ovl:hud[^\n]*\n[\s\S]*?```[ \t]*\n?/gi
const TRAILING_HUD_FENCE_RE = /```ovl:hud[^\n]*(?:\n[\s\S]*)?$/i

export function stripHudFencesFromText(text) {
  return norm(text)
    .replace(CLOSED_HUD_FENCE_RE, "")
    .replace(TRAILING_HUD_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
}

// All ovl:hud fences in `text`, merged per key in document order (first-seen
// key order is preserved; Map.set on an existing key keeps its position).
// Returns null when the text has no closed hud fence.
export function parseHudFromText(text) {
  const s = norm(text)
  const re = /```ovl:hud[^\n]*\n([\s\S]*?)```/gi
  const merged = new Map()
  let found = false
  let m
  while ((m = re.exec(s))) {
    found = true
    for (const [key, value] of parseFence(m[1], "keyvalue").pairs) merged.set(key, value)
  }
  return found ? [...merged.entries()] : null
}

// Per-key fold over the whole transcript, oldest first, so a slot keeps its
// last-written value until a later fence changes (or empties) it. Null when
// no narration entry carries a hud fence yet.
export function mergedHudPairsFromEntries(entries) {
  if (!Array.isArray(entries)) return null
  const merged = new Map()
  let found = false
  for (const entry of entries) {
    if (entry?.type !== "narration") continue
    const pairs = parseHudFromText(entry.text || "")
    if (!pairs) continue
    found = true
    for (const [key, value] of pairs) merged.set(key, value)
  }
  return found ? [...merged.entries()] : null
}

// Music cue channel: the narrator emits a reserved ```ovl:music``` fence whose
// body is `<verb>: <short-id>` lines — `bgm` starts/replaces looping background
// music, `play` is a one-shot, `stop` ends playback. Like the HUD fence it is a
// control channel: stripped from the displayed prose, routed to the persistent
// now-playing bar. The narrator references a SEMANTIC SHORT ID only (resolved to
// a stream by the privileged main-process resolver); never a URL. Total over
// partial input — a half-streamed line just doesn't change the cue.
const CLOSED_MUSIC_FENCE_RE = /```ovl:music[^\n]*\n[\s\S]*?```[ \t]*\n?/gi
const TRAILING_MUSIC_FENCE_RE = /```ovl:music[^\n]*(?:\n[\s\S]*)?$/i
const MUSIC_VERBS = new Set(["bgm", "play", "stop"])

export function stripMusicFencesFromText(text) {
  return norm(text)
    .replace(CLOSED_MUSIC_FENCE_RE, "")
    .replace(TRAILING_MUSIC_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
}

// The LAST valid directive across every ovl:music fence in `text`, or null.
// { verb: "bgm"|"play"|"stop", shortId } — a `stop` carries shortId "".
export function parseMusicCueFromText(text) {
  const s = norm(text)
  const re = /```ovl:music[^\n]*\n([\s\S]*?)```/gi
  let cue = null
  let m
  while ((m = re.exec(s))) {
    for (const line of m[1].split(/\r?\n/)) {
      const seg = line.trim()
      if (!seg) continue
      const colon = firstColon(seg)
      if (colon < 0) continue // incomplete / non-directive — skip, never throw
      const verb = seg.slice(0, colon).trim().toLowerCase()
      const shortId = seg.slice(colon + 1).trim()
      if (!MUSIC_VERBS.has(verb)) continue
      if (verb === "stop") cue = { verb: "stop", shortId: "" }
      else if (shortId) cue = { verb, shortId } // a bare `bgm:` with no id doesn't change state
    }
  }
  return cue
}

export function latestMusicCueFromEntries(entries) {
  if (!Array.isArray(entries)) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== "narration") continue
    const cue = parseMusicCueFromText(entry.text || "")
    if (cue) return cue
  }
  return null
}

// Scene backdrop channel: the narrator emits a reserved ```ovl:bg``` fence whose
// body is `set: story/includes/bg/<file>` (persists until changed) or `clear`.
// Looser saved variants are tolerated on parse: `path:`/`src:` verbs and a bare
// trusted includes path with no verb at all (a drift the contract now forbids
// but old saves carry) all read as `set`.
// Like HUD/music it is a control channel: stripped from the displayed prose and
// routed to the SceneBackdrop layer (a host-scrimmed, dimmed page background).
// Paths re-use the include trust rules — inside story/includes/, image extension
// only — and an invalid directive is simply ignored (the previous backdrop
// persists). Total over partial input; never throws.
const CLOSED_BG_FENCE_RE = /```ovl:bg[^\n]*\n[\s\S]*?```[ \t]*\n?/gi
const TRAILING_BG_FENCE_RE = /```ovl:bg[^\n]*(?:\n[\s\S]*)?$/i

export function stripBgFencesFromText(text) {
  return norm(text)
    .replace(CLOSED_BG_FENCE_RE, "")
    .replace(TRAILING_BG_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
}

// Narrator prose sometimes contains a line that is JUST a number followed by a
// period (a dramatic standalone year like "1999." or a bare "1."). CommonMark
// parses that as an ordered-list item (e.g. <ol start="1999">), so the number
// renders as a list MARKER in the left gutter — and a wide marker like "1999."
// overflows the narrow gutter and gets clipped by the reading column's edge.
// Escape the delimiter on lines whose ENTIRE content is a (CommonMark-legal,
// ≤9-digit) ordered-list marker so they render as ordinary prose paragraphs.
// Real list items — which carry text after the marker (`1. Something`) — never
// match, so genuine markdown lists are untouched. Render-only (like the strip*
// helpers); the persisted entry text is unchanged.
const STANDALONE_LIST_MARKER_RE = /^([ \t]*)(\d{1,9})([.)])([ \t]*)$/gm
export function escapeStandaloneListMarkers(text) {
  return String(text ?? "").replace(STANDALONE_LIST_MARKER_RE, "$1$2\\$3$4")
}

// The LAST valid directive across every ovl:bg fence in `text`, or null.
// { verb: "set", rel, src } with src an ovl-asset:// URL, or { verb: "clear" }.
export function parseBackgroundFromText(text) {
  const s = norm(text)
  const re = /```ovl:bg[^\n]*\n([\s\S]*?)```/gi
  let directive = null
  let m
  while ((m = re.exec(s))) {
    for (const line of m[1].split(/\r?\n/)) {
      const seg = line.trim()
      if (!seg) continue
      if (/^clear$/i.test(seg)) { directive = { verb: "clear" }; continue }
      const colon = firstColon(seg)
      if (colon < 0) {
        // Drift tolerance: narrators emit the bare file path with no `set:`
        // verb. A line that IS a trusted includes image path can only mean
        // one thing, so honor it instead of silently dropping the switch.
        if (!isUnsafeIncludePath(seg) && isUnderIncludes(seg) && classifyInclude(seg) === "image") {
          directive = { verb: "set", rel: seg, src: assetUrl(seg) }
        }
        continue // anything else: incomplete / non-directive — skip, never throw
      }
      const verb = seg.slice(0, colon).trim().toLowerCase()
      const rel = seg.slice(colon + 1).trim()
      if (verb === "clear") { directive = { verb: "clear" }; continue }
      // Back-compat for saved narration that emitted `path=...` instead of
      // the documented `set: ...` directive.
      if (!["set", "path", "src"].includes(verb) || !rel) continue
      // Same trust rules as ovl:include: inside story/includes/, image kind only.
      if (isUnsafeIncludePath(rel) || !isUnderIncludes(rel)) continue
      if (classifyInclude(rel) !== "image") continue
      directive = { verb: "set", rel, src: assetUrl(rel) }
    }
  }
  return directive
}

export function latestBackgroundFromEntries(entries) {
  if (!Array.isArray(entries)) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== "narration") continue
    const directive = parseBackgroundFromText(entry.text || "")
    if (directive) return directive
  }
  return null
}
