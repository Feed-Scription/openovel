import test from "node:test"
import assert from "node:assert/strict"

import {
  isValidShortId,
  slugify,
  parseCatalog,
  serializeCatalog,
  normalizeEntry,
  addEntry,
  resolveShortId,
  hasEntry,
  listShortIds,
  emptyCatalog,
} from "../src/music/catalog.js"
import {
  neteaseConfig,
  isConfigured,
  hasAuth,
  extractSearch,
  extractDetail,
  extractPlayUrl,
  qrCheckStatus,
  search,
  resolvePlayUrl,
  qrStart,
  qrPoll,
} from "../src/music/providers/netease.js"
import { MusicProviderRegistry, hasMusicAuth, isMusicConfigured } from "../src/music/registry.js"

// ── catalog: short id + slug ──────────────────────────────────────────────────
test("isValidShortId accepts lowercase kebab, rejects the rest", () => {
  for (const ok of ["rainy-cafe", "tense", "beat-3", "a"]) assert.equal(isValidShortId(ok), true, ok)
  for (const bad of ["", "-lead", "Rainy", "has space", "汉字", "x".repeat(81), 5, null]) {
    assert.equal(isValidShortId(bad), false, String(bad))
  }
})

test("slugify produces a clean short id", () => {
  assert.equal(slugify("Rainy Café — Night"), "rainy-caf-night")
  assert.equal(slugify("  Tense!!  "), "tense")
  assert.equal(slugify("汉字"), "")
})

// ── catalog: entry normalization ──────────────────────────────────────────────
test("normalizeEntry requires id + provider + trackId, coerces metadata", () => {
  assert.equal(normalizeEntry({ provider: "netease", trackId: "1" }), null) // no id
  assert.equal(normalizeEntry({ id: "a", trackId: "1" }), null) // no provider
  assert.equal(normalizeEntry({ id: "a", provider: "netease" }), null) // no trackId
  const e = normalizeEntry({ id: "rainy", provider: "netease", trackId: 123, title: "X", durationMs: "240000.7", junk: 1 })
  assert.deepEqual(e, { id: "rainy", provider: "netease", trackId: "123", title: "X", artist: "", album: "", cover: "", durationMs: 240001, cue: "" })
  assert.equal("junk" in e, false)
})

// ── catalog: add/dedupe/resolve ───────────────────────────────────────────────
test("addEntry dedupes by short id and never overwrites", () => {
  let cat = emptyCatalog()
  const r1 = addEntry(cat, { id: "rainy", provider: "netease", trackId: "1", title: "First" })
  assert.equal(r1.added, true)
  cat = r1.catalog
  assert.equal(hasEntry(cat, "rainy"), true)
  const r2 = addEntry(cat, { id: "rainy", provider: "netease", trackId: "2", title: "Second" })
  assert.equal(r2.added, false)
  assert.match(r2.reason, /already exists/)
  assert.equal(resolveShortId(r2.catalog, "rainy").trackId, "1", "original entry preserved")
  // invalid short id refused
  assert.equal(addEntry(cat, { id: "Bad ID", provider: "netease", trackId: "9" }).added, false)
  // missing fields refused
  assert.equal(addEntry(cat, { id: "x", provider: "netease" }).added, false)
})

test("resolveShortId / listShortIds", () => {
  const { catalog } = addEntry(emptyCatalog(), { id: "a", provider: "netease", trackId: "1" })
  assert.equal(resolveShortId(catalog, "a").trackId, "1")
  assert.equal(resolveShortId(catalog, "missing"), null)
  assert.equal(resolveShortId(catalog, "Bad ID"), null)
  assert.deepEqual(listShortIds(catalog), ["a"])
})

// ── catalog: parse/serialize round-trip + tolerance ───────────────────────────
test("parseCatalog tolerates garbage and round-trips through serialize", () => {
  assert.deepEqual(parseCatalog(""), emptyCatalog())
  assert.deepEqual(parseCatalog("not json"), emptyCatalog())
  assert.deepEqual(parseCatalog(null), emptyCatalog())
  const { catalog } = addEntry(emptyCatalog(), { id: "a", provider: "netease", trackId: "1", title: "Song" })
  const text = serializeCatalog(catalog)
  const back = parseCatalog(text)
  assert.equal(resolveShortId(back, "a").title, "Song")
  // an invalid entry inside the file is dropped on parse
  const dirty = parseCatalog(JSON.stringify({ entries: { good: { provider: "netease", trackId: "7" }, "Bad Key": { provider: "x", trackId: "8" } } }))
  assert.equal(hasEntry(dirty, "good"), true)
  assert.equal(hasEntry(dirty, "Bad Key"), false)
})

