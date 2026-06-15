import assert from "node:assert/strict"
import test from "node:test"

import { SessionProcessor } from "../src/runtime/sessionProcessor.js"

// Sub-agent → Showrunner wake (the residentTeam race fix): when the last
// sub-agent finishes with forShowrunner handoffs still queued and no
// composition pass is live, the session layer runs ONE forced pass instead of
// letting the handoffs wait for the next reader turn.

function withTeamEnv(value, run) {
  const saved = process.env.OPENOVEL_RESIDENT_TEAM
  if (value === undefined) delete process.env.OPENOVEL_RESIDENT_TEAM
  else process.env.OPENOVEL_RESIDENT_TEAM = value
  return Promise.resolve(run()).finally(() => {
    if (saved === undefined) delete process.env.OPENOVEL_RESIDENT_TEAM
    else process.env.OPENOVEL_RESIDENT_TEAM = saved
  })
}

test("wakeShowrunnerForHandoffs is a no-op when the team is off", async () => {
  await withTeamEnv("0", async () => {
    const processor = new SessionProcessor()
    const result = await processor.wakeShowrunnerForHandoffs({
      jobs: { start: () => { throw new Error("must not start a job") } },
      hasPending: () => true,
    })
    assert.deepEqual(result, { woken: false, reason: "team-off" })
  })
})

test("wakeShowrunnerForHandoffs skips when nothing is pending", async () => {
  await withTeamEnv("1", async () => {
    const processor = new SessionProcessor()
    const result = await processor.wakeShowrunnerForHandoffs({
      jobs: { start: () => { throw new Error("must not start a job") } },
      hasPending: () => false,
    })
    assert.equal(result.woken, false)
    assert.equal(result.reason, "no-pending-handoffs")
  })
})

test("wakeShowrunnerForHandoffs starts one forced composition pass when handoffs are pending", async () => {
  await withTeamEnv("1", async () => {
    const processor = new SessionProcessor()
    const started = []
    const result = await processor.wakeShowrunnerForHandoffs({
      jobs: {
        start: (spec) => {
          started.push(spec)
          return { id: "job_wake_1" }   // run() is deliberately not invoked
        },
      },
      hasPending: () => true,
    })
    assert.equal(result.woken, true)
    assert.equal(result.jobId, "job_wake_1")
    assert.equal(started.length, 1)
    assert.equal(started[0].type, "storykeeper")
    assert.equal(started[0].metadata.wake, "subagent-handoffs")
    assert.equal(started[0].metadata.agent, "showrunner")
  })
})

test("scheduleShowrunnerHandoffWake debounces to one pending timer", async () => {
  await withTeamEnv("0", async () => {   // team off → the fired wake is a safe no-op
    const processor = new SessionProcessor()
    assert.equal(processor.scheduleShowrunnerHandoffWake({ delayMs: 1 }), true)
    assert.equal(processor.scheduleShowrunnerHandoffWake({ delayMs: 1 }), false, "second schedule coalesces")
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(processor.scheduleShowrunnerHandoffWake({ delayMs: 1 }), true, "re-armable after firing")
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
