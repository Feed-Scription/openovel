import { readdir } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { ensureDir, readJson, readText, writeJson, writeText } from "../lib/files.js"
import { paths } from "../lib/storyStore.js"
import { displayWorkspacePath, resolveWorkspacePath } from "../lib/workspacePaths.js"
import { isUnsafeIncludePath } from "../lib/includePaths.js"
import { recomposeForegroundGuidance } from "../lib/foregroundCompose.js"

const DEFAULT_CARD_MAX_CHARS = 1200
const DEFAULT_INDEX_MAX_CARDS = 200
const DEFAULT_INDEX_MAX_CHARS = 12000
const DEFAULT_FAST_MAX_CARDS = 2

// Deterministic, model-free card activation for THIS turn. Runs before the
// narrator: it trigger-matches the reader action + current FOREGROUND.md against
// every card's `triggers`, then writes the matched cards (plus always:true
// cards) into story/guidance/cards.auto.md as @include lines. That manifest is
// composed into FOREGROUND.md (recompose below), so the card bodies inline into
// the narrator's guidance — same `@include` path as the section files.
//
// Dedup: cards already curated by the Storykeeper in story/guidance/cards.md are
// excluded, so a card is never @included twice. cards.auto.md is fully rewritten
// each turn (it is runtime-owned; the Storykeeper never edits it).
export async function fastActivateContextCards({
  action = "",
  snapshot = {},
  maxFastCards = DEFAULT_FAST_MAX_CARDS,
} = {}) {
  if (contextInsertsDisabled()) {
    await writeCardManifest(paths.cardsAuto, [])
    return { activated: [], source: "disabled" }
  }
  const [cards, curatedPaths] = await Promise.all([
    discoverContextCards(),
    readManifestCardPaths(paths.cardsManifest),
  ])
  const always = cards.filter((card) => card.always)
  const triggered = exactTriggerSelectContextCards(cards, {
    query: [action, snapshot.foregroundGuidance || ""].join("\n"),
    maxCards: maxFastCards,
    excludePaths: curatedPaths,
  })
  // always ∪ triggered, minus whatever the Storykeeper already curates.
  const autoCards = dedupeCardObjects([...always, ...triggered]).filter(
    (card) => !curatedPaths.has(card.filePath),
  )
  await writeCardManifest(paths.cardsAuto, autoCards)
  await recordContextCardActivations(autoCards)
  // Inline the freshly-activated cards into FOREGROUND.md for the narrator THIS
  // turn (the manifest only matters once composed).
  await recomposeForegroundGuidance().catch(() => {})
  return { activated: autoCards.map(publicCardInfo), source: autoCards.length ? "fast" : "fast-empty" }
}

// Build a card manifest file: one `@include story/context-cards/<slug>/CARD.md`
// per card whose path is @include-safe (story/ or shared/ scope). User (home)
// scope cards can't be @included (the directive validator rejects home/ paths),
// so their body is inlined directly — the composer passes non-@include lines
// through verbatim. Idempotent overwrite.
export async function writeCardManifest(manifestPath, cards = []) {
  const lines = []
  for (const card of cards) {
    const rel = card.displayPath
    if (rel && !isUnsafeIncludePath(rel)) {
      lines.push(`@include ${rel}`)
    } else {
      // home-scope (or otherwise non-includable) card → inline a minimal block.
      const body = truncateAtBoundary(card.body, card.maxChars || DEFAULT_CARD_MAX_CHARS)
      if (card.name) lines.push(`## ${card.name}`, "")
      if (body) lines.push(body, "")
    }
  }
  await ensureDir(path.dirname(manifestPath))
  await writeText(manifestPath, lines.length ? `${lines.join("\n").trimEnd()}\n` : "")
}

// Resolve the set of card filePaths a manifest already @includes, for dedup.
async function readManifestCardPaths(manifestPath) {
  const out = new Set()
  const text = await readText(manifestPath, "")
  if (!text.trim()) return out
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*@include\s+(\S.*?)\s*$/)
    if (!m) continue
    const rel = m[1]
    if (isUnsafeIncludePath(rel)) continue
    try {
      out.add(resolveWorkspacePath(rel).path)
    } catch { /* unresolvable — skip */ }
  }
  return out
}

