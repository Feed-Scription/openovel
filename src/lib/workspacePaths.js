import os from "node:os"
import path from "node:path"
import { settingsEnv } from "../config/settings.js"
import { pinnedStoryRoot } from "./storyContext.js"

const APP_DIR = ".openovel"
const LEGACY_APP_DIR = ".ai-story"

export function workspaceLayout({ cwd = process.cwd(), env = settingsEnv() } = {}) {
  const home = path.resolve(env.OPENOVEL_HOME || env.AI_STORY_HOME || path.join(os.homedir(), APP_DIR))
  const storyRoot = resolveStoryRoot({ cwd, env, home })
  const globalMemory = path.join(home, "memory")
  const globalContextCards = path.join(home, "context-cards")
  const sharedReferences = path.join(home, "references")
  const globalMemoryTopics = path.join(globalMemory, "topics")
  const sharedReferenceTopics = path.join(sharedReferences, "topics")
  return {
    home,
    storiesRoot: path.join(home, "stories"),
    globalMemory,
    globalMemoryTopics,
    globalContextCards,
    sharedReferences,
    sharedReferenceTopics,
    sharedReferenceIndex: path.join(sharedReferences, "INDEX.md"),
    userMemory: path.join(globalMemory, "USER.md"),
    // Model-observed companion to USER.md — memory-review writes here so
    // the user-set preferences file stays a one-way input the model can
    // read but never edit. Both files are surfaced to narrator + workflows.
    userObservedMemory: path.join(globalMemory, "OBSERVED.md"),
    storyRoot,
    storyId: env.OPENOVEL_STORY_ID || env.AI_STORY_ID || "",
  }
}