// ── netease: config + auth gating ─────────────────────────────────────────────
test("neteaseConfig resolves defaults + OPENOVEL_MUSIC_* overrides", () => {
  const def = neteaseConfig({})
  assert.equal(def.baseUrl, "https://openapi.music.163.com")
  assert.equal(def.endpoints.search, "/cloudsearch")
  assert.equal(def.endpoints.officialSearch, "/openapi/music/basic/search/song/get/v3")
  assert.equal(def.bitrate, 999)
  assert.equal(JSON.parse(def.device).clientIp, "127.0.0.1")
  assert.match(JSON.parse(def.device).appVer, /^\d+\.\d+\.\d+\.\d+$/)
  assert.equal(isConfigured(def), false) // no clientId/token
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_BASE_URL: "https://x/v1/", OPENOVEL_MUSIC_CLIENT_ID: "cid", OPENOVEL_MUSIC_SEARCH_PATH: "/s" })
  assert.equal(cfg.baseUrl, "https://x/v1") // trailing slash trimmed
  assert.equal(cfg.endpoints.search, "/s")
  assert.equal(isConfigured(cfg), true)
  assert.equal(hasAuth(cfg), false)
  assert.equal(hasAuth(neteaseConfig({ OPENOVEL_MUSIC_TOKEN: "MUSIC_U=abc" })), true)
})

// ── netease: response extractors (tolerant of shape variants) ─────────────────
test("extractSearch handles result.songs and the ar/al/dt variant", () => {
  const classic = extractSearch({ result: { songs: [{ id: 1, name: "A", artists: [{ name: "X" }], album: { name: "Alb", picUrl: "c" }, duration: 200000 }] } })
  assert.deepEqual(classic, [{ trackId: "1", title: "A", artist: "X", album: "Alb", cover: "c", durationMs: 200000 }])
  const modern = extractSearch({ songs: [{ id: 2, name: "B", ar: [{ name: "Y" }, { name: "Z" }], al: { name: "Alb2" }, dt: 99 }] })
  assert.deepEqual(modern, [{ trackId: "2", title: "B", artist: "Y, Z", album: "Alb2", cover: "", durationMs: 99 }])
  assert.deepEqual(extractSearch({}), [])
  assert.deepEqual(extractSearch({ result: { songs: [{ name: "no id" }] } }), []) // id-less dropped
})

test("extractDetail + extractPlayUrl pull from the documented shapes", () => {
  assert.equal(extractDetail({ songs: [{ id: 5, name: "Five", ar: [{ name: "Q" }] }] }).trackId, "5")
  assert.equal(extractPlayUrl({ data: [{ id: 5, url: "https://stream/5.mp3" }] }), "https://stream/5.mp3")
  assert.equal(extractPlayUrl({ url: "https://x/y.mp3" }), "https://x/y.mp3")
  assert.equal(extractPlayUrl({ data: [{ id: 5, url: null }] }), "")
})

// ── netease: QR state machine ─────────────────────────────────────────────────
test("qrCheckStatus maps NetEase codes", () => {
  assert.deepEqual(qrCheckStatus({ code: 801 }), { status: "pending" })
  assert.deepEqual(qrCheckStatus({ code: 802 }), { status: "scanned" })
  assert.deepEqual(qrCheckStatus({ code: 800 }), { status: "expired" })
  assert.deepEqual(qrCheckStatus({ code: 803, cookie: "MUSIC_U=tok" }), { status: "authorized", token: "MUSIC_U=tok" })
})

