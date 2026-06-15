// OpenAI-compatible speech client — POST {baseUrl}/audio/speech per sentence.
//
// The custom-TTS counterpart of volcanoClient.js with the SAME contract: one
// sentence in, `{ pcm: Buffer, sampleRate, encoding }` out, TtsError with
// code "aborted"/"timeout" semantics, failures surfaced via notices. The
// bridge (src/electron/ttsBridge.js) dispatches between the two by provider
// and treats the results identically, so sentence-level karaoke keeps working.
//
// `response_format: "pcm"` asks for raw 16-bit little-endian mono PCM. OpenAI
// itself emits 24 kHz; compatible servers may differ, so the per-entry
// `sampleRate` config rides through to the result for the renderer's player.

import { createNotices, reportNotices } from "../lib/notices.js"
import { TtsError } from "./volcanoClient.js"

export const DEFAULT_OPENAI_SPEECH_SAMPLE_RATE = 24000

// Pure request-shape builder, split out for unit tests.
export function buildSpeechRequest({ model = "", voice = "", text = "", speed = 1.0 } = {}) {
  const body = {
    model: String(model || ""),
    voice: String(voice || ""),
    input: String(text ?? ""),
    response_format: "pcm",
  }
  // Default speed elided: not every compatible server accepts the field.
  if (Number.isFinite(speed) && speed > 0 && speed !== 1.0) body.speed = speed
  return body
}

export function speechEndpoint(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/audio/speech`
}

// Synthesize one sentence. Resolves { pcm: Buffer, sampleRate, encoding }.
// Rejects (TtsError) on HTTP/transport errors, abort, or timeout.
export async function synthesizeSentenceOpenAI({
  text,
  baseUrl = "",
  apiKey = "",
  model = "",
  voice = "",
  speed = 1.0,
  sampleRate = DEFAULT_OPENAI_SPEECH_SAMPLE_RATE,
  signal,
  timeoutMs = 30000,
  bus,
} = {}) {
  const notices = createNotices("tts")
  const fail = (err) => {
    const e = err instanceof TtsError ? err : new TtsError(err?.message || String(err))
    notices.reject(`TTS synth failed: ${e.message}`)
    reportNotices(notices, { bus, event: "tts.error", prefix: "tts" })
    throw e
  }

  if (!baseUrl) return fail(new TtsError("custom TTS endpoint has no base URL", { code: "config" }))
  if (signal?.aborted) return fail(new TtsError("aborted", { code: "aborted" }))

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetch(speechEndpoint(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildSpeechRequest({ model, voice, text, speed })),
        signal: controller.signal,
      })
    } catch (err) {
      if (signal?.aborted) return fail(new TtsError("aborted", { code: "aborted" }))
      if (controller.signal.aborted) return fail(new TtsError("timeout", { code: "timeout" }))
      return fail(new TtsError(`speech request failed: ${err?.message || err}`))
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300)
      return fail(new TtsError(`speech API HTTP ${response.status}: ${detail}`, { code: response.status }))
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) return fail(new TtsError("speech API returned empty audio"))
    const rate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0
      ? Number(sampleRate)
      : DEFAULT_OPENAI_SPEECH_SAMPLE_RATE
    return { pcm: bytes, sampleRate: rate, encoding: "pcm" }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}
