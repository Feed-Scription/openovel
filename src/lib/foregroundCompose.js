import { existsSync } from "node:fs"
import { readdir, rename } from "node:fs/promises"
import path from "node:path"
import { ensureDir, readText, writeAtomic } from "./files.js"
import { paths } from "./storyStore.js"
import { INCLUDE_LINE_RE, isUnsafeIncludePath, classifyInclude } from "./includePaths.js"
import { RESERVED_OVL_KINDS } from "./ovlFences.js"

// Foreground guidance is canonically a directory of section files under
// story/frontend/. Each section file has frontmatter capturing which section it
// is plus last-update telemetry. The runtime composes all section files into a
// unified document for the narrator.
//
// Why split: per-section files let edit calls stay narrow, keep cache-friendly
// bytes stable, and give each section an independent update timestamp.
//
// Backward compat: if the dir doesn't exist (older workspaces, fresh init),
// fall back to reading the legacy story/guidance/FOREGROUND.md. On the next
// applyStorykeeperPatch, the dir gets seeded from the parsed legacy content.

// Array order = render order = prompt-cache ordering hint. Stable-first,
// volatile-last so the narrator's input prefix stays stable across consecutive
// turns and prompt caching can hit even when the volatile tail mutates:
//   - header / tone / forbidden / constants: rarely change (slow loop)
//   - active-characters: incremental updates (low-medium)
//   - scene / open-threads: refreshed every few turns (medium)
//   - active-pressures / directed-beat / pending-consequence: volatile tail (high)
// Filenames are the section id + `.md` (e.g. scene.md). They used to carry a
// numeric prefix (10-scene.md) back when render order was an alphabetical
// filename sort; that prefix became vestigial AND misleading once order moved
// to this array's position (e.g. forbidden rendered before constants, yet was
// numbered 60 vs 40). `legacyFilename` is the old prefixed name — kept ONLY so
// migrateForegroundFilenames() can rename existing workspaces to the new scheme.
export const FOREGROUND_SECTIONS = [
  { id: "header", filename: "header.md", legacyFilename: "00-header.md", heading: null, defaultBody: "" },
  { id: "tone", filename: "tone.md", legacyFilename: "20-tone.md", heading: "Tone", defaultBody: "" },
  // Rich-rendering usage guidance: custom content blocks when enabled, plus
  // enabled reserved render channels such as HUD/includes/background/music.
  // POSITIVE
  // instructions - deliberately its own section, NOT folded into Forbidden /
  // Avoid. A model that finds rich-render usage under a "Forbidden" heading
  // reads the whole rendering protocol as a prohibition and emits plain ```
  // code fences instead. `optional` keeps it out of the
  // default manifest, so plain-prose stories never carry a dangling @include —
  // the agent adds the section + its @include only when it authors a contract.
  { id: "rich-rendering", filename: "rich-rendering.md", legacyFilename: "25-rich-rendering.md", heading: "Rich Rendering", defaultBody: "", optional: true },
  { id: "forbidden", filename: "forbidden.md", legacyFilename: "60-forbidden.md", heading: "Forbidden / Avoid", defaultBody: "" },
  // Constants are story invariants: facts that must remain true until explicitly
  // changed by canon. This section used to be named must-keep.md / "Must Keep",
  // which invited agents to append a turn-by-turn log. Keep the legacy heading
  // and filenames as aliases so old saves and old envelopes migrate cleanly.
  { id: "constants", filename: "constants.md", legacyFilename: "40-must-keep.md", legacyFilenames: ["must-keep.md"], heading: "Constants", headingAliases: ["Must Keep"], defaultBody: "" },
  { id: "active-characters", filename: "active-characters.md", legacyFilename: "30-active-characters.md", heading: "Active Characters", defaultBody: "" },
  // Relationships gets its own section so address forms and pair-by-pair
  // dynamics are surfaced to the narrator without digging through individual
  // character cards.
  { id: "relationships", filename: "relationships.md", legacyFilename: "35-relationships.md", heading: "Active Relationships", defaultBody: "" },
  // `Current Working Set` is a removed legacy section: keep it as a heading alias
  // of Scene so an old on-disk FOREGROUND.md / a stray model-emitted block absorbs
  // into Scene on the next round-trip (no data loss, no unknown-heading warning).
  { id: "scene", filename: "scene.md", legacyFilename: "10-scene.md", heading: "Scene", headingAliases: ["Current Working Set"], defaultBody: "" },
  { id: "open-threads", filename: "open-threads.md", legacyFilename: "50-open-threads.md", heading: "Open Threads", defaultBody: "" },
  // Active Pressures is the interactive-fiction tension-engine section.
  // Constants stores durable facts; Active Pressures is the urgency-ranked
  // working subset the narrator should weigh into idle/interstitial moments.
  { id: "active-pressures", filename: "active-pressures.md", legacyFilename: "55-active-pressures.md", heading: "Active Pressures", defaultBody: "" },
  // This Turn (internal id "directed-beat"): a concrete WORLD event the narrator
  // weaves into the current turn alongside the reader's action — a character
  // arrives, a phone rings, weather breaks, time expires. The Director surfaces it
  // (gated, only when the precondition makes a natural opening genuinely exist) so
  // a scheduled structural beat actually lands instead of a soft pressure being
  // ignored; the Showrunner authors it here. It WEAVES WITH the reader's action,
  // never overrides it (see the contextCapsule carve-out). Distinct from Active
  // Pressures (reactive weights) and from Pending Consequence (honoring a choice
  // already made). Usually empty — fires rarely, cleared once staged. Seeded as an
  // empty stub (ensureCardManifests) so its @include never shows a missing marker.
  // Heading is in-world ("This Turn"), not "Directed Beat", to keep screenwriting
  // vocabulary out of the narrator's view.
  { id: "directed-beat", filename: "directed-beat.md", heading: "This Turn", defaultBody: "" },
  // Pending Consequence: the forward situation the reader's LAST committed option
  // set in motion (its hidden effect.consequence, surfaced by the World Keeper and
  // authored here by the Showrunner). Distinct from Active Pressures: this is the
  // specific thing the NEXT beat must honor because the player chose it. Usually
  // empty — populated only after a key-decision turn, cleared once the beat plays
  // it out. Seeded as an empty stub (ensureCardManifests) so its @include never
  // shows a missing marker on the common empty turns.
  { id: "pending-consequence", filename: "pending-consequence.md", heading: "Pending Consequence", defaultBody: "" },
  // (removed) current-working-set: it never earned a crisp role — it landed as
  // either a vestigial seed stub or a staler duplicate of scene.md. Ongoing /
  // timed protagonist task-tracking now lives in a context card (Card Manager's
  // domain). "Current Working Set" survives only as a Scene heading-alias above.
]

