// CSS sanitizer for the model-authored format contract (see formatContract.js).
//
// THREAT MODEL: the background model may author CSS. The Electron renderer
// already blocks <script>/<style>/external URLs (streamdown sanitize + CSP), so
// CSS cannot exfiltrate data or run code. The residual risk is purely VISUAL
// SPOOFING — a fixed/overlapping overlay that mimics a consent dialog or hides
// the composer. This module is the rule-level half of the defense; the
// structural half is the renderer wrapping all contract output in an isolated,
// overflow-clipped #ovl-content / .ovl-rich root that chrome renders OUTSIDE of
// (so contract z-index can never paint over a permission modal). Neither half
// trusts the other.
//
// Two transforms, same machinery:
//   sanitizeBlockCss(css)   → every selector scoped under `.ovl-rich `
//   sanitizeContentCss(css) → selectors restricted to a curated content
//                             allowlist, scoped under `#ovl-content `
// Plus intersectThemeTokens(theme) for the JSON theme-token channel.
//
// Hand-rolled (no postcss/csstree dep — the runtime stays dependency-free and
// the required transform is shallow). Inputs are untrusted; every function is
// total (never throws) and fails CLOSED (drop on doubt).

// Declarations: closed allowlist of property names / prefixes. Anything not
// matched is dropped. (Allowlist, not blocklist — safer default.)
const ALLOWED_PROP_EXACT = new Set([
  "color", "background-color", "background", "opacity",
  "border-radius", "box-shadow", "box-sizing", "outline",
  "display", "gap", "row-gap", "column-gap",
  "align-items", "align-content", "align-self",
  "justify-items", "justify-content", "justify-self", "place-items", "place-content",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "line-height", "letter-spacing", "word-spacing", "white-space", "word-break",
  "overflow-wrap", "tab-size", "vertical-align", "list-style-type", "list-style-position",
  "transform", "transform-origin", "overflow", "overflow-x", "overflow-y",
  "filter", "mix-blend-mode", "isolation",
])
// Prefixes: any property starting with one of these (and matching the family)
// is allowed — covers font*, margin*, padding*, border*, text*, flex*, grid*,
// and (controlled motion) transition*/animation*. Motion is made safe at the
// value/at-rule level (see processKeyframes + the injected reduced-motion
// override + infinite-loop cap), not by blocking these properties.
const ALLOWED_PROP_PREFIX = [
  "font", "margin", "padding", "border", "text", "flex", "grid", "transition", "animation",
]
// Properties that are NEVER allowed even if a prefix would match (e.g.
// `position`, or escape hatches). position is blocked outright in v1 — even
// `relative`/`absolute` can overlay siblings inside a scroll container.
const BLOCKED_PROP_EXACT = new Set([
  "position", "inset", "top", "right", "bottom", "left",
  "z-index", "pointer-events", "cursor", "content",
  "background-image", "list-style-image", "border-image", "mask", "mask-image",
  "-webkit-mask", "clip-path", "behavior", "-moz-binding",
])
// Value-level kill switches: if a declaration's value contains any of these
// tokens it is dropped regardless of property (covers url() exfil/masking,
// expression() legacy IE, and import smuggling).
const BLOCKED_VALUE_TOKENS = ["url(", "expression(", "image-set(", "-moz-element(", "@import"]

