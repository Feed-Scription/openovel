// NetEase Cloud Music (网易云音乐) open-platform adapter. Two modes:
//
//   "official" — the real developer.music.163.com / openapi.music.163.com 个人接入
//     platform. Every call is a GET to /openapi/music/basic/... carrying a
//     `bizContent` JSON string plus appId / appSecret / accessToken / device /
//     timestamp / signType (per the platform's request examples). Auto-selected
//     when the base URL is openapi.music.163.com.
//
//   "ncm" — the reverse-engineered NeteaseCloudMusicApi (Binaryify) shape
//     (cookie auth, /login/qr/*, /cloudsearch, /song/url). Used for any other
//     base (point OPENOVEL_MUSIC_BASE_URL at a self-hosted instance).
//
// CAPABILITY DEMO: a pasted accessToken (official) / cookie (ncm) short-circuits
// the QR flow so the cue→play loop is demonstrable immediately. Paths are all
// configurable via OPENOVEL_MUSIC_*. Pure-ish: every network function takes an
// injectable `fetchImpl` so request-shape + parsing unit-test without a live API.

const DEFAULTS = {
  baseUrl: "https://openapi.music.163.com",
  authStyle: "cookie", // ncm: auth rides a Cookie (MUSIC_U); "bearer" for an access_token
  // Official docs require app-specific channel/os/brand/deviceType values that
  // NetEase assigns offline. This sample blob only keeps the request shape valid;
  // production users should override it with OPENOVEL_MUSIC_DEVICE.
  device:
    '{"deviceType":"andrwear","os":"otos","appVer":"0.1.0.0","channel":"hm","model":"kys","deviceId":"357","brand":"hm","osVer":"8.1.0","clientIp":"127.0.0.1"}',
  // Official playurl docs use quality codes: 128 / 192 / 320 / 999 / 1999.
  // 999 asks for lossless when the account + copyright scope allow it.
  bitrate: 999,
  ncm: {
    qrKey: "/login/qr/key",
    qrCreate: "/login/qr/create",
    qrCheck: "/login/qr/check",
    search: "/cloudsearch",
    songDetail: "/song/detail",
    songUrl: "/song/url",
  },
  official: {
    search: "/openapi/music/basic/search/song/get/v3",
    songPlayUrl: "/openapi/music/basic/song/playurl/get/v2",
    qrKey: "/openapi/music/basic/user/oauth2/qrcodekey/get/v2",
  },
}

// official when the base is the real openapi.music.163.com; ncm otherwise.
// OPENOVEL_MUSIC_MODE forces it explicitly.
function resolveMode(env, baseUrl) {
  const explicit = String(env.OPENOVEL_MUSIC_MODE || "").toLowerCase()
  if (explicit === "official" || explicit === "ncm") return explicit
  return /openapi\.music\.163\.com/i.test(baseUrl) ? "official" : "ncm"
}

export function neteaseConfig(env = {}) {
  const baseUrl = String(env.OPENOVEL_MUSIC_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, "")
  const n = DEFAULTS.ncm
  const o = DEFAULTS.official
  return {
    id: "netease",
    baseUrl,
    mode: resolveMode(env, baseUrl),
    clientId: String(env.OPENOVEL_MUSIC_CLIENT_ID || ""), // = appId (official)
    clientSecret: String(env.OPENOVEL_MUSIC_CLIENT_SECRET || ""), // = appSecret (official)
    token: String(env.OPENOVEL_MUSIC_TOKEN || ""), // = accessToken (official) / cookie (ncm)
    authStyle: String(env.OPENOVEL_MUSIC_AUTH_STYLE || DEFAULTS.authStyle),
    device: String(env.OPENOVEL_MUSIC_DEVICE || DEFAULTS.device),
    bitrate: Number(env.OPENOVEL_MUSIC_BITRATE || DEFAULTS.bitrate),
    endpoints: {
      qrKey: String(env.OPENOVEL_MUSIC_QR_KEY_PATH || n.qrKey),
      qrCreate: String(env.OPENOVEL_MUSIC_QR_CREATE_PATH || n.qrCreate),
      qrCheck: String(env.OPENOVEL_MUSIC_QR_CHECK_PATH || n.qrCheck),
      search: String(env.OPENOVEL_MUSIC_SEARCH_PATH || n.search),
      songDetail: String(env.OPENOVEL_MUSIC_SONG_DETAIL_PATH || n.songDetail),
      songUrl: String(env.OPENOVEL_MUSIC_SONG_URL_PATH || n.songUrl),
      officialSearch: String(env.OPENOVEL_MUSIC_OFFICIAL_SEARCH_PATH || o.search),
      officialPlayUrl: String(env.OPENOVEL_MUSIC_OFFICIAL_PLAYURL_PATH || o.songPlayUrl),
      officialQrKey: String(env.OPENOVEL_MUSIC_OFFICIAL_QRKEY_PATH || o.qrKey),
    },
  }
}

