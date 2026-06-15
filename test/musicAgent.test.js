import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

import { musicAgentContract } from "../src/prompts/agentContracts.js"
import { resolvePromptFn } from "../src/workflows/residents/buildResidentAgent.js"
import { loadAgentConfigs } from "../src/agents/loadAgentConfigs.js"

test("musicAgentContract states the load-bearing directives", () => {
  const c = musicAgentContract()
  assert.equal(typeof c, "string")
  // the short-id contract
  assert.match(c, /SHORT ID/)
  assert.match(c, /never sees the trackId/i)
  // illustrate the FUTURE, never the past
  assert.match(c, /FUTURE/)
  assert.match(c, /never the past/i)
  // discovery via the agent-only tool
  assert.match(c, /music_search/)
  // catalog + dedupe + no overwrite
  assert.match(c, /CATALOG\.json/)
  assert.match(c, /DEDUPE/)
  assert.match(c, /NEVER overwrite/i)
  // routes guidance through the Showrunner, never writes the frontend itself
  assert.match(c, /forShowrunner/)
  // the cue fence protocol + its verbs
  assert.match(c, /ovl:music/)
  assert.match(c, /\bbgm\b/)
  assert.match(c, /\bstop\b/)
  // hard no-url / no-download
  assert.match(c, /never (emit or store a URL|download audio)/i)
})

test("resolvePromptFn resolves the music agent's named prompt", () => {
  const fn = resolvePromptFn({ id: "music", prompt: "musicAgentContract" })
  assert.equal(typeof fn, "function")
  assert.match(fn(), /You are the Music agent/)
})

test("loadAgentConfigs includes the music agent only when music-gen is enabled", async () => {
  const root = path.join(os.tmpdir(), `musiccfg-${Date.now()}`)
  const on = await loadAgentConfigs({ root, formatEnabled: false, imageEnabled: false, musicEnabled: true })
  const music = on.find((c) => c.id === "music")
  assert.ok(music, "music agent present when enabled")
  assert.equal(music.domainDir, path.join(root, "music"))
  assert.deepEqual(music.writeScope, ["story/music/**"])
  assert.ok(music.includeTools.includes("music_search"), "music agent has the music_search tool")

  const off = await loadAgentConfigs({ root, formatEnabled: false, imageEnabled: false, musicEnabled: false })
  assert.ok(!off.some((c) => c.id === "music"), "music agent absent when disabled")
})