// Card manifests pulled into the composed foreground via @include (alongside
// the section files). `cards.md` is curated by the Storykeeper (durable card
// set); `cards.auto.md` is rewritten by the runtime each turn from the
// deterministic trigger match. Both live under story/guidance/ and hold only
// `@include story/context-cards/<slug>/CARD.md` lines.
const CARD_MANIFEST_INCLUDES = [
  "@include story/guidance/cards.md",
  "@include story/guidance/cards.auto.md",
]

const SECTION_INDEX = Object.fromEntries(FOREGROUND_SECTIONS.map((section) => [section.id, section]))
const HEADING_TO_SECTION = Object.fromEntries(
  FOREGROUND_SECTIONS.flatMap((section) => {
    const headings = [section.heading, ...(section.headingAliases || [])].filter(Boolean)
    return headings.map((heading) => [heading.toLowerCase(), section.id])
  }),
)

// Load the composed foreground guidance the narrator should see. Reads
// FG_template.md and expands every @include in order; that is the SINGLE
// composition path. No hidden whitelist of section files — the model
// always sees the assembly recipe in plain text.
export async function loadForegroundGuidance() {
  if (existsSync(paths.foregroundTemplate)) {
    const composed = await composeFromTemplate(paths.foregroundTemplate)
    if (composed.trim()) return composed
  }
  return ""
}

// Compose by reading FG_template.md, stripping its schema header comment,
// and recursively expanding every @include directive. The template is the
// manifest — its @include lines are the assembly recipe, in declaration
// order.
export async function composeFromTemplate(templatePath = paths.foregroundTemplate) {
  if (!existsSync(templatePath)) return ""
  const raw = await readText(templatePath, "")
  if (!raw.trim()) return ""
  const body = stripHtmlCommentBlocks(raw).trim()
  if (!body) return ""
  const expanded = await expandForegroundIncludes(body)
  const richFallback = await composeRichRenderingFallback(body)
  return (expanded.trim() + (richFallback ? `\n\n${richFallback}` : "")) + "\n"
}

// Delivery safety net for an optional-section gap. rich-rendering.md is an
// `optional` section: the default manifest never lists it, so its @include
// exists only if an agent added the line to FG_template.md. In practice the
// Render Manager / Image agent can fill the section content via Showrunner handoff
// but nobody adds the @include (the Render Manager can't write guidance/, and
// nothing forces the Showrunner to), so generated blocks/illustrations sit
// unused because the narrator never learns the relevant render-channel
// protocol. When the section file carries real content and the template
// doesn't reference it, append it to the composed view, and report a notice
// (never silent). The template stays authoritative for ORDER: adding the
// @include line places the section explicitly and disables this fallback.
let richFallbackReported = false
async function composeRichRenderingFallback(templateBody) {
  if (/story\/frontend\/rich-rendering\.md/.test(templateBody)) return ""
  const file = path.join(paths.foregroundDir, "rich-rendering.md")
  if (!existsSync(file)) return ""
  const rawBody = stripFrontmatter(await readText(file, "")).trim()
  const body = await maybeFilterPlainBlocksRichRendering("story/frontend/rich-rendering.md", rawBody)
  const meaningful = meaningfulRichRenderingBody(body)
  if (!meaningful) return ""
  if (!richFallbackReported) {
    richFallbackReported = true
    const { reportNotices } = await import("./notices.js")
    reportNotices(
      "story/frontend/rich-rendering.md has content but FG_template.md carries no `@include story/frontend/rich-rendering.md`; auto-appending it to the composed foreground. Add the @include line to control its position.",
      { prefix: "[foreground]" },
    )
  }
  return body
}

function meaningfulRichRenderingBody(raw) {
  return stripFrontmatter(String(raw || ""))
    .replace(/^##\s+Rich Rendering\s*$/im, "")
    .replace(/_\(placeholder[^)]*\)_/g, "")
    .trim()
}

function listOvlMentions(text) {
  const kinds = []
  const seen = new Set()
  const re = /ovl:([a-z][a-z0-9-]*)/g
  let m
  while ((m = re.exec(String(text || "")))) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      kinds.push(m[1])
    }
  }
  return kinds
}

function hasCustomOvlMention(text, reservedKinds = new Set(RESERVED_OVL_KINDS)) {
  return listOvlMentions(text).some((kind) => !reservedKinds.has(kind))
}

function formatReservedFenceNames(kinds) {
  return [...kinds].map((kind) => `ovl:${kind}`).join(", ")
}

async function activePromptReservedOvlKinds() {
  const { isImageBackgroundEnabled, isMusicGenEnabled } = await import("./formatContract.js")
  return new Set(["hud", "include", ...(isImageBackgroundEnabled() ? ["bg"] : []), ...(isMusicGenEnabled() ? ["music"] : [])])
}

