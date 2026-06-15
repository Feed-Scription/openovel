import path from "node:path"
import { readText, writeJson } from "../lib/files.js"
import { getStorySnapshot, paths } from "../lib/storyStore.js"
import { displayWorkspacePath } from "../lib/workspacePaths.js"
import { getMemorySnapshot } from "../memory/memoryStore.js"

const DEFAULT_RECENT_CANON_CHARS = 24000
const DEFAULT_MAX_GUIDANCE_CHARS = 24000
const DEFAULT_MAX_INSERT_CHARS = 12000
const DEFAULT_MAX_MEMORY_CHARS = 6400
const DEFAULT_MAX_STORY_MEMORY_CHARS = 16000

export async function compileForegroundContext({
  snapshot,
  action = "",
  turnId = "",
  persist = true,
  recentCanonChars,
  maxGuidanceChars,
  maxInsertChars,
  maxMemoryChars,
  maxStoryMemoryChars,
} = {}) {
  const defaultBudgets = contextBudgetDefaults()
  recentCanonChars = numberOr(recentCanonChars, defaultBudgets.recentCanonChars)
  maxGuidanceChars = numberOr(maxGuidanceChars, defaultBudgets.maxGuidanceChars)
  maxInsertChars = numberOr(maxInsertChars, defaultBudgets.maxInsertChars)
  maxMemoryChars = numberOr(maxMemoryChars, defaultBudgets.maxMemoryChars)
  maxStoryMemoryChars = numberOr(maxStoryMemoryChars, defaultBudgets.maxStoryMemoryChars)
  const storySnapshot = snapshot || (await getStorySnapshot())
  const rawForegroundGuidance = storySnapshot.foregroundGuidance || ""
  // strip per-turn timestamp lines before injecting FG.md into
  // the narrator prompt. The Updated Turn / Updated: ISO lines change every
  // turn even when content didn't, busting prompt-cache prefix matches. The
  // file on disk keeps them (stale-patch detection reads Updated Turn:).
  const cacheableForegroundGuidance = stripVolatileGuidanceLines(rawForegroundGuidance)
  // Context cards compose directly into FOREGROUND.md via @include (the
  // cards.md / cards.auto.md manifests), so there is no separate inserts file
  // to read; the cards arrive inside foregroundGuidance above.
  const rawForegroundContextInserts = ""
  const rawRecentCanon = String(storySnapshot.chapters || "")
  const foregroundGuidance = truncateText(cacheableForegroundGuidance, maxGuidanceChars)
  const foregroundContextInserts = truncateText(rawForegroundContextInserts, maxInsertChars)
  const memorySnapshot = await getMemorySnapshot()
  // story/memory/MEMORY.md gets its own dedicated section (placed before
  // Recent Canon), so drop the duplicate "story" block from the Durable Memory
  // group — it would otherwise appear twice for the narrator. The "story"
  // block stays in selectForegroundMemory itself (storykeeper still uses it).
  const foregroundMemory = selectForegroundMemory(memorySnapshot, maxMemoryChars)
    .filter((block) => block.target !== "story")
  const storyMemory = truncateStoryMemory(memorySnapshot.memory, maxStoryMemoryChars)
  // Strip the per-turn "**读者选择**：<action>" headers BEFORE budgeting the tail
  // so the narrator's Recent Canon reads as continuous prose, not a transcript.
  // Pairing each past action with the prose it produced pressures the narrator
  // to REPLAY that prose when the same action repeats (identical options →
  // identical action). chapters.md on disk keeps the headers — this is
  // prompt-only; the repeat-guard reads snapshot.chapters directly.
  const recentCanonExcerpt = stripReaderChoiceHeaders(rawRecentCanon).slice(-recentCanonChars)

  // Options-only guidance (story/director/OPTIONS.md): authored by the Director
  // for the post-narration options generator. It lives in the internal director
  // domain, which is NEVER composed into FOREGROUND.md, so it reaches the options
  // call but never the narrator. Small file; cap defensively. Absent → "".
  const optionsGuidance = truncateText(await readText(path.join(paths.directorDir, "OPTIONS.md"), ""), 8000)

  const report = buildReport({
    action,
    turnId,
    rawForegroundGuidance,
    foregroundGuidance,
    rawForegroundContextInserts,
    foregroundContextInserts,
    rawRecentCanon,
    recentCanonExcerpt,
    foregroundMemory,
    maxGuidanceChars,
    maxInsertChars,
    recentCanonChars,
    maxMemoryChars,
  })

  if (persist) await writeJson(paths.contextReport, report)

  return {
    foregroundGuidance,
    foregroundContextInserts,
    foregroundMemory,
    storyMemory,
    recentCanonExcerpt,
    optionsGuidance,
    report,
  }
}

