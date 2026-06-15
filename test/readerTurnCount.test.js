import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getReaderTurnCount, initializeStory, paths, recordSceneEvent } from "../src/lib/storyStore.js"

process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-turns-home-${Date.now()}`)
process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-turns-story-${Date.now()}`)

test("getReaderTurnCount counts reader_action events from the full scene_log", async () => {
  await initializeStory()
  assert.equal(await getReaderTurnCount(), 0)

  for (let i = 0; i < 3; i++) {
    await recordSceneEvent({ type: "reader_action", turnId: `t${i}`, action: `action ${i}` })
    // Other event types must NOT inflate the count.
    await recordSceneEvent({ type: "background_signal", turnId: `t${i}` })
    await recordSceneEvent({ type: "continuity", turnId: `t${i}` })
  }
  assert.equal(await getReaderTurnCount(), 3)
})

test("getReaderTurnCount reads from disk so it survives a 'restart' (fresh read)", async () => {
  // The count comes straight from scene_log.jsonl — no in-memory/session cache
  // to reset to 1 — so a brand-new read of the same file returns the full total.
  const before = await getReaderTurnCount()
  await recordSceneEvent({ type: "reader_action", turnId: "again", action: "another turn" })
  assert.equal(await getReaderTurnCount(), before + 1)
  // foreground_turn presence is irrelevant to the reader-turn count.
  await recordSceneEvent({ type: "foreground_turn", turnId: "again" })
  assert.equal(await getReaderTurnCount(), before + 1)
})

test("getReaderTurnCount is 0 for an empty / missing scene_log", async () => {
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-turns-empty-${Date.now()}`)
  // No scene_log written yet.
  assert.ok(typeof paths.sceneLog === "string")
  assert.equal(await getReaderTurnCount(), 0)
})
