import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// The in-app lazy self-heal: opening a pre-reorg save (initializeStory) brings it
// onto the resident layout — foreground/→frontend/, background/→director/, prefix
// strip, and FG_template @include rewrite. This is the safety net behind the
// one-shot scripts/migrate-resident-layout.mjs.
test("initializeStory self-heals a legacy foreground/background save onto the resident layout", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-home-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-story-"))
  const prevHome = process.env.OPENOVEL_HOME
  const prevRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = root
  try {
    // Seed a legacy (G2-ish) layout: prefixed section files under foreground/,
    // an internal background/ dir, and a template pointing at story/foreground/.
    await mkdir(path.join(root, "foreground"), { recursive: true })
    await writeFile(path.join(root, "foreground", "00-header.md"), "---\nsection: header\n---\n\nHeader body\n")
    await writeFile(path.join(root, "foreground", "10-scene.md"), "---\nsection: scene\n---\n\n## Scene\n\nA room.\n")
    await writeFile(path.join(root, "foreground", "40-must-keep.md"), "---\nsection: must-keep\n---\n\n## Must Keep\n\n- A fact.\n")
    await mkdir(path.join(root, "background"), { recursive: true })
    await writeFile(path.join(root, "background", "ARC.md"), "# Arc\n")
    await writeFile(path.join(root, "background", "QUALITY.md"), "# Quality\n")
    await mkdir(path.join(root, "guidance"), { recursive: true })
    await writeFile(
      path.join(root, "guidance", "FG_template.md"),
      "# Foreground Guidance\n\n@include story/foreground/00-header.md\n@include story/foreground/10-scene.md\n@include story/foreground/40-must-keep.md\n",
    )

    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    await initializeStory()

    // Dirs relocated.
    assert.ok(existsSync(paths.frontendDir), "frontend/ created")
    assert.ok(!existsSync(path.join(root, "foreground")), "foreground/ gone")
    assert.ok(existsSync(paths.directorDir), "director/ created")
    assert.ok(!existsSync(path.join(root, "background")), "background/ gone")

    // Section files moved + prefixes stripped (content preserved).
    assert.equal((await readFile(path.join(root, "frontend", "header.md"), "utf8")).includes("Header body"), true)
    assert.ok(existsSync(path.join(root, "frontend", "scene.md")), "10-scene.md → scene.md")
    assert.ok(existsSync(path.join(root, "frontend", "constants.md")), "40-must-keep.md → constants.md")
    assert.match(await readFile(path.join(root, "frontend", "constants.md"), "utf8"), /section: constants/)
    assert.match(await readFile(path.join(root, "frontend", "constants.md"), "utf8"), /## Constants/)
    assert.ok(!existsSync(path.join(root, "frontend", "10-scene.md")), "prefixed name gone")
    assert.ok(!existsSync(path.join(root, "frontend", "40-must-keep.md")), "legacy must-keep prefixed name gone")

    // Internal notebook files now under director/.
    assert.ok(existsSync(path.join(root, "director", "ARC.md")), "background/ARC.md → director/ARC.md")
    assert.ok(existsSync(path.join(root, "director", "QUALITY.md")), "background/QUALITY.md → director/QUALITY.md")

    // Template @includes repointed to story/frontend/, no story/foreground/ left.
    const tpl = await readFile(paths.foregroundTemplate, "utf8")
    assert.match(tpl, /@include story\/frontend\/header\.md/)
    assert.match(tpl, /@include story\/frontend\/constants\.md/)
    assert.doesNotMatch(tpl, /story\/foreground\//)
    assert.doesNotMatch(tpl, /00-header\.md/)
    assert.doesNotMatch(tpl, /must-keep\.md/)
  } finally {
    if (prevHome === undefined) delete process.env.OPENOVEL_HOME
    else process.env.OPENOVEL_HOME = prevHome
    if (prevRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = prevRoot
  }
})
