import assert from "node:assert/strict"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadInitTranscript, isInterruptedInitTranscript } from "../src/runtime/initReplay.js"

test("isInterruptedInitTranscript: only a phase-start transcript with an intent counts", () => {
  const base = { intent: "写一个科幻故事", messages: [{ role: "user", text: "写一个科幻故事" }] }
  assert.equal(isInterruptedInitTranscript({ ...base, phase: "start" }), true)
  // Terminal phases — finished, failed, or deliberately cancelled — never resume.
  for (const phase of ["completed", "failed", "cancelled"]) {
    assert.equal(isInterruptedInitTranscript({ ...base, phase }), false, phase)
  }
  // Degenerate shapes.
  assert.equal(isInterruptedInitTranscript(null), false)
  assert.equal(isInterruptedInitTranscript({ phase: "start", intent: "  " }), false)
  assert.equal(isInterruptedInitTranscript({ phase: "start" }), false)
})

test("loadInitTranscript returns the LATEST run — a completed rerun shadows an old interruption", async () => {
  const agentsDir = await mkdtemp(path.join(os.tmpdir(), "openovel-init-resume-"))
  await mkdir(agentsDir, { recursive: true })
  const write = (name, obj) => writeFile(path.join(agentsDir, name), JSON.stringify(obj), "utf8")

  // Older run interrupted, newer run completed → the story is fine, no resume.
  await write("init-2026-06-01T10-00-00-000Z-aaaa.json", {
    runId: "init-2026-06-01T10-00-00-000Z-aaaa",
    phase: "start",
    intent: "老的中断",
    messages: [{ role: "user", text: "老的中断" }],
  })
  await write("init-2026-06-02T10-00-00-000Z-bbbb.json", {
    runId: "init-2026-06-02T10-00-00-000Z-bbbb",
    phase: "completed",
    intent: "新的完成",
    messages: [{ role: "user", text: "新的完成" }],
  })
  let latest = await loadInitTranscript(agentsDir)
  assert.equal(latest.runId, "init-2026-06-02T10-00-00-000Z-bbbb")
  assert.equal(isInterruptedInitTranscript(latest), false)

  // A newer interrupted run → resume.
  await write("init-2026-06-03T10-00-00-000Z-cccc.json", {
    runId: "init-2026-06-03T10-00-00-000Z-cccc",
    phase: "start",
    intent: "最新被中断",
    messages: [
      { role: "system", text: "greeting" },
      { role: "user", text: "最新被中断" },
    ],
  })
  latest = await loadInitTranscript(agentsDir)
  assert.equal(isInterruptedInitTranscript(latest), true)
  assert.equal(latest.intent, "最新被中断")
})

test("isUnfinishedInitTranscript: any non-complete phase with an intent counts", async () => {
  const { isUnfinishedInitTranscript } = await import("../src/runtime/initReplay.js")
  const base = { intent: "写一个科幻故事", messages: [] }
  for (const phase of ["start", "cancelled", "failed"]) {
    assert.equal(isUnfinishedInitTranscript({ ...base, phase }), true, phase)
  }
  for (const phase of ["complete", "completed"]) {
    assert.equal(isUnfinishedInitTranscript({ ...base, phase }), false, phase)
  }
  assert.equal(isUnfinishedInitTranscript(null), false)
  assert.equal(isUnfinishedInitTranscript({ phase: "cancelled", intent: "  " }), false)
})

test("loadInitTranscript requireMessages:false surfaces a messages-less cancelled transcript", async () => {
  const agentsDir = await mkdtemp(path.join(os.tmpdir(), "openovel-init-resume-"))
  await mkdir(agentsDir, { recursive: true })
  // The cancel-write race used to persist phase:cancelled with messages:[] —
  // the resume path must still see this story as unfinished.
  await writeFile(path.join(agentsDir, "init-2026-06-11T12-00-00-000Z-aaaa.json"), JSON.stringify({
    runId: "init-2026-06-11T12-00-00-000Z-aaaa",
    phase: "cancelled",
    intent: "被取消的初始化",
    messages: [],
  }), "utf8")
  // Default (replay semantics): no conversation → no transcript.
  assert.equal(await loadInitTranscript(agentsDir), null)
  // Resume semantics: the record is visible and classified unfinished.
  const t = await loadInitTranscript(agentsDir, { requireMessages: false })
  assert.equal(t.intent, "被取消的初始化")
  const { isUnfinishedInitTranscript } = await import("../src/runtime/initReplay.js")
  assert.equal(isUnfinishedInitTranscript(t), true)
  assert.equal(isInterruptedInitTranscript(t), false)
})
