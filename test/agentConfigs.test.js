import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadAgentConfigs } from "../src/agents/loadAgentConfigs.js"
import { allAgentConfigs, getAgentWriteScope, setAgentRegistry, clearAgentRegistry } from "../src/agents/agentRegistry.js"
import { agentWriteScopeDenial } from "../src/agents/writeGuard.js"

test("loadAgentConfigs parses the Agent Cards and derives domain paths", async () => {
  const root = path.join(os.tmpdir(), `agentcfg-${Date.now()}`)
  // Pin every feature-gated agent OFF so the assertion is deterministic
  // regardless of the operator's ambient settings (render = format-contract,
  // image = image-gen, music = music-gen).
  const configs = await loadAgentConfigs({ root, formatEnabled: false, imageEnabled: false, musicEnabled: false })
  const ids = configs.map((c) => c.id).sort()
  // the format/image/music-gated agents are dropped when their flag is off
  assert.deepEqual(ids, ["cards", "director", "memory", "showrunner", "worldkeeper"])

  const wk = configs.find((c) => c.id === "worldkeeper")
  assert.equal(wk.role, "subagent")
  assert.ok(wk.includeTools.includes("websearch"), "world keeper has web tools")
  assert.deepEqual(wk.writeScope, ["story/worldkeeper/**", "story/state/**"])
  assert.equal(wk.domainDir, path.join(root, "worldkeeper"))
  assert.equal(wk.threadPath, path.join(root, "worldkeeper", "thread.jsonl"))
  assert.equal(wk.lockPath, path.join(root, "worldkeeper", "agent.lock"))
  assert.equal(wk.inboxPath, path.join(root, "worldkeeper", "inbox.queue.jsonl"))

  const sr = configs.find((c) => c.id === "showrunner")
  assert.equal(sr.role, "coordinator")
  assert.deepEqual(sr.coordinates, ["cards", "worldkeeper", "director", "memory", "render"])
  for (const tool of ["task", "task_status", "monitor", "loop"]) {
    assert.ok(sr.includeTools.includes(tool), `showrunner has ${tool}`)
  }
})

test("explain is on every resident agent; bash + includeDangerous only on worldkeeper/director/cards", async () => {
  const root = path.join(os.tmpdir(), `agentcfg-tools-${Date.now()}`)
  // Enable every feature gate so all eight resident agents are present: this is
  // the invariant guard now that the implicit withExplain() append is gone, so
  // every card must declare `explain` itself.
  const configs = await loadAgentConfigs({ root, formatEnabled: true, imageEnabled: true, musicEnabled: true })
  for (const c of configs) {
    assert.ok(c.includeTools.includes("explain"), `${c.id} has explain`)
  }
  // Only the structured-data agents opt into the dangerous-gated bash tool.
  const danger = configs.filter((c) => c.includeDangerous).map((c) => c.id).sort()
  assert.deepEqual(danger, ["cards", "director", "worldkeeper"])
  for (const id of ["worldkeeper", "director", "cards"]) {
    assert.ok(configs.find((c) => c.id === id).includeTools.includes("bash"), `${id} has bash`)
  }
  for (const id of ["memory", "render", "showrunner", "image", "music"]) {
    const c = configs.find((x) => x.id === id)
    assert.equal(c.includeTools.includes("bash"), false, `${id} has no bash`)
    assert.equal(c.includeDangerous, false, `${id} is not dangerous`)
  }
})

test("loadAgentConfigs includes Render Manager only when format contract is enabled", async () => {
  const root = path.join(os.tmpdir(), `agentcfg-fmt-${Date.now()}`)
  const off = await loadAgentConfigs({ root, formatEnabled: false })
  assert.ok(!off.some((c) => c.id === "render"))
  const on = await loadAgentConfigs({ root, formatEnabled: true })
  assert.ok(on.some((c) => c.id === "render"))
})

