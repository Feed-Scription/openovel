import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { listStorySubagents } from "../src/agents/storySubagent.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"
import { registerDefaultTools } from "../src/tools/registerTools.js"

test("subagents include built-ins and project .openovel/agents/*.jsonc definitions", async () => {
  const cwd = await mkProject("openovel-agents-")
  await writeFile(
    path.join(cwd, ".openovel", "agents", "factcheck.jsonc"),
    `{
      // Custom general-purpose specialist.
      "name": "factcheck",
      "description": "Check claims against story files and external sources.",
      "modelProfile": "subagent-research",
      "tools": ["read", "grep", "websearch", "webfetch"],
      "disallowedTools": ["write", "edit"],
      "prompt": "Return a compact evidence table."
    }`,
    "utf8",
  )

  const agents = listStorySubagents({ cwd })
  const factcheck = agents.find((agent) => agent.name === "factcheck")
  const general = agents.find((agent) => agent.name === "general-purpose")
  assert.ok(general)
  assert.equal(general.modelProfile, "subagent")
  assert.deepEqual(general.tools, ["*"])
  assert.ok(agents.some((agent) => agent.name === "continuity"))
  assert.equal(factcheck.modelProfile, "subagent-research")
  assert.deepEqual(factcheck.tools, ["read", "grep", "websearch", "webfetch"])
  assert.deepEqual(factcheck.disallowedTools, ["write", "edit"])
})

test("task validates modelProfile against profile whitelist", async () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const task = registry.get("task")

  const invalid = await task.validate({
    description: "Check something",
    prompt: "Check something",
    subagent_type: "continuity",
    modelProfile: "claude-opus-raw-name",
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.message, /modelProfile must be one of/)

  const valid = await task.validate({
    description: "Check something",
    prompt: "Check something",
    subagent_type: "continuity",
    modelProfile: "subagent-research",
    tools: ["read", "grep", "*"],
    disallowedTools: ["write"],
  })
  assert.equal(valid, true)

  const omittedType = await task.validate({
    description: "Check something",
    prompt: "Check something",
    tools: ["*"],
  })
  assert.equal(omittedType, true)
})

async function mkProject(prefix) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix))
  await mkdir(path.join(cwd, ".openovel", "agents"), { recursive: true })
  return cwd
}
