import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { appendJsonl, ensureDir, readTailText, readText } from "../lib/files.js"
import { displayWorkspacePath } from "../lib/workspacePaths.js"
import { getStorySnapshot, paths } from "../lib/storyStore.js"
import { chatCompletion, hasModelKey } from "../provider/provider.js"

const DEFAULT_MAX_MESSAGES = 120
const DEFAULT_MAX_CHARS = 220_000
const DEFAULT_COMPACT_CHARS = 140_000
const DEFAULT_KEEP_MESSAGES = 28
const TOOL_RESULT_COMPACT_CHARS = 1600
const REHYDRATE_MAX_FILES = 40
const REHYDRATE_MAX_DEPTH = 4

export async function loadStorykeeperThread({
  ledgerPath = paths.storykeeperThread,
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const events = await readStorykeeperThreadEvents({ ledgerPath })
  const boundary = findLastCompactBoundaryIndex(events)
  const visibleEvents = boundary >= 0 ? events.slice(boundary + 1) : events
  const messages = visibleEvents
    .filter((event) => event.event === "storykeeper_thread_message")
    .map((event) => event.message)
    .filter(isChatMessage)
  return {
    messages: trimMessages(messages, { maxMessages, maxChars }),
    allMessages: messages,
    boundary: boundary >= 0 ? events[boundary] : null,
    eventCount: events.length,
    visibleEventCount: visibleEvents.length,
  }
}

export async function maybeCompactStorykeeperThread({
  ledgerPath = paths.storykeeperThread,
  turnId = "",
  trigger = "auto",
  maxChars = numberFromEnv("OPENOVEL_STORYKEEPER_THREAD_COMPACT_CHARS", DEFAULT_COMPACT_CHARS),
  keepMessages = numberFromEnv("OPENOVEL_STORYKEEPER_THREAD_KEEP_MESSAGES", DEFAULT_KEEP_MESSAGES),
} = {}) {
  const loaded = await loadStorykeeperThread({ ledgerPath, maxMessages: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER })
  const messages = loaded.allMessages
  const chars = serializedMessagesLength(messages)
  if (chars < maxChars || messages.length <= keepMessages + 2) {
    return { compacted: false, preCompactChars: chars, messageCount: messages.length }
  }

  // Tail-slice can sever assistant.tool_calls ↔ tool pairs; drop leading
  // orphans so the kept slice loads back as a chat-API-valid prefix.
  // Shared with trimMessages — see ensureValidPrefixBoundary below.
  const keep = ensureValidPrefixBoundary(messages.slice(-keepMessages))
  const summarize = messages.slice(0, Math.max(0, messages.length - keep.length))
  const summary = await summarizeStorykeeperThread(summarize, { turnId })
  const boundaryId = `sk_compact_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const summaryMessage = {
    role: "user",
    content: [
      "<storykeeper_thread_summary>",
      `Boundary: ${boundaryId}`,
      `Compacted at: ${new Date().toISOString()}`,
      "",
      summary,
      "</storykeeper_thread_summary>",
    ].join("\n"),
  }
  const rehydrationMessage = {
    role: "user",
    content: await buildStorykeeperPostCompactRehydration({ boundaryId, turnId }),
  }
  const boundaryEvent = {
    event: "storykeeper_compact_boundary",
    boundaryId,
    trigger,
    turnId,
    at: new Date().toISOString(),
    preCompactChars: chars,
    summarizedMessages: summarize.length,
    preservedMessages: keep.length,
    rehydrated: true,
  }
  await appendThreadEvent(boundaryEvent, ledgerPath)
  await appendStorykeeperThreadMessages([summaryMessage, rehydrationMessage, ...keep], {
    ledgerPath,
    turnId,
    source: "storykeeper:compact",
  })
  return {
    compacted: true,
    boundaryId,
    preCompactChars: chars,
    summarizedMessages: summarize.length,
    preservedMessages: keep.length,
    rehydrated: true,
  }
}

export async function buildStorykeeperPostCompactRehydration({ boundaryId = "", turnId = "" } = {}) {
  const snapshot = await safeGetStorySnapshot()
  const recentFiles = await collectRecentStoryFiles(paths.root)
  const provenanceTail = await readTailText(paths.provenance, 6000, "")
  const pending = snapshot.backgroundInboxItems || []
  return [
    "<storykeeper_post_compact_rehydration>",
    `Boundary: ${boundaryId || "-"}`,
    `Turn: ${turnId || "-"}`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Purpose: restore operational context that a thread summary alone may lose. This is a read-only capsule; verify files with read before editing.",
    "",
    "## Runtime Anchors",
    `- Story root: ${displayWorkspacePath(paths.root)}`,
    "- Contract files: story/frontend/*, story/guidance/FOREGROUND.md, story/inbox/INBOX.md, story/inbox/MERGED.md, story/canon/scene_log.jsonl, story/canon/PROVENANCE.md",
    "- Durable story state may also live under story/state/, story/context-cards/, story/memory/, story/research/, or other discovered story/ files.",
    "",
    "## Current Story Snapshot",
    `- Pending inbox items: ${pending.length}`,
    `- Context pressure: ${snapshot.contextReport?.pressure?.status || "-"}`,
    "",
    "Foreground guidance excerpt:",
    fenced(compactBlock(snapshot.foregroundGuidance, 5000)),
    "",
    "Recent canon excerpt:",
    fenced(compactBlock(snapshot.chapters, 5000)),
    "",
    "## Pending Inbox",
    pending.length
      ? pending.slice(0, 20).map((item) => `- ${item.id}: ${compactLine(item.instruction || item.type || "", 220)}`).join("\n")
      : "-",
    "",
    "## Recent Story Files",
    recentFiles.length
      ? recentFiles.map((file) => `- ${file.displayPath} (${file.size} bytes, mtime ${file.mtime})`).join("\n")
      : "-",
    "",
    "## Recent Provenance Tail",
    fenced(compactBlock(provenanceTail, 4000)),
    "</storykeeper_post_compact_rehydration>",
  ].join("\n")
}

export async function appendStorykeeperThreadMessages(messages = [], {
  ledgerPath = paths.storykeeperThread,
  turnId = "",
  source = "storykeeper",
} = {}) {
  await ensureDir(path.dirname(ledgerPath))
  const now = new Date().toISOString()
  for (const message of sanitizeMessagesForThread(messages)) {
    await appendThreadEvent({
      event: "storykeeper_thread_message",
      at: now,
      turnId,
      source,
      message,
    }, ledgerPath)
  }
}

export function storykeeperRunAppendStart(messages, threadMessageCount) {
  const systemPrefix = messages[0]?.role === "system" ? 1 : 0
  return systemPrefix + Math.max(0, threadMessageCount)
}

export function messagesToAppendAfterRun(runMessages = [], appendStart = 0) {
  return sanitizeMessagesForThread(runMessages.slice(Math.max(0, appendStart)))
}

export function sanitizeMessagesForThread(messages = []) {
  return messages
    .filter(isChatMessage)
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role !== "tool") return compactAssistantMessage(message)
      const content = String(message.content || "")
      if (content.length <= TOOL_RESULT_COMPACT_CHARS) return message
      return {
        ...message,
        content: compactToolResultContent(content),
      }
    })
}

export async function readStorykeeperThreadEvents({ ledgerPath = paths.storykeeperThread } = {}) {
  const raw = await readText(ledgerPath, "")
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

async function summarizeStorykeeperThread(messages, { turnId = "" } = {}) {
  const fallback = deterministicThreadSummary(messages)
  if (isTruthy(process.env.OPENOVEL_DISABLE_STORYKEEPER_THREAD_MODEL_SUMMARY)) return fallback
  if (!hasModelKey({ role: "foreground" })) return fallback
  try {
    return await chatCompletion({
      role: "foreground",
      modelProfile: "compaction",
      temperature: 0.2,
      maxTokens: 2400,
      messages: [
        {
          role: "system",
          content: [
            "Summarize the Storykeeper agent thread for future Storykeeper turns.",
            "Preserve decisions, unresolved tasks, files inspected or changed, failed assumptions, and why the agent chose its current maintenance direction.",
            "Do not summarize reader-facing prose for style; summarize operational memory for the background agent.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Current turn: ${turnId || "-"}`,
            "",
            renderMessagesForSummary(messages),
          ].join("\n"),
        },
      ],
    })
  } catch {
    return fallback
  }
}

