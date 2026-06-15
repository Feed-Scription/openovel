// Main-process TTS bridge.
//
// The renderer can't open the Volcano WebSocket (CSP forbids external
// connections), so synthesis runs here in the main process. The VM (also in the
// main process under the embedded transport) publishes per-sentence bus events
// as narration streams; this bridge synthesizes each sentence IN ORDER and
// streams the resulting PCM to the renderer over one IPC channel ("tts:event"),
// where useTtsKaraoke plays it gaplessly and reveals text in lockstep.
//
// Ordering matters for gapless karaoke: sentences are drained from a FIFO queue
// one at a time, so audio is emitted strictly in sentence order even though each
// synth is async. Synth of sentence N+1 overlaps playback of N (playback is the
// slow side), keeping the renderer's queue full.

import { bus } from "../runtime/bus.js"
import { synthesizeSentence } from "../tts/volcanoClient.js"
import { synthesizeSentenceOpenAI } from "../tts/openaiSpeechClient.js"
import { getTtsRuntimeConfig, isTtsActive } from "../lib/ttsConfig.js"

export function startTtsBridge({ send } = {}) {
  const emit = (type, payload) => {
    try { send?.("tts:event", { type, ...payload }) } catch { /* window gone */ }
  }

  const queue = []
  let draining = false
  let currentAbort = null
  let currentTurnId = null

  // Drop queued jobs for a turn (or all) and abort an in-flight synth for it.
  const cancel = (turnId) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!turnId || queue[i].turnId === turnId) queue.splice(i, 1)
    }
    if (currentAbort && (!turnId || currentTurnId === turnId)) {
      try { currentAbort.abort() } catch { /* already settled */ }
    }
    emit("cancel", { turnId: turnId || currentTurnId || null })
  }

  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (queue.length) {
        const job = queue.shift()
        if (job.type === "end") {
          emit("end", { turnId: job.turnId })
          continue
        }
        if (!isTtsActive(process.env)) continue
        const cfg = getTtsRuntimeConfig(process.env)
        const isCustom = cfg.provider !== "volcano"
        // Volcano requires a voice_type; an OpenAI-compatible endpoint may have
        // a single implicit voice, so an empty voice is valid there.
        if (!isCustom && !cfg.voiceType) continue
        const abort = new AbortController()
        currentAbort = abort
        currentTurnId = job.turnId
        try {
          // Both clients share the contract: one sentence in, whole-sentence
          // { pcm, sampleRate } out — so the karaoke path downstream is
          // provider-agnostic.
          const { pcm, sampleRate } = isCustom
            ? await synthesizeSentenceOpenAI({
                text: job.text,
                baseUrl: cfg.custom.baseUrl,
                apiKey: cfg.custom.apiKey,
                model: cfg.custom.model,
                voice: cfg.custom.voice,
                speed: cfg.speed,
                sampleRate: cfg.custom.sampleRate,
                signal: abort.signal,
                bus,
              })
            : await synthesizeSentence({
                text: job.text,
                creds: cfg.creds,
                voiceType: cfg.voiceType,
                encoding: "pcm",
                rate: 24000,
                speed: cfg.speed,
                signal: abort.signal,
                bus,
              })
          if (!abort.signal.aborted && pcm?.length) {
            emit("audio", {
              turnId: job.turnId,
              seq: job.seq,
              text: job.text,
              sampleRate,
              pcm: new Uint8Array(pcm), // tightly-packed copy for structured clone
              isLast: Boolean(job.isLast),
            })
          }
        } catch (err) {
          // "aborted" is the expected outcome of a cancel — stay quiet. Any other
          // failure (auth, server, transport) was already reported to the
          // operator by the client; tell the renderer so it drops karaoke for
          // this turn and falls back to the on-screen (CPM-paced) text.
          if (err?.code !== "aborted") {
            emit("error", { turnId: job.turnId, message: err?.message || String(err) })
          }
        } finally {
          currentAbort = null
        }
      }
    } finally {
      draining = false
    }
  }

  const offSentence = bus.subscribe("tts.sentence", (event) => {
    const p = event?.properties || {}
    if (!p.text) return
    queue.push({ type: "sentence", turnId: p.turnId, seq: p.seq, text: p.text, isLast: p.isLast })
    drain()
  })
  const offEnd = bus.subscribe("tts.turn_end", (event) => {
    const p = event?.properties || {}
    queue.push({ type: "end", turnId: p.turnId })
    drain()
  })
  const offCancel = bus.subscribe("tts.cancel", (event) => {
    cancel(event?.properties?.turnId)
  })

  return {
    // UI "stop" button: kill current + queued synthesis. Playback is stopped
    // renderer-side; this stops the upstream so no further audio is emitted.
    control(action) {
      if (action === "stop" || action === "cancel") cancel()
      return { ok: true }
    },
    dispose() {
      offSentence()
      offEnd()
      offCancel()
      cancel()
    },
  }
}
