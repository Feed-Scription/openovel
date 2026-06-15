import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  loadStarterManifest,
  seedStarterStories,
  readSeededIds,
  seededMarkerPath,
  coarseLang,
} from "../src/lib/starterStories.js"

const FORMAT = "openovel-snapshot/v1"

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

// Build a starter dir: an index.json manifest + the named (minimal valid)
// bundle files. Returns the dir path.
async function setupStarters(entries, bundleNames) {
  const dir = await tmpDir("ovl-starters-")
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ starters: entries }, null, 2), "utf8")
  for (const name of bundleNames) {
    await writeFile(path.join(dir, name), JSON.stringify({ format: FORMAT, files: [] }), "utf8")
  }
  return dir
}

test("loadStarterManifest parses, defaults id to filename stem, sorts by order, rejects unsafe files", async () => {
  const dir = await setupStarters(
    [
      { file: "a.json", lang: "ZH", order: 2 },
      { id: "custom", file: "b.json", title: "B", order: 1 },
      { file: "../escape.json" }, // path escape → dropped
      { file: "sub/c.json" },     // subpath → dropped
      { file: "" },               // empty → dropped
      { nope: true },             // junk → dropped
    ],
    ["a.json", "b.json"],
  )
  const manifest = await loadStarterManifest({ OPENOVEL_STARTER_DIR: dir })
  assert.deepEqual(manifest.map((m) => m.id), ["custom", "a"]) // order ascending
  assert.equal(manifest[1].lang, "zh") // lowercased
  assert.equal(manifest[0].file, "b.json")
})

test("loadStarterManifest returns [] when there's no manifest", async () => {
  const dir = await tmpDir("ovl-starters-empty-")
  assert.deepEqual(await loadStarterManifest({ OPENOVEL_STARTER_DIR: dir }), [])
})

test("seedStarterStories seeds once, then the marker blocks re-seeding", async () => {
  const dir = await setupStarters(
    [{ id: "one", file: "one.json" }, { id: "two", file: "two.json" }],
    ["one.json", "two.json"],
  )
  const home = await tmpDir("ovl-starters-home-")
  const env = { OPENOVEL_STARTER_DIR: dir, OPENOVEL_HOME: home }
  const calls = []
  const importBundle = async (bundle, entry) => {
    assert.equal(bundle.format, FORMAT)
    calls.push(entry.id)
    return { ok: true, id: `slot_${entry.id}` }
  }

  const r1 = await seedStarterStories({ env, importBundle })
  assert.deepEqual(r1.seeded.sort(), ["one", "two"])
  assert.deepEqual(calls.sort(), ["one", "two"])
  assert.ok(existsSync(seededMarkerPath(env)))
  assert.deepEqual([...(await readSeededIds(env))].sort(), ["one", "two"])

  // Second run: nothing new imported.
  calls.length = 0
  const r2 = await seedStarterStories({ env, importBundle })
  assert.deepEqual(r2.seeded, [])
  assert.deepEqual(calls, [])
})

test("seedStarterStories filters by lang and leaves mismatches un-marked (so a later switch seeds them)", async () => {
  const dir = await setupStarters(
    [
      { id: "zh1", file: "zh1.json", lang: "zh" },
      { id: "en1", file: "en1.json", lang: "en" },
      { id: "any", file: "any.json" }, // untagged → any locale
    ],
    ["zh1.json", "en1.json", "any.json"],
  )
  const home = await tmpDir("ovl-starters-lang-")
  const env = { OPENOVEL_STARTER_DIR: dir, OPENOVEL_HOME: home }
  const importBundle = async () => ({ ok: true })

  const r = await seedStarterStories({ env, lang: "en", importBundle })
  assert.deepEqual(r.seeded.sort(), ["any", "en1"])
  assert.deepEqual([...(await readSeededIds(env))].sort(), ["any", "en1"])

  // The reader later switches their story language to zh → zh1 now seeds.
  const r2 = await seedStarterStories({ env, lang: "zh", importBundle })
  assert.deepEqual(r2.seeded, ["zh1"])
})

test("seedStarterStories does not mark a failed import (retries next launch)", async () => {
  const dir = await setupStarters([{ id: "flaky", file: "flaky.json" }], ["flaky.json"])
  const home = await tmpDir("ovl-starters-fail-")
  const env = { OPENOVEL_STARTER_DIR: dir, OPENOVEL_HOME: home }
  let attempts = 0
  const importBundle = async () => {
    attempts++
    return attempts === 1 ? { ok: false, error: "boom" } : { ok: true }
  }

  const r1 = await seedStarterStories({ env, importBundle })
  assert.deepEqual(r1.seeded, [])
  assert.deepEqual([...(await readSeededIds(env))], []) // not marked
  assert.equal(existsSync(seededMarkerPath(env)), false)

  const r2 = await seedStarterStories({ env, importBundle })
  assert.deepEqual(r2.seeded, ["flaky"])
})

test("seedStarterStories no-ops with no manifest and writes no marker", async () => {
  const dir = await tmpDir("ovl-starters-none-")
  const home = await tmpDir("ovl-starters-none-home-")
  const env = { OPENOVEL_STARTER_DIR: dir, OPENOVEL_HOME: home }
  const r = await seedStarterStories({ env, importBundle: async () => ({ ok: true }) })
  assert.deepEqual(r, { seeded: [], skipped: [] })
  assert.equal(existsSync(seededMarkerPath(env)), false)
})

test("coarseLang buckets common languages, empty otherwise", () => {
  assert.equal(coarseLang("默认故事语言：中文"), "zh")
  assert.equal(coarseLang("Default story language: English"), "en")
  assert.equal(coarseLang("日本語で書いてください"), "ja")
  assert.equal(coarseLang("klingon please"), "")
  assert.equal(coarseLang(""), "")
})
