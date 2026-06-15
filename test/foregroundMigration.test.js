import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"

process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"

const { migrateForegroundFilenames } = await import("../src/lib/foregroundCompose.js")
const { paths } = await import("../src/lib/storyStore.js")

async function legacyWorkspace() {
  const root = path.join(os.tmpdir(), `openovel-fgmigrate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  await mkdir(paths.foregroundDir, { recursive: true })
  await mkdir(path.dirname(paths.foregroundTemplate), { recursive: true })
  // Legacy prefixed section files with real content.
  await writeFile(path.join(paths.foregroundDir, "00-header.md"), "## Prelude\n\nA quiet room.\n")
  await writeFile(path.join(paths.foregroundDir, "10-scene.md"), "## Scene\n\nThe library at dusk.\n")
  await writeFile(path.join(paths.foregroundDir, "40-must-keep.md"), "## Must Keep\n\n- The old promise still binds Alice.\n")
  // A legacy FG_template referencing the prefixed names.
  await writeFile(
    paths.foregroundTemplate,
    "# Foreground Guidance\n\n@include story/foreground/00-header.md\n@include story/foreground/10-scene.md\n@include story/foreground/40-must-keep.md\n",
  )
  return root
}

test("migrateForegroundFilenames renames prefixed section files + rewrites FG_template @includes", async () => {
  await legacyWorkspace()
  const res = await migrateForegroundFilenames()

  // Files renamed, content preserved, legacy names gone.
  assert.ok(existsSync(path.join(paths.foregroundDir, "scene.md")))
  assert.ok(existsSync(path.join(paths.foregroundDir, "constants.md")))
  assert.ok(!existsSync(path.join(paths.foregroundDir, "10-scene.md")))
  assert.ok(!existsSync(path.join(paths.foregroundDir, "40-must-keep.md")))
  assert.match(await readFile(path.join(paths.foregroundDir, "scene.md"), "utf8"), /The library at dusk/)
  const constantsContent = await readFile(path.join(paths.foregroundDir, "constants.md"), "utf8")
  assert.match(constantsContent, /## Constants/)
  assert.match(constantsContent, /old promise/)
  assert.ok(res.renamed.includes("scene.md") && res.renamed.includes("header.md") && res.renamed.includes("constants.md"))

  // FG_template @includes rewritten to unprefixed names under the renamed
  // frontend/ dir + card manifests appended.
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.match(tpl, /@include story\/frontend\/scene\.md/)
  assert.match(tpl, /@include story\/frontend\/constants\.md/)
  assert.doesNotMatch(tpl, /10-scene\.md/)
  assert.doesNotMatch(tpl, /must-keep\.md/)
  assert.doesNotMatch(tpl, /story\/foreground\//)
  assert.match(tpl, /@include story\/guidance\/cards\.md/)
  assert.match(tpl, /@include story\/guidance\/cards\.auto\.md/)

  // Card manifests seeded so the new @includes resolve (no "[include missing]").
  assert.ok(existsSync(paths.cardsManifest))
  assert.ok(existsSync(paths.cardsAuto))
})

test("migrateForegroundFilenames strips the removed current-working-set @include + inserts pending-consequence before the card manifests", async () => {
  const root = path.join(os.tmpdir(), `openovel-fgmigrate-pc-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  await mkdir(paths.foregroundDir, { recursive: true })
  await mkdir(path.dirname(paths.foregroundTemplate), { recursive: true })
  // An existing template that still @includes the removed current-working-set.
  await writeFile(
    paths.foregroundTemplate,
    "# Foreground Guidance\n\n@include story/frontend/scene.md\n@include story/frontend/active-pressures.md\n@include story/frontend/current-working-set.md\n@include story/guidance/cards.md\n@include story/guidance/cards.auto.md\n",
  )
  const res = await migrateForegroundFilenames()
  assert.equal(res.templateChanged, true)
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  // The removed section's @include is gone.
  assert.doesNotMatch(tpl, /current-working-set\.md/)
  // pending-consequence inserted in the volatile tail, before the card manifests.
  assert.match(tpl, /@include story\/frontend\/pending-consequence\.md/)
  assert.ok(
    tpl.indexOf("pending-consequence.md") < tpl.indexOf("story/guidance/cards.md"),
    "inserted before the card manifests",
  )
  assert.ok(existsSync(path.join(paths.foregroundDir, "pending-consequence.md")))

  // Idempotent: a second run does not duplicate the include.
  await migrateForegroundFilenames()
  const tpl2 = await readFile(paths.foregroundTemplate, "utf8")
  assert.equal(tpl2.match(/pending-consequence\.md/g).length, 1, "no duplicate include")
})

