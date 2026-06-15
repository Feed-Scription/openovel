import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createStory,
  currentStoryDescriptor,
  currentStoryMode,
  listStories,
  PROJECT_LOCAL_ID,
  resolveActiveStoryMode,
  setStoryMode,
  slugifyStoryName,
  switchActiveStory,
} from "../src/lib/storyDirectory.js"

test("story modes: setStoryMode accepts comic/fast, modes replace each other, unknown clears", async () => {
  const ctx = await isolatedEnv()
  const savedFast = process.env.OPENOVEL_ENABLE_FAST_MODE
  const savedComic = process.env.OPENOVEL_ENABLE_COMIC_MODE
  try {
    const a = await createStory({ name: "mode-story", env: ctx.env, cwd: ctx.cwd })

    assert.equal((await setStoryMode({ id: a.id, mode: "fast", env: ctx.env, cwd: ctx.cwd })).mode, "fast")
    let stories = await listStories({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(stories.find((s) => s.id === a.id).mode, "fast")

    // The single meta field makes the modes mutually exclusive.
    assert.equal((await setStoryMode({ id: a.id, mode: "comic", env: ctx.env, cwd: ctx.cwd })).mode, "comic")
    stories = await listStories({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(stories.find((s) => s.id === a.id).mode, "comic")

    // Unknown / empty clears back to default prose.
    assert.equal((await setStoryMode({ id: a.id, mode: "warp", env: ctx.env, cwd: ctx.cwd })).mode, "")
    stories = await listStories({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(stories.find((s) => s.id === a.id).mode, "")

    // Active-story resolution: currentStoryMode reads the meta; the resolver
    // additionally requires the global gate.
    await setStoryMode({ id: a.id, mode: "fast", env: ctx.env, cwd: ctx.cwd })
    switchActiveStory({ id: a.id, env: ctx.env })
    assert.equal(await currentStoryMode({ env: ctx.env, cwd: ctx.cwd }), "fast")
    delete process.env.OPENOVEL_ENABLE_FAST_MODE
    assert.equal(await resolveActiveStoryMode({ env: ctx.env, cwd: ctx.cwd }), "")
    process.env.OPENOVEL_ENABLE_FAST_MODE = "1"
    assert.equal(await resolveActiveStoryMode({ env: ctx.env, cwd: ctx.cwd }), "fast")
    // The fast gate does not unlock comic (and vice versa).
    await setStoryMode({ id: a.id, mode: "comic", env: ctx.env, cwd: ctx.cwd })
    delete process.env.OPENOVEL_ENABLE_COMIC_MODE
    assert.equal(await resolveActiveStoryMode({ env: ctx.env, cwd: ctx.cwd }), "")
    process.env.OPENOVEL_ENABLE_COMIC_MODE = "1"
    assert.equal(await resolveActiveStoryMode({ env: ctx.env, cwd: ctx.cwd }), "comic")
  } finally {
    if (savedFast === undefined) delete process.env.OPENOVEL_ENABLE_FAST_MODE
    else process.env.OPENOVEL_ENABLE_FAST_MODE = savedFast
    if (savedComic === undefined) delete process.env.OPENOVEL_ENABLE_COMIC_MODE
    else process.env.OPENOVEL_ENABLE_COMIC_MODE = savedComic
    ctx.restore()
  }
})

test("slugifyStoryName (legacy fallback) keeps CJK + spaces", () => {
  // Random-id story creation no longer goes through slugifyStoryName;
  // it's kept only as a back-compat fallback when reading legacy story
  // directories. Its job now is to ensure path safety, not Latin-ify.
  assert.equal(slugifyStoryName("My Story Foo"), "My Story Foo")
  assert.equal(slugifyStoryName("中文标题"), "中文标题")
  assert.equal(slugifyStoryName("path/sep:colon"), "pathsepcolon")
  assert.equal(slugifyStoryName("a".repeat(120)).length, 80)
})

test("listStories surfaces project-local + any stored stories with current marked active", async () => {
  const ctx = await isolatedEnv()
  try {
    let stories = await listStories({ env: ctx.env, cwd: ctx.cwd })
    assert.ok(stories.length >= 1)
    const project = stories.find((s) => s.id === PROJECT_LOCAL_ID)
    assert.ok(project, "project-local entry always present")
    assert.equal(project.active, true)

    const a = await createStory({ name: "alpha", env: ctx.env, cwd: ctx.cwd })
    const b = await createStory({ name: "beta", env: ctx.env, cwd: ctx.cwd })

    stories = await listStories({ env: ctx.env, cwd: ctx.cwd })
    const names = stories.map((s) => s.displayName)
    assert.ok(names.includes("alpha"))
    assert.ok(names.includes("beta"))
    // Random ids are opaque tokens, not the user-typed name.
    assert.notEqual(a.id, "alpha")
    assert.notEqual(b.id, "beta")
    assert.match(a.id, /^s_[0-9a-f]{8}$/)
    assert.equal(stories.find((s) => s.active).id, PROJECT_LOCAL_ID)
  } finally {
    ctx.restore()
  }
})

test("createStory generates a random id and stores the display name in meta.json", async () => {
  const ctx = await isolatedEnv()
  try {
    const first = await createStory({ name: "echo", env: ctx.env, cwd: ctx.cwd })
    assert.match(first.id, /^s_[0-9a-f]{8}$/)
    assert.equal(first.displayName, "echo")
    assert.equal(first.created, true)
    assert.ok(existsSync(first.root))

    // Same display name → new random id, NOT a collision; no idempotency
    // promise — the user can have multiple "echo" stories in their library.
    const second = await createStory({ name: "echo", env: ctx.env, cwd: ctx.cwd })
    assert.notEqual(first.id, second.id)
    assert.equal(second.displayName, "echo")
  } finally {
    ctx.restore()
  }
})

test("createStory accepts colons, CJK, and spaces in the display name", async () => {
  const ctx = await isolatedEnv()
  try {
    const r = await createStory({ name: "武林外传：第81回", env: ctx.env, cwd: ctx.cwd })
    assert.equal(r.displayName, "武林外传：第81回")
    assert.match(r.id, /^s_[0-9a-f]{8}$/)
  } finally {
    ctx.restore()
  }
})

test("switchActiveStory mutates env so subsequent lookups resolve to the new story", async () => {
  const ctx = await isolatedEnv()
  try {
    let descriptor = currentStoryDescriptor({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(descriptor.id, PROJECT_LOCAL_ID)

    const created = await createStory({ name: "delta", env: ctx.env, cwd: ctx.cwd })
    switchActiveStory({ id: created.id, env: ctx.env })
    descriptor = currentStoryDescriptor({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(descriptor.id, created.id)
    assert.equal(descriptor.isProjectLocal, false)

    switchActiveStory({ id: PROJECT_LOCAL_ID, env: ctx.env })
    descriptor = currentStoryDescriptor({ env: ctx.env, cwd: ctx.cwd })
    assert.equal(descriptor.id, PROJECT_LOCAL_ID)
    assert.equal(descriptor.isProjectLocal, true)
  } finally {
    ctx.restore()
  }
})

async function isolatedEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-stories-home-"))
  const cwd = await mkdtemp(path.join(os.tmpdir(), "openovel-stories-cwd-"))
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ID: process.env.OPENOVEL_STORY_ID,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
  }
  process.env.OPENOVEL_HOME = home
  delete process.env.OPENOVEL_STORY_ID
  delete process.env.OPENOVEL_STORY_ROOT
  return {
    cwd,
    env: process.env,
    home,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}
