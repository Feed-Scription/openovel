import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { workspaceLayout } from "./workspacePaths.js"
import { isComicModeEnabled, isFastModeEnabled } from "./formatContract.js"

// Stories live at ~/.openovel/stories/<id>/ (when OPENOVEL_STORY_ID is set)
// or at ./story (the project-local default when no STORY_ID is set).
// Display name lives in <root>/meta.json — the directory id is a random
// short token so the user can name a story anything (including chars the
// filesystem doesn't accept) without affecting the path layer.

export const PROJECT_LOCAL_ID = "(project)"

const DISPLAY_NAME_MAX = 120
const META_FILENAME = "meta.json"

// Strip ASCII control bytes (\x00 through \x1f + \x7f) from a string.
// Built as a regex object so the source file doesn't have to embed raw
// control characters that some editors / diff tools choke on.
const CONTROL_CHARS_RE = new RegExp(
  "[" + "\\u0000-\\u001f" + "\\u007f" + "]+",
  "g",
)

// Display name normalization: only strip control codes (incl. newlines)
// + trim + cap length. Everything else stays verbatim — CJK, ASCII
// punctuation incl. ':', emoji are all preserved.
export function normalizeStoryDisplayName(name) {
  return String(name || "")
    .normalize("NFC")
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX)
}

// Random short id used as the on-disk directory name. 32 bits of entropy
// = ~4G combos; createStory still re-rolls on the rare collision.
export function makeStoryId() {
  return `s_${randomBytes(4).toString("hex")}`
}

// Back-compat helper: older stories were named directly with a slug of
// the user's text. New code paths use makeStoryId() instead. This stays
// exported because legacy callers and tests still reference it.
export function slugifyStoryName(name) {
  return String(name || "")
    .normalize("NFC")
    .replace(CONTROL_CHARS_RE, "")
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80)
}

async function readStoryMeta(root) {
  try {
    const text = await readFile(path.join(root, META_FILENAME), "utf8")
    const meta = JSON.parse(text)
    return meta && typeof meta === "object" ? meta : null
  } catch { return null }
}

async function writeStoryMeta(root, meta) {
  await writeFile(path.join(root, META_FILENAME), JSON.stringify(meta, null, 2), "utf8")
}

export function currentStoryDescriptor({ cwd = process.cwd(), env = process.env } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const id = layout.storyId || PROJECT_LOCAL_ID
  return {
    id,
    root: layout.storyRoot,
    isProjectLocal: !layout.storyId,
  }
}

// Same as currentStoryDescriptor but also reads the display name from
// meta.json. Async because of the read. Use this anywhere the renderer
// needs the human-readable label (header strap, status text).
export async function describeCurrentStoryWithName({ cwd = process.cwd(), env = process.env } = {}) {
  const desc = currentStoryDescriptor({ cwd, env })
  if (desc.isProjectLocal) return { ...desc, displayName: "" }
  const meta = await readStoryMeta(desc.root)
  return { ...desc, displayName: meta?.displayName || desc.id }
}

export async function listStories({ cwd = process.cwd(), env = process.env } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const out = []

  out.push(await describeStory({
    id: PROJECT_LOCAL_ID,
    root: path.join(cwd, "story"),
    isProjectLocal: true,
  }))

  const entries = await readdir(layout.storiesRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    out.push(await describeStory({
      id: entry.name,
      root: path.join(layout.storiesRoot, entry.name),
      isProjectLocal: false,
    }))
  }

  const current = currentStoryDescriptor({ cwd, env }).id
  for (const desc of out) desc.active = desc.id === current
  out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (a.isProjectLocal !== b.isProjectLocal) return a.isProjectLocal ? -1 : 1
    return (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0)
  })
  return out
}

async function describeStory({ id, root, isProjectLocal }) {
  const exists = existsSync(root)
  const chapters = path.join(root, "canon", "chapters.md")
  const sceneLog = path.join(root, "canon", "scene_log.jsonl")
  let lastTouchedAt = 0
  let chapterBytes = 0
  if (exists) {
    for (const candidate of [chapters, sceneLog, root]) {
      const s = await stat(candidate).catch(() => null)
      if (s?.mtimeMs > lastTouchedAt) lastTouchedAt = s.mtimeMs
      if (candidate === chapters && s) chapterBytes = s.size
    }
  }
  // Display name from meta.json when present. Fallback to the dir id so
  // legacy stories (created before the random-id refactor) still render
  // their old human-readable slug in the library.
  let displayName = id
  let mode = ""
  if (exists && !isProjectLocal) {
    const meta = await readStoryMeta(root)
    if (meta?.displayName) displayName = String(meta.displayName)
    if (isKnownStoryMode(meta?.mode)) mode = meta.mode
  }
  // A story "has a replayable init" when a recorded init transcript exists
  // under <root>/agents/ (story/agents/init-*.json, written at init time).
  let hasInitReplay = false
  if (exists) {
    const agentEntries = await readdir(path.join(root, "agents")).catch(() => [])
    hasInitReplay = agentEntries.some((name) => /^init-.*\.json$/i.test(name))
  }
  // Library cover art: a model- or user-prepared image at the canonical
  // story/includes/cover.<ext> (the Image agent's cover remit writes it
  // there). The library card crops it to its 2:3 portrait frame. coverVersion
  // (mtime) lets the renderer cache-bust when the file is regenerated.
  let coverFile = ""
  let coverVersion = 0
  if (exists) {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
      const candidate = path.join(root, "includes", `cover.${ext}`)
      const s = await stat(candidate).catch(() => null)
      if (s && s.mtimeMs > coverVersion) { coverFile = candidate; coverVersion = s.mtimeMs }
    }
  }
  return {
    id,
    displayName,
    mode,
    root,
    isProjectLocal,
    exists,
    hasCanon: chapterBytes > 0,
    chapterBytes,
    hasInitReplay,
    coverFile,
    coverVersion,
    lastTouchedAt,
    lastTouched: lastTouchedAt ? new Date(lastTouchedAt).toISOString() : "",
  }
}