// Compact index of available cards (slug/kind/description/triggers + activation
// stats). Read-only; surfaced to UIs/debugging. No model selection any more.
export async function discoverContextCardIndex({
  maxCards = numberFromEnv("OPENOVEL_CONTEXT_CARD_INDEX_MAX_CARDS", DEFAULT_INDEX_MAX_CARDS),
  maxChars = numberFromEnv("OPENOVEL_CONTEXT_CARD_INDEX_CHARS", DEFAULT_INDEX_MAX_CHARS),
} = {}) {
  const cards = await discoverContextCards()
  const stats = await readContextCardStats()
  const entries = cards
    .map((card) => {
      const stat = stats.cards?.[cardStatsKey(card)] || null
      return {
        slug: card.name,
        scope: card.scope,
        kind: card.kind,
        path: card.displayPath,
        description: truncateAtBoundary(card.description || "", 280),
        triggers: card.triggers,
        always: card.always,
        activationCount: Number(stat?.count) || 0,
        lastActivatedAt: stat?.lastActivatedAt || "",
      }
    })
    .sort(compareCardIndexEntries)
  return trimCardIndex(entries, { maxCards, maxChars })
}

export async function discoverContextCards() {
  const roots = [
    { scope: "story", dir: paths.contextCards },
    { scope: "user", dir: paths.globalContextCards },
    { scope: "shared", dir: paths.sharedContextCards },
  ]
  const groups = await Promise.all(roots.map(loadCardDir))
  return dedupeCards(groups.flat())
}

function exactTriggerSelectContextCards(cards, {
  query = "",
  maxCards = DEFAULT_FAST_MAX_CARDS,
  excludePaths = new Set(),
} = {}) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return []
  const automaton = buildTriggerAutomaton(cards, { excludePaths })
  if (!automaton.outputs) return []
  const hitsByPath = new Map()
  const queryChars = [...normalizedQuery]
  let node = automaton.root
  for (let index = 0; index < queryChars.length; index += 1) {
    const char = queryChars[index]
    while (node !== automaton.root && !node.next.has(char)) node = node.fail
    node = node.next.get(char) || automaton.root
    for (const output of node.outputs) {
      const start = index - output.length + 1
      if (start < 0) continue
      if (!acceptTriggerBoundary(queryChars, start, index, output)) continue
      const existing = hitsByPath.get(output.card.filePath)
      if (!existing || output.length > existing.triggerLength) {
        hitsByPath.set(output.card.filePath, { card: output.card, triggerLength: output.length })
      }
    }
  }
  return [...hitsByPath.values()]
    .sort((a, b) =>
      b.triggerLength - a.triggerLength ||
      scopeRank(a.card.scope) - scopeRank(b.card.scope) ||
      a.card.name.localeCompare(b.card.name),
    )
    .slice(0, Math.max(0, Number(maxCards) || DEFAULT_FAST_MAX_CARDS))
    .map((item) => item.card)
}

function buildTriggerAutomaton(cards, { excludePaths = new Set() } = {}) {
  const root = createAutomatonNode()
  let outputs = 0
  for (const card of cards) {
    if (excludePaths.has(card.filePath) || card.always) continue
    for (const trigger of card.triggers || []) {
      const normalizedTrigger = normalizeText(trigger)
      const chars = [...normalizedTrigger]
      if (chars.length < 2) continue
      let node = root
      for (const char of chars) {
        if (!node.next.has(char)) node.next.set(char, createAutomatonNode())
        node = node.next.get(char)
      }
      node.outputs.push({
        card,
        trigger: normalizedTrigger,
        length: chars.length,
        requireWordBoundary: requiresWordBoundary(normalizedTrigger),
      })
      outputs += 1
    }
  }
  const queue = []
  for (const child of root.next.values()) {
    child.fail = root
    queue.push(child)
  }
  while (queue.length) {
    const current = queue.shift()
    for (const [char, child] of current.next.entries()) {
      let fail = current.fail
      while (fail !== root && !fail.next.has(char)) fail = fail.fail
      child.fail = fail.next.get(char) || root
      child.outputs = child.outputs.concat(child.fail.outputs)
      queue.push(child)
    }
  }
  return { root, outputs }
}

