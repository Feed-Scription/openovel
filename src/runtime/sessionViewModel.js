// SessionViewModel — UI-agnostic orchestration layer over the openovel runtime.
//
// Owns:
//   - the state any interactive surface needs (entries, input, options, status,
//     foreground guidance, compose buffer, jobs, modelInfo)
//   - the actions a surface can invoke (submit, setInput, switchStory, ...)
//   - bus subscriptions for background job lifecycle
//   - the local narration revealer that drives display pacing
//
// Does NOT know about:
//   - the DOM, React, rendering details, or any client's input mechanics
//
// State updates are batched via a microtask trampoline so streaming narration
// (~30 ticks/sec at default CPM) and chatty Storykeeper events collapse into
// one "state" emit per microtask.
//
// The Electron renderer (src/electron/) consumes this VM today, via the
// embedded transport (src/electron/transport/embedded.js) over IPC.
//
// Tests live in test/sessionViewModel.test.js.

import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { backgroundJobs } from "./backgroundJob.js"
import { bus } from "./bus.js"
import { sessionProcessor } from "./sessionProcessor.js"
import { compileForegroundContext } from "../context/contextCompiler.js"
import {
  createStory,
  currentStoryDescriptor,
  describeCurrentStoryWithName,
  listStories,
  PROJECT_LOCAL_ID,
  slugifyStoryName,
  switchActiveStory,
} from "../lib/storyDirectory.js"
import { getReaderTurnCount, getStorySnapshot, initializeStory, paths } from "../lib/storyStore.js"
import { ensureDir, writeText } from "../lib/files.js"
import { loadFormatContract } from "../lib/formatContract.js"
import { classifyInclude, isUnderIncludes } from "../lib/includePaths.js"
import { isTtsActive } from "../lib/ttsConfig.js"
import { createSentenceBuffer } from "../tts/sentenceBuffer.js"
import { storyPaths, workspaceLayout } from "../lib/workspacePaths.js"
import { nextRevealUnit, revealUnitDelayMs, punctuationDelayMs, insideRichFence, richFenceSkipEnd } from "../lib/revealPacing.js"
import { createUsageProfile, persistUsageProfile, runWithUsageProfile } from "../telemetry/usageProfile.js"
import { parseSlashArgs } from "./viewModel/parseSlashArgs.js"
import {
  getPreferenceSnapshot,
  resetPreferenceOnboarding,
} from "../onboarding/preferenceOnboarding.js"
import {
  localeFromLanguagePreference,
  normalizeLanguagePreference,
  onboardingCopy,
  openovelHomeWasEmpty,
  onboardingQuestions,
  resolveOnboardingLocale,
  savePreferenceOnboarding,
  shouldRunPreferenceOnboarding,
} from "../onboarding/preferenceOnboarding.js"
import {
  configDoctorText,
  memoryText,
  providerDoctorText,
  storiesText,
} from "./viewModel/textViews.js"
import { walkStoryTree } from "./viewModel/storyTree.js"
import { loadTranscriptHistory } from "./viewModel/transcriptHistory.js"
import { cloneVmState } from "./viewModel/state.js"
import { optionLabel, toDisplayOption } from "../lib/optionLabel.js"
import { rollbackTransactionText, transactionsText } from "./viewModel/transactionCommands.js"
import { approvePermissionText, denyPermissionText, permissionsText } from "./viewModel/permissionCommands.js"
import { listPermissionRequests, resolvePermissionRequest } from "./permissionService.js"
import { listStoryTransactions, rollbackStoryTransaction } from "./storyTransaction.js"

// ---------- defaults & helpers ----------

const TRUTHY = new Set(["1", "true", "on", "yes"])
const FALSY = new Set(["0", "false", "off", "no"])

// Turn a story title into something safe to use as a filename stem. Keeps
// CJK / accented letters but strips path separators and shell-hostile chars.
// Trims trailing dots/spaces because Windows refuses them.
function sanitizeFilenameBase(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
}

function isOn(value, fallback = true) {
  const v = String(value || "").toLowerCase()
  if (TRUTHY.has(v)) return true
  if (FALSY.has(v)) return false
  return fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// Reveal-pacing primitives (nextRevealUnit / revealUnitDelayMs /
// punctuationDelayMs / insideRichFence) live in the dependency-free
// ../lib/revealPacing.js so the Settings reveal-speed preview shares the exact
// same cadence (incl. punctuation pauses). Re-exported for back-compat with
// existing importers (e.g. test/narrationRevealUnit.test.js).
export { nextRevealUnit, revealUnitDelayMs, insideRichFence }

function makeId(prefix = "e") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
}

// Read FOREGROUND.md (best effort) so #autoTriggerOpening can pick a
// locale-appropriate "begin the story" trigger after init-chat. The init
// agent writes the Prelude in the user's language, so FG.md is a reliable
// signal even when the original user-typed intent is no longer in state.
async function readForegroundForLocaleHint() {
  try {
    return await readFile(paths.foregroundGuidance, "utf8")
  } catch {
    return ""
  }
}

// Frozen empty state used as the initial snapshot.
function defaultPacing(env = process.env) {
  return {
    enabled: isOn(env.OPENOVEL_DISPLAY_PACING, true),
    cpm: (() => {
      const v = Number(env.OPENOVEL_DISPLAY_CPM || env.OPENOVEL_DISPLAY_CHARS_PER_MINUTE)
      return Number.isFinite(v) && v > 0 ? clamp(v, 120, 2400) : 720
    })(),
    // Words/min for Latin/numeric runs (revealed a whole word at a time).
    // English silent reading is ~200-300 wpm; a typewriter reveal feels right
    // a touch slower. Independent of cpm because words and glyphs are
    // different reveal units.
    wpm: (() => {
      const v = Number(env.OPENOVEL_DISPLAY_WPM)
      return Number.isFinite(v) && v > 0 ? clamp(v, 60, 1000) : 240
    })(),
    frameMs: (() => {
      const v = Number(env.OPENOVEL_DISPLAY_FRAME_MS)
      return Number.isFinite(v) && v > 0 ? clamp(v, 16, 500) : 33
    })(),
    punctuation: isOn(env.OPENOVEL_DISPLAY_PUNCTUATION_PAUSES, true),
  }
}

// Activity feed cap. The demo sidebar shows newest-first; older rows scroll
// off. ~80 is enough for ~5–10 turns of mixed foreground + background events
// before things age out, which is the depth the eye can scan.
const ACTIVITY_MAX = 80
// Max agents kept in the side-pane Agents tree (active + recently-finished
// history). Oldest finished entries drop off; the panel scrolls within its cap.
const JOBS_MAX = 40
// Transcript entries kept live in VM state. Every narration-reveal tick clones
// this whole array and IPC-serializes it to the renderer, so the cap directly
// sets the per-tick cost; 80 (~40 turns of scrollback) keeps reveal smooth on
// long stories. Raise via OPENOVEL_VM_ENTRY_MAX for deeper in-window history.
const ENTRY_MAX_DEFAULT = 80
const LIVE_STREAM_COUNTER_FLUSH_MS = 250

function entryMax(env = process.env) {
  const n = Number(env.OPENOVEL_VM_ENTRY_MAX)
  return Number.isFinite(n) && n > 0 ? Math.max(20, Math.floor(n)) : ENTRY_MAX_DEFAULT
}

function trimEntries(entries, maxEntries = ENTRY_MAX_DEFAULT) {
  if (!Array.isArray(entries) || entries.length <= maxEntries) return entries
  return entries.slice(-maxEntries)
}

// Classify provider/network errors so the UI can decide between a friendly
// "check your config" prompt vs. a generic error toast. Keep it pattern-based
// (string match on message) — providers throw plain Error and there's no
// stable error code surface across vendors.
function classifyError(error) {
  const msg = String(error?.message || error || "").toLowerCase()
  if (!msg) return "unknown"
  if (msg.includes("missing provider api key") || msg.includes("api key")) return "missing-key"
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid_api_key")) return "auth"
  if (msg.includes("403") || msg.includes("forbidden")) return "auth"
  if (msg.includes("404") || msg.includes("not found") || msg.includes("model not found")) return "model"
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) return "rate"
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("aborted")) return "timeout"
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network") || msg.includes("fetch failed")) return "network"
  return "unknown"
}
function formatNarratorError(error) {
  const kind = classifyError(error)
  const detail = error?.message || String(error)
  const headerByKind = {
    "missing-key": "Connection failed — no API key configured.",
    "auth":        "Connection failed — API key rejected (401/403).",
    "model":       "Connection failed — model not found at this endpoint.",
    "rate":        "Connection failed — provider rate-limited or quota exhausted.",
    "timeout":     "Connection failed — request timed out.",
    "network":     "Connection failed — network unreachable.",
    "unknown":     "Connection failed.",
  }
  const header = headerByKind[kind] || headerByKind.unknown
  return `${header} Check Settings → API Keys (network, key, model name).\n\nDetails: ${detail}`
}

// ── humanize helpers for the activity feed ─────────────────────────────
function humanizeSource(jobType) {
  if (!jobType) return "Background"
  const t = String(jobType).toLowerCase()
  if (t === "storykeeper") return "Storykeeper"
  if (t === "memory-review" || t === "memory_review" || t === "memory") return "Memory"
  if (t === "signal" || t === "background.signal") return "Signal"
  if (t === "initializer" || t === "story-initializer") return "Initializer"
  if (t.startsWith("subagent")) {
    const sub = t.split(/[.:-]/).filter(Boolean).slice(-1)[0]
    return sub ? `Subagent · ${sub}` : "Subagent"
  }
  return jobType
}

function humanizeJobStart(job) {
  const title = job.title || job.metadata?.title
  if (title) return truncate(title, 80)
  return "starting…"
}

function humanizeJobDone(job) {
  const title = job.title || job.metadata?.title
  return title ? `done · ${truncate(title, 60)}` : "done"
}

function humanizeToolCall(name) {
  if (!name) return "tool"
  return name
}

// Flatten the init-chat transcript into model conversation turns so a REVISION
// run carries the full dialogue (original brief, prior draft summaries, earlier
// revisions) instead of just the latest sentence — otherwise the init agent
// behaves like it has amnesia on every revision. Keeps the reader's words and
// the agent's reports; drops UI-only rows (greeting, tool calls, ask-user echoes).
export function initConversationHistory(messages = []) {
  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = String(m?.text || "").trim()
    if (!text) continue
    if (m.role === "user" || m.role === "user-answer") out.push({ role: "user", content: text })
    else if (m.role === "summary" || m.role === "agent") out.push({ role: "assistant", content: text })
  }
  return out
}

