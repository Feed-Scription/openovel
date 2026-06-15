// TTS settings + Volcano (Doubao) credentials, stored in the same
// settings.local.json the API-key/behavior stores use, and mirrored to
// process.env so the running session picks changes up without a restart.
//
// One store owns the whole TTS section (enable, voice, speed, and the 3-part
// Volcano credential) so the Settings UI talks to a single get/set pair, and so
// the 3-value credential doesn't have to be shoehorned into the single-`apiKey`
// shape of apiKeysStore. Credentials are redacted from the snapshot.
//
// Restart persistence works exactly like API keys: writes mirror to env now, and
// hydrateTtsEnvFromSettings() re-seeds env from disk on boot (call it next to
// apiKeysStore.hydrateProcessEnvFromSettings in main.js).

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

import { DEFAULT_TTS_VOICE, DEFAULT_TTS_CLUSTER } from "../lib/ttsConfig.js"
import { slugifyCustomProviderName } from "../provider/customProviders.js"

// Example大模型 (bigtts) voices — the user pastes their console's voice_type;
// these are just datalist hints, not an exhaustive or guaranteed-available set.
export const VOICE_EXAMPLES = [
  { id: "zh_female_cancan_mars_bigtts", label: "灿灿 · 女声" },
  { id: "zh_female_wanwanxiaohe_moon_bigtts", label: "湾湾小何 · 女声" },
  { id: "zh_male_jieshuonansheng_mars_bigtts", label: "解说男声" },
  { id: "zh_female_qingxinnvsheng_mars_bigtts", label: "清新女声" },
  { id: "en_female_anna_mars_bigtts", label: "Anna · English" },
]

// settings.local.json shape ↔ env var. `apiKey` flags the secret fields so the
// snapshot redacts them.
//
// Multi-provider note: `provider` pins "volcano" (the built-in WebSocket
// protocol) or a user-defined OpenAI-compatible endpoint ("custom:<slug>",
// entries under tts.customProviders). Each custom entry keeps its OWN
// baseUrl/model/voice/key in the settings file, so switching providers never
// loses configuration; the ACTIVE entry is compiled into the flat
// OPENOVEL_TTS_* envs by mirrorActiveProviderEnv (the runtime only ever needs
// the active one — same pattern as the image settings store).
const FIELDS = [
  { key: "enabled", path: ["tts", "enabled"], env: "OPENOVEL_ENABLE_TTS", type: "bool", default: false },
  { key: "provider", path: ["tts", "provider"], env: "OPENOVEL_TTS_PROVIDER", type: "string", default: "volcano" },
  { key: "voiceType", path: ["tts", "voiceType"], env: "OPENOVEL_TTS_VOICE_TYPE", type: "string", default: DEFAULT_TTS_VOICE },
  { key: "speed", path: ["tts", "speed"], env: "OPENOVEL_TTS_SPEED", type: "number", default: 1.0 },
  { key: "appId", path: ["tts", "volcano", "appId"], env: "VOLCANO_APP_ID", type: "string", default: "" },
  { key: "accessToken", path: ["tts", "volcano", "accessToken"], env: "VOLCANO_ACCESS_TOKEN", type: "string", secret: true, default: "" },
  { key: "cluster", path: ["tts", "volcano", "cluster"], env: "VOLCANO_CLUSTER", type: "string", default: DEFAULT_TTS_CLUSTER },
]

// Envs owned by the ACTIVE custom entry; cleared when volcano is active.
const CUSTOM_ENVS = {
  baseUrl: "OPENOVEL_TTS_BASE_URL",
  apiKey: "OPENOVEL_TTS_API_KEY",
  model: "OPENOVEL_TTS_MODEL",
  sampleRate: "OPENOVEL_TTS_SAMPLE_RATE",
}

