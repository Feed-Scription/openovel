// Shared TTS runtime config reader.
//
// TTS is configured through process.env (mirrored from settings.local.json by
// src/electron/ttsStore.js, and re-seeded on startup by its hydrate step) — the
// same persistence path optionsEnabled / displayPacing use. Everything that
// needs to know "is TTS on, which voice, which credentials" reads it here so the
// env-var names live in one place. Pure: no Electron, no disk.

export const DEFAULT_TTS_VOICE = "zh_female_cancan_mars_bigtts"
export const DEFAULT_TTS_CLUSTER = "volcano_tts"

function isOn(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

export function isTtsEnabled(env = process.env) {
  return isOn(env.OPENOVEL_ENABLE_TTS, false)
}

// Active TTS provider: "volcano" (built-in WebSocket protocol) or a
// user-defined OpenAI-compatible endpoint ("custom:<slug>"). The ACTIVE custom
// entry's fields are mirrored into the flat OPENOVEL_TTS_* envs below by
// ttsStore.js, the same active-entry-compilation pattern the image settings
// use — the runtime never needs the full entry list.
export function ttsProvider(env = process.env) {
  const id = String(env.OPENOVEL_TTS_PROVIDER || "").trim()
  return id.startsWith("custom:") ? id : "volcano"
}

// Credentials are present enough to attempt synthesis for the active provider.
export function hasTtsCreds(env = process.env) {
  if (ttsProvider(env) !== "volcano") return Boolean(env.OPENOVEL_TTS_BASE_URL)
  return Boolean(env.VOLCANO_APP_ID && env.VOLCANO_ACCESS_TOKEN)
}

// Full runtime config the bridge/client need for one synth call.
export function getTtsRuntimeConfig(env = process.env) {
  const speedRaw = Number(env.OPENOVEL_TTS_SPEED)
  const sampleRateRaw = Number(env.OPENOVEL_TTS_SAMPLE_RATE)
  return {
    enabled: isTtsEnabled(env),
    provider: ttsProvider(env),
    voiceType: env.OPENOVEL_TTS_VOICE_TYPE || DEFAULT_TTS_VOICE,
    speed: Number.isFinite(speedRaw) && speedRaw > 0 ? clamp(speedRaw, 0.5, 2.0) : 1.0,
    creds: {
      appid: env.VOLCANO_APP_ID || "",
      token: env.VOLCANO_ACCESS_TOKEN || "",
      cluster: env.VOLCANO_CLUSTER || DEFAULT_TTS_CLUSTER,
    },
    // OpenAI-compatible custom endpoint (active entry, mirrored by ttsStore).
    custom: {
      baseUrl: env.OPENOVEL_TTS_BASE_URL || "",
      apiKey: env.OPENOVEL_TTS_API_KEY || "",
      model: env.OPENOVEL_TTS_MODEL || "",
      // Voice for custom endpoints rides the same OPENOVEL_TTS_VOICE_TYPE env,
      // but with NO volcano default — an empty voice is valid for servers
      // with a single voice.
      voice: env.OPENOVEL_TTS_VOICE_TYPE || "",
      sampleRate: Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? sampleRateRaw : 24000,
    },
  }
}

// TTS can actually run for this turn: toggle on AND credentials present.
export function isTtsActive(env = process.env) {
  return isTtsEnabled(env) && hasTtsCreds(env)
}
