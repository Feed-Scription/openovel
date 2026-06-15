// Loader for the opt-in per-story "format contract" (rich foreground rendering
// authored by the background loop). OFF by default.
//
// The contract is FILE-BASED under story/format/:
//   config.json            optional pure-JSON config: { version, theme, css,
//                          contentCss, hud, include }
//   blocks/<kind>.html     ONE block per file; the filename stem IS the kind
//                          (lowercase-kebab, also the `ovl:<kind>` fence the
//                          narrator emits); the body is the block's HTML
//                          template with {{slot}} placeholders
//   *.css                  sibling stylesheets referenced from config css lists
//
// (The earlier formats — a primitive-JSON DSL, then HTML embedded in a single
// CONTRACT.md — are gone; CONTRACT.md is no longer read, and the write tool
// refuses it. One template per .html file is the form closest to how models
// write HTML, and a file that IS html cannot be misauthored as a style guide.)
//
// The narrator never sees the CSS — only a tiny marker hint (authored
// separately into the foreground). This module turns the on-disk contract into
// a frozen, SANITIZED object the VM broadcasts to the renderer. Two trust
// boundaries: the CSS sanitizer (scoped + property-filtered before it leaves
// here) and the HTML block sanitizer (htmlBlock.js — each template is sanitized
// to a JSON-serializable HAST the renderer walks WITHOUT innerHTML).
//
// CAPABILITY ENVELOPE is bounded (the HTML tag/attr allowlist + the CSS property
// allowlist + structural isolation in the renderer); the CONTENT CATALOG is open
// — the model invents block kinds by COMPOSING ordinary HTML, no code change.

import path from "node:path"
import { readdir } from "node:fs/promises"
import { ensureDir, readText } from "./files.js"
import { paths } from "./storyStore.js"
import { resolveWorkspacePath } from "./workspacePaths.js"
import { parseJsonObject } from "./json.js"
import { settingsEnv } from "../config/settings.js"
import { isUnsafeIncludePath } from "./includePaths.js"
import { sanitizeBlockCss, sanitizeContentCss, sanitizeHudCss, intersectThemeTokens } from "./cssSanitizer.js"
import { sanitizeBlockHtml } from "./htmlBlock.js"

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
const SLOT_RE = /^[a-z][a-z0-9_-]{0,31}$/
// HUD slot `kind` becomes a CSS class suffix (ovl-hud-<kind>) only; keep it to a
// small known set so a contract can't mint arbitrary HUD classes.
const HUD_SLOT_KINDS = new Set(["text", "bar", "badge", "meter"])
// Kinds reserved for runtime control channels (HUD data, music cues, render-time
// @include, scene backdrop, comic-mode panel script) — never a block-template
// definition, so a blocks/<reserved>.html is refused.
const RESERVED_KINDS = new Set(["hud", "music", "include", "bg", "panel", "synopsis"])
// `{{name}}` placeholder, same shape as richBlockModel.fillSlots.
const SLOT_PLACEHOLDER_RE = /\{\{\s*([^\s{}]+)\s*\}\}/g

// Infer the fence parse mode from the template's placeholders: if it references
// any named slot beyond body/raw, the narrator's fence body is key: value lines
// (keyvalue); otherwise the whole body is the single body/raw slot. There is no
// authored `parse` field — the template itself declares its shape.
function inferParseMode(htmlString) {
  const re = new RegExp(SLOT_PLACEHOLDER_RE.source, "g")
  let m
  while ((m = re.exec(String(htmlString || "")))) {
    const name = m[1]
    if (name !== "body" && name !== "raw") return "keyvalue"
  }
  return "raw"
}

// Lenient boolean read, matching settings.js parseBool and behaviorStore's
// envIsOn. The Settings → Behavior toggle writes "1"/"0" (see behaviorStore.js),
// so a strict `=== "true"` check silently reported the feature as OFF even with
// the box ticked — accept the whole truthy family instead.
function envFlagOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase())
}

// Experimental: the background Image agent. Implies BOTH format-contract and
// story-includes (below) so prepared images actually render — image-gen is
// useless without them, and isFormatContractEnabled short-circuits the contract
// loader before the include OR, so it must be forced on too.
export function isImageGenEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_IMAGE_GEN)
}

