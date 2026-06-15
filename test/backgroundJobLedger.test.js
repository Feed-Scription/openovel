import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { BackgroundJobRegistry } from "../src/runtime/backgroundJob.js"

async function newLedgerDir() {
  return mkdtemp(path.join(tmpdir(), "openovel-jobs-"))
}

function newRegistry() {
  return new BackgroundJobRegistry()
}

async function waitFor(predicate, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

test("ledger records started + completed for a successful job", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  const reg = newRegistry()
  await reg.bindLedger({ path: ledger })

  const job = reg.start({
    id: "j-success",
    type: "storykeeper",
    metadata: { turnId: "t-1" },
    run: async () => ({ processedBatches: 2, batches: [] }),
  })
  // Wait for the run-promise to resolve, then for the ledger write
  await waitFor(() => job.status === "completed")
  await waitFor(async () => {
    const events = await reg.readLedger()
    return events.filter((e) => e.id === "j-success" && e.event === "completed").length === 1
  })

  const events = await reg.readLedger()
  const filtered = events.filter((e) => e.id === "j-success").map((e) => e.event)
  assert.deepEqual(filtered, ["started", "completed"])
})

test("ledger records started + error for a failing job", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  const reg = newRegistry()
  await reg.bindLedger({ path: ledger })

  const job = reg.start({
    id: "j-fail",
    type: "storykeeper",
    run: async () => { throw new Error("DeepSeek aborted") },
  })
  await waitFor(() => job.status === "error")
  await waitFor(async () => {
    const events = await reg.readLedger()
    return events.some((e) => e.id === "j-fail" && e.event === "error")
  })

  const events = await reg.readLedger()
  const filtered = events.filter((e) => e.id === "j-fail")
  assert.equal(filtered[0].event, "started")
  assert.equal(filtered[1].event, "error")
  assert.match(filtered[1].error, /DeepSeek aborted/)
})

test("recoverAbandoned marks pre-existing started-but-not-terminal jobs as abandoned", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")

  // Simulate a previous process: one job started, one started+completed
  await writeFile(
    ledger,
    [
      JSON.stringify({ event: "started", id: "j-orphan", type: "storykeeper", at: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ event: "started", id: "j-done", type: "memory-review", at: "2026-01-01T00:00:01.000Z" }),
      JSON.stringify({ event: "completed", id: "j-done", at: "2026-01-01T00:00:02.000Z", output: {} }),
    ].join("\n") + "\n",
    "utf8",
  )

  const reg = newRegistry()
  const recovered = await reg.bindLedger({ path: ledger })
  assert.equal(recovered, 1, "should recover the orphan")

  const events = await reg.readLedger()
  const orphanEvents = events.filter((e) => e.id === "j-orphan")
  assert.deepEqual(orphanEvents.map((e) => e.event), ["started", "abandoned"])
  assert.match(orphanEvents[1].reason, /process restart/)

  // Already-completed job should NOT be re-abandoned
  const doneEvents = events.filter((e) => e.id === "j-done")
  assert.deepEqual(doneEvents.map((e) => e.event), ["started", "completed"])
})

test("bindLedger is idempotent for the same path", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  const reg = newRegistry()
  const first = await reg.bindLedger({ path: ledger })
  assert.equal(typeof first, "number")
  const second = await reg.bindLedger({ path: ledger })
  assert.equal(second, false, "binding the same path again is a no-op")
})

test("listFromLedger returns latest event per job, newest first", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  const reg = newRegistry()
  await reg.bindLedger({ path: ledger })

  const j1 = reg.start({ id: "j-a", type: "storykeeper", run: async () => ({ ok: true }) })
  await waitFor(() => j1.status === "completed")
  const j2 = reg.start({ id: "j-b", type: "memory-review", run: async () => ({ ok: true }) })
  await waitFor(() => j2.status === "completed")
  // settle ledger writes
  await waitFor(async () => (await reg.readLedger()).filter((e) => e.event === "completed").length >= 2)

  const summary = await reg.listFromLedger({ limit: 10 })
  assert.equal(summary.length, 2)
  // Newest startedAt first
  assert.equal(summary[0].id, "j-b")
  assert.equal(summary[1].id, "j-a")
  // Each entry has lastEvent
  assert.equal(summary[0].lastEvent, "completed")
  assert.equal(summary[1].lastEvent, "completed")
})