function shortenPath(p) {
  if (!p) return ""
  // strip "story/" prefix for compactness; it's the same root for every demo line
  return String(p).replace(/^story\//, "")
}

// Compact label for a multi-file write: name the first couple of basenames,
// then "+N" for the rest. e.g. ["a/MEMORY.md","b/scene.md","c/x.md"] →
// "MEMORY.md, scene.md +1". The full list lives in meta.files for the tooltip.
function summarizeFileList(paths, shown = 2) {
  const names = paths.map((p) => String(p).split("/").pop())
  if (names.length <= shown) return names.join(", ")
  return `${names.slice(0, shown).join(", ")} +${names.length - shown}`
}

function shortenTurnId(id) {
  if (!id) return ""
  const s = String(id)
  // turn ids look like "turn_2026-05-26T13-42-01_a1b2" — show the short tail
  const tail = s.split(/[._-]/).pop()
  return tail.length <= 8 ? tail : tail.slice(0, 8)
}

export function matchesInitUsageEvent(initChat, props = {}) {
  if (!initChat?.running) return false
  const activeTurn = String(initChat.usageTurnId || initChat.runId || "").trim()
  const eventTurn = String(props.turnId || "").trim()
  if (activeTurn && eventTurn) return eventTurn === activeTurn
  if (String(props.kind || "") === "story-init") return true
  const workflow = String(props.workflow || "").trim()
  return workflow === "story-init" || workflow.startsWith("story-init-")
}

export function modelUsageTotalTokens(usage = {}) {
  const total = Number(usage.totalTokens || 0)
  if (Number.isFinite(total) && total > 0) return total
  const input = Number(usage.inputTokens || 0)
  const output = Number(usage.outputTokens || 0)
  const reasoning = Number(usage.reasoningTokens || 0)
  return (Number.isFinite(input) ? input : 0)
    + (Number.isFinite(output) ? output : 0)
    + (!output && Number.isFinite(reasoning) ? reasoning : 0)
}

export function eventCostUsd(cost) {
  if (cost == null) return 0
  if (typeof cost === "object") {
    const value = Number(cost.estimatedUSD ?? cost.estimatedCostUSD ?? cost.usd ?? 0)
    return Number.isFinite(value) ? value : 0
  }
  const value = Number(cost)
  return Number.isFinite(value) ? value : 0
}

export function storySelectorVisibleStories(stories = [], env = process.env) {
  const showProjectLocal = isOn(env.OPENOVEL_SHOW_PROJECT_STORY || env.OPENOVEL_SHOW_PROJECT_LOCAL_STORY, false)
  return (Array.isArray(stories) ? stories : []).filter((story) => {
    if (!story?.isProjectLocal) return true
    return showProjectLocal && story.chapterBytes > 0
  })
}

// truncate(text, width) lives near the bottom of this file alongside the
// other display helpers; humanize functions above reference it.

// ── Story-library search + sort ───────────────────────────────────────────
// The selector keeps the full story list (allStories) plus the active query +
// sort; the rendered `items` are derived from them so keyboard navigation and
// click/Enter all operate on the same filtered, sorted order.
const STORY_SORTS = ["recent", "name", "size"]
function normalizeStorySort(value) {
  return STORY_SORTS.includes(value) ? value : "recent"
}
function storyTouchedMs(s) {
  const t = Date.parse(s?.lastTouched || "")
  return Number.isFinite(t) ? t : 0
}
function sortStorySelectorStories(stories, sortBy) {
  const arr = stories.slice()
  if (sortBy === "name") {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
    arr.sort((a, b) => collator.compare(String(a.displayName || a.id || ""), String(b.displayName || b.id || "")))
  } else if (sortBy === "size") {
    arr.sort((a, b) => (Number(b.chapterBytes) || 0) - (Number(a.chapterBytes) || 0))
  } else {
    arr.sort((a, b) => storyTouchedMs(b) - storyTouchedMs(a))
  }
  return arr
}
// Build the rendered item list: the New + Import cards always lead, followed by
// the filtered + sorted story cards.
function buildStorySelectorItems(stories, query, sortBy) {
  const q = String(query || "").trim().toLowerCase()
  let list = stories
  if (q) {
    list = list.filter((s) => String(s.displayName || s.id || "").toLowerCase().includes(q))
  }
  list = sortStorySelectorStories(list, normalizeStorySort(sortBy))
  return [
    { id: "(new)", isNew: true, label: "+ New story…" },
    { id: "(import)", isImport: true, label: "Import…" },
    ...list,
  ]
}

function initialState(env = process.env) {
  return {
    // "idle" | "busy" | "composing-worldbook" | "onboarding"
    //   | "story-selector" | "story-naming" | "init-chat" | "error"
    mode: "idle",
    // True until start() resolves the first real screen. The renderer holds on
    // the boot splash while this is set, so it never flashes the default `idle`
    // reading view during start()'s async work (homeWasEmpty, initializeStory,
    // the onboarding/selector decision). Cleared atomically with the first
    // real mode by #enterOnboarding / #enterStorySelector / #hydrateActiveStory.
    booting: true,
    entries: [],
    input: "",
    compose: null,
    onboarding: null,
    storySelector: null, // { items: [...], cursor: number }
    storyNaming: null,   // { error?: string }
    // Conversational story-init flow. After the user names a new story we
    // drop into this mode: a chat-like surface where the user states what
    // kind of story they want, an agent uses file tools to draft canon /
    // characters / context-cards, and may call ask_user mid-run to clarify.
    // Shape:
    //   storyName       — slug of the new story we're initializing
    //   messages        — ordered visible items: greeting/user/agent/
    //                     tool-call/ask-user/summary
    //   input           — draft text in the intent box (cleared on submit)
    //   pendingAskUser  — { id, question, header?, options? } when the agent is waiting on
    //                     ask_user; null otherwise
    //   running         — agent currently working
    //   completed       — agent finished; show "Enter interactive mode?"
    initChat: null,
    options: [],
    // Framing line for a KEY decision point (rendered as a question above the
    // options); "" on normal turns (flat suggested-action list).
    decisionFraming: "",
    optionsEnabled: isOn(env.OPENOVEL_OPTIONS_ENABLED, true),
    foregroundGuidance: "",
    // Opt-in rich-render contract (lib/formatContract.js). null when the
    // feature flag is off or no contract exists — renderer treats null as
    // "plain rendering". Only the sanitized, renderer-safe shape lives here.
    formatContract: null,
    // Comic mode (experimental): per-panel image generation status, keyed by
    // the panel's story/includes/comic/... rel path → "pending"|"ready"|
    // "failed". ComicStrip swaps placeholders on it; cleared on story switch.
    comicPanels: {},
    // Same statuses keyed by panel INDEX for the turn currently streaming:
    // the entry text carries no image paths until the runtime injects them at
    // completion, so index is the only key the renderer can match mid-stream.
    // Reset on every reader action (a new turn is a new index space).
    comicPanelsLive: {},
    // Surface forms (names + aliases) of CHARACTER context cards, longest
    // first — the renderer tints these in narration. Refreshed on story
    // hydrate and whenever the background loop writes a context card.
    characterNames: [],
    inboxCount: 0,
    // Authoritative completed-foreground-turn count (counts foreground_turn
    // events via storyStore's cache — NOT visible `user` entries, which are
    // trim-windowed and include slash-command echoes). The footer shows this
    // plus 1 while a turn is in flight (busy) as the "current turn" ordinal.
    turnCount: 0,
    status: "idle",
    busy: false,
    currentStory: currentStoryDescriptor({ env }),
    pacing: defaultPacing(env),
    jobs: [],
    activeTools: [],
    storyTree: [],
    // Rels of directories the user has expanded. The tree itself is loaded
    // incrementally: a fresh refresh walks only the root level + each rel in
    // this set. Click-to-collapse strips the rel and all descendants.
    storyTreeExpanded: [],
    // Demo sidebar surfaces — derived state, not source of truth.
    activity: [],            // newest-first ring buffer of humanized events
    aggregate: {             // session-wide counters that tick up live
      jobs: 0,
      toolCalls: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      charactersStreamed: 0, // live during foreground narrator stream
      filesWritten: 0,
    },
    liveStream: null,        // { source, chars, startedAt } while streaming
    // Last narrator failure — surfaces a banner with "check Settings" prompt.
    // Cleared on next successful turn. Schema: { kind, message, at } or null.
    lastError: null,
  }
}

// ── active-agent tree helpers ──────────────────────────────────────────────
// Map a background job to the agent it runs + a display label, so the side pane
// can show "which agent is active" (L1) and group its in-flight tool calls (L2).
const AGENT_LABELS = {
  showrunner: "Showrunner",
  worldkeeper: "World Keeper",
  director: "Director",
  cards: "Card Manager",
  memory: "Memory",
  "memory-review": "Memory",
  render: "Render Manager",
  storykeeper: "Storykeeper",
  "background-signal": "Signal",
  signal: "Signal",
  diversify: "Diversify",
  dramatist: "Dramatist",
}

// The agent id MUST match the tool calls' context.agent (= the agent pack id) so
// the tree can group an agent's tools under it. resident:<id> jobs carry
// metadata.agent; others fall back to their job type, which equals the pack id
// (memory-review, diversify) — so do NOT remap those.
export function resolveJobAgentId(job = {}) {
  if (job.metadata?.agent) return String(job.metadata.agent)
  const type = String(job.type || "")
  if (type.startsWith("resident:")) return type.slice("resident:".length)
  return type || "agent"
}

export function agentLabelFor(id) {
  const key = String(id || "")
  return AGENT_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Agent")
}

// A job that belongs to a story the reader has since switched away from. Such
// jobs run detached, pinned to their origin story root (storyContext.js), and
// their lifecycle events must not drive THIS story's status line, jobs panel,
// or snapshot refreshes. `activeRoot` must be the SESSION's story root (the VM
// passes state.currentStory.root, captured in unpinned action contexts) — NOT
// paths.root: bus.publish dispatches synchronously, so these handlers run in
// the PUBLISHER's async context, and a pinned job's completion would resolve
// paths.root back to its own (foreign) story and defeat the check. With no
// active story (library view), every story-pinned job is foreign. Jobs without
// a storyRoot (older shape) count as local.
export function isForeignStoryJob(job = {}, activeRoot = "") {
  return Boolean(job.storyRoot && job.storyRoot !== activeRoot)
}

// ---------- ViewModel ----------

export class SessionViewModel extends EventEmitter {
  #state
  #emitScheduled = false
  #unsubscribe = []
  #started = false
  #shuttingDown = false
  #env
  // jobId → activityId, so background.job.completed can mark the right row
  // done without scanning the whole activity list. Bounded by #wireBus
  // cleaning up entries on completion.
  // In-flight foreground reader turn (the sessionProcessor.processReaderAction
  // promise). Tracked so a story switch can wait for its canon writes
  // (scene_log / chapters.md) to land on the CURRENT story before repointing
  // the env — it's not a registered background job, so the job drain misses it.
  #activeReaderTurn = null
  #jobActivityIds = new Map()
  // toolCall id → activityId. Same idea for tool.call.completed.
  #toolActivityIds = new Map()
  #entryMax
  // Init-replay (demo playback) — a token bumped on every start/cancel so a
  // running #runInitReplay loop stops when superseded; #replaySpeed is the
  // current cadence multiplier.
  #replayToken = 0
  #replaySpeed = 1
  // Banked promise of the post-switch unfinished-init restore (set by
  // switchToStory); resumeStoryInit awaits it instead of racing a second one.
  #pendingInitRestore = null

  constructor({ env = process.env } = {}) {
    super()
    this.#env = env
    this.#entryMax = entryMax(env)
    this.#state = initialState(env)
  }

  // ---- snapshot accessors ----

  getState() {
    return cloneVmState(this.#state)
  }

  // Sugar over .on("state", listener). Always invokes listener with the current
  // snapshot once so subscribers can initialize their view eagerly.
  subscribe(listener) {
    const handler = (snapshot) => listener(snapshot)
    this.on("state", handler)
    listener(this.getState())
    return () => this.off("state", handler)
  }

  // ---- state mutation (private) ----

  #patch(patch) {
    this.#state = { ...this.#state, ...patch }
    this.#scheduleEmit()
  }

  #scheduleEmit() {
    if (this.#emitScheduled) return
    this.#emitScheduled = true
    queueMicrotask(() => {
      this.#emitScheduled = false
      this.emit("state", this.getState())
    })
  }

  #pushEntry(entry) {
    const next = trimEntries(
      [...this.#state.entries, { id: makeId("entry"), complete: true, ...entry }],
      this.#entryMax,
    )
    this.#patch({ entries: next })
    return next[next.length - 1]
  }

  // ---- activity feed ----
  // Newest-first ring buffer of humanized events that the demo sidebar shows.
  // Each entry is { id, at, source, label, status, meta? } where status is
  // "running" | "done" | "error" | "info".
  #pushActivity(entry) {
    const item = {
      id: makeId("act"),
      at: Date.now(),
      status: "info",
      ...entry,
    }
    const next = [item, ...this.#state.activity].slice(0, ACTIVITY_MAX)
    this.#patch({ activity: next })
    return item.id
  }

  #updateActivity(id, patch) {
    if (!id) return
    let touched = false
    const next = this.#state.activity.map((a) => {
      if (a.id !== id) return a
      touched = true
      return { ...a, ...patch, updatedAt: Date.now(), meta: { ...(a.meta || {}), ...(patch.meta || {}) } }
    })
    if (touched) this.#patch({ activity: next })
  }

  // Comic mode: mirror one panel lifecycle event into state — keyed by rel
  // path (durable; matches the path-injected completed text) AND by panel
  // index (the live turn's only matchable key while the text is still
  // streaming). A "failed"/"pending" never downgrades a "ready" (a late
  // duplicate event must not blank an already-shown image).
  // True when the bus event being handled was published from a DIFFERENT
  // story than the one this session displays. bus.publish dispatches
  // synchronously, so paths.root read here (pin-aware) resolves the
  // PUBLISHER's story root: every background job runs pinned to its origin
  // story (storyContext.js), and a previous story's detached job keeps
  // publishing under that pin after the reader switches away. Its events must
  // not patch the new story's content state (format contract, comic panels,
  // story tree, tool tree). Call synchronously at handler entry, before any
  // await. In the library view (no current story) every story-context event
  // counts as foreign.
  #isForeignStoryEvent() {
    return paths.root !== (this.#state.currentStory?.root || "")
  }

  #patchComicPanel(event, status) {
    if (this.#isForeignStoryEvent()) return
    const rel = String(event?.properties?.rel || "")
    const index = event?.properties?.index
    const patch = {}
    if (rel) {
      const prev = this.#state.comicPanels || {}
      if (!(prev[rel] === "ready" && status !== "ready")) patch.comicPanels = { ...prev, [rel]: status }
    }
    if (Number.isInteger(index) && index >= 0) {
      const prev = this.#state.comicPanelsLive || {}
      if (!(prev[index] === "ready" && status !== "ready")) patch.comicPanelsLive = { ...prev, [index]: status }
    }
    if (Object.keys(patch).length) this.#patch(patch)
  }

  #bumpAggregate(delta) {
    const cur = this.#state.aggregate
    this.#patch({
      aggregate: {
        jobs:               cur.jobs               + (delta.jobs               || 0),
        toolCalls:          cur.toolCalls          + (delta.toolCalls          || 0),
        modelCalls:         cur.modelCalls         + (delta.modelCalls         || 0),
        inputTokens:        cur.inputTokens        + (delta.inputTokens        || 0),
        outputTokens:       cur.outputTokens       + (delta.outputTokens       || 0),
        costUsd:            cur.costUsd            + (delta.costUsd            || 0),
        charactersStreamed: cur.charactersStreamed + (delta.charactersStreamed || 0),
        filesWritten:       cur.filesWritten       + (delta.filesWritten       || 0),
      },
    })
  }

  #replaceLastEntry(updater) {
    const entries = this.#state.entries
    if (!entries.length) return
    const last = entries[entries.length - 1]
    const updated = { ...last, ...updater }
    const next = trimEntries([...entries.slice(0, -1), updated], this.#entryMax)
    this.#patch({ entries: next })
  }

  #setStatus(status) {
    this.#patch({ status })
    this.emit("status", status)
  }

  // ---- lifecycle ----

  async start({ runOnboarding = true, skipStorySelector = false } = {}) {
    if (this.#started) return
    this.#started = true
    const t0 = Date.now()
    const log = (stage) => process.stderr.write(`[vm.start +${Date.now() - t0}ms] ${stage}\n`)
    log("begin")
    const homeWasEmpty = await openovelHomeWasEmpty()
    log("openovelHomeWasEmpty")
    await initializeStory()
    log("initializeStory")
    await backgroundJobs.bindLedger({ path: paths.jobsLedger })
    log("bindLedger")
    this.#wireBus()
    log("wireBus")

    if (runOnboarding && await shouldRunPreferenceOnboarding({ homeWasEmpty })) {
      log("→ onboarding")
      await this.#enterOnboarding({ homeWasEmpty })
      return
    }

    if (skipStorySelector) {
      log("→ hydrate (forced)")
      await this.#hydrateActiveStory()
      log("hydrate done")
      return
    }
    if (isOn(this.#env.OPENOVEL_SKIP_STORY_SELECTOR, false)) {
      log("→ hydrate (env skip)")
      await this.#hydrateActiveStory()
      log("hydrate done")
      return
    }
    log("→ enter story selector")
    await this.#enterStorySelector()
    log("selector ready")
  }

  // Populate state.entries / options / inboxCount etc. for the currently
  // active story, and kick storykeeper if it has pending inbox work. Used
  // after the user picks a story in the selector, or when the selector is
  // disabled.
  async #hydrateActiveStory() {
    const history = await loadTranscriptHistory(paths.sceneLog, { maxTurns: 30 }).catch(
      () => ({ entries: [], lastOptions: [] }),
    )
    const snapshot = await getStorySnapshot()
    const inboxItems = snapshot.backgroundInboxItems?.length || 0
    const formatContract = await loadFormatContract().catch(() => ({ enabled: false }))
    const turnCount = await getReaderTurnCount().catch(() => 0)
    this.#patch({
      mode: "idle",
      booting: false,
      foregroundGuidance: snapshot.foregroundGuidance || "",
      formatContract: formatContract.enabled ? formatContract : null,
      // Replayed comic panels resolve their images straight from disk via
      // ovl-asset:// (ComicStrip's no-status path), so the live event map
      // starts empty for every (re)entered story.
      comicPanels: {},
      comicPanelsLive: {},
      // Agents panel + live tool tree start clean for the (re)entered story;
      // a previous story's detached jobs report only to their own story (see
      // isForeignStoryJob / #isForeignStoryEvent in the bus handlers).
      jobs: [],
      activeTools: [],
      inboxCount: inboxItems,
      turnCount,
      currentStory: await describeCurrentStoryWithName({ env: this.#env }),
      entries: trimEntries(history.entries, this.#entryMax),
      options: this.#state.optionsEnabled ? history.lastOptions.map(toDisplayOption) : [],
      decisionFraming: this.#state.optionsEnabled ? (history.lastFraming || "") : "",
      status: history.entries.length ? "resumed · ready" : "idle",
    })
    this.#refreshStoryTree()
    this.#refreshCharacterNames()
    if (inboxItems > 0) {
      // F2b: spawn a proper storykeeper drain via backgroundJobs.start so it
      // shows up in the ledger + telemetry, and uses acquireWithHeal so a
      // stale flag from a prior session's killed batch doesn't block it.
      this.#setStatus(`resuming background work (${inboxItems} pending)…`)
      sessionProcessor.kickstartStorykeeperIfPending().catch(() => {})
    }
    // Resident-team resume: the kickstart above only covers the Showrunner
    // (via story/inbox/INBOX.md). Sub-agents have their OWN inbox queues and
    // may have been mid-run when the previous session left — re-wake those.
    this.#resumeResidentAgents().catch(() => {})
  }

  // Wake sub-agents that the previous session left with unfinished work:
  // pending per-agent inbox messages, plus agents recorded mid-run by the
  // exit snapshot whose jobs never reached a terminal ledger event. Their
  // durable files (notebook/thread/inbox) carry the actual state — a fresh
  // wake continues from exactly what's on disk.
  async #resumeResidentAgents() {
    const { isResidentTeamEnabled, resumeResidentAgents } = await import("./residentTeam.js")
    if (!isResidentTeamEnabled(this.#env)) return
    const { consumeAgentResumeSnapshot, interruptedAgentsFromLedger } = await import("./agentResume.js")
    const snapshot = await consumeAgentResumeSnapshot()
    let interrupted = []
    if (snapshot) {
      const ledger = await backgroundJobs.readLedger().catch(() => [])
      interrupted = interruptedAgentsFromLedger(snapshot, ledger)
    }
    const { woken } = await resumeResidentAgents({ interruptedAgents: interrupted })
    if (woken.length) {
      this.#setStatus(`resumed ${woken.length} background agent${woken.length === 1 ? "" : "s"} (${woken.join(", ")})`)
    }
  }

  // Reload the rich-render format contract from disk and patch it into state.
  // Called when the background loop rewrites story/format/* (the renderer then
  // re-themes without a restart). No-op shape when the flag is off.
  async #refreshFormatContract() {
    const fc = await loadFormatContract().catch(() => ({ enabled: false }))
    this.#patch({ formatContract: fc.enabled ? fc : null })
  }

  // Rebuild the character-name highlight list from the context cards on disk.
  // Called on story hydrate and whenever a background write touches a card, so
  // a newly-introduced character starts tinting without a restart.
  async #refreshCharacterNames() {
    try {
      const { discoverContextCards, extractCharacterHighlightNames } = await import("../context/foregroundInserts.js")
      const cards = await discoverContextCards()
      this.#patch({ characterNames: extractCharacterHighlightNames(cards) })
    } catch {
      /* a failed scan keeps the previous list; highlighting is cosmetic */
    }
  }

  // ---- story selector ----

  // Public: leave the current story and return to the library / splash view.
  // Used by the header home-button. Going home means "I'm done reading this
  // book for now" — so we genuinely put the book down (see
  // #enterStorySelector for what that entails). The story's files on disk
  // are untouched; when the user re-picks it from the grid, switchToStory()
  // re-initializes and the storykeeper inbox / scene log pick up where they
  // left off.
  async goToLibrary() {
    return this.#enterStorySelector()
  }

  async #enterStorySelector() {
    // Put the current book down: stop in-flight background work for this
    // session, clear the in-memory transcript and guidance buffers, and
    // forget the current story descriptor. The env var (OPENOVEL_STORY_ID)
    // is left pointing at the previous story so the next switchToStory()
    // call still routes through the normal "leave-and-re-init" path. We
    // call this on both the home-button return AND on bootstrap so the
    // library page is always shown without a residual current-story label.
    // Drain BEFORE reset(): reset() clears the registry, which would otherwise
    // hide a still-running job from the next switch's drainer, letting it write
    // into whatever story is active when it finishes.
    await this.#drainBeforeSwitch()
    backgroundJobs.reset()
    sessionProcessor.reset()
    this.#patch({
      foregroundGuidance: "",
      formatContract: null,
      comicPanels: {},
      comicPanelsLive: {},
      characterNames: [],
      inboxCount: 0,
      turnCount: 0,
      entries: [],
      options: [],
      decisionFraming: "",
      currentStory: null,
      busy: false,
      lastError: null,
      // The Agents panel is per-story: rows for the story being left would
      // otherwise linger (its detached jobs no longer report here — their
      // completion events are filtered as foreign-story). Same for the live
      // tool tree: the leaving story's in-flight tool rows would be stuck
      // "running" since their completion events are now foreign-filtered.
      jobs: [],
      activeTools: [],
    })

    const stories = await listStories({ env: this.#env }).catch(() => [])
    // Hide the project-local ./story sentinel from the Electron library by
    // default. In dev workspaces it often contains eval fixtures or accidental
    // failed-turn scratch canon, not a user-created library story. CLI users can
    // still switch to "(project)", and OPENOVEL_SHOW_PROJECT_STORY=1 restores the
    // card when someone explicitly wants legacy project-local stories visible.
    const filtered = storySelectorVisibleStories(stories, this.#env)
    // Flag whether each story has an auto-saved initial snapshot on disk, so
    // the UI can disable "Export initial version" for stories that never got
    // one (imported stories, project-local, pre-feature stories).
    const { initialSnapshotPath, listVersions } = await import("../lib/storySnapshot.js")
    const { existsSync } = await import("node:fs")
    const { loadInitTranscript, isUnfinishedInitTranscript } = await import("./initReplay.js")
    const storyItems = await Promise.all(filtered.map(async (s) => ({
      ...s,
      hasInitialSnapshot: existsSync(initialSnapshotPath(s.id, this.#env)),
      // Count of banked versions (snapshots saved on restart / version switch),
      // so the card can show "N 个存档" and gate the history menu.
      versionCount: (await listVersions(s.id, this.#env)).length,
      // Newest init transcript never reached "complete" → the card menu offers
      // "Continue initialization" (resumeStoryInit). requireMessages:false so a
      // record whose conversation was lost still counts as unfinished.
      initUnfinished: isUnfinishedInitTranscript(
        await loadInitTranscript(`${s.root}/agents`, { requireMessages: false }).catch(() => null),
      ),
    })))
    // Preserve the active search + sort across refreshes (rename/delete re-enter
    // here), so the user's filter doesn't reset under them.
    const prior = this.#state.storySelector
    const query = prior?.query || ""
    const sortBy = normalizeStorySort(prior?.sortBy)
    const items = buildStorySelectorItems(storyItems, query, sortBy)
    // Comic / fast mode (experimental): the per-story menu entries only render
    // when their global gates are on. Resolved here (not in the renderer) so
    // all clients inherit the same gating from the VM state.
    const { isComicModeEnabled, isFastModeEnabled } = await import("../lib/formatContract.js")
    this.#patch({
      mode: "story-selector",
      booting: false,
      status: "select a story to resume or create a new one",
      storySelector: {
        items,
        cursor: 0,
        allStories: storyItems,
        query,
        sortBy,
        comicModeAvailable: isComicModeEnabled(this.#env),
        fastModeAvailable: isFastModeEnabled(this.#env),
      },
    })
  }

  // Library search: filter the story cards by name (the New/Import cards always
  // stay). Re-derives items + clamps the cursor so keyboard nav stays valid.
  setStorySearch(query) {
    const sel = this.#state.storySelector
    if (!sel) return
    const q = String(query || "")
    const items = buildStorySelectorItems(sel.allStories || [], q, sel.sortBy)
    this.#patch({
      storySelector: {
        ...sel,
        items,
        query: q,
        cursor: Math.min(Math.max(0, sel.cursor || 0), Math.max(0, items.length - 1)),
      },
    })
  }

  // Library sort: "recent" (default) | "name" | "size".
  setStorySort(sortBy) {
    const sel = this.#state.storySelector
    if (!sel) return
    const next = normalizeStorySort(sortBy)
    const items = buildStorySelectorItems(sel.allStories || [], sel.query, next)
    this.#patch({
      storySelector: {
        ...sel,
        items,
        sortBy: next,
        cursor: Math.min(Math.max(0, sel.cursor || 0), Math.max(0, items.length - 1)),
      },
    })
  }

  moveStorySelector(delta) {
    const sel = this.#state.storySelector
    if (!sel) return
    const n = sel.items.length
    if (!n) return
    const cursor = ((sel.cursor + delta) % n + n) % n
    this.#patch({ storySelector: { ...sel, cursor } })
  }

  async confirmStorySelection() {
    const sel = this.#state.storySelector
    if (!sel) return
    const item = sel.items[sel.cursor]
    if (!item) return
    if (item.isNew) {
      this.#patch({
        mode: "story-naming",
        storyNaming: { error: "" },
        storySelector: null,
        input: "",
        status: "name your new story",
      })
      return
    }
    // Existing story (including the project-local sentinel).
    await this.switchToStory(item.id)
    this.#patch({ storySelector: null })
  }

  // Switch by explicit id, without going through the cursor-driven selector.
  // The Electron stories modal calls this directly when a row is clicked.
  // Safe to invoke from any mode — the VM has the same idempotent
  // reset+re-init sequence used by the selector path.
  async switchToStory(id) {
    try {
      // Let the current story's background jobs finish before repointing the
      // env — otherwise an in-flight Storykeeper write corrupts the new story.
      await this.#drainBeforeSwitch()
      switchActiveStory({ id, env: this.#env })
      backgroundJobs.reset()
      sessionProcessor.reset()
      await initializeStory()
      await backgroundJobs.bindLedger({ path: paths.jobsLedger })
      await this.#hydrateActiveStory()
      // An init that the previous session never finished (app closed/crashed
      // mid-run, or cancelled/failed) takes priority over auto-opening:
      // restore the init-chat from its transcript (auto-continuing only the
      // interrupted case). Otherwise: a freshly imported /
      // initialized-but-never-read story has a full scaffold (FOREGROUND.md +
      // cards) but an empty scene_log, so hydrate leaves the reader on a
      // blank pane — compose the opening the same way a fresh init does.
      // Fire-and-forget: the switch returns immediately so the library/modal
      // closes; the prose then streams into the visible view. The promise is
      // banked so the explicit menu action (resumeStoryInit) can await the
      // same restore instead of racing a second one.
      this.#pendingInitRestore = this.#maybeResumeInterruptedInit()
        .then((resumed) => {
          if (!resumed) this.#autoOpenIfFresh().catch(() => {})
          return resumed
        })
        .catch(() => false)
      return { ok: true, id }
    } catch (error) {
      this.#pushEntry({ type: "error", text: `Failed to switch story: ${error.message || error}` })
      this.#patch({ mode: "idle", status: "error" })
      return { ok: false, error: error.message || String(error) }
    }
  }

  // ---- structured GUI actions (Electron modals) ----
  // These wrap the same primitives the slash commands use, but return
  // structured results so the modal can update its own state without
  // parsing the entries pushed by the text path.

  async listPermissions({ status = "pending", limit = 50 } = {}) {
    return listPermissionRequests({ status, limit, ledgerPath: this.#permissionLedgerPath() })
  }

  async approvePermission(requestId) {
    return resolvePermissionRequest(requestId, "approved", "", { ledgerPath: this.#permissionLedgerPath() })
  }

  async denyPermission(requestId, reason = "") {
    return resolvePermissionRequest(requestId, "denied", reason, { ledgerPath: this.#permissionLedgerPath() })
  }

  async listTransactions({ limit = 30 } = {}) {
    return listStoryTransactions({ limit })
  }

  async rollbackTransaction(txId) {
    return rollbackStoryTransaction(txId)
  }

  // ---- story naming (used after picking "+ New story…") ----

  async confirmStoryName({ preferences } = {}) {
    const raw = this.#state.input
    if (!String(raw || "").trim()) {
      this.#patch({ storyNaming: { error: "Name cannot be empty." } })
      return
    }
    try {
      // Drain the previous story's background jobs before switching — an
      // in-flight write must not land in the freshly-created story's dir.
      await this.#drainBeforeSwitch()
      const created = await createStory({ name: raw, env: this.#env })
      switchActiveStory({ id: created.id, env: this.#env })
      backgroundJobs.reset()
      sessionProcessor.reset()
      await initializeStory()
      // Per-story preference override (set on the naming screen). Written AFTER
      // switchActiveStory so `paths` resolves to the new story, and BEFORE the
      // init workflow runs (later, in init-chat) so its getMemorySnapshot()
      // already sees these prefs. Empty/absent → falls back to global USER.md.
      if (typeof preferences === "string" && preferences.trim()) {
        await ensureDir(paths.memory)
        await writeText(paths.storyPreferences, preferences)
      }
      await backgroundJobs.bindLedger({ path: paths.jobsLedger })
      // Enter the conversational init flow. A background agent will later
      // (M2) take the user's intent + ask_user clarifications and draft
      // canon / characters / context-cards into this story dir.
      const shownName = created.displayName || created.id
      this.#patch({
        mode: "init-chat",
        initChat: {
          storyName: shownName,
          messages: [
            {
              id: makeId("im"),
              role: "system",
              // Renderer translates via meta.i18nKey when present; the
              // English `text` is the fallback for any non-i18n client.
              text: `What kind of story should "${shownName}" become? Tell me a few sentences — or paste a full worldbook — and I'll start drafting the canon and characters.`,
              meta: {
                i18nKey: "initChat.greeting",
                i18nParams: { storyName: shownName },
              },
              at: Date.now(),
            },
          ],
          input: "",
          pendingAskUser: null,
          running: false,
          completed: false,
          // Live token counters driven by model.call.completed + tool.loop.stream.
          // streamChars: cumulative content chars seen in still-running calls;
          // usageTokens: real total tokens from completed model calls.
          // Display layer combines them as usageTokens + ceil(streamChars/4).
          streamChars: 0,
          usageTokens: 0,
          usageInputTokens: 0,
          usageOutputTokens: 0,
          usageCostUsd: 0,
        },
        storyNaming: null,
        input: "",
        currentStory: { ...currentStoryDescriptor({ env: this.#env }), displayName: shownName },
        status: `initializing "${shownName}" — describe the story you want`,
      })
      this.#refreshStoryTree()
    } catch (error) {
      this.#patch({ storyNaming: { error: error.message || String(error) } })
    }
  }

  async cancelStoryNaming() {
    this.#patch({ storyNaming: null, input: "" })
    await this.#enterStorySelector()
  }

  // ---- init-chat (conversational story initialization) ----

  // Internal helper: append a message to the initChat messages list.
  #initPushMessage(msg) {
    const ic = this.#state.initChat
    if (!ic) return
    this.#patch({
      initChat: {
        ...ic,
        messages: [
          ...ic.messages,
          { id: makeId("im"), at: Date.now(), ...msg },
        ],
      },
    })
  }

  // Record a resident agent's run lifecycle (running/done/error) during init,
  // keyed by agent id (matches the tool-call meta.agent the tree groups on).
  // Only mutates while an init run is live so post-completion events are inert.
  #initSetAgentRun(agentId, state) {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic || !ic.running) return
    const id = String(agentId || "").trim()
    if (!id) return
    const prev = ic.agentRuns || {}
    if (prev[id] === state) return
    this.#patch({ initChat: { ...ic, agentRuns: { ...prev, [id]: state } } })
  }

  // The intent box text. Mirrors `state.input` semantics but lives on the
  // initChat substate so the bottom command bar doesn't get involved.
  setInitInput(text) {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic) return
    this.#patch({ initChat: { ...ic, input: String(text || "") } })
  }

  // User submits their intent. Pushes the user message, marks running,
  // then fires (without awaiting) the background agent. The agent's tool
  // calls and final summary land via bus subscriptions in #wireBus.
  //
  // First-time gate: if OPENOVEL_INIT_DEPTH is unset, we stash the intent
  // in `pendingInitDepth` and return — the renderer shows a choice modal,
  // which then calls continueInitWithDepth() to resume. Subsequent calls
  // skip the gate (env now has the user's pick).
  async submitInitIntent() {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic || ic.running) return
    const text = String(ic.input || "").trim()
    if (!text) return
    const isRevision = Boolean(ic.completed)
    const envDepth = String(this.#env.OPENOVEL_INIT_DEPTH || "").trim()
    const validDepth = ["zero", "standard", "deep"].includes(envDepth) ? envDepth : null
    // Revisions reuse the previously-chosen depth; only fresh new-story
    // submissions trigger the modal.
    if (!validDepth && !isRevision) {
      this.#patch({
        initChat: {
          ...ic,
          pendingInitDepth: { intent: text, isRevision },
        },
        status: "choose initialization depth to continue",
      })
      return
    }
    this.#beginInitRun({ ic, text, isRevision, depth: validDepth || "standard" })
  }

  // Live reader feedback DURING an init run: the input box stays writable while
  // the agent works. The message is echoed into the init-chat transcript and
  // enqueued to the init coordinator's inbox; the running agent drains it at a
  // safe point (between tool steps / at the next pass), exactly like the
  // foreground/background agent channel. No-op when not running (the normal
  // submit/revision path handles the idle/completed states).
  async submitInitFeedback(text) {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic || !ic.running) return
    const trimmed = String(text || "").trim()
    if (!trimmed) return
    this.#initPushMessage({ role: "user", text: trimmed })
    this.#patch({ initChat: { ...this.#state.initChat, input: "" } })
    try {
      const { enqueueAgentMessage } = await import("./agentChannel.js")
      await enqueueAgentMessage({
        from: "reader",
        to: "story-init",
        type: "reader_feedback",
        priority: "now",
        turnId: ic.usageTurnId || ic.runId || "",
        payload: { message: trimmed },
      }, { bus })
    } catch (err) {
      process.stderr.write(`init reader feedback enqueue failed: ${err?.message || err}\n`)
    }
  }

  // Continue the init run after the user picked a depth in the Modal. The
  // renderer is expected to have persisted the choice (via the Electron
  // initDepthStore IPC) before calling this — we just consume the stashed
  // intent and fire the agent with the chosen depth.
  async continueInitWithDepth(depth) {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic || ic.running) return
    const pending = ic.pendingInitDepth
    if (!pending) return
    if (!["zero", "standard", "deep"].includes(depth)) return
    this.#beginInitRun({ ic, text: pending.intent, isRevision: pending.isRevision, depth })
  }

  #beginInitRun({ ic, text, isRevision, depth }) {
    // Provider-driven downgrade: Kimi Code is the free-tier provider
    // and is not yet validated for the deep-research init flow (long
    // tool chains, subagent dispatch, web research). If deep is selected
    // while the active background provider is kimi-code, transparently
    // fall back to standard for this run and tell the user why. We do
    // NOT touch the persisted setting — the user's "deep" preference
    // stays, and re-activates as soon as they pick a different provider.
    const downgradeNotice = this.#deepDowngradeNoticeIfNeeded(depth)
    const effectiveDepth = downgradeNotice ? "standard" : depth
    if (downgradeNotice) {
      this.#initPushMessage({ role: "system", text: downgradeNotice })
    }
    // Unique id for this init run — used as the JSON transcript filename
    // and as the in-state correlation key (so persistence at start +
    // completion write the SAME file).
    const runId = `init-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 6)}`
    const usageTurnId = `init_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    this.#patch({
      initChat: {
        ...ic,
        input: "",
        messages: [
          ...ic.messages,
          { id: makeId("im"), role: "user", text, at: Date.now() },
        ],
        running: true,
        completed: false,
        pendingAskUser: null,
        pendingInitDepth: null,
        // Per-agent lifecycle map (agentId -> "running"|"done"|"error"), driven
        // by background.agent.* events. The agent-tree badge reads this as the
        // authoritative "is this agent finished" signal instead of guessing
        // from whether a tool happens to be in flight right now. Reset per run.
        agentRuns: {},
        // Reset live counters at the start of each agent run so a retry
        // doesn't accumulate from the previous attempt.
        streamChars: 0,
        usageTokens: 0,
        usageInputTokens: 0,
        usageOutputTokens: 0,
        usageCostUsd: 0,
        usageTurnId,
        isRevision,
        depth: effectiveDepth,
        runId,
        startedAt: new Date().toISOString(),
        requestedDepth: depth,
      },
      status: isRevision
        ? "agent is applying your revision…"
        : effectiveDepth === "deep"
          ? "agent is researching and drafting your story…"
          : effectiveDepth === "zero"
            ? "placing your brief into the Prelude…"
            : "agent is drafting your story…",
    })
    // Persist the run-start metadata + a pre-run directory listing now,
    // so even a crashed init leaves evidence in story/agents/.
    this.#persistInitTranscript({ phase: "start", runId, intent: text, isRevision, requestedDepth: depth, effectiveDepth }).catch((e) => {
      process.stderr.write(`init transcript (start) failed: ${e?.message || e}\n`)
    })
    // Carry the prior dialogue + the original brief into the run. `ic` here is
    // the pre-submit state, so its messages are the conversation BEFORE this
    // turn — exactly the memory a revision needs.
    const history = initConversationHistory(ic.messages)
    const firstUser = (ic.messages || []).find((m) => m.role === "user")
    const originalBrief = (firstUser && String(firstUser.text || "").trim()) || text
    // Fire-and-forget; failures surface via the catch path.
    this.#runInitAgent(text, effectiveDepth, { history, originalBrief, runId, usageTurnId }).catch((err) => {
      this.#initPushMessage({
        role: "system",
        text: `Init agent failed: ${err?.message || String(err)}`,
      })
      const cur = this.#state.initChat
      if (cur) {
        this.#patch({
          initChat: { ...cur, running: false, completed: true, pendingAskUser: null },
          status: "init failed",
        })
      }
      this.#persistInitTranscript({ phase: "failed", runId, intent: text, isRevision, requestedDepth: depth, effectiveDepth, error: err?.message || String(err) }).catch(() => {})
    })
  }

  // Return a user-facing notice string when the requested depth is
  // incompatible with the active provider, else null. Currently the only
  // incompatibility is kimi-code + deep — we haven't validated kimi-code's
  // long-tool-chain / subagent / web-research behavior for the deep
  // workflow yet, so we transparently downgrade to standard.
  #deepDowngradeNoticeIfNeeded(depth) {
    if (depth !== "deep") return null
    try {
      const provider = String(this.#env.AI_BACKGROUND_PROVIDER || this.#env.AI_PROVIDER || "").trim()
      if (provider === "kimi-code") {
        return "Kimi Code 暂不支持深度初始化（深度模式依赖长工具链 / 子 Agent / 网络调研，目前在 Kimi Code 上未完成验证）。本次自动降级为标准初始化；之后切换到其他 provider 时，深度模式会再次可用。"
      }
    } catch { /* tolerate env lookup failure */ }
    return null
  }

  async #runInitAgent(intent, depth = "standard", { history = [], originalBrief, runId = "", usageTurnId = "" } = {}) {
    const { runStoryInit } = await import("../workflows/storyInitWorkflow.js")
    const { paths } = await import("../lib/storyStore.js")
    const { runPinnedToStoryRoot } = await import("../lib/storyContext.js")
    // PIN the entire init run to the story being initialized. Init is long-running
    // (multi-step agent + preview_narration); if the reader switches to ANOTHER
    // story mid-run, its scaffold's file writes would otherwise follow the global
    // env flip and clobber that story's foreground — exactly how a 荆轲 init once
    // overwrote 朱博's working set. The AsyncLocalStorage pin keeps every write on
    // THIS story regardless of a later switchActiveStory(). Captured synchronously
    // (paths.root is dynamic) before any long await.
    const storyRoot = paths.root
    return runPinnedToStoryRoot(storyRoot, async () => {
      const turnId = usageTurnId || runId || this.#state.initChat?.usageTurnId || this.#state.initChat?.runId || `init_${Date.now()}`
      const profile = createUsageProfile({
        action: `story init: ${String(intent || "").slice(0, 80)}`,
        turnId,
        kind: "story-init",
      })
      let usageSummary = null
      let result
      try {
        result = await runWithUsageProfile(profile, () =>
          runStoryInit({ intent, depth, env: this.#env, history, originalBrief, turnId }),
        )
      } finally {
        try {
          const persisted = await persistUsageProfile(profile)
          usageSummary = persisted?.summary || null
        } catch (e) {
          process.stderr.write(`init usage profile failed: ${e?.message || e}\n`)
        }
      }
      // The final assistant message (no tool calls) is the summary card.
      this.#initPushMessage({
        role: "summary",
        text: String(result?.content || "").trim() || "(no summary)",
      })
      // Persist the completed transcript (overwrites the "start" stub written
      // when the run began) BEFORE capturing the initial snapshot: the
      // snapshot banks agents/init-<runId>.json, and capturing first froze
      // the stub inside initial.json — a later "restart" then restored the
      // stub OVER the finished recording, silently killing init replay
      // (observed on five stories). Awaited, with an explicit `ic` snapshot,
      // for the same teardown race the cancel path documents. Failure path
      // writes from #beginInitRun's catch.
      const final = this.#state.initChat
      if (final?.runId) {
        await this.#persistInitTranscript({
          phase: "complete",
          runId: final.runId,
          intent,
          isRevision: Boolean(final.isRevision),
          requestedDepth: final.requestedDepth || depth,
          effectiveDepth: depth,
          summary: String(result?.content || "").trim(),
          usage: { steps: result?.steps || 0, ...(usageSummary || {}) },
          ic: final,
        }).catch((e) => {
          process.stderr.write(`init transcript (complete) failed: ${e?.message || e}\n`)
        })
      }
      // Auto-snapshot the freshly-drafted story so the user can later share
      // or restore THIS exact starting point ("initial" version), separately
      // from whatever they play to.
      await this.#captureInitialSnapshot().catch((e) => {
        // Snapshot failure shouldn't block the init flow — log and move on.
        process.stderr.write(`initial snapshot failed: ${e?.message || e}\n`)
      })
      const cur = this.#state.initChat
      if (cur) {
        this.#patch({
          initChat: { ...cur, running: false, completed: true, pendingAskUser: null, usageSummary },
          status: "draft ready — start when you're ready",
        })
      }
    })
  }

  // Persist the init run's metadata + full message stream to
  // story/agents/init.<runId>.json. Called at run start (stub), success
  // (full transcript), and failure (transcript up to the failure point).
  // The file is overwritten each phase so the latest state is always on
  // disk; the runId in the filename keeps separate runs distinct.
  // `ic` may be passed explicitly when the caller is about to tear the
  // init-chat state down (cancelInitChat patches initChat:null synchronously
  // while this fire-and-forget write is still awaiting its imports — reading
  // this.#state here then sees null and silently drops the conversation,
  // which is exactly how cancelled transcripts lost their messages).
  async #persistInitTranscript({ phase, runId, intent, isRevision, requestedDepth, effectiveDepth, summary, usage, error, ic: icSnapshot }) {
    if (!runId) return
    const { writeJson } = await import("../lib/files.js")
    const { paths } = await import("../lib/storyStore.js")
    const { currentStoryDescriptor } = await import("../lib/storyDirectory.js")
    const desc = currentStoryDescriptor({ env: this.#env })
    const ic = icSnapshot ?? this.#state.initChat
    // Pre-run dir listing — captured fresh at start, mostly redundant at
    // completion but kept stable for diff. Helps catch the "init ran
    // against the wrong story dir" failure mode the user reported.
    let preRunFiles = []
    if (phase === "start") {
      try {
        const { readdir } = await import("node:fs/promises")
        const path = (await import("node:path")).default
        async function walk(dir, prefix = "") {
          const out = []
          let entries = []
          try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
          for (const e of entries) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name
            if (e.isDirectory()) {
              if (rel.startsWith("agents") || rel.startsWith("packets")) continue
              out.push(...await walk(path.join(dir, e.name), rel))
            } else {
              out.push(rel)
            }
          }
          return out
        }
        preRunFiles = await walk(paths.root)
      } catch { /* tolerate */ }
    }
    const filePath = `${paths.agents}/${runId}.json`
    const payload = {
      runId,
      phase,
      writtenAt: new Date().toISOString(),
      story: {
        id: desc.id,
        displayName: ic?.storyName || "",
        root: desc.root,
      },
      env: {
        OPENOVEL_STORY_ID: this.#env.OPENOVEL_STORY_ID || null,
        OPENOVEL_STORY_ROOT: this.#env.OPENOVEL_STORY_ROOT || null,
        AI_BACKGROUND_PROVIDER: this.#env.AI_BACKGROUND_PROVIDER || null,
        AI_PROVIDER: this.#env.AI_PROVIDER || null,
      },
      intent,
      isRevision: Boolean(isRevision),
      depth: { requested: requestedDepth, effective: effectiveDepth },
      startedAt: ic?.startedAt || null,
      preRunFiles: phase === "start" ? preRunFiles : undefined,
      messages: (ic?.messages || []).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        meta: m.meta || undefined,
        at: m.at || null,
      })),
      summary: summary || undefined,
      usage: usage || undefined,
      error: error || undefined,
    }
    await writeJson(filePath, payload)
  }

  async #captureInitialSnapshot() {
    const { createSnapshot, writeSnapshotToFile, initialSnapshotPath } = await import("../lib/storySnapshot.js")
    const desc = currentStoryDescriptor({ env: this.#env })
    const sp = storyPaths({ env: this.#env })
    const bundle = await createSnapshot({
      storyRoot: sp.root,
      storyId: desc.id,
      label: "initial",
    })
    const out = initialSnapshotPath(desc.id, this.#env)
    await writeSnapshotToFile(bundle, out)
  }

  // Public: permanently delete a story from disk. Removes both the story
  // directory and any saved snapshots. Refuses to delete the project-local
  // sentinel or the currently-active story (user must switch first — we
  // could auto-switch but doing so silently could mask an unsaved state).
  async deleteStory(id) {
    if (!id) return { ok: false, error: "story id required" }
    if (id === "(project)") return { ok: false, error: "the project-local story cannot be deleted" }
    const active = currentStoryDescriptor({ env: this.#env }).id
    if (active === id) {
      return { ok: false, error: "switch to another story before deleting this one" }
    }
    try {
      const path = (await import("node:path")).default || (await import("node:path"))
      const { rm } = await import("node:fs/promises")
      const layout = workspaceLayout({ env: this.#env })
      const storyDir = path.join(layout.storiesRoot, id)
      const snapshotDir = path.join(layout.home, "snapshots", id)
      await rm(storyDir, { recursive: true, force: true })
      await rm(snapshotDir, { recursive: true, force: true })
      // If the user is in the splash grid, re-render it so the deleted card
      // disappears without a manual refresh.
      if (this.#state.mode === "story-selector") {
        await this.#enterStorySelector()
      }
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  // Public: rename a story's display name (persisted in <root>/meta.json).
  // The directory id never changes — only the human-facing name does.
  async renameStory(id, name) {
    if (!id) return { ok: false, error: "story id required" }
    if (id === "(project)") return { ok: false, error: "the project-local story cannot be renamed" }
    const trimmed = String(name || "").trim()
    if (!trimmed) return { ok: false, error: "story name cannot be empty" }
    try {
      const { renameStory: renameStoryFile } = await import("../lib/storyDirectory.js")
      const result = await renameStoryFile({ id, name: trimmed, env: this.#env })
      // If the renamed story is the active one, reflect the new name in the header.
      const active = currentStoryDescriptor({ env: this.#env }).id
      if (active === id && this.#state.currentStory) {
        this.#patch({ currentStory: { ...this.#state.currentStory, displayName: result.displayName } })
      }
      // Re-render the library grid so the card shows the new name immediately.
      if (this.#state.mode === "story-selector") {
        await this.#enterStorySelector()
      }
      return { ok: true, id, displayName: result.displayName }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  // Public: switch a story's presentation/pacing mode (experimental).
  // mode = "comic" | "fast" | "" (prose default), persisted in <root>/meta.json
  // (one field, so the modes replace each other). Turning comic ON requires a
  // configured image-generation provider: every turn generates panel images,
  // so an unconfigured provider would strand the story as
  // captions-on-placeholders from the first turn. Fast mode is pure prose and
  // needs no provider check.
  async setStoryMode(id, mode) {
    if (!id) return { ok: false, error: "story id required" }
    if (id === "(project)") return { ok: false, error: "the project-local story keeps the default mode" }
    const next = mode === "comic" ? "comic" : mode === "fast" ? "fast" : ""
    try {
      if (next === "comic") {
        const { hasImageGenerationConfig } = await import("../provider/imageGeneration.js")
        if (!hasImageGenerationConfig()) return { ok: false, error: "needs-image-provider" }
      }
      const { setStoryMode: persistStoryMode } = await import("../lib/storyDirectory.js")
      const result = await persistStoryMode({ id, mode: next, env: this.#env })
      const active = currentStoryDescriptor({ env: this.#env }).id
      if (active === id && this.#state.currentStory) {
        this.#patch({ currentStory: { ...this.#state.currentStory, mode: result.mode } })
      }
      // Re-render the library grid so the card's menu reflects the new mode.
      if (this.#state.mode === "story-selector") {
        await this.#enterStorySelector()
      }
      return { ok: true, id, mode: result.mode }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  // Public: build a snapshot of the active (or named) story. Renderer
  // bridges this through to the Electron save dialog so the user can write
  // it wherever they want. `kind` = "current" (fresh capture of live state)
  // or "initial" (load the auto-saved post-init bundle from disk).
  async exportStorySnapshot({ storyId, kind = "current" } = {}) {
    const { createSnapshot, readSnapshotFile, initialSnapshotPath } = await import("../lib/storySnapshot.js")
    const sp = storyPaths({ env: this.#env })
    const desc = currentStoryDescriptor({ env: this.#env })
    const id = storyId || desc.id
    if (kind === "initial") {
      const filePath = initialSnapshotPath(id, this.#env)
      return readSnapshotFile(filePath)
    }
    return createSnapshot({
      storyRoot: sp.root,
      storyId: id,
      label: "current",
    })
  }

  // Public: build a reader-facing export of the story narrative (EPUB or
  // TXT). Unlike exportStorySnapshot — which dumps every workspace file as
  // JSON for round-trip restore — this generates a self-contained ebook
  // suitable for reading apps. Returns { data: Buffer, filename, mimeType }.
  // Caller (Electron main → save dialog) writes the buffer to disk.
  async exportStoryNovel({ storyId, format = "epub", locale: localeArg } = {}) {
    const { collectNovelData } = await import("../services/export/collectNovelData.js")
    const { generateEpub } = await import("../services/export/generateEpub.js")
    const { generateTxt } = await import("../services/export/generateTxt.js")
    const PathMod = (await import("node:path")).default
    const { PROJECT_LOCAL_ID } = await import("../lib/storyDirectory.js")
    const sp = storyPaths({ env: this.#env })
    const desc = currentStoryDescriptor({ env: this.#env })
    const id = storyId || desc.id
    // Resolve the story root: active story keeps the live path (which may
    // be OPENOVEL_STORY_ROOT-overridden or project-local); any other id is
    // a sibling under ~/.openovel/stories/<id>.
    let storyRoot
    if (id === desc.id) {
      storyRoot = sp.root
    } else if (id === PROJECT_LOCAL_ID) {
      storyRoot = PathMod.join(process.cwd(), "story")
    } else {
      storyRoot = PathMod.join(sp.storiesRoot, id)
    }
    const locale = localeArg || "zh"
    const data = await collectNovelData({ storyRoot, locale })
    if (!data.chapters.length) {
      throw new Error("No narrative to export — the story has no canon chapters yet.")
    }
    const safeTitle = sanitizeFilenameBase(data.title) || data.storyId || "openovel-story"
    if (format === "txt") {
      return {
        data: generateTxt(data),
        filename: `${safeTitle}.txt`,
        mimeType: "text/plain;charset=utf-8",
        format: "txt",
        title: data.title,
        chapterCount: data.chapters.length,
      }
    }
    const epubBuf = await generateEpub(data)
    return {
      data: epubBuf,
      filename: `${safeTitle}.epub`,
      mimeType: "application/epub+zip",
      format: "epub",
      title: data.title,
      chapterCount: data.chapters.length,
    }
  }

  // Public: restore a snapshot bundle as a new story in the user's
  // library. Caller (Electron main → file dialog → JSON.parse) supplies
  // the bundle; we figure out a unique slot id, restore files, refresh
  // the story selector. `bundle.storyId` is a hint — if it collides with
  // an existing story we suffix with -import-<n> to avoid clobbering.
  async importStorySnapshot({ bundle } = {}) {
    if (!bundle || typeof bundle !== "object") return { ok: false, error: "snapshot bundle missing" }
    const { restoreSnapshot, writeSnapshotToFile, initialSnapshotPath } = await import("../lib/storySnapshot.js")
    const { workspaceLayout } = await import("../lib/workspacePaths.js")
    const { makeStoryId } = await import("../lib/storyDirectory.js")
    const path = (await import("node:path")).default
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs")
    const layout = workspaceLayout({ env: this.#env })
    // New slot id is a random token, same scheme as createStory. Bundle's
    // own storyId becomes the displayName fallback in meta.json (so the
    // user sees the original story's label in the library).
    let id = makeStoryId()
    for (let i = 0; i < 8; i++) {
      if (!existsSync(path.join(layout.storiesRoot, id))) break
      id = makeStoryId()
    }
    const targetDir = path.join(layout.storiesRoot, id)
    mkdirSync(targetDir, { recursive: true })
    try {
      await restoreSnapshot(bundle, targetDir)
      // Ensure meta.json exists with a sensible displayName — prefer the
      // bundle's storyId (likely a slug like "wlwz" or the user-typed
      // name). If the bundle restored its own meta.json that already had
      // a displayName, leave it alone.
      const metaPath = path.join(targetDir, "meta.json")
      if (!existsSync(metaPath)) {
        writeFileSync(metaPath, JSON.stringify({
          displayName: String(bundle.storyId || "imported"),
          createdAt: new Date().toISOString(),
          importedFrom: bundle.storyId || "",
        }, null, 2), "utf8")
      }
      // Bank the imported state as this story's initial baseline so "Restart"
      // works. An imported save never went through in-app init, so it has no
      // auto-saved initial.json; the imported snapshot IS its starting point, so
      // restart returns to it. Best-effort: a missing baseline only disables
      // Restart, it never corrupts the import.
      try {
        await writeSnapshotToFile(bundle, initialSnapshotPath(id, this.#env))
      } catch { /* baseline is best-effort */ }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
    // Refresh the splash grid so the new card appears immediately.
    if (this.#state.mode === "story-selector") {
      await this.#enterStorySelector()
    }
    return { ok: true, id, displayName: String(bundle.storyId || "imported"), fileCount: bundle.fileCount || 0 }
  }

  // ── Restart + saved versions ─────────────────────────────────────────────
  // "Restart" returns a story to its post-init opening (the auto-saved
  // initial.json); "restore version" returns it to a banked playthrough. Both
  // first archive the CURRENT live state as a version so a branch is never
  // lost, then restore the chosen bundle over the live root.

  // Snapshot the active story's current live state into a saved version, unless
  // it is still at its opening (0 reader turns — identical to initial.json, not
  // worth banking). Caller must already have switched the env to `storyId`.
  async #archiveCurrentAsVersion(storyId) {
    const turnCount = await getReaderTurnCount().catch(() => 0)
    if (!turnCount) return null
    const { saveVersion } = await import("../lib/storySnapshot.js")
    const sp = storyPaths({ env: this.#env })
    const versionId = `v_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    return saveVersion({
      storyRoot: sp.root,
      storyId,
      versionId,
      label: `turn ${turnCount}`,
      turnCount,
      env: this.#env,
      maxVersions: Number(this.#env.OPENOVEL_MAX_STORY_VERSIONS) || 0,
    }).catch((e) => {
      process.stderr.write(`archive version failed: ${e?.message || e}\n`)
      return null
    })
  }

  // Shared restart/restore core: make `storyId` the active story, bank its
  // current playthrough, then restore `loadBundle()`'s snapshot over the live
  // root and re-enter the story. Mirrors the /switch-story drain+reset sequence
  // so in-flight foreground settles and background leases are dropped first.
  async #swapToSnapshot(storyId, loadBundle) {
    const stories = await listStories({ env: this.#env }).catch(() => [])
    const target = stories.find((s) => s.id === storyId)
    if (!target?.root) return { ok: false, error: "story not found" }

    // Validate the bundle BEFORE we touch any live files.
    let bundle
    try {
      bundle = await loadBundle()
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
    if (!bundle) return { ok: false, error: "snapshot not found" }

    const { restoreSnapshotInPlace } = await import("../lib/storySnapshot.js")

    // Settle the active foreground turn, then make the target the active story.
    this.#setStatus("restoring…")
    await this.#drainBeforeSwitch()
    switchActiveStory({ id: storyId, env: this.#env })
    backgroundJobs.reset()
    sessionProcessor.reset()

    // Bank the current playthrough (no-op at the opening) so it stays reachable.
    const archived = await this.#archiveCurrentAsVersion(storyId)

    // Restore over the live root, re-ensure scaffolding, rebind the job ledger.
    await restoreSnapshotInPlace(bundle, storyPaths({ env: this.#env }).root)
    await initializeStory()
    await backgroundJobs.bindLedger({ path: paths.jobsLedger })

    // Re-enter the story showing the restored state (rebuilds transcript from
    // the restored scene_log + re-reads the snapshot).
    await this.#hydrateActiveStory()
    // Restarting to the initial baseline restores a scaffold with an empty
    // scene_log (the baseline is captured at init draft, before the opening is
    // composed), so hydrate leaves a blank pane. Compose the opening the same
    // way a fresh init / story switch does. No-op when the restored snapshot
    // already has prose (e.g. a banked version), since entries.length !== 0.
    this.#autoOpenIfFresh().catch(() => {})
    return { ok: true, archived }
  }

  // Public: restart a story back to its freshly-initialized opening. Banks the
  // current playthrough as a version first.
  async restartStory(storyId) {
    if (!storyId) return { ok: false, error: "story id required" }
    const { readSnapshotFile, initialSnapshotPath } = await import("../lib/storySnapshot.js")
    const { existsSync } = await import("node:fs")
    const initPath = initialSnapshotPath(storyId, this.#env)
    if (!existsSync(initPath)) return { ok: false, error: "no initial baseline for this story" }
    return this.#swapToSnapshot(storyId, () => readSnapshotFile(initPath))
  }

  // Public: switch a story to one of its banked versions. Banks the current
  // playthrough first so the in-progress branch is not lost.
  async restoreStoryVersion(storyId, versionId) {
    if (!storyId || !versionId) return { ok: false, error: "story id and version id required" }
    const { readSnapshotFile, versionPath } = await import("../lib/storySnapshot.js")
    const { existsSync } = await import("node:fs")
    const vp = versionPath(storyId, versionId, this.#env)
    if (!existsSync(vp)) return { ok: false, error: "version not found" }
    return this.#swapToSnapshot(storyId, () => readSnapshotFile(vp))
  }

  // Public: list a story's banked versions (newest-first) for the home card.
  async listStoryVersions(storyId) {
    if (!storyId) return { ok: false, error: "story id required" }
    const { listVersions, initialSnapshotPath } = await import("../lib/storySnapshot.js")
    const { existsSync } = await import("node:fs")
    return {
      ok: true,
      versions: await listVersions(storyId, this.#env),
      hasInitialSnapshot: existsSync(initialSnapshotPath(storyId, this.#env)),
    }
  }

  // Public: delete one banked version.
  async deleteStoryVersion(storyId, versionId) {
    if (!storyId || !versionId) return { ok: false, error: "story id and version id required" }
    const { deleteVersion } = await import("../lib/storySnapshot.js")
    const versions = await deleteVersion(storyId, versionId, this.#env)
    return { ok: true, versions }
  }

  // User answers an ask_user prompt. Resolves the agent's awaiting Promise
  // via the askUserRegistry so the tool loop can continue.
  async submitInitAskUserAnswer(text) {
    if (this.#state.mode !== "init-chat") return
    const ic = this.#state.initChat
    if (!ic || !ic.pendingAskUser) return
    const answer = String(text || "")
    const questionId = ic.pendingAskUser.id
    this.#initPushMessage({
      role: "user-answer",
      text: answer,
      meta: { questionId },
    })
    this.#patch({ initChat: { ...this.#state.initChat, pendingAskUser: null } })
    try {
      const { askUserRegistry } = await import("./askUserRegistry.js")
      askUserRegistry.resolve(questionId, answer)
    } catch { /* ignore */ }
  }

  // "Enter interactive mode?" — agent finished, user wants to start reading.
  // Init only writes the upstream context (FOREGROUND.md with its Prelude,
  // context cards, MEMORY.md) — never the opening prose. So after hydrate
  // (which would otherwise leave the reader staring at an empty pane), we
  // auto-fire a "(begin the story)" reader action. The narrator then
  // composes the actual opening from the Prelude, and the user sees prose
  // streaming in immediately.
  async confirmInitDone() {
    if (this.#state.mode !== "init-chat") return
    this.#patch({ initChat: null })
    await this.#hydrateActiveStory()
    await this.#autoOpenIfFresh()
  }

  // Compose the opening scene for a story that has a scaffold but has never
  // been read (empty scene_log → no transcript entries). Mirrors a fresh
  // init: the narrator writes the opening from FOREGROUND.md's Prelude. No-op
  // when the story already has transcript entries (already read — e.g. user
  // re-entered init-chat to revise then bailed) or has no foreground scaffold
  // yet (nothing to open from). Shared by confirmInitDone and switchToStory.
  async #autoOpenIfFresh() {
    if (this.#state.entries.length !== 0) return
    if (!(this.#state.foregroundGuidance || "").trim()) return
    try {
      const fg = await readForegroundForLocaleHint()
      await this.#autoTriggerOpening(fg)
    } catch (error) {
      this.#pushEntry({
        type: "error",
        text: `Could not auto-start the opening scene: ${error.message || error}`,
      })
    }
  }

  // Reopening a story whose init never finished. Two flavors, decided by the
  // newest init transcript's phase (any phase but "complete" + no reading
  // history = unfinished):
  //   - "start" (app closed / crashed mid-run): rebuild the init-chat from the
  //     transcript and re-launch the run with the recorded intent +
  //     conversation. The init agent works against whatever scaffold files the
  //     interrupted run already wrote, so the continuation picks up the
  //     on-disk state — same files-are-the-state posture as the resident-agent
  //     resume.
  //   - "cancelled" / "failed" (the run ended deliberately or in error):
  //     restore the init-chat SURFACE with the recorded conversation and the
  //     intent prefilled into the input, but do NOT auto-run — a deliberate
  //     bail must not silently relaunch (and a failed run could loop-burn
  //     tokens). One send continues against the on-disk scaffold.
  // Returns true when the init flow was restored (the caller then skips
  // auto-opening, which would otherwise ship a half-built scaffold as a
  // story opening).
  async #maybeResumeInterruptedInit({ force = false } = {}) {
    // Already in a live init-chat (not a replay): nothing to restore again.
    if (this.#state.mode === "init-chat" && this.#state.initChat && !this.#state.initChat.replay) return true
    // Any actually NARRATED prose means the reader has read this story, so
    // init finished long ago. Deliberately not turnCount: that counts
    // reader_action events, and an unfinished init can leave auto-opening
    // reader_actions whose narration never arrived; those must not block the
    // restore. transcriptHistory only emits entries
    // for completed action+narration turns, so the narration check is the
    // reliable "has been read" signal.
    const hasNarration = this.#state.entries.some((e) => e?.type === "narration")
    if (!force && hasNarration) return false
    const { loadInitTranscript, isInterruptedInitTranscript, isUnfinishedInitTranscript } = await import("./initReplay.js")
    // requireMessages:false — a transcript whose conversation was lost (an old
    // cancel write raced state teardown) still marks the story as unfinished.
    const transcript = await loadInitTranscript(paths.agents, { requireMessages: false }).catch(() => null)
    if (!isUnfinishedInitTranscript(transcript)) return false
    const interrupted = isInterruptedInitTranscript(transcript)
    const intent = String(transcript.intent)
    // Rebuild the conversation. The transcript's start-phase write happens
    // AFTER the submitting user message is appended, so for the auto-resume
    // case drop that trailing message — #beginInitRun re-appends it (keeping
    // the restored state byte-identical to the pre-crash one). The manual
    // (cancelled/failed) restore keeps the conversation as recorded.
    let messages = (transcript.messages || []).map((m) => ({
      id: m.id || makeId("im"),
      role: m.role,
      text: m.text,
      meta: m.meta || undefined,
      at: m.at || Date.now(),
    }))
    const last = messages[messages.length - 1]
    if (interrupted && last?.role === "user" && String(last.text || "") === intent) messages = messages.slice(0, -1)
    messages.push(
      interrupted
        ? {
            id: makeId("im"),
            role: "system",
            text: "The previous initialization was interrupted — continuing from where it left off.",
            meta: { i18nKey: "initChat.resumedInterrupted" },
            at: Date.now(),
          }
        : {
            id: makeId("im"),
            role: "system",
            text: "This story's initialization never finished. The draft below is restored; send the request (prefilled) to continue building on what was already written.",
            meta: { i18nKey: "initChat.resumeUnfinished" },
            at: Date.now(),
          },
    )
    const ic = {
      storyName: transcript.story?.displayName || this.#state.currentStory?.displayName || "",
      messages,
      input: interrupted ? "" : intent,
      pendingAskUser: null,
      running: false,
      completed: false,
      streamChars: 0,
      usageTokens: 0,
      usageInputTokens: 0,
      usageOutputTokens: 0,
      usageCostUsd: 0,
    }
    this.#patch({
      mode: "init-chat",
      initChat: ic,
      input: "",
      status: interrupted ? "resuming interrupted initialization…" : "initialization unfinished — review and continue",
    })
    if (!interrupted) return true
    const depth = ["zero", "standard", "deep"].includes(transcript.depth?.requested)
      ? transcript.depth.requested
      : (["zero", "standard", "deep"].includes(transcript.depth?.effective) ? transcript.depth.effective : "standard")
    this.#beginInitRun({ ic, text: intent, isRevision: Boolean(transcript.isRevision), depth })
    return true
  }

  // User bails out of the init flow. Reject any outstanding ask_user so the
  // agent doesn't leak a hanging Promise.
  async cancelInitChat() {
    if (this.#state.mode !== "init-chat") return
    this.#replayToken++ // stop any running demo replay
    const ic = this.#state.initChat
    try {
      const { askUserRegistry } = await import("./askUserRegistry.js")
      askUserRegistry.rejectAll("init flow cancelled by user")
    } catch { /* ignore */ }
    // A deliberate bail-out is TERMINAL: without this, the transcript stays at
    // phase "start" and the next open of this story would misread the cancel
    // as an interrupted run and auto-resume it. (If the detached agent run is
    // still alive and later finishes, its own completed/failed write wins —
    // also terminal, so the no-resume outcome is the same.)
    if (ic?.runId && !ic.replay) {
      // The rewrite replaces the whole payload — recover `intent` from the last
      // user message so the cancelled transcript keeps its replay value.
      const lastUser = [...(ic.messages || [])].reverse().find((m) => m.role === "user")
      this.#persistInitTranscript({
        phase: "cancelled",
        runId: ic.runId,
        intent: lastUser?.text || "",
        isRevision: ic.isRevision,
        requestedDepth: ic.requestedDepth,
        effectiveDepth: ic.depth,
        // Explicit snapshot: the patch below nulls state.initChat before the
        // async write reads it, which used to drop the whole conversation.
        ic,
      }).catch(() => {})
    }
    this.#patch({ initChat: null })
    await this.#enterStorySelector()
  }

  // ---- init replay (demo playback of a recorded init run) ----
  //
  // Explicit "continue initialization" from the library story-card menu: open
  // the story and put it back into the init flow. Normally the restore the
  // switch itself banked is enough (await it for a reportable result); the
  // force pass covers the edge where stray narrated prose would make the
  // automatic restore decline — the user clicked the menu item, so restoring
  // the init surface is exactly what they asked for.
  async resumeStoryInit(storyId) {
    if (!storyId) return { ok: false, error: "story id required" }
    const switched = await this.switchToStory(storyId)
    if (!switched?.ok) return switched
    const resumed = await (this.#pendingInitRestore ?? Promise.resolve(false)).catch(() => false)
    if (resumed) return { ok: true }
    const forced = await this.#maybeResumeInterruptedInit({ force: true }).catch(() => false)
    return forced
      ? { ok: true }
      : { ok: false, error: "no unfinished initialization recorded for this story" }
  }

  // Plays a story's recorded init transcript (story/agents/init-*.json) back
  // into state.initChat at a fixed demo pace, WITHOUT running the model or
  // writing any files — it only patches initChat. Used to show the init flow.
  async replayStoryInit(storyId) {
    const stories = await listStories({ env: this.#env }).catch(() => [])
    const story = stories.find((s) => s.id === storyId)
    if (!story?.root) return { ok: false, error: "story not found" }
    const { loadInitTranscript, buildReplaySteps, replayMeta } = await import("./initReplay.js")
    const transcript = await loadInitTranscript(`${story.root}/agents`)
    if (!transcript) return { ok: false, error: "no recorded init to replay" }
    const meta = replayMeta(transcript)
    const steps = buildReplaySteps(transcript)
    const token = ++this.#replayToken
    this.#replaySpeed = Number(this.#env.OPENOVEL_INIT_REPLAY_SPEED) > 0 ? Number(this.#env.OPENOVEL_INIT_REPLAY_SPEED) : 1
    this.#patch({
      mode: "init-chat",
      storyNaming: null,
      input: "",
      initChat: {
        storyName: meta.storyName,
        messages: [],
        input: "",
        pendingAskUser: null,
        running: true,
        completed: false,
        replay: true,
        replayStoryId: storyId,
        replaySpeed: this.#replaySpeed,
        depth: meta.depth,
        streamChars: 0,
        usageTokens: 0,
        usageInputTokens: 0,
        usageOutputTokens: 0,
        usageCostUsd: 0,
      },
      status: `replaying init for "${meta.storyName}"`,
    })
    this.#runInitReplay(steps, token).catch(() => {})
    return { ok: true }
  }

  // Live playback speed (1x/5x/10x/50x). The driver reads #replaySpeed at each
  // sleep, so changing it mid-replay fast-forwards immediately.
  setReplaySpeed(mult) {
    const m = Number(mult)
    if (!(m > 0)) return
    this.#replaySpeed = m
    const ic = this.#state.initChat
    if (ic?.replay) this.#patch({ initChat: { ...ic, replaySpeed: m } })
  }

  #replayAlive(token) {
    return this.#replayToken === token && this.#state.mode === "init-chat" && Boolean(this.#state.initChat?.replay)
  }

  #patchInit(partial) {
    const ic = this.#state.initChat
    if (!ic) return
    this.#patch({ initChat: { ...ic, ...partial } })
  }

  #initSetLastMessageText(text) {
    const ic = this.#state.initChat
    if (!ic || !ic.messages.length) return
    const messages = ic.messages.slice()
    messages[messages.length - 1] = { ...messages[messages.length - 1], text }
    this.#patch({ initChat: { ...ic, messages } })
  }

  // Merge a meta patch into the most-recently-pushed init message. Used by the
  // replay driver to flip a tool row from running → done (the driver pushes the
  // tool, then patches the same last message a beat later).
  #initUpdateLastMessageMeta(metaPatch) {
    const ic = this.#state.initChat
    if (!ic || !ic.messages.length) return
    const messages = ic.messages.slice()
    const last = messages[messages.length - 1]
    messages[messages.length - 1] = { ...last, meta: { ...(last.meta || {}), ...metaPatch } }
    this.#patch({ initChat: { ...ic, messages } })
  }

  #replaySleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / (this.#replaySpeed || 1))))
  }

  async #replayTypeMessage(message, token) {
    const full = String(message.text || "")
    this.#initPushMessage({ ...message, text: "" })
    if (!full.length) return
    const ticks = Math.min(28, Math.max(6, Math.ceil(full.length / 18)))
    const perTick = Math.ceil(full.length / ticks)
    for (let n = 1; n <= ticks; n++) {
      if (!this.#replayAlive(token)) return
      this.#initSetLastMessageText(full.slice(0, Math.min(full.length, n * perTick)))
      await this.#replaySleep(Math.min(70, Math.max(22, 1700 / ticks)))
    }
    this.#initSetLastMessageText(full)
  }

  async #runInitReplay(steps, token) {
    for (const step of steps) {
      if (!this.#replayAlive(token)) return
      if (typeof step.usageTokens === "number") this.#patchInit({ usageTokens: step.usageTokens })
      switch (step.kind) {
        case "message":
          if (step.typed) await this.#replayTypeMessage(step.message, token)
          else { this.#initPushMessage(step.message); await this.#replaySleep(300) }
          break
        case "tool": {
          // Show the tool call working briefly, then settle to done — so the
          // viewer sees the individual row rather than it folding into the
          // agent's count instantly. The fresh completedAt re-arms the
          // renderer's own FOLD_GRACE_MS, which folds it a couple seconds later.
          const recorded = step.message.meta || {}
          const finalStatus = recorded.status === "error" ? "error" : "done"
          this.#initPushMessage({
            ...step.message,
            meta: { ...recorded, status: "running", completedAt: undefined },
          })
          await this.#replaySleep(240)
          if (!this.#replayAlive(token)) break
          this.#initUpdateLastMessageMeta({ status: finalStatus, completedAt: Date.now() })
          await this.#replaySleep(150)
          break
        }
        case "ask":
          this.#initPushMessage(step.message)
          this.#patchInit({ pendingAskUser: step.pendingAskUser })
          await this.#replaySleep(1100) // a beat to read the question before it's answered
          break
        case "answer":
          this.#patchInit({ pendingAskUser: null })
          this.#initPushMessage(step.message)
          await this.#replaySleep(550)
          break
        case "complete":
          if (this.#replayAlive(token)) {
            this.#patchInit({ running: false, completed: true, pendingAskUser: null, usageTokens: step.usageTokens })
          }
          break
        default:
          break
      }
    }
  }

  async shutdown() {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    // App quit while a story is open: in-flight agents are about to be killed
    // mid-run — record them so reopening the story auto-resumes their work.
    if (this.#state.currentStory) {
      try {
        const { writeAgentResumeSnapshot } = await import("./agentResume.js")
        await writeAgentResumeSnapshot({ registry: backgroundJobs })
      } catch { /* best-effort */ }
    }
    for (const off of this.#unsubscribe) {
      try { off() } catch { /* ignore */ }
    }
    this.#unsubscribe = []
  }

  // Request an interactive shutdown — any consumer (e.g. a /quit command in
  // the future) can call this to signal "I want to exit"; UI surfaces should
  // listen for "exit-request" and unmount themselves. shutdown() does the
  // actual teardown and does NOT emit (so listeners can call shutdown()
  // without recursing).
  requestExit() {
    if (this.#shuttingDown) return
    this.emit("exit-request")
  }

  #wireBus() {
    this.#unsubscribe.push(
      bus.subscribe("background.job.started", (event) => {
        const job = event.properties?.job || {}
        // A previous story's detached work (e.g. a Showrunner handoff-wake
        // that fired after the switch) — it runs and lands in its own story;
        // don't surface it in this story's status/panels.
        if (isForeignStoryJob(job, this.#state.currentStory?.root)) return
        this.#setStatus(`running ${job.title || job.type}`)
        const actId = this.#pushActivity({
          source: humanizeSource(job.type),
          label: humanizeJobStart(job),
          status: "running",
          jobId: job.id,
          meta: { jobType: job.type, startedAt: Date.now() },
        })
        if (job.id) this.#jobActivityIds.set(job.id, actId)
        // Track the live set of active agents (L1 of the side-pane agent tree).
        const agentId = resolveJobAgentId(job)
        // A re-started agent supersedes its own finished (done/error) history
        // entry — drop it so the panel shows one row per agent, not "running"
        // above a stale "done". Other agents' finished entries stay.
        this.#patch({
          jobs: [
            ...this.#state.jobs.filter((j) => j.id !== job.id && !(j.agent === agentId && j.state !== "running")),
            { id: job.id, agent: agentId, label: agentLabelFor(agentId), type: job.type, startedAt: Date.now(), state: "running" },
          ].slice(-JOBS_MAX),
        })
        this.#bumpAggregate({ jobs: 1 })
      }),
      bus.subscribe("background.job.completed", async (event) => {
        const job = event.properties?.job || {}
        const jobType = job.type || "background"
        const startedAt = this.#jobStartedAt(job.id)
        const durationMs = startedAt ? Date.now() - startedAt : null
        // A foreign-story job (started before a switch, finished detached in
        // its own story) still gets its activity row closed below, but must
        // not drive this story's status line or snapshot/tree refresh.
        if (!isForeignStoryJob(job, this.#state.currentStory?.root)) {
          let inboxItems = 0
          try {
            const snap = await getStorySnapshot()
            inboxItems = snap.backgroundInboxItems?.length || 0
            this.#patch({
              foregroundGuidance: snap.foregroundGuidance || "",
              inboxCount: inboxItems,
            })
          } catch { /* tolerate transient read errors */ }
          this.#setStatus(formatJobCompletedStatus(jobType, inboxItems))
          this.#refreshStoryTree()
        }
        const actId = job.id ? this.#jobActivityIds.get(job.id) : null
        if (actId) {
          this.#updateActivity(actId, {
            label: humanizeJobDone(job),
            status: "done",
            meta: { durationMs },
          })
          this.#jobActivityIds.delete(job.id)
        }
        // Keep the agent in the tree marked "done" (bounded history) — the Agents
        // panel is now the single activity view; it doesn't vanish on completion.
        if (job.id) {
          this.#patch({
            jobs: this.#state.jobs.map((j) =>
              j.id === job.id ? { ...j, state: "done", durationMs, endedAt: Date.now() } : j),
          })
        }
      }),
      bus.subscribe("background.job.error", (event) => {
        const job = event.properties?.job || {}
        // Background errors are NOT surfaced on the reader-facing footer status:
        // they route to the Error Log (the activity entry below, status "error")
        // and light the header error badge. Dumping a raw provider error onto the
        // narrative page is noise the reader can't act on. (Do NOT #setStatus here.)
        if (job.id) {
          this.#patch({
            jobs: this.#state.jobs.map((j) =>
              j.id === job.id ? { ...j, state: "error", endedAt: Date.now(), error: job.error || "" } : j),
          })
        }
        const actId = job.id ? this.#jobActivityIds.get(job.id) : null
        if (actId) {
          this.#updateActivity(actId, {
            label: `${humanizeSource(job.type)} failed: ${job.error || "unknown"}`,
            status: "error",
          })
          this.#jobActivityIds.delete(job.id)
        } else {
          this.#pushActivity({
            source: humanizeSource(job.type),
            label: `failed: ${job.error || "unknown"}`,
            status: "error",
          })
        }
      }),
      bus.subscribe("foreground.options.error", (event) => {
        // The post-narration options call failed this turn (timeout / provider
        // error). Like background errors, this routes to the Error Log + header
        // badge, NEVER the reader-facing footer; the reader keeps free-text input.
        const error = event.properties?.error || "unknown error"
        this.#pushActivity({
          source: "Options",
          label: `unavailable this turn: ${error}`,
          status: "error",
        })
      }),
      // Per-model-call event — fires after EACH model call completes
      // anywhere in the runtime (foreground narrator + every background
      // job). The aggregate ticks here, so the sidebar counter never sits
      // at zero while a long Storykeeper drain is in flight.
      bus.subscribe("model.call.completed", (event) => {
        const props = event.properties || {}
        const usage = props.usage || {}
        const costUsd = eventCostUsd(props.cost)
        this.#bumpAggregate({
          modelCalls:   1,
          inputTokens:  usage.inputTokens  || 0,
          outputTokens: usage.outputTokens || 0,
          costUsd,
        })
        const ic = this.#state.initChat
        if (matchesInitUsageEvent(ic, props)) {
          this.#patch({
            initChat: {
              ...ic,
              usageTokens: (ic.usageTokens || 0) + modelUsageTotalTokens(usage),
              usageInputTokens: (ic.usageInputTokens || 0) + (usage.inputTokens || 0),
              usageOutputTokens: (ic.usageOutputTokens || 0) + (usage.outputTokens || 0),
              usageCostUsd: (ic.usageCostUsd || 0) + costUsd,
              streamChars: 0,
            },
          })
        }
      }),
      // Job-completion usage summary — used ONLY to annotate the job's
      // activity row with its final totals. Aggregate is NOT incremented
      // here (model.call.completed already covered every call).
      bus.subscribe("background.usage", (event) => {
        const props = event.properties || {}
        const sum = props.summary || {}
        const actId = props.jobId ? this.#jobActivityIds.get(props.jobId) : null
        if (actId) {
          this.#updateActivity(actId, {
            meta: {
              modelCalls:   sum.modelCalls   || 0,
              inputTokens:  sum.inputTokens  || 0,
              outputTokens: sum.outputTokens || 0,
              costUsd:      Number(sum.estimatedCostUSD) || 0,
            },
          })
        }
      }),
      bus.subscribe("background.inbox.enqueued", (event) => {
        if (this.#isForeignStoryEvent()) return
        const items = event.properties?.items || event.properties?.added || []
        const n = Array.isArray(items) ? items.length : Number(items) || 0
        if (!n) return
        this.#pushActivity({
          source: "Inbox",
          label: `enqueued ${n} item${n === 1 ? "" : "s"}`,
          status: "info",
        })
      }),
      bus.subscribe("background.signal", (event) => {
        if (this.#isForeignStoryEvent()) return
        const props = event.properties || {}
        const summary = props.summary || props.note || ""
        this.#pushActivity({
          source: "Signal",
          label: summary ? `extracted · ${truncate(summary, 60)}` : "extracted anchors",
          status: "info",
        })
      }),
      bus.subscribe("storykeeper.queue.enqueued", (event) => {
        if (this.#isForeignStoryEvent()) return
        const props = event.properties || {}
        const priority = props.priority || "later"
        const type = props.type || "message"
        this.#pushActivity({
          source: "Queue",
          label: `enqueued ${type} · ${priority}`,
          status: "info",
          meta: { messageId: props.id, turnId: props.turnId },
        })
      }),
      bus.subscribe("storykeeper.queue.injected", (event) => {
        if (this.#isForeignStoryEvent()) return
        const props = event.properties || {}
        const ids = Array.isArray(props.ids) ? props.ids : []
        if (!ids.length) return
        this.#pushActivity({
          source: "Queue",
          label: `injected ${ids.length} message${ids.length === 1 ? "" : "s"}`,
          status: "done",
          meta: { count: ids.length, reason: props.reason || "" },
        })
      }),
      bus.subscribe("story.files_changed", (event) => {
        // A left story's detached job writing ITS files must not re-theme,
        // re-highlight, or refresh THIS story's tree/feed.
        if (this.#isForeignStoryEvent()) return
        const props = event.properties || {}
        // Background loop rewrote the rich-render contract → reload it so the
        // renderer re-themes live (fire-and-forget; flag-gated inside).
        if (props.formatUpdated) this.#refreshFormatContract().catch(() => {})
        const files = Array.isArray(props.files) ? props.files : []
        // A context-card write may add/rename a character → refresh the
        // narration name-highlight list live.
        if (files.some((f) => String(f?.path || "").includes("context-cards"))) {
          this.#refreshCharacterNames()
        }
        const wroteCount = files.length + (props.foregroundUpdated ? 1 : 0) + (props.provenanceUpdated ? 1 : 0)
        if (!wroteCount) return
        this.#bumpAggregate({ filesWritten: wroteCount })
        const paths = files.map((f) => f.path)
        const label = files.length
          ? files.length === 1
            ? `wrote ${shortenPath(paths[0])}`
            : `wrote ${summarizeFileList(paths)}`
          : props.foregroundUpdated
            ? "updated foreground guidance"
            : "updated provenance"
        // Stash the full path list so the activity row's tooltip can show
        // exactly which files changed — "wrote 7 files" alone is unactionable.
        const extraPaths = []
        if (props.foregroundUpdated) extraPaths.push("guidance/FOREGROUND.md")
        if (props.provenanceUpdated) extraPaths.push("canon/PROVENANCE.md")
        this.#pushActivity({
          source: "Files",
          label,
          status: "done",
          meta: {
            files: [...paths.map(shortenPath), ...extraPaths],
            foregroundUpdated: !!props.foregroundUpdated,
            inboxResolved: props.inboxResolved || 0,
          },
        })
        this.#refreshStoryTree()
      }),
      bus.subscribe("session.reader_action", (event) => {
        const text = event.properties?.action || event.properties?.text || ""
        // A new reader turn just started (recorded as reader_action in the
        // scene_log). Bump the live count to match — hydrate seeded it from the
        // full file, so this stays in sync and a re-scan after restart agrees.
        this.#patch({ turnCount: (this.#state.turnCount || 0) + 1 })
        this.#pushActivity({
          source: "Reader",
          label: text ? truncate(text, 60) : "(empty action)",
          status: "info",
        })
      }),
      bus.subscribe("session.foreground_turn", (event) => {
        const turnId = event.properties?.turnId
        this.#pushActivity({
          source: "Narrator",
          label: turnId ? `turn ${shortenTurnId(turnId)}` : "turn complete",
          status: "done",
          meta: turnId ? { turnId } : null,
        })
      }),
      // Comic mode (experimental): mirror panel-generation lifecycle into
      // renderer state. ComicStrip keys off state.comicPanels[rel] to swap a
      // panel's placeholder for its image (ready) or a caption-only mark
      // (failed). Cleared on story switch (#enterStorySelector).
      bus.subscribe("comic.panel.pending", (event) => this.#patchComicPanel(event, "pending")),
      bus.subscribe("comic.panel.ready", (event) => this.#patchComicPanel(event, "ready")),
      bus.subscribe("comic.panel.failed", (event) => this.#patchComicPanel(event, "failed")),
      bus.subscribe("tool.call.started", (event) => {
        if (this.#isForeignStoryEvent()) return
        const props = event.properties || {}
        // explain() is a status note, not a tool: stash it as the agent's latest
        // "what I'm doing" line (shown after "thinking…"), not as a tool row.
        if (props.name === "explain") {
          if (props.agent && props.argsSummary) {
            this.#patch({
              jobs: this.#state.jobs.map((j) =>
                j.agent === props.agent && j.state === "running" ? { ...j, explain: props.argsSummary } : j),
            })
          }
          return
        }
        const next = [
          ...this.#state.activeTools,
          {
            id: props.id,
            name: props.name,
            agent: props.agent || "",
            argsSummary: props.argsSummary || "",
            startedAt: props.at,
            state: "running",
          },
        ]
        this.#patch({ activeTools: next })
        // Label format: "<tool> <argsSummary>" — e.g.
        //   "edit chen-guangming/CARD.md"
        //   "grep \"陈光明\" in canon"
        //   "websearch \"上海铁路局编制\""
        // Falls back to just the tool name when no summary is available.
        const verb = humanizeToolCall(props.name)
        const label = props.argsSummary ? `${verb} ${props.argsSummary}` : verb
        const actId = this.#pushActivity({
          source: "Tool",
          label,
          status: "running",
          meta: {
            toolName: props.name,
            argsSummary: props.argsSummary || "",
            jobId: props.jobId,
            startedAt: Date.now(),
          },
        })
        if (props.id) this.#toolActivityIds.set(props.id, actId)
      }),
      bus.subscribe("tool.call.completed", (event) => {
        const id = event.properties?.id
        if (!id) return
        // Foreign-story completions skip the live tool tree (their started
        // events never created an entry; switch paths clear leftovers), but
        // the activity-row closure below always runs so a row created while
        // its story was still current doesn't stay "running" forever.
        if (!this.#isForeignStoryEvent()) {
          // Don't drop the entry — flip it to "done" and schedule cleanup. This
          // gives the side pane a few seconds to display fast tool calls
          // (read/grep often finish in <50ms, otherwise the user never sees
          // them) and lets the user count how many ran.
          const next = this.#state.activeTools.map((t) =>
            t.id === id ? { ...t, state: "done", completedAt: event.properties?.at } : t,
          )
          this.#patch({ activeTools: next })
          setTimeout(() => {
            const remaining = this.#state.activeTools.filter((t) => t.id !== id)
            if (remaining.length !== this.#state.activeTools.length) {
              this.#patch({ activeTools: remaining })
            }
          }, 5000)
        }
        const actId = this.#toolActivityIds.get(id)
        if (actId) {
          const created = this.#state.activity.find((a) => a.id === actId)
          const durationMs = created?.meta?.startedAt ? Date.now() - created.meta.startedAt : null
          const failed = event.properties?.ok === false
          this.#updateActivity(actId, {
            status: failed ? "error" : "done",
            meta: { durationMs, error: failed ? (event.properties?.error || "") : "" },
          })
          this.#toolActivityIds.delete(id)
        }
        this.#bumpAggregate({ toolCalls: 1 })
      }),
      bus.subscribe("tool.permission", (event) => {
        const props = event.properties || {}
        // Don't pollute the feed with the common case (silent allow). Only
        // surface ask/deny — those are the moments a viewer cares about.
        if (props.action === "allow" && !props.denied) return
        const verb = props.denied ? "denied" : props.action || "decided"
        this.#pushActivity({
          source: "Permission",
          label: `${verb} ${props.id || "tool"}${props.reason ? ` · ${truncate(props.reason, 40)}` : ""}`,
          status: props.denied ? "error" : "info",
          meta: { toolId: props.id, action: props.action, reason: props.reason || "" },
        })
      }),
      // ── init-chat: surface tool calls inline in the chat view so the user
      //    sees the agent's work as it happens. Only active while an init agent
      //    is running.
      bus.subscribe("tool.call.started", (event) => {
        if (this.#state.mode !== "init-chat") return
        const ic = this.#state.initChat
        if (!ic || !ic.running) return
        const props = event.properties || {}
        this.#initPushMessage({
          role: "tool-call",
          text: props.argsSummary || "",
          meta: {
            tool: props.name || "tool",
            callId: props.id,
            status: "running",
            agent: props.agent || "",
            // Agent attribution: depth>0 marks a subagent's nested call so
            // the renderer can indent it and chip it with the subagent type.
            depth: props.depth || 0,
            agentType: props.agentType || null,
          },
        })
      }),
      bus.subscribe("tool.call.completed", (event) => {
        if (this.#state.mode !== "init-chat") return
        const props = event.properties || {}
        const ic = this.#state.initChat
        if (!ic) return
        // Walk back to find the matching tool-call message and flip its status.
        let mutated = false
        const messages = ic.messages.map((m) => {
          if (mutated) return m
          if (m.role === "tool-call" && m.meta?.callId === props.id) {
            mutated = true
            return {
              ...m,
              // completedAt lets the renderer keep a just-finished call visible
              // for a short grace window before folding it into the count.
              meta: { ...m.meta, status: props.ok === false ? "error" : "done", error: props.error || "", completedAt: Date.now() },
            }
          }
          return m
        })
        if (mutated) this.#patch({ initChat: { ...ic, messages } })
      }),
      // init-chat: track each resident agent's run lifecycle so the agent-tree
      // badge reflects whether the AGENT is still working, not merely whether a
      // tool is in flight this instant. Without this, an agent that finished one
      // tool and is thinking before the next (or composing its final result)
      // would falsely read "done" between tool calls.
      bus.subscribe("background.agent.started", (event) => {
        this.#initSetAgentRun(event.properties?.agent, "running")
      }),
      bus.subscribe("background.agent.completed", (event) => {
        this.#initSetAgentRun(event.properties?.agent, "done")
      }),
      bus.subscribe("background.agent.error", (event) => {
        this.#initSetAgentRun(event.properties?.agent, "error")
      }),
      bus.subscribe("agent.ask_user.requested", (event) => {
        if (this.#state.mode !== "init-chat") return
        const ic = this.#state.initChat
        if (!ic) return
        const { id, question, header, options, multiSelect } = event.properties || {}
        if (!id) return
        const choices = Array.isArray(options)
          ? options
              .map((opt) => ({
                label: String(opt?.label || "").trim(),
                description: String(opt?.description || "").trim(),
              }))
              .filter((opt) => opt.label)
          : []
        // Multi-select only applies when there are options to combine.
        const multi = Boolean(multiSelect) && choices.length > 0
        this.#initPushMessage({
          role: "ask-user",
          text: question || "(no question)",
          meta: { questionId: id, header: header || "", options: choices, multiSelect: multi },
        })
        this.#patch({
          initChat: { ...this.#state.initChat, pendingAskUser: { id, question, header: header || "", options: choices, multiSelect: multi } },
        })
      }),
      // ── init-chat: live token counter ──
      // model.call.completed carries real total/input/output token usage for
      // every call in the init run. tool.loop.stream only supplies a temporary
      // live estimate while a still-running streamed call has no usage block yet;
      // tool.loop.step is kept as a stream reset signal to avoid double-counting.
      bus.subscribe("tool.loop.stream", (event) => {
        if (this.#state.mode !== "init-chat") return
        const props = event.properties || {}
        const ic = this.#state.initChat
        if (!matchesInitUsageEvent(ic, props)) return
        this.#patch({
          initChat: { ...ic, streamChars: (ic.streamChars || 0) + (props.chars || 0) },
        })
      }),
      bus.subscribe("tool.loop.step", (event) => {
        if (this.#state.mode !== "init-chat") return
        const props = event.properties || {}
        const ic = this.#state.initChat
        if (!matchesInitUsageEvent(ic, props)) return
        this.#patch({
          initChat: {
            ...ic,
            streamChars: 0,
          },
        })
      }),
    )
    this.#refreshStoryTree()
  }

  // Look up when a job started by reading its activity row's meta.
  #jobStartedAt(jobId) {
    if (!jobId) return null
    const actId = this.#jobActivityIds.get(jobId)
    if (!actId) return null
    const row = this.#state.activity.find((a) => a.id === actId)
    return row?.meta?.startedAt || null
  }

  async #refreshStoryTree() {
    try {
      const PathMod = await import("node:path")
      const path = PathMod.default || PathMod
      const root = paths.root
      // Initial scan: root level only. Subtrees are loaded on demand via
      // expandStoryTreeNode below. The previously-expanded set is re-walked
      // here so a turn-end refresh doesn't collapse what the user opened.
      const baseTree = await walkStoryTree(root, { maxDepth: 0, maxItems: 200 })
      const expanded = Array.isArray(this.#state.storyTreeExpanded)
        ? this.#state.storyTreeExpanded
        : []
      // Walk shortest rels first so a parent is in `result` before any
      // descendant tries to splice in below it.
      const sortedExpanded = [...new Set(expanded)].sort(
        (a, b) => a.split("/").length - b.split("/").length,
      )
      let result = baseTree
      const validExpanded = []
      for (const rel of sortedExpanded) {
        const idx = result.findIndex((e) => e.rel === rel && e.isDir)
        if (idx < 0) continue                       // dir gone — drop from set
        const parent = result[idx]
        const abs = path.join(root, rel)
        const sub = await walkStoryTree(abs, { maxDepth: 0, maxItems: 200 })
        const children = sub.map((e) => ({
          ...e,
          rel: `${rel}/${e.rel}`,
          depth: parent.depth + 1,
        }))
        result = [
          ...result.slice(0, idx),
          { ...parent, loaded: true },
          ...children,
          ...result.slice(idx + 1),
        ]
        validExpanded.push(rel)
      }
      this.#patch({ storyTree: result, storyTreeExpanded: validExpanded })
    } catch { /* ignore */ }
  }

  // Walk one level under `rel` and splice the children into `storyTree`
  // right after the parent entry. Idempotent — re-calls return early if the
  // dir is already expanded.
  async expandStoryTreeNode(rel) {
    if (typeof rel !== "string" || !rel) return
    try {
      const PathMod = await import("node:path")
      const path = PathMod.default || PathMod
      const root = paths.root
      const expanded = Array.isArray(this.#state.storyTreeExpanded)
        ? this.#state.storyTreeExpanded
        : []
      if (expanded.includes(rel)) return
      const cur = Array.isArray(this.#state.storyTree) ? this.#state.storyTree : []
      const idx = cur.findIndex((e) => e.rel === rel && e.isDir)
      if (idx < 0) return
      const parent = cur[idx]
      const abs = path.join(root, rel)
      const sub = await walkStoryTree(abs, { maxDepth: 0, maxItems: 200 })
      const children = sub.map((e) => ({
        ...e,
        rel: `${rel}/${e.rel}`,
        depth: parent.depth + 1,
      }))
      const nextTree = [
        ...cur.slice(0, idx),
        { ...parent, loaded: true },
        ...children,
        ...cur.slice(idx + 1),
      ]
      this.#patch({
        storyTree: nextTree,
        storyTreeExpanded: [...expanded, rel],
      })
    } catch { /* ignore */ }
  }

  // Strip `rel` + every descendant from the tree, and remove `rel` (and any
  // expanded descendants of it) from the expanded set.
  async collapseStoryTreeNode(rel) {
    if (typeof rel !== "string" || !rel) return
    const cur = Array.isArray(this.#state.storyTree) ? this.#state.storyTree : []
    const expanded = Array.isArray(this.#state.storyTreeExpanded)
      ? this.#state.storyTreeExpanded
      : []
    if (!expanded.includes(rel)) return
    const prefix = rel + "/"
    const nextTree = []
    for (const e of cur) {
      if (e.rel === rel) {
        nextTree.push({ ...e, loaded: false })
      } else if (!e.rel.startsWith(prefix)) {
        nextTree.push(e)
      }
    }
    const nextExpanded = expanded.filter((r) => r !== rel && !r.startsWith(prefix))
    this.#patch({ storyTree: nextTree, storyTreeExpanded: nextExpanded })
  }

  // Read a single file under the active story root and return its text +
  // size. Used by the sidebar's file-preview panel. The path validation is
  // strict: rejects absolute paths, `..` segments, and anything that resolves
  // outside the root. We also cap reads at 1 MB so a corrupt or huge file
  // can't lock the renderer or blow context.
  async readStoryFile(rel) {
    const PathMod = await import("node:path")
    const path = PathMod.default || PathMod
    const MAX_BYTES = 1024 * 1024
    if (typeof rel !== "string" || !rel) {
      throw new Error("readStoryFile: rel must be a non-empty string")
    }
    if (rel.includes("\0") || rel.startsWith("/") || rel.startsWith("\\")) {
      throw new Error("readStoryFile: rejected absolute path")
    }
    const normalised = path.posix.normalize(rel.replace(/\\/g, "/"))
    if (normalised.startsWith("..") || normalised.includes("/../") || normalised === "..") {
      throw new Error("readStoryFile: rejected traversal")
    }
    const root = paths.root
    const abs = path.resolve(root, normalised)
    if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
      throw new Error("readStoryFile: path escapes story root")
    }
    const { stat } = await import("node:fs/promises")
    let st
    try {
      st = await stat(abs)
    } catch (error) {
      throw new Error(`readStoryFile: cannot stat ${rel}: ${error.message || error}`)
    }
    if (st.isDirectory()) {
      throw new Error(`readStoryFile: ${rel} is a directory`)
    }
    const size = st.size
    const storyRel = `story/${normalised}`
    const includeKind = isUnderIncludes(storyRel) ? classifyInclude(storyRel) : "unknown"
    if (includeKind === "image" || includeKind === "video" || includeKind === "audio") {
      return {
        rel: normalised,
        kind: includeKind,
        assetRel: storyRel,
        text: "",
        size,
        truncated: false,
        mtimeMs: st.mtimeMs,
      }
    }
    const ext = String(normalised).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ""
    if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "mp4", "webm", "mov", "ogv", "m4v", "mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) {
      return {
        rel: normalised,
        kind: "binary",
        assetRel: null,
        text: "",
        size,
        truncated: false,
        mtimeMs: st.mtimeMs,
      }
    }
    const truncated = size > MAX_BYTES
    const text = truncated
      ? (await readFile(abs)).slice(0, MAX_BYTES).toString("utf8")
      : await readFile(abs, "utf8")
    return { rel: normalised, kind: "text", text, size, truncated, mtimeMs: st.mtimeMs }
  }

  // ---- input editing ----

  setInput(text) {
    this.#patch({ input: String(text || "") })
  }

  // Narrator reveal speed (chars/min). Driven from Settings → Display via the
  // electron prefs; the renderer pushes it here on load and on change. The
  // revealer reads this.#state.pacing.cpm on every tick, so a change takes
  // effect immediately — even mid-stream. Also mirrored to env so any pacing
  // re-derived later in the session (e.g. after a state reset) agrees.
  setNarrationCpm(cpm) {
    const n = Number(cpm)
    if (!Number.isFinite(n)) return
    const cur = this.#state.pacing || {}
    // cpm <= 0 is the "unlimited" sentinel: disable pacing so the revealer
    // dumps each chunk instantly (no per-character typewriter). cpm keeps its
    // last finite value so re-enabling restores the prior speed.
    if (n <= 0) {
      if (cur.enabled === false) return
      this.#patch({ pacing: { ...cur, enabled: false } })
      this.#env.OPENOVEL_DISPLAY_PACING = "0"
      return
    }
    const next = clamp(Math.round(n), 120, 2400)
    if (cur.cpm === next && cur.enabled !== false) return
    this.#patch({ pacing: { ...cur, cpm: next, enabled: true } })
    this.#env.OPENOVEL_DISPLAY_CPM = String(next)
    this.#env.OPENOVEL_DISPLAY_PACING = "1"
  }

  // Append to the input buffer using the VM's own latest state (NOT the
  // caller's snapshot). Necessary because React subscribers see a snapshot
  // captured at render time — two keystrokes that arrive between renders
  // would both compute `snapshot.input + char` from the same stale value and
  // the first character would be lost.
  appendInput(text) {
    if (!text) return
    this.#patch({ input: this.#state.input + String(text) })
  }

  backspaceInput() {
    this.#patch({ input: this.#state.input.slice(0, -1) })
  }

  clearInput() {
    this.#patch({ input: "" })
  }

  // Copy option text into the input field, leaving the user free to edit
  // before submitting. Used by the small "fill" button on the right of
  // each option row.
  pickOption(n) {
    const idx = Number(n) - 1
    const option = this.#state.options[idx]
    if (option) this.#patch({ input: optionLabel(option) })
  }

  // Fill the input AND immediately submit — the natural "execute this option"
  // intent when the user clicks the row body or presses the option's number key.
  async submitOption(n) {
    if (this.#state.busy) return
    const idx = Number(n) - 1
    const option = this.#state.options[idx]
    if (!option) return
    const label = optionLabel(option)
    if (!label) return
    // Submit the option BOUND to its runtime-stamped id so the server can resolve
    // the hidden effect from the immediately-prior recorded turn. Typing the same
    // text by hand carries no binding and earns no baked effect (anti-hack).
    // pickOption (the pencil) deliberately routes through the draft box instead,
    // so editing-then-sending drops the binding by design.
    this.#patch({ input: "" })
    await this.#submitReaderAction(label, { boundOption: { id: option.id, label } })
  }

  // ---- onboarding (state machine) ----

  async #enterOnboarding({ homeWasEmpty }) {
    const locale = resolveOnboardingLocale()
    // Onboarding asks ONLY language; the api-key step is inserted after it and
    // then onboarding finishes. (Richer preferences live in Settings now.)
    const questions = onboardingQuestions(locale)
    const copy = onboardingCopy(locale)
    const resolved = questions[0]
    // The intro / saved / skipped strings live ON the onboarding state and
    // render inside OnboardingPane only. We deliberately do NOT push them
    // as transcript entries: once onboarding ends, they should disappear
    // along with the pane, not linger above the reader's first action.
    this.#patch({
      mode: "onboarding",
      booting: false,
      status: "first-run setup",
      onboarding: {
        // Flow order: language → api-key → remaining questions. Language
        // goes first so the entire onboarding UI (and everything after)
        // can re-render in the user's chosen language before they're
        // asked to do anything else.
        phase: "language",
        step: 0,
        locale,
        questions,
        answers: [],
        homeWasEmpty,
        intro: copy.intro,
        defaultLabel: copy.defaultLabel,
        skippedText: copy.skipped,
        savedText: copy.saved,
        currentQuestion: resolved,
        done: false,
      },
    })
  }

  // Advance from the API-key step into the remaining preference questions.
  // Called from the OnboardingModal's "Continue →" button. Language has
  // already been answered (it was step 1), so we jump straight to
  // questions[1] = style_sample.
  async advanceOnboardingFromApiKey() {
    const ob = this.#state.onboarding
    if (!ob || ob.phase !== "api-key") return
    const nextStep = 1
    const nextQuestion = ob.questions[nextStep]
    if (!nextQuestion) {
      // No more questions after language — finish onboarding.
      await savePreferenceOnboarding(ob.answers)
      this.#patch({ mode: "idle", status: "ready", onboarding: null, input: "" })
      if (!isOn(this.#env.OPENOVEL_SKIP_STORY_SELECTOR, false)) {
        await this.#enterStorySelector()
      }
      return
    }
    this.#patch({
      onboarding: {
        ...ob,
        phase: "questions",
        step: nextStep,
        currentQuestion: nextQuestion,
      },
      input: "",
    })
  }

  // Step back one position in the onboarding flow:
  //   language → (nothing, first step)
  //   api-key  → language
  //   questions[1] (style_sample) → api-key
  //   questions[k] (k>1) → questions[k-1]
  // Pops the corresponding answer so re-submitting doesn't double-record.
  async goBackInOnboarding() {
    const ob = this.#state.onboarding
    if (!ob || this.#state.mode !== "onboarding") return
    if (ob.phase === "language") return                              // already at the first step
    if (ob.phase === "api-key") {
      // Go back to language; pop its answer so submitting language again
      // re-resolves locale cleanly.
      this.#patch({
        onboarding: {
          ...ob,
          phase: "language",
          step: 0,
          answers: ob.answers.filter((a) => a.id !== "language"),
          currentQuestion: ob.questions[0],
        },
        input: "",
      })
      return
    }
    // phase === "questions"
    if ((ob.step || 0) <= 1) {
      // The first question step is style_sample at index 1 — going back
      // from here lands at the api-key step (language stays answered).
      this.#patch({
        onboarding: {
          ...ob,
          phase: "api-key",
          step: 0,
          // Drop any answers later than language so we don't double-record
          // on re-advance.
          answers: ob.answers.filter((a) => a.id === "language"),
        },
        input: "",
      })
      return
    }
    const prevStep = ob.step - 1
    // answers carries [language, ...subsequent]. Trim subsequent down to
    // prevStep - 1 entries (the language entry is always answer[0]).
    const keepCount = 1 + (prevStep - 1)
    this.#patch({
      onboarding: {
        ...ob,
        step: prevStep,
        answers: ob.answers.slice(0, keepCount),
        currentQuestion: ob.questions[prevStep],
      },
      input: "",
    })
  }

  async answerOnboarding(answer) {
    const ob = this.#state.onboarding
    if (!ob || this.#state.mode !== "onboarding") return
    const trimmed = String(answer || "").trim()
    if (isOnboardingSkip(trimmed)) return this.skipOnboarding()

    const q = ob.currentQuestion
    const normalizedAnswer =
      q.id === "language"
        ? normalizeLanguagePreference(trimmed, { fallback: q.fallback })
        : trimmed
    const newAnswers = [
      ...ob.answers,
      {
        id: q.id,
        answer: normalizedAnswer,
        context: q.context || "",
        fallback: q.fallback,
        memoryPrefix: q.memoryPrefix,
      },
    ]

    let locale = ob.locale
    let questions = ob.questions
    // After the language answer we re-resolve the locale so the remaining
    // questions (and their tag-group labels) localize correctly.
    if (q.id === "language") {
      locale = localeFromLanguagePreference(normalizedAnswer, locale)
      questions = onboardingQuestions(locale)
    }

    // Language is the FIRST step (phase: "language") — after answering it
    // we jump into the api-key step instead of advancing the question
    // index. ob.step stays at 0 so that when api-key completes,
    // advanceOnboardingFromApiKey can resume at questions[1] (style_sample).
    if (ob.phase === "language") {
      this.#patch({
        onboarding: {
          ...ob,
          phase: "api-key",
          locale,
          questions,
          answers: newAnswers,
          // currentQuestion stays pointing at the language question for
          // the goBackInOnboarding restore path.
        },
        input: "",
      })
      return
    }

    const nextStep = ob.step + 1
    if (nextStep >= questions.length) {
      // Done — save + transition into the story selector.
      await savePreferenceOnboarding(newAnswers)
      this.#patch({ mode: "idle", status: "ready", onboarding: null, input: "" })
      if (!isOn(this.#env.OPENOVEL_SKIP_STORY_SELECTOR, false)) {
        await this.#enterStorySelector()
      }
      return
    }

    // All questions are now static — no LLM materialization needed.
    const nextBase = questions[nextStep]

    this.#patch({
      onboarding: {
        ...ob,
        step: nextStep,
        locale,
        questions,
        answers: newAnswers,
        currentQuestion: nextBase,
      },
      input: "",
    })
  }

  async skipOnboarding() {
    const ob = this.#state.onboarding
    if (!ob) return
    await savePreferenceOnboarding(ob.answers, { skipped: true })
    this.#patch({ mode: "idle", status: "ready", onboarding: null, input: "" })
    if (!isOn(this.#env.OPENOVEL_SKIP_STORY_SELECTOR, false)) {
      await this.#enterStorySelector()
    }
  }

  // ---- compose mode (multi-line worldbook entry) ----

  appendCompose(text) {
    const c = this.#state.compose
    if (!c) return
    const buffer = c.buffer + String(text || "")
    this.#patch({
      compose: { ...c, buffer, cursor: buffer.length, submittable: buffer.trim().length > 0 },
    })
  }

  // Wholesale buffer replacement — used by the Electron textarea path so
  // it can stay uncontrolled (required for IME composition: pinyin/zhuyin
  // /kana inputs need to own the DOM value until the user confirms a
  // candidate, otherwise React's value-restore breaks the composition).
  setComposeBuffer(text) {
    const c = this.#state.compose
    if (!c) return
    const buffer = String(text || "")
    this.#patch({
      compose: { ...c, buffer, cursor: buffer.length, submittable: buffer.trim().length > 0 },
    })
  }

  backspaceCompose() {
    const c = this.#state.compose
    if (!c || !c.buffer) return
    const buffer = c.buffer.slice(0, -1)
    this.#patch({
      compose: { ...c, buffer, cursor: buffer.length, submittable: buffer.trim().length > 0 },
    })
  }

  newlineCompose() {
    this.appendCompose("\n")
  }

  beginPaste() {
    if (this.#state.compose) {
      this.#patch({ compose: { ...this.#state.compose, pasteActive: true } })
    }
  }

  endPaste() {
    if (this.#state.compose) {
      this.#patch({ compose: { ...this.#state.compose, pasteActive: false } })
    }
  }

  cancelCompose() {
    if (!this.#state.compose) return
    this.#patch({ mode: "idle", compose: null, status: "compose cancelled" })
  }

  async submitCompose() {
    const c = this.#state.compose
    if (!c || !c.submittable) return
    const worldbook = c.buffer
    this.#patch({ busy: true, status: `preparing new story…` })
    // Background jobs are pinned to the story they started on (storyContext.js),
    // so we no longer block the switch on them — only the unpinned foreground
    // turn (which mutates shared VM state, not just files) must settle first.
    await this.#drainBeforeSwitch()
    try {
      this.#setStatus(`creating story "${c.storyName}"…`)
      const created = await createStory({ name: c.storyName })
      switchActiveStory({ id: created.id })
      // Point currentStory at the new root NOW, not only in the post-init
      // patch below: the initializer job's events are story-root-filtered
      // against it (#isForeignStoryEvent / isForeignStoryJob), and a stale
      // descriptor would hide the init's status/tool stream.
      this.#patch({ currentStory: currentStoryDescriptor({ env: this.#env }) })
      backgroundJobs.reset()
      sessionProcessor.reset()
      await initializeStory()
      await backgroundJobs.bindLedger({ path: paths.jobsLedger })
      this.#setStatus(`initializing from worldbook (${worldbook.length} chars)…`)
      const init = await sessionProcessor.initializeFromWorldbook({ worldbook, sourceHint: "compose" })
      // initializeFromWorldbook returns { job, ready } — `ready` resolves when
      // the initializer agent has actually written FOREGROUND.md and seeded
      // chapters.md. Without this second await, the auto-trigger below fires
      // the first narrator turn against an empty working set and the narrator
      // hallucinates an opening unrelated to the worldbook.
      await init.ready
      const snap = await getStorySnapshot()
      // Close compose pane, switch to idle, then immediately auto-trigger
      // the opening narration so the reader sees prose right away instead of
      // an empty transcript with a blinking cursor.
      this.#patch({
        mode: "idle",
        compose: null,
        busy: false,
        status: "story ready · generating opening…",
        currentStory: await describeCurrentStoryWithName({ env: this.#env }),
        foregroundGuidance: snap.foregroundGuidance || "",
        inboxCount: snap.backgroundInboxItems?.length || 0,
        options: [],
        decisionFraming: "",
      })
      this.#refreshStoryTree()
      await this.#autoTriggerOpening(worldbook)
    } catch (error) {
      this.#patch({ busy: false, mode: "composing-worldbook", status: "error" })
      this.#pushEntry({ type: "error", text: `Failed to create story: ${error.message || error}` })
    }
  }

  // Right after init the narrator has full context (FOREGROUND.md with its
  // Prelude, context cards, MEMORY.md) but no reader action to react to.
  // Submit a generic, locale-aware "open the scene" directive so the user
  // gets prose immediately. The narrator's contract treats it as the
  // reader's first input.
  //
  // `localeHint` is any prose used to pick the trigger language — usually
  // the worldbook (legacy paste flow) or the freshly-written FOREGROUND.md
  // (init-chat flow). CJK characters anywhere in the hint switch the
  // trigger to Chinese.
  async #autoTriggerOpening(localeHint) {
    // Shared with the init narration preview so the rehearsal opens on the SAME
    // instruction the reader's first turn does (see narrator.openingTriggerAction).
    const { openingTriggerAction } = await import("../lib/narrator.js")
    await this.#submitReaderAction(openingTriggerAction(localeHint), { suppressUserEntry: true })
  }

  // ---- submit / slash dispatch ----

  async submit() {
    if (this.#state.busy) return
    if (this.#state.mode === "story-selector") {
      return this.confirmStorySelection()
    }
    if (this.#state.mode === "story-naming") {
      return this.confirmStoryName()
    }
    // Onboarding's prose-reference / style-tags questions are explicitly
    // optional — pressing Continue with an empty answer must advance to
    // the next step (answerOnboarding fills in the fallback). Earlier we
    // short-circuited on `!action`, which silently dropped the click.
    if (this.#state.mode === "onboarding") {
      const action = this.#state.input.trim()
      this.#patch({ input: "" })
      await this.answerOnboarding(action)
      return
    }
    const action = this.#state.input.trim()
    if (!action) return
    this.#patch({ input: "" })
    if (action === "/options" || action.startsWith("/options ")) {
      this.#pushEntry({ type: "user", text: action })
      const next = parseOptionsCommand(action, this.#state.optionsEnabled)
      this.#patch({ optionsEnabled: next, options: next ? this.#state.options : [] })
      this.#pushEntry({
        type: "system",
        text: `Options are now ${next ? "enabled" : "disabled"}. Free-form input always works.`,
      })
      return
    }
    if (action === "/help" || action === "/?") {
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({ type: "system", text: helpText() })
      return
    }
    if (action === "/providers") {
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({ type: "system", text: providerDoctorText() })
      return
    }
    if (action === "/config") {
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({ type: "system", text: configDoctorText() })
      return
    }
    if (action === "/memory") {
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({ type: "system", text: await memoryText() })
      return
    }
    if (action === "/stories") {
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({ type: "system", text: await storiesText() })
      return
    }
    if (action === "/transactions" || action.startsWith("/transactions ")) {
      this.#pushEntry({ type: "user", text: action })
      const argv = parseSlashArgs(action)
      const limit = Number(argv.positional[1] || argv.options.limit || 20)
      this.#pushEntry({ type: "system", text: await transactionsText({ limit }) })
      return
    }
    if (action === "/permissions" || action.startsWith("/permissions ")) {
      this.#pushEntry({ type: "user", text: action })
      const argv = parseSlashArgs(action)
      const status = argv.positional[1] || argv.options.status || "pending"
      const limit = Number(argv.positional[2] || argv.options.limit || 20)
      this.#pushEntry({ type: "system", text: await permissionsText({ status, limit, ledgerPath: this.#permissionLedgerPath() }) })
      return
    }
    if (action.startsWith("/approve")) {
      this.#pushEntry({ type: "user", text: action })
      try {
        const argv = parseSlashArgs(action)
        this.#pushEntry({ type: "system", text: await approvePermissionText(argv.positional[1], { ledgerPath: this.#permissionLedgerPath() }) })
      } catch (error) {
        this.#pushEntry({ type: "error", text: error.message || String(error) })
      }
      return
    }
    if (action.startsWith("/deny")) {
      this.#pushEntry({ type: "user", text: action })
      try {
        const argv = parseSlashArgs(action)
        const reason = argv.positional.slice(2).join(" ")
        this.#pushEntry({ type: "system", text: await denyPermissionText(argv.positional[1], reason, { ledgerPath: this.#permissionLedgerPath() }) })
      } catch (error) {
        this.#pushEntry({ type: "error", text: error.message || String(error) })
      }
      return
    }
    if (action.startsWith("/rollback")) {
      this.#pushEntry({ type: "user", text: action })
      try {
        const argv = parseSlashArgs(action)
        this.#pushEntry({ type: "system", text: await rollbackTransactionText(argv.positional[1]) })
        await this.#refreshStoryTree()
      } catch (error) {
        this.#pushEntry({ type: "error", text: error.message || String(error) })
      }
      return
    }
    if (action === "/context" || action === "/recompile-context") {
      this.#pushEntry({ type: "user", text: action })
      try {
        const snapshot = await getStorySnapshot()
        const compiled = await compileForegroundContext({ snapshot, action: "manual context inspection" })
        const { formatContextReport } = await import("../context/contextCompiler.js")
        this.#pushEntry({ type: "system", text: formatContextReport(compiled.report) })
      } catch (error) {
        this.#pushEntry({ type: "error", text: error.message || String(error) })
      }
      return
    }
    if (action === "/preferences" || action.startsWith("/preferences ")) {
      this.#pushEntry({ type: "user", text: action })
      await this.#handlePreferencesCommand(action)
      return
    }
    if (action.startsWith("/new-story") || action.startsWith("/switch-story")) {
      this.#pushEntry({ type: "user", text: action })
      await this.#handleStoryCommand(action)
      return
    }
    if (action.startsWith("/")) {
      // Unknown slash command — surface as system message
      this.#pushEntry({ type: "user", text: action })
      this.#pushEntry({
        type: "system",
        text: `Unknown command "${action.split(/\s+/)[0]}". Try /help for the list.`,
      })
      return
    }

    // Free-form reader action
    await this.#submitReaderAction(action)
  }

  // Submit the current reader input verbatim as a story action, skipping the
  // slash-command dispatch in submit(). The Electron client disables typed slash
  // commands in the reader box (it exposes those functions through menus/modals),
  // so a "/"-prefixed line there is just narration input. Callers that want
  // typed slash commands can still call submit() directly.
  async submitReaderText() {
    if (this.#state.busy) return
    if (this.#state.mode !== "idle") return
    const action = this.#state.input.trim()
    if (!action) return
    this.#patch({ input: "" })
    await this.#submitReaderAction(action)
  }

  async #submitReaderAction(action, { suppressUserEntry = false, boundOption = null } = {}) {
    const submittedAtMs = Date.now()
    // comicPanelsLive is per-turn (index-keyed): a new action opens a new
    // index space, so stale statuses from the previous turn must not gate it.
    this.#patch({ busy: true, status: "foreground narrator", comicPanelsLive: {} })
    if (!suppressUserEntry) {
      this.#pushEntry({ type: "user", text: action })
    }

    // Begin live-stream tracking for the demo sidebar's foreground ticker.
    // We count chars (CJK ≈ 1:1 with tokens) since OpenAI-compat streaming
    // never emits per-delta usage. Each char arrives via onForegroundChunk.
    this.#patch({
      liveStream: { source: "Narrator", chars: 0, startedAt: Date.now() },
    })

    // TTS karaoke: when streaming text-to-speech is active, segment the
    // narration into sentences AS IT STREAMS and publish each on the bus. The
    // main-process bridge synthesizes audio; the renderer plays it gaplessly and
    // reveals text in lockstep. The gate in narrator.js only forwards the
    // accepted attempt's text (a suppressed/retried attempt forwards nothing),
    // so the chunks we segment here are always the committed narration.
    const ttsActive = isTtsActive(this.#env)
    const ttsTurnId = ttsActive ? makeId("ttsturn") : null
    const ttsBuffer = ttsActive ? createSentenceBuffer() : null
    let ttsSeq = 0
    if (ttsActive) {
      // A new reader turn supersedes any audio still playing from the last one.
      bus.publish("tts.cancel", {})
    }
    const publishTtsSentences = (sentences) => {
      for (const text of sentences) {
        bus.publish("tts.sentence", { turnId: ttsTurnId, seq: ttsSeq++, text })
      }
    }
    let pendingStreamChars = 0
    let streamCounterTimer = null
    const flushStreamCounters = () => {
      if (!pendingStreamChars) return
      const n = pendingStreamChars
      pendingStreamChars = 0
      const cur = this.#state.liveStream
      this.#patch({
        liveStream: cur ? { ...cur, chars: cur.chars + n } : { source: "Narrator", chars: n, startedAt: Date.now() },
      })
      this.#bumpAggregate({ charactersStreamed: n })
    }
    const scheduleStreamCounterFlush = () => {
      if (streamCounterTimer) return
      streamCounterTimer = setTimeout(() => {
        streamCounterTimer = null
        flushStreamCounters()
      }, LIVE_STREAM_COUNTER_FLUSH_MS)
    }
    const stopStreamCounterFlush = () => {
      if (streamCounterTimer) clearTimeout(streamCounterTimer)
      streamCounterTimer = null
      flushStreamCounters()
    }

    let revealer = null
    try {
      revealer = this.#createNarrationRevealer({ ttsTurnId })
      revealer.start()
      // Track the turn so #drainBeforeSwitch can await its canon writes before a
      // story switch repoints the env. (The writes finish when this resolves;
      // the revealer below is just UI pacing.)
      const turnPromise = sessionProcessor.processReaderAction({
        action,
        boundOption,
        // Suppressed actions (the internal opening kickoff) are also flagged
        // `hidden` on the persisted reader_action so transcript replay never
        // re-surfaces them after a reload.
        hidden: suppressUserEntry,
        optionsEnabled: this.#state.optionsEnabled,
        submittedAtMs,
        onForegroundChunk: (chunk) => {
          revealer.push(chunk)
          if (ttsBuffer) publishTtsSentences(ttsBuffer.push(chunk))
          // Update the live ticker. The aggregate counter ticks up too, so
          // the "total chars this session" number visibly moves.
          const n = String(chunk || "").length
          if (n > 0) {
            pendingStreamChars += n
            scheduleStreamCounterFlush()
          }
        },
      })
      this.#activeReaderTurn = turnPromise
      let result
      try {
        result = await turnPromise
      } finally {
        if (this.#activeReaderTurn === turnPromise) this.#activeReaderTurn = null
      }
      if (ttsActive) {
        // All chunks have been forwarded by now — flush any trailing clause and
        // signal the turn is complete so the bridge knows no more audio follows.
        publishTtsSentences(ttsBuffer.flush())
        bus.publish("tts.turn_end", { turnId: ttsTurnId })
      }
      stopStreamCounterFlush()
      revealer.complete(result.foreground.narration)
      await revealer.finish()
      // Stream done; clear the live ticker.
      this.#patch({ liveStream: null })
      const bgJobCount = [result.signalJob, result.job, result.memoryJob].filter(Boolean).length
      let status = `background launched ${bgJobCount} jobs`
      if (result.profile) {
        await persistUsageProfile(result.profile)
        const summary = result.profile.summary || {}
        if (summary.modelCalls) {
          // Note: aggregate increments already happened live via the
          // `model.call.completed` events for each call inside this turn.
          // Here we only synthesise the human-readable status string.
          const cost = Number(summary.estimatedCostUSD || 0).toFixed(4)
          const inTokens = summary.inputTokens || 0
          const outTokens = summary.outputTokens || 0
          const cacheRead = summary.cacheReadInputTokens || 0
          const cacheRatio = inTokens > 0 ? Math.round((cacheRead / inTokens) * 100) : 0
          const cacheHint = inTokens > 0 ? ` cache=${cacheRatio}%` : ""
          status = `turn ok · in=${inTokens} out=${outTokens}${cacheHint} cost=$${cost} · bg=${bgJobCount}`
        }
      }
      this.#patch({
        // Display-only options (id + label + key); the hidden effect stays in the
        // recorded turn (scene_log) and is resolved server-side on selection.
        options: this.#state.optionsEnabled ? (result.foreground.options || []).map(toDisplayOption) : [],
        decisionFraming: this.#state.optionsEnabled ? (result.foreground.framing || "") : "",
        status,
        busy: false,
        mode: "idle",
        lastError: null,    // success — clear any stale connection-error banner
      })
    } catch (error) {
      stopStreamCounterFlush()
      if (ttsActive) bus.publish("tts.cancel", { turnId: ttsTurnId })
      revealer?.abort()
      this.#pushEntry({ type: "error", text: formatNarratorError(error) })
      this.#patch({
        busy: false,
        status: "connection failed — check Settings → API Keys",
        mode: "idle",
        liveStream: null,
        lastError: {
          kind: classifyError(error),
          message: error?.message || String(error),
          at: new Date().toISOString(),
        },
      })
    }
  }

  #permissionLedgerPath() {
    return storyPaths({ env: this.#env }).permissionsLedger
  }

  // ---- slash command handlers (private) ----

  async #handlePreferencesCommand(action) {
    const argv = parseSlashArgs(action)
    const sub = argv.positional[1] || ""
    if (sub === "reset") {
      const keepResearch = argv.flags.has("keep-research")
      try {
        const result = await resetPreferenceOnboarding({ keepResearch })
        const lines = [
          "Preference state cleared.",
          `  user memory: ${result.removed.userMemory ? "reset" : "(unchanged)"}`,
          `  onboarding marker: ${result.removed.marker ? "removed" : "(absent)"}`,
          `  shared references: ${result.removed.references ? "reset" : (keepResearch ? "kept" : "(unchanged)")}`,
          "",
          "Restart without OPENOVEL_SKIP_ONBOARDING to re-run the 3-question flow.",
        ]
        this.#pushEntry({ type: "system", text: lines.join("\n") })
      } catch (error) {
        this.#pushEntry({ type: "error", text: error.message || String(error) })
      }
      return
    }
    if (sub && sub !== "show") {
      this.#pushEntry({
        type: "system",
        text: `Unknown subcommand "${sub}". Try /preferences | /preferences reset [--keep-research]`,
      })
      return
    }
    try {
      const snap = await getPreferenceSnapshot()
      const lines = [
        `marker: ${snap.markerExists ? snap.markerPath : "(none — onboarding has not completed)"}`,
        `user memory: ${snap.userMemoryPath}`,
        snap.entries.length ? `\n${snap.entries.length} saved entries:` : "\n(no saved preference entries)",
        ...snap.entries.map((e, i) => `  ${i + 1}. ${truncate(e, 200)}`),
      ]
      this.#pushEntry({ type: "system", text: lines.join("\n") })
    } catch (error) {
      this.#pushEntry({ type: "error", text: error.message || String(error) })
    }
  }

  async #handleStoryCommand(action) {
    const argv = parseSlashArgs(action)
    const verb = argv.positional[0]
    const name = argv.positional[1]
    if (!name) {
      this.#pushEntry({
        type: "system",
        text:
          verb === "/new-story"
            ? "Usage: /new-story <name> [--worldbook <path>] [--empty]"
            : "Usage: /switch-story <name>  (use \"(project)\" for the project-local ./story)",
      })
      return
    }

    if (verb === "/new-story" && !argv.flags.has("worldbook") && !argv.flags.has("empty")) {
      // Open a dedicated compose pane. Nothing is created on disk yet — the
      // story is only materialized on submit. The pane itself shows the
      // keymap, so we don't push a transcript entry that would linger after
      // the pane closes.
      this.#patch({
        mode: "composing-worldbook",
        compose: {
          storyName: name,
          buffer: "",
          cursor: 0,
          pasteActive: false,
          submittable: false,
        },
        status: `composing worldbook for "${name}"…`,
      })
      return
    }

    // From here on: --empty, --worldbook <path>, or /switch-story <name>
    let target
    try {
      if (verb === "/new-story") {
        const created = await createStory({ name })
        target = { id: created.id, root: created.root, isProjectLocal: false }
      } else {
        if (name === PROJECT_LOCAL_ID) {
          target = { id: PROJECT_LOCAL_ID, isProjectLocal: true }
        } else {
          const { listStories } = await import("../lib/storyDirectory.js")
          const stories = await listStories()
          const match = stories.find((s) => s.id === name && !s.isProjectLocal)
          if (!match) {
            this.#pushEntry({
              type: "error",
              text: `No story "${name}". Run /stories to see what exists.`,
            })
            return
          }
          target = { id: match.id, root: match.root, isProjectLocal: false }
        }
      }
    } catch (error) {
      this.#pushEntry({ type: "error", text: error.message || String(error) })
      return
    }

    this.#setStatus(`switching to ${target.id}…`)
    // Background jobs are pinned to the story they started on (storyContext.js),
    // so we no longer block the switch on them — only the unpinned foreground
    // turn (which mutates shared VM state, not just files) must settle first.
    await this.#drainBeforeSwitch()
    switchActiveStory({ id: target.id })
    // Same as the compose path: repoint currentStory before the initializer
    // runs, so its events pass the story-root filters and reach the feed.
    this.#patch({ currentStory: currentStoryDescriptor({ env: this.#env }) })
    backgroundJobs.reset()
    sessionProcessor.reset()
    await initializeStory()
    await backgroundJobs.bindLedger({ path: paths.jobsLedger })

    if (verb === "/new-story" && argv.flags.has("worldbook")) {
      const wb = argv.options.worldbook
      this.#setStatus(`initializing from ${wb}…`)
      try {
        const text = await readFile(wb, "utf8")
        const init = await sessionProcessor.initializeFromWorldbook({ worldbook: text, sourceHint: wb })
        await init.ready
      } catch (error) {
        this.#pushEntry({ type: "error", text: `Initializer failed: ${error.message || error}` })
      }
    }

    const snap = await getStorySnapshot()
    this.#patch({
      currentStory: await describeCurrentStoryWithName({ env: this.#env }),
      foregroundGuidance: snap.foregroundGuidance || "",
      inboxCount: snap.backgroundInboxItems?.length || 0,
      options: [],
      decisionFraming: "",
      status: "idle",
    })
    this.#pushEntry({
      type: "system",
      text: `Now active: ${target.id}${target.isProjectLocal ? " (project-local ./story)" : ""}`,
    })
  }

  // ---- narration revealer ----

  // Mirrors the original tui.js revealer but pushes through #patch / #replaceLastEntry
  // so subscribers see one batched state emit per microtask even at high CPM.
  #createNarrationRevealer({ ttsTurnId = null } = {}) {
    const entryId = makeId("entry")
    let target = ""
    let started = false
    let done = false
    let timer = null
    let resolveFinish
    const finished = new Promise((resolve) => { resolveFinish = resolve })

    const ensureStarted = () => {
      if (started) return
      started = true
      // Tag the entry with the TTS turn id so the renderer can show the
      // audio-driven (karaoke) reveal for it instead of the CPM-paced text
      // while narration is being spoken.
      const entry = { id: entryId, type: "narration", text: "", complete: false, pending: true }
      if (ttsTurnId) entry.tts = ttsTurnId
      this.#patch({
        entries: trimEntries(
          [...this.#state.entries, entry],
          this.#entryMax,
        ),
      })
    }

    const currentText = () => {
      const e = this.#state.entries.find((x) => x.id === entryId)
      return e ? e.text : ""
    }

    const setText = (text, complete = false) => {
      const entries = this.#state.entries.map((e) =>
        e.id === entryId ? { ...e, text, complete, pending: !complete && !String(text || "").length } : e,
      )
      this.#patch({ entries: trimEntries(entries, this.#entryMax) })
    }

    const abort = () => {
      done = true
      if (timer) clearTimeout(timer)
      timer = null
      const entry = this.#state.entries.find((e) => e.id === entryId)
      if (!entry) {
        resolveFinish()
        return
      }
      if (!String(entry.text || "").length) {
        this.#patch({
          entries: trimEntries(
            this.#state.entries.filter((e) => e.id !== entryId),
            this.#entryMax,
          ),
        })
      } else {
        setText(entry.text, true)
      }
      resolveFinish()
    }

    const finishIfReady = () => {
      if (done && currentText().length >= target.length) {
        if (timer) clearTimeout(timer)
        timer = null
        setText(target, true)
        resolveFinish()
        return true
      }
      return false
    }

    const tick = () => {
      timer = null
      const text = currentText()
      if (text.length < target.length) {
        const pacing = this.#state.pacing
        // `ovl:` fences (include/hud/music/bg/panel…) are control and render
        // channels, not prose: the typewriter SKIPS them whole. The moment the
        // cursor reaches a fence it jumps past everything that has streamed in
        // (one atomic paint), so the raw fence text never types out in front
        // of the reader. The includes() guard keeps fence-free narration on
        // the normal path with zero extra cost.
        if (target.includes("```ovl:")) {
          const skipTo = richFenceSkipEnd(target, text.length)
          if (skipTo > text.length) {
            setText(target.slice(0, skipTo))
            timer = setTimeout(tick, pacing.frameMs)
            return
          }
        }
        // Advance by one reveal unit: a whole Latin/numeric word, or a single
        // CJK glyph, or a whitespace/punctuation run. This makes Western text
        // appear word-by-word at word-reading speed while CJK (no word
        // boundaries) still streams glyph-by-glyph.
        const unit = nextRevealUnit(target, text.length)
        const next = Math.min(target.length, unit.end)
        const unitText = target.slice(text.length, next)
        setText(target.slice(0, next))
        const lastChar = target[next - 1] || ""
        const unitDelay = revealUnitDelayMs(unit.kind, unitText, pacing)
        const punct = pacing.punctuation ? punctuationDelayMs(lastChar) : 0
        timer = setTimeout(tick, unitDelay + punct)
        return
      }
      if (!finishIfReady()) timer = setTimeout(tick, this.#state.pacing.frameMs)
    }

    const schedule = () => {
      if (!timer && !finishIfReady()) timer = setTimeout(tick, 0)
    }

    return {
      start: () => {
        ensureStarted()
      },
      push: (chunk) => {
        const text = String(chunk || "")
        if (!text) return
        ensureStarted()
        if (!this.#state.pacing.enabled) {
          target += text
          setText(target)
          return
        }
        target += text
        schedule()
      },
      complete: (finalText) => {
        const text = String(finalText || "")
        ensureStarted()
        if (text && text.length >= target.length) target = text
        done = true
        if (!this.#state.pacing.enabled) {
          setText(target, true)
          resolveFinish()
          return
        }
        schedule()
      },
      finish: () => finished,
      abort,
    }
  }

  // ---- private utility ----

  // Drain in-flight background work BEFORE switching the active story or
  // resetting the job registry. CRITICAL for data integrity: a running job
  // (esp. the Storykeeper) resolves its write paths against the LIVE env, and
  // backgroundJobs.reset() only clears the registry — it does NOT abort the
  // running promise. If we flip OPENOVEL_STORY_ID (or reset the registry, which
  // then hides the job from the drainer) while a Storykeeper write is mid-flight,
  // its writeForegroundGuidance lands on the NEW story's foreground/*.md files —
  // overwriting them with the previous story's content. Waiting for running jobs
  // to finish first makes their writes land on the correct (old) story.
  async #drainBeforeSwitch() {
    // Record who is mid-run BEFORE anything else, while the env still points
    // at the story being left: the reopen path uses this snapshot (cross-
    // checked against the jobs ledger) to re-wake agents that never finished.
    // Written only when something is actually running — see agentResume.js.
    try {
      const { writeAgentResumeSnapshot } = await import("./agentResume.js")
      await writeAgentResumeSnapshot({ registry: backgroundJobs })
    } catch { /* snapshot is best-effort; reopen also scans pending inboxes */ }
    // Stop any narration audio immediately — we're leaving this story.
    bus.publish("tts.cancel", {})
    // Let any in-flight FOREGROUND turn finish before the env flips. Unlike
    // background jobs, the foreground turn is NOT pinned (it mutates shared VM
    // state — the narration revealer, entries, options — not just files), so we
    // still await it. It's bounded by model latency (NOT local display pacing)
    // and is usually already settled by the time the reader chooses to switch.
    if (this.#activeReaderTurn) {
      this.#setStatus("finishing the current turn…")
      try { await this.#activeReaderTurn } catch { /* turn errors are surfaced by submit() */ }
    }
    // Background jobs (Storykeeper, memory-review, signal) are deliberately NOT
    // waited for: each is pinned to the story it started on (storyContext.js),
    // so it finishes writing to its OWN story even after the switch — no
    // pollution, no work lost. The switch is therefore instant once the
    // foreground turn settles, instead of blocking up to 15s on the slow loop.
  }

  // (removed) #waitForAllBackgroundJobs — switch paths no longer block on the
  // slow loop; background jobs are pinned to their origin story (storyContext.js).
}