// Experimental: scene background images. The narrator selects a prepared image
// from story/includes/bg/ via the reserved `ovl:bg` control fence and the
// renderer shows it as a dimmed, host-scrimmed page backdrop. Like image-gen it
// implies format-contract + story-includes (the fence is documented through the
// contract ecosystem and the bytes are served by the includes asset protocol).
// Works without image-gen (user-supplied files); the Image agent only PREPARES
// backgrounds when image-gen is also on.
export function isImageBackgroundEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_IMAGE_BACKGROUND)
}

// Experimental: per-character visual reference sheets. The Image agent derives
// a written visual spec (story/image/characters.md) plus a generated reference
// sheet image (story/includes/characters/) for each major carded character, and
// holds every later illustration prompt to that spec — cross-image character
// consistency in ordinary (prose) mode. Only meaningful when the Image agent
// can generate, so it requires image-gen rather than forcing it on (a sheet
// feature silently enabling the whole illustration pipeline would surprise).
export function isCharacterSheetsEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_CHARACTER_SHEETS) && isImageGenEnabled(env)
}

// Experimental: comic mode. A per-story presentation mode (story meta.json
// `mode: "comic"`, toggled from the library card menu) gated by this GLOBAL
// switch: with it off the menu entry is hidden and an existing comic meta is
// ignored (the story falls back to prose narration). In comic mode the
// foreground emits a panel script (reserved `ovl:panel` fences) instead of
// prose; the runtime generates the panel images into story/includes/comic/ and
// the renderer shows a picture-story strip. Like music, the fences are
// reserved control channels parsed by the renderer in every mode, so this
// forces neither format-contract nor story-includes on; the ovl-asset://
// protocol that serves the bytes is registered unconditionally.
export function isComicModeEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_COMIC_MODE)
}

// Experimental: fast mode. A per-story pacing mode (story meta.json
// `mode: "fast"`, toggled from the library card menu) gated by this GLOBAL
// switch, mirroring comic mode's two-level shape: with it off the menu entry
// is hidden and an existing fast meta is ignored. In fast mode the narrator
// writes short bursts (roughly 300-500 chars) that compress time montage-style
// and stop at the next meaningful reader decision; the options generator
// carries the gameplay weight. Pure prose: no rendering, includes, or image
// dependencies.
export function isFastModeEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_FAST_MODE)
}

// Reader display preference (Electron Settings → Display, mirrored into the
// env by settingsStore.syncPrefEnv): false means the client renders contract
// blocks in the host's PLAIN style, ignoring model-authored templates/CSS.
// Prompt builders (narrator hint, render/showrunner contracts) read this to
// stop steering toward custom `ovl:<kind>` blocks while they would only show
// as plain cards. The reserved channels (hud/music/bg/include) stay full
// citizens either way. Default true; only an explicit "0" disables it.
export function isCustomRichBlocksEnabled(env = settingsEnv()) {
  return String(env.OPENOVEL_CUSTOM_RICH_BLOCKS ?? "").trim() !== "0"
}

// Experimental: the background Music agent. INDEPENDENT of the format contract —
// the reserved `ovl:music` cue fence is a narration control channel (stripped
// unconditionally in the renderer, like `ovl:hud`, and read by the now-playing
// bar), and its `music-cues.md` guidance composes via FG_template regardless of
// rich rendering. So music-gen forces neither format-contract nor story-includes
// on; it stands alone.
export function isMusicGenEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_MUSIC_GEN)
}

export function isFormatContractEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_FORMAT_CONTRACT) || isImageGenEnabled(env) || isImageBackgroundEnabled(env)
}

// Render-time @include is a SECOND experimental opt-in layered on top of the
// format contract: it requires this user-level toggle AND a contract that
// declares `include: { enabled: true }`. Off by default; surfaced in
// Settings → Behavior (see electron/behaviorStore.js). Image-gen and
// image-background force it on (their bytes are served from story/includes/).
export function isStoryIncludesEnabled(env = settingsEnv()) {
  return envFlagOn(env.OPENOVEL_ENABLE_STORY_INCLUDES) || isImageGenEnabled(env) || isImageBackgroundEnabled(env)
}

// Closed set of media kinds the render-time @include feature may serve. The
// contract opts in (include.enabled) and may narrow to a subset via allow[];
// host code (renderer + ovl-asset protocol) enforces the actual extension
// allowlist (see lib/includePaths.js).
const INCLUDE_KINDS = new Set(["image", "video", "audio", "text"])

