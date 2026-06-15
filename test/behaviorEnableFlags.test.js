import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"

// Isolate the settings.local.json the behavior store reads/writes.
process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-behav-${Date.now()}`)
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"

const { setBehavior, hydrateBehaviorEnvFromSettings } = await import("../src/electron/behaviorStore.js")
const { isFormatContractEnabled, isStoryIncludesEnabled } = await import("../src/lib/formatContract.js")

// Regression: the Settings → Behavior toggle writes "1"/"0", but the enable
// check used a strict `=== "true"`, so rich rendering read as OFF with the box
// ticked. The deep-init pre-generation gate (isFormatContractEnabled(env)) then
// never fired. The check must accept the same truthy family as the toggle writer.
test("toggle ON (writes '1') reads as enabled — not strict ===\"true\"", async () => {
  delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  assert.equal(isFormatContractEnabled(process.env), false)

  await setBehavior({ formatContract: true })
  assert.equal(process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT, "1")
  assert.equal(isFormatContractEnabled(process.env), true)
})

// Regression: settings.local.json under $OPENOVEL_HOME is NOT a config layer
// loadSettings()/settingsEnv() read, and nothing seeded process.env from it on
// boot — so every Behavior toggle reverted to default after a restart. The boot
// hydrate must re-apply the saved toggles to process.env.
test("toggles survive a restart via hydrateBehaviorEnvFromSettings", async () => {
  await setBehavior({ formatContract: true, storyIncludes: true })
  // Simulate a fresh launch: process.env wiped, only the file remains.
  delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  delete process.env.OPENOVEL_ENABLE_STORY_INCLUDES
  assert.equal(isFormatContractEnabled(process.env), false)

  await hydrateBehaviorEnvFromSettings()
  assert.equal(isFormatContractEnabled(process.env), true)
  assert.equal(isStoryIncludesEnabled(process.env), true)
})

test("toggle OFF persists as disabled across a restart", async () => {
  await setBehavior({ formatContract: false })
  delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  await hydrateBehaviorEnvFromSettings()
  assert.equal(isFormatContractEnabled(process.env), false)
})

test("lenient parse accepts the whole truthy family", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(isFormatContractEnabled({ OPENOVEL_ENABLE_FORMAT_CONTRACT: v }), true, `expected ${v} → true`)
  }
  for (const v of ["0", "false", "no", "off", "", undefined]) {
    assert.equal(isFormatContractEnabled({ OPENOVEL_ENABLE_FORMAT_CONTRACT: v }), false, `expected ${v} → false`)
  }
})