// @keyframes (incl. -webkit-) are handled specially (name-scoped + stop decls
// filtered). Every OTHER at-rule (@media/@supports/@font-face/@page/…) is
// dropped wholesale — theme vars come through the JSON channel, never raw
// @media/:root.
const KEYFRAMES_RE = /^@(?:-webkit-)?keyframes\s+([\w-]+)/i
const KEYFRAME_STOP_RE = /^\s*(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*\s*$/i

// Theme tokens the JSON `theme` map may override (closed allowlist). Mirrors
// the CSS custom properties in renderer/styles/theme.css that are safe to
// retint. NO url()-bearing or layout-breaking tokens.
const ALLOWED_THEME_TOKENS = new Set([
  "--paper", "--paper-soft", "--paper-lift",
  "--ink", "--ink-mid", "--ink-soft", "--ink-faint", "--ink-ghost",
  "--voice-narration", "--voice-user", "--voice-system", "--voice-dialogue",
  "--transcript-font-family", "--transcript-font-size", "--transcript-line-height",
])

// Curated content-selector allowlist. Each entry is matched against the
// selector's LAST compound's key token. Chrome (modals/settings/composer) is
// deliberately absent — it can never be restyled.
const ALLOWED_CONTENT_SELECTORS = [
  ".entry-para", ".entry-narration", "blockquote", "ul", "ol", "li",
  ".ovl-rich", ".ovl-hud", ".option", ".options", ".option-list",
]

function stripComments(css) {
  return String(css || "").replace(/\/\*[\s\S]*?\*\//g, "")
}

// Remove `;`-terminated at-statements (@import/@charset/@namespace) BEFORE
// brace-splitting — they have no `{}` block, so the brace scanner would
// otherwise glue them onto the following rule's selector and drop both.
function stripAtStatements(css) {
  return css.replace(/@(?:import|charset|namespace)\b[^;{}]*;/gi, "")
}

// Split a stylesheet into top-level rules { selector, body } via brace
// matching. Returns ALL rules including at-rules (the caller decides which to
// keep — @keyframes is processed, others dropped). Malformed tails are ignored.
function splitRules(css) {
  const rules = []
  let i = 0
  const n = css.length
  while (i < n) {
    const braceStart = css.indexOf("{", i)
    if (braceStart === -1) break
    const selector = css.slice(i, braceStart).trim()
    let depth = 1
    let j = braceStart + 1
    for (; j < n && depth > 0; j++) {
      if (css[j] === "{") depth++
      else if (css[j] === "}") depth--
    }
    const body = css.slice(braceStart + 1, depth === 0 ? j - 1 : n)
    i = depth === 0 ? j : n
    if (selector) rules.push({ selector, body })
  }
  return rules
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function propAllowed(prop) {
  if (BLOCKED_PROP_EXACT.has(prop)) return false
  if (ALLOWED_PROP_EXACT.has(prop)) return true
  return ALLOWED_PROP_PREFIX.some((p) => prop === p || prop.startsWith(p + "-"))
}

function filterDeclarations(body, issues, nameMap) {
  const out = []
  for (const chunk of String(body || "").split(";")) {
    const seg = chunk.trim()
    if (!seg) continue
    const colon = seg.indexOf(":")
    if (colon < 0) continue
    const prop = seg.slice(0, colon).trim().toLowerCase()
    let value = seg.slice(colon + 1).trim()
    if (!prop || !value) continue
    const lowerVal = value.toLowerCase()
    if (BLOCKED_VALUE_TOKENS.some((t) => lowerVal.includes(t))) {
      issues.push(`dropped ${prop}: value contains a blocked token`)
      continue
    }
    if (!propAllowed(prop)) {
      issues.push(`dropped disallowed property: ${prop}`)
      continue
    }
    // strip !important escalation to keep app fallbacks (incl. reduced-motion) winnable
    value = value.replace(/!\s*important/gi, "").trim()
    // Controlled motion: in animation declarations, rewrite references to the
    // contract's @keyframes names to their scoped (ovl-) form, and cap infinite
    // loops to a finite count so a block can't pulse forever.
    if (prop === "animation" || prop === "animation-name") {
      if (nameMap) for (const [orig, scoped] of nameMap) {
        value = value.replace(new RegExp(`\\b${escapeRe(orig)}\\b`, "g"), scoped)
      }
    }
    if (prop === "animation" || prop === "animation-iteration-count") {
      value = value.replace(/\binfinite\b/gi, "3")
    }
    out.push(`${prop}: ${value}`)
  }
  return out
}

// Sanitize a @keyframes rule: scope its name (ovl-<name>) and filter each stop's
// declarations through the same property allowlist. Returns "" if nothing valid.
function serializeKeyframes(rule, name, nameMap, issues) {
  const parts = []
  for (const stop of splitRules(rule.body)) {
    if (!KEYFRAME_STOP_RE.test(stop.selector)) {
      issues.push(`dropped invalid keyframe stop: ${stop.selector}`)
      continue
    }
    const decls = filterDeclarations(stop.body, issues, nameMap)
    if (decls.length) parts.push(`${stop.selector.trim()} { ${decls.join("; ")} }`)
  }
  if (!parts.length) return ""
  return `@keyframes ${nameMap.get(name)} { ${parts.join(" ")} }`
}

// Injected (trusted) override: honour the OS "reduce motion" setting by killing
// all contract animation/transition within the scope. Appended AFTER
// sanitization so it is never filtered; !important beats author rules (whose
// !important we stripped).
function reducedMotionOverride(scope) {
  return `@media (prefers-reduced-motion: reduce) { ${scope}, ${scope} * { animation: none !important; transition: none !important; } }`
}

// A selector is rejected outright if it tries to reach above the scope.
function selectorEscapesScope(sel) {
  const s = sel.toLowerCase()
  if (/(^|[\s,>+~])(:root|html|body|\*)(\b|[\s,>+~]|$)/.test(s)) return true
  // chrome class fragments — defense in depth (structural isolation is primary)
  if (/(modal|permission|settings|api-key|apikey|composer|footer|onboarding)/.test(s)) return true
  return false
}

function lastCompoundKey(sel) {
  // crude: last whitespace/combinator-separated token, take its leading
  // class/tag/element token
  const parts = sel.split(/[\s>+~]+/).filter(Boolean)
  const last = parts[parts.length - 1] || ""
  const m = last.match(/^[.#]?[a-zA-Z][\w-]*/)
  return m ? m[0] : last
}

function transformRule(rule, { scope, contentAllowlist, nameMap }, issues) {
  const decls = filterDeclarations(rule.body, issues, nameMap)
  if (!decls.length) return ""
  const selectors = rule.selector.split(",").map((s) => s.trim()).filter(Boolean)
  const kept = []
  for (const sel of selectors) {
    if (selectorEscapesScope(sel)) {
      issues.push(`dropped selector escaping scope: ${sel}`)
      continue
    }
    if (contentAllowlist) {
      const key = lastCompoundKey(sel)
      if (!ALLOWED_CONTENT_SELECTORS.includes(key)) {
        issues.push(`dropped non-allowlisted content selector: ${sel}`)
        continue
      }
    }
    kept.push(scopeSelector(scope, sel))
  }
  if (!kept.length) return ""
  return `${kept.join(", ")} { ${decls.join("; ")} }`
}

function scopeSelector(scope, selector) {
  const sel = String(selector || "").trim()
  if (scope === "#ovl-hud-root" && sel === ".ovl-hud") return "#ovl-hud-root.ovl-hud"
  if (scope === "#ovl-hud-root" && sel === ".hud-root") return "#ovl-hud-root.hud-root"
  if (scope === "#ovl-hud-root" && sel.startsWith(".ovl-hud ")) {
    return `#ovl-hud-root.ovl-hud${sel.slice(".ovl-hud".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".hud-root ")) {
    return `#ovl-hud-root.hud-root${sel.slice(".hud-root".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".ovl-hud.")) {
    return `#ovl-hud-root.ovl-hud${sel.slice(".ovl-hud".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".hud-root.")) {
    return `#ovl-hud-root.hud-root${sel.slice(".hud-root".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".ovl-hud:")) {
    return `#ovl-hud-root.ovl-hud${sel.slice(".ovl-hud".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".hud-root:")) {
    return `#ovl-hud-root.hud-root${sel.slice(".hud-root".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".ovl-hud[")) {
    return `#ovl-hud-root.ovl-hud${sel.slice(".ovl-hud".length)}`
  }
  if (scope === "#ovl-hud-root" && sel.startsWith(".hud-root[")) {
    return `#ovl-hud-root.hud-root${sel.slice(".hud-root".length)}`
  }
  return `${scope} ${sel}`
}

function sanitize(css, opts) {
  const issues = []
  const rules = splitRules(stripAtStatements(stripComments(css)))
  // Pass 1: collect @keyframes names so animation references can be rewritten
  // to their scoped form regardless of document order.
  const nameMap = new Map()
  for (const rule of rules) {
    const m = rule.selector.match(KEYFRAMES_RE)
    if (m && !nameMap.has(m[1])) nameMap.set(m[1], `ovl-${m[1]}`)
  }
  // Pass 2: emit scoped keyframes + sanitized rules; drop every other at-rule.
  const out = []
  let usedMotion = false
  for (const rule of rules) {
    const kf = rule.selector.match(KEYFRAMES_RE)
    if (kf) {
      const serialized = serializeKeyframes(rule, kf[1], nameMap, issues)
      if (serialized) { out.push(serialized); usedMotion = true }
      continue
    }
    if (rule.selector.trim().startsWith("@")) continue // drop other at-rules
    const serialized = transformRule(rule, { ...opts, nameMap }, issues)
    if (serialized) {
      out.push(serialized)
      if (/\b(animation|transition)/i.test(serialized)) usedMotion = true
    }
  }
  // Append a trusted reduced-motion override whenever motion is present.
  if (usedMotion) out.push(reducedMotionOverride(opts.scope))
  return { css: out.join("\n"), issues }
}

// Scope every selector under `.ovl-rich ` (the renderer wraps each rich block
// in a .ovl-rich container, so all model-styled nodes are descendants).
export function sanitizeBlockCss(css) {
  return sanitize(css, { scope: ".ovl-rich", contentAllowlist: false })
}

// Restrict to the curated content-selector allowlist and scope under
// `#ovl-content ` (P2 system theming of existing app content surfaces).
export function sanitizeContentCss(css) {
  return sanitize(css, { scope: "#ovl-content", contentAllowlist: true })
}

// Scope HUD CSS under the HUD root. Same property filter; the HUD lives in
// its own isolated root so chrome stays unreachable.
export function sanitizeHudCss(css) {
  return sanitize(css, { scope: "#ovl-hud-root", contentAllowlist: false })
}

// Inline `style=""` channel (HTML block templates). Same property allowlist +
// blocked-value tokens as the `.css` path, but no selector machinery (an inline
// style has none). Returns the cleaned `style` string plus a structured list of
// dropped declarations so the write-gate can name each violation to the model.
// Total (never throws); fails CLOSED (drop on doubt).
export function sanitizeInlineStyle(styleString) {
  const out = []
  const dropped = [] // [{ prop, reason }]
  for (const chunk of String(styleString || "").split(";")) {
    const seg = chunk.trim()
    if (!seg) continue
    const colon = seg.indexOf(":")
    if (colon < 0) continue
    const prop = seg.slice(0, colon).trim().toLowerCase()
    let value = seg.slice(colon + 1).trim()
    if (!prop || !value) continue
    const lowerVal = value.toLowerCase()
    if (BLOCKED_VALUE_TOKENS.some((t) => lowerVal.includes(t))) {
      dropped.push({ prop, reason: "value contains a blocked token (url()/expression()/@import)" })
      continue
    }
    if (!propAllowed(prop)) {
      dropped.push({ prop, reason: "property not in the allowlist" })
      continue
    }
    value = value.replace(/!\s*important/gi, "").trim()
    // Cap infinite animation loops (no @keyframes name-scoping inline — use a
    // class for custom animations; inline motion is still rendered, just bounded).
    if (prop === "animation" || prop === "animation-iteration-count") {
      value = value.replace(/\binfinite\b/gi, "3")
    }
    out.push(`${prop}: ${value}`)
  }
  return { style: out.join("; "), dropped }
}

// Keep only allowlisted theme tokens with safe (no url()/expression) values.
export function intersectThemeTokens(theme) {
  const issues = []
  const tokens = {}
  for (const [rawKey, rawVal] of Object.entries(theme || {})) {
    const key = String(rawKey || "").trim()
    const value = String(rawVal ?? "").trim()
    if (!ALLOWED_THEME_TOKENS.has(key)) {
      issues.push(`dropped non-allowlisted theme token: ${key}`)
      continue
    }
    if (!value || BLOCKED_VALUE_TOKENS.some((t) => value.toLowerCase().includes(t))) {
      issues.push(`dropped theme token with unsafe value: ${key}`)
      continue
    }
    tokens[key] = value.replace(/!\s*important/gi, "").trim()
  }
  return { tokens, issues }
}

// Exposed for tests / reuse.
export const _internals = { splitRules, propAllowed, selectorEscapesScope, ALLOWED_THEME_TOKENS, ALLOWED_CONTENT_SELECTORS }