// Sanitize the optional `include` block: { enabled, allow? }. allow=null means
// "all kinds"; allow=[] means "explicitly none". Unknown kinds are dropped with
// a notice. Returns null when no include block was authored.
function sanitizeInclude(include, issues) {
  if (!include || typeof include !== "object" || Array.isArray(include)) return null
  const enabled = include.enabled === true
  let allow = null
  if (Array.isArray(include.allow)) {
    allow = []
    for (const k of include.allow) {
      const kind = String(k).toLowerCase()
      if (INCLUDE_KINDS.has(kind)) allow.push(kind)
      else issues.push(`dropped unknown include kind: ${k}`)
    }
  }
  return { enabled, allow }
}

function sanitizeHud(hud, issues) {
  if (!hud || typeof hud !== "object") return null
  const slots = Array.isArray(hud.slots)
    ? hud.slots
        .map((s) => {
          if (!s || typeof s !== "object") return null
          const id = String(s.id || "").trim()
          if (!SLOT_RE.test(id)) { issues.push(`dropped HUD slot with invalid id: ${s.id}`); return null }
          const kind = String(s.kind || "text").toLowerCase()
          return { id, label: s.label != null ? String(s.label).slice(0, 60) : id, kind: HUD_SLOT_KINDS.has(kind) ? kind : "text" }
        })
        .filter(Boolean)
        .slice(0, 32)
    : []
  return { slots, cssPaths: Array.isArray(hud.css) ? hud.css : [] }
}

// Validate ONE block-template file: the filename stem is the kind, the content
// is the HTML template. Returns the sanitized HAST + a SPECIFIC issue list
// (illegal tag/attr/style; bad/reserved kind; no renderable HTML). At LOAD time
// the issues are warnings (the tree is already cleaned); the write gate
// (registerTools) is what REJECTS a template whose issues are non-empty, so the
// model fixes and retries. `class`/`label` default off the kind; `parse` is
// inferred from the template's slots.
export function validateBlockTemplate(filename, html) {
  const base = path.basename(String(filename || ""))
  const stem = base.replace(/\.html?$/i, "")
  const kind = stem.toLowerCase()
  const issues = []
  if (!/\.html?$/i.test(base)) issues.push(`block template files must use the .html extension (got: ${base})`)
  // The RAW stem must be lowercase-kebab: the filename IS the kind the narrator
  // emits as ovl:<kind>, so a cased filename would silently diverge from it.
  if (!KIND_RE.test(stem)) issues.push(`invalid block kind "${stem}": the filename stem must be lowercase-kebab (it becomes the ovl:<kind> fence)`)
  if (RESERVED_KINDS.has(kind)) issues.push(`"${kind}" is a RESERVED control-channel kind (hud/music/include/bg), it cannot be a block template`)
  const raw = String(html || "")
  const { tree, issues: htmlIssues, empty } = sanitizeBlockHtml(raw)
  issues.push(...htmlIssues)
  if (empty) issues.push("template has no renderable HTML")
  return { kind, issues, empty, tree, parse: inferParseMode(raw) }
}

// Advisory lint for HUD css: catch the single-background assumption that makes
// the HUD unreadable (observed: near-white .ovl-hud-value on the paper-light
// header). The HOST toggles `hud-dark` on the HUD root by sampling what's
// behind the strip, so base-scope rules ARE the paper mode and must stay
// ink-dark; light text belongs under a `.hud-dark` selector. Pure text lint
// (no fs), tolerant parser: only plain hex/rgb()/rgba() literals are judged.
const CSS_COLOR_DECL_RE = /(?:^|;|\{)\s*color\s*:\s*([^;}]+)/gi

