import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { applyStorykeeperPatch, initializeStory, paths } from "../src/lib/storyStore.js"
import { readText } from "../src/lib/files.js"

process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-switchguard-home-${Date.now()}`)
process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-switchguard-story-${Date.now()}`)
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"

const POLLUTION = "# Foreground Guidance\n\n## Scene\n\nCONTENT FROM A DIFFERENT STORY — must not be written.\n"

test("applyStorykeeperPatch discards writes when the active story changed mid-run", async () => {
  await initializeStory()
  const beforeFg = await readText(paths.foregroundGuidance, "")
  const beforeScene = await readText(path.join(paths.foregroundDir, "10-scene.md"), "")

  const res = await applyStorykeeperPatch(
    { turnId: "t-other", foregroundGuidanceMarkdown: POLLUTION },
    { expectedStoryRoot: "/definitely/not/this/story" },
  )

  assert.equal(res.skipped, true)
  assert.equal(res.reason, "story_switched_mid_run")
  // Nothing was written — the foreground files are byte-for-byte unchanged.
  assert.equal(await readText(paths.foregroundGuidance, ""), beforeFg)
  assert.equal(await readText(path.join(paths.foregroundDir, "10-scene.md"), ""), beforeScene)
})

test("applyStorykeeperPatch does NOT trip the guard when the root matches", async () => {
  await initializeStory()
  const res = await applyStorykeeperPatch(
    { turnId: "t-mine", foregroundGuidanceMarkdown: "# Foreground Guidance\n\n## Scene\n\nA quiet room at dusk.\n" },
    { expectedStoryRoot: paths.root },
  )
  assert.notEqual(res.reason, "story_switched_mid_run")
  assert.notEqual(res.skipped, true)
})

test("no expectedStoryRoot → guard is inert (init/onboarding callers unaffected)", async () => {
  await initializeStory()
  const res = await applyStorykeeperPatch({ turnId: "t-noguard", foregroundGuidanceMarkdown: "# Foreground Guidance\n\n## Scene\n\nDawn.\n" })
  assert.notEqual(res.reason, "story_switched_mid_run")
})
