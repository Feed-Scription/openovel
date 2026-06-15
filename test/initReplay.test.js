import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildReplaySteps, replayMeta, loadInitTranscript, hasInitTranscript } from "../src/runtime/initReplay.js"

const SAMPLE = {
  runId: "init-2026-06-08T140000-Z-abcd",
  phase: "complete",
  story: { id: "s_demo", displayName: "朱博的妙妙假期", root: "/x/s_demo" },
  depth: { requested: "deep", effective: "standard" },
  usage: { steps: 12, modelCalls: 8, inputTokens: 80000, outputTokens: 12327, estimatedCostUSD: 0.4 },
  summary: "Drafted the opening scaffold, three cards, and the arc ledger.",
  messages: [
    { id: "im_1", role: "system", text: "What kind of story should this become? ".repeat(2), at: 1 },
    { id: "im_2", role: "user", text: "A pilgrimage along the Kumano Kodō.", at: 2 },
    { id: "im_3", role: "agent", text: "Great — let me confirm a couple of premises before I draft.".repeat(2), at: 3 },
    { id: "im_4", role: "tool-call", text: "read story/BRIEF.md", meta: { tool: "read", callId: "c1", status: "done" }, at: 4 },
    { id: "im_5", role: "ask-user", text: "Who is the protagonist?", meta: { questionId: "ask_1", header: "Protagonist", options: [{ label: "A lone traveler", description: "solo" }, { label: "Two companions", description: "pair" }], multiSelect: false }, at: 5 },
    { id: "im_6", role: "user-answer", text: "Two companions.", meta: { questionId: "ask_1" }, at: 6 },
    { id: "im_7", role: "agent", text: "Got it.", at: 7 },
    { id: "im_8", role: "summary", text: "Scaffold ready.".repeat(4), at: 8 },
  ],
}

test("replayMeta pulls the story name + effective depth", () => {
  assert.deepEqual(replayMeta(SAMPLE), { storyName: "朱博的妙妙假期", depth: "standard" })
  assert.deepEqual(replayMeta({}), { storyName: "", depth: "standard" })
})

test("buildReplaySteps maps each recorded message to the right step kind", () => {
  const steps = buildReplaySteps(SAMPLE)
  const kinds = steps.map((s) => s.kind)
  // 8 messages → 8 steps + a final complete
  assert.equal(steps.length, SAMPLE.messages.length + 1)
  assert.deepEqual(kinds, ["message", "message", "message", "tool", "ask", "answer", "message", "message", "complete"])
  assert.equal(steps.at(-1).kind, "complete")
})

test("ask step carries the reconstructed pendingAskUser; answer follows it", () => {
  const steps = buildReplaySteps(SAMPLE)
  const ask = steps.find((s) => s.kind === "ask")
  assert.equal(ask.pendingAskUser.id, "ask_1")
  assert.equal(ask.pendingAskUser.question, "Who is the protagonist?")
  assert.equal(ask.pendingAskUser.header, "Protagonist")
  assert.equal(ask.pendingAskUser.options.length, 2)
  assert.equal(ask.pendingAskUser.multiSelect, false)
  // the answer step immediately follows, carrying the recorded answer text
  const askIdx = steps.indexOf(ask)
  assert.equal(steps[askIdx + 1].kind, "answer")
  assert.equal(steps[askIdx + 1].message.text, "Two companions.")
})

test("typed flag is set only on long agent/system/summary prose", () => {
  const steps = buildReplaySteps(SAMPLE)
  const byRole = (role) => steps.filter((s) => s.kind === "message" && s.message.role === role)
  assert.equal(byRole("system")[0].typed, true) // long greeting
  assert.equal(byRole("agent")[0].typed, true) // long confirm line
  assert.equal(byRole("agent")[1].typed, false) // "Got it." is short
  assert.equal(byRole("user")[0].typed, false) // user echo isn't typed
})

test("real tool calls become 'tool' steps; explain notes stay 'message'", () => {
  const steps = buildReplaySteps({
    messages: [
      { id: "t1", role: "tool-call", text: "thinking", meta: { tool: "explain", status: "done" }, at: 1 },
      { id: "t2", role: "tool-call", text: "read story/BRIEF.md", meta: { tool: "read", status: "done" }, at: 2 },
      { id: "t3", role: "tool-call", text: "glob **/*.md", meta: { tool: "glob", status: "error" }, at: 3 },
    ],
  })
  assert.deepEqual(steps.map((s) => s.kind), ["message", "tool", "tool", "complete"])
  // tool steps carry the recorded tool-call message (so the driver can group +
  // flip its status), and an explain note does not become a lingering tool row.
  const tools = steps.filter((s) => s.kind === "tool")
  assert.deepEqual(tools.map((s) => s.message.meta.tool), ["read", "glob"])
})

test("usageTokens climbs across the costing steps and lands on the total", () => {
  const steps = buildReplaySteps(SAMPLE)
  const total = 80000 + 12327
  assert.equal(steps.at(-1).usageTokens, total)
  // monotonic non-decreasing
  let prev = -1
  for (const s of steps) {
    assert.ok(s.usageTokens >= prev, `tokens non-decreasing (${s.usageTokens} >= ${prev})`)
    prev = s.usageTokens
  }
})

test("buildReplaySteps tolerates an empty / malformed transcript", () => {
  assert.deepEqual(buildReplaySteps({}).map((s) => s.kind), ["complete"])
  assert.deepEqual(buildReplaySteps(null).map((s) => s.kind), ["complete"])
  assert.equal(buildReplaySteps({ messages: [] }).at(-1).usageTokens, 0)
})

test("loadInitTranscript reads the newest init-*.json (and hasInitTranscript reflects it)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openovel-initreplay-"))
  assert.equal(await loadInitTranscript(dir), null)
  assert.equal(await hasInitTranscript(dir), false)
  await writeFile(path.join(dir, "init-2026-06-08T130000-Z-0001.json"), JSON.stringify({ messages: [{ role: "system", text: "old" }] }))
  await writeFile(path.join(dir, "init-2026-06-08T140000-Z-0002.json"), JSON.stringify({ messages: [{ role: "system", text: "new" }], summary: "newest" }))
  await writeFile(path.join(dir, "not-an-init.json"), "garbage")
  const t = await loadInitTranscript(dir)
  assert.equal(t.summary, "newest")
  assert.equal(await hasInitTranscript(dir), true)
})
