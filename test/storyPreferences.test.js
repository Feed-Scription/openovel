import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getMemorySnapshot } from "../src/memory/memoryStore.js"
import { initializeStory, paths } from "../src/lib/storyStore.js"
import { writeText, readText } from "../src/lib/files.js"
import { SessionViewModel } from "../src/runtime/sessionViewModel.js"

const SAVE = ["OPENOVEL_HOME", "OPENOVEL_STORY_ID", "OPENOVEL_STORY_ROOT", "OPENOVEL_IGNORE_PROJECT_CONFIG", "OPENOVEL_SKIP_ONBOARDING", "OPENOVEL_SKIP_STORY_SELECTOR", "OPENOVEL_DISPLAY_PACING"]

async function withEnv(fn) {
  const saved = {}
  for (const k of SAVE) saved[k] = process.env[k]
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-prefs-home-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-prefs-story-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = root
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_SKIP_ONBOARDING = "1"
  process.env.OPENOVEL_SKIP_STORY_SELECTOR = "1"
  process.env.OPENOVEL_DISPLAY_PACING = "0"
  delete process.env.OPENOVEL_STORY_ID
  try {
    await fn({ home, root })
  } finally {
    for (const k of SAVE) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test("getMemorySnapshot.user falls back to global USER.md when no per-story prefs", async () => {
  await withEnv(async () => {
    await initializeStory()
    await writeText(paths.userMemory, "# User Memory\n\n- Default story language: English\n")
    const snap = await getMemorySnapshot()
    assert.match(snap.user, /Default story language: English/)
  })
})

test("getMemorySnapshot.user is OVERRIDDEN by story PREFERENCES.md when present", async () => {
  await withEnv(async () => {
    await initializeStory()
    await writeText(paths.userMemory, "# User Memory\n\n- Default story language: English\n")
    await writeText(paths.storyPreferences, "# User Memory\n\n- Default story language: 日本語\n")
    const snap = await getMemorySnapshot()
    assert.match(snap.user, /日本語/)
    assert.doesNotMatch(snap.user, /English/) // story prefs REPLACE, not merge
    assert.equal(snap.paths.storyPreferences, paths.storyPreferences)
  })
})

test("an empty per-story PREFERENCES.md falls back to global (no accidental blanking)", async () => {
  await withEnv(async () => {
    await initializeStory()
    await writeText(paths.userMemory, "# User Memory\n\n- Default story language: English\n")
    await writeText(paths.storyPreferences, "   \n  \n")
    const snap = await getMemorySnapshot()
    assert.match(snap.user, /English/)
  })
})

test("confirmStoryName writes story/memory/PREFERENCES.md when preferences are passed", async () => {
  await withEnv(async () => {
    const vm = new SessionViewModel({ env: process.env })
    const PREFS = "# User Memory\n\n- Default story language: 日本語\n- Style preferences:\n  - Tone: 庄重 — solemn\n"
    vm.setInput("偏好覆盖测试")
    await vm.confirmStoryName({ preferences: PREFS })
    // confirmStoryName switched the active story; paths now resolves to it.
    const written = await readText(paths.storyPreferences, "")
    assert.equal(written.trim(), PREFS.trim())
    await vm.shutdown()
  })
})

test("confirmStoryName with no preferences leaves PREFERENCES.md absent (tracks global)", async () => {
  await withEnv(async () => {
    const vm = new SessionViewModel({ env: process.env })
    vm.setInput("默认偏好测试")
    await vm.confirmStoryName()
    assert.equal(existsSync(paths.storyPreferences), false)
    await vm.shutdown()
  })
})
