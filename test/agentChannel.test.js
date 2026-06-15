import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  broadcastAgentMessage,
  drainAgentMessages,
  enqueueAgentMessage,
  inboxQueuePath,
  listAgentMessages,
  markAgentMessagesForTurnInjected,
  registeredAgentIds,
  renderAgentInbox,
  setAgentInboxRegistry,
} from "../src/runtime/agentChannel.js"

test("from/to addressing routes to the recipient inbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentchannel-"))
  const queuePath = path.join(dir, "worldkeeper.inbox.jsonl")
  await enqueueAgentMessage(
    { from: "director", to: "worldkeeper", type: "drama_proposal", priority: "now", turnId: "t1", payload: { note: "raise stakes" } },
    { queuePath },
  )
  const pending = await listAgentMessages({ queuePath })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].source, "director", "stored `from` as source")
  assert.equal(pending[0].to, "worldkeeper")
  assert.equal(pending[0].type, "drama_proposal")

  const rendered = renderAgentInbox(pending)
  assert.match(rendered, /<foreground_updates>/)
  assert.match(rendered, /source="director"/)
})

test("registry resolves agentId -> inbox path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentchannel-reg-"))
  const wk = path.join(dir, "worldkeeper", "inbox.queue.jsonl")
  const dr = path.join(dir, "director", "inbox.queue.jsonl")
  setAgentInboxRegistry([["worldkeeper", wk], ["director", dr]])
  try {
    assert.equal(inboxQueuePath("worldkeeper"), wk)
    assert.deepEqual(registeredAgentIds().sort(), ["director", "worldkeeper"])
    // enqueue by `to` (no explicit queuePath) lands in the resolved inbox
    await enqueueAgentMessage({ from: "foreground", to: "director", type: "narration_generated", turnId: "t2", payload: { summary: "x" } })
    const drained = await drainAgentMessages({ agent: "director" })
    assert.equal(drained.length, 1)
    assert.equal(drained[0].to, "director")
  } finally {
    setAgentInboxRegistry([])
  }
})

test("broadcast fans the same message out to every registered inbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentchannel-bcast-"))
  const agents = ["worldkeeper", "director", "cards", "memory"]
  setAgentInboxRegistry(agents.map((id) => [id, path.join(dir, id, "inbox.queue.jsonl")]))
  try {
    const sent = await broadcastAgentMessage({
      from: "runtime",
      type: "narration_generated",
      priority: "next",
      turnId: "t3",
      payload: { summary: "scene advanced", narrativePointer: { dir: "story/canon", file: "chapters.recent.md", turnId: "t3" } },
    })
    assert.equal(sent.length, agents.length, "one enqueue per registered inbox")
    for (const id of agents) {
      const pending = await listAgentMessages({ agent: id })
      assert.equal(pending.length, 1, `${id} received the broadcast`)
      assert.equal(pending[0].to, id)
      assert.equal(pending[0].payload.narrativePointer.file, "chapters.recent.md", "carries the pointer, not prose")
    }
  } finally {
    setAgentInboxRegistry([])
  }
})

test("broadcast can target an explicit subset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentchannel-subset-"))
  setAgentInboxRegistry([
    ["worldkeeper", path.join(dir, "worldkeeper", "inbox.queue.jsonl")],
    ["director", path.join(dir, "director", "inbox.queue.jsonl")],
  ])
  try {
    await broadcastAgentMessage({ from: "showrunner", type: "route", turnId: "t4", payload: {} }, { agents: ["director"] })
    assert.equal((await listAgentMessages({ agent: "director" })).length, 1)
    assert.equal((await listAgentMessages({ agent: "worldkeeper" })).length, 0)
  } finally {
    setAgentInboxRegistry([])
  }
})

test("markAgentMessagesForTurnInjected can mark only runtime broadcasts and leave peer messages pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentchannel-filter-"))
  setAgentInboxRegistry([
    ["worldkeeper", path.join(dir, "worldkeeper", "inbox.queue.jsonl")],
  ])
  try {
    await enqueueAgentMessage({
      from: "runtime",
      to: "worldkeeper",
      type: "narration_generated",
      turnId: "t5",
      payload: { summary: "scene", narrativePointer: { file: "chapters.recent.md" } },
    })
    await enqueueAgentMessage({
      from: "director",
      to: "worldkeeper",
      type: "state_check",
      turnId: "t5",
      payload: { message: "validate location" },
    })

    const marked = await markAgentMessagesForTurnInjected("t5", {
      agent: "worldkeeper",
      sources: ["runtime"],
      types: ["reader_action", "narration_generated"],
    })
    assert.equal(marked.injected.length, 1)

    const pending = await listAgentMessages({ agent: "worldkeeper" })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].source, "director")
    assert.equal(pending[0].type, "state_check")
  } finally {
    setAgentInboxRegistry([])
  }
})

test("inbox registry is slotted per story root: a left story's agent keeps its own addresses", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  const rootA = await mkdtemp(path.join(os.tmpdir(), "agentchannel-rootA-"))
  const rootB = await mkdtemp(path.join(os.tmpdir(), "agentchannel-rootB-"))
  try {
    // Story A loads its configs (registry populated under root A).
    process.env.OPENOVEL_STORY_ROOT = rootA
    const wkA = path.join(rootA, "worldkeeper", "inbox.queue.jsonl")
    setAgentInboxRegistry([["worldkeeper", wkA]])

    // Reader switches to story B; B loads its own configs.
    process.env.OPENOVEL_STORY_ROOT = rootB
    const wkB = path.join(rootB, "worldkeeper", "inbox.queue.jsonl")
    setAgentInboxRegistry([["worldkeeper", wkB]])
    assert.equal(inboxQueuePath("worldkeeper"), wkB)

    // Story A's still-running agent (pinned to root A) resolves A's inbox —
    // a single global registry here once sent its message into B's queue.
    process.env.OPENOVEL_STORY_ROOT = rootA
    assert.equal(inboxQueuePath("worldkeeper"), wkA)
    assert.deepEqual(registeredAgentIds(), ["worldkeeper"])

    // And B's slot is untouched by A's tail-end resolution.
    process.env.OPENOVEL_STORY_ROOT = rootB
    assert.equal(inboxQueuePath("worldkeeper"), wkB)
  } finally {
    setAgentInboxRegistry([])
    process.env.OPENOVEL_STORY_ROOT = rootA
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})
