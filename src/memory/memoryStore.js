import path from "node:path"
import { readdir, unlink } from "node:fs/promises"
import { ensureDir, readText, writeAtomic } from "../lib/files.js"
import { initializeStory, paths } from "../lib/storyStore.js"
import { memoryProviderRegistry, registerMemoryProvider } from "./registry.js"

const ENTRY_PREFIX = "- "
const GENERATED_TOPIC_MARKER = "<!-- openovel-memory-topic:v1 -->"
const DEFAULT_MAX_ENTRY_CHARS = 700
const DEFAULT_MAX_STORY_ENTRIES = 32
const DEFAULT_MAX_USER_ENTRIES = 80
const DEFAULT_MAX_OBSERVED_ENTRIES = 80
const DEFAULT_MAX_REFERENCE_ENTRIES = 80
const CROSS_STORY_MEMORY_ENV = "OPENOVEL_CROSS_STORY_MEMORY"

registerMemoryProvider({
  id: "file-markdown",
  name: "File-native Markdown memory",
  kind: "file-native",
  storage: "markdown",
  scopes: ["story", "user", "observed", "references"],
  capabilities: {
    read: true,
    write: true,
    topics: true,
    grepFriendly: true,
    userEditable: true,
  },
  snapshot: (options) => fileGetMemorySnapshot(options),
  applyPatch: (patch) => fileApplyMemoryPatch(patch),
  add: ({ target, content }) => fileAddMemoryEntry(target, content),
  replace: ({ target, oldText, content }) => fileReplaceMemoryEntry(target, oldText, content),
  remove: ({ target, oldText }) => fileRemoveMemoryEntry(target, oldText),
  clear: ({ target }) => fileClearMemoryTarget(target),
})

export { memoryProviderRegistry, registerMemoryProvider } from "./registry.js"

export async function getMemorySnapshot(options = {}) {
  return activeMemoryProvider(options).snapshot(options)
}

export async function applyMemoryPatch(patch = {}, options = {}) {
  const provider = activeMemoryProvider(options)
  const gatedPatch = gateCrossStoryPatch(patch, options)
  if (typeof provider.applyPatch === "function") return provider.applyPatch(gatedPatch)
  return defaultApplyMemoryPatch(provider, gatedPatch)
}

export async function addMemoryEntry(target, content, options = {}) {
  if (isCrossStoryMemoryTarget(target) && !isCrossStoryMemoryEnabled(options.env) && options.allowCrossStoryWrites !== true) {
    return { ok: true, target, changed: false, reason: "cross_story_memory_disabled" }
  }
  return activeMemoryProvider(options).add({ target, content })
}

export async function replaceMemoryEntry(target, oldText, content, options = {}) {
  return activeMemoryProvider(options).replace({ target, oldText, content })
}

export async function removeMemoryEntry(target, oldText, options = {}) {
  return activeMemoryProvider(options).remove({ target, oldText })
}

export async function clearMemoryTarget(target, options = {}) {
  const provider = activeMemoryProvider(options)
  if (typeof provider.clear === "function") return provider.clear({ target })
  return defaultClearMemoryTarget(provider, { target })
}

async function defaultClearMemoryTarget(provider, { target }) {
  const snap = await provider.snapshot()
  const sourceKey = target === "story"
    ? "memory"
    : target === "references"
      ? "references"
      : target === "observed"
        ? "observed"
        : target
  const text = snap[sourceKey] || ""
  let removed = 0
  for (const entry of parseIndexEntries(text)) {
    const res = await provider.remove({ target, oldText: entry.content })
    if (res?.changed) removed++
  }
  return { ok: true, target, removed }
}

function activeMemoryProvider(options = {}) {
  return memoryProviderRegistry.resolve({ id: options.provider, env: options.env })
}

async function defaultApplyMemoryPatch(provider, { memory = [], story = [], user = [], observed = [], references = [] } = {}) {
  const results = []
  for (const entry of [...memory, ...story]) {
    results.push(await provider.add({ target: "memory", content: entry }))
  }
  // `user` writes still routed to USER.md for backward compat (e.g. the
  // onboarding workflow). New model-driven writes use `observed`.
  for (const entry of user) {
    results.push(await provider.add({ target: "user", content: entry }))
  }
  for (const entry of observed) {
    results.push(await provider.add({ target: "observed", content: entry }))
  }
  for (const entry of references) {
    results.push(await provider.add({ target: "references", content: entry }))
  }
  return {
    results,
    snapshot: await provider.snapshot(),
  }
}

