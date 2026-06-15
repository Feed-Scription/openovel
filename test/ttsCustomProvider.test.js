import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildSpeechRequest, speechEndpoint, DEFAULT_OPENAI_SPEECH_SAMPLE_RATE } from "../src/tts/openaiSpeechClient.js"
import { getTtsRuntimeConfig, hasTtsCreds, ttsProvider } from "../src/lib/ttsConfig.js"
import { getTtsSnapshot, setTts, hydrateTtsEnvFromSettings } from "../src/electron/ttsStore.js"

const ENV_KEYS = [
  "OPENOVEL_HOME",
  "OPENOVEL_ENABLE_TTS",
  "OPENOVEL_TTS_PROVIDER",
  "OPENOVEL_TTS_VOICE_TYPE",
  "OPENOVEL_TTS_SPEED",
  "OPENOVEL_TTS_BASE_URL",
  "OPENOVEL_TTS_API_KEY",
  "OPENOVEL_TTS_MODEL",
  "OPENOVEL_TTS_SAMPLE_RATE",
  "VOLCANO_APP_ID",
  "VOLCANO_ACCESS_TOKEN",
  "VOLCANO_CLUSTER",
]

async function withIsolatedTtsEnv(run) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENOVEL_HOME = await mkdtemp(path.join(os.tmpdir(), "openovel-tts-"))
  try {
    return await run()
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("openai speech request shape: pcm format, speed elided at 1.0", () => {
  const body = buildSpeechRequest({ model: "tts-1", voice: "alloy", text: "你好。", speed: 1.0 })
  assert.deepEqual(body, { model: "tts-1", voice: "alloy", input: "你好。", response_format: "pcm" })
  const fast = buildSpeechRequest({ model: "tts-1", voice: "", text: "hi", speed: 1.5 })
  assert.equal(fast.speed, 1.5)
  assert.equal(speechEndpoint("https://tts.example.com/v1/"), "https://tts.example.com/v1/audio/speech")
  assert.equal(DEFAULT_OPENAI_SPEECH_SAMPLE_RATE, 24000)
})

test("ttsConfig: provider awareness and custom creds gating", () => {
  const volcano = { OPENOVEL_ENABLE_TTS: "1", VOLCANO_APP_ID: "a", VOLCANO_ACCESS_TOKEN: "t" }
  assert.equal(ttsProvider(volcano), "volcano")
  assert.equal(hasTtsCreds(volcano), true)

  const custom = { OPENOVEL_ENABLE_TTS: "1", OPENOVEL_TTS_PROVIDER: "custom:x", OPENOVEL_TTS_BASE_URL: "https://t.example/v1", OPENOVEL_TTS_MODEL: "tts-1", OPENOVEL_TTS_SAMPLE_RATE: "44100" }
  assert.equal(ttsProvider(custom), "custom:x")
  assert.equal(hasTtsCreds(custom), true) // base URL alone is enough (key optional)
  const cfg = getTtsRuntimeConfig(custom)
  assert.equal(cfg.provider, "custom:x")
  assert.equal(cfg.custom.baseUrl, "https://t.example/v1")
  assert.equal(cfg.custom.sampleRate, 44100)
  assert.equal(cfg.custom.voice, "") // no volcano default leaks into custom voice

  // Custom pin without a base URL = not configured.
  assert.equal(hasTtsCreds({ OPENOVEL_TTS_PROVIDER: "custom:x" }), false)
})

test("tts store: entry CRUD, env mirroring, switch round-trip, hydrate", async () => {
  await withIsolatedTtsEnv(async () => {
    await setTts({ appId: "app-1", accessToken: "tok-12345678", voiceType: "zh_female_cancan_mars_bigtts" })
    await setTts({ upsertCustomProvider: { name: "My Speech", baseUrl: "https://t.example/v1", model: "tts-1", voice: "alloy", apiKey: "sk-12345678" } })
    await setTts({ provider: "custom:my-speech" })

    // Active custom entry compiled into the flat envs.
    assert.equal(process.env.OPENOVEL_TTS_PROVIDER, "custom:my-speech")
    assert.equal(process.env.OPENOVEL_TTS_BASE_URL, "https://t.example/v1")
    assert.equal(process.env.OPENOVEL_TTS_VOICE_TYPE, "alloy")
    assert.equal(getTtsRuntimeConfig(process.env).provider, "custom:my-speech")

    // Edit without apiKey keeps the saved key; empty voice clears the env.
    await setTts({ upsertCustomProvider: { id: "custom:my-speech", name: "My Speech", baseUrl: "https://t.example/v2", model: "tts-1-hd", voice: "" } })
    let snap = await getTtsSnapshot()
    assert.equal(snap.customProviders[0].keySet, true)
    assert.equal(process.env.OPENOVEL_TTS_BASE_URL, "https://t.example/v2")
    assert.equal(process.env.OPENOVEL_TTS_VOICE_TYPE, undefined)

    // Back to volcano: custom envs cleared, volcano voice restored.
    await setTts({ provider: "volcano" })
    assert.equal(process.env.OPENOVEL_TTS_PROVIDER, undefined)
    assert.equal(process.env.OPENOVEL_TTS_BASE_URL, undefined)
    assert.equal(process.env.OPENOVEL_TTS_VOICE_TYPE, "zh_female_cancan_mars_bigtts")

    // Boot hydrate recompiles the active provider from disk.
    await setTts({ provider: "custom:my-speech" })
    for (const key of ENV_KEYS) { if (key !== "OPENOVEL_HOME") delete process.env[key] }
    await hydrateTtsEnvFromSettings()
    assert.equal(process.env.OPENOVEL_TTS_PROVIDER, "custom:my-speech")
    assert.equal(process.env.OPENOVEL_TTS_BASE_URL, "https://t.example/v2")
    assert.equal(process.env.OPENOVEL_TTS_MODEL, "tts-1-hd")

    // Deleting the active entry falls back to volcano.
    await setTts({ deleteCustomProvider: "custom:my-speech" })
    snap = await getTtsSnapshot()
    assert.equal(snap.config.provider, "volcano")
    assert.equal(snap.customProviders.length, 0)
  })
})