export function storyPaths({ cwd = process.cwd(), env = settingsEnv() } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const root = layout.storyRoot
  const canon = path.join(root, "canon")
  const packets = path.join(root, "packets")
  const profiles = path.join(root, "profiles")
  const research = path.join(root, "research")
  const guidance = path.join(root, "guidance")
  // Showrunner-owned narrator working set: a directory of section files composed
  // into the read-only FOREGROUND.md. Renamed from story/foreground/ (the
  // foreground/background naming is retired). `foregroundDir` stays as a
  // deprecated alias so existing consumers transparently follow to frontend/.
  const frontendDir = path.join(root, "frontend")
  const foregroundDir = frontendDir
  // Per-agent domain directories — each resident sub-agent owns one. The
  // Director's domain replaces the former internal story/background/ scratchpad
  // (the plot-arc / pacing / tic analysis lives here); the others are scaffolded
  // for the World Keeper, Card Manager, and (format-gated) Render Manager.
  const directorDir = path.join(root, "director")
  const worldkeeperDir = path.join(root, "worldkeeper")
  const cardsDir = path.join(root, "cards")
  const renderDir = path.join(root, "render")
  // Opt-in format-contract feature: per-story rich-render contract authored by
  // the background loop (see lib/formatContract.js). Off by default.
  const formatDir = path.join(root, "format")
  // Opt-in render-time @include feature: dedicated folder for text/image/video
  // files the narrator pulls into its prose via `ovl:include` fences. The
  // ovl-asset:// protocol (Electron main) only serves files under here. Off by
  // default (gated by the format contract's `include` block). See lib/includePaths.js.
  const includesDir = path.join(root, "includes")
  const memory = path.join(root, "memory")
  const memoryTopics = path.join(memory, "topics")
  const inbox = path.join(root, "inbox")
  const contextCards = path.join(root, "context-cards")
  const sharedContextCards = path.join(layout.sharedReferences, "context-cards")
  // per-story durable backgroundJob ledger
  const jobs = path.join(root, "jobs")
  const watchers = path.join(root, "watchers")
  const transactions = path.join(root, "transactions")
  const permissions = path.join(root, "permissions")
  const agents = path.join(root, "agents")
  return {
    ...layout,
    root,
    canon,
    packets,
    profiles,
    research,
    guidance,
    memory,
    memoryTopics,
    inbox,
    contextCards,
    sharedContextCards,
    foregroundDir,
    frontendDir,
    directorDir,
    worldkeeperDir,
    cardsDir,
    renderDir,
    formatDir,
    includesDir,
    jobs,
    watchers,
    transactions,
    permissions,
    agents,
    sceneLog: path.join(canon, "scene_log.jsonl"),
    chapters: path.join(canon, "chapters.md"),
    // Mirror of ONLY the single most-recently-written section, overwritten
    // every turn. Lets the background agent locate "what was just written"
    // without tail-reading the full canon. chapters.md stays the complete,
    // consistency-check source of truth.
    chaptersRecent: path.join(canon, "chapters.recent.md"),
    provenance: path.join(canon, "PROVENANCE.md"),
    // Original user brief — written ONCE at init time, then read-only.
    // Storykeeper / narrator reference this as ground truth across the
    // entire lifetime of the story so they don't drift from the user's
    // original intent. Editing is denied at the tool layer.
    brief: path.join(root, "BRIEF.md"),
    // Storykeeper-owned running quality analysis: each background turn it
    // audits canon/chapters.md (the narrator's actual prose) for anomalies
    // and logs findings + corrective actions here. Seeded at init. Lives in the
    // Director's internal domain — never composed into the foreground.
    qualityLog: path.join(directorDir, "QUALITY.md"),
    // Storykeeper-owned plot-arc / pacing / foreshadowing ledger: the internal
    // reasoning substrate for rhythm control (arc position, tension read,
    // planned beats, setup→payoff bookkeeping, stagnation watch). Seeded at
    // init from BRIEF, maintained every background turn. Internal-only — never
    // composed into the foreground; its effect reaches the story only when the
    // Storykeeper translates the plan into the narrator-facing foreground
    // sections (scene.md / active-pressures.md / open-threads.md).
    arcLog: path.join(directorDir, "ARC.md"),
    // Runtime-owned choice feedback ledger. It mirrors the player's submitted
    // action and, when the option UI was active, the options they declined so
    // the Director can adapt story/director/OPTIONS.md from observed behavior.
    choiceFeedbackLog: path.join(directorDir, "CHOICE_FEEDBACK.md"),
    // Director-maintained profile of the player's in-story choice behavior.
    // Derived from CHOICE_FEEDBACK.md and used to predict likely next behavior
    // patterns when tuning OPTIONS.md. Internal-only; never narrator-facing.
    playerProfile: path.join(directorDir, "PLAYER_PROFILE.md"),
    // Incremental n-gram tic counts + a byte checkpoint into canon/chapters.md,
    // so the Storykeeper folds only newly-appended prose each turn instead of
    // re-scanning the whole window. Runtime-owned; lives in the Director domain.
    ngramStore: path.join(directorDir, "ngrams.json"),
    contextReport: path.join(packets, "foreground_context.report.latest.json"),
    // Runtime cache of the most recent foreground_turn event. Hot-path option
    // binding reads this instead of archaeology through scene_log.jsonl, whose
    // tail can be dominated by large background audit patches.
    latestForegroundTurn: path.join(packets, "last-foreground-turn.json"),
    // Derived cache of the foreground_turn count, bumped on append so watchers
    // don't re-scan the whole append-only scene_log every turn. See storyStore.
    turnCountCache: path.join(packets, "turn-count.json"),
    contextCardStats: path.join(packets, "context_cards.stats.json"),
    latestProfile: path.join(profiles, "profile.latest.json"),
    // Auto-managed search log: every websearch call appends a block here.
    // Models READ this file freely but should NOT write/edit it directly —
    // it's the runtime's append-only audit trail.
    searchLog: path.join(research, "search-log.md"),
    // Model-editable research scratchpad. Empty by default. Init agent /
    // storykeeper may organize their findings, highlight URLs worth
    // following up on, write distilled notes, etc.
    researchNotes: path.join(research, "ResearchNotes.md"),
    // Legacy single-file contract (markdown). The loader no longer reads it;
    // kept only so the write tool can recognize and refuse legacy writes.
    formatContract: path.join(formatDir, "CONTRACT.md"),
    // File-based format contract: a pure-JSON config + one HTML template file
    // per block kind under blocks/ (filename stem = kind) + sibling .css.
    formatConfig: path.join(formatDir, "config.json"),
    formatBlocksDir: path.join(formatDir, "blocks"),
    foregroundGuidance: path.join(guidance, "FOREGROUND.md"),
    // FG_template.md is the unified editable mirror — models edit this
    // file when they want to rewrite the whole guidance in one shot. The
    // runtime parses it into per-section files and regenerates
    // FOREGROUND.md (which is read-only and banner-warned).
    foregroundTemplate: path.join(guidance, "FG_template.md"),
    foregroundContextInserts: path.join(guidance, "CONTEXT_INSERTS.md"),
    // Context-card @include manifests composed into the foreground. cards.md is
    // curated by the Storykeeper (durable set); cards.auto.md is rewritten each
    // turn by the deterministic trigger match (deduped vs cards.md).
    cardsManifest: path.join(guidance, "cards.md"),
    cardsAuto: path.join(guidance, "cards.auto.md"),
    backgroundInbox: path.join(inbox, "INBOX.md"),
    backgroundInboxArchive: path.join(inbox, "MERGED.md"),
    memoryIndex: path.join(memory, "MEMORY.md"),
    storyMemory: path.join(memory, "MEMORY.md"),
    // Per-story player-preference override. When present, it replaces the
    // global home/memory/USER.md for THIS story (see memory/memoryStore.js).
    // Same line format as USER.md so the same form parser round-trips it.
    storyPreferences: path.join(memory, "PREFERENCES.md"),
    jobsLedger: path.join(jobs, "jobs.jsonl"),
    storykeeperLock: path.join(jobs, "storykeeper.lock"),
    storykeeperThread: path.join(agents, "storykeeper.thread.jsonl"),
    storykeeperQueue: path.join(agents, "storykeeper.queue.jsonl"),
    permissionsLedger: path.join(permissions, "permissions.jsonl"),
    watcherIndex: path.join(watchers, "README.md"),
    monitorsFile: path.join(watchers, "monitors.json"),
    loopsFile: path.join(watchers, "loops.json"),
    watcherLedger: path.join(watchers, "events.jsonl"),
  }
}