export function isCrossStoryMemoryEnabled(env = process.env) {
  const raw = env?.[CROSS_STORY_MEMORY_ENV]
  if (raw === undefined || raw === null || String(raw).trim() === "") return true
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase())
}

function isCrossStoryMemoryTarget(target) {
  return ["observed", "reference", "references"].includes(String(target || "").trim().toLowerCase())
}

function gateCrossStoryPatch(patch = {}, options = {}) {
  if (options.allowCrossStoryWrites === true || isCrossStoryMemoryEnabled(options.env)) return patch
  return {
    ...patch,
    observed: [],
    references: [],
  }
}

async function fileGetMemorySnapshot(options = {}) {
  await initializeStory()
  const crossStoryEnabled = isCrossStoryMemoryEnabled(options.env)
  const includeCrossStory = crossStoryEnabled || options.includeDisabledCrossStory === true
  const story = await readText(paths.memoryIndex, "# Story Memory\n\n")
  const globalUser = await readText(paths.userMemory, "# User Memory\n\n")
  // Per-story override: global USER.md is the DEFAULT; if this story has its
  // own PREFERENCES.md (set at creation time), it REPLACES the global prefs for
  // this story. Every consumer reads snapshot.user, so the override propagates
  // to the narrator, options, story init, and the Storykeeper uniformly.
  const storyPrefs = await readText(paths.storyPreferences, "")
  const user = storyPrefs.trim() ? storyPrefs : globalUser
  const observed = includeCrossStory ? await readText(paths.userObservedMemory, "# Observed Memory\n\n") : "# Observed Memory\n\n"
  const references = includeCrossStory ? await readText(paths.sharedReferenceIndex, "# Shared References\n\n") : "# Shared References\n\n"
  return {
    memory: story,
    story,
    user,
    observed,
    references,
    crossStoryMemoryEnabled: crossStoryEnabled,
    paths: {
      storyMemory: paths.memoryIndex,
      storyMemoryTopics: paths.memoryTopics,
      userMemory: paths.userMemory,
      storyPreferences: paths.storyPreferences,
      userMemoryTopics: paths.globalMemoryTopics,
      userObservedMemory: paths.userObservedMemory,
      sharedReferences: paths.sharedReferenceIndex,
      sharedReferenceTopics: paths.sharedReferenceTopics,
    },
  }
}

async function fileApplyMemoryPatch({ memory = [], story = [], user = [], observed = [], references = [] } = {}) {
  await initializeStory()
  const results = []
  for (const entry of [...memory, ...story]) {
    results.push(await fileAddMemoryEntry("memory", entry))
  }
  for (const entry of user) {
    results.push(await fileAddMemoryEntry("user", entry))
  }
  for (const entry of observed) {
    results.push(await fileAddMemoryEntry("observed", entry))
  }
  for (const entry of references) {
    results.push(await fileAddMemoryEntry("references", entry))
  }
  return {
    results,
    snapshot: await fileGetMemorySnapshot(),
  }
}

async function fileClearMemoryTarget(target) {
  await initializeStory()
  const config = memoryTargetConfig(target)
  await writeAtomic(config.indexFile, defaultContentForTarget(target))
  const names = await readdir(config.topicsDir).catch(() => [])
  let removed = 0
  for (const name of names) {
    if (!name.endsWith(".md")) continue
    await unlink(path.join(config.topicsDir, name)).catch(() => {})
    removed++
  }
  return { ok: true, target, cleared: true, removedTopicFiles: removed }
}

async function fileAddMemoryEntry(target, content) {
  const normalized = normalizeEntry(content)
  if (!normalized) return { ok: false, target, reason: "empty" }

  const file = memoryFileForTarget(target)
  const current = await readText(file, defaultContentForTarget(target))
  const entries = parseIndexEntries(current)
  if (entries.some((entry) => entry.content === normalized)) {
    return { ok: true, target, changed: false, reason: "duplicate" }
  }
  const nextEntry = memoryIndexEntry(normalized)
  entries.push(nextEntry)
  await writeEntries(file, target, entries)
  return { ok: true, target, changed: true, file: displayMemoryFile(target), topicFile: displayTopicFile(target, nextEntry.slug) }
}

async function fileReplaceMemoryEntry(target, oldText, content) {
  const file = memoryFileForTarget(target)
  const current = await readText(file, defaultContentForTarget(target))
  const entries = parseIndexEntries(current)
  const index = entries.findIndex((entry) => entry.content.includes(oldText) || entry.line.includes(oldText))
  if (index < 0) return { ok: false, target, reason: "not_found" }
  const normalized = normalizeEntry(content)
  if (!normalized) return { ok: false, target, reason: "empty" }
  entries[index] = {
    ...entries[index],
    title: titleFromEntry(normalized),
    content: normalized,
    slug: entries[index].slug || slugFromEntry(normalized),
  }
  await writeEntries(file, target, entries)
  return { ok: true, target, changed: true }
}