export function isConfigured(config) {
  if (config?.mode === "official") return Boolean(config.baseUrl && config.clientId && config.clientSecret)
  return Boolean(config?.baseUrl && (config.token || config.clientId))
}

// A user token (accessToken / cookie) is what authorizes playback.
export function hasAuth(config) {
  return Boolean(config?.token)
}

function authHeaders(config) {
  if (config?.mode === "official" || !config?.token) return {} // official auth rides query params
  if (config.authStyle === "bearer") return { Authorization: `Bearer ${config.token}` }
  return { Cookie: config.token }
}

function redactUrl(value) {
  try {
    const url = new URL(String(value))
    for (const key of ["accessToken", "appSecret", "device"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]")
    }
    return url.toString()
  } catch {
    return String(value)
      .replace(/(accessToken=)[^&\s]+/gi, "$1[redacted]")
      .replace(/(appSecret=)[^&\s]+/gi, "$1[redacted]")
      .replace(/(device=)[^&\s]+/gi, "$1[redacted]")
  }
}

function assertOfficialOk(data, action) {
  const code = data?.code
  const subCode = data?.subCode ?? data?.subcode
  const codeOk = code === undefined || code === null || code === "" || Number(code) === 200
  const subCodeNumber = Number(subCode)
  const subCodeOk =
    subCode === undefined ||
    subCode === null ||
    subCode === "" ||
    subCodeNumber === 0 ||
    subCodeNumber === 200
  if (codeOk && subCodeOk) return
  const message = String(data?.message || data?.msg || data?.error || data?.errmsg || "unexpected response")
  const bits = [`NetEase ${action} failed`]
  if (!codeOk) bits.push(`code ${code}`)
  if (!subCodeOk) bits.push(`subCode ${subCode}`)
  throw new Error(`${bits.join(" ")}: ${message}`)
}

// The common official param envelope: the business params go in bizContent (a
// JSON string), everything else is a flat query param.
function officialParams(config, bizContent) {
  return {
    bizContent: JSON.stringify(bizContent),
    appId: config.clientId,
    signType: "RSA_SHA256",
    accessToken: config.token,
    appSecret: config.clientSecret,
    device: config.device,
    timestamp: Date.now(),
  }
}

