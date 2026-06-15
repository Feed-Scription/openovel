import path from "node:path"
import { existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import { appendJsonl, appendText, ensureDir, readJson, readTailText, readText, writeAtomic, writeText } from "./files.js"
import { bus } from "../runtime/bus.js"
import { storyPaths } from "./workspacePaths.js"
import { optionLabel } from "./optionLabel.js"

export const paths = dynamicPaths()

const recoveredTransactionRoots = new Set()
const SCENE_LOG_INITIAL_LOOKBACK_BYTES = 64 * 1024
const SCENE_LOG_MAX_LOOKBACK_BYTES = 4 * 1024 * 1024

export async function initializeStory() {
  // Verbose per-step timing for debugging "VM startup takes N seconds"
  // reports. Enable with OPENOVEL_DEBUG_INIT_STORY=1.
  const debugInit = process.env.OPENOVEL_DEBUG_INIT_STORY === "1"
  const t0 = Date.now()
  const mark = (stage) => {
    if (debugInit) process.stderr.write(`[initializeStory +${Date.now() - t0}ms] ${stage}\n`)
  }
  mark("begin")
  const p = storyPaths()
  mark("storyPaths")
  await Promise.all([
    ensureDir(p.canon),
    ensureDir(p.packets),
    ensureDir(p.profiles),
    ensureDir(p.research),
    ensureDir(p.guidance),
    ensureDir(p.memory),
    ensureDir(p.memoryTopics),
    ensureDir(p.inbox),
    ensureDir(p.contextCards),
    ensureDir(p.globalMemory),
    ensureDir(p.globalMemoryTopics),
    ensureDir(p.globalContextCards),
    ensureDir(p.sharedReferences),
    ensureDir(p.sharedReferenceTopics),
    ensureDir(p.sharedContextCards),
    ensureDir(p.jobs),
    ensureDir(p.watchers),
    ensureDir(p.transactions),
    ensureDir(p.permissions),
    ensureDir(p.agents),
  ])
  mark("ensureDirs")
  if (!recoveredTransactionRoots.has(p.root)) {
    recoveredTransactionRoots.add(p.root)
    try {
      const { recoverAbandonedStoryTransactions } = await import("../runtime/storyTransaction.js")
      mark("tx:import")
      await recoverAbandonedStoryTransactions()
      mark("tx:recover")
    } catch {
      // Transaction recovery is best-effort during bootstrap; ordinary story
      // initialization must remain usable even if an old manifest is corrupt.
    }
  }
  const chapters = await readText(p.chapters, "")
  if (!chapters) await writeText(p.chapters, "")
  const chaptersRecent = await readText(p.chaptersRecent, "")
  if (!chaptersRecent) {
    await writeText(
      p.chaptersRecent,
      "<!-- Most recent section only; overwritten every turn. The complete canon is canon/chapters.md — use that for consistency checks. -->\n",
    )
  }
  mark("chapters")
  const provenance = await readText(p.provenance, "")
  if (!provenance) {
    await writeText(
      p.provenance,
      [
        "# Storykeeper Provenance",
        "",
        "Audit notes for background file updates. This is ordinary Markdown so users and agents can inspect it with read/grep.",
        "",
      ].join("\n"),
    )
  }
  // Resident-layout self-heal (lazy migration): bring a pre-reorg workspace onto
  // the new tree on open. story/foreground/ → story/frontend/ (Showrunner working
  // set) and story/background/ → story/director/ (internal arc/pacing/quality).
  // Idempotent: only renames when the source exists and the target does not, so
  // a save already migrated (or pre-migrated by the one-shot script) is untouched.
  for (const [from, to] of [["foreground", "frontend"], ["background", "director"]]) {
    const src = path.join(p.root, from)
    const dst = path.join(p.root, to)
    if (existsSync(src) && !existsSync(dst)) {
      try {
        await rename(src, dst)
      } catch {
        // Cross-device or partial — leave the source in place; the FG_template
        // @include rewrite below + migrateForegroundFilenames will still point at
        // the new dir, and a later open retries. Surface nothing destructive.
      }
    }
  }
  // Migrate the legacy story/QUALITY.md (root) into the Director's internal
  // domain. QUALITY was never narrator-facing. Once-only: only when the old file
  // exists and the new one doesn't.
  const legacyQuality = path.join(p.root, "QUALITY.md")
  if (existsSync(legacyQuality) && !existsSync(p.qualityLog)) {
    await ensureDir(path.dirname(p.qualityLog))
    try {
      await rename(legacyQuality, p.qualityLog)
    } catch {
      // Cross-device rename can fail — copy instead, leaving the old file as a
      // harmless orphan (the existsSync(new) guard prevents re-migration).
      await writeText(p.qualityLog, await readText(legacyQuality, ""))
    }
  }
  // Story quality analysis — Storykeeper's running audit of the narrator's
  // actual prose. Seeded once; the slow loop maintains it thereafter.
  const qualityLog = await readText(p.qualityLog, "")
  if (!qualityLog) {
    await writeText(
      p.qualityLog,
      [
        "# Story Quality Analysis",
        "",
        "Internal notebook — lives in `story/director/` and is NEVER shown to the",
        "narrator. Maintained by Storykeeper. Each background turn it reads the recent tail of",
        "`canon/chapters.md` (the narrator's actual writing) plus the repeated-n-gram report,",
        "checks for anomalies and verbal tics, logs the analysis here, and fixes the root cause",
        "by editing the per-section files under `story/frontend/` (or the relevant context",
        "card) — not by editing the prose.",
        "",
        "## Open issues",
        "",
        "_(none yet)_",
        "",
        "## Resolved",
        "",
        "_(none yet)_",
        "",
      ].join("\n"),
    )
  }
  // Plot-arc / pacing / foreshadowing ledger — Storykeeper's internal rhythm
  // notebook. Seeded once with an empty skeleton; init fills the opening
  // direction + setups from BRIEF, and the slow loop maintains it every turn.
  const arcLog = await readText(p.arcLog, "")
  if (!arcLog) {
    await writeText(
      p.arcLog,
      [
        "# Story Arc · Pacing · Setups",
        "",
        "Internal notebook — lives in `story/director/`, NEVER shown to the narrator.",
        "Maintained by the Storykeeper every turn (seeded with the opening direction + setups at init).",
        "This is the REASONING substrate; its effect reaches the story ONLY by translating the plan",
        "here into the foreground sections the narrator reads — scene.md / active-pressures.md /",
        "open-threads.md. The story is reader-driven: treat the plan as a compass re-checked each",
        "turn, not a fixed script.",
        "",
        "## 进展追踪 Arc position",
        "",
        "_(where we are against a loose frame — 起/承/转/合 or Fichtean crisis #N; seeded by init from BRIEF)_",
        "",
        "## 节奏评估 Pacing read",
        "",
        "_(recent tension trajectory; Scene/Sequel balance — all-action or all-reflection?; turns since last escalation / last release / last payoff)_",
        "",
        "## 后续规划 Planned beats (held loosely)",
        "",
        "_(the next intended move — escalate / a 转 / a Sequel breather — and the target tension direction)_",
        "",
        "## 伏笔与回收 Setups & payoffs (埋坑/填坑)",
        "",
        "_(one row per setup: id · planted [what + turn] · reinforced · intended payoff · status {open | reinforced | paid | dropped-as-red-herring}; flag setups overdue for payoff)_",
        "",
        "## 停滞预警 Stagnation watch",
        "",
        "_(turns since the rhythm last moved; trigger → force a crisis, introduce a 转, or cash a setup)_",
        "",
      ].join("\n"),
    )
  }
  const choiceFeedbackLog = await readText(p.choiceFeedbackLog, "")
  if (!choiceFeedbackLog) {
    await writeText(
      p.choiceFeedbackLog,
      [
        "# Choice Feedback",
        "",
        "Runtime-owned ledger for the Director. This file records player inputs",
        "and, when the option UI was enabled, the reader-facing options the player",
        "did not choose. It is internal guidance evidence for story/director/OPTIONS.md,",
        "not canon and not narrator-facing.",
        "",
      ].join("\n"),
    )
  }
  const playerProfile = await readText(p.playerProfile, "")
  if (!playerProfile) {
    await writeText(
      p.playerProfile,
      [
        "# Player Choice Profile",
        "",
        "Director-maintained internal profile derived from `story/director/CHOICE_FEEDBACK.md`.",
        "This file is about the player's in-story choice behavior only: preferences,",
        "recurring decision style, current predicted next moves, and implications for",
        "`story/director/OPTIONS.md`. Do not infer demographics, identity, or traits",
        "unrelated to play behavior.",
        "",
        "## Current Read",
        "",
        "_(No observed choice pattern yet.)_",
        "",
        "## Evidence",
        "",
        "_(Summarize recent choice-feedback entries here; keep it compact.)_",
        "",
        "## Predictions",
        "",
        "_(Likely near-future behavior patterns, with confidence and counter-signals.)_",
        "",
        "## Options Implications",
        "",
        "_(Abstract guidance for how OPTIONS.md should adapt; no concrete stale labels.)_",
        "",
      ].join("\n"),
    )
  }
  // Auto-managed search log (runtime appends; model read-only).
  const searchLog = await readText(p.searchLog, "")
  if (!searchLog) {
    await writeText(
      p.searchLog,
      [
        "# Search Log",
        "",
        "Append-only audit trail. The runtime adds a block here every time `websearch` runs.",
        "Do not edit by hand — entries get overwritten on the next search anyway.",
        "If you want to write distilled findings or organize URLs to follow up on, use ResearchNotes.md instead.",
        "",
      ].join("\n"),
    )
  }
  // Model-editable research scratchpad.
  const researchNotes = await readText(p.researchNotes, "")
  if (!researchNotes) {
    await writeText(
      p.researchNotes,
      [
        "# Research Notes",
        "",
        "Model-editable scratchpad. Write distilled findings, highlight URLs from the search log worth following up on, jot down hypotheses, organize sources by topic, etc.",
        "",
      ].join("\n"),
    )
  }
  mark("notes")
  // Seed FG_template.md + per-section files if missing. New model: FG.md
  // is purely auto-generated by recomposeForegroundGuidance from the
  // @include manifest. After seeding (or even when already present),
  // ALWAYS recompose so the read-only FG.md reflects the latest sources —
  // catches the case where an earlier run wrote a stale FG.md.
  const { buildDefaultForegroundTemplate, recomposeForegroundGuidance } = await import("./foregroundCompose.js")
  mark("foregroundCompose:import")
  const { FOREGROUND_SECTIONS, migrateForegroundFilenames } = await import("./foregroundCompose.js")
  // Bring legacy workspaces onto the unprefixed filename scheme (10-scene.md →
  // scene.md) and ensure the card-manifest @includes exist, BEFORE seeding
  // sections below — otherwise the seed loop would write an empty scene.md
  // alongside a real 10-scene.md. Idempotent / no-op for new + migrated stories.
  await migrateForegroundFilenames().catch(() => {})
  const template = await readText(p.foregroundTemplate, "")
  if (!template) {
    await writeText(p.foregroundTemplate, buildDefaultForegroundTemplate())
  }
  // Seed EVERY section the default manifest @includes — even ones whose
  // body is just a placeholder heading. Without these, the init agent's
  // first `read foreground/<section>.md` call returns "File not found"
  // and the agent has to guess whether to write the file vs. edit it.
  // Idempotent: only files that don't already exist get the placeholder.
  await ensureDir(p.foregroundDir)
  for (const section of FOREGROUND_SECTIONS) {
    const filePath = path.join(p.foregroundDir, section.filename)
    const existing = await readText(filePath, "")
    if (existing) continue
    await writeText(filePath, defaultSectionBody(section))
  }
  mark("foreground:seed")
  // Recompose unconditionally — cheap, idempotent, and self-heals any
  // stale FG.md from older code paths.
  await recomposeForegroundGuidance().catch(() => {})
  mark("foreground:recompose")
  const memory = await readText(p.memoryIndex, "")
  if (!memory) await writeText(p.memoryIndex, "# Story Memory\n\n")
  // Context cards compose via @include (cards.md / cards.auto.md, seeded by
  // ensureCardManifests through recompose above), so there is no separate
  // inserts file to seed.
  const inbox = await readText(p.backgroundInbox, "")
  if (!inbox) await writeText(p.backgroundInbox, inboxHeader())
  const archive = await readText(p.backgroundInboxArchive, "")
  if (!archive) await writeText(p.backgroundInboxArchive, inboxArchiveHeader())
  const userMemory = await readText(p.userMemory, "")
  if (!userMemory) {
    await writeText(
      p.userMemory,
      [
        "# User Memory",
        "",
        "Global author preferences shared across stories. User-editable; the model reads but never writes here. Model observations live in OBSERVED.md.",
        "",
      ].join("\n"),
    )
  }
  const userObservedMemory = await readText(p.userObservedMemory, "")
  if (!userObservedMemory) {
    await writeText(
      p.userObservedMemory,
      [
        "# Observed Memory",
        "",
        "Model-observed notes about the reader and how they interact, shared across stories. Written by the background memory-review loop. The user-set USER.md remains read-only.",
        "",
      ].join("\n"),
    )
  }
  const referenceIndex = await readText(p.sharedReferenceIndex, "")
  if (!referenceIndex) {
    await writeText(
      p.sharedReferenceIndex,
      [
        "# Shared References",
        "",
        "Reusable research notes and source pointers shared across stories. Put history, geography, genre craft, and other non-story-specific material here to avoid duplication.",
        "",
      ].join("\n"),
    )
  }
  const watcherIndex = await readText(p.watcherIndex, "")
  if (!watcherIndex) {
    await writeText(
      p.watcherIndex,
      [
        "# Story Watchers",
        "",
        "Runtime automation used by background agents. Monitors watch foreground/file changes and loops enqueue recurring background work.",
        "",
        "- `monitors.json`: active monitor definitions.",
        "- `loops.json`: active loop definitions.",
        "- `events.jsonl`: trigger audit trail.",
        "",
        "These files are runtime configuration, not story canon. Users and agents may inspect or edit them, but Storykeeper should merge only triggered inbox items into durable story files.",
        "",
      ].join("\n"),
    )
  }
  const monitors = await readText(p.monitorsFile, "")
  if (!monitors) await writeText(p.monitorsFile, "[]\n")
  const loops = await readText(p.loopsFile, "")
  if (!loops) await writeText(p.loopsFile, "[]\n")
  mark("done")
}

// The options shown to the reader on the PREVIOUS turn — read from the tail of the
// append-only scene_log (the last foreground_turn). The options model uses these to
// avoid re-offering choices the reader already declined.
async function readLastTurnOptions() {
  const turn = await readLatestForegroundTurnCache() || await readLatestForegroundTurnFromSceneLog()
  // Options may be legacy strings or `{ id, label, key?, effect? }` objects;
  // keep both shapes (the options model + selection binding read them).
  return Array.isArray(turn?.foreground?.options)
    ? turn.foreground.options.filter((o) => o && (typeof o === "string" ? o.trim() : (typeof o.label === "string" && o.label.trim())))
    : []
}

// The recent per-turn `tension` trajectory (chronological, oldest→newest) — the
// raw material for the Storykeeper's pacing read. Each foreground_turn event in
// the scene_log carries a compact `tension` label (sessionProcessor); we tail
// the log and return the last `n` of them as {turn, tension}. Same tail-read +
// partial-line tolerance as readLastTurnOptions.
async function readRecentTensions(n = 8) {
  const want = Math.max(1, Number(n) || 8)
  return readSceneLogTail((events, { final = false } = {}) => {
    const out = []
    for (const e of events) {
      if (e && e.type === "foreground_turn") {
        out.push({ turn: e.turnId || "", tension: typeof e.foreground?.tension === "string" ? e.foreground.tension.trim() : "" })
      }
    }
    return out.length >= want || final ? out.slice(-want) : null
  }, { fallback: [] })
}

async function readLatestForegroundTurnCache() {
  try {
    const cached = await readJson(paths.latestForegroundTurn, null)
    if (cached?.type === "foreground_turn" && cached.turnId) return cached
  } catch {
    // Corrupt or missing cache → legacy fallback below.
  }
  return null
}

async function readLatestForegroundTurnFromSceneLog() {
  return readSceneLogTail((events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === "foreground_turn") return events[i]
    }
    return null
  }, { fallback: null })
}