async function fileRemoveMemoryEntry(target, oldText) {
  const file = memoryFileForTarget(target)
  const current = await readText(file, defaultContentForTarget(target))
  const entries = parseIndexEntries(current)
  const removed = entries.filter((entry) => entry.content.includes(oldText) || entry.line.includes(oldText))
  const next = entries.filter((entry) => !removed.includes(entry))
  if (next.length === entries.length) return { ok: false, target, reason: "not_found" }
  await writeEntries(file, target, next)
  await removeGeneratedTopicFiles(target, removed, next)
  return { ok: true, target, changed: true }
}

function memoryFileForTarget(target) {
  return memoryTargetConfig(target).indexFile
}

function memoryTargetConfig(target) {
  if (target === "story" || target === "memory") {
    return {
      id: "story",
      title: "# Story Memory",
      indexFile: paths.memoryIndex,
      topicsDir: paths.memoryTopics,
      maxEntries: positiveNumber(process.env.OPENOVEL_MEMORY_STORY_MAX_ENTRIES, DEFAULT_MAX_STORY_ENTRIES),
    }
  }
  if (target === "user") {
    return {
      id: "user",
      title: "# User Memory",
      indexFile: paths.userMemory,
      topicsDir: paths.globalMemoryTopics,
      maxEntries: positiveNumber(process.env.OPENOVEL_MEMORY_USER_MAX_ENTRIES, DEFAULT_MAX_USER_ENTRIES),
    }
  }
  if (target === "observed") {
    return {
      id: "observed",
      title: "# Observed Memory",
      indexFile: paths.userObservedMemory,
      topicsDir: paths.globalMemoryTopics,
      maxEntries: positiveNumber(process.env.OPENOVEL_MEMORY_OBSERVED_MAX_ENTRIES, DEFAULT_MAX_OBSERVED_ENTRIES),
    }
  }
  if (target === "reference" || target === "references") {
    return {
      id: "references",
      title: "# Shared References",
      indexFile: paths.sharedReferenceIndex,
      topicsDir: paths.sharedReferenceTopics,
      maxEntries: positiveNumber(process.env.OPENOVEL_MEMORY_REFERENCES_MAX_ENTRIES, DEFAULT_MAX_REFERENCE_ENTRIES),
    }
  }
  throw new Error(`Unknown memory target: ${target}`)
}

function defaultContentForTarget(target) {
  return `${memoryTargetConfig(target).title}\n\n${indexHelpText(target)}\n`
}

function parseIndexEntries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(ENTRY_PREFIX))
    .map((line) => parseIndexLine(line))
    .filter(Boolean)
}

function parseIndexLine(line) {
  const body = line.slice(ENTRY_PREFIX.length).trim()
  const link = body.match(/^\[([^\]]+)\]\(([^)]+)\)(?:\s+[—-]\s+(.+))?$/)
  if (!link) {
    const content = body.trim()
    return content ? memoryIndexEntry(content) : null
  }
  const title = link[1].trim()
  const rel = link[2].trim()
  const content = (link[3] || title).trim()
  return {
    title,
    content,
    slug: slugFromTopicPath(rel) || slugFromEntry(content || title),
    line,
  }
}

function normalizeEntry(content) {
  if (typeof content !== "string") return ""
  return content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DEFAULT_MAX_ENTRY_CHARS)
}

async function writeEntries(file, target, entries) {
  const config = memoryTargetConfig(target)
  await ensureDir(config.topicsDir)
  const boundedEntries = assignUniqueSlugs(trimEntriesForTarget(target, entries))
  await Promise.all(boundedEntries.map((entry) => ensureTopicFile(config, entry)))
  // Blank line between bullets — readable when each line is short.
  const body = boundedEntries.length ? boundedEntries.map((entry) => renderIndexLine(entry)).join("\n\n") : ""
  await writeAtomic(file, `${config.title}\n\n${indexHelpText(target)}\n${body}${body ? "\n" : ""}`)
  return boundedEntries
}

function trimEntriesForTarget(target, entries) {
  const maxEntries = memoryTargetConfig(target).maxEntries
  if (!maxEntries || entries.length <= maxEntries) return entries
  return entries.slice(-maxEntries)
}

function memoryIndexEntry(content) {
  const normalized = normalizeEntry(content)
  return {
    title: titleFromEntry(normalized),
    content: normalized,
    slug: slugFromEntry(normalized),
    line: `${ENTRY_PREFIX}${normalized}`,
  }
}