// Remove the "**读者选择**：<action>" block headers that prefix every canon
// turn in chapters.md, leaving continuous prose. Collapses the blank lines the
// removal leaves behind and trims any leading whitespace. Total function.
export function stripReaderChoiceHeaders(text) {
  return String(text || "")
    .replace(/^[ \t]*\*\*读者选择\*\*[：:][^\n]*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
}

// Truncate story MEMORY.md for the narrator's dedicated Story Memory section.
// MEMORY.md is an append-style index: the first lines are the file's framing
// header (title, version marker, what-this-is note) and entries accrue
// chronologically, newest at the bottom. So we keep the first 4 lines (the
// header) ALWAYS, then keep as many of the MOST RECENT entry lines (the tail)
// as fit — dropping the stale middle. A "…" marker flags the elision.
function truncateStoryMemory(text, maxChars) {
  const raw = String(text || "").replace(/\s+$/, "")
  if (!raw.trim()) return ""
  if (raw.length <= maxChars) return raw
  const lines = raw.split(/\r?\n/)
  const head = lines.slice(0, 4)
  const rest = lines.slice(4)
  let used = head.join("\n").length + 2 // + "\n…"
  const tail = []
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const cost = rest[i].length + 1
    if (used + cost > maxChars) break
    tail.unshift(rest[i])
    used += cost
  }
  const elided = tail.length < rest.length
  return [...head, ...(elided ? ["", "…"] : []), ...tail].join("\n")
}

export async function getLatestContextReport() {
  const text = await readText(paths.contextReport, "")
  if (!text.trim()) {
    const compiled = await compileForegroundContext({ persist: true })
    return compiled.report
  }
  try {
    return JSON.parse(text)
  } catch {
    const compiled = await compileForegroundContext({ persist: true })
    return compiled.report
  }
}

export function contextBudgetDefaults(env = process.env) {
  return {
    recentCanonChars: positiveNumber(env.OPENOVEL_CONTEXT_RECENT_CANON_CHARS, DEFAULT_RECENT_CANON_CHARS),
    maxGuidanceChars: positiveNumber(env.OPENOVEL_CONTEXT_GUIDANCE_CHARS, DEFAULT_MAX_GUIDANCE_CHARS),
    maxInsertChars: positiveNumber(env.OPENOVEL_CONTEXT_INSERT_CHARS, DEFAULT_MAX_INSERT_CHARS),
    maxMemoryChars: positiveNumber(env.OPENOVEL_CONTEXT_MEMORY_CHARS, DEFAULT_MAX_MEMORY_CHARS),
    maxStoryMemoryChars: positiveNumber(env.OPENOVEL_CONTEXT_STORY_MEMORY_CHARS, DEFAULT_MAX_STORY_MEMORY_CHARS),
  }
}

export function formatContextReport(report) {
  const sources = Array.isArray(report?.sources) ? report.sources : []
  const dropped = Array.isArray(report?.dropped) ? report.dropped : []
  const warnings = Array.isArray(report?.warnings) ? report.warnings : []
  const rows = [
    "Context Report",
    `generated: ${report?.generatedAt || "-"}`,
    `turn: ${report?.turnId || "-"} action: ${report?.action || "-"}`,
    "",
    "budgets:",
    `- guidance: ${report?.budgets?.foregroundGuidance?.usedChars || 0}/${report?.budgets?.foregroundGuidance?.maxChars || 0} chars`,
    `- memory: ${report?.budgets?.memory?.usedChars || 0}/${report?.budgets?.memory?.maxChars || 0} chars`,
    `- canon excerpt: ${report?.budgets?.canon?.usedChars || 0}/${report?.budgets?.canon?.maxChars || 0} chars`,
    "",
    "included sources:",
    ...sources.filter((source) => source.included).map(formatSource),
  ]

  const omitted = sources.filter((source) => !source.included)
  if (omitted.length) rows.push("", "not included:", ...omitted.map(formatSource))
  if (dropped.length) rows.push("", "dropped:", ...dropped.map(formatDropped))
  if (warnings.length) rows.push("", "warnings:", ...warnings.map((item) => `- ${item}`))
  return rows.join("\n")
}

