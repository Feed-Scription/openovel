import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import { acquireStorykeeperLease } from "../src/runtime/storykeeperLease.js"

test("Storykeeper lease blocks concurrent owners and releases normally", async () => {
  const env = await isolatedEnv("openovel-lock-basic-")
  try {
    await initializeStory()
    const first = await acquireStorykeeperLease({ owner: "first", heartbeatMs: 1000 })
    assert.equal(first.acquired, true)
    const second = await acquireStorykeeperLease({ owner: "second", heartbeatMs: 1000 })
    assert.equal(second.acquired, false)
    assert.equal(second.reason, "locked")
    await first.release()
    const third = await acquireStorykeeperLease({ owner: "third", heartbeatMs: 1000 })
    assert.equal(third.acquired, true)
    await third.release()
  } finally {
    env.restore()
  }
})

test("Storykeeper lease can take over stale or corrupt locks", async () => {
  const env = await isolatedEnv("openovel-lock-stale-")
  try {
    await initializeStory()
    const old = new Date(Date.now() - 10_000).toISOString()
    await writeFile(
      paths.storykeeperLock,
      `${JSON.stringify({ lockId: "old", owner: "old", pid: process.pid, startedAt: old, heartbeatAt: old, storyRoot: paths.root, status: "active" })}\n`,
      "utf8",
    )
    const takeover = await acquireStorykeeperLease({ owner: "new", ttlMs: 10, heartbeatMs: 1000 })
    assert.equal(takeover.acquired, true)
    assert.notEqual(takeover.lockId, "old")
    await takeover.release()

    await writeFile(paths.storykeeperLock, "{not json", "utf8")
    // Backdate the corrupt lock's mtime so the takeover is deterministic. The
    // corrupt branch judges staleness by file mtime vs now(); a just-written
    // file can land in the same millisecond — age 0, or even slightly negative
    // since mtimeMs is a float and Date.now() is integer — reading as
    // "corrupt-fresh" and flaking the takeover (~40% of runs). A corrupt lock
    // worth taking over is an old one, so model that.
    const staleMtime = new Date(Date.now() - 10_000)
    await utimes(paths.storykeeperLock, staleMtime, staleMtime)
    const corrupt = await acquireStorykeeperLease({ owner: "corrupt-new", ttlMs: 10, heartbeatMs: 1000 })
    assert.equal(corrupt.acquired, true)
    await corrupt.release()
  } finally {
    env.restore()
  }
})

test("Storykeeper lease release only deletes the owner's own lock", async () => {
  const env = await isolatedEnv("openovel-lock-owner-")
  try {
    await initializeStory()
    const first = await acquireStorykeeperLease({ owner: "first", heartbeatMs: 1000 })
    assert.equal(first.acquired, true)
    await writeFile(
      paths.storykeeperLock,
      `${JSON.stringify({ lockId: "replacement", owner: "second", pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), storyRoot: paths.root, status: "active" })}\n`,
      "utf8",
    )
    const released = await first.release()
    assert.equal(released.released, false)
    assert.equal(existsSync(paths.storykeeperLock), true)
    const current = JSON.parse(await readFile(paths.storykeeperLock, "utf8"))
    assert.equal(current.lockId, "replacement")
  } finally {
    env.restore()
  }
})

test("Storykeeper lease heartbeat fails when lock is removed", async () => {
  const env = await isolatedEnv("openovel-lock-removed-")
  try {
    await initializeStory()
    const lease = await acquireStorykeeperLease({ owner: "first", heartbeatMs: 1000 })
    assert.equal(lease.acquired, true)
    await import("node:fs/promises").then((fs) => fs.unlink(paths.storykeeperLock))
    await assert.rejects(() => lease.heartbeat(), /removed or replaced/)
    await lease.release()
  } finally {
    env.restore()
  }
})

async function isolatedEnv(prefix) {
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
  }
  const home = await mkdtemp(path.join(os.tmpdir(), `${prefix}home-`))
  const storyRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}story-`))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = storyRoot
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  return {
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}