function renderIndexLine(entry) {
  // Plain bullet — `- <content>`. Previously the format was
  //   `- [Title](topics/<slug>.md) — Content`
  // but Title was just the first 80 chars of Content, so the line read
  // as the content duplicated (title-prefix THEN full content again).
  // Topic files under topics/<slug>.md still get created in case anyone
  // wants the deep-dive form, but the index entry is the canonical body.
  // parseIndexLine continues to accept both shapes so legacy USER.md
  // files keep working.
  return `${ENTRY_PREFIX}${entry.content}`
}

async function ensureTopicFile(config, entry) {
  const file = path.join(config.topicsDir, `${entry.slug}.md`)
  const current = await readText(file, "")
  if (current.includes(entry.content)) return
  const content = renderTopicFile(config, entry, current)
  await writeAtomic(file, content)
}

function renderTopicFile(config, entry, current = "") {
  const now = new Date().toISOString()
  const generated = [
    "---",
    `target: ${config.id}`,
    `slug: ${entry.slug}`,
    `updated: ${now}`,
    "---",
    GENERATED_TOPIC_MARKER,
    "",
    `# ${entry.title}`,
    "",
    "## Entries",
    "",
    `${ENTRY_PREFIX}${entry.content}`,
    "",
  ].join("\n")
  if (!current.trim() || current.includes(GENERATED_TOPIC_MARKER)) return generated
  return `${current.trimEnd()}\n\n## Openovel Memory Entry ${now}\n\n${ENTRY_PREFIX}${entry.content}\n`
}

async function removeGeneratedTopicFiles(target, removed, remaining) {
  const config = memoryTargetConfig(target)
  const remainingSlugs = new Set(remaining.map((entry) => entry.slug).filter(Boolean))
  await Promise.all(
    removed
      .filter((entry) => entry.slug && !remainingSlugs.has(entry.slug))
      .map(async (entry) => {
        const file = path.join(config.topicsDir, `${entry.slug}.md`)
        const current = await readText(file, "")
        if (!current.includes(GENERATED_TOPIC_MARKER)) return
        await unlink(file).catch(() => {})
      }),
  )
}

function assignUniqueSlugs(entries) {
  const used = new Set()
  return entries.map((entry) => {
    const base = entry.slug || slugFromEntry(entry.content)
    let slug = base
    let index = 2
    while (used.has(slug)) slug = `${base}-${index++}`
    used.add(slug)
    return { ...entry, slug }
  })
}

function slugFromTopicPath(value) {
  const base = path.basename(String(value || "").trim(), ".md")
  return safeSlug(base)
}

function slugFromEntry(entry) {
  return safeSlug(
    String(entry || "")
      .toLowerCase()
      .replace(/[`*_~[\]()]/g, "")
      .split(/\s+/)
      .slice(0, 8)
      .join("-"),
  )
}

function safeSlug(value) {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return ascii || `memory-${hashText(value)}`
}

function titleFromEntry(entry) {
  return String(entry || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

function escapeMarkdownLinkText(value) {
  return String(value || "").replace(/[[\]]/g, "")
}

function displayMemoryFile(target) {
  const config = memoryTargetConfig(target)
  if (config.id === "story") return "story/memory/MEMORY.md"
  if (config.id === "user") return "home/memory/USER.md"
  if (config.id === "observed") return "home/memory/OBSERVED.md"
  return "home/references/INDEX.md"
}

function displayTopicFile(target, slug) {
  const config = memoryTargetConfig(target)
  if (config.id === "story") return `story/memory/topics/${slug}.md`
  if (config.id === "user" || config.id === "observed") return `home/memory/topics/${slug}.md`
  return `home/references/topics/${slug}.md`
}

function indexHelpText(target) {
  const config = memoryTargetConfig(target)
  const scope =
    config.id === "user"
      ? "Global user and collaboration preferences shared across stories. User-editable; the model reads but does not write here — model observations live in OBSERVED.md."
      : config.id === "observed"
        ? "Model-observed notes about the reader and how they interact, shared across stories. Written by the background memory-review loop; never edit USER.md from here."
        : config.id === "references"
          ? "Reusable shared research and source pointers."
          : "Story-specific durable lessons, conventions, and continuity notes."
  return [
    "<!-- openovel-memory-index:v1 -->",
    "",
    `${scope} This file is a compact index, not the full memory body. Put detailed notes in topics/*.md and keep each index line short enough for foreground context.`,
    "",
  ].join("\n")
}

function hashText(value) {
  let hash = 2166136261
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