async function readSceneLogTail(scan, {
  fallback,
  initialBytes = SCENE_LOG_INITIAL_LOOKBACK_BYTES,
  maxBytes = SCENE_LOG_MAX_LOOKBACK_BYTES,
} = {}) {
  const sizes = []
  for (let bytes = initialBytes; bytes < maxBytes; bytes *= 2) sizes.push(bytes)
  sizes.push(maxBytes)
  for (const bytes of sizes) {
    const tail = await readTailText(paths.sceneLog, bytes, "")
    if (!tail) return fallback
    const result = scan(parseSceneLogTail(tail), { final: bytes >= maxBytes, bytes })
    if (result) return result
  }
  return fallback
}

function parseSceneLogTail(tail) {
  const out = []
  for (const line of String(tail || "").split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s)) // a tail slice may begin mid-line — bad lines just skip
    } catch { /* skip unparseable (partial first line) */ }
  }
  return out
}

export async function getStorySnapshot() {
  await initializeStory()
  const backgroundInbox = await readText(paths.backgroundInbox, "")
  // Foreground guidance is canonically the story/frontend/ directory of section
  // files. loadForegroundGuidance composes the dir
  // contents into the same shape the narrator used to see for FG.md;
  // falls back to legacy story/guidance/FOREGROUND.md when the dir is
  // empty or missing (older workspaces / fresh init that hasn't run
  // applyStorykeeperPatch yet).
  const { loadForegroundGuidance } = await import("./foregroundCompose.js")
  // read only the trailing slice of chapters.md — every downstream
  // consumer of snapshot.chapters takes a suffix off the end (narrator Recent
  // Canon budget: 24000 chars default; backgroundSignal: 1600). Loading the
  // full file scales with session length and wastes memory + time. 160KB ≈
  // ~53K Chinese chars (3 bytes each), comfortably above the largest consumer
  // (24000 chars ≈ 72KB even when the tail is dense CJK) with headroom for
  // interleaved action-header lines.
  const chapters = await readTailText(paths.chapters, 160 * 1024, "")
  return {
    foregroundGuidance: await loadForegroundGuidance(),
    backgroundInbox,
    backgroundInboxItems: parseBackgroundInboxItems(backgroundInbox),
    chapters,
    previousOptions: await readLastTurnOptions(),
    recentTensions: await readRecentTensions(8),
    contextReport: await readJson(paths.contextReport, null),
  }
}

