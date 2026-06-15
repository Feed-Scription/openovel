import assert from "node:assert/strict"
import test from "node:test"

import { resolveJobAgentId, agentLabelFor } from "../src/runtime/sessionViewModel.js"

// The side-pane agent tree groups an agent's in-flight tool calls under it by
// matching tool.agent (= context.agent = the agent pack id) to the job's resolved
// agent id. These two MUST agree, so the resolver is the load-bearing piece.
test("resolveJobAgentId matches the agent pack id for every job kind", () => {
  // resident sub-agents carry metadata.agent = their pack id
  assert.equal(resolveJobAgentId({ type: "resident:worldkeeper", metadata: { agent: "worldkeeper" } }), "worldkeeper")
  // metadata.agent wins even for the coordinator job (type "storykeeper")
  assert.equal(resolveJobAgentId({ type: "storykeeper", metadata: { agent: "showrunner" } }), "showrunner")
  // resident:<id> without metadata → strip the prefix
  assert.equal(resolveJobAgentId({ type: "resident:director" }), "director")
  // jobs whose type already equals the pack id are NOT remapped
  assert.equal(resolveJobAgentId({ type: "storykeeper" }), "storykeeper")
  assert.equal(resolveJobAgentId({ type: "memory-review" }), "memory-review")
  assert.equal(resolveJobAgentId({ type: "diversify" }), "diversify")
  assert.equal(resolveJobAgentId({ type: "background-signal" }), "background-signal")
  assert.equal(resolveJobAgentId({}), "agent")
})

test("agentLabelFor gives friendly L1 names", () => {
  assert.equal(agentLabelFor("worldkeeper"), "World Keeper")
  assert.equal(agentLabelFor("cards"), "Card Manager")
  assert.equal(agentLabelFor("render"), "Render Manager")
  assert.equal(agentLabelFor("showrunner"), "Showrunner")
  assert.equal(agentLabelFor("memory-review"), "Memory")
  assert.equal(agentLabelFor("background-signal"), "Signal")
  // unknown id → capitalized fallback, never blank
  assert.equal(agentLabelFor("custom"), "Custom")
  assert.equal(agentLabelFor(""), "Agent")
})

test("isForeignStoryJob: only a job pinned to ANOTHER story root is foreign", async () => {
  const { isForeignStoryJob } = await import("../src/runtime/sessionViewModel.js")
  const active = "/tmp/openovel-foreign-current"
  assert.equal(isForeignStoryJob({ storyRoot: active }, active), false)
  assert.equal(isForeignStoryJob({ storyRoot: "/tmp/openovel-foreign-other" }, active), true)
  // legacy jobs without a storyRoot stay local (never filtered)
  assert.equal(isForeignStoryJob({}, active), false)
  assert.equal(isForeignStoryJob({ storyRoot: "" }, active), false)
  // no active story (library view): every story-pinned job is foreign
  assert.equal(isForeignStoryJob({ storyRoot: active }, ""), true)
  assert.equal(isForeignStoryJob({ storyRoot: active }, undefined), true)
})