function createAutomatonNode() {
  return { next: new Map(), fail: null, outputs: [] }
}

function acceptTriggerBoundary(queryChars, start, end, output) {
  if (!output.requireWordBoundary) return true
  const before = start > 0 ? queryChars[start - 1] : ""
  const after = end + 1 < queryChars.length ? queryChars[end + 1] : ""
  return !isWordChar(before) && !isWordChar(after)
}

function requiresWordBoundary(trigger) {
  return /^[\p{Script=Latin}\p{N}_-]+$/u.test(String(trigger || ""))
}

async function loadCardDir({ scope, dir }) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
      const baseDir = path.join(dir, entry.name)
      const filePath = await firstExistingCardFile(baseDir)
      if (!filePath) return null
      const raw = await readText(filePath, "")
      if (!raw.trim()) return null
      return parseCard({ raw, filePath, baseDir, fallbackName: entry.name, scope })
    }),
  )
  return loaded.filter(Boolean)
}

async function firstExistingCardFile(baseDir) {
  for (const name of ["CARD.md", "CONTEXT.md", "README.md"]) {
    const filePath = path.join(baseDir, name)
    const text = await readText(filePath, "")
    if (text.trim()) return filePath
  }
  return ""
}

function parseCard({ raw, filePath, baseDir, fallbackName, scope }) {
  const { frontmatter, body } = splitFrontmatter(raw)
  const name = stringField(frontmatter.name) || fallbackName
  const target = stringField(frontmatter.target || frontmatter.context || "foreground").toLowerCase()
  if (target && target !== "foreground" && target !== "inline") return null
  return {
    name,
    scope,
    kind: stringField(frontmatter.kind || frontmatter.type) || "note",
    filePath,
    baseDir,
    displayPath: displayWorkspacePath(filePath),
    displayBaseDir: displayWorkspacePath(baseDir),
    description: stringField(frontmatter.description) || firstParagraph(body),
    whenToUse: stringField(frontmatter.when_to_use || frontmatter.whenToUse || frontmatter.when),
    triggers: listField(frontmatter.triggers || frontmatter.keywords || frontmatter.tags),
    always: boolField(frontmatter.always || frontmatter.pinned),
    maxChars: numberField(frontmatter.max_chars || frontmatter.maxChars, DEFAULT_CARD_MAX_CHARS),
    body: body.trim(),
  }
}

// Character-name highlight list for the reading view: from the discovered
// cards, the surface forms (name + triggers) of CHARACTER-kind cards, cleaned
// and sorted longest-first so an alias contained in a longer alias never
// shadows it ("陈" vs "陈振华"). The renderer wraps these in a tinted span.
// Kind matching is permissive over the contract's free-form vocabulary
// (character / person / npc / protagonist / 人物 / 角色). Pure.
const CHARACTER_KIND_RE = /char|person|npc|protag|人物|角色/i
const HIGHLIGHT_NAME_MAX = 80

export function extractCharacterHighlightNames(cards = []) {
  const out = new Set()
  for (const card of cards) {
    if (!card || !CHARACTER_KIND_RE.test(String(card.kind || ""))) continue
    for (const raw of [card.name, ...(card.triggers || [])]) {
      const value = String(raw || "").trim()
      // 2..24 chars: single CJK chars over-match pronoun-like text; very long
      // strings are descriptions, not names. Multi-line/comma'd entries are
      // malformed triggers, not surface forms.
      if (value.length < 2 || value.length > 24) continue
      if (/[\n\r,，;；]/.test(value)) continue
      out.add(value)
    }
  }
  return [...out].sort((a, b) => b.length - a.length).slice(0, HIGHLIGHT_NAME_MAX)
}