export function resolveWorkspacePath(filePath, { cwd = process.cwd(), env = settingsEnv() } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const value = normalizeSlashes(String(filePath || "").trim())
  if (!value) throw new Error("filePath is required")

  if (path.isAbsolute(value)) {
    const resolved = path.resolve(value)
    if (isInside(resolved, layout.storyRoot)) {
      return scopedResult(resolved, layout.storyRoot, "story")
    }
    if (isInside(resolved, layout.sharedReferences)) {
      return scopedResult(resolved, layout.sharedReferences, "shared")
    }
    if (isInsideHomeReadable(resolved, layout)) {
      return scopedResult(resolved, layout.home, "home")
    }
    throw new Error(`Refusing to access path outside story/shared/home workspaces: ${filePath}`)
  }

  const scoped = splitScope(value)
  const root = scoped.scope === "shared"
    ? layout.sharedReferences
    : scoped.scope === "home"
      ? layout.home
      : layout.storyRoot
  const resolved = path.resolve(root, scoped.relativePath)
  if (!isInside(resolved, root)) {
    throw new Error(`Refusing to access path outside ${scoped.scope} workspace: ${filePath}`)
  }
  // The home dir (~/.openovel by default) also holds secrets — settings.local.json
  // with API keys, the device id, and every OTHER story under stories/. The
  // model only ever needs the documented memory / references / context-card
  // subtrees, so the home scope is allow-listed to those.
  if (scoped.scope === "home" && !isInsideHomeReadable(resolved, layout)) {
    throw new Error(
      `Refusing to access ${filePath}: only home/memory, home/references, and home/context-cards are reachable (settings, API keys, and other stories are off-limits).`,
    )
  }
  return scopedResult(resolved, root, scoped.scope)
}