// Create a new story slot. The directory name is a random id; the
// user-chosen display name is stored in meta.json. `id` in the return
// value is the random id, not the name — callers route by id.
export async function createStory({ name, cwd = process.cwd(), env = process.env } = {}) {
  const displayName = normalizeStoryDisplayName(name)
  if (!displayName) throw new Error(`Story name cannot be empty`)
  const layout = workspaceLayout({ cwd, env })
  // Re-roll on the rare existsSync hit. 32 bits of entropy means this
  // basically never collides, but the loop is cheap.
  let id = makeStoryId()
  for (let i = 0; i < 8; i++) {
    if (!existsSync(path.join(layout.storiesRoot, id))) break
    id = makeStoryId()
  }
  const root = path.join(layout.storiesRoot, id)
  const created = !existsSync(root)
  await mkdir(root, { recursive: true })
  await writeStoryMeta(root, {
    displayName,
    createdAt: new Date().toISOString(),
  })
  return { id, displayName, root, created }
}

// Per-story presentation/pacing mode, persisted in meta.json. "comic"
// switches the foreground from prose narration to a panel script rendered as
// a picture story; "fast" keeps prose but plays in short decision-to-decision
// bursts. Both are experimental and gated globally (OPENOVEL_ENABLE_COMIC_MODE
// / OPENOVEL_ENABLE_FAST_MODE); absent / anything else means the default prose
// mode. The single `mode` field makes the modes mutually exclusive: switching
// to one replaces the other. Like PREFERENCES.md this is a per-story override:
// the story carries its own mode across restarts.
const STORY_MODES = new Set(["comic", "fast"])

function isKnownStoryMode(mode) {
  return STORY_MODES.has(mode)
}

export async function setStoryMode({ id, mode, cwd = process.cwd(), env = process.env } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const root = path.join(layout.storiesRoot, id)
  if (!existsSync(root)) throw new Error(`Story not found: ${id}`)
  const existing = (await readStoryMeta(root)) || {}
  const next = { ...existing }
  if (isKnownStoryMode(mode)) next.mode = mode
  else delete next.mode
  await writeStoryMeta(root, next)
  return { id, mode: next.mode || "" }
}

// Mode of the ACTIVE story (resolved via workspaceLayout, so it follows
// OPENOVEL_STORY_ID). Read per turn by the session processor; a meta.json
// read is two syscalls, cheap enough to skip caching.
export async function currentStoryMode({ cwd = process.cwd(), env = process.env } = {}) {
  const desc = currentStoryDescriptor({ cwd, env })
  if (desc.isProjectLocal) return ""
  const meta = await readStoryMeta(desc.root)
  return isKnownStoryMode(meta?.mode) ? meta.mode : ""
}

// The active story's mode AND its global gate, resolved together: the one
// source of truth both loops use (sessionProcessor for the narrator, the
// storykeeper/resident workflows for background context). A persisted mode
// whose global switch is off resolves to "" (the story degrades to default
// prose, same as comic mode always behaved).
export async function resolveActiveStoryMode({ cwd = process.cwd(), env } = {}) {
  const mode = await currentStoryMode({ cwd, env: env || process.env }).catch(() => "")
  // Gates fall back to settingsEnv() (settings-file layering) when the caller
  // didn't hand us an explicit env, matching how the session processor always
  // called isComicModeEnabled().
  if (mode === "comic") return isComicModeEnabled(env || undefined) ? mode : ""
  if (mode === "fast") return isFastModeEnabled(env || undefined) ? mode : ""
  return ""
}

// Update a story's display name post-creation. Returns the new name as
// it was normalized.
export async function renameStory({ id, name, cwd = process.cwd(), env = process.env } = {}) {
  const displayName = normalizeStoryDisplayName(name)
  if (!displayName) throw new Error(`Story name cannot be empty`)
  const layout = workspaceLayout({ cwd, env })
  const root = path.join(layout.storiesRoot, id)
  if (!existsSync(root)) throw new Error(`Story not found: ${id}`)
  const existing = (await readStoryMeta(root)) || {}
  await writeStoryMeta(root, { ...existing, displayName })
  return { id, displayName }
}

// Mutates the env object (defaults to process.env) so subsequent workspaceLayout
// calls resolve to the new story. Does NOT initialize the story dir or reset
// the SessionProcessor — those are caller concerns.
//
// id === PROJECT_LOCAL_ID restores the project-local ./story default.
export function switchActiveStory({ id, env = process.env } = {}) {
  delete env.OPENOVEL_STORY_ROOT
  delete env.AI_STORY_ROOT
  delete env.OPENOVEL_ROOT
  if (!id || id === PROJECT_LOCAL_ID) {
    delete env.OPENOVEL_STORY_ID
    delete env.AI_STORY_ID
    return { id: PROJECT_LOCAL_ID, isProjectLocal: true }
  }
  // Random ids are already FS-safe; legacy slug-style ids are too. We
  // intentionally do NOT slugify here anymore — slugifying a random id
  // is a no-op, and slugifying a legacy slug would corrupt it (it might
  // have been e.g. `foo.bar` originally, which the new regex now keeps
  // but the old call's trim-by-stricter-rule could have changed).
  env.OPENOVEL_STORY_ID = String(id)
  delete env.AI_STORY_ID
  return { id: String(id), isProjectLocal: false }
}
