import vm from "node:vm"
import { stat } from "node:fs/promises"
import { appendJsonl, readJson, readText, writeAtomic } from "../lib/files.js"
import { enqueueBackgroundInbox, getForegroundTurnCount, initializeStory, paths } from "../lib/storyStore.js"
import { resolveWorkspacePath } from "../lib/workspacePaths.js"

const VERSION = 1
const DEFAULT_MONITOR_SOURCE = "foreground"
const MAX_MONITORS = 50
const MAX_LOOPS = 50
const MAX_PATTERN_CHARS = 1000
const MAX_CODE_CHARS = 2000
const JS_TIMEOUT_MS = 50

export async function createMonitor(input = {}) {
  await initializeStory()
  const monitors = await readMonitors()
  if (monitors.length >= MAX_MONITORS) throw new Error(`Too many monitors; max ${MAX_MONITORS}`)
  const monitor = normalizeMonitor(input)
  monitor.cursor = await initialMonitorCursor(monitor)
  monitors.push(monitor)
  await writeMonitors(monitors)
  await writeWatcherEvent({ event: "monitor_created", id: monitor.id, monitor: publicMonitor(monitor) })
  return monitor
}

export async function listMonitors() {
  await initializeStory()
  return (await readMonitors()).map(publicMonitor)
}

export async function deleteMonitor(id) {
  await initializeStory()
  const monitors = await readMonitors()
  const next = monitors.filter((monitor) => monitor.id !== id)
  if (next.length === monitors.length) return { deleted: false, id }
  await writeMonitors(next)
  await writeWatcherEvent({ event: "monitor_deleted", id })
  return { deleted: true, id }
}

export async function setMonitorEnabled(id, enabled) {
  await initializeStory()
  const monitors = await readMonitors()
  const index = monitors.findIndex((monitor) => monitor.id === id)
  if (index < 0) return { updated: false, id }
  monitors[index] = { ...monitors[index], enabled: Boolean(enabled), updatedAt: nowIso() }
  await writeMonitors(monitors)
  await writeWatcherEvent({ event: "monitor_updated", id, enabled: Boolean(enabled) })
  return { updated: true, monitor: publicMonitor(monitors[index]) }
}

export async function createLoop(input = {}) {
  await initializeStory()
  const loops = await readLoops()
  if (loops.length >= MAX_LOOPS) throw new Error(`Too many loops; max ${MAX_LOOPS}`)
  const currentTurnNumber = await countForegroundTurns()
  const loop = normalizeLoop(input, { currentTurnNumber })
  loops.push(loop)
  await writeLoops(loops)
  await writeWatcherEvent({ event: "loop_created", id: loop.id, loop: publicLoop(loop) })
  let runNow = null
  if (input.runNow === true) {
    runNow = await enqueueLoopInbox(loop, { turnId: input.turnId || "manual_loop_run", turnNumber: currentTurnNumber })
    loops[loops.length - 1] = advanceLoop(loop, currentTurnNumber)
    await writeLoops(loops)
  }
  return { loop, runNow }
}

export async function listLoops() {
  await initializeStory()
  return (await readLoops()).map(publicLoop)
}

export async function deleteLoop(id) {
  await initializeStory()
  const loops = await readLoops()
  const next = loops.filter((loop) => loop.id !== id)
  if (next.length === loops.length) return { deleted: false, id }
  await writeLoops(next)
  await writeWatcherEvent({ event: "loop_deleted", id })
  return { deleted: true, id }
}

export async function setLoopEnabled(id, enabled) {
  await initializeStory()
  const loops = await readLoops()
  const index = loops.findIndex((loop) => loop.id === id)
  if (index < 0) return { updated: false, id }
  loops[index] = { ...loops[index], enabled: Boolean(enabled), updatedAt: nowIso() }
  await writeLoops(loops)
  await writeWatcherEvent({ event: "loop_updated", id, enabled: Boolean(enabled) })
  return { updated: true, loop: publicLoop(loops[index]) }
}

export async function runLoopNow(id, context = {}) {
  await initializeStory()
  const loops = await readLoops()
  const index = loops.findIndex((loop) => loop.id === id)
  if (index < 0) return { ran: false, id, reason: "not-found" }
  const turnNumber = await countForegroundTurns()
  const inbox = await enqueueLoopInbox(loops[index], { ...context, turnNumber, manual: true })
  loops[index] = advanceLoop(loops[index], turnNumber)
  await writeLoops(loops)
  return { ran: true, id, inbox, loop: publicLoop(loops[index]) }
}