function normalizeTtsCustomEntry(raw = {}) {
  const name = String(raw.name || "").trim()
  const slug = slugifyCustomProviderName(String(raw.id || "").replace(/^custom:/, "") || name)
  if (!slug) return null
  const sampleRate = Number(raw.sampleRate)
  return {
    id: `custom:${slug}`,
    name: name || slug,
    baseUrl: String(raw.baseUrl || "").trim(),
    model: String(raw.model || "").trim(),
    voice: String(raw.voice || "").trim(),
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24000,
    apiKey: String(raw.apiKey || ""),
  }
}

function customEntries(settings) {
  const list = settings?.tts?.customProviders
  return Array.isArray(list) ? list.map(normalizeTtsCustomEntry).filter(Boolean) : []
}

function activeProvider(settings) {
  const pin = String(process.env.OPENOVEL_TTS_PROVIDER || readNested(settings, ["tts", "provider"]) || "").trim()
  return pin.startsWith("custom:") ? pin : "volcano"
}

// Compile the active provider's fields into the flat envs the runtime reads
// (lib/ttsConfig.js). Volcano active → custom envs cleared and the volcano
// voiceType restored; custom active → its entry fields mirrored, with the
// entry's voice riding OPENOVEL_TTS_VOICE_TYPE (empty voice = unset, which is
// valid for single-voice servers).
function mirrorActiveProviderEnv(settings) {
  const provider = activeProvider(settings)
  const entry = provider === "volcano" ? null : customEntries(settings).find((e) => e.id === provider)
  if (entry) {
    process.env.OPENOVEL_TTS_PROVIDER = entry.id
    for (const [key, envName] of Object.entries(CUSTOM_ENVS)) {
      const value = String(entry[key] ?? "")
      if (value) process.env[envName] = value
      else delete process.env[envName]
    }
    if (entry.voice) process.env.OPENOVEL_TTS_VOICE_TYPE = entry.voice
    else delete process.env.OPENOVEL_TTS_VOICE_TYPE
  } else {
    delete process.env.OPENOVEL_TTS_PROVIDER
    for (const envName of Object.values(CUSTOM_ENVS)) delete process.env[envName]
    const voice = readNested(settings, ["tts", "voiceType"])
    if (typeof voice === "string" && voice) process.env.OPENOVEL_TTS_VOICE_TYPE = voice
    else delete process.env.OPENOVEL_TTS_VOICE_TYPE
  }
}

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(settingsFilePath(), "utf8"))
  } catch { return {} }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