export async function recordSceneEvent(event) {
  const recorded = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    ...event,
  }
  await appendJsonl(paths.sceneLog, recorded)
  // Keep the foreground-turn count cache fresh with an O(1) bump instead of
  // letting watchers re-scan the whole append-only scene_log every turn
  // (O(N)/turn → O(N²)/session). Only bump when the cache already exists; if it
  // doesn't, getForegroundTurnCount seeds it with a one-time scan that includes
  // this just-appended event.
  if (event?.type === "foreground_turn") {
    await writeLatestForegroundTurnCache(recorded).catch(() => {})
    const current = await readTurnCountCache()
    if (current !== null) await writeTurnCountCache(current + 1).catch(() => {})
  }
}

async function writeLatestForegroundTurnCache(event) {
  await writeAtomic(paths.latestForegroundTurn, `${JSON.stringify({
    type: "foreground_turn",
    id: event.id || "",
    at: event.at || "",
    turnId: event.turnId || "",
    action: event.action || "",
    foreground: event.foreground || {},
  }, null, 2)}\n`)
}

const TURN_COUNT_CACHE_VERSION = 1

// scene_log.jsonl is append-only and grows for the whole session; the watcher
// layer needs the foreground_turn count every turn, and re-parsing the full log
// each time is O(N) per turn → O(N²) over a long game. We cache the count in a
// tiny JSON, bumped on each foreground_turn append (recordSceneEvent), and seed
// it lazily with a single full scan the first time it's read (covers stories
// created before this cache existed). The count drives loop cadence / watcher
// turn numbers, not canon — a rare ±1 drift after an unclean crash is harmless;
// delete packets/turn-count.json to force a clean rebuild.
async function readTurnCountCache() {
  try {
    const cache = await readJson(paths.turnCountCache, null)
    if (cache && cache.version === TURN_COUNT_CACHE_VERSION && Number.isInteger(cache.foregroundTurns)) {
      return cache.foregroundTurns
    }
  } catch {
    // corrupt cache → treat as absent; getForegroundTurnCount rebuilds it
  }
  return null
}

