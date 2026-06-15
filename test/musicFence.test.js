import test from "node:test"
import assert from "node:assert/strict"

import {
  parseMusicCueFromText,
  stripMusicFencesFromText,
  latestMusicCueFromEntries,
} from "../src/electron/renderer/lib/richBlockModel.js"

const fence = (body) => "Some prose.\n\n```ovl:music\n" + body + "\n```\n\nMore prose."

test("parseMusicCueFromText reads bgm / play / stop directives", () => {
  assert.deepEqual(parseMusicCueFromText(fence("bgm: rainy-cafe")), { verb: "bgm", shortId: "rainy-cafe" })
  assert.deepEqual(parseMusicCueFromText(fence("play: door-knock")), { verb: "play", shortId: "door-knock" })
  assert.deepEqual(parseMusicCueFromText(fence("stop:")), { verb: "stop", shortId: "" })
  assert.equal(parseMusicCueFromText("no fence here"), null)
})

test("the LAST valid directive wins across lines and fences", () => {
  assert.deepEqual(parseMusicCueFromText(fence("bgm: a\nstop:")), { verb: "stop", shortId: "" })
  const two = "```ovl:music\nbgm: a\n```\nmid\n```ovl:music\nbgm: b\n```"
  assert.deepEqual(parseMusicCueFromText(two), { verb: "bgm", shortId: "b" })
})

test("unknown verbs and bare/half-streamed directives don't change state", () => {
  assert.equal(parseMusicCueFromText(fence("volume: 50")), null) // unknown verb
  assert.equal(parseMusicCueFromText(fence("bgm:")), null) // no short id yet (mid-stream)
  assert.equal(parseMusicCueFromText(fence("bgm")), null) // no colon yet
  // a valid earlier directive survives a trailing half-line
  assert.deepEqual(parseMusicCueFromText(fence("bgm: a\nplay")), { verb: "bgm", shortId: "a" })
})

test("an unterminated (streaming) fence never throws and yields no cue mid-open", () => {
  // trailing fence with no closer + incomplete directive
  assert.equal(parseMusicCueFromText("prose\n```ovl:music\nbgm:"), null)
})

test("stripMusicFencesFromText removes closed + trailing fences, collapsing blank runs", () => {
  const out = stripMusicFencesFromText(fence("bgm: rainy-cafe"))
  assert.ok(!out.includes("ovl:music"))
  assert.ok(!out.includes("rainy-cafe"))
  assert.match(out, /Some prose\./)
  assert.match(out, /More prose\./)
  // an unterminated trailing fence is stripped too
  assert.equal(stripMusicFencesFromText("hi\n\n```ovl:music\nbgm: x").trim(), "hi")
})

test("latestMusicCueFromEntries walks narration entries from the end", () => {
  const entries = [
    { type: "narration", text: fence("bgm: a") },
    { type: "user", text: "ignored" },
    { type: "narration", text: "no cue this turn" },
    { type: "narration", text: fence("stop:") },
  ]
  assert.deepEqual(latestMusicCueFromEntries(entries), { verb: "stop", shortId: "" })
  // no cue anywhere → null (caller keeps previous)
  assert.equal(latestMusicCueFromEntries([{ type: "narration", text: "plain" }]), null)
  assert.equal(latestMusicCueFromEntries(null), null)
  // the most recent CUED narration wins even if later turns have none
  const keep = [{ type: "narration", text: fence("bgm: a") }, { type: "narration", text: "silence after" }]
  assert.deepEqual(latestMusicCueFromEntries(keep), { verb: "bgm", shortId: "a" })
})
