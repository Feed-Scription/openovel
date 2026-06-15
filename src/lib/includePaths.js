// Pure, dependency-free contract shared by the @include mechanisms across the
// app. CRITICAL: this module must NOT import any node builtins — it is imported
// both by the node runtime (foregroundCompose, formatContract, the Electron
// main process) AND by the sandboxed renderer (richBlockModel / IncludeBlock).
// Keep it string-logic only.
//
// Two distinct @include features share this contract:
//   - COMPILE-TIME (foregroundCompose.js): expands `@include <path>` lines in
//     FG_template.md into the narrator's prompt. Text only, server-side.
//   - RENDER-TIME (the format-contract `ovl:include` fence): the narrator emits
//     `@include story/includes/<path>` lines the UI resolves into displayed
//     text / image / video / audio. Multimedia, client-side.
// They share the directive syntax + the path-safety check; the render-time
// feature additionally constrains paths to the dedicated story/includes/ dir
// and serves bytes through the `ovl-asset://` protocol below.

// A line whose ONLY non-whitespace content is `@include <path>`.
export const INCLUDE_LINE_RE = /^\s*@include\s+(\S.*?)\s*$/

// @include paths are workspace-relative under story/ or shared/ — no absolute
// filesystem paths, no `~/` home expansion, no `..` escapes. (resolveWorkspacePath
// re-checks server-side; this rejects up front with a directive-specific error.)
export function isUnsafeIncludePath(rel) {
  const value = String(rel || "").trim()
  if (!value) return true
  if (value.startsWith("/") || value.startsWith("\\")) return true     // absolute POSIX/Windows
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true                       // Windows drive letter
  if (value.startsWith("~")) return true                               // ~/ or ~user expansion
  if (value.split(/[\\/]/).includes("..")) return true                 // parent escape
  // First segment must be a recognized scope.
  const head = value.split(/[\\/]/, 1)[0]
  if (head !== "story" && head !== "shared") return true
  return false
}

// Render-time includes are restricted to the dedicated folder: the path must
// resolve under story/includes/<file>. (Render-time only — the compile-time
// @include keeps its broader story//shared scope.)
export function isUnderIncludes(rel) {
  const segments = String(rel || "").trim().replace(/\\/g, "/").split("/").filter(Boolean)
  return segments.length >= 3 && segments[0] === "story" && segments[1] === "includes"
}

// Extension → media kind. The closed allowlist IS the capability envelope for
// what the renderer/protocol will serve. `.ogg` is treated as audio (the common
// case); use `.ogv` for Ogg video.
const KIND_BY_EXT = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video", ogv: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio", flac: "audio",
  md: "text", markdown: "text", txt: "text",
}

export function includeExtension(rel) {
  const m = String(rel || "").toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ""
}

// → "image" | "video" | "audio" | "text" | "unknown"
export function classifyInclude(rel) {
  return KIND_BY_EXT[includeExtension(rel)] || "unknown"
}

// Custom scheme served by the Electron main process (see main.js). A fixed
// authority ("local") keeps the standard-scheme URL parser happy; the
// workspace-relative path rides in the URL path, segment-encoded.
export const ASSET_SCHEME = "ovl-asset"

export function assetUrl(rel) {
  const clean = String(rel || "").trim().replace(/\\/g, "/").replace(/^\/+/, "")
  const encoded = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/")
  return `${ASSET_SCHEME}://local/${encoded}`
}

// Inverse of assetUrl — used by the main-process handler to recover the
// workspace-relative path from an incoming request. Returns "" on anything
// that isn't a well-formed ovl-asset URL.
export function relFromAssetUrl(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== `${ASSET_SCHEME}:`) return ""
    return u.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")
  } catch {
    return ""
  }
}

// Optional per-include attribute lines: a `<key>: <value>` line directly after
// an `@include` attaches to that include. The key set is CLOSED (the same
// posture as every other capability envelope here): `alt` is the accessibility
// description read by screen readers, `caption` is a short visible line shown
// under the media. Values are plain text (the renderer inserts them as text
// nodes, never markup). Both ASCII ":" and the fullwidth "：" separate, since a
// CJK narrator naturally types the latter. "=" is accepted for old saves where
// models emitted `path=... alt=... caption=...`.
const INCLUDE_ATTR_RE = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:：=]\s*(.*)$/
const INCLUDE_ATTR_KEYS = new Set(["alt", "caption"])
const INLINE_INCLUDE_ATTR_RE = /(^|\s)(alt|caption)\s*[:：=]\s*/gi
const INLINE_INCLUDE_PATH_RE = /^(?:path|src|file)\s*[:：=]\s*(\S[\s\S]*)$/i

function splitInlineIncludeAttrs(value) {
  let text = String(value || "").trim()
  if (!text) return { rel: "", attrs: {} }
  const pathAssignment = text.match(INLINE_INCLUDE_PATH_RE)
  if (pathAssignment) text = pathAssignment[1].trim()
  const matches = [...text.matchAll(INLINE_INCLUDE_ATTR_RE)]
  const first = matches.find((match) => match.index > 0)
  if (!first) return { rel: text, attrs: {} }

  const attrs = {}
  const rel = text.slice(0, first.index).trim()
  for (let i = matches.indexOf(first); i < matches.length; i++) {
    const match = matches[i]
    const key = String(match[2] || "").toLowerCase()
    const next = matches[i + 1]
    const start = match.index + match[0].length
    const end = next ? next.index : text.length
    const attrValue = text.slice(start, end).trim()
    if (INCLUDE_ATTR_KEYS.has(key) && attrValue) attrs[key] = attrValue
  }
  return { rel, attrs }
}

// Parse an `ovl:include` fence body into [{ rel, attrs }]. Accepts
// `@include <path>` lines (preferred, mirrors the compile-time syntax) or a
// bare path on its own line; attribute lines attach to the most recent
// include (one before any include is skipped). Tolerant of partial/streamed
// input: blank lines and comments are skipped, never thrown on.
export function parseIncludeDirectives(code) {
  const out = []
  for (const line of String(code ?? "").split(/\r?\n/)) {
    const seg = line.trim()
    if (!seg || seg.startsWith("#") || seg.startsWith("//")) continue
    const inc = seg.match(INCLUDE_LINE_RE)
    if (inc) {
      const parsed = splitInlineIncludeAttrs(inc[1])
      out.push({ rel: parsed.rel, attrs: parsed.attrs })
      continue
    }
    const attr = seg.match(INCLUDE_ATTR_RE)
    if (attr && INCLUDE_ATTR_KEYS.has(attr[1].toLowerCase())) {
      const last = out[out.length - 1]
      const value = attr[2].trim()
      if (last && value) last.attrs[attr[1].toLowerCase()] = value
      continue
    }
    out.push(splitInlineIncludeAttrs(seg))
  }
  return out
}

// Back-compat path-only view of parseIncludeDirectives (attribute lines are
// consumed by the directive parser, so they never show up as bogus paths).
export function parseIncludeLines(code) {
  return parseIncludeDirectives(code).map((entry) => entry.rel)
}