async function writeTurnCountCache(foregroundTurns) {
  await writeAtomic(
    paths.turnCountCache,
    JSON.stringify({ version: TURN_COUNT_CACHE_VERSION, foregroundTurns }),
  )
}

async function scanForegroundTurnCount() {
  const text = await readText(paths.sceneLog, "")
  if (!text.trim()) return 0
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      if (JSON.parse(line).type === "foreground_turn") count++
    } catch {
      // ignore torn lines
    }
  }
  return count
}

export async function getForegroundTurnCount() {
  const cached = await readTurnCountCache()
  if (cached !== null) return cached
  // First use (or cache cleared): seed from a one-time full scan, then persist.
  const count = await scanForegroundTurnCount()
  await writeTurnCountCache(count).catch(() => {})
  return count
}

// The reader-turn count for UI display = number of reader_action events in the
// FULL append-only scene_log (the on-disk source of truth). Deliberately NOT
// the foreground_turn cache: foreground_turn isn't recorded in every workspace
// (older / init-only stories show 0), and a cache that survives only the
// session reads back as 1 after a restart. reader_action is written once per
// real reader turn (slash commands branch off before sessionProcessor, so they
// don't count) and accumulates for the life of the story. O(N) full scan — call
// on hydrate/story-switch, then track live via the session.reader_action event.
export async function getReaderTurnCount() {
  const text = await readText(paths.sceneLog, "")
  if (!text.trim()) return 0
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      if (JSON.parse(line).type === "reader_action") count++
    } catch {
      // ignore torn lines
    }
  }
  return count
}

export async function appendChapterText(text) {
  // O(1) append. Was read-modify-write the whole file every turn,
  // which is O(N) per append and quadratic over a long session — a 5000-turn
  // game would otherwise read+write ~12GB cumulatively for chapter
  // accumulation alone. Now we just append the new content with a leading
  // blank line as the section separator. The leading "\n\n" is harmless at
  // the very start of an empty file (it becomes two leading blank lines that
  // readers trim or ignore).
  const body = String(text || "").trim()
  if (!body) return
  await appendText(paths.chapters, `\n\n${body}\n`)
  // Dual-write: mirror ONLY this latest block to chapters.recent.md so the
  // background agent can locate "what was just written" without tail-reading
  // the whole canon. Overwrite (not append) — this file is always exactly one
  // section. chapters.md remains the complete, consistency-check source.
  await writeAtomic(
    paths.chaptersRecent,
    `<!-- Most recent section only; overwritten every turn. The complete canon is canon/chapters.md — use that for consistency checks. -->\n\n${body}\n`,
  )
}

export async function appendChoiceFeedback({
  turnId = "",
  action = "",
  source = "",
  selected = null,
  previousOptions = [],
  includeUnchosen = false,
  optionsEnabled = false,
} = {}) {
  const entry = formatChoiceFeedbackEntry({
    turnId,
    action,
    source,
    selected,
    previousOptions,
    includeUnchosen,
    optionsEnabled,
  })
  if (entry) await appendText(paths.choiceFeedbackLog, `\n${entry}\n`)
}

export function formatChoiceFeedbackEntry({
  turnId = "",
  action = "",
  source = "",
  selected = null,
  previousOptions = [],
  includeUnchosen = false,
  optionsEnabled = false,
  now = new Date(),
} = {}) {
  const input = compactLine(action, 500)
  if (!input && !turnId) return ""
  const selectedId = selected && typeof selected === "object" ? compactLine(selected.id, 120) : ""
  const selectedKey = selected && typeof selected === "object" && selected.key === true
  const options = Array.isArray(previousOptions) ? previousOptions : []
  const unchosen = includeUnchosen
    ? options
        .filter((option) => {
          if (!selectedId) return true
          return !(option && typeof option === "object" && option.id === selectedId)
        })
        .map((option) => compactLine(optionLabel(option), 220))
        .filter(Boolean)
    : []
  const lines = [
    `## ${compactLine(turnId, 120) || "unknown-turn"} - ${toIsoString(now)}`,
    "",
    `- input source: ${compactLine(source, 80) || "unknown"}`,
    `- option UI enabled: ${optionsEnabled ? "yes" : "no"}`,
    `- player input: ${input || "-"}`,
  ]
  if (selectedId) {
    lines.push(`- selected option id: ${selectedId}`)
    lines.push(`- selected key decision: ${selectedKey ? "yes" : "no"}`)
  } else {
    lines.push("- selected option id: -")
  }
  if (includeUnchosen) {
    lines.push("- unchosen options:")
    if (unchosen.length) {
      for (const label of unchosen) lines.push(`  - ${label}`)
    } else {
      lines.push("  - (none)")
    }
  } else {
    lines.push("- unchosen options: not recorded (option UI disabled)")
  }
  return lines.join("\n")
}

