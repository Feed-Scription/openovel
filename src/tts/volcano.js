// Volcano Engine (Doubao / 火山引擎) TTS — V1 binary WebSocket protocol.
//
// Pure, dependency-free request/response codec for the `ws_binary` endpoint.
// All network + lifecycle lives in volcanoClient.js; everything here is a pure
// function so the framing (the part that is easy to get subtly wrong) is unit-
// testable without a socket — same posture as src/provider/anthropic.js.
//
// Wire format (confirmed against a working Node implementation):
//   request frame  = [0x11,0x10,0x11,0x00] · uint32be(payloadLen) · gzip(JSON)
//   response frame = header(4) · [int32be seq · uint32be size · audioBytes]
// Header nibbles: byte0 = version<<4 | headerSize(4-byte units);
//   byte1 = messageType<<4 | flags; byte2 = serialization<<4 | compression.
//   messageType 0xb = audio-only server response, 0xf = error.
//   flags: 0 = ack/"started" (no audio); bit 0b10 (or negative seq) = last packet.

import { gzipSync, gunzipSync } from "node:zlib"

export const VOLCANO_WS_ENDPOINT = "wss://openspeech.bytedance.com/api/v1/tts/ws_binary"

// version 1, headerSize 1 (4 bytes) | full-client-request, no flags |
// JSON serialization, gzip compression | reserved.
const DEFAULT_REQUEST_HEADER = Buffer.from([0x11, 0x10, 0x11, 0x00])

const MSG_TYPE_AUDIO = 0xb
const MSG_TYPE_ERROR = 0xf

// Build the JSON request body for one synthesis call. Pure: callers (the client)
// supply reqid/uid so tests stay deterministic.
export function buildTtsRequest({
  text,
  appid,
  token,
  cluster = "volcano_tts",
  uid = "openovel",
  voiceType = "",
  encoding = "pcm",
  rate = 24000,
  speedRatio = 1.0,
  reqid,
  operation = "submit",
} = {}) {
  return {
    app: { appid: appid || "", token: token || "", cluster },
    user: { uid },
    audio: {
      voice_type: voiceType,
      encoding,
      rate,
      speed_ratio: speedRatio,
    },
    request: {
      reqid: reqid || "",
      text: String(text ?? ""),
      text_type: "plain",
      operation,
    },
  }
}

// Encode one request frame: default header + big-endian payload length + gzipped
// JSON. Accepts the request object (or a pre-serialized JSON string).
export function encodeRequestFrame(request) {
  const json = typeof request === "string" ? request : JSON.stringify(request)
  const payload = gzipSync(Buffer.from(json, "utf8"))
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([DEFAULT_REQUEST_HEADER, size, payload])
}

// Decode one server frame into a normalized shape. Never throws on a short/odd
// buffer — returns what it can so the client can decide.
export function decodeResponseFrame(buf) {
  const out = {
    type: null,
    flags: 0,
    compression: 0,
    seq: 0,
    audio: null,
    isLast: false,
    isAck: false,
    errorCode: 0,
    errorMsg: "",
  }
  if (!buf || buf.length < 4) return out

  const headerSize = (buf[0] & 0x0f) * 4
  out.type = buf[1] >> 4
  out.flags = buf[1] & 0x0f
  out.compression = buf[2] & 0x0f
  const payload = buf.subarray(headerSize || 4)

  if (out.type === MSG_TYPE_ERROR) {
    if (payload.length >= 8) {
      out.errorCode = payload.readInt32BE(0)
      const size = payload.readUInt32BE(4)
      let msg = payload.subarray(8, 8 + size)
      if (out.compression === 1) {
        try { msg = gunzipSync(msg) } catch { /* leave raw */ }
      }
      out.errorMsg = msg.toString("utf8")
    }
    out.isLast = true
    return out
  }

  if (out.type === MSG_TYPE_AUDIO) {
    // flags 0 = "started" ack — no audio in this frame.
    if (out.flags === 0 || payload.length < 8) {
      out.isAck = true
      return out
    }
    out.seq = payload.readInt32BE(0)
    const size = payload.readUInt32BE(4)
    let audio = payload.subarray(8, 8 + size)
    if (out.compression === 1) {
      try { audio = gunzipSync(audio) } catch { /* raw PCM/codec bytes */ }
    }
    out.audio = audio
    // Last packet: explicit last-bit in flags, or the negative-sequence marker.
    out.isLast = (out.flags & 0b10) !== 0 || out.seq < 0
    return out
  }

  return out
}
