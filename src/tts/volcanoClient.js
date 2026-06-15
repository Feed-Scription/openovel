// Volcano Engine (Doubao) TTS client — one WebSocket per sentence.
//
// The unit of work is a single sentence (the sentenceBuffer upstream guarantees
// whole clauses). We open the binary ws_binary connection, send one `submit`
// request, accumulate the streamed audio packets, and resolve with the full
// sentence PCM once the last packet arrives. The connection closes per sentence
// — simple and robust; ordering across sentences is handled by the caller's
// queue (src/electron/ttsBridge.js).
//
// Network lives here; framing is in volcano.js (pure, unit-tested). Failures are
// surfaced via notices — never swallowed (repo "never silently discard" rule).

import { WebSocket } from "undici"
import { randomUUID } from "node:crypto"

import {
  buildTtsRequest,
  encodeRequestFrame,
  decodeResponseFrame,
  VOLCANO_WS_ENDPOINT,
} from "./volcano.js"
import { createNotices, reportNotices } from "../lib/notices.js"

export class TtsError extends Error {
  constructor(message, { code } = {}) {
    super(message)
    this.name = "TtsError"
    this.code = code
  }
}

// Are the minimum credentials present? Used by the bridge to no-op cleanly.
export function hasVolcanoCreds(creds = {}) {
  return Boolean(creds.appid && creds.token)
}

// Synthesize one sentence. Resolves { pcm: Buffer, sampleRate, encoding }.
// Rejects (TtsError) on auth/server/transport errors, abort, or timeout.
// `onAudio(chunk)` is invoked per streamed packet for early playback if desired.
export function synthesizeSentence({
  text,
  creds = {},
  voiceType = "",
  encoding = "pcm",
  rate = 24000,
  speed = 1.0,
  uid = "openovel",
  signal,
  onAudio,
  timeoutMs = 15000,
  bus,
} = {}) {
  return new Promise((resolve, reject) => {
    const notices = createNotices("tts")
    const reqid = randomUUID()
    const request = buildTtsRequest({
      text,
      appid: creds.appid,
      token: creds.token,
      cluster: creds.cluster || "volcano_tts",
      uid,
      voiceType,
      encoding,
      rate,
      speedRatio: speed,
      reqid,
    })

    let ws
    let settled = false
    let timer = null
    const chunks = []

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (signal) signal.removeEventListener("abort", onAbort)
      try { ws?.close() } catch { /* already closing */ }
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ pcm: Buffer.concat(chunks), sampleRate: rate, encoding })
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      const e = err instanceof Error ? err : new TtsError(String(err))
      notices.reject(`TTS synth failed: ${e.message}`)
      reportNotices(notices, { bus, event: "tts.error", prefix: "tts" })
      reject(e)
    }
    function onAbort() {
      fail(new TtsError("aborted", { code: "aborted" }))
    }

    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    timer = setTimeout(() => fail(new TtsError("timeout", { code: "timeout" })), timeoutMs)

    try {
      ws = new WebSocket(VOLCANO_WS_ENDPOINT, {
        headers: { Authorization: `Bearer; ${creds.token || ""}` },
      })
      ws.binaryType = "arraybuffer"
    } catch (err) {
      fail(err)
      return
    }

    ws.addEventListener("open", () => {
      try {
        ws.send(encodeRequestFrame(request))
      } catch (err) {
        fail(err)
      }
    })

    ws.addEventListener("message", (event) => {
      const data = event?.data
      const buf = data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.isBuffer(data) ? data : Buffer.from(data || [])
      const frame = decodeResponseFrame(buf)
      if (frame.type === 0xf) {
        fail(new TtsError(frame.errorMsg || `server error ${frame.errorCode}`, { code: frame.errorCode }))
        return
      }
      if (frame.isAck) return
      if (frame.audio && frame.audio.length) {
        chunks.push(frame.audio)
        try { onAudio?.(frame.audio) } catch { /* consumer is best-effort */ }
      }
      if (frame.isLast) succeed()
    })

    ws.addEventListener("error", (event) => {
      fail(new TtsError(event?.message || "websocket error"))
    })

    ws.addEventListener("close", (event) => {
      if (settled) return
      // Closed before the last audio packet: surface it (don't half-play).
      fail(new TtsError(`connection closed early (${event?.code ?? "?"})`))
    })
  })
}
