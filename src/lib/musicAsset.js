// Trust boundary + URL contract for the privileged `ovl-music://` scheme — the
// renderer plays music by short id (`ovl-music://local/<shortId>`) and the main
// process resolves that, via the catalog + provider, into a live stream URL it
// proxies. This keeps the provider token in main (never in the model/renderer),
// avoids CORS, and means the renderer never holds a long media URL.
//
// Mirrors lib/includeAsset.js: pure + dependency-injected so the resolve/reject
// decision is unit-testable. The catalog, provider registry, env, and fetch are
// all passed in.

import { isValidShortId, resolveShortId } from "../music/catalog.js"

export const MUSIC_SCHEME = "ovl-music"

// Build the URL the renderer's <audio>/<img> points at. `part` "cover" → album
// art; anything else → the audio stream.
export function musicAssetUrl(shortId, part) {
  const base = `${MUSIC_SCHEME}://local/${encodeURIComponent(String(shortId || ""))}`
  return part === "cover" ? `${base}?part=cover` : base
}

// ovl-music://local/<shortId>[?part=cover] → { shortId, part } | null. Rejects
// anything that isn't a well-formed ovl-music URL with a valid short id.
export function parseMusicUrl(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== `${MUSIC_SCHEME}:`) return null
    const shortId = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "")
    if (!isValidShortId(shortId)) return null
    return { shortId, part: u.searchParams.get("part") === "cover" ? "cover" : "audio" }
  } catch {
    return null
  }
}

// Resolve an ovl-music URL to the remote URL the main process should stream.
//   deps: { catalog (parsed object), registry (musicProviderRegistry), env, fetchImpl }
// → { ok:true, kind:"audio"|"cover", streamUrl } | { ok:false, reason }
export async function resolveMusicTarget(url, { catalog, registry, env, fetchImpl } = {}) {
  const parsed = parseMusicUrl(url)
  if (!parsed) return { ok: false, reason: "not an ovl-music url" }
  const entry = resolveShortId(catalog, parsed.shortId)
  if (!entry) return { ok: false, reason: `short id not in catalog: ${parsed.shortId}` }
  try {
    if (parsed.part === "cover") {
      const detail =
        typeof registry?.trackDetail === "function"
          ? await registry.trackDetail({ trackId: entry.trackId, provider: entry.provider, env, fetchImpl })
          : null
      const cover = (detail && detail.cover) || entry.cover || ""
      if (!cover) return { ok: false, reason: "no cover art" }
      return { ok: true, kind: "cover", streamUrl: cover }
    }
    const play = await registry.resolvePlayUrl({ trackId: entry.trackId, provider: entry.provider, env, fetchImpl })
    if (!play?.url) return { ok: false, reason: "no playable stream (provider not authorized?)" }
    return { ok: true, kind: "audio", streamUrl: play.url }
  } catch (error) {
    return { ok: false, reason: error?.message || "resolve failed" }
  }
}