function buildReport({
  action,
  turnId,
  rawForegroundGuidance,
  foregroundGuidance,
  rawForegroundContextInserts,
  foregroundContextInserts,
  rawRecentCanon,
  recentCanonExcerpt,
  foregroundMemory,
  maxGuidanceChars,
  maxInsertChars,
  recentCanonChars,
  maxMemoryChars,
}) {
  const memoryUsedChars = foregroundMemory.reduce((sum, item) => sum + item.entries.join("\n").length, 0)
  const memoryRawChars = foregroundMemory.reduce((sum, item) => sum + (item.rawChars || 0), 0)
  const sources = [
    {
      id: "foreground-guidance",
      type: "foreground_guidance",
      path: toWorkspacePath(paths.foregroundGuidance),
      included: true,
      reason: "small Markdown working set maintained by the background loop",
      chars: foregroundGuidance.length,
      rawChars: String(rawForegroundGuidance || "").length,
      maxChars: maxGuidanceChars,
      omittedChars: Math.max(0, String(rawForegroundGuidance || "").length - foregroundGuidance.length),
      truncated: String(rawForegroundGuidance || "").length > foregroundGuidance.length,
    },
    {
      id: "foreground-context-inserts",
      type: "foreground_context_inserts",
      path: toWorkspacePath(paths.foregroundContextInserts),
      included: Boolean(foregroundContextInserts),
      reason: "selected Markdown context cards refreshed between foreground turns",
      chars: foregroundContextInserts.length,
      rawChars: String(rawForegroundContextInserts || "").length,
      maxChars: maxInsertChars,
      omittedChars: Math.max(0, String(rawForegroundContextInserts || "").length - foregroundContextInserts.length),
      truncated: String(rawForegroundContextInserts || "").length > foregroundContextInserts.length,
    },
    {
      id: "recent-canon",
      type: "canon_excerpt",
      path: toWorkspacePath(paths.chapters),
      included: Boolean(recentCanonExcerpt),
      reason: "latest reader-facing prose for local continuity",
      chars: recentCanonExcerpt.length,
      rawChars: String(rawRecentCanon || "").length,
      maxChars: recentCanonChars,
      omittedChars: Math.max(0, String(rawRecentCanon || "").length - recentCanonExcerpt.length),
      truncated: String(rawRecentCanon || "").length > recentCanonExcerpt.length,
    },
    ...foregroundMemory.map((item) => ({
      id: `memory-${item.target}`,
      type: "memory",
      path: item.path,
      included: item.entries.length > 0,
      reason:
        item.target === "user"
          ? "global user-set preferences (read-only for the model)"
          : item.target === "observed"
            ? "model-observed reader notes (cross-session)"
            : item.target === "references"
              ? "shared reference index for reusable research"
            : "story-specific memory and continuity convention",
      chars: item.entries.join("\n").length,
      rawChars: item.rawChars,
      maxChars: maxMemoryChars,
      omittedChars: Math.max(0, (item.rawChars || 0) - item.entries.join("\n").length),
      entries: item.entries.length,
      rawEntries: item.rawEntries,
      maxEntries: item.maxEntries,
      truncated: item.truncated,
    })),
  ]
  const pressure = contextPressure({
    sources,
    maxChars: maxGuidanceChars + maxInsertChars + recentCanonChars + maxMemoryChars,
  })

  return {
    generatedAt: new Date().toISOString(),
    action,
    turnId,
    budgets: {
      foregroundGuidance: {
        usedChars: foregroundGuidance.length,
        rawChars: String(rawForegroundGuidance || "").length,
        maxChars: maxGuidanceChars,
      },
      foregroundContextInserts: {
        usedChars: foregroundContextInserts.length,
        rawChars: String(rawForegroundContextInserts || "").length,
        maxChars: maxInsertChars,
      },
      memory: {
        usedChars: memoryUsedChars,
        rawChars: memoryRawChars,
        maxChars: maxMemoryChars,
      },
      canon: {
        usedChars: recentCanonExcerpt.length,
        rawChars: String(rawRecentCanon || "").length,
        maxChars: recentCanonChars,
      },
    },
    pressure,
    sources,
    warnings: warningsFor({ sources, foregroundMemory, pressure }),
  }
}