test("readLedger tolerates torn last line", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  await writeFile(
    ledger,
    `${JSON.stringify({ event: "started", id: "j-good", at: "2026-01-01T00:00:00.000Z" })}\n{this is not valid json\n`,
    "utf8",
  )
  const reg = newRegistry()
  await reg.bindLedger({ path: ledger })
  const events = await reg.readLedger()
  // Good line parsed; torn line skipped (we also wrote an "abandoned" for j-good during bind)
  assert.equal(events.filter((e) => e.id === "j-good")[0].event, "started")
  assert.ok(events.length >= 1, "torn line should not crash readLedger")
})

test("ledger truncates very long string fields to keep events scannable", async () => {
  const dir = await newLedgerDir()
  const ledger = path.join(dir, "jobs.jsonl")
  const reg = newRegistry()
  await reg.bindLedger({ path: ledger })
  const longString = "x".repeat(5000)
  const job = reg.start({
    id: "j-bulky",
    type: "storykeeper",
    run: async () => ({ foregroundGuidance: longString, inboxResolved: ["a", "b", "c"] }),
  })
  await waitFor(() => job.status === "completed")
  await waitFor(async () => (await reg.readLedger()).some((e) => e.id === "j-bulky" && e.event === "completed"))

  const events = await reg.readLedger()
  const completed = events.find((e) => e.id === "j-bulky" && e.event === "completed")
  assert.match(completed.output.foregroundGuidance, /truncated/)
  assert.ok(completed.output.foregroundGuidance.length < 500, "long string truncated to keep ledger lean")
  assert.deepEqual(completed.output.inboxResolved, ["a", "b", "c"]) // short arrays kept verbatim
})

test("backgroundJobs.start binds a UsageProfile and publishes background.usage", async () => {
  // The bug: prior code let chatMessage calls inside background jobs fall
  // through `currentUsageProfile() === null` and silently drop cost data.
  // The fix: each job runs inside its own runWithUsageProfile, and the
  // completion publishes a summary so eval/TUI aggregators can sum it.
  const { bus } = await import("../src/runtime/bus.js")
  const { createUsageProfile, currentUsageProfile, recordModelCall } = await import("../src/telemetry/usageProfile.js")

  const usageEvents = []
  const unsub = bus.subscribe("background.usage", (e) => usageEvents.push(e))

  const reg = newRegistry()
  let profileWasBound = false
  const job = reg.start({
    id: "j-usage",
    type: "storykeeper",
    metadata: { turnId: "t-42" },
    run: async () => {
      // Inside run(), currentUsageProfile should be set to the job's profile.
      profileWasBound = currentUsageProfile() !== null
      // Simulate a chat call recording into the bound profile.
      recordModelCall({
        role: "background",
        modelProfile: "storykeeper",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: true,
        telemetry: {
          durationMs: 1234,
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 800,
            prompt_cache_hit_tokens: 1000,
          },
        },
      })
      return { ok: true }
    },
    bus,
  })
  await waitFor(() => job.status === "completed")
  await waitFor(() => usageEvents.length > 0)
  unsub()

  assert.equal(profileWasBound, true, "currentUsageProfile should be set inside run()")
  assert.equal(usageEvents.length, 1)
  const summary = usageEvents[0].properties.summary
  assert.equal(usageEvents[0].properties.type, "storykeeper")
  assert.equal(summary.modelCalls, 1)
  assert.equal(summary.inputTokens, 5000)
  assert.equal(summary.cacheReadInputTokens, 1000)
  assert.equal(summary.outputTokens, 800)
  assert.ok(summary.estimatedCostUSD > 0, "cost should be computed from usage")
  // Verify the job itself carries the summary for later inspection.
  assert.equal(job.usage.modelCalls, 1)
})

test("background.usage fires even when the job throws (input still billed)", async () => {
  const { bus } = await import("../src/runtime/bus.js")
  const { recordModelCall } = await import("../src/telemetry/usageProfile.js")

  const usageEvents = []
  const unsub = bus.subscribe("background.usage", (e) => usageEvents.push(e))

  const reg = newRegistry()
  const job = reg.start({
    id: "j-failing",
    type: "storykeeper",
    run: async () => {
      recordModelCall({
        role: "background",
        modelProfile: "storykeeper",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: false,
        error: "Provider API 400: bad reasoning_content",
        telemetry: { durationMs: 50, usage: { prompt_tokens: 3000 } },
      })
      throw new Error("Provider API 400: bad reasoning_content")
    },
    bus,
  })
  await waitFor(() => job.status === "error")
  await waitFor(() => usageEvents.length > 0)
  unsub()

  assert.equal(usageEvents.length, 1)
  assert.equal(usageEvents[0].properties.error, "Provider API 400: bad reasoning_content")
  const summary = usageEvents[0].properties.summary
  assert.equal(summary.modelCalls, 1, "the failed attempt's input tokens should still be reported")
  assert.equal(summary.inputTokens, 3000)
})