export async function evaluateStoryWatchers({ turnId, action, foreground, publish } = {}) {
  await initializeStory()
  const turnNumber = await countForegroundTurns()
  const [monitorResult, loopResult] = await Promise.all([
    evaluateMonitors({ turnId, action, foreground, turnNumber }),
    evaluateLoops({ turnId, action, foreground, turnNumber }),
  ])
  const result = {
    turnId,
    turnNumber,
    monitors: monitorResult,
    loops: loopResult,
  }
  if (monitorResult.triggered.length || loopResult.triggered.length) {
    publish?.("watchers.triggered", result)
  }
  return result
}

async function evaluateMonitors({ turnId, action, foreground, turnNumber }) {
  const monitors = await readMonitors()
  const triggered = []
  const checked = []
  let changed = false

  for (const monitor of monitors) {
    if (monitor.enabled === false) continue
    if (monitor.maxTriggers && monitor.fireCount >= monitor.maxTriggers) continue
    if (monitor.cooldownTurns && turnNumber - (monitor.lastTriggeredTurnNumber || 0) < monitor.cooldownTurns) continue

    const target = await readMonitorTarget(monitor, { turnId, action, foreground })
    const nextCursor = target.cursor || monitor.cursor
    if (!target.text) {
      monitor.cursor = nextCursor
      changed = true
      checked.push({ id: monitor.id, matched: false, reason: "empty-target" })
      continue
    }

    const match = await evaluatePredicate(monitor.predicate, {
      text: target.text,
      action,
      foreground,
      narration: foreground?.narration || "",
      turnId,
      turnNumber,
      filePath: target.displayPath || "",
    })
    monitor.cursor = nextCursor
    changed = true
    checked.push({ id: monitor.id, matched: match.matched })
    if (!match.matched) continue

    const inbox = await enqueueMonitorInbox(monitor, {
      turnId,
      action,
      foreground,
      turnNumber,
      match,
      target,
    })
    monitor.fireCount = (monitor.fireCount || 0) + 1
    monitor.lastTriggeredAt = nowIso()
    monitor.lastTriggeredTurnId = turnId
    monitor.lastTriggeredTurnNumber = turnNumber
    monitor.updatedAt = nowIso()
    triggered.push({ id: monitor.id, inbox, match: match.summary, target: target.displayPath || target.source })
    await writeWatcherEvent({
      event: "monitor_triggered",
      id: monitor.id,
      turnId,
      turnNumber,
      match: match.summary,
      target: target.displayPath || target.source,
      inbox,
    })
  }

  if (changed) await writeMonitors(monitors)
  return { checked, triggered }
}

async function evaluateLoops({ turnId, action, foreground, turnNumber }) {
  const loops = await readLoops()
  const triggered = []
  let changed = false

  for (const loop of loops) {
    if (loop.enabled === false) continue
    if (loop.maxRuns && loop.runCount >= loop.maxRuns) continue
    if (turnNumber < loop.nextDueTurnNumber) continue

    const inbox = await enqueueLoopInbox(loop, { turnId, action, foreground, turnNumber })
    Object.assign(loop, advanceLoop(loop, turnNumber))
    changed = true
    triggered.push({ id: loop.id, inbox })
    await writeWatcherEvent({ event: "loop_triggered", id: loop.id, turnId, turnNumber, inbox })
  }

  if (changed) await writeLoops(loops)
  return { triggered }
}

async function readMonitorTarget(monitor, { turnId, action, foreground }) {
  const source = monitor.target?.source || DEFAULT_MONITOR_SOURCE
  if (source === "foreground") {
    if (monitor.cursor?.lastTurnId === turnId) {
      return { source, text: "", cursor: monitor.cursor }
    }
    return {
      source,
      text: foregroundText({ turnId, action, foreground }),
      cursor: { ...(monitor.cursor || {}), lastTurnId: turnId },
    }
  }

  const filePath = monitor.target?.filePath || "story/canon/chapters.md"
  const resolved = resolveWorkspacePath(filePath)
  const text = await readText(resolved.path, "")
  const info = await stat(resolved.path).catch(() => null)
  const mode = monitor.target?.mode || "append"
  const offset = mode === "append" ? Math.max(0, Number(monitor.cursor?.offset) || 0) : 0
  const nextText = text.slice(offset)
  return {
    source: "file",
    text: nextText,
    displayPath: resolved.displayPath,
    cursor: {
      ...(monitor.cursor || {}),
      offset: text.length,
      mtimeMs: info?.mtimeMs || 0,
    },
  }
}

async function initialMonitorCursor(monitor) {
  if (monitor.target?.source !== "file" || monitor.target?.mode === "full") return {}
  const filePath = monitor.target?.filePath || "story/canon/chapters.md"
  const resolved = resolveWorkspacePath(filePath)
  const text = await readText(resolved.path, "")
  const info = await stat(resolved.path).catch(() => null)
  return {
    offset: text.length,
    mtimeMs: info?.mtimeMs || 0,
  }
}

