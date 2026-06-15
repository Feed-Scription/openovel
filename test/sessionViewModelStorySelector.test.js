import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SessionViewModel, storySelectorVisibleStories } from "../src/runtime/sessionViewModel.js"
import { createStory } from "../src/lib/storyDirectory.js"

async function isolatedEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-vm-sel-"))
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ID: process.env.OPENOVEL_STORY_ID,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
    OPENOVEL_SKIP_ONBOARDING: process.env.OPENOVEL_SKIP_ONBOARDING,
    OPENOVEL_SKIP_STORY_SELECTOR: process.env.OPENOVEL_SKIP_STORY_SELECTOR,
  }
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_SKIP_ONBOARDING = "1"
  delete process.env.OPENOVEL_SKIP_STORY_SELECTOR
  delete process.env.OPENOVEL_STORY_ID
  delete process.env.OPENOVEL_STORY_ROOT
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

test("VM start() opens the story selector by default", async () => {
  const env = await isolatedEnv()
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    const state = vm.getState()
    assert.equal(state.mode, "story-selector")
    assert.ok(state.storySelector)
    assert.ok(state.storySelector.items.length >= 1)
    assert.equal(state.storySelector.items[0].isNew, true)
    assert.equal(state.storySelector.cursor, 0)
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("story selector hides project-local ./story by default even when it has canon", () => {
  const stories = [
    { id: "(project)", isProjectLocal: true, chapterBytes: 214 },
    { id: "s_alpha", isProjectLocal: false, displayName: "alpha", chapterBytes: 1024 },
  ]
  assert.deepEqual(
    storySelectorVisibleStories(stories, {}).map((story) => story.id),
    ["s_alpha"],
  )
  assert.deepEqual(
    storySelectorVisibleStories(stories, { OPENOVEL_SHOW_PROJECT_STORY: "1" }).map((story) => story.id),
    ["(project)", "s_alpha"],
  )
})

test("VM up/down arrows wrap around the story list", async () => {
  const env = await isolatedEnv()
  try {
    await createStory({ name: "story-a", env: process.env })
    await createStory({ name: "story-b", env: process.env })
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    const n = vm.getState().storySelector.items.length
    // VM now hides the bare project-local sentinel when it has no canon,
    // so the list is "(new)" + story-a + story-b = 3 items in this fixture.
    assert.ok(n >= 3)
    vm.moveStorySelector(1)
    assert.equal(vm.getState().storySelector.cursor, 1)
    vm.moveStorySelector(-1)
    assert.equal(vm.getState().storySelector.cursor, 0)
    vm.moveStorySelector(-1) // wraps to end
    assert.equal(vm.getState().storySelector.cursor, n - 1)
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("VM picking '+ New story' enters naming mode, then drops into init-chat", async () => {
  const env = await isolatedEnv()
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    // Cursor starts on "(new)"
    await vm.submit()
    assert.equal(vm.getState().mode, "story-naming")
    vm.appendInput("alpha-1")
    await vm.submit()
    const state = vm.getState()
    // Naming used to drop into composing-worldbook; the conversational
    // init flow replaced that — the user now lands in init-chat.
    assert.equal(state.mode, "init-chat")
    // The user-visible name lives in storyName / currentStory.displayName.
    // currentStory.id is now a random token (not derived from the name).
    assert.equal(state.initChat.storyName, "alpha-1")
    assert.equal(state.currentStory.displayName, "alpha-1")
    assert.match(state.currentStory.id, /^s_[0-9a-f]{8}$/)
    // A greeting message is seeded so the chat isn't empty.
    assert.ok(state.initChat.messages.length >= 1)
    assert.equal(state.initChat.messages[0].role, "system")
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("VM picking an existing story switches without compose", async () => {
  const env = await isolatedEnv()
  try {
    const created = await createStory({ name: "echo-9", env: process.env })
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    // Move cursor to echo-9 (find its index — match on displayName, since
    // the id is now a random token).
    const items = vm.getState().storySelector.items
    const idx = items.findIndex((i) => i.displayName === "echo-9")
    assert.ok(idx > 0)
    for (let i = 0; i < idx; i++) vm.moveStorySelector(1)
    assert.equal(vm.getState().storySelector.cursor, idx)
    await vm.submit()
    const state = vm.getState()
    assert.equal(state.mode, "idle")
    assert.equal(state.currentStory.id, created.id)
    assert.equal(state.currentStory.displayName, "echo-9")
    assert.equal(state.storySelector, null)
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("VM cancelStoryNaming goes back to the selector", async () => {
  const env = await isolatedEnv()
  try {
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    await vm.submit() // pick "+ New story"
    assert.equal(vm.getState().mode, "story-naming")
    vm.appendInput("draft-name")
    await vm.cancelStoryNaming()
    const state = vm.getState()
    assert.equal(state.mode, "story-selector")
    assert.equal(state.storyNaming, null)
    assert.equal(state.input, "")
    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("library search filters story cards; sort reorders them", async () => {
  const env = await isolatedEnv()
  try {
    await createStory({ name: "Zeta tale", env: process.env })
    await createStory({ name: "Alpha tale", env: process.env })
    await createStory({ name: "Beta saga", env: process.env })
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    const names = () => vm.getState().storySelector.items.slice(2).map((i) => i.displayName)

    let sel = vm.getState().storySelector
    // New + Import always lead the list.
    assert.equal(sel.items[0].isNew, true)
    assert.equal(sel.items[1].isImport, true)
    assert.equal(names().length, 3)

    // Sort by name → alphabetical order of the story cards.
    vm.setStorySort("name")
    assert.equal(vm.getState().storySelector.sortBy, "name")
    assert.deepEqual(names(), ["Alpha tale", "Beta saga", "Zeta tale"])

    // Search filters the cards by name; New/Import still lead.
    vm.setStorySearch("tale")
    sel = vm.getState().storySelector
    assert.equal(sel.query, "tale")
    assert.equal(sel.items[0].isNew, true)
    assert.deepEqual(names(), ["Alpha tale", "Zeta tale"])
    assert.ok(sel.cursor <= sel.items.length - 1)

    // Clearing the search restores all cards (still name-sorted).
    vm.setStorySearch("")
    assert.deepEqual(names(), ["Alpha tale", "Beta saga", "Zeta tale"])

    await vm.shutdown()
  } finally {
    env.restore()
  }
})

test("fast mode: selector gate follows the env flag; setStoryMode('fast') needs no image provider", async () => {
  const env = await isolatedEnv()
  const savedFast = process.env.OPENOVEL_ENABLE_FAST_MODE
  try {
    process.env.OPENOVEL_ENABLE_FAST_MODE = "1"
    const vm = new SessionViewModel({ env: process.env })
    await vm.start()
    let sel = vm.getState().storySelector
    assert.equal(sel.fastModeAvailable, true)

    const a = await createStory({ name: "fast tale", env: process.env })
    // Fast is pure prose: succeeds with NO image provider configured...
    const fast = await vm.setStoryMode(a.id, "fast")
    assert.equal(fast.ok, true)
    assert.equal(fast.mode, "fast")
    // ...where comic refuses without one.
    const comic = await vm.setStoryMode(a.id, "comic")
    assert.equal(comic.ok, false)
    assert.equal(comic.error, "needs-image-provider")

    // Gate off → the menu affordance disappears on the next selector entry.
    delete process.env.OPENOVEL_ENABLE_FAST_MODE
    await vm.setStoryMode(a.id, "")
    sel = vm.getState().storySelector
    assert.equal(sel.fastModeAvailable, false)

    await vm.shutdown()
  } finally {
    if (savedFast === undefined) delete process.env.OPENOVEL_ENABLE_FAST_MODE
    else process.env.OPENOVEL_ENABLE_FAST_MODE = savedFast
    env.restore()
  }
})