test("when no ledger is bound, registry works as before (in-memory only)", async () => {
  const reg = newRegistry()
  const job = reg.start({
    id: "j-no-ledger",
    type: "test",
    run: async () => ({ ok: true }),
  })
  await waitFor(() => job.status === "completed")
  assert.equal(reg.get("j-no-ledger").status, "completed")
  assert.equal(reg.list().length, 1)
  assert.equal(reg.ledgerPath(), "")
})

test("storykeeper output is dropped from in-memory job after completion", async () => {
  const reg = newRegistry()
  const job = reg.start({
    id: "j-storykeeper-output",
    type: "storykeeper",
    run: async () => ({ messages: new Array(100).fill("x".repeat(1000)) }),
  })
  await waitFor(() => job.status === "completed")
  assert.equal(job.status, "completed")
  // storykeeper is a fire-and-forget job type; output payload should be
  // dropped from the in-memory entry to keep the Map small.
  assert.equal(job.output, undefined)
})

test("initializer retains output for caller consumption", async () => {
  const reg = newRegistry()
  const job = reg.start({
    id: "j-init-output",
    type: "initializer",
    run: async () => ({ status: "ready", summary: "init done" }),
  })
  await waitFor(() => job.status === "completed")
  assert.equal(job.status, "completed")
  assert.deepEqual(job.output, { status: "ready", summary: "init done" })
})

test("jobs Map is capped — old terminal entries evicted by new start()", async () => {
  const reg = newRegistry()
  // Run jobs sequentially so each new start() sees prior jobs as completed
  // (eligible for eviction). Synchronous bursts would leave them all in
  // "running" state at start time and the eviction loop would correctly
  // skip them — that case is covered by the running-never-evicted test.
  for (let i = 0; i < 270; i++) {
    const job = reg.start({
      id: `j-${i.toString().padStart(4, "0")}`,
      type: "storykeeper",
      run: async () => ({ ok: true }),
    })
    await waitFor(() => job.status === "completed", { timeout: 5000 })
  }
  const size = reg.list().length
  assert.ok(size <= 256, `expected Map size ≤ 256, got ${size}`)
  assert.ok(reg.get("j-0269"), "newest job must be retained")
  assert.equal(reg.get("j-0000"), undefined, "oldest job must be evicted")
})

test("running jobs are never evicted even past the cap", async () => {
  const reg = newRegistry()
  const stalls = []
  for (let i = 0; i < 300; i++) {
    reg.start({
      id: `r-${i.toString().padStart(4, "0")}`,
      type: "storykeeper",
      run: () => new Promise((resolve) => stalls.push(resolve)),
    })
  }
  // None of the 300 jobs have completed; the eviction pass should refuse
  // to evict running entries, so the Map remains at 300.
  assert.equal(reg.list().length, 300)
  // Cleanup: drain the stalled runs so node's test runner can exit
  for (const resolve of stalls) resolve({ ok: true })
  await waitFor(() => reg.list().every((j) => j.status === "completed"), { timeout: 5000 })
})

test("a job's lifecycle events land in the ledger bound when it STARTED, not the one bound when it finishes", async () => {
  const ledgerA = path.join(await newLedgerDir(), "jobs-a.jsonl")
  const ledgerB = path.join(await newLedgerDir(), "jobs-b.jsonl")
  const reg = newRegistry()
  await reg.bindLedger({ path: ledgerA })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const job = reg.start({ id: "j-pinned", type: "storykeeper", run: () => gate })
  assert.ok(job.storyRoot, "job records the story root it started under")

  // Reader switches stories mid-run: registry reset + re-bound to B's ledger.
  reg.reset()
  await reg.bindLedger({ path: ledgerB })

  release({ ok: true })
  await waitFor(() => job.status === "completed")
  await reg.flushLedger()

  // started + completed both live in A's ledger; B's ledger never saw the job.
  // (A completion written to B once left A's ledger at "started" forever, so
  // reopening A re-woke an agent that had actually finished.)
  const eventsA = (await readFile(ledgerA, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
  assert.deepEqual(eventsA.filter((e) => e.id === "j-pinned").map((e) => e.event), ["started", "completed"])
  const rawB = await readFile(ledgerB, "utf8").catch(() => "")
  assert.ok(!rawB.includes("j-pinned"))
})