async function evaluatePredicate(predicate = {}, context = {}) {
  if (predicate.type === "javascript") return evaluateJavascriptPredicate(predicate, context)
  return evaluateRegexPredicate(predicate, context)
}

function evaluateRegexPredicate(predicate, context) {
  const pattern = String(predicate.pattern || "")
  if (!pattern) return { matched: false, summary: "" }
  const flags = sanitizeRegexFlags(predicate.flags || "")
  const re = new RegExp(pattern, flags)
  const match = re.exec(context.text)
  return {
    matched: Boolean(match),
    summary: match ? compact(match[0], 240) : "",
    groups: match?.groups || {},
  }
}

function evaluateJavascriptPredicate(predicate, context) {
  const code = String(predicate.code || "")
  if (!code.trim()) return { matched: false, summary: "" }
  const expressionLike = !/[;\n]|\breturn\b/.test(code)
  const wrapped = expressionLike ? `(${code})` : `(function(){\n${code}\n})()`
  const script = new vm.Script(wrapped, { displayErrors: false })
  const result = script.runInNewContext(
    {
      text: context.text,
      action: context.action,
      foreground: context.foreground,
      narration: context.narration,
      turnId: context.turnId,
      turnNumber: context.turnNumber,
      filePath: context.filePath,
      console: { log() {} },
    },
    { timeout: JS_TIMEOUT_MS, displayErrors: false },
  )
  return {
    matched: Boolean(result),
    summary: typeof result === "string" ? compact(result, 240) : result === true ? "javascript predicate returned true" : compact(JSON.stringify(result), 240),
  }
}

async function enqueueMonitorInbox(monitor, { turnId, action, foreground, turnNumber, match, target }) {
  const kind = `monitor-${monitor.id}-${(monitor.fireCount || 0) + 1}`
  const instruction = [
    monitor.trigger?.instruction || monitor.instruction || "A monitor detected a foreground change that may require background maintenance.",
    "",
    `Monitor: ${monitor.description || monitor.id}`,
    `Target: ${target.displayPath || target.source}`,
    `Match: ${match.summary || "truthy predicate"}`,
    `Turn number: ${turnNumber}`,
    "Inspect the relevant canon/event files before updating guidance or durable story files.",
  ].join("\n")
  return enqueueBackgroundInbox({
    turnId,
    action,
    foreground,
    signal: {
      needsBackground: true,
      priority: monitor.trigger?.priority || monitor.priority || "soon",
      tasks: [
        {
          kind,
          type: monitor.trigger?.type || "monitor",
          instruction,
          anchors: [monitor.id, monitor.description || "", match.summary || ""].filter(Boolean),
        },
      ],
    },
  })
}

async function enqueueLoopInbox(loop, { turnId = "loop", action = "", foreground = {}, turnNumber, manual = false } = {}) {
  const kind = `loop-${loop.id}-${(loop.runCount || 0) + 1}`
  const instruction = [
    loop.prompt,
    "",
    `Loop: ${loop.description || loop.id}`,
    `Run: ${(loop.runCount || 0) + 1}${manual ? " (manual)" : ""}`,
    `Turn number: ${turnNumber}`,
    "This is recurring background work. Keep the foreground hot path compact; write results to ordinary files and summarize only what the narrator needs.",
  ].join("\n")
  return enqueueBackgroundInbox({
    turnId,
    action,
    foreground,
    signal: {
      needsBackground: true,
      priority: loop.priority || "soon",
      tasks: [
        {
          kind,
          type: loop.type || "loop",
          instruction,
          anchors: [loop.id, loop.description || ""].filter(Boolean),
        },
      ],
    },
  })
}