function filterPlainBlocksRichRenderingBody(text, reservedKinds = new Set(RESERVED_OVL_KINDS)) {
  const lines = String(text || "").split(/\r?\n/)
  const kept = []
  let skippingCustomFence = false
  for (const line of lines) {
    // In plain-blocks mode, keep reserved-channel guidance visible but keep
    // custom block-kind instructions out of the narrator's working set.
    if (skippingCustomFence) {
      if (/^\s*```\s*$/.test(line)) skippingCustomFence = false
      continue
    }
    const fence = line.match(/^\s*```ovl:([a-z][a-z0-9-]*)/)
    if (fence && !reservedKinds.has(fence[1])) {
      skippingCustomFence = true
      continue
    }
    if (hasCustomOvlMention(line, reservedKinds)) continue
    kept.push(line)
  }
  return kept.join("\n")
}

async function maybeFilterPlainBlocksRichRendering(rel, body) {
  if (!/(^|\/)(story\/)?frontend\/rich-rendering\.md$/i.test(String(rel || ""))) return body
  const { isCustomRichBlocksEnabled } = await import("./formatContract.js")
  return isCustomRichBlocksEnabled() ? body : filterPlainBlocksRichRenderingBody(body, await activePromptReservedOvlKinds())
}

async function formatConfigNeedsReservedGuidance() {
  const file = path.join(paths.formatDir, "config.json")
  if (!existsSync(file)) return false
  try {
    const { validateFormatConfig } = await import("./formatContract.js")
    const parsed = validateFormatConfig(await readText(file, ""))
    const config = parsed?.config || {}
    return Boolean(config.hud || config.include?.enabled)
  } catch {
    return false
  }
}

// Does the workspace carry rich-render assets (a format contract's blocks, or
// embeddable story/includes/ media beyond the host-chrome cover) that the
// narrator can only use once story/frontend/rich-rendering.md documents the
// `ovl:` protocol? Returns the gap: assets exist but rich-rendering.md is still
// empty/placeholder. This is the recurring "contract authored but the frontend
// usage never written" save defect — detectable, so callers (preview_narration)
// can hard-stop on it instead of shipping an unused contract. Pure read.
export async function detectUnusedRichRenderingGap() {
  const { isCustomRichBlocksEnabled } = await import("./formatContract.js")
  const customBlocks = isCustomRichBlocksEnabled()
  const blocksDir = path.join(paths.formatDir, "blocks")
  const blockFiles = existsSync(blocksDir)
    ? (await readdir(blocksDir).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".html"))
    : []
  const hasConfig = existsSync(path.join(paths.formatDir, "config.json"))
  // Embeddable includes = anything under story/includes/ EXCEPT the host-chrome
  // cover (cover.* needs no rich-rendering.md), which is what makes assets need
  // the narrator-facing protocol. A shallow scan of the known asset subdirs.
  const includeAssets = []
  for (const sub of ["beats", "bg"]) {
    const dir = path.join(paths.includesDir, sub)
    if (existsSync(dir)) {
      for (const f of await readdir(dir).catch(() => [])) includeAssets.push(`includes/${sub}/${f}`)
    }
  }
  const blockFilesThatNeedGuidance = customBlocks ? blockFiles : []
  const configNeedsGuidance = customBlocks ? hasConfig : await formatConfigNeedsReservedGuidance()
  const hasContract = blockFilesThatNeedGuidance.length > 0 || configNeedsGuidance
  const hasAssets = hasContract || includeAssets.length > 0
  if (!hasAssets) return { gap: false }

  const file = path.join(paths.foregroundDir, "rich-rendering.md")
  const raw = existsSync(file) ? await readText(file, "") : ""
  const meaningful = meaningfulRichRenderingBody(raw)
  if (meaningful) return { gap: false }

  const what = [
    blockFilesThatNeedGuidance.length ? `${blockFilesThatNeedGuidance.length} format block(s) (${blockFilesThatNeedGuidance.map((f) => f.replace(/\.html$/i, "")).join(", ")})` : "",
    !blockFilesThatNeedGuidance.length && configNeedsGuidance ? "a story/format/config.json reserved-channel config" : "",
    includeAssets.length ? `${includeAssets.length} prepared media file(s) under story/includes/` : "",
  ].filter(Boolean).join(" and ")
  return {
    gap: true,
    file: "story/frontend/rich-rendering.md",
    reason: customBlocks
      ? `Rich-render assets exist (${what}) but story/frontend/rich-rendering.md is ${existsSync(file) ? "still a placeholder / empty" : "missing"}. The narrator is never told the \`ovl:\` protocol, so those blocks/media silently degrade to plain text and the contract sits unused. Write the narrator-facing usage into story/frontend/rich-rendering.md (literal \`ovl:<kind>\` fences + when to emit each) and ensure FG_template.md carries \`@include story/frontend/rich-rendering.md\`.`
      : `Reserved rich-render assets exist (${what}) but story/frontend/rich-rendering.md is ${existsSync(file) ? "still a placeholder / empty" : "missing"}. In plain-blocks mode, document only enabled reserved fences (${formatReservedFenceNames(await activePromptReservedOvlKinds())}) and ensure FG_template.md carries \`@include story/frontend/rich-rendering.md\`. Do not add custom block guidance while custom story-card styling is off.`,
  }
}

