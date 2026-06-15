import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SessionViewModel } from "../src/runtime/sessionViewModel.js"
import { suggestSlashCommands } from "../src/runtime/viewModel/slashCommands.js"

async function isolatedEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-vm-ob-"))
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ID: process.env.OPENOVEL_STORY_ID,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
    OPENOVEL_SKIP_ONBOARDING: process.env.OPENOVEL_SKIP_ONBOARDING,
    OPENOVEL_SKIP_STORY_SELECTOR: process.env.OPENOVEL_SKIP_STORY_SELECTOR,
    OPENOVEL_DISPLAY_PACING: process.env.OPENOVEL_DISPLAY_PACING,
  }
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_DISPLAY_PACING = "0"
  process.env.OPENOVEL_SKIP_STORY_SELECTOR = "1"
  delete process.env.OPENOVEL_STORY_ID
  delete process.env.OPENOVEL_STORY_ROOT
  delete process.env.OPENOVEL_SKIP_ONBOARDING
  return {
    home,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

test("VM enters onboarding when home is empty + finishes after language + api-key", async () => {
  const env = await isolatedEnv()
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    let s = vm.getState()
    // Flow: phase=language (step 0) → phase=api-key → done. Onboarding asks
    // only language now; the richer preference questions live in Settings.
    assert.equal(s.mode, "onboarding")
    assert.equal(s.onboarding.phase, "language")
    assert.equal(s.onboarding.step, 0)
    assert.ok(s.onboarding.currentQuestion)
    assert.match(s.onboarding.currentQuestion.prompt, /language|语言/i)
    // Only the language question is collected during onboarding.
    assert.equal(s.onboarding.questions.length, 1)

    // Step 1: answer the language question — switches to the api-key phase.
    vm.setInput("English")
    await vm.submit()
    s = vm.getState()
    assert.equal(s.mode, "onboarding")
    assert.equal(s.onboarding.phase, "api-key")
    assert.equal(s.onboarding.step, 0)
    assert.equal(s.onboarding.locale, "en")
    assert.equal(s.input, "")

    // Step 2 (final): advance past api-key — onboarding finishes immediately,
    // with no preference-question steps.
    await vm.advanceOnboardingFromApiKey()
    s = vm.getState()
    assert.equal(s.mode, "idle")
    assert.equal(s.onboarding, null)
    assert.equal(s.status, "ready")
    // Onboarding-time messages must NOT linger in the transcript above
    // the reader's first action.
    const lingering = s.entries.find((e) =>
      /Quick \d+-second calibration|Saved user preferences|first-run setup/i.test(e.text),
    )
    assert.equal(lingering, undefined, "no onboarding strings left in transcript")
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("VM /skip exits onboarding immediately", async () => {
  const env = await isolatedEnv()
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    assert.equal(vm.getState().mode, "onboarding")
    vm.setInput("/skip")
    await vm.submit()
    const s = vm.getState()
    assert.equal(s.mode, "idle")
    assert.equal(s.onboarding, null)
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("VM skips onboarding when OPENOVEL_SKIP_ONBOARDING is set", async () => {
  const env = await isolatedEnv()
  process.env.OPENOVEL_SKIP_ONBOARDING = "1"
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    assert.equal(vm.getState().mode, "idle")
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("suggestSlashCommands returns full catalog on '/' and filters on prefix", () => {
  const all = suggestSlashCommands("/")
  assert.ok(all.length >= 11)

  const newOnly = suggestSlashCommands("/new")
  assert.equal(newOnly.length, 1)
  assert.equal(newOnly[0].match, "/new-story")

  const empty = suggestSlashCommands("/nonexistent")
  assert.equal(empty.length, 0)

  // Empty when not a slash command
  assert.equal(suggestSlashCommands("foo").length, 0)
})