export function selectForegroundMemory(snapshot, maxChars) {
  const budget = Math.max(0, Number(maxChars) || 0)
  let used = 0
  return [
    memoryBlock("user", snapshot.user, toWorkspacePath(paths.userMemory)),
    memoryBlock("observed", snapshot.observed, toWorkspacePath(paths.userObservedMemory), 8),
    memoryBlock("story", snapshot.memory, toWorkspacePath(paths.memoryIndex)),
    memoryBlock("references", snapshot.references, toWorkspacePath(paths.sharedReferenceIndex), 8),
  ].map((block) => {
    const entries = []
    let truncated = false
    for (const entry of block.entries) {
      const next = used + entry.length
      if (next > budget) {
        truncated = true
        break
      }
      entries.push(entry)
      used = next
    }
    return { ...block, entries, truncated: truncated || entries.length < block.entries.length }
  })
}

function memoryBlock(target, text, filePath, maxEntries = 12) {
  const allEntries = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
  return {
    target,
    path: filePath,
    entries: allEntries.slice(0, maxEntries),
    rawEntries: allEntries.length,
    maxEntries,
    rawChars: String(text || "").length,
  }
}

function warningsFor({ sources, foregroundMemory, pressure }) {
  const warnings = []
  if (!sources.some((source) => source.type === "foreground_guidance" && source.chars > 0)) {
    warnings.push("Foreground guidance is empty.")
  }
  if (foregroundMemory.every((item) => item.entries.length === 0)) {
    warnings.push("No durable memory entries are included yet.")
  }
  if (pressure.status === "high") {
    warnings.push("Context pressure is high; ask the Storykeeper to compact FOREGROUND.md and move bulky details into ordinary files or context cards.")
  }
  if (pressure.truncatedSources > 0) {
    warnings.push(`${pressure.truncatedSources} context source(s) were clipped by foreground budgets.`)
  }
  return warnings
}

function formatSource(source) {
  const flags = [
    source.truncated ? "truncated" : "",
    source.entries !== undefined ? `${source.entries} entries` : "",
    source.error ? "error" : "",
  ].filter(Boolean)
  const suffix = flags.length ? ` (${flags.join(", ")})` : ""
  return `- ${source.type} ${source.path || source.id}: ${source.chars || 0} chars${suffix} — ${source.reason || ""}`
}

function formatDropped(item) {
  return `- ${item.type} ${item.path || ""}: ${item.reason || "dropped"}`
}

function toWorkspacePath(filePath) {
  return displayWorkspacePath(filePath)
}

// strip per-turn metadata that would bust prompt-cache prefix
// matching. The file on disk keeps these lines (other code reads "Updated Turn:"
// to detect stale Storykeeper patches). They just must not enter the narrator's
// cacheable hot path. Pure pass-through when no volatile lines are present, so
// the initial guidance template is byte-identical to the file on disk.
export function stripVolatileGuidanceLines(text) {
  const value = String(text || "")
  if (!/^(Updated Turn:|Updated:\s*\d{4}-\d{2}-\d{2}T)/m.test(value)) return value
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trimStart()
      if (/^Updated Turn:/i.test(t)) return false
      if (/^Updated:\s*\d{4}-\d{2}-\d{2}T/.test(t)) return false
      return true
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n")
}

function truncateText(text, maxChars) {
  const value = String(text || "")
  const budget = Math.max(0, Number(maxChars) || 0)
  if (!budget || value.length <= budget) return value
  return value.slice(0, budget)
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function contextPressure({ sources, maxChars }) {
  const includedChars = sources.reduce((sum, source) => sum + (source.included ? source.chars || 0 : 0), 0)
  const rawChars = sources.reduce((sum, source) => sum + (source.rawChars || source.chars || 0), 0)
  const truncated = sources.filter((source) => source.truncated)
  const utilization = maxChars ? Number((includedChars / maxChars).toFixed(4)) : 0
  const rawToIncludedRatio = includedChars ? Number((rawChars / includedChars).toFixed(4)) : 0
  return {
    includedChars,
    rawChars,
    maxChars,
    omittedChars: Math.max(0, rawChars - includedChars),
    estimatedTokens: estimateTokens(includedChars),
    rawEstimatedTokens: estimateTokens(rawChars),
    utilization,
    rawToIncludedRatio,
    truncatedSources: truncated.length,
    truncatedSourceIds: truncated.map((source) => source.id),
    status: utilization >= 0.9 || truncated.length >= 2 ? "high" : utilization >= 0.75 || truncated.length ? "watch" : "ok",
  }
}

function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) * 0.6)
}
