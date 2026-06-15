import path from "node:path"
import { open, readFile, stat, unlink } from "node:fs/promises"
import { appendJsonl, ensureDir, readText, writeAtomic } from "../lib/files.js"
import { paths } from "../lib/storyStore.js"

// The ONE inter-agent message channel. Every communication direction — foreground
// → background, background → background (A2A), background → foreground, and
// broadcast-to-all — reduces to "append an addressed message to the recipient's
// inbox queue." Each resident agent has exactly one physical inbox
// (`story/<domain>/inbox.queue.jsonl`); messages carry `from`/`to` addressing and
// a priority. A resident agent drains its OWN inbox mid-run (the tool loop's
// drainQueuedContext hook), so updates injected while it is already running are
// folded into its context at the next step.
//
// This module is the generalization of the former Storykeeper-only queue: the
// event-sourced JSONL engine (fold/compact/mutation-lock/priority) is preserved
// exactly; only the addressing layer (per-agent inbox resolution + broadcast) is
// new. `agentMessageQueue.js` is a thin back-compat shim over this module.

const PRIORITY_ORDER = { now: 0, next: 1, later: 2 }
const DEFAULT_QUEUE_LOCK_TTL_MS = 30_000
const DEFAULT_QUEUE_LOCK_WAIT_MS = 5_000
const AUTO_COMPACT_EVENT_THRESHOLD = 500
const AUTO_COMPACT_BYTES_THRESHOLD = 512 * 1024
const DEFAULT_RETAIN_TERMINAL_MESSAGES = 200

// agentId → inbox queue path, kept PER STORY ROOT. Populated by the config
// loader (loadAgentConfigs) under the root it loaded against; lookups read the
// slot of the root that is current for the CALLER (pin-aware via paths.root).
// This matters because background agents outlive story switches: a story-A
// agent still finishing after the reader switched to story B runs pinned to A
// (storyContext.js) and must keep addressing A's inboxes. A single global map
// here meant whichever story loaded configs last owned the addresses, so A's
// tail-end `forAgents` message could land in B's inbox queue (cross-story
// contamination). `from`/`to` addressing resolves through here so callers
// don't pass raw paths. An explicit `queuePath` always wins (used by the
// back-compat shim + tests).
const inboxRegistries = new Map() // story root → Map(agentId → queue path)
const EMPTY_REGISTRY = new Map()

function currentInboxRegistry() {
  return inboxRegistries.get(paths.root) || EMPTY_REGISTRY
}

// Register the set of agent inboxes (agentId → absolute queue path) for the
// current story root. `broadcast` (with no explicit `agents`) fans out to
// every inbox registered for the caller's root.
export function setAgentInboxRegistry(entries = []) {
  inboxRegistries.set(paths.root, new Map(entries.map(([id, qp]) => [String(id), qp])))
}

export function registeredAgentIds() {
  return [...currentInboxRegistry().keys()]
}

// Resolve an agentId to its inbox path. Falls back to a conventional location
// under the story root so an unregistered agent still has a stable inbox.
export function inboxQueuePath(agentId) {
  const id = String(agentId || "")
  if (!id) throw new Error("inboxQueuePath requires an agentId")
  return currentInboxRegistry().get(id) || path.join(paths.root, id, "inbox.queue.jsonl")
}

function resolveQueuePath({ queuePath, to } = {}) {
  if (queuePath) return queuePath
  if (to) return inboxQueuePath(to)
  throw new Error("agentChannel: a message needs an explicit queuePath or a `to` address")
}

