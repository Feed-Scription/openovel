// The music catalog — the single source of truth mapping a narrator-facing
// SEMANTIC SHORT ID to a provider track + display metadata. The Music agent
// writes it (story/music/CATALOG.json); the renderer reads it for now-playing
// metadata; the privileged ovl-music:// resolver reads it to turn a short id
// into a live stream. The narrator only ever sees the short id — never the
// trackId, never a URL.
//
// Pure + filesystem-free so it unit-tests without a workspace. A thin loader
// (the resolver / view-model) reads the JSON off disk and hands the parsed
// object here.
//
// Shape: { version: 1, entries: { [shortId]: Entry } }
//   Entry: { id, provider, trackId, title, artist, album, cover, durationMs, cue }

export const CATALOG_VERSION = 1

// A short id is a lowercase ascii kebab slug — URL-clean (it rides in
// ovl-music://local/<shortId>) and stable as a catalog key. The agent authors
// semantic ids; slugify is the normalizer / fallback.
const SHORT_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function isValidShortId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && SHORT_ID_RE.test(value)
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

export function emptyCatalog() {
  return { version: CATALOG_VERSION, entries: {} }
}

// Tolerant parse: any malformed input yields an empty catalog rather than
// throwing (a half-written file must never crash the resolver / renderer).
export function parseCatalog(text) {
  if (text && typeof text === "object") return normalizeCatalog(text)
  const raw = String(text ?? "").trim()
  if (!raw) return emptyCatalog()
  try {
    return normalizeCatalog(JSON.parse(raw))
  } catch {
    return emptyCatalog()
  }
}

function normalizeCatalog(obj) {
  const out = emptyCatalog()
  const entries = obj && typeof obj === "object" ? obj.entries : null
  if (entries && typeof entries === "object") {
    for (const [key, value] of Object.entries(entries)) {
      const entry = normalizeEntry({ ...value, id: value?.id || key })
      if (entry && isValidShortId(entry.id)) out.entries[entry.id] = entry
    }
  }
  return out
}

export function serializeCatalog(catalog) {
  const safe = normalizeCatalog(catalog || {})
  return `${JSON.stringify(safe, null, 2)}\n`
}

// Coerce a raw entry into the validated shape, or null if it lacks the
// load-bearing fields (id + provider + trackId). Metadata is best-effort.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null
  const id = String(raw.id || "").trim()
  const provider = String(raw.provider || "").trim()
  const trackId = String(raw.trackId ?? raw.track_id ?? "").trim()
  if (!id || !provider || !trackId) return null
  const durationMs = Number(raw.durationMs ?? raw.duration_ms ?? 0)
  return {
    id,
    provider,
    trackId,
    title: String(raw.title || "").trim(),
    artist: String(raw.artist || "").trim(),
    album: String(raw.album || "").trim(),
    cover: String(raw.cover || "").trim(),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
    cue: String(raw.cue || "").trim(),
  }
}

export function hasEntry(catalog, shortId) {
  return Boolean(catalog?.entries && Object.prototype.hasOwnProperty.call(catalog.entries, shortId))
}

export function resolveShortId(catalog, shortId) {
  if (!isValidShortId(shortId)) return null
  return catalog?.entries?.[shortId] || null
}

export function listShortIds(catalog) {
  return catalog?.entries ? Object.keys(catalog.entries) : []
}

// Add an entry, deduping by short id (NEVER overwrite — the agent must not
// regenerate). Returns { catalog, added, reason }. The input catalog is not
// mutated.
export function addEntry(catalog, rawEntry) {
  const base = normalizeCatalog(catalog || {})
  const entry = normalizeEntry(rawEntry)
  if (!entry) return { catalog: base, added: false, reason: "entry missing id/provider/trackId" }
  if (!isValidShortId(entry.id)) return { catalog: base, added: false, reason: `invalid short id "${entry.id}" (lowercase kebab a-z0-9-)` }
  if (hasEntry(base, entry.id)) return { catalog: base, added: false, reason: `short id "${entry.id}" already exists` }
  return { catalog: { ...base, entries: { ...base.entries, [entry.id]: entry } }, added: true, reason: "" }
}