// ---------- shared helpers ----------

function parseOptionsCommand(action, current) {
  const value = String(action || "").trim().split(/\s+/)[1]
  if (!value) return !current
  if (TRUTHY.has(value.toLowerCase()) || ["enable", "enabled"].includes(value.toLowerCase())) return true
  if (FALSY.has(value.toLowerCase()) || ["disable", "disabled"].includes(value.toLowerCase())) return false
  return current
}

// Build the status line shown after a background job completes. Distinguishes
// job type so the user doesn't see "storykeeper complete" when only the
// memory-review job finished, and surfaces the inbox-pending count when
// storykeeper bailed out with leftover work (dead-loop guard fired but items
// stayed unresolved — they'll be retried on the next reader action).
function formatJobCompletedStatus(jobType, inboxItems) {
  if (jobType === "storykeeper") {
    if (inboxItems > 0) return `storykeeper paused · ${inboxItems} inbox pending (retries on next turn)`
    return "storykeeper complete"
  }
  if (jobType === "memory-review") return "memory review complete"
  if (jobType === "background-signal") return "signal extracted"
  if (jobType === "initializer") return "story initialized"
  if (jobType === "subagent") return "subagent complete"
  return `${jobType} complete`
}

function isOnboardingSkip(value) {
  return ["/skip", "skip", "跳过"].includes(String(value || "").trim().toLowerCase())
}