function normalizeMonitor(input) {
  const predicate = normalizePredicate(input)
  const source = input.source || input.target?.source || (input.filePath ? "file" : DEFAULT_MONITOR_SOURCE)
  return {
    version: VERSION,
    id: safeId(input.id || `mon_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    description: compact(input.description || input.name || "Foreground monitor", 240),
    enabled: input.enabled !== false,
    target: {
      source: source === "file" ? "file" : "foreground",
      filePath: input.filePath || input.target?.filePath || "",
      mode: input.mode || input.target?.mode || "append",
    },
    predicate,
    trigger: {
      instruction: compact(input.instruction || input.trigger?.instruction || "", 1200),
      priority: input.priority || input.trigger?.priority || "soon",
      type: input.type || input.trigger?.type || "monitor",
    },
    cooldownTurns: clampInt(input.cooldownTurns, 0, 1000, 0),
    maxTriggers: clampInt(input.maxTriggers, 0, 10000, 0),
    fireCount: 0,
    cursor: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function normalizePredicate(input) {
  const type = input.predicate?.type || input.predicateType || (input.code ? "javascript" : "regex")
  if (type === "javascript") {
    const code = String(input.code || input.predicate?.code || "").trim()
    if (!code) throw new Error("javascript monitor needs code")
    if (code.length > MAX_CODE_CHARS) throw new Error(`javascript monitor code is too long; max ${MAX_CODE_CHARS} chars`)
    return { type: "javascript", code }
  }
  const pattern = String(input.pattern || input.predicate?.pattern || "").trim()
  if (!pattern) throw new Error("regex monitor needs pattern")
  if (pattern.length > MAX_PATTERN_CHARS) throw new Error(`regex monitor pattern is too long; max ${MAX_PATTERN_CHARS} chars`)
  const flags = sanitizeRegexFlags(input.flags || input.predicate?.flags || "")
  // Compile once on create for early feedback.
  new RegExp(pattern, flags)
  return { type: "regex", pattern, flags }
}

function normalizeLoop(input, { currentTurnNumber }) {
  const prompt = String(input.prompt || input.instruction || "").trim()
  if (!prompt) throw new Error("loop needs prompt")
  const intervalTurns = clampInt(input.intervalTurns || input.everyTurns || 1, 1, 10000, 1)
  return {
    version: VERSION,
    id: safeId(input.id || `loop_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    description: compact(input.description || input.name || "Recurring background loop", 240),
    enabled: input.enabled !== false,
    prompt: compact(prompt, 4000),
    intervalTurns,
    nextDueTurnNumber: currentTurnNumber + intervalTurns,
    maxRuns: clampInt(input.maxRuns, 0, 10000, 0),
    runCount: 0,
    priority: input.priority || "soon",
    type: input.type || "loop",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function advanceLoop(loop, currentTurnNumber) {
  const intervalTurns = Math.max(1, Number(loop.intervalTurns) || 1)
  return {
    ...loop,
    runCount: (loop.runCount || 0) + 1,
    lastRunAt: nowIso(),
    lastRunTurnNumber: currentTurnNumber,
    nextDueTurnNumber: currentTurnNumber + intervalTurns,
    updatedAt: nowIso(),
  }
}

async function readMonitors() {
  const raw = await readJson(paths.monitorsFile, [])
  return Array.isArray(raw) ? raw : []
}

async function writeMonitors(monitors) {
  await writeAtomic(paths.monitorsFile, `${JSON.stringify(monitors, null, 2)}\n`)
}

async function readLoops() {
  const raw = await readJson(paths.loopsFile, [])
  return Array.isArray(raw) ? raw : []
}

async function writeLoops(loops) {
  await writeAtomic(paths.loopsFile, `${JSON.stringify(loops, null, 2)}\n`)
}

async function writeWatcherEvent(event) {
  await appendJsonl(paths.watcherLedger, { at: nowIso(), ...event })
}

// Delegates to the cached count in storyStore — O(1) amortized instead of a
// full scene_log scan every turn. (The full scan now happens at most once, to
// seed the cache.)
async function countForegroundTurns() {
  return getForegroundTurnCount()
}

function foregroundText({ turnId, action, foreground }) {
  return [
    `turnId: ${turnId || ""}`,
    `action: ${action || ""}`,
    `narration: ${foreground?.narration || ""}`,
    `tension: ${foreground?.tension || ""}`,
    `source: ${foreground?.source || ""}`,
  ].join("\n")
}

function publicMonitor(monitor) {
  return {
    id: monitor.id,
    description: monitor.description,
    enabled: monitor.enabled,
    target: monitor.target,
    predicate: monitor.predicate?.type === "javascript"
      ? { type: "javascript", codeChars: String(monitor.predicate.code || "").length }
      : monitor.predicate,
    trigger: monitor.trigger,
    fireCount: monitor.fireCount || 0,
    maxTriggers: monitor.maxTriggers || 0,
    cooldownTurns: monitor.cooldownTurns || 0,
    lastTriggeredTurnId: monitor.lastTriggeredTurnId || "",
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
  }
}

function publicLoop(loop) {
  return {
    id: loop.id,
    description: loop.description,
    enabled: loop.enabled,
    intervalTurns: loop.intervalTurns,
    nextDueTurnNumber: loop.nextDueTurnNumber,
    runCount: loop.runCount || 0,
    maxRuns: loop.maxRuns || 0,
    priority: loop.priority,
    type: loop.type,
    prompt: loop.prompt,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  }
}

function sanitizeRegexFlags(value) {
  const allowed = new Set(["i", "m", "s", "u"])
  return [...new Set(String(value || "").split("").filter((flag) => allowed.has(flag)))].join("")
}

function safeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `watch_${Date.now()}`
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function compact(value, maxChars = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : text
}

function nowIso() {
  return new Date().toISOString()
}
