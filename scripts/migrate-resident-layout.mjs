#!/usr/bin/env node
// One-shot migration: bring existing story saves onto the resident-agent layout.
//   story/foreground/ → story/frontend/   (Showrunner working set)
//   story/background/  → story/director/   (internal arc/pacing/quality)
//   strip numeric-prefixed section filenames inside frontend/ (10-scene.md → scene.md)
//   rewrite FG_template.md @includes (story/foreground/NN-name.md → story/frontend/name.md)
//
// Idempotent: writes story/.layout-version and skips already-migrated saves; never
// clobbers an existing destination. The app ALSO self-heals each save lazily on
// open (storyStore.initializeStory + migrateForegroundFilenames) — this script is
// the bulk pass.
//
// Usage:
//   node scripts/migrate-resident-layout.mjs --dry-run        # show planned moves, change nothing
//   node scripts/migrate-resident-layout.mjs                  # migrate ~/.openovel + ~/.openovel-fr
//   node scripts/migrate-resident-layout.mjs --home <path>    # migrate one home only
import { readdir, rename, readFile, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const LAYOUT_VERSION = "resident-1"
const DIR_MOVES = [["foreground", "frontend"], ["background", "director"]]

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const homeIdx = argv.indexOf("--home")
const homeOverride = homeIdx >= 0 ? argv[homeIdx + 1] : null

function homes() {
  if (homeOverride) return [homeOverride]
  if (process.env.OPENOVEL_HOME) return [process.env.OPENOVEL_HOME]
  return [path.join(os.homedir(), ".openovel"), path.join(os.homedir(), ".openovel-fr")]
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function listStoryDirs(home) {
  const storiesRoot = path.join(home, "stories")
  if (!(await isDir(storiesRoot))) return []
  const entries = await readdir(storiesRoot, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(storiesRoot, e.name))
}

// Build the move/rewrite plan for one story (no side effects).
async function planStory(storyDir) {
  const plan = { dirMoves: [], renames: [], templateRewrite: false, skip: null }
  if (existsSync(path.join(storyDir, ".layout-version"))) {
    plan.skip = "already-migrated"
    return plan
  }
  for (const [from, to] of DIR_MOVES) {
    const src = path.join(storyDir, from)
    const dst = path.join(storyDir, to)
    if ((await isDir(src)) && !existsSync(dst)) plan.dirMoves.push([src, dst])
  }
  // After the (planned) foreground→frontend move, strip numeric prefixes. Look in
  // whichever dir currently holds the section files.
  const sectionDir = existsSync(path.join(storyDir, "frontend"))
    ? path.join(storyDir, "frontend")
    : path.join(storyDir, "foreground")
  if (await isDir(sectionDir)) {
    for (const name of await readdir(sectionDir).catch(() => [])) {
      const m = name.match(/^(\d+)-(.+)$/)
      if (m) plan.renames.push([name, m[2]])
    }
  }
  const tplPath = path.join(storyDir, "guidance", "FG_template.md")
  if (existsSync(tplPath)) {
    const tpl = await readFile(tplPath, "utf8").catch(() => "")
    if (/story\/foreground\//.test(tpl) || /@include story\/frontend\/\d+-/.test(tpl)) plan.templateRewrite = true
  }
  return plan
}

async function applyStory(storyDir, plan) {
  for (const [src, dst] of plan.dirMoves) {
    await rename(src, dst).catch(async (err) => {
      console.warn(`  ! rename ${src} → ${dst} failed: ${err?.message || err}`)
    })
  }
  const frontendDir = path.join(storyDir, "frontend")
  for (const [oldName, newName] of plan.renames) {
    const oldPath = path.join(frontendDir, oldName)
    const newPath = path.join(frontendDir, newName)
    if (existsSync(oldPath) && !existsSync(newPath)) await rename(oldPath, newPath).catch(() => {})
  }
  if (plan.templateRewrite) {
    const tplPath = path.join(storyDir, "guidance", "FG_template.md")
    let tpl = await readFile(tplPath, "utf8").catch(() => "")
    tpl = tpl.split("story/foreground/").join("story/frontend/")
    tpl = tpl.replace(/(@include\s+story\/frontend\/)\d+-/g, "$1")
    await writeFile(tplPath, tpl, "utf8")
  }
  await writeFile(path.join(storyDir, ".layout-version"), `${LAYOUT_VERSION}\n`, "utf8")
}

function describe(storyDir, plan) {
  const rel = storyDir
  if (plan.skip) return `· ${rel} — skip (${plan.skip})`
  const parts = []
  for (const [src, dst] of plan.dirMoves) parts.push(`mv ${path.basename(src)}/ → ${path.basename(dst)}/`)
  if (plan.renames.length) parts.push(`strip prefix ×${plan.renames.length}`)
  if (plan.templateRewrite) parts.push("rewrite FG_template")
  return `${parts.length ? "→" : "·"} ${rel}${parts.length ? " — " + parts.join(", ") : " — nothing to do"}`
}

async function main() {
  let migrated = 0
  let skipped = 0
  let noop = 0
  for (const home of homes()) {
    const stories = await listStoryDirs(home)
    if (!stories.length) continue
    console.log(`\n# ${home} (${stories.length} stories)`)
    for (const storyDir of stories) {
      const plan = await planStory(storyDir)
      console.log("  " + describe(storyDir, plan))
      if (plan.skip) { skipped++; continue }
      const hasWork = plan.dirMoves.length || plan.renames.length || plan.templateRewrite
      if (!hasWork) { noop++; continue }
      if (!dryRun) {
        await applyStory(storyDir, plan)
        migrated++
      }
    }
  }
  console.log(`\n${dryRun ? "[dry-run] " : ""}done — ${dryRun ? "would migrate" : "migrated"} ${migrated}, skipped ${skipped} (already migrated), ${noop} nothing-to-do.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
