import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import {
  beginStoryTransaction,
  listStoryTransactions,
  recoverAbandonedStoryTransactions,
  rollbackStoryTransaction,
  withStoryTransaction,
} from "../src/runtime/storyTransaction.js"
import { writeAtomic } from "../src/lib/files.js"

test("StoryTransaction snapshots committed writes and rolls back updated files", async () => {
  const env = await isolatedEnv("openovel-tx-update-")
  try {
    await initializeStory()
    const file = path.join(paths.root, "canon", "tx.md")
    await writeFile(file, "before\n", "utf8")
    const { transaction } = await withStoryTransaction({ source: "test", files: [file] }, async () => {
      await writeAtomic(file, "after\n")
    })

    assert.equal(transaction.status, "committed")
    assert.equal(await readFile(file, "utf8"), "after\n")
    const listed = await listStoryTransactions({ limit: 10 })
    assert.ok(listed.some((tx) => tx.txId === transaction.txId))

    const rolled = await rollbackStoryTransaction(transaction.txId)
    assert.deepEqual(rolled.rolledBack.map((f) => f.action), ["restored"])
    assert.equal(await readFile(file, "utf8"), "before\n")
  } finally {
    env.restore()
  }
})

test("StoryTransaction rollback removes files created by the transaction", async () => {
  const env = await isolatedEnv("openovel-tx-create-")
  try {
    await initializeStory()
    const file = path.join(paths.root, "canon", "created.md")
    const { transaction } = await withStoryTransaction({ source: "test", files: [file] }, async () => {
      await writeAtomic(file, "created\n")
    })
    assert.equal(await readFile(file, "utf8"), "created\n")
    await rollbackStoryTransaction(transaction.txId)
    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/)
  } finally {
    env.restore()
  }
})

test("recoverAbandonedStoryTransactions marks preparing transactions abandoned", async () => {
  const env = await isolatedEnv("openovel-tx-abandoned-")
  try {
    await initializeStory()
    const file = path.join(paths.root, "canon", "abandoned.md")
    const tx = await beginStoryTransaction({ source: "test", files: [file] })
    const recovered = await recoverAbandonedStoryTransactions()
    assert.ok(recovered >= 1)
    const listed = await listStoryTransactions({ limit: 10 })
    const manifest = listed.find((item) => item.txId === tx.txId)
    assert.equal(manifest.status, "abandoned")
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
