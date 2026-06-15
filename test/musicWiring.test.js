import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { isMusicGenEnabled, isFormatContractEnabled, isStoryIncludesEnabled, isImageGenEnabled } from "../src/lib/formatContract.js"
import { loadSettings } from "../src/config/settings.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"
import { registerDefaultTools } from "../src/tools/registerTools.js"

// ── flag gating: music is INDEPENDENT of format-contract + includes ───────────
test("isMusicGenEnabled gates on OPENOVEL_ENABLE_MUSIC_GEN and stands alone", () => {
  const on = { OPENOVEL_ENABLE_MUSIC_GEN: "true" }
  assert.equal(isMusicGenEnabled(on), true)
  // the ovl:music fence is a narration control channel — it forces neither the
  // format contract nor story-includes on
  assert.equal(isFormatContractEnabled(on), false, "music-gen must NOT force the format contract on")
  assert.equal(isStoryIncludesEnabled(on), false, "music streams — never a file include")
  assert.equal(isImageGenEnabled(on), false, "music-gen is independent of image-gen")
  // off
  assert.equal(isMusicGenEnabled({}), false)
})

// ── settings round-trip ───────────────────────────────────────────────────────
test("settings round-trips tools.musicGen <-> OPENOVEL_ENABLE_MUSIC_GEN", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-music-settings-"))
  const baseEnv = { OPENOVEL_HOME: home, OPENOVEL_IGNORE_PROJECT_CONFIG: "1" }
  const on = loadSettings({ cwd: home, env: { ...baseEnv, OPENOVEL_ENABLE_MUSIC_GEN: "true" } })
  assert.equal(on.settings.tools.musicGen, true)
  assert.equal(on.env.OPENOVEL_ENABLE_MUSIC_GEN, "true")
  const off = loadSettings({ cwd: home, env: baseEnv })
  assert.equal(off.settings.tools.musicGen, false)
  assert.equal(off.env.OPENOVEL_ENABLE_MUSIC_GEN, "false")
})

// ── music_search tool: agent-only, no URL ever reaches the model ──────────────
test("music_search is agent-only and returns URL-free track metadata", async () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("music_search")
  assert.ok(tool, "music_search is registered")
  assert.equal(tool.exposeToModel, false, "agent-only — not in the default model toolset")
  assert.equal(tool.readOnly, true)

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    jsonRes(
      url.includes("/song/url")
        ? { data: [{ url: "https://stream/1.mp3" }] }
        : { result: { songs: [{ id: 1, name: "Rainfall", ar: [{ name: "A" }], al: { name: "Al", picUrl: "https://cover/1.jpg" }, dt: 180000 }] } },
    )
  try {
    const res = await tool.execute({ query: "rain", limit: 3 }, { env: { OPENOVEL_MUSIC_BASE_URL: "http://localhost:3000", OPENOVEL_MUSIC_CLIENT_ID: "cid" } })
    const parsed = JSON.parse(res.output)
    assert.equal(parsed.provider, "netease")
    assert.equal(parsed.results[0].trackId, "1")
    assert.equal(parsed.results[0].title, "Rainfall")
    assert.equal(parsed.results[0].durationMs, 180000)
    // cover art URL is stripped — the model gets metadata, never a URL
    assert.equal("cover" in parsed.results[0], false)
    assert.equal(/https?:\/\//.test(res.output), false, "no URL of any kind reaches the model")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("music_search surfaces an unconfigured provider as an error", async () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("music_search")
  await assert.rejects(() => tool.execute({ query: "x" }, { env: {} }), /not configured/i)
})

function jsonRes(obj) {
  return { ok: true, status: 200, text: async () => JSON.stringify(obj) }
}