test("write guard denies cross-domain writes (when enforced) and always allows in-domain + reads", async () => {
  const prev = process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE
  process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE = "1"
  setAgentRegistry([
    { id: "worldkeeper", writeScope: ["story/worldkeeper/**", "story/state/**"] },
    { id: "director", writeScope: ["story/director/**"] },
  ])
  try {
    // in-domain write: allowed (null = no denial)
    assert.equal(agentWriteScopeDenial({ name: "write", args: { filePath: "story/worldkeeper/notebook/x.md" }, context: { agent: "worldkeeper" } }), null)
    assert.equal(agentWriteScopeDenial({ name: "edit", args: { filePath: "story/state/stats.json" }, context: { agent: "worldkeeper" } }), null)
    // cross-domain write into the Showrunner-owned frontend: denied
    const denial = agentWriteScopeDenial({ name: "write", args: { filePath: "story/frontend/scene.md" }, context: { agent: "worldkeeper" } })
    assert.match(denial || "", /may not write/)
    // a sub-agent writing another sub-agent's domain: denied
    assert.match(agentWriteScopeDenial({ name: "edit", args: { filePath: "story/director/ARC.md" }, context: { agent: "worldkeeper" } }) || "", /may not write/)
    // reads / grep / web are never guarded
    assert.equal(agentWriteScopeDenial({ name: "read", args: { filePath: "story/frontend/scene.md" }, context: { agent: "worldkeeper" } }), null)
    assert.equal(agentWriteScopeDenial({ name: "websearch", args: { query: "x" }, context: { agent: "worldkeeper" } }), null)
    // unregistered/unscoped agent (e.g. legacy storykeeper) is unrestricted
    assert.equal(agentWriteScopeDenial({ name: "write", args: { filePath: "story/frontend/scene.md" }, context: { agent: "storykeeper" } }), null)
  } finally {
    clearAgentRegistry()
    if (prev === undefined) delete process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE
    else process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE = prev
  }
})

test("write guard is log-only (allows) when enforcement flag is off", async () => {
  const prev = process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE
  delete process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE
  setAgentRegistry([{ id: "director", writeScope: ["story/director/**"] }])
  try {
    // out-of-domain write would be denied if enforced, but flag is off → null (allowed, logged)
    assert.equal(agentWriteScopeDenial({ name: "write", args: { filePath: "story/frontend/scene.md" }, context: { agent: "director" } }), null)
  } finally {
    clearAgentRegistry()
    if (prev !== undefined) process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE = prev
  }
})

test("config registry exposes write scope by id", async () => {
  await loadAgentConfigs({ root: path.join(os.tmpdir(), `agentcfg-reg-${Date.now()}`), formatEnabled: false })
  assert.deepEqual(getAgentWriteScope("director"), ["story/director/**"])
  assert.ok(allAgentConfigs().length >= 5)
  clearAgentRegistry()
})

test("agent registry is slotted per story root: a left story's agent is guarded by ITS configs", () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  const rootA = path.join(os.tmpdir(), `agentcfg-rootA-${Date.now()}`)
  const rootB = path.join(os.tmpdir(), `agentcfg-rootB-${Date.now()}`)
  try {
    process.env.OPENOVEL_STORY_ROOT = rootA
    setAgentRegistry([{ id: "director", writeScope: ["story/director/**"] }])

    // Switch to story B: its registry slot starts empty, then loads its own
    // (per-story YAML overrides may differ from A's).
    process.env.OPENOVEL_STORY_ROOT = rootB
    assert.equal(getAgentWriteScope("director"), null)
    setAgentRegistry([{ id: "director", writeScope: ["story/director/**", "story/state/**"] }])

    // Story A's still-running agent (pinned to root A) consults A's slot.
    process.env.OPENOVEL_STORY_ROOT = rootA
    assert.deepEqual(getAgentWriteScope("director"), ["story/director/**"])
    process.env.OPENOVEL_STORY_ROOT = rootB
    assert.deepEqual(getAgentWriteScope("director"), ["story/director/**", "story/state/**"])
  } finally {
    clearAgentRegistry()
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})