// Validate a CARD.md body against the authoring contract → human-readable
// warnings (empty = conforms). The write/edit tools call this after a write so
// the model is told "saved, but this card won't auto-activate because …".
export function validateContextCardContent(raw) {
  const { frontmatter, body } = splitFrontmatter(raw)
  const warnings = []
  const target = stringField(frontmatter.target || frontmatter.context || "foreground").toLowerCase()
  if (target && target !== "foreground" && target !== "inline") {
    warnings.push(`target: "${target}" is not a foreground card — the narrator will never load it. Use target: foreground or omit the field.`)
  }
  if (!stringField(frontmatter.name)) {
    warnings.push("missing `name` — the card falls back to the directory slug as its display name; set an explicit name.")
  }
  if (!stringField(frontmatter.description) && !firstParagraph(body)) {
    warnings.push("missing `description` — without it nothing summarizes this card; add a one-line description.")
  }
  const triggers = listField(frontmatter.triggers || frontmatter.keywords || frontmatter.tags)
  if (!triggers.length) {
    warnings.push("missing `triggers` — fast activation matches triggers against the reader action + FOREGROUND.md, so with none this card never auto-loads when its entity appears. Add the exact names/aliases/titles the prose uses (CJK: the precise characters).")
  }
  if (!body.trim()) {
    warnings.push("empty body — an active card with no body renders nothing into the narrator prompt.")
  }
  return warnings
}

// Detect a NEW card (being written at `slug`) that duplicates an EXISTING
// story-scoped card under a DIFFERENT slug — i.e. the same entity given two
// cards. That fragments the entity: both auto-activate on the shared triggers
// (double-injection) and their bodies drift apart. Compares by exact name match
// OR overlapping triggers (the load-bearing signal, since two cards for one
// character usually share names/aliases even when the `name` field differs
// slightly, e.g. "陈振华" vs "陈振华（老陈）"). Returns [{ slug, name,
// sharedTriggers, nameMatch }]; empty = no conflict. Editing the same slug is
// never a conflict. Only story scope — the user/shared card libraries are
// intentionally separate and may legitimately mirror a story entity.
export async function findConflictingCards({ slug, content } = {}) {
  const wantSlug = String(slug || "")
  const { frontmatter } = splitFrontmatter(content || "")
  const newName = normalizeText(stringField(frontmatter.name) || "")
  const newTriggers = new Set(
    listField(frontmatter.triggers || frontmatter.keywords || frontmatter.tags)
      .map((trigger) => normalizeText(trigger))
      .filter((trigger) => [...trigger].length >= 2),
  )
  if (!newName && !newTriggers.size) return []
  const existing = (await discoverContextCards()).filter((card) => card.scope === "story")
  const conflicts = []
  for (const card of existing) {
    const cardSlug = String(card.filePath || "").split(/[\\/]/).slice(-2)[0] || ""
    if (!cardSlug || cardSlug === wantSlug) continue
    const nameMatch = Boolean(newName) && normalizeText(card.name || "") === newName
    const sharedTriggers = [...new Set(
      (card.triggers || []).map((trigger) => normalizeText(trigger)).filter((trigger) => newTriggers.has(trigger)),
    )]
    if (nameMatch || sharedTriggers.length) {
      conflicts.push({ slug: cardSlug, name: card.name, sharedTriggers, nameMatch })
    }
  }
  return conflicts
}

// ── card parsing helpers ────────────────────────────────────────────────────

function splitFrontmatter(raw) {
  const text = String(raw || "")
  if (!text.startsWith("---")) return { frontmatter: {}, body: text }
  const lines = text.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end < 0) return { frontmatter: {}, body: text }
  return {
    frontmatter: parseYamlFrontmatter(lines.slice(1, end).join("\n")),
    body: lines.slice(end + 1).join("\n"),
  }
}

function parseYamlFrontmatter(text) {
  try {
    const parsed = YAML.parse(String(text || "")) || {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function listField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stringField(item)).filter(Boolean)
  }
  const text = stringField(value)
  if (!text) return []
  const inline = text.match(/^\[(.*)\]$/)?.[1] ?? text
  return inline
    .split(/[,，]/)
    .map((item) => stripQuotes(item).trim())
    .filter(Boolean)
}