function deterministicThreadSummary(messages) {
  const rows = ["Deterministic summary of older Storykeeper thread:"]
  const tail = messages.slice(-20)
  for (const message of tail) {
    if (message.role === "user") {
      rows.push(`- User/context: ${compactLine(message.content, 360)}`)
    } else if (message.role === "assistant") {
      rows.push(`- Storykeeper: ${compactLine(message.content || summarizeToolCalls(message), 360)}`)
    } else if (message.role === "tool") {
      rows.push(`- Tool result: ${compactLine(message.content, 240)}`)
    }
  }
  return rows.join("\n")
}

function renderMessagesForSummary(messages) {
  return messages
    .map((message, index) => {
      const label = `${index + 1}. ${message.role}`
      if (message.role === "assistant" && message.tool_calls?.length) {
        return `${label}: ${summarizeToolCalls(message)}`
      }
      return `${label}:\n${compactLine(message.content, 2400)}`
    })
    .join("\n\n")
}

function summarizeToolCalls(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (!calls.length) return ""
  return `tool calls: ${calls.map((call) => call.function?.name || "unknown").join(", ")}`
}

function compactAssistantMessage(message) {
  if (message.role !== "assistant") return message
  const out = { ...message }
  if (typeof out.reasoning_content === "string" && out.reasoning_content.length > 4000) {
    out.reasoning_content = `${out.reasoning_content.slice(0, 4000)}...[truncated ${out.reasoning_content.length - 4000}]`
  }
  if (typeof out.reasoning === "string" && out.reasoning.length > 4000) {
    out.reasoning = `${out.reasoning.slice(0, 4000)}...[truncated ${out.reasoning.length - 4000}]`
  }
  return out
}