// Per-asset COVERAGE rule check (warning level; the hard gate above handles the
// all-or-nothing case). In full custom mode, every block kind defined in
// story/format/blocks/<kind>.html must be mentioned by its literal render fence
// token in rich-rendering.md; in plain-blocks mode, stale custom mentions warn
// instead. Embeddable media under story/includes/ (cover.* excluded: host chrome)
//      must each be described in the story/includes/INDEX.md manifest (path +
//      what it depicts + suggested use), so agents can embed without guessing.
// Returns an array of human-readable warning strings; empty = all covered.
export async function detectRichRenderingWarnings() {
  const warnings = []
  const { isCustomRichBlocksEnabled } = await import("./formatContract.js")
  const customBlocks = isCustomRichBlocksEnabled()
  const reservedKinds = await activePromptReservedOvlKinds()
  const rrFile = path.join(paths.foregroundDir, "rich-rendering.md")
  const rr = existsSync(rrFile) ? stripFrontmatter(await readText(rrFile, "")) : ""

  if (!customBlocks) {
    const customMentions = listOvlMentions(rr).filter((kind) => !reservedKinds.has(kind))
    for (const kind of customMentions) {
      warnings.push(
        `plain-blocks mode: story/frontend/rich-rendering.md still mentions custom \`ovl:${kind}\`. The narrator is instructed not to emit content blocks while custom story-card styling is off; remove or park this guidance in story/render/style.md and keep only enabled reserved fences (${formatReservedFenceNames(reservedKinds)}).`,
      )
    }
  }

  // Rule 1: block kinds vs rich-rendering.md mentions. Kinds retired via
  // config.json `archived` are exempt (their files stay as history but the
  // loader skips them); for those the INVERSE is the defect: still being
  // mentioned would tell the narrator to emit a block that no longer renders.
  const blocksDir = path.join(paths.formatDir, "blocks")
  const kinds = existsSync(blocksDir)
    ? (await readdir(blocksDir).catch(() => []))
        .filter((f) => f.toLowerCase().endsWith(".html"))
        .map((f) => f.replace(/\.html$/i, "").toLowerCase())
    : []
  if (customBlocks && kinds.length) {
    let archived = new Set()
    try {
      const { validateFormatConfig } = await import("./formatContract.js")
      const configText = await readText(path.join(paths.formatDir, "config.json"), "")
      const parsed = validateFormatConfig(configText)
      if (parsed.ok && parsed.config) archived = new Set(parsed.config.archived || [])
    } catch { /* unparseable config is the write gate's problem; treat as none archived */ }
    for (const kind of kinds) {
      const mentioned = rr.includes(`ovl:${kind}`)
      if (archived.has(kind)) {
        if (mentioned) {
          warnings.push(
            `block kind \`${kind}\` is ARCHIVED in story/format/config.json but story/frontend/rich-rendering.md still mentions \`ovl:${kind}\` — the narrator will emit a block that no longer renders; remove its usage line (or un-archive the kind).`,
          )
        }
        continue
      }
      if (!mentioned) {
        warnings.push(
          `block kind \`${kind}\` (story/format/blocks/${kind}.html) is never mentioned as \`ovl:${kind}\` in story/frontend/rich-rendering.md — the narrator is never told it exists, so it will never render; add its fence usage line (or archive the kind in config.json \`archived\`).`,
        )
      }
    }
  }

  // Rule 2: embeddable media vs the story/includes/INDEX.md manifest.
  const media = []
  if (existsSync(paths.includesDir)) {
    const walk = async (dir, rel, depth) => {
      if (depth > 2) return
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) { await walk(path.join(dir, entry.name), childRel, depth + 1); continue }
        if (/^cover\.[a-z0-9]+$/i.test(childRel)) continue // host chrome, never embedded
        const kind = classifyInclude(`story/includes/${childRel}`)
        if (kind === "image" || kind === "video" || kind === "audio") media.push(childRel)
      }
    }
    await walk(paths.includesDir, "", 0)
  }
  if (media.length) {
    const idxFile = path.join(paths.includesDir, "INDEX.md")
    if (!existsSync(idxFile)) {
      warnings.push(
        `story/includes/ holds ${media.length} embeddable media file(s) but no story/includes/INDEX.md manifest — author one with a line per file (path, what it depicts, suggested embed moment) so the narrator/agents can include them without guessing.`,
      )
    } else {
      const idx = await readText(idxFile, "")
      for (const rel of media) {
        if (!idx.includes(rel) && !idx.includes(path.basename(rel))) {
          warnings.push(
            `story/includes/${rel} is not described in story/includes/INDEX.md — add a line (path, what it depicts, suggested use) or the asset stays unguessable.`,
          )
        }
      }
    }
  }

  return warnings
}

// Strip top-level HTML comment blocks (the schema header). Keeps the rest
// of the template intact so headings and @include lines survive.
function stripHtmlCommentBlocks(text) {
  let result = String(text || "")
  // Greedy strip of `<!-- ... -->` blocks. Non-greedy so multiple blocks
  // get stripped independently.
  result = result.replace(/<!--[\s\S]*?-->/g, "")
  return result
}

// `@include path/to/file.md` directive expander.
// Syntax: a line whose ONLY non-whitespace content is `@include <path>`.
// Path is workspace-relative (resolved against the active story root via
// resolveWorkspacePath). Cycle detection: each include path is added to a
// visited Set; re-entering it returns a `[include cycle]` marker instead
// of recursing — prevents A→B→A loops from blowing the stack. Hard
// recursion depth ceiling (8) catches pathological linear chains.
//
// INCLUDE_LINE_RE + isUnsafeIncludePath are the shared directive contract
// (lib/includePaths.js) — the render-time `ovl:include` fence reuses them.
const INCLUDE_MAX_DEPTH = 8

// The compile-time @include inlines TEXT into the narrator's foreground; a
// media path (an agent pointing the FG template at story/includes/ art) or
// any binary body must never expand — decoded bytes balloon the composed
// FOREGROUND.md far past the narrator budget as garbage. Three layers, each
// emitting a model-visible diagnostic comment instead of the body: a media
// extension is refused before the read, an oversized file is refused on
// size, and a binary sniff (NUL / UTF-8 replacement chars, the same signal
// storySnapshot uses) catches binaries with unknown extensions. 256KB is far
// above any sane guidance section and far below typical media.
const INCLUDE_MAX_BYTES = 256 * 1024