export async function applyStorykeeperPatch(patch, { expectedStoryRoot } = {}) {
  // Cross-story safety backstop: if the reader switched stories while this
  // Storykeeper job was running, the active story root no longer matches the
  // one this patch was computed for. Writing now would overwrite the NEW
  // story's foreground/*.md with the previous story's content. Discard the
  // write instead — the original story's inbox items stay unresolved and its
  // next session re-processes them. (The primary guard is draining background
  // jobs before any switch; this catches the drain-timeout edge.)
  if (expectedStoryRoot && paths.root !== expectedStoryRoot) {
    return { foregroundGuidance: "", inboxResolved: [], skipped: true, reason: "story_switched_mid_run" }
  }
  // transactional apply. Compute ALL new file content in
  // memory first, then commit each file via atomic temp+rename. If anything
  // fails after the staleness check, the existing files stay intact (writeAtomic
  // never publishes a half-written file). Previous behavior could leave FG.md
  // updated but INBOX.md / MERGED.md un-resolved if the second write aborted.
  //
  // Foreground guidance is a per-section directory. The
  // envelope's foregroundGuidanceMarkdown still arrives as unified Markdown
  // (zero behavioral change for storykeeper), but the runtime parses it into
  // sections and writes each section as its own file under story/frontend/.
  // The composed FOREGROUND.md is dual-written for human readability.
  const { loadForegroundGuidance, parseForegroundGuidance, writeForegroundGuidance, recomposeForegroundGuidance } = await import("./foregroundCompose.js")
  const current = await loadForegroundGuidance()
  if (isStaleStorykeeperPatch(patch, current)) {
    return {
      foregroundGuidance: current,
      inboxResolved: [],
      skipped: true,
      reason: "stale_storykeeper_patch",
      currentTurnId: latestGuidanceTurnId(current),
    }
  }
  const guidancePayload = normalizeForegroundGuidanceMarkdown(patch.foregroundGuidanceMarkdown, patch.turnId)
  const legacyPayload = guidancePayload ? "" : renderLegacyForegroundGuidance(patch)
  const foregroundGuidance = guidancePayload || legacyPayload || current
  const wroteForeground = Boolean(guidancePayload || legacyPayload)
  const parsedSections = wroteForeground ? parseForegroundGuidance(foregroundGuidance) : null
  // Warn loudly when the model invented `## ` headings outside the schema
  // — their content WAS preserved (it merged into the previous recognized
  // section's bucket) but the model probably intended it to be its own
  // section. Bus emit so the demo UI / probe artifacts catch it.
  const unknownHeadings = parsedSections?.__unknownHeadings || []
  if (unknownHeadings.length) {
    bus?.publish?.("foreground.unknown-heading", {
      turnId: patch.turnId,
      headings: unknownHeadings,
      source: "storykeeper",
      hint: "Content merged into previous section. Use only the schema headings declared in FG_template.md's header comment.",
    })
  }

  // Pre-compute inbox resolution (no I/O after this point until commit phase)
  const inboxState = await computeBackgroundInboxResolution(patch.inboxResolved, {
    turnId: patch.turnId,
    note: (patch.inboxNotes || []).join("; "),
    rejectedIds: patch.inboxRejected,
  })
  const provenanceText = await computeStorykeeperProvenance(patch, {
    inboxResolved: inboxState.resolvedIds,
    wroteForegroundGuidance: wroteForeground,
  })

  // Commit phase: atomic writes in dependency order. recordSceneEvent in the
  // agent pack's commit/apply step runs AFTER this returns, so a successful return implies
  // all three files are coherent.
  const transactionFiles = storykeeperTransactionFiles({ parsedSections, provenanceText, inboxState })
  const { withStoryTransaction } = await import("../runtime/storyTransaction.js")
  await withStoryTransaction(
    { source: "storykeeper", turnId: patch.turnId, files: transactionFiles },
    async () => {
      if (parsedSections) {
        await writeForegroundGuidance({ sections: parsedSections, turnId: patch.turnId, at: new Date().toISOString() })
      }
      if (provenanceText) await writeAtomic(paths.provenance, provenanceText)
      if (inboxState.committable) {
        await writeAtomic(paths.backgroundInbox, inboxState.nextInboxText)
        await writeAtomic(paths.backgroundInboxArchive, inboxState.nextArchiveText)
      }
    },
  )
  // No envelope-level guidance → the model touched files directly via
  // the edit tool (either a section file under story/frontend/ or the
  // FG_template.md manifest). Either way, just recompose the read-only
  // FOREGROUND.md from the template + includes — template edits are
  // structural (which sections, which order) and section edits are
  // content; both are handled by the same recompose pass.
  if (!parsedSections) {
    try {
      await recomposeForegroundGuidance()
    } catch { /* best-effort */ }
  }
  const filesChanged = patch.filesChanged || []
  const inboxResolvedIds = inboxState.resolvedIds || []
  // Publish a single event summarising what changed on disk this commit so
  // the demo sidebar can show "Storykeeper wrote N files" with line items.
  // This is purely observational — no consumers in the runtime depend on it.
  if (
    filesChanged.length ||
    parsedSections ||
    provenanceText ||
    inboxState.committable
  ) {
    bus.publish("story.files_changed", {
      turnId: patch.turnId || null,
      files: filesChanged,
      foregroundUpdated: Boolean(parsedSections),
      provenanceUpdated: Boolean(provenanceText),
      // Opt-in format-contract feature: signal when the Storykeeper rewrote the
      // rich-render contract so the VM can reload it (see formatContract.js).
      formatUpdated: filesChanged.some((f) => /(^|\/)format\//.test(String(f?.path || f || ""))),
      inboxResolved: inboxResolvedIds.length,
    })
  }
  return {
    foregroundGuidance,
    inboxResolved: inboxResolvedIds,
    inboxRejected: inboxState.rejectedIds || [],
    inboxDeferred: patch.inboxDeferred || [],
    filesChanged,
    provenanceFile: provenanceText ? "story/canon/PROVENANCE.md" : "",
  }
}

function storykeeperTransactionFiles({ parsedSections, provenanceText, inboxState }) {
  const files = []
  if (parsedSections) {
    files.push(paths.foregroundGuidance)
    // Unprefixed section filenames (must match FOREGROUND_SECTIONS in
    // foregroundCompose.js; statically importing it here would cycle).
    for (const filename of [
      "header.md",
      "tone.md",
      "forbidden.md",
      "constants.md",
      "active-characters.md",
      "relationships.md",
      "scene.md",
      "open-threads.md",
      "active-pressures.md",
      "directed-beat.md",
      "pending-consequence.md",
    ]) {
      files.push(`${paths.foregroundDir}/${filename}`)
    }
  }
  if (provenanceText) files.push(paths.provenance)
  if (inboxState?.committable) {
    files.push(paths.backgroundInbox, paths.backgroundInboxArchive)
  }
  return files
}

export async function enqueueBackgroundInbox({ turnId, action, foreground, signal }) {
  await initializeStory()
  const tasks = inboxTasksFromSignal(signal)
  if (!tasks.length) return { added: [], skipped: [] }

  let text = await readText(paths.backgroundInbox, "")
  if (!text.trim()) text = inboxHeader()
  const existing = new Set(parseBackgroundInboxItems(text).map((item) => item.id))
  const added = []
  const skipped = []
  const now = new Date().toISOString()

  for (const [index, task] of tasks.entries()) {
    const id = `inbox_${safeId(turnId || "turn")}_${task.kind || index + 1}`
    if (existing.has(id)) {
      skipped.push(id)
      continue
    }
    added.push(id)
    existing.add(id)
    text = `${text.trimEnd()}\n\n${formatInboxEntry({
      id,
      createdAt: now,
      turnId,
      action,
      foreground,
      signal,
      task,
    })}\n`
  }

  if (added.length) await writeText(paths.backgroundInbox, text)
  return { added, skipped }
}

export async function resolveBackgroundInbox(ids = [], { turnId = "", note = "" } = {}) {
  await initializeStory()
  const state = await computeBackgroundInboxResolution(ids, { turnId, note })
  if (!state.committable) return { resolvedIds: state.resolvedIds }
  await writeAtomic(paths.backgroundInbox, state.nextInboxText)
  await writeAtomic(paths.backgroundInboxArchive, state.nextArchiveText)
  return { resolvedIds: state.resolvedIds }
}

// Pure-compute helper: reads current state, decides what would be resolved,
// and returns the would-be next contents WITHOUT writing anything. Used by
// applyStorykeeperPatch to stage a transactional commit (all writes after all
// computes succeed). Splits the I/O surface into: 2 reads → pure compute →
// 2 atomic writes, instead of the previous read-write-read-write pattern that
// could leave inconsistent state if interrupted between writes.
export async function computeBackgroundInboxResolution(ids = [], { turnId = "", note = "", rejectedIds = [] } = {}) {
  const wanted = new Set(arrayOfStrings(ids))
  const rejectedWanted = new Set(arrayOfStrings(rejectedIds))
  if (!wanted.size && !rejectedWanted.size) return { resolvedIds: [], rejectedIds: [], committable: false }

  const text = await readText(paths.backgroundInbox, "")
  const items = parseBackgroundInboxItems(text)
  const resolveAll = wanted.has("*")
  const rejectedAll = rejectedWanted.has("*")
  const resolved = items.filter((item) => resolveAll || wanted.has(item.id))
  const rejected = items.filter((item) => !resolved.includes(item) && (rejectedAll || rejectedWanted.has(item.id)))
  if (!resolved.length && !rejected.length) return { resolvedIds: [], rejectedIds: [], committable: false }

  const remaining = items.filter((item) => !resolved.includes(item) && !rejected.includes(item))
  const nextInboxText = [inboxHeader().trimEnd(), ...remaining.map((item) => item.block.trim())]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n")

  const archive = await readText(paths.backgroundInboxArchive, inboxArchiveHeader())
  const mergedAt = new Date().toISOString()
  const archiveBlock = [
    `## Merge ${mergedAt}${turnId ? ` ${turnId}` : ""}`,
    "",
    `- Resolved: ${resolved.length ? resolved.map((item) => item.id).join(", ") : "-"}`,
    `- Rejected: ${rejected.length ? rejected.map((item) => item.id).join(", ") : "-"}`,
    note ? `- Note: ${note}` : "",
    "",
    ...resolved.map((item) => `[resolved]\n${item.block.trim()}`),
    ...rejected.map((item) => `[rejected]\n${item.block.trim()}`),
  ]
    .filter(Boolean)
    .join("\n")
  const nextArchiveText = `${archive.trimEnd()}\n\n${archiveBlock}\n`

  return {
    resolvedIds: resolved.map((item) => item.id),
    rejectedIds: rejected.map((item) => item.id),
    committable: true,
    nextInboxText,
    nextArchiveText,
  }
}

export function parseBackgroundInboxItems(text = "") {
  const lines = String(text || "").split(/\r?\n/)
  const items = []
  let current = null

  for (const line of lines) {
    const match = line.match(/^##\s+([A-Za-z0-9_.:-]+)\s*$/)
    if (match) {
      if (current) items.push({ ...current, block: current.lines.join("\n") })
      current = { id: match[1], lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) items.push({ ...current, block: current.lines.join("\n") })
  return items
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

// Minimal placeholder body for a freshly-seeded foreground section file.
// Just the heading + a one-line stub so the init agent's first `read`
// succeeds and it sees what the file is "supposed" to contain.
//
// header gets a richer default (framing notes); directed-beat /
// pending-consequence seed empty (frontmatter only) so they compose to
// nothing until fired — everything else gets a generic stub the agent
// is expected to overwrite.
function defaultSectionBody(section) {
  if (section.id === "pending-consequence" || section.id === "directed-beat") {
    // Seeded empty (frontmatter only, no heading/placeholder) so it composes to
    // NOTHING until a turn populates it. A heading here would inject a dangling
    // "## Pending Consequence" / "## This Turn" into the narrator every turn.
    return ["---", `section: ${section.id}`, "---", ""].join("\n")
  }
  if (section.id === "header") {
    return [
      "---",
      "section: header",
      "---",
      "",
      "This file is a small, replaceable cheatsheet for the fast foreground narrator. Treat it like a near-generation Author's Note or context card, not like the whole memory system.",
      "",
      "- Use scene-specific sensory details only when they help the current action.",
      "- Prefer concrete action beats, causality, and unresolved pressure over explaining the setting.",
      "- Surface playable pressures, available clues, and consequences without steering the reader.",
      "- Avoid total reveals; let secrets surface through action, evidence, and consequence.",
      "",
      "The background Storykeeper rewrites the working sections below. Users may also edit them directly.",
    ].join("\n")
  }
  if (section.id === "relationships") {
    return [
      "---",
      `section: ${section.id}`,
      "---",
      "",
      "## Active Relationships",
      "",
      "Pair-by-pair dynamics between the named characters: who outranks whom, what the history is, what they're hiding from each other, and HOW they address one another (formal title vs. nickname vs. first name, and which switch signals which beat).",
      "",
      "_(placeholder — init agent or storykeeper rewrites this section with one entry per character pair / triangle)_",
    ].join("\n")
  }
  return [
    "---",
    `section: ${section.id}`,
    "---",
    "",
    `## ${section.heading || section.id}`,
    "",
    "_(placeholder — init agent or storykeeper rewrites this section)_",
  ].join("\n")
}

function inboxHeader() {
  return [
    "# Background Inbox",
    "",
    "Pending requests from the fast loop. The background Storykeeper should merge these into FOREGROUND.md, story memory, research notes, or other ordinary files, then mark the handled item ids as resolved.",
    "",
  ].join("\n")
}

function inboxArchiveHeader() {
  return [
    "# Merged Background Inbox",
    "",
    "Resolved background inbox entries. This is an audit trail, not foreground context.",
    "",
  ].join("\n")
}

function inboxTasksFromSignal(signal = {}) {
  if (signal.needsBackground === false) return []
  const tasks = Array.isArray(signal.tasks) ? signal.tasks : []
  const normalized = tasks
    .map((task, index) => ({
      kind: safeInboxKind(task?.kind || index + 1),
      type: stringOrDash(task?.type || "continuity"),
      instruction: String(task?.instruction || "").trim(),
      anchors: arrayOfStrings(task?.anchors),
    }))
    .filter((task) => task.instruction)

  const preserve = arrayOfStrings(signal.preserve)
  if (preserve.length) {
    normalized.push({
      kind: "preserve",
      type: "preserve",
      instruction: "Merge these explicit reader-supplied anchors into foreground guidance or durable story files if they are not already represented.",
      anchors: preserve,
    })
  }
  return normalized
}

function safeInboxKind(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "1"
}

function formatInboxEntry({ id, createdAt, turnId, action, foreground, signal, task }) {
  return [
    `## ${id}`,
    "",
    `- Created: ${createdAt}`,
    `- Turn: ${turnId || "-"}`,
    `- Priority: ${signal?.priority || "soon"}`,
    `- Type: ${task.type || "continuity"}`,
    `- Anchors: ${task.anchors?.length ? task.anchors.join(", ") : "-"}`,
    "",
    "Instruction:",
    task.instruction,
    "",
    "Reader action:",
    String(action || "-").trim(),
    "",
    "Foreground excerpt:",
    truncateForInbox(foreground?.narration || ""),
    "",
    "Reader-facing options:",
    "Omitted intentionally. Unchosen options are UI affordances, not canon.",
  ].join("\n")
}

function truncateForInbox(text, maxChars = 900) {
  const value = String(text || "").trim()
  if (!value) return "-"
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
}

function safeId(value) {
  return String(value || "item").replace(/[^A-Za-z0-9_.:-]+/g, "_")
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : []
}

async function computeStorykeeperProvenance(patch = {}, { inboxResolved = [], wroteForegroundGuidance = false } = {}) {
  const filesChanged = normalizeFilesChanged(patch.filesChanged)
  const fromLegacyPatch = patch.legacyPatchConverted || hasLegacyGuidanceFields(patch)
  if (wroteForegroundGuidance && !filesChanged.some((file) => file.path === "story/guidance/FOREGROUND.md")) {
    filesChanged.unshift({
      path: "story/guidance/FOREGROUND.md",
      purpose: fromLegacyPatch
        ? "updated foreground working set from a legacy structured patch"
        : "updated foreground working set from Storykeeper envelope payload",
      provenance: ["foregroundGuidanceMarkdown", patch.turnId].filter(Boolean),
    })
  }
  if (!filesChanged.length && !inboxResolved.length && !patch.summary && !patch.status && !patch.warnings?.length) {
    return ""
  }

  const current = await readText(paths.provenance, "# Storykeeper Provenance\n\n")
  const at = new Date().toISOString()
  const block = [
    `## ${at}${patch.turnId ? ` ${patch.turnId}` : ""}`,
    "",
    `- Status: ${stringOrDash(patch.status || (filesChanged.length || inboxResolved.length ? "applied" : "skipped"))}`,
    `- Summary: ${stringOrDash(patch.summary)}`,
    `- Source events: ${sourceEvents(patch).join(", ") || "-"}`,
    `- Inbox resolved: ${inboxResolved.length ? inboxResolved.join(", ") : "-"}`,
    patch.transportOnly === false ? "- Note: legacy structured patch was converted to file-native foreground guidance." : "",
    "",
    "Files:",
    ...(filesChanged.length
      ? filesChanged.map((file) => {
          const provenance = file.provenance?.length ? ` provenance=${file.provenance.join(", ")}` : ""
          return `- ${file.path}: ${file.purpose || "updated"}${provenance}`
        })
      : ["-"]),
    patch.inboxNotes?.length ? ["", "Inbox notes:", ...patch.inboxNotes.map((note) => `- ${note}`)] : "",
    patch.warnings?.length ? ["", "Warnings:", ...patch.warnings.map((warning) => `- ${warning}`)] : "",
    patch.needsFollowup?.length ? ["", "Follow-up:", ...patch.needsFollowup.map((item) => `- ${item}`)] : "",
  ]
    .flat()
    .filter(Boolean)
    .join("\n")
  return `${current.trimEnd()}\n\n${block}\n`
}

function normalizeFilesChanged(value = []) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === "string") return { path: normalizeStoryPath(item), purpose: "", provenance: [] }
      if (!item || typeof item !== "object") return null
      return {
        path: normalizeStoryPath(item.path || item.file || item.filePath),
        purpose: compactLine(item.purpose || item.reason || item.summary || "", 240),
        provenance: unique(arrayOfStrings(item.provenance || item.sources || item.sourceEvents)),
      }
    })
    .filter((item) => item?.path)
    .slice(0, 30)
}

function sourceEvents(patch = {}) {
  return unique([
    patch.turnId,
    ...arrayOfStrings(patch.sourceEvents),
    ...normalizeFilesChanged(patch.filesChanged).flatMap((file) => file.provenance || []),
  ])
}

function normalizeStoryPath(value) {
  const text = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!text) return ""
  if (text.startsWith("story/") || text.startsWith("shared/")) return text
  return `story/${text}`
}

