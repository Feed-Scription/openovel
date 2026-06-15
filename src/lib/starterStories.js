// Starter stories: pre-initialized novels shipped with the app and seeded into
// a brand-new library on first run, so a fresh user has something playable to
// open without going through init first.
//
// Authoring: build a story in-app, then "Export as sample (clean)" (the clean
// snapshot export — see lib/storySnapshot.js) and drop the resulting JSON into
// resources/starter-stories/, registering it in index.json. The clean export
// already strips runtime ledgers / agent threads / search logs, so the bundle
// carries only authored story content.
//
// Delivery: into an EMPTY library (the VM's gate), the runtime seeds every
// manifest entry not yet recorded in the per-home marker
// ($OPENOVEL_HOME/.starters-seeded.json). The marker is keyed by each entry's
// STABLE logical id (not the random on-disk slot id), so a starter the user
// deletes stays deleted, and an app update can add new starters without
// re-injecting the ones already seeded.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { SNAPSHOT_FORMAT } from "./storySnapshot.js"

const MARKER_FILENAME = ".starters-seeded.json"
const MANIFEST_FILENAME = "index.json"

// Directory holding starter bundles. The Electron main process sets
// OPENOVEL_STARTER_DIR (packaged: process.resourcesPath/starter-stories; dev:
// repo resources/starter-stories). For non-Electron callers (tests, CLI) we
// fall back to the repo-relative path so the feature stays exercisable headless.
export function starterDir(env = process.env) {
  if (env.OPENOVEL_STARTER_DIR) return path.resolve(env.OPENOVEL_STARTER_DIR)
  const here = path.dirname(fileURLToPath(import.meta.url)) // src/lib
  return path.resolve(here, "..", "..", "resources", "starter-stories")
}

function homeDir(env = process.env) {
  return path.resolve(
    env.OPENOVEL_HOME || env.AI_STORY_HOME || path.join(os.homedir(), ".openovel"),
  )
}

export function seededMarkerPath(env = process.env) {
  return path.join(homeDir(env), MARKER_FILENAME)
}

// The set of logical starter ids already seeded into this home. Missing /
// unreadable / malformed marker ⇒ empty set (seed everything).
export async function readSeededIds(env = process.env) {
  try {
    const text = await readFile(seededMarkerPath(env), "utf8")
    const parsed = JSON.parse(text)
    const ids = Array.isArray(parsed?.seeded) ? parsed.seeded : []
    return new Set(ids.filter((x) => typeof x === "string" && x))
  } catch {
    return new Set()
  }
}

async function writeSeededIds(ids, env = process.env) {
  const marker = seededMarkerPath(env)
  await mkdir(path.dirname(marker), { recursive: true })
  const body = { seeded: [...ids].sort(), at: new Date().toISOString() }
  await writeFile(marker, JSON.stringify(body, null, 2), "utf8")
}

// Load + validate the manifest. Returns [] when there's no starter dir or no
// manifest (the common case for a source checkout with no bundles committed).
// Accepts either a bare array or { starters: [...] }.
export async function loadStarterManifest(env = process.env) {
  const dir = starterDir(env)
  let text
  try {
    text = await readFile(path.join(dir, MANIFEST_FILENAME), "utf8")
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.starters)
      ? parsed.starters
      : []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue
    const file = typeof raw.file === "string" ? raw.file.trim() : ""
    // Path-safety: a manifest entry may only name a plain file inside the dir.
    if (!file || file.includes("..") || file.includes("/") || file.includes("\\") || path.isAbsolute(file)) {
      continue
    }
    const id = (typeof raw.id === "string" && raw.id.trim()) || file.replace(/\.json$/i, "")
    out.push({
      id,
      file,
      title: typeof raw.title === "string" ? raw.title : "",
      lang: typeof raw.lang === "string" ? raw.lang.toLowerCase() : "",
      order: Number.isFinite(raw.order) ? raw.order : 0,
    })
  }
  out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return out
}

export async function readStarterBundle(entry, env = process.env) {
  const dir = path.resolve(starterDir(env))
  const full = path.resolve(dir, entry.file)
  // Defense in depth on top of the manifest-load check.
  if (full !== path.join(dir, entry.file) || !full.startsWith(dir + path.sep)) {
    throw new Error(`starter path escapes dir: ${entry.file}`)
  }
  const text = await readFile(full, "utf8")
  const bundle = JSON.parse(text)
  if (bundle.format !== SNAPSHOT_FORMAT) {
    throw new Error(`unsupported starter bundle format: ${bundle.format}`)
  }
  return bundle
}

// Coarse language bucket for starter filtering. Maps the user's story-language
// preference text (from USER.md) to a short tag. Returns "" when ambiguous, in
// which case the caller seeds every starter regardless of its lang tag.
export function coarseLang(text) {
  const s = String(text || "").toLowerCase()
  if (!s) return ""
  if (/中文|汉语|漢語|chinese|普通话|简体|繁體|繁体|粤语|\bzh\b/.test(s)) return "zh"
  if (/english|英文|英语|英語|\ben\b/.test(s)) return "en"
  if (/日本語|japanese|にほんご|\bja\b/.test(s)) return "ja"
  if (/한국어|korean|\bko\b/.test(s)) return "ko"
  return ""
}

function langMatches(entryLang, userLang) {
  if (!entryLang) return true // untagged starter → seed in any locale
  if (!userLang) return true // unknown user locale → don't exclude
  return entryLang === userLang
}

// Seed un-seeded starter stories. `importBundle(bundle, entry)` performs the
// actual install (the VM passes a wrapper around importStorySnapshot) and
// should resolve to a truthy outcome ({ ok, id }) on success. An entry is only
// marked seeded when its import SUCCEEDS, so a transient failure (or an
// unreadable bundle) simply retries on the next launch. A lang-mismatched entry
// is skipped WITHOUT being marked, so it can still seed if the user later
// switches their story language.
export async function seedStarterStories({ env = process.env, lang = "", importBundle } = {}) {
  if (typeof importBundle !== "function") {
    throw new Error("seedStarterStories: importBundle is required")
  }
  const manifest = await loadStarterManifest(env)
  if (!manifest.length) return { seeded: [], skipped: [] }

  const already = await readSeededIds(env)
  const seeded = []
  const skipped = []
  let changed = false

  for (const entry of manifest) {
    if (already.has(entry.id)) { skipped.push(entry.id); continue }
    if (!langMatches(entry.lang, lang)) { skipped.push(entry.id); continue }

    let bundle
    try {
      bundle = await readStarterBundle(entry, env)
    } catch {
      skipped.push(entry.id) // unreadable: leave un-marked, retry next launch
      continue
    }

    let outcome
    try {
      outcome = await importBundle(bundle, entry)
    } catch {
      outcome = null
    }
    if (outcome && outcome.ok !== false) {
      already.add(entry.id)
      seeded.push(entry.id)
      changed = true
    } else {
      skipped.push(entry.id)
    }
  }

  if (changed) await writeSeededIds(already, env)
  return { seeded, skipped }
}
