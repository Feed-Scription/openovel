// Music-provider credentials + 扫码登录 token, stored in the same global
// settings.local.json the API-keys panel uses (under `music.<provider>`) and
// hydrated into OPENOVEL_MUSIC_* so the registry + the privileged resolver read
// them. The token lives ONLY here in the main process — never sent to the model
// or the renderer (the renderer gets a redacted snapshot + plays via
// ovl-music://). Mirrors apiKeysStore.js.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

import { settingsEnv } from "../config/settings.js"
import { musicProviderRegistry } from "../music/registry.js"

const PROVIDER = "netease"

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(settingsFilePath(), "utf8"))
  } catch {
    return {}
  }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

function musicSection(settings) {
  return (settings && settings.music && settings.music[PROVIDER]) || {}
}

// Mirror stored creds + token into process.env so the registry / resolver pick
// them up without a restart. Idempotent.
export async function hydrateMusicEnvFromSettings() {
  const cfg = musicSection(await readSettingsFile())
  const map = {
    OPENOVEL_MUSIC_CLIENT_ID: cfg.clientId,
    OPENOVEL_MUSIC_CLIENT_SECRET: cfg.clientSecret,
    OPENOVEL_MUSIC_BASE_URL: cfg.baseUrl,
    OPENOVEL_MUSIC_DEVICE: cfg.device,
    OPENOVEL_MUSIC_TOKEN: cfg.token,
  }
  for (const [k, v] of Object.entries(map)) {
    if (v) process.env[k] = String(v)
  }
  if (cfg.provider || PROVIDER) process.env.OPENOVEL_MUSIC_PROVIDER = cfg.provider || PROVIDER
}

function mask(value) {
  const s = String(value || "")
  if (!s) return ""
  if (s.length <= 8) return "*".repeat(s.length)
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

// Redacted view for the renderer — never the raw token/secret.
export async function getMusicAuthSnapshot() {
  const cfg = musicSection(await readSettingsFile())
  const token = process.env.OPENOVEL_MUSIC_TOKEN || cfg.token || ""
  return {
    provider: PROVIDER,
    filePath: settingsFilePath(),
    clientId: cfg.clientId || process.env.OPENOVEL_MUSIC_CLIENT_ID || "",
    clientSecretSet: Boolean(cfg.clientSecret || process.env.OPENOVEL_MUSIC_CLIENT_SECRET),
    baseUrl: cfg.baseUrl || process.env.OPENOVEL_MUSIC_BASE_URL || "",
    device: cfg.device || process.env.OPENOVEL_MUSIC_DEVICE || "",
    authorized: Boolean(token),
    tokenMasked: mask(token),
  }
}

// Save personal-access credentials (clientId/secret/baseUrl/device). Empty string clears.
export async function setMusicConfig(patch = {}) {
  const settings = await readSettingsFile()
  settings.music = settings.music || {}
  settings.music[PROVIDER] = settings.music[PROVIDER] || {}
  const m = settings.music[PROVIDER]
  for (const [key, envKey] of [
    ["clientId", "OPENOVEL_MUSIC_CLIENT_ID"],
    ["clientSecret", "OPENOVEL_MUSIC_CLIENT_SECRET"],
    ["baseUrl", "OPENOVEL_MUSIC_BASE_URL"],
    ["device", "OPENOVEL_MUSIC_DEVICE"],
  ]) {
    if (!(key in patch)) continue
    const value = typeof patch[key] === "string" ? patch[key].trim() : ""
    if (key === "device" && value) {
      try {
        const parsed = JSON.parse(value)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      } catch {
        throw new Error("Music device must be a JSON object string from the NetEase open-platform device parameters.")
      }
    }
    if (value) {
      m[key] = value
      process.env[envKey] = value
    } else {
      delete m[key]
      delete process.env[envKey]
    }
  }
  await writeSettingsFile(settings)
  return getMusicAuthSnapshot()
}

// The 扫码登录/OAuth token (or a pasted access_token — the demo fast path).
export async function setMusicToken(token) {
  const settings = await readSettingsFile()
  settings.music = settings.music || {}
  settings.music[PROVIDER] = settings.music[PROVIDER] || {}
  const value = typeof token === "string" ? token.trim() : ""
  if (value) {
    settings.music[PROVIDER].token = value
    process.env.OPENOVEL_MUSIC_TOKEN = value
  } else {
    delete settings.music[PROVIDER].token
    delete process.env.OPENOVEL_MUSIC_TOKEN
  }
  await writeSettingsFile(settings)
  return getMusicAuthSnapshot()
}

export async function clearMusicAuth() {
  return setMusicToken("")
}

// ── 扫码登录 orchestration (runs in main: network + token storage) ────────────
export async function startMusicQr() {
  const { provider, config, configured } = musicProviderRegistry.resolve({ env: settingsEnv() })
  if (!configured) return { ok: false, message: "set the NetEase clientId first (Settings → Music)" }
  if (!provider?.auth?.qrStart) return { ok: false, message: `${provider?.id || "provider"} has no QR login` }
  try {
    const { key, qrImg, qrUrl } = await provider.auth.qrStart(config, {})
    return { ok: true, key, qrImg, qrUrl }
  } catch (error) {
    return { ok: false, message: error?.message || "qr start failed" }
  }
}

export async function pollMusicQr(key) {
  const { provider, config } = musicProviderRegistry.resolve({ env: settingsEnv() })
  if (!provider?.auth?.qrPoll) return { status: "error", message: "no QR login" }
  try {
    const res = await provider.auth.qrPoll(config, { key })
    if (res.status === "authorized" && res.token) await setMusicToken(res.token)
    return res
  } catch (error) {
    return { status: "error", message: error?.message || "qr poll failed" }
  }
}

// ── Test connection ───────────────────────────────────────────────────────────
// Like the model/image "test" buttons: a live probe of the configured provider.
// Runs a small search (proves the base URL is reachable + the response parses)
// and, when a token is present, resolves a play URL for the first hit (proves
// playback auth actually works — the gate that matters). Returns { ok, ... }.
const TEST_QUERY = "love"

export async function testMusicConnection() {
  const t0 = Date.now()
  await hydrateMusicEnvFromSettings()
  const env = settingsEnv()
  let resolved
  try {
    resolved = musicProviderRegistry.resolve({ env })
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - t0, error: error?.message || String(error) }
  }
  if (!resolved.configured) {
    return { ok: false, latencyMs: Date.now() - t0, error: "Set the clientId, or paste an access token, before testing." }
  }
  try {
    const { results, provider } = await musicProviderRegistry.search({ query: TEST_QUERY, limit: 3, env })
    const count = Array.isArray(results) ? results.length : 0
    const out = {
      ok: true,
      latencyMs: Date.now() - t0,
      provider,
      authorized: resolved.authorized,
      resultCount: count,
      sampleTitle: count ? [results[0].title, results[0].artist].filter(Boolean).join(" — ") : "",
    }
    // With a token + at least one hit, confirm the playback path resolves a stream.
    if (resolved.authorized && count) {
      try {
        const play = await musicProviderRegistry.resolvePlayUrl({ trackId: results[0].trackId, env })
        out.playable = Boolean(play?.url)
        if (!out.playable) out.playableNote = "search works, but no playable stream for the sample (VIP/copyright, or the token lacks playback scope)"
      } catch (error) {
        out.playable = false
        out.playableNote = error?.message || String(error)
      }
    } else if (resolved.authorized) {
      out.playable = null
      out.playableNote = "search returned no sample track, so playback was not tested"
    }
    return out
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - t0, authorized: resolved.authorized, error: error?.message || String(error) }
  }
}
