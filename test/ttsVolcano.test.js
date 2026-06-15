import test from "node:test"
import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"

import {
  buildTtsRequest,
  encodeRequestFrame,
  decodeResponseFrame,
  VOLCANO_WS_ENDPOINT,
} from "../src/tts/volcano.js"

// ── Request body ─────────────────────────────────────────────────────────────

test("buildTtsRequest: nests app/user/audio/request with defaults", () => {
  const req = buildTtsRequest({
    text: "她推开门。",
    appid: "app1",
    token: "tok1",
    uid: "u1",
    voiceType: "zh_female_x_bigtts",
    reqid: "r1",
  })
  assert.deepEqual(req.app, { appid: "app1", token: "tok1", cluster: "volcano_tts" })
  assert.deepEqual(req.user, { uid: "u1" })
  assert.equal(req.audio.voice_type, "zh_female_x_bigtts")
  assert.equal(req.audio.encoding, "pcm")
  assert.equal(req.audio.rate, 24000)
  assert.equal(req.audio.speed_ratio, 1.0)
  assert.equal(req.request.reqid, "r1")
  assert.equal(req.request.text, "她推开门。")
  assert.equal(req.request.text_type, "plain")
  assert.equal(req.request.operation, "submit")
})

test("buildTtsRequest: caller can override cluster/encoding/rate/speed", () => {
  const req = buildTtsRequest({ text: "hi", cluster: "volcano_icl", encoding: "mp3", rate: 16000, speedRatio: 1.5 })
  assert.equal(req.app.cluster, "volcano_icl")
  assert.equal(req.audio.encoding, "mp3")
  assert.equal(req.audio.rate, 16000)
  assert.equal(req.audio.speed_ratio, 1.5)
})

// ── Request framing ──────────────────────────────────────────────────────────

test("encodeRequestFrame: default header + big-endian length + gunzippable JSON", () => {
  const req = buildTtsRequest({ text: "hello", appid: "a", token: "t", reqid: "r" })
  const frame = encodeRequestFrame(req)
  // 4-byte default header.
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x10, 0x11, 0x00])
  // 4-byte big-endian payload length, then gzipped JSON.
  const payloadLen = frame.readUInt32BE(4)
  const payload = frame.subarray(8)
  assert.equal(payload.length, payloadLen)
  const json = JSON.parse(gunzipSync(payload).toString("utf8"))
  assert.equal(json.request.text, "hello")
  assert.equal(json.app.appid, "a")
})

test("encodeRequestFrame: accepts a pre-serialized JSON string", () => {
  const frame = encodeRequestFrame('{"x":1}')
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x10, 0x11, 0x00])
  assert.deepEqual(JSON.parse(gunzipSync(frame.subarray(8)).toString("utf8")), { x: 1 })
})

// ── Response framing ─────────────────────────────────────────────────────────

// Build a synthetic server audio frame the way the gateway does.
function audioFrame({ flags, seq, audio }) {
  const header = Buffer.from([0x11, (0xb << 4) | flags, 0x00, 0x00])
  const seqBuf = Buffer.allocUnsafe(4)
  seqBuf.writeInt32BE(seq, 0)
  const sizeBuf = Buffer.allocUnsafe(4)
  sizeBuf.writeUInt32BE(audio.length, 0)
  return Buffer.concat([header, seqBuf, sizeBuf, audio])
}

test("decodeResponseFrame: mid-stream audio packet (not last)", () => {
  const audio = Buffer.from([1, 2, 3, 4])
  const r = decodeResponseFrame(audioFrame({ flags: 0b01, seq: 1, audio }))
  assert.equal(r.type, 0xb)
  assert.equal(r.isAck, false)
  assert.equal(r.isLast, false)
  assert.equal(r.seq, 1)
  assert.deepEqual([...r.audio], [1, 2, 3, 4])
})

test("decodeResponseFrame: final audio packet via last-bit flag", () => {
  const audio = Buffer.from([9, 9])
  const r = decodeResponseFrame(audioFrame({ flags: 0b11, seq: 7, audio }))
  assert.equal(r.isLast, true)
  assert.deepEqual([...r.audio], [9, 9])
})

test("decodeResponseFrame: final audio packet via negative sequence", () => {
  const audio = Buffer.from([5])
  const r = decodeResponseFrame(audioFrame({ flags: 0b01, seq: -3, audio }))
  assert.equal(r.isLast, true)
})

test("decodeResponseFrame: flags 0 is a 'started' ack with no audio", () => {
  const header = Buffer.from([0x11, 0xb << 4, 0x00, 0x00])
  const r = decodeResponseFrame(header)
  assert.equal(r.type, 0xb)
  assert.equal(r.isAck, true)
  assert.equal(r.audio, null)
  assert.equal(r.isLast, false)
})

test("decodeResponseFrame: error frame carries code + message", () => {
  const header = Buffer.from([0x11, 0xf << 4, 0x00, 0x00])
  const code = Buffer.allocUnsafe(4)
  code.writeInt32BE(3001, 0)
  const msgBytes = Buffer.from("bad token", "utf8")
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32BE(msgBytes.length, 0)
  const r = decodeResponseFrame(Buffer.concat([header, code, size, msgBytes]))
  assert.equal(r.type, 0xf)
  assert.equal(r.errorCode, 3001)
  assert.equal(r.errorMsg, "bad token")
  assert.equal(r.isLast, true)
})

test("decodeResponseFrame: tolerates short/empty buffers", () => {
  assert.equal(decodeResponseFrame(Buffer.alloc(0)).type, null)
  assert.equal(decodeResponseFrame(null).type, null)
})

test("endpoint constant is the binary ws route", () => {
  assert.equal(VOLCANO_WS_ENDPOINT, "wss://openspeech.bytedance.com/api/v1/tts/ws_binary")
})