test("migrateForegroundFilenames strips a legacy numeric-prefixed current-working-set @include too", async () => {
  const root = path.join(os.tmpdir(), `openovel-fgmigrate-pfx-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  await mkdir(paths.foregroundDir, { recursive: true })
  await mkdir(path.dirname(paths.foregroundTemplate), { recursive: true })
  await writeFile(
    paths.foregroundTemplate,
    "# Foreground Guidance\n\n@include story/foreground/10-scene.md\n@include story/foreground/15-current-working-set.md\n@include story/guidance/cards.md\n",
  )
  await migrateForegroundFilenames()
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.doesNotMatch(tpl, /current-working-set\.md/, "legacy prefixed cws include stripped")
})

test("migrateForegroundFilenames inserts the directed-beat @include before pending-consequence (directed-beat)", async () => {
  const root = path.join(os.tmpdir(), `openovel-fgmigrate-db-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  await mkdir(paths.foregroundDir, { recursive: true })
  await mkdir(path.dirname(paths.foregroundTemplate), { recursive: true })
  // An existing template that already has pending-consequence but not directed-beat.
  await writeFile(
    paths.foregroundTemplate,
    "# Foreground Guidance\n\n@include story/frontend/scene.md\n@include story/frontend/active-pressures.md\n@include story/frontend/pending-consequence.md\n@include story/guidance/cards.md\n",
  )
  const res = await migrateForegroundFilenames()
  assert.equal(res.templateChanged, true)
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.match(tpl, /@include story\/frontend\/directed-beat\.md/)
  assert.ok(
    tpl.indexOf("directed-beat.md") < tpl.indexOf("pending-consequence.md"),
    "inserted before pending-consequence",
  )
  // The usually-empty stub is seeded so its @include resolves to nothing.
  assert.ok(existsSync(path.join(paths.foregroundDir, "directed-beat.md")))

  // Idempotent: a second run does not duplicate the include.
  await migrateForegroundFilenames()
  const tpl2 = await readFile(paths.foregroundTemplate, "utf8")
  assert.equal(tpl2.match(/directed-beat\.md/g).length, 1, "no duplicate include")
})

test("migrateForegroundFilenames seeds directed-beat before pending-consequence even when neither include exists (directed-beat)", async () => {
  const root = path.join(os.tmpdir(), `openovel-fgmigrate-db2-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  await mkdir(paths.foregroundDir, { recursive: true })
  await mkdir(path.dirname(paths.foregroundTemplate), { recursive: true })
  // Old template lacking BOTH new sections (and still carrying the removed cws):
  // cws is stripped, both new sections inserted, directed-beat first.
  await writeFile(
    paths.foregroundTemplate,
    "# Foreground Guidance\n\n@include story/frontend/scene.md\n@include story/frontend/current-working-set.md\n@include story/guidance/cards.md\n",
  )
  await migrateForegroundFilenames()
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.doesNotMatch(tpl, /current-working-set\.md/)
  assert.match(tpl, /@include story\/frontend\/directed-beat\.md/)
  assert.match(tpl, /@include story\/frontend\/pending-consequence\.md/)
  assert.ok(tpl.indexOf("directed-beat.md") < tpl.indexOf("pending-consequence.md"), "directed-beat before pending-consequence")
  assert.ok(tpl.indexOf("pending-consequence.md") < tpl.indexOf("story/guidance/cards.md"), "both before the card manifests")
})

test("migrateForegroundFilenames is idempotent (second run is a no-op)", async () => {
  await legacyWorkspace()
  await migrateForegroundFilenames()
  const tplAfterFirst = await readFile(paths.foregroundTemplate, "utf8")
  const filesAfterFirst = (await readdir(paths.foregroundDir)).sort()

  const res2 = await migrateForegroundFilenames()
  assert.deepEqual(res2.renamed, [], "nothing left to rename on a migrated story")
  assert.equal(res2.templateChanged, false)
  assert.equal(await readFile(paths.foregroundTemplate, "utf8"), tplAfterFirst)
  assert.deepEqual((await readdir(paths.foregroundDir)).sort(), filesAfterFirst)
})