export async function expandForegroundIncludes(text, depth = 0, visited = new Set()) {
  const src = String(text || "")
  if (!src) return ""
  if (depth >= INCLUDE_MAX_DEPTH) {
    return src.replace(INCLUDE_LINE_RE, () => `<!-- [include depth limit reached] -->`)
  }
  if (!/@include\s+/.test(src)) return src                  // fast path
  const { resolveWorkspacePath } = await import("./workspacePaths.js")
  const { readFile } = await import("node:fs/promises")
  const lines = src.split(/\r?\n/)
  const out = []
  // Fenced code blocks pass through VERBATIM, directives inside them are
  // examples, not instructions. The concrete failure: rich-rendering.md
  // demonstrates the render-time ovl:include fence to the narrator, and the
  // demonstration body carries a literal `@include story/includes/<img>`
  // line; line-by-line matching expanded it at compile time, inlining image
  // bytes into FOREGROUND.md. Fence-length tracking (close needs a bare run
  // at least as long as the open) keeps ````-wrapped examples containing
  // ``` lines intact too.
  let fenceLen = 0
  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,})(.*)$/)
    if (fence) {
      if (!fenceLen) fenceLen = fence[1].length
      else if (fence[1].length >= fenceLen && !fence[2].trim()) fenceLen = 0
      out.push(line)
      continue
    }
    if (fenceLen) { out.push(line); continue }
    const match = line.match(INCLUDE_LINE_RE)
    if (!match) { out.push(line); continue }
    const rel = match[1]
    // For failed includes (rejected/invalid/missing/cycle): emit ONLY a
    // diagnostic HTML comment, never the original directive line —
    // otherwise the literal `@include ...` token would leak into the
    // composed narrator view AND would break parseForegroundGuidance
    // boundaries when the next round-trip tries to re-split sections.
    if (isUnsafeIncludePath(rel)) {
      out.push(`<!-- [include path rejected (must be relative inside story/ or shared/): ${rel}] -->`)
      continue
    }
    let resolved
    try {
      resolved = resolveWorkspacePath(rel)
    } catch {
      out.push(`<!-- [include path invalid: ${rel}] -->`)
      continue
    }
    if (visited.has(resolved.path)) {
      out.push(`<!-- [include cycle: ${rel} already included above] -->`)
      continue
    }
    const mediaKind = classifyInclude(rel)
    if (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio") {
      out.push(`<!-- [include skipped: ${rel} is ${mediaKind} (binary, not inlined here); the foreground @include carries text only. Media embeds at render time via the ovl:include fence] -->`)
      continue
    }
    let buf
    try {
      buf = await readFile(resolved.path)
    } catch {
      out.push(`<!-- [include missing: ${rel}] -->`)
      continue
    }
    if (buf.length > INCLUDE_MAX_BYTES) {
      out.push(`<!-- [include skipped: ${rel} is ${Math.round(buf.length / 1024)}KB, over the ${Math.round(INCLUDE_MAX_BYTES / 1024)}KB foreground include cap; split or trim it] -->`)
      continue
    }
    let body = buf.toString("utf8")
    if (body.includes("\u0000") || body.includes("�")) {
      out.push(`<!-- [include skipped: ${rel} is binary, not inlined here; the foreground @include carries text only] -->`)
      continue
    }
    body = await maybeFilterPlainBlocksRichRendering(rel, body)
    visited.add(resolved.path)
    // Strip YAML frontmatter (`--- ... ---` at top) so per-section metadata
    // doesn't leak into the composed narrator view. Section files written
    // by writeForegroundGuidance always have frontmatter.
    body = stripFrontmatter(body)
    const expanded = await expandForegroundIncludes(body, depth + 1, visited)
    out.push(expanded.trimEnd())
    // Sibling includes of the same file are fine — only ancestor cycles
    // are blocked. So we don't delete from visited on the way out at the
    // top level; we do at nested levels via a per-call clone? Simpler: a
    // truly-shared visited Set is fine for tree expansion since the same
    // file in two unrelated subtrees would still be ok to inline twice.
    // To support that we'd want a copy-on-recurse Set; keep simpler
    // semantics for now (each path inlined at most once per template).
  }
  return out.join("\n")
}

// Validate an FG_template.md (or any content using @include directives)
// without running the heavy expansion. Returns issues + a flat list of
// include directives the file declared. Used by the write/edit tools after
// a model touches FG_template.md so the model gets immediate feedback.
export async function validateForegroundTemplate(content) {
  const { resolveWorkspacePath } = await import("./workspacePaths.js")
  const issues = []
  const includes = []
  const src = stripHtmlCommentBlocks(content || "")
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(INCLUDE_LINE_RE)
    if (!m) continue
    const rel = m[1]
    const entry = { line: i + 1, path: rel, resolved: null, exists: false }
    if (isUnsafeIncludePath(rel)) {
      issues.push({
        severity: "error",
        line: entry.line,
        message: `@include rejects unsafe path: ${rel}. Use a workspace-relative path inside story/ or shared/ (no leading slash, no '..').`,
      })
      includes.push(entry)
      continue
    }
    try {
      const resolved = resolveWorkspacePath(rel)
      entry.resolved = resolved.path
      entry.exists = existsSync(resolved.path)
      if (!entry.exists) {
        issues.push({
          severity: "warn",
          line: entry.line,
          message: `@include path doesn't exist yet: ${rel}`,
        })
      }
    } catch (err) {
      issues.push({
        severity: "error",
        line: entry.line,
        message: `@include path invalid: ${rel} (${err.message || err})`,
      })
    }
    includes.push(entry)
  }
  // Heuristic: a freshly-edited template with no @includes at all means
  // the model dropped the manifest. Surface that as a warning so the
  // model can re-add include lines.
  if (!includes.length && src.trim()) {
    issues.push({
      severity: "warn",
      message: "FG_template.md has no @include directives — narrator will see only the inline body (no section files will be composed).",
    })
  }
  return { issues, includes }
}