function stringField(value) {
  if (typeof value === "string") return stripQuotes(value).trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function boolField(value) {
  if (typeof value === "boolean") return value
  return ["1", "true", "yes", "on"].includes(stringField(value).toLowerCase())
}

function numberField(value, fallback) {
  const number = Number(stringField(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function stripQuotes(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "")
}

function firstParagraph(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((item) => item.replace(/^#+\s+/, "").trim())
    .find(Boolean) || ""
}

function isWordChar(char) {
  return Boolean(char && /[\p{L}\p{N}_]/u.test(char))
}

function normalizeText(value) {
  return String(value || "").toLowerCase()
}

function truncateAtBoundary(text, maxChars) {
  const value = String(text || "").trim()
  if (value.length <= maxChars) return value
  const sliced = value.slice(0, Math.max(0, maxChars - 12))
  const boundary = Math.max(sliced.lastIndexOf("\n\n"), sliced.lastIndexOf("\n"), sliced.lastIndexOf("。"))
  return `${sliced.slice(0, boundary > 200 ? boundary : sliced.length).trimEnd()}\n...`
}

function dedupeCards(cards) {
  const seen = new Set()
  const out = []
  for (const card of cards) {
    const key = card.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(card)
  }
  return out
}

function dedupeCardObjects(cards) {
  const out = []
  const seen = new Set()
  for (const card of cards) {
    if (!card?.filePath || seen.has(card.filePath)) continue
    seen.add(card.filePath)
    out.push(card)
  }
  return out
}

// ── activation stats ─────────────────────────────────────────────────────────

async function readContextCardStats() {
  const stats = await readJson(paths.contextCardStats, { version: 1, cards: {} }).catch(() => ({ version: 1, cards: {} }))
  return stats && typeof stats === "object" && stats.cards && typeof stats.cards === "object"
    ? stats
    : { version: 1, cards: {} }
}

async function recordContextCardActivations(cards = []) {
  if (!cards.length) return { activated: [] }
  const stats = await readContextCardStats()
  const now = new Date().toISOString()
  const next = { ...stats, version: 1, updatedAt: now, cards: { ...(stats.cards || {}) } }
  for (const card of cards) {
    const key = cardStatsKey(card)
    const current = next.cards[key] || {}
    next.cards[key] = {
      path: card.displayPath,
      name: card.name,
      scope: card.scope,
      kind: card.kind,
      count: (Number(current.count) || 0) + 1,
      firstActivatedAt: current.firstActivatedAt || now,
      lastActivatedAt: now,
    }
  }
  await ensureDir(path.dirname(paths.contextCardStats))
  await writeJson(paths.contextCardStats, next)
  return { activated: cards.map(cardStatsKey) }
}

function cardStatsKey(card) {
  return String(card?.displayPath || card?.filePath || `${card?.scope || "unknown"}:${card?.name || ""}`).toLowerCase()
}

function compareCardIndexEntries(a, b) {
  const activation = (Number(b.activationCount) || 0) - (Number(a.activationCount) || 0)
  if (activation) return activation
  const last = String(b.lastActivatedAt || "").localeCompare(String(a.lastActivatedAt || ""))
  if (last) return last
  const scope = scopeRank(a.scope) - scopeRank(b.scope)
  if (scope) return scope
  return String(a.slug || "").localeCompare(String(b.slug || ""))
}

function trimCardIndex(entries, { maxCards, maxChars }) {
  const cardLimit = Math.max(0, Number(maxCards) || DEFAULT_INDEX_MAX_CARDS)
  const charLimit = Math.max(0, Number(maxChars) || DEFAULT_INDEX_MAX_CHARS)
  const out = []
  let used = 2 // []
  for (const entry of entries) {
    if (out.length >= cardLimit) break
    const size = JSON.stringify(entry).length + (out.length ? 1 : 0)
    if (charLimit && used + size > charLimit) break
    out.push(entry)
    used += size
  }
  return out
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function scopeRank(scope) {
  return { story: 0, user: 1, shared: 2 }[scope] ?? 9
}

function publicCardInfo(card) {
  return {
    name: card.name,
    kind: card.kind,
    scope: card.scope,
    path: card.displayPath,
    description: card.description,
  }
}

export function contextInsertsDisabled(env = process.env) {
  return (
    ["1", "true", "yes", "on"].includes(String(env.OPENOVEL_ABLATION_DISABLE_CONTEXT_INSERTS || "").toLowerCase()) ||
    ["1", "true", "yes", "on"].includes(String(env.OPENOVEL_DISABLE_CONTEXT_INSERTS || "").toLowerCase())
  )
}