function colorLightness(value) {
  const v = String(value || "").trim().toLowerCase()
  let m = v.match(/^#([0-9a-f]{3})$/)
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16))
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }
  m = v.match(/^#([0-9a-f]{6})$/)
  if (m) {
    const n = parseInt(m[1], 16)
    return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
  return null // var()/named/other — not judged
}

export function lintHudCssModes(cssText) {
  const warnings = []
  for (const block of String(cssText || "").split("}")) {
    const brace = block.indexOf("{")
    if (brace < 0) continue
    const selector = block.slice(0, brace).trim()
    const body = block.slice(brace + 1)
    if (!/hud/i.test(selector)) continue
    if (/hud-dark/i.test(selector)) continue // dark-mode override: light text is the point
    let m
    CSS_COLOR_DECL_RE.lastIndex = 0
    while ((m = CSS_COLOR_DECL_RE.exec(body))) {
      const lightness = colorLightness(m[1])
      if (lightness != null && lightness > 0.8) {
        warnings.push(
          `HUD css: \`${selector}\` sets a near-white color (${m[1].trim()}) in the BASE (paper/light) scope — it will be invisible on the light header. Base rules are the PAPER mode (keep ink-dark text); put light text under a \`.ovl-hud.hud-dark …\` override instead (the host adds \`hud-dark\` when the strip sits over dark imagery).`,
        )
      }
    }
  }
  return warnings
}

// Validate the config.json text (no fs) — for the write-time tool gate and the
// loader. `issues` is advisory lint; ok=false only when the text is not a JSON
// object at all.
export function validateFormatConfig(text) {
  const issues = []
  const trimmed = String(text || "").trim()
  if (!trimmed) return { ok: true, config: {}, issues }
  const parsed = parseJsonObject(trimmed, null)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, config: null, issues: ["config.json is not a JSON object"] }
  }
  if (parsed.blocks !== undefined) {
    issues.push("config.json has a `blocks` field, it is IGNORED: blocks are the story/format/blocks/<kind>.html files, not config entries")
  }
  if (parsed.template !== undefined || parsed.templates !== undefined) {
    issues.push("config.json has a template field, it is IGNORED: templates live in story/format/blocks/<kind>.html files")
  }
  const reservedChannels =
    parsed.reservedChannels && typeof parsed.reservedChannels === "object" && !Array.isArray(parsed.reservedChannels)
      ? parsed.reservedChannels
      : {}
  const { tokens: theme, issues: themeIssues } = intersectThemeTokens(parsed.theme || {})
  issues.push(...themeIssues)
  // Older/plain-blocks configs grouped host-owned channels under
  // `reservedChannels`. Keep top-level hud/include authoritative, but load the
  // grouped shape so archived stories still activate HUD and render-time media.
  const hud = sanitizeHud(parsed.hud ?? reservedChannels.hud, issues)
  const include = sanitizeInclude(parsed.include ?? reservedChannels.include, issues)
  const cssPaths = Array.isArray(parsed.css) ? parsed.css : []
  const contentCssPaths = Array.isArray(parsed.contentCss) ? parsed.contentCss : []
  for (const rel of [...cssPaths, ...contentCssPaths]) {
    if (isUnsafeIncludePath(rel)) issues.push(`unsafe css path (must be relative inside story/ or shared/): ${rel}`)
  }
  // `archived`: retired block kinds. Their blocks/<kind>.html files STAY on disk
  // (agents have no delete tool; the file is the kind's history) but the loader
  // skips them, so the narrator's catalog stays small. Declarative + reversible:
  // un-archiving is removing the entry. Non-string / malformed entries are
  // linted, not fatal.
  const archived = []
  if (parsed.archived !== undefined) {
    if (!Array.isArray(parsed.archived)) {
      issues.push("config.json `archived` must be an array of block-kind strings; ignored")
    } else {
      for (const entry of parsed.archived) {
        const kind = String(entry || "").trim().toLowerCase()
        if (!kind || typeof entry !== "string") { issues.push(`archived entry ${JSON.stringify(entry)} is not a kind string; ignored`); continue }
        if (!archived.includes(kind)) archived.push(kind)
      }
    }
  }
  return {
    ok: true,
    config: {
      version: Number(parsed.version) || 1,
      theme,
      hud,
      include,
      cssPaths,
      contentCssPaths,
      archived,
    },
    issues,
  }
}

async function loadCssFiles(relPaths, sanitizer, issues) {
  const parts = []
  for (const rel of relPaths || []) {
    if (isUnsafeIncludePath(rel)) { issues.push(`rejected unsafe css path: ${rel}`); continue }
    let resolved
    try { resolved = resolveWorkspacePath(rel) } catch { issues.push(`invalid css path: ${rel}`); continue }
    const raw = await readText(resolved.path, "")
    if (!raw) continue
    const { css, issues: cssIssues } = sanitizer(raw)
    issues.push(...cssIssues)
    if (css) parts.push(css)
  }
  return parts.join("\n")
}