// Parse a unified FOREGROUND.md (or anything in that shape) into per-section
// bodies. Headings recognized: Scene (legacy alias: Current Working Set), Tone,
// Active Characters, Constants (legacy: Must Keep), Open Threads, Forbidden /
// Avoid. Anything before the first recognized heading goes into "header".
export function parseForegroundGuidance(text) {
  const out = { header: "", scene: "", tone: "", "rich-rendering": "", "active-characters": "", constants: "", "open-threads": "", "active-pressures": "", "directed-beat": "", "pending-consequence": "", forbidden: "" }
  Object.defineProperty(out, "must-keep", {
    get() { return this.constants },
    set(value) { this.constants = String(value || "") },
    enumerable: false,
    configurable: true,
  })
  // Track `## ` headings that aren't in HEADING_TO_SECTION so callers
  // (storyStore.applyStorykeeperPatch, init's split step) can publish a
  // bus warning when a model invented a new section that's about to get
  // silently merged into the previous bucket.
  Object.defineProperty(out, "__unknownHeadings", {
    value: [], enumerable: false, configurable: true, writable: true,
  })
  if (!text || !String(text).trim()) return out
  const lines = String(text).split(/\r?\n/)
  let current = "header"
  const buckets = { header: [] }
  let inHtmlComment = false
  for (const line of lines) {
    // Strip HTML-comment blocks (the schema header + the FG.md banner)
    // before scanning for headings — otherwise an `##` token that
    // happens to appear inside the comment would get picked up.
    if (inHtmlComment) {
      if (/-->/.test(line)) inHtmlComment = false
      continue
    }
    if (/^\s*<!--/.test(line) && !/-->/.test(line)) {
      inHtmlComment = true
      continue
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue   // single-line comment
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match) {
      const sectionId = HEADING_TO_SECTION[match[1].trim().toLowerCase()]
      if (sectionId) {
        current = sectionId
        if (!buckets[current]) buckets[current] = []
        continue
      }
      // Unknown `## ` heading — record so the caller can warn. The heading
      // text + its following body stay in `current` (legacy behavior, no
      // silent data loss; the model just gets a wrong-bucket result).
      out.__unknownHeadings.push(match[1].trim())
    }
    // Skip "# Foreground Guidance" top-level heading from header capture
    if (/^#\s+Foreground Guidance\s*$/i.test(line)) continue
    if (!buckets[current]) buckets[current] = []
    buckets[current].push(line)
  }
  for (const id of Object.keys(out)) {
    out[id] = (buckets[id] || []).join("\n").trim()
  }
  return out
}

// Banner inserted into the composed FOREGROUND.md (after the title) so
// models and humans both see it's a generated artifact. The runtime
// overwrites this file every storykeeper turn — edits should go to
// FG_template.md (manifest) or story/frontend/*.md (sections).
const FOREGROUND_BANNER = [
  "<!--",
  "AUTO-GENERATED — DO NOT EDIT THIS FILE.",
  "The runtime composes this file from:",
  "  story/guidance/FG_template.md    (manifest of @include directives)",
  "  story/frontend/*.md              (per-section files, edit surgically)",
  "Every storykeeper turn regenerates it. Any edit here will be overwritten.",
  "-->",
].join("\n")

// Insert the do-not-edit banner just after the top-level `# Foreground
// Guidance` heading so naive readers (e.g. `read tool` with limit=2)
// still see the title on line 1 before the banner.
function wrapWithBanner(composed) {
  const src = String(composed || "").replace(/^\s*\n/, "")  // drop leading blank line
  const lines = src.split(/\r?\n/)
  if (lines[0]?.startsWith("# ")) {
    return [lines[0], "", FOREGROUND_BANNER, "", ...lines.slice(1)].join("\n")
  }
  return `${FOREGROUND_BANNER}\n\n${src}`
}

// Schema documentation prepended to FG_template.md. The parser only
// recognizes the `## ` headings listed below (derived from FOREGROUND_SECTIONS,
// so it stays in sync as sections are added); any other `## ` heading silently
// falls into the previous bucket — which means models that invent custom
// sections lose them on the next round-trip. The header makes the schema
// explicit + says where non-schema content can go.
function buildTemplateSchemaHeader() {
  const known = FOREGROUND_SECTIONS
    .filter((s) => s.heading)
    .map((s) => `  ## ${s.heading}`)
    .join("\n")
  return [
    "<!--",
    "SCHEMA — read before editing this file.",
    "",
    "Only the following `##` headings are recognized when the runtime parses",
    "this file back into the per-section store. Use them EXACTLY as written",
    "(case-insensitive, but spell them out):",
    known,
    "",
    "Anything BEFORE the first recognized `##` heading is the implicit `header`",
    "section — a good place for `## Prelude`, story-wide notes, or any prose",
    "that doesn't fit a category.",
    "",
    "Anything between two recognized headings belongs to the section above.",
    "Inventing a new `## Custom Heading` between recognized sections will",
    "cause that content to silently merge into the preceding section on the",
    "next runtime round-trip — do not do this. If you need a new structural",
    "category, propose adding it as a first-class section instead.",
    "",
    "Surgical edits: prefer editing the section file under story/frontend/",
    "directly (e.g. story/frontend/constants.md) — the runtime will",
    "regenerate this template + FOREGROUND.md from sections automatically.",
    "",
    "INCLUDES — pull external content into a section:",
    "  @include path/to/file.md",
    "  (one directive per line, workspace-relative path)",
    "When the runtime composes guidance for the narrator it expands every",
    "such directive inline. The directive itself STAYS in the section file,",
    "so the next round-trip preserves it — handy for keeping a long character",
    "manifest in story/frontend/extras/, or pulling shared snippets from",
    "shared/. Includes can nest up to 8 levels. Missing files leave the",
    "directive in place + a `[include missing: …]` marker; model should fix.",
    "-->",
    "",
  ].join("\n")
}

// Write each section as its own file. If FG_template.md doesn't exist yet,
// also write a default @include manifest pointing at the section files —
// init bootstrap. If the template DOES exist, leave it alone (the model
// may have edited it to add custom sections or reorder includes). Always
// regenerate the read-only FOREGROUND.md by composing from the template.
export async function writeForegroundGuidance({ sections, turnId = "", at = new Date().toISOString() } = {}) {
  if (!sections || typeof sections !== "object") return { written: [] }
  await ensureDir(paths.foregroundDir)
  const written = []
  for (const section of FOREGROUND_SECTIONS) {
    let body = sections[section.id]
    if (typeof body !== "string" && section.id === "constants") body = sections["must-keep"]
    if (typeof body !== "string") continue
    const trimmed = body.trim()
    const filePath = path.join(paths.foregroundDir, section.filename)
    if (!trimmed && !existsSync(filePath)) continue
    const content = formatSectionFile({ section, body: trimmed, turnId, at })
    await writeAtomic(filePath, content)
    written.push(section.filename)
  }
  // Ensure FG_template.md exists with a default manifest. Never overwrite
  // a model-edited template; that would silently drop their reordering or
  // extra @includes.
  await ensureDir(path.dirname(paths.foregroundGuidance))
  if (!existsSync(paths.foregroundTemplate)) {
    await writeAtomic(paths.foregroundTemplate, buildDefaultForegroundTemplate())
  }
  await ensureCardManifests()
  // Compose FG.md (read-only) from template + section files.
  const composed = await composeFromTemplate()
  if (composed.trim()) {
    await writeAtomic(paths.foregroundGuidance, wrapWithBanner(composed))
  }
  return { written, composedChars: composed.length }
}

// Default @include manifest for new stories. Lists the well-known
// section files under story/frontend/ in stable→volatile order. Models
// can edit this freely: reorder includes, add custom files (e.g.
// story/frontend/extras/era-notes.md), or remove sections they don't
// need.
export function buildDefaultForegroundTemplate() {
  const includes = [
    ...FOREGROUND_SECTIONS
      // `optional` sections (e.g. rich-rendering) are added by the model only
      // when relevant; listing them here would point @include at a file that was
      // never written → a "[include missing: …]" marker in every plain story.
      .filter((s) => !s.optional)
      .map((s) => `@include story/frontend/${s.filename}`),
    // Context cards compose in via @include too — the curated set then the
    // per-turn auto set (deduped by the runtime). See CARD_MANIFEST_INCLUDES.
    ...CARD_MANIFEST_INCLUDES,
  ].join("\n")
  return `${buildTemplateSchemaHeader()}# Foreground Guidance\n\n${includes}\n`
}

// Seed the two card manifests as empty files so their @include resolves to
// nothing (rather than a "[include missing: …]" marker) before the first
// curation/trigger write. Also seed the usually-empty pending-consequence and
// directed-beat section stubs for the same reason (both fire rarely, so most
// turns they must compose to nothing, not a missing marker). Idempotent.
export async function ensureCardManifests() {
  await ensureDir(path.dirname(paths.cardsManifest))
  for (const file of [paths.cardsManifest, paths.cardsAuto]) {
    if (!existsSync(file)) await writeAtomic(file, "")
  }
  await ensureDir(paths.foregroundDir)
  // Truly empty (no heading) so an empty stub composes to NOTHING, not a naked
  // "## Pending Consequence" / "## This Turn". formatSectionFile likewise drops
  // the heading when a section body is empty, so clearing them later also vanishes.
  for (const filename of ["pending-consequence.md", "directed-beat.md"]) {
    const stub = path.join(paths.foregroundDir, filename)
    if (!existsSync(stub)) await writeAtomic(stub, "")
  }
}

// Regenerate the composed FOREGROUND.md from the per-section dir without
// modifying section files. applyStorykeeperPatch needs this when Storykeeper
// edits section files directly instead of returning a unified envelope; the
// composed on-disk snapshot should still stay fresh for humans and the UI.
// Regenerate the read-only FOREGROUND.md from the template + section
// files. Used after a model touches any section file directly — the
// template's @include list hasn't changed but the included content has,
// so the composed view is stale.
export async function recomposeForegroundGuidance() {
  if (!existsSync(paths.foregroundTemplate)) {
    // No template yet → bootstrap a default one if there's anything to
    // compose. Otherwise the read-only FG.md stays absent (legit empty
    // state for an init-only story).
    if (!existsSync(paths.foregroundDir)) return { recomposed: false, reason: "no-template-no-dir" }
    await writeAtomic(paths.foregroundTemplate, buildDefaultForegroundTemplate())
  }
  await ensureCardManifests()
  const composed = await composeFromTemplate()
  if (!composed.trim()) return { recomposed: false, reason: "empty-compose" }
  await ensureDir(path.dirname(paths.foregroundGuidance))
  await writeAtomic(paths.foregroundGuidance, wrapWithBanner(composed))
  return { recomposed: true, composedChars: composed.length }
}

// Migrate a legacy single-file FOREGROUND.md into dir form. Idempotent: if
// the dir already has content, this is a no-op. Used on first read of a
// workspace that was created before the dir layout existed.
export async function migrateLegacyForegroundIfNeeded({ turnId = "legacy-migration", at = new Date().toISOString() } = {}) {
  if (!existsSync(paths.foregroundGuidance)) return { migrated: false }
  if (existsSync(paths.foregroundDir)) {
    const files = await readdir(paths.foregroundDir).catch(() => [])
    if (files.length) return { migrated: false }
  }
  const legacy = await readText(paths.foregroundGuidance, "")
  if (!legacy.trim()) return { migrated: false }
  const sections = parseForegroundGuidance(legacy)
  await writeForegroundGuidance({ sections, turnId, at })
  return { migrated: true, sections }
}

// Migrate a workspace from numeric-prefixed section filenames (10-scene.md) to
// the unprefixed scheme (scene.md), and ensure the card-manifest @includes are
// present. Idempotent — a no-op once a story is on the new scheme. Renames the
// per-section files (never clobbering a new-name file that already exists) and
// rewrites the matching @include lines in FG_template.md, then seeds the card
// manifests. Free-form extras/ includes are left untouched.
export async function migrateForegroundFilenames() {
  const renamed = []
  if (existsSync(paths.foregroundDir)) {
    for (const section of FOREGROUND_SECTIONS) {
      for (const legacyFilename of legacyFilenamesFor(section)) {
        const oldPath = path.join(paths.foregroundDir, legacyFilename)
        const newPath = path.join(paths.foregroundDir, section.filename)
        if (existsSync(oldPath) && !existsSync(newPath)) {
          await rename(oldPath, newPath).catch(() => {})
          if (!renamed.includes(section.filename)) renamed.push(section.filename)
        }
      }
    }
    await migrateConstantsSectionFile()
  }
  let templateChanged = false
  if (existsSync(paths.foregroundTemplate)) {
    const before = await readText(paths.foregroundTemplate, "")
    let tpl = before
    for (const section of FOREGROUND_SECTIONS) {
      for (const legacyFilename of legacyFilenamesFor(section)) {
        tpl = tpl.split(`story/foreground/${legacyFilename}`).join(`story/foreground/${section.filename}`)
        tpl = tpl.split(`story/frontend/${legacyFilename}`).join(`story/frontend/${section.filename}`)
      }
    }
    // Resident-layout reorg: the section dir is now story/frontend/. Repoint any
    // legacy @include story/foreground/* lines so existing saves compose correctly.
    tpl = tpl.split("story/foreground/").join("story/frontend/")
    // current-working-set is a REMOVED section: strip any @include line that
    // references it (incl. legacy numeric-prefixed / story/foreground paths) from
    // existing templates. The orphaned section file is left on disk (harmless);
    // any task tracking re-homes to a context card going forward.
    tpl = tpl.split(/^[^\n]*@include [^\n]*current-working-set\.md[^\n]*\n?/m).join("")
    // Ensure the pending-consequence @include is present in existing saves (the
    // section was added after some templates were written). Insert it in the
    // volatile tail, just before the card manifests, else appended.
    const pendingInclude = "@include story/frontend/pending-consequence.md"
    if (!tpl.includes(pendingInclude)) {
      const anchor = tpl.includes(CARD_MANIFEST_INCLUDES[0]) ? CARD_MANIFEST_INCLUDES[0] : ""
      if (anchor) {
        tpl = tpl.replace(anchor, `${pendingInclude}\n${anchor}`)
      } else {
        tpl = `${tpl.replace(/\s+$/, "")}\n${pendingInclude}\n`
      }
    }
    // Ensure the directed-beat @include is present, rendered BEFORE
    // pending-consequence (the world acts this turn, before honoring last turn's
    // choice). Anchor on the pending-consequence include (guaranteed present from
    // the block above), else the card manifest, else append.
    const directedInclude = "@include story/frontend/directed-beat.md"
    if (!tpl.includes(directedInclude)) {
      const anchor = tpl.includes(pendingInclude)
        ? pendingInclude
        : (tpl.includes(CARD_MANIFEST_INCLUDES[0]) ? CARD_MANIFEST_INCLUDES[0] : "")
      if (anchor) {
        tpl = tpl.replace(anchor, `${directedInclude}\n${anchor}`)
      } else {
        tpl = `${tpl.replace(/\s+$/, "")}\n${directedInclude}\n`
      }
    }
    // Ensure both card-manifest @includes are present (append any missing).
    const missing = CARD_MANIFEST_INCLUDES.filter((inc) => !tpl.includes(inc))
    if (missing.length) tpl = `${tpl.replace(/\s+$/, "")}\n${missing.join("\n")}\n`
    if (tpl !== before) {
      await writeAtomic(paths.foregroundTemplate, tpl)
      templateChanged = true
    }
  }
  await ensureCardManifests()
  return { renamed, templateChanged }
}

function legacyFilenamesFor(section) {
  return [...new Set([section.legacyFilename, ...(section.legacyFilenames || [])].filter(Boolean))]
}

async function migrateConstantsSectionFile() {
  const filePath = path.join(paths.foregroundDir, "constants.md")
  if (!existsSync(filePath)) return false
  const before = await readText(filePath, "")
  if (!before) return false
  const after = before
    .replace(/^section:\s*must-keep\s*$/m, "section: constants")
    .replace(/^##\s+Must Keep\s*$/m, "## Constants")
  if (after === before) return false
  await writeAtomic(filePath, after)
  return true
}

function formatSectionFile({ section, body, turnId, at }) {
  const frontmatter = [
    "---",
    `section: ${section.id}`,
    turnId ? `updatedTurn: ${turnId}` : "",
    at ? `updatedAt: ${at}` : "",
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n")
  // Embed the section's `## Heading` at the top of the body so the @include
  // expansion produces well-structured composed output without the
  // composer needing to know about each section's heading. Header section
  // has no heading marker (it's the implicit "before any ## " bucket).
  // An EMPTY body emits frontmatter only (no naked heading) so a cleared
  // section composes to nothing rather than injecting a dangling `## Heading`
  // into the narrator prompt.
  const headed = section.heading && String(body || "").trim() ? `## ${section.heading}\n\n${body}` : body
  return `${frontmatter}\n${headed}\n`
}

function stripFrontmatter(text) {
  if (!text) return ""
  const trimmed = text.replace(/^﻿/, "")
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?/)
  return match ? trimmed.slice(match[0].length) : trimmed
}

// Expose section schema for callers (e.g., applyStorykeeperPatch) that want
// to map an envelope's foregroundGuidanceMarkdown payload into dir writes.
export function sectionSchema() {
  return FOREGROUND_SECTIONS.map((section) => ({ id: section.id, filename: section.filename, heading: section.heading }))
}
