import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { addMemoryEntry, applyMemoryPatch, getMemorySnapshot, memoryProviderRegistry, registerMemoryProvider, removeMemoryEntry } from "../src/memory/memoryStore.js"

process.env.OPENOVEL_HOME ||= path.join(os.tmpdir(), `openovel-memory-${Date.now()}`)
process.env.OPENOVEL_STORY_ROOT ||= path.join(os.tmpdir(), `openovel-memory-story-${Date.now()}`)

test("memory store persists compact durable entries and rejects duplicates", async () => {
  const marker = `test memory ${Date.now()}`
  const first = await addMemoryEntry("memory", marker)
  const second = await addMemoryEntry("memory", marker)
  const snapshot = await getMemorySnapshot()

  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.match(snapshot.memory, new RegExp(marker))
  assert.match(snapshot.memory, /topics\//)
  assert.match(snapshot.memory, /openovel-memory-index:v1/)
  assert.ok(first.topicFile.includes("story/memory/topics/"))

  const topicFile = path.join(snapshot.paths.storyMemoryTopics, `${first.topicFile.split("/").at(-1)}`)
  const topicText = await readFile(topicFile, "utf8")
  assert.match(topicText, /openovel-memory-topic:v1/)
  assert.match(topicText, new RegExp(marker))

  const removed = await removeMemoryEntry("memory", marker)
  assert.equal(removed.ok, true)
})

test("memory provider registry exposes the default file-native provider", () => {
  const info = memoryProviderRegistry.diagnose()
  assert.equal(info.defaultProvider, "file-markdown")
  assert.equal(info.active.id, "file-markdown")
  assert.equal(info.active.storage, "markdown")
  assert.equal(info.active.topics, true)
  assert.ok(info.active.scopes.includes("story"))
})

test("memory store can route through a custom provider interface", async () => {
  const id = `test-memory-provider-${Date.now()}`
  const calls = []
  registerMemoryProvider({
    id,
    name: "Test memory provider",
    kind: "test",
    storage: "memory",
    scopes: ["user"],
    snapshot: async () => ({
      memory: "# Story Memory\n\n",
      story: "# Story Memory\n\n",
      user: "# User Memory\n\n- custom provider snapshot\n",
      references: "# Shared References\n\n",
      paths: {},
    }),
    add: async (input) => {
      calls.push(["add", input])
      return { ok: true, target: input.target, changed: true, provider: id }
    },
    replace: async (input) => {
      calls.push(["replace", input])
      return { ok: true, target: input.target, changed: true, provider: id }
    },
    remove: async (input) => {
      calls.push(["remove", input])
      return { ok: true, target: input.target, changed: true, provider: id }
    },
  })

  const snapshot = await getMemorySnapshot({ provider: id })
  const added = await addMemoryEntry("user", "custom preference", { provider: id })

  assert.match(snapshot.user, /custom provider snapshot/)
  assert.equal(added.provider, id)
  assert.deepEqual(calls[0], ["add", { target: "user", content: "custom preference" }])
})

test("memory store separates global user and shared reference entries", async () => {
  const userMarker = `prefers lean historical prose ${Date.now()}`
  const referenceMarker = `Huaihai Campaign source shelf ${Date.now()}`
  await addMemoryEntry("user", userMarker)
  await addMemoryEntry("references", referenceMarker)
  const snapshot = await getMemorySnapshot()

  try {
    assert.match(snapshot.user, new RegExp(userMarker))
    assert.match(snapshot.references, new RegExp(referenceMarker))
    assert.doesNotMatch(snapshot.memory, new RegExp(userMarker))
    assert.ok(snapshot.paths.userMemoryTopics.endsWith("memory/topics"))
    assert.ok(snapshot.paths.sharedReferenceTopics.endsWith("references/topics"))
  } finally {
    await removeMemoryEntry("user", userMarker)
    await removeMemoryEntry("references", referenceMarker)
  }
})

test("cross-story memory can be disabled without hiding it from explicit UI inspection", async () => {
  const previous = process.env.OPENOVEL_CROSS_STORY_MEMORY
  const observedMarker = `observed cross-story note ${Date.now()}`
  const blockedMarker = `blocked cross-story note ${Date.now()}`
  const storyMarker = `story-local memory still writes ${Date.now()}`

  try {
    process.env.OPENOVEL_CROSS_STORY_MEMORY = "1"
    await addMemoryEntry("observed", observedMarker)

    process.env.OPENOVEL_CROSS_STORY_MEMORY = "0"
    const blocked = await addMemoryEntry("observed", blockedMarker)
    const applied = await applyMemoryPatch({
      memory: [storyMarker],
      observed: [blockedMarker],
      references: [blockedMarker],
    })
    const hidden = await getMemorySnapshot()
    const inspectable = await getMemorySnapshot({ includeDisabledCrossStory: true })

    assert.equal(blocked.changed, false)
    assert.equal(blocked.reason, "cross_story_memory_disabled")
    assert.equal(hidden.crossStoryMemoryEnabled, false)
    assert.doesNotMatch(hidden.observed, new RegExp(observedMarker))
    assert.doesNotMatch(hidden.references, new RegExp(blockedMarker))
    assert.match(hidden.memory, new RegExp(storyMarker))
    assert.match(inspectable.observed, new RegExp(observedMarker))
    assert.doesNotMatch(inspectable.observed, new RegExp(blockedMarker))
    assert.ok(applied.results.some((result) => result.target === "memory" && result.changed))
    assert.ok(!applied.results.some((result) => result.target === "observed" || result.target === "references"))
  } finally {
    if (previous === undefined) delete process.env.OPENOVEL_CROSS_STORY_MEMORY
    else process.env.OPENOVEL_CROSS_STORY_MEMORY = previous
  }
})

test("memory indexes can migrate flat bullets into topic files", async () => {
  const root = path.join(os.tmpdir(), `openovel-memory-index-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  const { initializeStory, paths } = await import("../src/lib/storyStore.js")
  await initializeStory()

  const oldEntry = `flat bullet migrated ${Date.now()}`
  await writeFile(paths.memoryIndex, `# Story Memory\n\n- ${oldEntry}\n`, "utf8")
  const added = await addMemoryEntry("memory", `new indexed entry ${Date.now()}`)
  const snapshot = await getMemorySnapshot()

  assert.equal(added.ok, true)
  assert.match(snapshot.memory, /flat bullet migrated/)
  assert.match(snapshot.memory, /new indexed entry/)
  // Topic-file companions are still written; check one exists on disk.
  const { readdir } = await import("node:fs/promises")
  const topics = await readdir(path.dirname(paths.memoryIndex) + "/topics").catch(() => [])
  assert.ok(topics.some((f) => f.endsWith(".md")), "expected at least one topics/*.md companion file")
})

test("story memory is bounded by a configurable entry cap", async () => {
  const previous = process.env.OPENOVEL_MEMORY_STORY_MAX_ENTRIES
  process.env.OPENOVEL_MEMORY_STORY_MAX_ENTRIES = "3"
  const base = `bounded memory ${Date.now()}`

  try {
    for (let index = 0; index < 5; index++) {
      await addMemoryEntry("memory", `${base} ${index}`)
    }
    const snapshot = await getMemorySnapshot()
    assert.doesNotMatch(snapshot.memory, new RegExp(`${base} 0`))
    assert.doesNotMatch(snapshot.memory, new RegExp(`${base} 1`))
    assert.match(snapshot.memory, new RegExp(`${base} 2`))
    assert.match(snapshot.memory, new RegExp(`${base} 4`))
  } finally {
    if (previous === undefined) delete process.env.OPENOVEL_MEMORY_STORY_MAX_ENTRIES
    else process.env.OPENOVEL_MEMORY_STORY_MAX_ENTRIES = previous
  }
})