// Read + sanitize every block template under story/format/blocks/. Templates
// with issues still load (their trees are already cleaned — defense-in-depth;
// the write gate is what keeps issues from being persisted), but a template
// with no renderable HTML is dropped.
async function loadBlockTemplates(issues, archivedKinds = new Set()) {
  let entries = []
  try {
    entries = await readdir(paths.formatBlocksDir, { withFileTypes: true })
  } catch {
    return [] // no blocks/ dir — fine, a contract may be config/theme-only
  }
  const blocks = []
  const seen = new Set()
  const files = entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => e.name)
    .sort() // deterministic order; the catalog order is not semantic
  for (const name of files) {
    // Archived kinds (config.json `archived`) keep their template file on disk
    // as history but are not registered: the renderer never sees them and the
    // narrator's catalog stays small. Recorded as an issue, never silent.
    const stem = name.replace(/\.html?$/i, "").toLowerCase()
    if (archivedKinds.has(stem)) { issues.push(`block ${stem}: archived via config.json, not registered`); continue }
    const html = await readText(path.join(paths.formatBlocksDir, name), "")
    const { kind, issues: blockIssues, empty, tree, parse } = validateBlockTemplate(name, html)
    for (const it of blockIssues) issues.push(`block ${kind}: ${it}`)
    if (empty || !KIND_RE.test(kind) || RESERVED_KINDS.has(kind)) continue
    if (seen.has(kind)) { issues.push(`duplicate block kind ${kind} (case-insensitive), first file wins`); continue }
    seen.add(kind)
    blocks.push({ kind, class: `ovl-${kind}`, label: kind, parse, template: tree })
  }
  return blocks
}

// Full load: read config.json + blocks/*.html, sanitize, load+sanitize CSS.
// Returns a frozen object the VM stores in state and the renderer consumes.
// Returns { enabled:false } when the flag is off or no usable contract exists.
export async function loadFormatContract({ env = settingsEnv() } = {}) {
  if (!isFormatContractEnabled(env)) return { enabled: false }
  // Scene backdrop channel is contract-INDEPENDENT once the toggle is on: the
  // backdrop is user/agent-prepared media + a host-owned scrim, so a story with
  // no contract files still gets the `ovl:bg` channel (the renderer keys off
  // this flag; `enabled` must be true for the broadcast object to be active).
  const imageBackground = isImageBackgroundEnabled(env)

  const issues = []
  const configText = await readText(paths.formatConfig, "")
  const { ok, config, issues: configIssues } = validateFormatConfig(configText)
  issues.push(...configIssues)
  const cfg = ok && config ? config : { version: 1, theme: {}, hud: null, include: null, cssPaths: [], contentCssPaths: [], archived: [] }
  const blocks = await loadBlockTemplates(issues, new Set(cfg.archived || []))

  const css = await loadCssFiles(cfg.cssPaths, sanitizeBlockCss, issues)
  const contentCss = await loadCssFiles(cfg.contentCssPaths, sanitizeContentCss, issues)
  const hudCss = cfg.hud ? await loadCssFiles(cfg.hud.cssPaths, sanitizeHudCss, issues) : ""

  // Effective include state = user toggle (env) AND the contract's own opt-in.
  const includeEnabled = isStoryIncludesEnabled(env) && Boolean(cfg.include && cfg.include.enabled)
  const enabled =
    blocks.length > 0 ||
    Boolean(css) || Boolean(contentCss) || Boolean(hudCss) ||
    Object.keys(cfg.theme || {}).length > 0 ||
    Boolean(cfg.hud && cfg.hud.slots.length) ||
    includeEnabled ||
    imageBackground

  // The moment a story opts into render-time includes, make sure the dedicated
  // drop folder exists so the reader has somewhere to put media (binary media
  // is user-supplied — the model can't author it). Lazy + tolerant, mirroring
  // how story/format/ is created on demand rather than for every story.
  if (includeEnabled || imageBackground) {
    await ensureDir(paths.includesDir).catch(() => {})
  }

  return Object.freeze({
    enabled,
    version: cfg.version || 1,
    blocks,
    theme: cfg.theme || {},
    hud: cfg.hud ? { slots: cfg.hud.slots } : null,
    // Reflect the EFFECTIVE enabled state (env toggle ∧ contract opt-in) so the
    // renderer's `include?.enabled` check is the single source of truth.
    include: cfg.include ? { ...cfg.include, enabled: includeEnabled } : null,
    imageBackground,
    css,
    contentCss,
    hudCss,
    issues,
  })
}

export const _internals = { inferParseMode, sanitizeInclude, sanitizeHud, sanitizeBlockHtml, RESERVED_KINDS, KIND_RE }