export async function enqueueAgentMessage(message = {}, { queuePath, bus = null } = {}) {
  const to = stringOr(message.to, "")
  const resolved = resolveQueuePath({ queuePath, to })
  const id = message.id || `agmsg_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const event = {
    event: "agent_message_queued",
    id,
    at: new Date().toISOString(),
    priority: normalizePriority(message.priority),
    // `source` is the stored "from" field (kept for engine + render compatibility).
    source: stringOr(message.from, stringOr(message.source, "foreground")),
    to,
    type: stringOr(message.type, "foreground_update"),
    turnId: stringOr(message.turnId, ""),
    payload: message.payload && typeof message.payload === "object" ? message.payload : {},
  }
  await withQueueMutationLock(resolved, async () => {
    await appendQueueEventUnlocked(event, resolved)
    await compactAgentInboxIfNeeded({ queuePath: resolved })
  })
  bus?.publish?.("agent.channel.enqueued", summarizeQueueMessage(event))
  return event
}

// Fan a single message out to many inboxes. With no explicit `agents`, broadcasts
// to every registered inbox. The summary+pointer turn broadcast goes through here.
export async function broadcastAgentMessage(message = {}, { bus = null, agents = null } = {}) {
  const targets = (agents && agents.length ? agents : registeredAgentIds()).map(String)
  const out = []
  for (const to of targets) {
    out.push(await enqueueAgentMessage({ ...message, to }, { bus }))
  }
  bus?.publish?.("agent.channel.broadcast", { type: stringOr(message.type, "foreground_update"), recipients: targets, count: out.length })
  return out
}

export async function listAgentMessages({ queuePath, agent, status = "pending", limit = 100 } = {}) {
  const resolved = resolveQueuePath({ queuePath, to: agent })
  const events = await readAgentInboxEvents({ queuePath: resolved })
  const messages = foldQueueEvents(events)
  return takeOrderedQueueMessages(
    messages.filter((message) => status === "all" || message.status === status),
    Math.max(0, Number(limit) || 100),
  )
}

export async function drainAgentMessages({
  queuePath,
  agent,
  maxPriority = "later",
  limit = 12,
  excludeTurnIds = [],
  bus = null,
} = {}) {
  const resolved = resolveQueuePath({ queuePath, to: agent })
  const excluded = new Set(excludeTurnIds.filter(Boolean))
  const maxRank = PRIORITY_ORDER[normalizePriority(maxPriority)]
  const drained = await withQueueMutationLock(resolved, async () => {
    const events = await readAgentInboxEvents({ queuePath: resolved })
    if (shouldCompactQueueEvents(events, resolved)) {
      const compacted = compactQueueEvents(events)
      await writeAtomic(resolved, renderQueueEvents(compacted))
      events.length = 0
      events.push(...compacted)
    }
    const selected = takeOrderedQueueMessages(
      foldQueueEvents(events)
        .filter((message) => message.status === "pending")
        .filter((message) => PRIORITY_ORDER[message.priority] <= maxRank)
        .filter((message) => !excluded.has(message.turnId)),
      Math.max(0, Number(limit) || 12),
    )
    if (!selected.length) return []
    await appendInjectedEvents(selected.map((message) => message.id), {
      queuePath: resolved,
      reason: "tool-loop-context-injection",
    })
    await compactAgentInboxIfNeeded({ queuePath: resolved })
    return selected
  })
  if (!drained.length) return []
  bus?.publish?.("agent.channel.injected", {
    ids: drained.map((message) => message.id),
    reason: "tool-loop-context-injection",
    at: new Date().toISOString(),
  })
  return drained
}

export async function markAgentMessagesInjected(ids = [], {
  queuePath,
  agent,
  reason = "injected",
  bus = null,
} = {}) {
  const resolved = resolveQueuePath({ queuePath, to: agent })
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return { injected: [] }
  await withQueueMutationLock(resolved, async () => {
    await appendInjectedEvents(uniqueIds, { queuePath: resolved, reason })
    await compactAgentInboxIfNeeded({ queuePath: resolved })
  })
  const at = new Date().toISOString()
  bus?.publish?.("agent.channel.injected", { ids: uniqueIds, reason, at })
  return { injected: uniqueIds }
}

export async function markAgentMessagesForTurnInjected(turnId, {
  queuePath,
  agent,
  reason = "included-in-current-turn-context",
  sources = null,
  types = null,
  excludeSources = null,
  excludeTypes = null,
  bus = null,
} = {}) {
  const resolved = resolveQueuePath({ queuePath, to: agent })
  const target = String(turnId || "")
  if (!target) return { injected: [] }
  const sourceSet = filterSet(sources)
  const typeSet = filterSet(types)
  const excludeSourceSet = filterSet(excludeSources)
  const excludeTypeSet = filterSet(excludeTypes)
  const ids = await withQueueMutationLock(resolved, async () => {
    const events = await readAgentInboxEvents({ queuePath: resolved })
    const messages = foldQueueEvents(events)
      .filter((message) => message.status === "pending")
      .filter((message) => message.turnId === target)
      .filter((message) => matchesQueueFilter(message, { sourceSet, typeSet, excludeSourceSet, excludeTypeSet }))
    const selected = messages.map((message) => message.id)
    await appendInjectedEvents(selected, { queuePath: resolved, reason })
    await compactAgentInboxIfNeeded({ queuePath: resolved })
    return selected
  })
  if (ids.length) bus?.publish?.("agent.channel.injected", { ids, reason, at: new Date().toISOString() })
  return { injected: ids }
}

function filterSet(values) {
  return Array.isArray(values) && values.length
    ? new Set(values.map((value) => String(value || "")).filter(Boolean))
    : null
}

function matchesQueueFilter(message, { sourceSet, typeSet, excludeSourceSet, excludeTypeSet }) {
  if (sourceSet && !sourceSet.has(message.source)) return false
  if (typeSet && !typeSet.has(message.type)) return false
  if (excludeSourceSet?.has(message.source)) return false
  if (excludeTypeSet?.has(message.type)) return false
  return true
}

function renderQueueRows(messages) {
  return messages.map((message) => {
    const payload = compactPayload(message.payload)
    return [
      `  <update id="${escapeAttribute(message.id)}" priority="${escapeAttribute(message.priority)}" type="${escapeAttribute(message.type)}" source="${escapeAttribute(message.source)}" turn_id="${escapeAttribute(message.turnId)}" queued_at="${escapeAttribute(message.at)}">`,
      payload ? `    <payload>${escapeText(payload)}</payload>` : "",
      "  </update>",
    ].filter(Boolean).join("\n")
  })
}

export function renderAgentInbox(messages = []) {
  // apply_feedback = the runtime's report of what it dropped/truncated/rejected
  // when applying YOUR previous envelope. Surfaced directly here (not only in
  // the PROVENANCE audit file) so you act on it; the rest are foreground updates
  // that arrived mid-run.
  const feedback = messages.filter((m) => m.type === "apply_feedback")
  const updates = messages.filter((m) => m.type !== "apply_feedback")
  const blocks = []
  if (feedback.length) {
    blocks.push([
      "<previous_envelope_feedback>",
      "When the runtime applied your previous envelope it had to drop or truncate the following. They are NOT in effect. Re-do the affected change (e.g. edit the per-section file directly with the write/edit tool) so it sticks.",
      ...renderQueueRows(feedback),
      "</previous_envelope_feedback>",
    ].join("\n"))
  }
  if (updates.length) {
    blocks.push([
      "<foreground_updates>",
      "These updates arrived while you were already running. Treat them as current-turn context, not as resolved inbox work. Verify files with read before editing; resolve/defer/reject INBOX ids explicitly in your final envelope.",
      ...renderQueueRows(updates),
      "</foreground_updates>",
    ].join("\n"))
  }
  return blocks.join("\n\n")
}

export async function readAgentInboxEvents({ queuePath } = {}) {
  const raw = await readText(queuePath, "")
  const events = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Ignore torn JSONL lines.
    }
  }
  return events
}

export async function compactAgentInbox({
  queuePath,
  agent,
  retainTerminalMessages = DEFAULT_RETAIN_TERMINAL_MESSAGES,
} = {}) {
  const resolved = resolveQueuePath({ queuePath, to: agent })
  return withQueueMutationLock(resolved, async () => {
    const events = await readAgentInboxEvents({ queuePath: resolved })
    const compacted = compactQueueEvents(events, { retainTerminalMessages })
    await writeAtomic(resolved, renderQueueEvents(compacted))
    return {
      compacted: true,
      beforeEvents: events.length,
      afterEvents: compacted.length,
    }
  })
}

function foldQueueEvents(events = []) {
  const byId = new Map()
  for (const event of events) {
    if (!event?.id) continue
    // Accept the legacy "storykeeper_message_*" event names too, so an existing
    // save's pending queue items aren't silently dropped on upgrade.
    if (event.event === "agent_message_queued" || event.event === "storykeeper_message_queued") {
      byId.set(event.id, {
        id: event.id,
        at: event.at || "",
        priority: normalizePriority(event.priority),
        source: stringOr(event.source, "foreground"),
        to: stringOr(event.to, ""),
        type: stringOr(event.type, "foreground_update"),
        turnId: stringOr(event.turnId, ""),
        payload: event.payload && typeof event.payload === "object" ? event.payload : {},
        status: "pending",
        injectedAt: "",
        injectedReason: "",
      })
      continue
    }
    if (event.event === "agent_message_injected" || event.event === "storykeeper_message_injected") {
      const existing = byId.get(event.id)
      if (!existing) continue
      byId.set(event.id, {
        ...existing,
        status: "injected",
        injectedAt: event.at || "",
        injectedReason: event.reason || "",
      })
    }
  }
  return [...byId.values()]
}

function takeOrderedQueueMessages(messages = [], limit = 100) {
  const max = Math.max(0, Number(limit) || 0)
  if (!max) return []
  const buckets = { now: [], next: [], later: [] }
  for (const message of messages) {
    buckets[normalizePriority(message.priority)].push(message)
  }
  const selected = []
  for (const priority of ["now", "next", "later"]) {
    for (const message of buckets[priority]) {
      selected.push(message)
      if (selected.length >= max) return selected
    }
  }
  return selected
}

function insertBounded(selected, item, limit, compare) {
  let lo = 0
  let hi = selected.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compare(item, selected[mid]) < 0) hi = mid
    else lo = mid + 1
  }
  if (lo >= limit) return
  selected.splice(lo, 0, item)
  if (selected.length > limit) selected.pop()
}

async function appendInjectedEvents(ids = [], { queuePath, reason }) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return
  const at = new Date().toISOString()
  for (const id of uniqueIds) {
    await appendQueueEventUnlocked({
      event: "agent_message_injected",
      id,
      at,
      reason,
    }, queuePath)
  }
}

async function compactAgentInboxIfNeeded({
  queuePath,
  bytesThreshold = AUTO_COMPACT_BYTES_THRESHOLD,
} = {}) {
  const info = await stat(queuePath).catch(() => null)
  if (!info || info.size < bytesThreshold) return { compacted: false }
  const events = await readAgentInboxEvents({ queuePath })
  if (!shouldCompactQueueEvents(events)) return { compacted: false }
  const compacted = compactQueueEvents(events)
  await writeAtomic(queuePath, renderQueueEvents(compacted))
  return { compacted: true, beforeEvents: events.length, afterEvents: compacted.length }
}

function shouldCompactQueueEvents(events = []) {
  if (events.length > AUTO_COMPACT_EVENT_THRESHOLD) return true
  return false
}

function compactQueueEvents(events = [], { retainTerminalMessages = DEFAULT_RETAIN_TERMINAL_MESSAGES } = {}) {
  const messages = foldQueueEvents(events)
  const pending = messages.filter((message) => message.status === "pending")
  const terminal = takeRecentTerminalMessages(
    messages.filter((message) => message.status !== "pending"),
    Math.max(0, Number(retainTerminalMessages) || DEFAULT_RETAIN_TERMINAL_MESSAGES),
  )
  const retainedIds = new Set([...pending, ...terminal].map((message) => message.id))
  const compactedAt = new Date().toISOString()
  const out = [{
    event: "agent_message_queue_compacted",
    at: compactedAt,
    beforeEvents: events.length,
    retainedMessages: retainedIds.size,
    retainedPending: pending.length,
    retainedTerminal: terminal.length,
  }]
  for (const message of messages) {
    if (!retainedIds.has(message.id)) continue
    out.push({
      event: "agent_message_queued",
      id: message.id,
      at: message.at,
      priority: message.priority,
      source: message.source,
      to: message.to,
      type: message.type,
      turnId: message.turnId,
      payload: message.payload,
    })
    if (message.status !== "pending") {
      out.push({
        event: "agent_message_injected",
        id: message.id,
        at: message.injectedAt || compactedAt,
        reason: message.injectedReason || "compacted-terminal-state",
      })
    }
  }
  return out
}

function takeRecentTerminalMessages(messages = [], limit = DEFAULT_RETAIN_TERMINAL_MESSAGES) {
  const selected = []
  for (const message of messages) {
    insertBounded(selected, message, limit, (a, b) =>
      String(b.injectedAt || b.at || "").localeCompare(String(a.injectedAt || a.at || "")),
    )
  }
  return selected
}

function renderQueueEvents(events = []) {
  if (!events.length) return ""
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
}

async function appendQueueEventUnlocked(event, queuePath) {
  await ensureDir(path.dirname(queuePath))
  await appendJsonl(queuePath, event)
}

async function withQueueMutationLock(queuePath, fn) {
  const lock = await acquireQueueMutationLock(queuePath)
  try {
    return await fn()
  } finally {
    await lock.release().catch(() => {})
  }
}

async function acquireQueueMutationLock(queuePath, {
  ttlMs = DEFAULT_QUEUE_LOCK_TTL_MS,
  waitMs = DEFAULT_QUEUE_LOCK_WAIT_MS,
} = {}) {
  await ensureDir(path.dirname(queuePath))
  const lockPath = `${queuePath}.lock`
  const lockId = `q_lock_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const deadline = Date.now() + waitMs
  while (true) {
    let fh = null
    try {
      fh = await open(lockPath, "wx")
      await fh.writeFile(`${JSON.stringify({ lockId, pid: process.pid, at: new Date().toISOString() })}\n`, "utf8")
      return {
        lockId,
        async release() {
          const current = await readQueueLock(lockPath)
          if (current?.lockId === lockId) await unlink(lockPath).catch(() => {})
        },
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockPath).catch(() => null)
      if (!info || Date.now() - info.mtimeMs > ttlMs) {
        await unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        const lockError = new Error(`Timed out waiting for agent inbox lock: ${queuePath}`)
        lockError.code = "OPENOVEL_AGENT_INBOX_LOCK_TIMEOUT"
        throw lockError
      }
      await sleep(25)
    } finally {
      await fh?.close().catch(() => {})
    }
  }
}

async function readQueueLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"))
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizePriority(value) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, value) ? value : "next"
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback
}

function summarizeQueueMessage(message) {
  return {
    id: message.id,
    priority: message.priority,
    source: message.source,
    to: message.to,
    type: message.type,
    turnId: message.turnId,
    at: message.at,
  }
}

function compactPayload(payload) {
  const text = JSON.stringify(payload || {})
  if (text.length <= 4000) return text
  return `${text.slice(0, 3960)}...[queue-payload-truncated ${text.length - 3960} chars]`
}

function escapeText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll("\"", "&quot;")
}