test("qrStart fetches key then create; qrPoll checks status", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes("/login/qr/key")) return jsonRes({ data: { unikey: "K1" } })
    if (url.includes("/login/qr/create")) return jsonRes({ data: { qrimg: "data:image/png;base64,AAA", qrurl: "https://qr/K1" } })
    if (url.includes("/login/qr/check")) return jsonRes({ code: 803, cookie: "MUSIC_U=tok" })
    throw new Error(`unexpected ${url}`)
  }
  // ncm base → the /login/qr/* flow (the official base uses signed /openapi paths)
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_BASE_URL: "http://localhost:3000", OPENOVEL_MUSIC_CLIENT_ID: "cid" })
  assert.equal(cfg.mode, "ncm")
  const started = await qrStart(cfg, { fetchImpl })
  assert.equal(started.key, "K1")
  assert.equal(started.qrUrl, "https://qr/K1")
  assert.ok(calls[0].includes("/login/qr/key") && calls[1].includes("/login/qr/create"))
  const polled = await qrPoll(cfg, { key: "K1", fetchImpl })
  assert.deepEqual(polled, { status: "authorized", token: "MUSIC_U=tok" })
})

// ── netease: search request shape (both modes) + resolvePlayUrl auth gate ─────
test("search (ncm mode) issues a /cloudsearch keywords request", async () => {
  let seen = ""
  const fetchImpl = async (url) => {
    seen = url
    return jsonRes({ result: { songs: [{ id: 9, name: "Hit", ar: [{ name: "A" }], al: { name: "Al" }, dt: 180000 }] } })
  }
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_BASE_URL: "http://localhost:3000", OPENOVEL_MUSIC_CLIENT_ID: "cid" })
  assert.equal(cfg.mode, "ncm")
  const out = await search(cfg, { query: "rain", limit: 5, fetchImpl })
  assert.match(seen, /\/cloudsearch\?/)
  assert.match(seen, /keywords=rain/)
  assert.equal(out[0].trackId, "9")
})

test("search (official mode) builds the signed /openapi bizContent request", async () => {
  let seen = ""
  const fetchImpl = async (url) => {
    seen = url
    return jsonRes({ code: 200, data: { songs: [{ songId: "ABC123", name: "Hit", artists: [{ name: "A" }], album: { name: "Al" }, duration: 200000 }] } })
  }
  // default base (openapi.music.163.com) → official mode
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "appid", OPENOVEL_MUSIC_CLIENT_SECRET: "secret", OPENOVEL_MUSIC_TOKEN: "tok" })
  assert.equal(cfg.mode, "official")
  const out = await search(cfg, { query: "rain", limit: 3, fetchImpl })
  assert.match(seen, /\/openapi\/music\/basic\/search\/song\/get\/v3\?/)
  assert.match(seen, /appId=appid/)
  assert.match(seen, /signType=RSA_SHA256/)
  assert.match(seen, /accessToken=tok/)
  assert.match(decodeURIComponent(seen), /"keyword":"rain"/)
  assert.equal(out[0].trackId, "ABC123", "the hex songId is preferred over a numeric id")
})

test("search (official mode) rejects NetEase application-level errors", async () => {
  const fetchImpl = async () => jsonRes({ code: 400, message: "bad device params" })
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "appid", OPENOVEL_MUSIC_CLIENT_SECRET: "secret", OPENOVEL_MUSIC_TOKEN: "tok" })
  await assert.rejects(
    () => search(cfg, { query: "rain", limit: 3, fetchImpl }),
    /NetEase search failed code 400: bad device params/,
  )
})

test("search (official mode) redacts sensitive params from transport errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "upstream down" })
  const cfg = neteaseConfig({
    OPENOVEL_MUSIC_CLIENT_ID: "appid",
    OPENOVEL_MUSIC_CLIENT_SECRET: "super-secret",
    OPENOVEL_MUSIC_TOKEN: "token-value",
  })
  await assert.rejects(
    () => search(cfg, { query: "rain", limit: 3, fetchImpl }),
    (error) => {
      assert.match(error.message, /HTTP 500/)
      assert.match(error.message, /accessToken=.*redacted/i)
      assert.match(error.message, /appSecret=.*redacted/i)
      assert.match(error.message, /device=.*redacted/i)
      assert.doesNotMatch(error.message, /super-secret/)
      assert.doesNotMatch(error.message, /token-value/)
      assert.doesNotMatch(error.message, /"deviceId":"357"/)
      return true
    },
  )
})