async function getJson(url, { fetchImpl, headers, method = "GET", body } = {}) {
  const doFetch = fetchImpl || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20 * 1000)
  try {
    const res = await doFetch(url, {
      method,
      headers: { Accept: "application/json", ...(headers || {}) },
      body,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`non-JSON response from ${redactUrl(url)}: ${text.slice(0, 160)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function qs(params) {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ""
}

// ── search ───────────────────────────────────────────────────────────────────
export function extractSearch(data) {
  const songs =
    data?.result?.songs ||
    data?.songs ||
    data?.data?.songs ||
    data?.data?.result?.songs ||
    data?.data?.list ||
    []
  if (!Array.isArray(songs)) return []
  return songs.map(extractTrack).filter(Boolean)
}

function extractTrack(song) {
  if (!song || typeof song !== "object") return null
  // Prefer songId (official hex id, what playurl wants) over the numeric id.
  const trackId = String(song.songId ?? song.id ?? song.trackId ?? song.songIdStr ?? "").trim()
  if (!trackId) return null
  const artists = song.artists || song.ar || song.singers || []
  const artist = Array.isArray(artists) ? artists.map((a) => a?.name).filter(Boolean).join(", ") : ""
  const album = song.album || song.al || {}
  const durationMs = Number(song.duration ?? song.dt ?? 0)
  return {
    trackId,
    title: String(song.name || song.title || song.songName || "").trim(),
    artist: String(artist).trim(),
    album: String(album?.name || "").trim(),
    cover: String(album?.picUrl || album?.cover || song.picUrl || "").trim(),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
  }
}

export async function search(config, { query, limit = 8, fetchImpl } = {}) {
  const q = String(query || "").trim()
  if (!q) return []
  const url =
    config.mode === "official"
      ? `${config.baseUrl}${config.endpoints.officialSearch}${qs(officialParams(config, { keyword: q, limit: String(limit), offset: "0" }))}`
      : `${config.baseUrl}${config.endpoints.search}${qs({ keywords: q, keyword: q, type: 1, limit, clientId: config.clientId })}`
  const data = await getJson(url, { fetchImpl, headers: authHeaders(config) })
  if (config.mode === "official") assertOfficialOk(data, "search")
  return extractSearch(data).slice(0, limit)
}

// ── track detail (ncm only; official search carries enough metadata) ──────────
export function extractDetail(data) {
  const song = data?.songs?.[0] || data?.result?.songs?.[0] || data?.data?.[0] || data?.data?.song || null
  return extractTrack(song)
}

export async function trackDetail(config, { trackId, fetchImpl } = {}) {
  const id = String(trackId || "").trim()
  if (!id || config.mode === "official") return null
  const url = `${config.baseUrl}${config.endpoints.songDetail}${qs({ id, ids: `[${id}]`, clientId: config.clientId })}`
  const data = await getJson(url, { fetchImpl, headers: authHeaders(config) })
  return extractDetail(data)
}

// ── play url ─────────────────────────────────────────────────────────────────
export function extractPlayUrl(data) {
  const first = data?.data?.[0] || data?.data || data?.result || null
  const url = first?.url || first?.playUrl || data?.url || (typeof first === "string" ? first : "")
  return url ? String(url) : ""
}

// Returns { url } the privileged resolver streams, or null. Requires a user token.
export async function resolvePlayUrl(config, { trackId, fetchImpl } = {}) {
  const id = String(trackId || "").trim()
  if (!id || !hasAuth(config)) return null
  const url =
    config.mode === "official"
      ? `${config.baseUrl}${config.endpoints.officialPlayUrl}${qs(officialParams(config, { songId: id, bitrate: config.bitrate }))}`
      : `${config.baseUrl}${config.endpoints.songUrl}${qs({ id, ids: `[${id}]`, clientId: config.clientId })}`
  const data = await getJson(url, { fetchImpl, headers: authHeaders(config) })
  if (config.mode === "official") assertOfficialOk(data, "playback URL")
  const playUrl = extractPlayUrl(data)
  return playUrl ? { url: playUrl } : null
}

// ── 扫码登录 (QR) state machine ───────────────────────────────────────────────
export async function qrStart(config, { fetchImpl } = {}) {
  if (config.mode === "official") {
    // The official QR login obtains a qrcodekey; the qrcode-create + check
    // endpoints aren't wired yet, so we can't complete the poll loop. Surface a
    // clear message — the demo path is pasting an accessToken.
    const url = `${config.baseUrl}${config.endpoints.officialQrKey}${qs(officialParams(config, { type: 2, expiredKey: "604800" }))}`
    const data = await getJson(url, { fetchImpl })
    assertOfficialOk(data, "QR login")
    const key = String(data?.data?.qrCodeKey || data?.data?.codeKey || data?.data?.unikey || data?.data?.key || "").trim()
    throw new Error(
      key
        ? `official QR login isn't fully wired (need the qrcode-create + check endpoints). Got a qrcodekey (${key.slice(0, 8)}…) — paste an accessToken under Settings → Music for now.`
        : `official qrcodekey response from ${url} had no key — got ${JSON.stringify(data).slice(0, 240)}. Paste an accessToken instead.`,
    )
  }
  const ts = Date.now() // ncm cache buster
  const keyUrl = `${config.baseUrl}${config.endpoints.qrKey}${qs({ clientId: config.clientId, timestamp: ts })}`
  const keyData = await getJson(keyUrl, { fetchImpl, headers: authHeaders(config) })
  const key = String(keyData?.data?.unikey || keyData?.unikey || keyData?.data?.key || "").trim()
  if (!key) {
    throw new Error(
      `qr key response from ${keyUrl} had no unikey — got ${JSON.stringify(keyData).slice(0, 240)}. ` +
        `This QR flow expects a NeteaseCloudMusicApi-compatible endpoint. Point OPENOVEL_MUSIC_BASE_URL at a compatible base, or use the paste-token fast path.`,
    )
  }
  const createData = await getJson(
    `${config.baseUrl}${config.endpoints.qrCreate}${qs({ key, qrimg: true, clientId: config.clientId, timestamp: ts })}`,
    { fetchImpl, headers: authHeaders(config) },
  )
  const qrImg = String(createData?.data?.qrimg || createData?.qrimg || "").trim()
  const qrUrl = String(createData?.data?.qrurl || createData?.qrurl || "").trim()
  return { key, qrImg, qrUrl }
}

export function qrCheckStatus(data) {
  const code = Number(data?.code ?? data?.data?.code ?? 0)
  const token = String(data?.cookie || data?.data?.cookie || data?.token || data?.data?.token || "").trim()
  if (code === 803) return { status: "authorized", token }
  if (code === 802) return { status: "scanned" }
  if (code === 800) return { status: "expired" }
  return { status: "pending" }
}

export async function qrPoll(config, { key, fetchImpl } = {}) {
  const k = String(key || "").trim()
  if (!k) return { status: "expired" }
  if (config.mode === "official") return { status: "error", message: "official QR poll not wired — paste an accessToken" }
  const data = await getJson(
    `${config.baseUrl}${config.endpoints.qrCheck}${qs({ key: k, clientId: config.clientId, timestamp: Date.now() })}`,
    { fetchImpl, headers: authHeaders(config) },
  )
  return qrCheckStatus(data)
}

// Personal-access tokens are long-lived; refresh is a no-op for the demo.
export async function refresh(config) {
  return { token: config?.token || "" }
}

// The registry provider object.
export const neteaseProvider = {
  id: "netease",
  name: "NetEase Cloud Music (网易云音乐 · 个人接入)",
  resolveConfig: neteaseConfig,
  configured: isConfigured,
  hasAuth,
  search,
  trackDetail,
  resolvePlayUrl,
  auth: { qrStart, qrPoll, refresh },
}