function truncate(text, width) {
  const str = String(text || "")
  if (str.length <= width) return str
  return str.slice(0, Math.max(0, width - 1)) + "…"
}

function helpText() {
  return [
    "Slash commands:",
    "  /help                       This help.",
    "  /providers                  Show provider routing + key status.",
    "  /config                     Show settings layering + effective config.",
    "  /context                    Compile foreground context for inspection.",
    "  /memory                     Print story + user memory snapshot.",
    "  /recompile-context          Re-compile + diff foreground context.",
    "  /options [on|off]           Toggle the post-narration options call.",
    "",
    "  /preferences                Show current saved preferences.",
    "  /preferences reset [--keep-research]",
    "                              Clear preferences (and references unless kept);",
    "                              next start re-runs onboarding.",
    "",
    "  /stories                    List all known stories + which is active.",
    "  /transactions [limit]       List recent file transactions.",
    "  /rollback <txId>            Restore files from a transaction's before snapshot.",
    "  /permissions [pending|all]  List permission requests.",
    "  /approve <id>               Approve a pending permission request.",
    "  /deny <id> [reason]         Deny a pending permission request.",
    "  /new-story <name>           Open a multi-line editor for the worldbook;",
    "                              Ctrl-D submits and creates the story, Esc cancels.",
    "  /new-story <name> --worldbook <path>",
    "                              Same, but seed the worldbook from a markdown file.",
    "  /new-story <name> --empty   Create + switch with no initial worldbook.",
    "  /switch-story <name>        Hot-switch to an existing story",
    "                              (name = \"(project)\" for project-local ./story).",
    "",
    "Anything else is treated as a reader action.",
    "Ctrl-C to exit.",
  ].join("\n")
}
