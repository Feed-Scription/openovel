import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  agentResumeSnapshotPath,
  writeAgentResumeSnapshot,
  consumeAgentResumeSnapshot,
  interruptedAgentsFromLedger,
} from "../src/runtime/agentResume.js"

async function withIsolatedStory(run) {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = await mkdtemp(path.join(os.tmpdir(), "openovel-resume-"))
  try {
    return await run()
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
}

function fakeRegistry(jobs) {
  return { list: () => jobs }
}

test("resume snapshot: records running jobs only, never clobbers when idle", async () => {
  await withIsolatedStory(async () => {
    // Idle registry → no write, and crucially no delete of an existing file.
    let result = await writeAgentResumeSnapshot({ registry: fakeRegistry([]) })
    assert.equal(result.recorded, 0)
    assert.equal(existsSync(agentResumeSnapshotPath()), false)

    result = await writeAgentResumeSnapshot({
      registry: fakeRegistry([
        { id: "j1", type: "resident:world-keeper", status: "running", metadata: { agent: "world-keeper", turnId: "t9" }, title: "wk", startedAt: "x" },
        { id: "j2", type: "resident:director", status: "completed", metadata: { agent: "director" } },
      ]),
    })
    assert.equal(result.recorded, 1)
    assert.equal(existsSync(agentResumeSnapshotPath()), true)

    // A later idle write (e.g. boot-path drain with an empty registry) must
    // NOT remove the previous session's snapshot.
    result = await writeAgentResumeSnapshot({ registry: fakeRegistry([]) })
    assert.equal(result.recorded, 0)
    assert.equal(existsSync(agentResumeSnapshotPath()), true)

    // Consume is one-shot.
    const snapshot = await consumeAgentResumeSnapshot()
    assert.equal(snapshot.activeJobs.length, 1)
    assert.equal(snapshot.activeJobs[0].agent, "world-keeper")
    assert.equal(existsSync(agentResumeSnapshotPath()), false)
    assert.equal(await consumeAgentResumeSnapshot(), null)
  })
})

test("ledger cross-check: completed-after-exit jobs are not interrupted", () => {
  const snapshot = {
    activeJobs: [
      { id: "a", agent: "world-keeper" },   // completed after the reader left → skip
      { id: "b", agent: "director" },       // abandoned (process died) → resume
      { id: "c", agent: "memory" },         // no terminal event in ledger → resume
      { id: "d", agent: "" },               // agent-less job (legacy) → ignore
      { id: "e", agent: "director" },       // duplicate agent → dedup
    ],
  }
  const ledger = [
    { id: "a", event: "started" },
    { id: "a", event: "completed" },
    { id: "b", event: "started" },
    { id: "b", event: "abandoned" },
    { id: "c", event: "started" },
    { id: "e", event: "started" },
  ]
  assert.deepEqual(interruptedAgentsFromLedger(snapshot, ledger).sort(), ["director", "memory"])
  assert.deepEqual(interruptedAgentsFromLedger(null, ledger), [])
  assert.deepEqual(interruptedAgentsFromLedger({ activeJobs: [] }, []), [])
})

test("resumeResidentAgents no-ops when the team is disabled", async () => {
  const saved = process.env.OPENOVEL_RESIDENT_TEAM
  process.env.OPENOVEL_RESIDENT_TEAM = "0"
  try {
    const { resumeResidentAgents } = await import("../src/runtime/residentTeam.js")
    const result = await resumeResidentAgents({ interruptedAgents: ["world-keeper"] })
    assert.deepEqual(result.woken, [])
  } finally {
    if (saved === undefined) delete process.env.OPENOVEL_RESIDENT_TEAM
    else process.env.OPENOVEL_RESIDENT_TEAM = saved
  }
})

test("resume snapshot: excludes jobs pinned to another story", async () => {
  await withIsolatedStory(async () => {
    const { storyPaths } = await import("../src/lib/workspacePaths.js")
    const localRoot = storyPaths().root
    const result = await writeAgentResumeSnapshot({
      registry: fakeRegistry([
        { id: "j-local", status: "running", storyRoot: localRoot, metadata: { agent: "worldkeeper" } },
        // A previous story's detached agent, still finishing after the switch:
        // it is NOT this story's interrupted work.
        { id: "j-foreign", status: "running", storyRoot: "/somewhere/else/story", metadata: { agent: "director" } },
        // Older job shape without storyRoot stays included.
        { id: "j-legacy", status: "running", metadata: { agent: "memory" } },
      ]),
    })
    assert.equal(result.recorded, 2)
    const snapshot = await consumeAgentResumeSnapshot()
    assert.deepEqual(snapshot.activeJobs.map((j) => j.id).sort(), ["j-legacy", "j-local"])

    // Only-foreign registries count as idle — and must not clobber an existing
    // snapshot (same contract as the empty-registry case).
    await writeAgentResumeSnapshot({
      registry: fakeRegistry([{ id: "j-a", status: "running", storyRoot: localRoot, metadata: { agent: "memory" } }]),
    })
    const again = await writeAgentResumeSnapshot({
      registry: fakeRegistry([{ id: "j-foreign2", status: "running", storyRoot: "/somewhere/else", metadata: { agent: "cards" } }]),
    })
    assert.equal(again.recorded, 0)
    assert.equal((await consumeAgentResumeSnapshot()).activeJobs[0].id, "j-a")
  })
})
