import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { SessionViewModel } from "../src/runtime/sessionViewModel.js"
import { backgroundJobs } from "../src/runtime/backgroundJob.js"
import { sessionProcessor } from "../src/runtime/sessionProcessor.js"
import { cloneVmState } from "../src/runtime/viewModel/state.js"

const SAVE_KEYS = [
  "OPENOVEL_HOME", "OPENOVEL_STORY_ID", "OPENOVEL_STORY_ROOT",
  "OPENOVEL_IGNORE_PROJECT_CONFIG", "OPENOVEL_SKIP_ONBOARDING",
  "OPENOVEL_DISPLAY_PACING", "OPENOVEL_OPTIONS_ENABLED",
  "OPENOVEL_ENABLE_FORMAT_CONTRACT",
]

async function setupEnv({ flag }) {
  const saved = {}
  for (const k of SAVE_KEYS) saved[k] = process.env[k]
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-fdp-home-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-fdp-story-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = root
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_SKIP_ONBOARDING = "1"
  process.env.OPENOVEL_DISPLAY_PACING = "0"
  if (flag) process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  else delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  return {
    root,
    restore() {
      for (const k of SAVE_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    },
  }
}

async function writeContract(root) {
  await mkdir(path.join(root, "format", "blocks"), { recursive: true })
  await writeFile(path.join(root, "format", "config.json"), JSON.stringify({ version: 1, css: ["story/format/blocks.css"] }))
  await writeFile(path.join(root, "format", "blocks", "terminal.html"), '<div class="screen"><pre>{{body}}</pre></div>')
  await writeFile(path.join(root, "format", "blocks.css"), ".ovl-terminal { color: #0f0; position: fixed }")
}

test("initialState.formatContract defaults to null", async () => {
  const env = await setupEnv({ flag: false })
  try {
    const vm = new SessionViewModel({ env: process.env })
    assert.equal(vm.getState().formatContract, null)
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("cloneVmState isolates the formatContract reference and preserves it", () => {
  const fc = Object.freeze({ enabled: true, version: 1, blocks: [], css: ".ovl-rich .x{color:red}" })
  const cloned = cloneVmState({
    entries: [], options: [], jobs: [], activeTools: [], storyTree: [], activity: [],
    pacing: {}, aggregate: {}, formatContract: fc,
  })
  assert.notEqual(cloned.formatContract, fc, "should be a fresh object reference")
  assert.equal(cloned.formatContract.enabled, true)
  assert.equal(cloned.formatContract.css, ".ovl-rich .x{color:red}")
})

test("flag ON: VM hydrate loads + sanitizes the contract into state", async () => {
  const env = await setupEnv({ flag: true })
  try {
    await writeContract(env.root)
    const vm = new SessionViewModel({ env: process.env })
    await vm.start({ runOnboarding: false, skipStorySelector: true })
    const fc = vm.getState().formatContract
    assert.ok(fc, "formatContract should be populated")
    assert.equal(fc.enabled, true)
    assert.equal(fc.blocks.length, 1)
    assert.equal(fc.blocks[0].kind, "terminal")
    assert.match(fc.css, /\.ovl-rich \.ovl-terminal/)
    assert.doesNotMatch(fc.css, /position/) // sanitized
    await vm.shutdown()
  } finally {
    backgroundJobs.reset()
    sessionProcessor.reset()
    env.restore()
  }
})

test("flag OFF: contract on disk is ignored (state stays null)", async () => {
  const env = await setupEnv({ flag: false })
  try {
    await writeContract(env.root)
    const vm = new SessionViewModel({ env: process.env })
    await vm.start({ runOnboarding: false, skipStorySelector: true })
    assert.equal(vm.getState().formatContract, null)
    await vm.shutdown()
  } finally {
    backgroundJobs.reset()
    sessionProcessor.reset()
    env.restore()
  }
})
