import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  compactStorykeeperMessageQueue,
  drainStorykeeperMessages,
  enqueueStorykeeperMessage,
  listStorykeeperMessages,
  markStorykeeperMessagesForTurnInjected,
  renderStorykeeperQueuedMessages,
} from "../src/runtime/agentMessageQueue.js"

async function tempQueuePath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-agent-queue-"))
  return path.join(root, "storykeeper.queue.jsonl")
}

test("Storykeeper message queue persists pending messages and drains by priority", async () => {
  const queuePath = await tempQueuePath()
  await enqueueStorykeeperMessage({ priority: "later", type: "watcher", turnId: "turn_later", payload: { note: "later" } }, { queuePath })
  const now = await enqueueStorykeeperMessage({ priority: "now", type: "foreground_turn", turnId: "turn_now", payload: { action: "stop" } }, { queuePath })
  await enqueueStorykeeperMessage({ priority: "next", type: "foreground_turn", turnId: "turn_next", payload: { action: "look" } }, { queuePath })

  const pending = await listStorykeeperMessages({ queuePath })
  assert.deepEqual(pending.map((message) => message.priority), ["now", "next", "later"])

  const drained = await drainStorykeeperMessages({ queuePath, maxPriority: "next" })
  assert.deepEqual(drained.map((message) => message.id), [now.id, pending[1].id])

  const remaining = await listStorykeeperMessages({ queuePath })
  assert.deepEqual(remaining.map((message) => message.turnId), ["turn_later"])
})

test("Storykeeper message queue can acknowledge the current turn without injecting it twice", async () => {
  const queuePath = await tempQueuePath()
  await enqueueStorykeeperMessage({ priority: "next", type: "foreground_turn", turnId: "turn_current", payload: { action: "look" } }, { queuePath })
  await enqueueStorykeeperMessage({ priority: "next", type: "foreground_turn", turnId: "turn_future", payload: { action: "run" } }, { queuePath })

  await markStorykeeperMessagesForTurnInjected("turn_current", { queuePath, reason: "included-in-context" })
  const drained = await drainStorykeeperMessages({ queuePath })
  assert.deepEqual(drained.map((message) => message.turnId), ["turn_future"])

  const rendered = renderStorykeeperQueuedMessages(drained)
  assert.match(rendered, /foreground_updates/)
  assert.match(rendered, /turn_future/)
  assert.doesNotMatch(rendered, /turn_current/)
})

test("apply_feedback renders in its own block, separate from foreground updates", () => {
  const rendered = renderStorykeeperQueuedMessages([
    { id: "fb1", type: "apply_feedback", priority: "now", source: "runtime", turnId: "turn_3", at: "t", payload: { warnings: ["foregroundGuidanceMarkdown: kept 24000, dropped 5000"] } },
    { id: "u1", type: "foreground_turn", priority: "next", source: "foreground", turnId: "turn_4", at: "t", payload: { action: "look" } },
  ])
  assert.match(rendered, /<previous_envelope_feedback>/)
  assert.match(rendered, /dropped 5000/)
  assert.match(rendered, /NOT in effect/)
  assert.match(rendered, /<foreground_updates>/)
  // feedback block comes before the updates block
  assert.ok(rendered.indexOf("previous_envelope_feedback") < rendered.indexOf("foreground_updates"))
})

test("Storykeeper message queue drain claims messages under a mutation lock", async () => {
  const queuePath = await tempQueuePath()
  for (let i = 0; i < 6; i++) {
    await enqueueStorykeeperMessage({ priority: "next", type: "foreground_turn", turnId: `turn_${i}`, payload: { index: i } }, { queuePath })
  }

  const [first, second] = await Promise.all([
    drainStorykeeperMessages({ queuePath, limit: 6 }),
    drainStorykeeperMessages({ queuePath, limit: 6 }),
  ])
  const ids = [...first, ...second].map((message) => message.id)

  assert.equal(new Set(ids).size, 6)
  assert.equal(ids.length, 6)
  assert.deepEqual(await listStorykeeperMessages({ queuePath }), [])
})

test("Storykeeper message queue compaction keeps pending work and bounded terminal state", async () => {
  const queuePath = await tempQueuePath()
  for (let i = 0; i < 8; i++) {
    await enqueueStorykeeperMessage({ priority: "next", type: "foreground_turn", turnId: `done_${i}`, payload: { index: i } }, { queuePath })
  }
  await drainStorykeeperMessages({ queuePath, limit: 8 })
  await enqueueStorykeeperMessage({ priority: "later", type: "watcher", turnId: "pending", payload: { note: "keep" } }, { queuePath })

  const result = await compactStorykeeperMessageQueue({ queuePath, retainTerminalMessages: 2 })
  assert.ok(result.afterEvents < result.beforeEvents)

  const pending = await listStorykeeperMessages({ queuePath })
  assert.deepEqual(pending.map((message) => message.turnId), ["pending"])

  const all = await listStorykeeperMessages({ queuePath, status: "all", limit: 20 })
  assert.equal(all.filter((message) => message.status === "injected").length, 2)
})