// Subtrees of the home dir that model-facing tools may read. Everything else
// under home (settings.local.json, kimi-device-id, stories/, electron-prefs)
// stays off-limits.
const HOME_READABLE_SUBDIRS = ["memory", "references", "context-cards"]
function isInsideHomeReadable(resolved, layout) {
  return HOME_READABLE_SUBDIRS.some((dir) => {
    const sub = path.join(layout.home, dir)
    return resolved === sub || isInside(resolved, sub)
  })
}

export function displayWorkspacePath(filePath, { cwd = process.cwd(), env = settingsEnv() } = {}) {
  const layout = workspaceLayout({ cwd, env })
  const resolved = path.resolve(filePath)
  if (isInside(resolved, layout.storyRoot)) return displayScopedPath(resolved, layout.storyRoot, "story")
  if (isInside(resolved, layout.sharedReferences)) return displayScopedPath(resolved, layout.sharedReferences, "shared")
  if (isInside(resolved, layout.home)) {
    // `home/` is the abstract scope marker for the openovel home dir —
    // actual filesystem location varies (defaults ~/.openovel, but can be
    // any OPENOVEL_HOME). Models and prompts see `home/...`; never the
    // literal "~/.openovel" which would lie for users with a custom home.
    const rel = path.relative(layout.home, resolved).split(path.sep).join("/")
    return `home/${rel}`
  }
  const legacyHome = path.resolve(env.AI_STORY_HOME || path.join(os.homedir(), LEGACY_APP_DIR))
  if (legacyHome !== layout.home && isInside(resolved, legacyHome)) {
    const rel = path.relative(legacyHome, resolved).split(path.sep).join("/")
    return `home-legacy/${rel}`
  }
  return resolved
}

function resolveStoryRoot({ cwd, env, home }) {
  // A background job pins itself to the story it started on (storyContext.js),
  // so a mid-run switchActiveStory() env flip can't redirect its writes into the
  // newly-active story. The pin wins over the live env by design.
  const pinned = pinnedStoryRoot()
  if (pinned) return path.resolve(cwd, pinned)
  const explicitRoot = env.OPENOVEL_STORY_ROOT || env.OPENOVEL_ROOT || env.AI_STORY_ROOT
  const storyId = env.OPENOVEL_STORY_ID || env.AI_STORY_ID
  if (explicitRoot) return path.resolve(cwd, explicitRoot)
  if (storyId) return path.join(home, "stories", safeName(storyId))
  return path.join(cwd, "story")
}

function splitScope(value) {
  const normalized = value.replace(/^\.\/+/, "")
  if (normalized === "story") return { scope: "story", relativePath: "." }
  if (normalized.startsWith("story/")) return { scope: "story", relativePath: normalized.slice("story/".length) || "." }
  if (normalized === "shared" || normalized === "references" || normalized === "global/references") {
    return { scope: "shared", relativePath: "." }
  }
  if (normalized.startsWith("shared/")) return { scope: "shared", relativePath: normalized.slice("shared/".length) || "." }
  if (normalized.startsWith("references/")) {
    return { scope: "shared", relativePath: normalized.slice("references/".length) || "." }
  }
  if (normalized.startsWith("global/references/")) {
    return { scope: "shared", relativePath: normalized.slice("global/references/".length) || "." }
  }
  // `home/` is the abstract marker for the openovel home dir (default
  // ~/.openovel). displayWorkspacePath emits these for memory / references /
  // context-card files, and the prompts reference home/memory/USER.md etc., so
  // the read tool must resolve them back. Access is allow-listed to safe
  // subtrees in resolveWorkspacePath.
  if (normalized === "home") return { scope: "home", relativePath: "." }
  if (normalized.startsWith("home/")) {
    return { scope: "home", relativePath: normalized.slice("home/".length) || "." }
  }
  return { scope: "story", relativePath: normalized }
}

function scopedResult(resolved, root, scope) {
  return {
    path: resolved,
    root,
    scope,
    displayPath: displayScopedPath(resolved, root, scope),
  }
}

function displayScopedPath(filePath, root, scope) {
  const rel = path.relative(root, filePath).split(path.sep).join("/")
  return rel ? `${scope}/${rel}` : scope
}

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/").split(path.sep).join("/")
}

function safeName(value) {
  return String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default"
}