function compactLine(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : text
}

function toIsoString(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
}

function renderLegacyForegroundGuidance(patch = {}) {
  return hasLegacyGuidanceFields(patch) ? renderForegroundGuidance(patch) : ""
}

function hasLegacyGuidanceFields(patch = {}) {
  return [
    "currentScene",
    "tone",
    "newFacts",
    "characters",
    "locations",
    "objects",
    "openThreads",
    "forbidden",
    "activeCharacters",
    "characterBriefs",
    "groundingNotes",
    "counterfactualWarnings",
    "continuityWarnings",
    "narrativePatch",
  ].some((key) => {
    const value = patch[key]
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === "object") return Object.keys(value).length > 0
    return typeof value === "string" && value.trim()
  })
}

function renderForegroundGuidance(patch = {}) {
  const characters = objectEntries(patch.characterBriefs).length ? patch.characterBriefs : patch.characters || {}
  return [
    "# Foreground Guidance",
    "",
    "This Markdown file is the small working set for the fast foreground narrator. It is intentionally plain text: editable, grep-able, and replaceable. Treat it like an agent cheatsheet or context card, not a full world model.",
    "",
    "## Priority",
    "",
    "- Canon prose, explicit reader input, and this file are binding for the next turn.",
    "- Prefer concrete action, causality, pressure, and a playable situation over exposition.",
    "- Respect reader agency; do not decide unasked inner thoughts, speech, or irreversible actions.",
    "- If this file conflicts with recent canon, follow recent canon and leave room for the background loop to repair it.",
    "",
    "## Scene",
    "",
    line("Scene", patch.currentScene),
    line("Tone", patch.tone),
    listSection("Active Characters", patch.activeCharacters),
    listSection("Constants", patch.newFacts),
    objectSection("Character Briefs", characters),
    listSection("Grounding Notes", patch.groundingNotes),
    listSection("Open Threads", patch.openThreads),
    listSection("Forbidden / Avoid", patch.forbidden),
    listSection("Counterfactual Warnings", patch.counterfactualWarnings),
    listSection("Continuity Warnings", patch.continuityWarnings),
    patch.narrativePatch ? ["## Narrative Patch", "", patch.narrativePatch.trim()] : "",
    "",
    `Updated Turn: ${stringOrDash(patch.turnId)}`,
    `Updated: ${new Date().toISOString()}`,
  ]
    .flat()
    .filter((line) => line !== null && line !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n")
}

function normalizeForegroundGuidanceMarkdown(value, turnId = "") {
  const text = stripSuggestedNextBeats(String(value || "").trim())
  if (!text) return ""
  const withTitle = text.startsWith("#") ? text : `# Foreground Guidance\n\n${text}`
  const withoutOldMarker = withTitle
    .split(/\r?\n/)
    .filter((line) => !/^Updated Turn:\s*/i.test(line.trim()))
    .join("\n")
    .trimEnd()
  return `${withoutOldMarker}\n\nUpdated Turn: ${stringOrDash(turnId)}\n`
}

function stripSuggestedNextBeats(text) {
  const lines = String(text || "").split(/\r?\n/)
  const out = []
  let dropping = false
  for (const line of lines) {
    if (/^##\s+Suggested Next Beats\s*$/i.test(line.trim())) {
      dropping = true
      continue
    }
    if (dropping && /^##\s+/.test(line.trim())) dropping = false
    if (!dropping) out.push(line)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function isStaleStorykeeperPatch(patch = {}, currentGuidance = "") {
  const incoming = turnOrder(patch.turnId)
  const current = turnOrder(latestGuidanceTurnId(currentGuidance))
  return Boolean(incoming && current && incoming < current)
}

function latestGuidanceTurnId(text = "") {
  const match = String(text || "").match(/^Updated Turn:\s*(turn_[A-Za-z0-9_.:-]+)/im)
  return match?.[1] || ""
}

function turnOrder(turnId = "") {
  const match = String(turnId || "").match(/^turn_(\d+)/)
  return match ? Number(match[1]) : 0
}

function line(label, value) {
  return `- ${label}: ${stringOrDash(value)}`
}

function listSection(title, values = []) {
  const list = unique(Array.isArray(values) ? values : [])
  return [`## ${title}`, "", ...(list.length ? list.map((item) => `- ${item}`) : ["-"])]
}

function objectSection(title, value = {}) {
  const entries = objectEntries(value)
  if (!entries.length) return [`## ${title}`, "", "-"]
  return [
    `## ${title}`,
    "",
    ...entries.map(([name, detail]) => {
      if (typeof detail === "string") return `- ${name}: ${detail}`
      return `- ${name}: ${Object.entries(detail || {})
        .map(([key, val]) => `${key}=${stringOrDash(val)}`)
        .join("; ")}`
    }),
  ]
}

function objectEntries(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []
}

function stringOrDash(value) {
  const text = String(value || "").trim()
  return text || "-"
}

function dynamicPaths() {
  const keys = [
    "home",
    "storiesRoot",
    "globalMemory",
    "globalMemoryTopics",
    "globalContextCards",
    "sharedReferences",
    "sharedReferenceTopics",
    "sharedReferenceIndex",
    "userMemory",
    "userObservedMemory",
    "brief",
    "qualityLog",
    "arcLog",
    "choiceFeedbackLog",
    "playerProfile",
    "storyRoot",
    "storyId",
    "root",
    "canon",
    "packets",
    "profiles",
    "research",
    "guidance",
    "ngramStore",
    "memory",
    "memoryTopics",
    "inbox",
    "contextCards",
    "sharedContextCards",
    "foregroundDir",
    "frontendDir",
    "directorDir",
    "worldkeeperDir",
    "cardsDir",
    "renderDir",
    "formatDir",
    "includesDir",
    "formatContract",
    "formatConfig",
    "formatBlocksDir",
    "sceneLog",
    "chapters",
    "chaptersRecent",
    "turnCountCache",
    "provenance",
    "contextReport",
    "latestForegroundTurn",
    "contextCardStats",
    "latestProfile",
    "researchNotes",
    "searchLog",
    "foregroundGuidance",
    "foregroundTemplate",
    "foregroundContextInserts",
    "cardsManifest",
    "cardsAuto",
    "backgroundInbox",
    "backgroundInboxArchive",
    "memoryIndex",
    "storyMemory",
    "storyPreferences",
    "jobs",
    "jobsLedger",
    "storykeeperLock",
    "watchers",
    "transactions",
    "permissions",
    "permissionsLedger",
    "agents",
    "storykeeperThread",
    "storykeeperQueue",
    "watcherIndex",
    "monitorsFile",
    "loopsFile",
    "watcherLedger",
  ]
  return Object.defineProperties(
    {},
    Object.fromEntries(keys.map((key) => [key, { enumerable: true, get: () => storyPaths()[key] }])),
  )
}