function readNested(obj, pathArr) {
  let cur = obj
  for (const key of pathArr) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

function writeNested(obj, pathArr, value) {
  let cur = obj
  for (let i = 0; i < pathArr.length - 1; i++) {
    cur[pathArr[i]] = cur[pathArr[i]] || {}
    cur = cur[pathArr[i]]
  }
  cur[pathArr[pathArr.length - 1]] = value
}

function isOn(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function envStringFor(field, value) {
  if (field.type === "bool") return value ? "1" : "0"
  return String(value)
}

function coerce(field, fileValue) {
  if (field.type === "bool") return isOn(fileValue, field.default)
  if (field.type === "number") {
    const n = Number(fileValue)
    return Number.isFinite(n) ? n : field.default
  }
  return typeof fileValue === "string" && fileValue !== "" ? fileValue : field.default
}

function maskKey(value) {
  if (!value) return ""
  const s = String(value)
  if (s.length <= 8) return "*".repeat(s.length)
  return s.slice(0, 4) + "…" + s.slice(-4)
}

// Re-seed process.env from disk on boot so a saved TTS config survives restart.
export async function hydrateTtsEnvFromSettings() {
  const settings = await readSettingsFile()
  for (const field of FIELDS) {
    const fileValue = readNested(settings, field.path)
    if (fileValue === undefined || fileValue === null || fileValue === "") continue
    process.env[field.env] = envStringFor(field, coerce(field, fileValue))
  }
  // LAST: the active provider's compiled envs win over the generic loop above
  // (a custom entry's voice/endpoint replace the volcano-shaped flat fields).
  mirrorActiveProviderEnv(settings)
}

// Redacted snapshot for the renderer: secrets become a "set + masked" flag.
export async function getTtsSnapshot() {
  const settings = await readSettingsFile()
  const config = {}
  for (const field of FIELDS) {
    const envValue = process.env[field.env]
    const fileValue = readNested(settings, field.path)
    const effective = envValue !== undefined && envValue !== "" ? envValue
      : (fileValue !== undefined ? fileValue : field.default)
    if (field.secret) {
      config[field.key] = { set: Boolean(effective), masked: maskKey(effective) }
    } else {
      config[field.key] = coerce(field, effective)
    }
  }
  // The provider field's env is deliberately unset while volcano is active —
  // normalize so the UI always sees a concrete pin.
  config.provider = activeProvider(settings)
  const custom = customEntries(settings).map((entry) => ({
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    model: entry.model,
    voice: entry.voice,
    sampleRate: entry.sampleRate,
    keySet: Boolean(entry.apiKey),
    maskedKey: maskKey(entry.apiKey),
  }))
  return { config, customProviders: custom, voices: VOICE_EXAMPLES, filePath: settingsFilePath() }
}

// Patch any subset of the TTS fields. Empty string clears a secret. Atomic.
// Custom-endpoint management rides the same patch protocol:
//   { upsertCustomProvider: { id?, name, baseUrl, model, voice, sampleRate, apiKey? } }
//   { deleteCustomProvider: "custom:<slug>" }
//   { provider: "volcano" | "custom:<slug>" }   ← switch; per-entry config persists
export async function setTts(patch = {}) {
  const settings = await readSettingsFile()
  const changes = []
  for (const [key, raw] of Object.entries(patch || {})) {
    if (key === "upsertCustomProvider") {
      const entry = normalizeTtsCustomEntry(raw || {})
      if (!entry) continue
      const list = customEntries(settings)
      const existing = list.find((e) => e.id === entry.id)
      // An omitted/empty apiKey on an existing entry means "keep the saved key"
      // (the form redacts it); a non-empty value replaces it.
      if (existing && !entry.apiKey) entry.apiKey = existing.apiKey
      const next = existing ? list.map((e) => (e.id === entry.id ? entry : e)) : [...list, entry]
      writeNested(settings, ["tts", "customProviders"], next)
      changes.push({ key: entry.id, set: true })
      continue
    }
    if (key === "deleteCustomProvider") {
      const id = String(raw || "")
      const list = customEntries(settings).filter((e) => e.id !== id)
      writeNested(settings, ["tts", "customProviders"], list)
      // Deleting the active entry falls back to volcano rather than leaving a
      // dangling pin.
      if (activeProvider(settings) === id) {
        writeNested(settings, ["tts", "provider"], "volcano")
        delete process.env.OPENOVEL_TTS_PROVIDER
      }
      changes.push({ key: id, set: false })
      continue
    }
    const field = FIELDS.find((f) => f.key === key)
    if (!field) continue
    let value
    if (field.type === "bool") value = Boolean(raw)
    else if (field.type === "number") {
      const n = Number(raw)
      value = Number.isFinite(n) ? n : field.default
    } else {
      value = typeof raw === "string" ? raw.trim() : ""
    }

    const isEmptyString = field.type === "string" && value === ""
    if (isEmptyString) {
      // Clear the field entirely so it falls back to the default.
      const parent = readNested(settings, field.path.slice(0, -1))
      if (parent) delete parent[field.path[field.path.length - 1]]
      delete process.env[field.env]
    } else {
      writeNested(settings, field.path, value)
      process.env[field.env] = envStringFor(field, value)
    }
    changes.push({ key, set: !isEmptyString })
  }
  // Recompile the active provider's flat envs after ANY change — a provider
  // switch, an entry edit, or a volcano field edit can all shift what the
  // runtime should see.
  mirrorActiveProviderEnv(settings)
  await writeSettingsFile(settings)
  return { changes, filePath: settingsFilePath(), snapshot: await getTtsSnapshot() }
}