function compactToolResultContent(content) {
  const tagMatch = content.match(/<tool_result\s+tool="([^"]*)"\s+status="([^"]*)"/)
  const tool = tagMatch?.[1] || "unknown"
  const status = tagMatch?.[2] || "ok"
  return `<tool_result tool="${escapeAttribute(tool)}" status="${escapeAttribute(status)}" compacted="1" original_bytes="${content.length}">\n<content>\n${content.slice(0, TOOL_RESULT_COMPACT_CHARS)}\n...[thread-truncated ${content.length - TOOL_RESULT_COMPACT_CHARS} chars]\n</content>\n</tool_result>`
}

async function safeGetStorySnapshot() {
  try {
    return await getStorySnapshot()
  } catch {
    return {
      foregroundGuidance: "",
      backgroundInboxItems: [],
      chapters: "",
      contextReport: null,
    }
  }
}

async function collectRecentStoryFiles(root) {
  const files = []
  await walkStoryFiles(root, {
    root,
    depth: 0,
    files,
    maxFiles: REHYDRATE_MAX_FILES * 4,
  })
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, REHYDRATE_MAX_FILES)
    .map((file) => ({
      displayPath: displayWorkspacePath(file.path),
      size: file.size,
      mtime: new Date(file.mtimeMs).toISOString(),
    }))
}

async function walkStoryFiles(dir, { root, depth, files, maxFiles }) {
  if (files.length >= maxFiles || depth > REHYDRATE_MAX_DEPTH) return
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (shouldSkipRehydrationPath(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkStoryFiles(full, { root, depth: depth + 1, files, maxFiles })
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(full)
      files.push({
        path: full,
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
    } catch {
      // Best-effort rehydration: skip files that disappear mid-scan.
    }
  }
}

function shouldSkipRehydrationPath(name) {
  return [
    ".DS_Store",
    "node_modules",
    ".git",
    "agents",
    "transactions",
    "permissions",
    "tool-output",
  ].includes(name)
}

function fenced(value) {
  return ["```", value || "-", "```"].join("\n")
}

function compactBlock(value, maxChars) {
  const text = String(value || "").trim()
  if (!text) return ""
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 36)).trimEnd()}\n...[rehydration-truncated ${text.length - maxChars} chars]`
}

function trimMessages(messages, { maxMessages, maxChars }) {
  const out = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const size = JSON.stringify(msg).length
    if (out.length >= maxMessages) break
    if (out.length && chars + size > maxChars) break
    out.unshift(msg)
    chars += size
  }
  return ensureValidPrefixBoundary(out)
}

// Drop leading messages until the head is a valid chat-API prefix
// boundary: system / user / assistant-without-tool_calls /
// assistant-with-fully-resolved-tool_calls. Tail-slicing thread.jsonl
// (either by char budget in trimMessages or by message count in
// maybeCompactStorykeeperThread) can sever the assistant.tool_calls ↔
// tool pairing and leave orphan tool messages — DeepSeek returns
// "Messages with role 'tool' must be a response to a preceding message
// with 'tool_calls'" (400) on that shape. Drop until clean. Mutates the
// input array via shift; returns it for chaining.
function ensureValidPrefixBoundary(messages) {
  while (messages.length) {
    const head = messages[0]
    if (head.role === "system" || head.role === "user") break
    if (head.role === "assistant") {
      const toolCalls = Array.isArray(head.tool_calls) ? head.tool_calls : []
      if (!toolCalls.length) break
      const calledIds = toolCalls.map((c) => c?.id).filter(Boolean)
      if (!calledIds.length) break
      const resolved = new Set()
      for (let i = 1; i < messages.length; i++) {
        const next = messages[i]
        if (next?.role === "tool" && next.tool_call_id) resolved.add(next.tool_call_id)
      }
      if (calledIds.every((id) => resolved.has(id))) break
    }
    messages.shift()
  }
  return messages
}

function serializedMessagesLength(messages) {
  return messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0)
}

function findLastCompactBoundaryIndex(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.event === "storykeeper_compact_boundary") return i
  }
  return -1
}

async function appendThreadEvent(event, ledgerPath) {
  await ensureDir(path.dirname(ledgerPath))
  await appendJsonl(ledgerPath, event)
}

function isChatMessage(message) {
  return Boolean(message && typeof message === "object" && ["system", "user", "assistant", "tool"].includes(message.role))
}

function compactLine(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 24))}...[truncated ${text.length - maxChars}]`
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}

function escapeAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