test("resolvePlayUrl (official mode) hits the playurl endpoint with bizContent songId", async () => {
  let seen = ""
  const fetchImpl = async (url) => { seen = url; return jsonRes({ code: 200, subCode: "200", data: { url: "https://stream/x.mp3" } }) }
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "appid", OPENOVEL_MUSIC_CLIENT_SECRET: "secret", OPENOVEL_MUSIC_TOKEN: "tok" })
  const out = await resolvePlayUrl(cfg, { trackId: "ABA2B0", fetchImpl })
  assert.match(seen, /\/openapi\/music\/basic\/song\/playurl\/get\/v2\?/)
  assert.match(decodeURIComponent(seen), /"songId":"ABA2B0"/)
  assert.match(decodeURIComponent(seen), /"bitrate":999/)
  assert.deepEqual(out, { url: "https://stream/x.mp3" })
})

test("resolvePlayUrl (official mode) rejects NetEase application-level errors", async () => {
  const fetchImpl = async () => jsonRes({ code: 403, message: "token lacks playback scope" })
  const cfg = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "appid", OPENOVEL_MUSIC_CLIENT_SECRET: "secret", OPENOVEL_MUSIC_TOKEN: "tok" })
  await assert.rejects(
    () => resolvePlayUrl(cfg, { trackId: "ABA2B0", fetchImpl }),
    /NetEase playback URL failed code 403: token lacks playback scope/,
  )
})

test("resolvePlayUrl returns null without a token, a url with one", async () => {
  const fetchImpl = async () => jsonRes({ data: [{ id: 9, url: "https://stream/9.mp3" }] })
  const noTok = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "cid" })
  assert.equal(await resolvePlayUrl(noTok, { trackId: "9", fetchImpl }), null)
  const withTok = neteaseConfig({ OPENOVEL_MUSIC_CLIENT_ID: "cid", OPENOVEL_MUSIC_TOKEN: "MUSIC_U=t" })
  assert.deepEqual(await resolvePlayUrl(withTok, { trackId: "9", fetchImpl }), { url: "https://stream/9.mp3" })
})

// ── registry routing ──────────────────────────────────────────────────────────
test("registry routes search to the configured provider and gates resolvePlayUrl on auth", async () => {
  const reg = new MusicProviderRegistry([
    {
      id: "netease",
      name: "NetEase",
      resolveConfig: (env) => neteaseConfig(env),
      configured: isConfigured,
      hasAuth,
      search,
      resolvePlayUrl,
    },
  ])
  const fetchImpl = async (url) =>
    url.includes("/song/url")
      ? jsonRes({ data: [{ url: "https://stream/x.mp3" }] })
      : jsonRes({ result: { songs: [{ id: 1, name: "S" }] } })

  // unconfigured → search throws
  await assert.rejects(() => reg.search({ query: "a", env: {}, fetchImpl }), /not configured/i)
  // configured (ncm base + clientId) → search works
  const env = { OPENOVEL_MUSIC_BASE_URL: "http://localhost:3000", OPENOVEL_MUSIC_CLIENT_ID: "cid" }
  const res = await reg.search({ query: "a", env, fetchImpl })
  assert.equal(res.results[0].trackId, "1")
  // play url gated on token
  assert.equal(await reg.resolvePlayUrl({ trackId: "1", env, fetchImpl }), null)
  const authedEnv = { ...env, OPENOVEL_MUSIC_TOKEN: "MUSIC_U=t" }
  assert.deepEqual(await reg.resolvePlayUrl({ trackId: "1", env: authedEnv, fetchImpl }), { url: "https://stream/x.mp3" })
})

test("hasMusicAuth / isMusicConfigured reflect env", () => {
  assert.equal(isMusicConfigured({}), false)
  // official (default base) needs appId + appSecret
  assert.equal(isMusicConfigured({ OPENOVEL_MUSIC_CLIENT_ID: "cid" }), false)
  assert.equal(isMusicConfigured({ OPENOVEL_MUSIC_CLIENT_ID: "cid", OPENOVEL_MUSIC_CLIENT_SECRET: "sec" }), true)
  // ncm base just needs a clientId (or token)
  assert.equal(isMusicConfigured({ OPENOVEL_MUSIC_BASE_URL: "http://localhost:3000", OPENOVEL_MUSIC_CLIENT_ID: "cid" }), true)
  assert.equal(hasMusicAuth({ OPENOVEL_MUSIC_CLIENT_ID: "cid" }), false)
  assert.equal(hasMusicAuth({ OPENOVEL_MUSIC_TOKEN: "MUSIC_U=t" }), true)
})

function jsonRes(obj) {
  return { ok: true, status: 200, text: async () => JSON.stringify(obj) }
}
