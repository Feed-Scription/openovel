export const DEFAULT_SCENE = "waiting for the reader's opening action."

export function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback
}

export function arrayOfStrings(value, fallback = []) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : fallback
}

export function inboxDispositionIds(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim()
      if (item && typeof item === "object") return String(item.id || item.inboxId || "").trim()
      return ""
    })
    .filter(Boolean)
}

export function unclassifiedInboxWarnings(parsed, ctx) {
  const pending = (ctx.snapshot?.backgroundInboxItems || []).map((item) => item.id)
  if (!pending.length) return []
  const handled = new Set([
    ...arrayOfStrings(parsed.inboxResolved),
    ...inboxDispositionIds(parsed.inboxDeferred),
    ...inboxDispositionIds(parsed.inboxRejected),
  ])
  const missing = pending.filter((id) => !handled.has(id))
  return missing.length
    ? [`Inbox items left pending without explicit disposition: ${missing.slice(0, 8).join(", ")}`]
    : []
}

export function objectOr(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback
}

// Generous cap on a full FOREGROUND.md rewrite returned in the envelope. Was a
// silent `return ""` at 6000 chars — a large valid rewrite vanished and the
// model thought it applied. Now we keep up to the cap and, on overflow, record
// a notice (surfaced via envelope warnings → PROVENANCE) instead of dropping.
const ENVELOPE_GUIDANCE_MAX_CHARS = 24000
export function normalizeEnvelopeGuidanceMarkdown(value, notices) {
  const text = String(value || "").trim()
  if (!text) return ""
  if (text.length > ENVELOPE_GUIDANCE_MAX_CHARS) {
    notices?.truncate?.("foregroundGuidanceMarkdown", {
      kept: ENVELOPE_GUIDANCE_MAX_CHARS,
      dropped: text.length - ENVELOPE_GUIDANCE_MAX_CHARS,
    }, { hint: "split the working set into per-section edits instead of one big rewrite" })
    return text.slice(0, ENVELOPE_GUIDANCE_MAX_CHARS)
  }
  return text
}

export function normalizeFilesChanged(value = []) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === "string") return { path: normalizeStoryPath(item), purpose: "", provenance: [] }
      if (!item || typeof item !== "object") return null
      return {
        path: normalizeStoryPath(item.path || item.file || item.filePath),
        purpose: compactText(item.purpose || item.reason || item.summary || "", 240),
        provenance: unique(arrayOfStrings(item.provenance || item.sources || item.sourceEvents)),
      }
    })
    .filter((item) => item?.path)
    .slice(0, 30)
}

export function normalizeStoryPath(value) {
  const text = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!text) return ""
  if (text.startsWith("story/") || text.startsWith("shared/")) return text
  return `story/${text}`
}

export function enumOr(value, allowed, fallback) {
  const text = String(value || "").trim()
  return allowed.includes(text) ? text : fallback
}

export function compactPatch(patch) {
  return {
    ...patch,
    currentScene: compactText(patch.currentScene, 180),
    tone: compactText(patch.tone, 220),
    newFacts: compactRecentList(patch.newFacts, { maxItems: 10, maxChars: 220 }),
    openThreads: compactRecentList(patch.openThreads, { maxItems: 8, maxChars: 220 }),
    forbidden: compactRecentList(patch.forbidden, { maxItems: 8, maxChars: 180 }),
    activeCharacters: compactRecentList(patch.activeCharacters, { maxItems: 8, maxChars: 80 }),
    characterBriefs: compactObject(patch.characterBriefs, { maxItems: 8, maxChars: 180 }),
    characters: compactObject(patch.characters, { maxItems: 8, maxChars: 180 }),
    locations: compactObject(patch.locations, { maxItems: 8, maxChars: 180 }),
    objects: compactObject(patch.objects, { maxItems: 10, maxChars: 180 }),
    groundingNotes: compactRecentList(patch.groundingNotes, { maxItems: 8, maxChars: 220 }),
    counterfactualWarnings: compactRecentList(patch.counterfactualWarnings, { maxItems: 6, maxChars: 220 }),
    continuityWarnings: compactRecentList(patch.continuityWarnings, { maxItems: 6, maxChars: 220 }),
    narrativePatch: compactText(patch.narrativePatch, 700),
    inboxNotes: compactRecentList(patch.inboxNotes, { maxItems: 8, maxChars: 220 }),
    inboxDeferred: compactRecentList(patch.inboxDeferred || [], { maxItems: 20, maxChars: 120 }),
    inboxRejected: compactRecentList(patch.inboxRejected || [], { maxItems: 20, maxChars: 120 }),
    warnings: compactRecentList(patch.warnings || [], { maxItems: 8, maxChars: 240 }),
  }
}

export function compactRecentList(values = [], { maxItems, maxChars }, notices, label) {
  const seen = new Set()
  const out = []
  let droppedToCap = 0
  for (const value of [...values].reverse()) {
    const text = compactText(value, maxChars)
    if (!text || seen.has(text)) continue
    seen.add(text)
    if (out.length >= maxItems) { droppedToCap++; continue }
    out.push(text)
  }
  if (droppedToCap && notices && label) {
    notices.truncate(label, { kept: out.length, dropped: droppedToCap })
  }
  return out.reverse()
}

export function compactObject(value = {}, { maxItems, maxChars }) {
  const entries = Object.entries(value || {})
    .filter(([key]) => String(key || "").trim())
    .slice(-maxItems)
    .map(([key, detail]) => {
      if (typeof detail === "string") return [compactText(key, 80), compactText(detail, maxChars)]
      const next = {}
      for (const [field, fieldValue] of Object.entries(detail || {}).slice(0, 6)) {
        next[compactText(field, 40)] = compactText(fieldValue, maxChars)
      }
      return [compactText(key, 80), next]
    })
  return Object.fromEntries(entries)
}

export function dropStaleFacts(values = []) {
  return values.filter((item) => {
    const text = String(item || "")
    return text.trim() && !text.includes(DEFAULT_SCENE)
  })
}

export function compactText(value, maxChars) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return ""
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : text
}

export function emptyIfDefaultScene(scene) {
  const value = String(scene || "").trim()
  return value === DEFAULT_SCENE ? "" : value
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

export function firstMarkdownValue(text, label) {
  const pattern = new RegExp(`^-\\s+${label}:\\s*(.+)$`, "im")
  const match = String(text || "").match(pattern)
  const value = match?.[1]?.trim() || ""
  return value === "-" ? "" : value
}

export function markdownList(text, heading) {
  const lines = String(text || "").split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break
    const match = line.match(/^-\s+(.+)/)
    if (match?.[1] && match[1].trim() !== "-") out.push(match[1].trim())
  }
  return out
}
