// Story snapshot format and helpers.
//
// A snapshot is a single self-contained JSON file that captures every text
// file under a story's root directory. It's used in two ways:
//
//   - Auto-saved as the "initial" snapshot right after the conversational
//     init agent finishes drafting a new story. Lives at
//     $OPENOVEL_HOME/snapshots/<storyId>/initial.json
//   - User-triggered "share" — exports either the initial snapshot or the
//     story's current live state to a user-chosen file path so they can
//     send it to a friend / archive it / restore it.
//
// Format = `openovel-snapshot/v1`:
//   { format, snapshotAt, storyId, label, fileCount, files }
//   files = [{ path, encoding: "utf8"|"base64"|"skipped", content, ... }]
//
// Restore (the symmetric op) recreates the directory tree from a bundle.

import { readFile, writeFile, mkdir, stat, readdir, rm } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import os from "node:os"

export const SNAPSHOT_FORMAT = "openovel-snapshot/v1"

// Hard cap per file: avoid runaway sizes for things like accidentally
// committed video / heap dumps. The expected story payload is markdown +
// jsonl + small images, well under a few MB total.
const MAX_FILE_SIZE = 5 * 1024 * 1024
const DEFAULT_SKIP_DIRS = new Set([
  ".locks",            // ephemeral file locks
  "watchers",          // runtime trigger state
  "permissions",       // per-session permission ledger
  "transactions",      // mid-write transaction manifests
])

// Extra top-level dirs dropped from a "starter"/clean export: runtime ledgers
// and diagnostics that are machine/playthrough state, not authored story
// content. DEFAULT_SKIP_DIRS (above) is already dropped from EVERY snapshot.
const STARTER_SKIP_DIRS = new Set([
  ...DEFAULT_SKIP_DIRS,
  "jobs",              // backgroundJob ledger
  "packets",           // foreground-context diagnostics + hot-path caches
  "profiles",          // usage profile from non-interactive runs
])

// Per-file noise filter for a starter/clean export — returns true to DROP the
// file. Targets resident-agent runtime plumbing wherever it lives (each agent
// keeps a thread/queue/lock under its own domain dir, not just under agents/)
// plus the runtime's append-only research audit log. agents/init-*.json (the
// replayable init recording) is deliberately KEPT: it is authored provenance,
// not noise, and powers the library's "replay init" affordance.
function isStarterNoiseFile(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1)
  if (rel.startsWith("agents/") && /^init-.*\.json$/i.test(base)) return false
  if (base === "thread.jsonl" || base.endsWith(".thread.jsonl")) return true
  if (base === "queue.jsonl" || base.endsWith(".queue.jsonl")) return true
  if (base.endsWith(".lock")) return true
  if (rel === "research/search-log.md") return true
  return false
}

// Path-level variant for filtering an ALREADY-built bundle (which still carries
// the STARTER_SKIP_DIRS dirs that the live-walk skips up front).
function isStarterNoisePath(rel) {
  const top = rel.split("/")[0]
  if (STARTER_SKIP_DIRS.has(top)) return true
  return isStarterNoiseFile(rel)
}

// Walks a story root and emits a flat list of files in the format the
// snapshot bundle expects.
async function collectFiles(rootDir, opts = {}) {
  const skipDirs = opts.skipDirs || DEFAULT_SKIP_DIRS
  const skipFile = opts.skipFile || null
  const out = []
  async function walk(dir, prefix) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    // Stable order so two snapshots of the same dir produce diffable JSON.
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        await walk(full, rel)
      } else if (e.isFile()) {
        // Drop filtered files BEFORE the read so a clean export never even
        // loads a huge agent thread / queue into memory.
        if (skipFile && skipFile(rel)) continue
        const st = await stat(full).catch(() => null)
        if (!st) continue
        if (st.size > MAX_FILE_SIZE) {
          out.push({ path: rel, encoding: "skipped", reason: "exceeds 5MB cap", size: st.size })
          continue
        }
        const buf = await readFile(full)
        const entry = encodeFile(rel, buf)
        out.push(entry)
      }
    }
  }
  await walk(rootDir, "")
  return out
}

// Try UTF-8; fall back to base64 if the buffer contains binary bytes.
function encodeFile(rel, buf) {
  const utf8 = buf.toString("utf8")
  // The replacement char appears when invalid sequences exist in the source —
  // a reliable "this isn't really UTF-8" signal.
  if (!utf8.includes("�")) {
    return { path: rel, encoding: "utf8", content: utf8 }
  }
  return { path: rel, encoding: "base64", content: buf.toString("base64") }
}

export async function createSnapshot({ storyRoot, storyId, label = "", clean = false }) {
  if (!storyRoot) throw new Error("createSnapshot: storyRoot is required")
  const files = clean
    ? await collectFiles(storyRoot, { skipDirs: STARTER_SKIP_DIRS, skipFile: isStarterNoiseFile })
    : await collectFiles(storyRoot)
  const bundle = {
    format: SNAPSHOT_FORMAT,
    snapshotAt: new Date().toISOString(),
    storyId: storyId || "",
    label,
    fileCount: files.length,
    files,
  }
  // Only stamp `clean` on clean exports so an ordinary snapshot's JSON stays
  // byte-for-byte what it was before this option existed.
  if (clean) bundle.clean = true
  return bundle
}

// Strip starter-noise files from an ALREADY-built bundle and mark it clean.
// Used to produce a shippable starter from a bundle captured without the clean
// filter (e.g. the auto-saved initial.json). Returns a new bundle; the input is
// left untouched.
export function filterStarterBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.files)) return bundle
  const files = bundle.files.filter((f) => f && !isStarterNoisePath(f.path))
  return { ...bundle, clean: true, fileCount: files.length, files }
}

export async function writeSnapshotToFile(bundle, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8")
  return filePath
}

export async function readSnapshotFile(filePath) {
  const text = await readFile(filePath, "utf8")
  const bundle = JSON.parse(text)
  if (bundle.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Unsupported snapshot format: ${bundle.format}`)
  }
  return bundle
}

// Re-materialize a snapshot into a target directory. Used by import flows
// (user wants to restore a shared bundle into a new story slot).
export async function restoreSnapshot(bundle, targetDir) {
  if (bundle.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Unsupported snapshot format: ${bundle.format}`)
  }
  await mkdir(targetDir, { recursive: true })
  for (const f of bundle.files || []) {
    if (f.encoding === "skipped") continue
    const dst = path.join(targetDir, f.path)
    await mkdir(path.dirname(dst), { recursive: true })
    const buf = f.encoding === "base64"
      ? Buffer.from(f.content, "base64")
      : Buffer.from(f.content, "utf8")
    await writeFile(dst, buf)
  }
  return targetDir
}

// Remove the files inside a LIVE story root that a snapshot would have captured,
// honoring the same DEFAULT_SKIP_DIRS the snapshot itself skipped. This is the
// missing half of an in-place restore: restoreSnapshot only WRITES files, so a
// file created AFTER the snapshot (a new context card, a new agent thread)
// would otherwise linger and desync the restored state. We only ever touch
// files under rootDir; version bundles live under $OPENOVEL_HOME (outside the
// story root), so they are never at risk here.
async function clearRestorableFiles(rootDir, skipDirs = DEFAULT_SKIP_DIRS) {
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        await walk(full)
      } else if (e.isFile()) {
        await rm(full, { force: true }).catch(() => {})
      }
    }
  }
  await walk(rootDir)
}

// Restore a snapshot OVER a live story root: wipe the snapshot's scope first,
// then re-materialize the bundle. Used by restart / version-restore where the
// target directory already holds a (different) playthrough we must not blend
// with. Skip dirs (transactions/watchers/permissions/.locks) are left untouched
// on both the wipe and the restore, matching createSnapshot's own exclusions.
//
// meta.json is the LIBRARY CARD (displayName, createdAt, per-story mode), not
// playthrough state: a rename or a comic/fast mode switch made after the
// snapshot must survive a restart / version restore, so the live file wins
// over the bundled one. (Plain restoreSnapshot keeps the bundled meta — the
// import flow materializes into a fresh slot and overwrites it itself.)
//
// agents/init-*.json gets the same live-wins treatment: an init transcript is
// a RECORDING of the init run (the replay source), not playthrough state, so
// rolling the playthrough back must not roll back the recording. The initial
// snapshot used to bank the run-start stub (captured before the complete
// rewrite landed) and a restart then clobbered the finished transcript with
// it — replay went dark. (Plain restoreSnapshot is again unaffected: a fresh
// import slot has no live recording to protect.)
export async function restoreSnapshotInPlace(bundle, storyRoot) {
  if (!storyRoot) throw new Error("restoreSnapshotInPlace: storyRoot is required")
  if (bundle.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Unsupported snapshot format: ${bundle.format}`)
  }
  const metaPath = path.join(storyRoot, "meta.json")
  const liveMeta = await readFile(metaPath, "utf8").catch(() => null)
  const agentsDir = path.join(storyRoot, "agents")
  const liveInits = new Map()
  for (const name of await readdir(agentsDir).catch(() => [])) {
    if (!/^init-.*\.json$/i.test(name)) continue
    const buf = await readFile(path.join(agentsDir, name)).catch(() => null)
    if (buf) liveInits.set(name, buf)
  }
  await clearRestorableFiles(storyRoot)
  await restoreSnapshot(bundle, storyRoot)
  if (liveMeta !== null) await writeFile(metaPath, liveMeta, "utf8")
  if (liveInits.size) {
    await mkdir(agentsDir, { recursive: true })
    for (const [name, buf] of liveInits) {
      await writeFile(path.join(agentsDir, name), buf)
    }
  }
  return storyRoot
}

// Canonical local path for the auto-saved initial snapshot of a story.
export function initialSnapshotPath(storyId, env = process.env) {
  const home = env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "snapshots", storyId, "initial.json")
}

// ── Saved versions ────────────────────────────────────────────────────────
// A "version" is a full snapshot the user banked before restarting (or before
// switching to another version), so a prior playthrough is never lost. They
// live alongside initial.json, under a versions/ subdir, with a lightweight
// index.json so the UI can list them without parsing every (large) bundle.

export function versionsDir(storyId, env = process.env) {
  const home = env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "snapshots", storyId, "versions")
}

export function versionPath(storyId, versionId, env = process.env) {
  return path.join(versionsDir(storyId, env), `${versionId}.json`)
}

function versionIndexPath(storyId, env = process.env) {
  return path.join(versionsDir(storyId, env), "index.json")
}

// Returns newest-first version metadata: [{ id, label, turnCount, at }].
export async function listVersions(storyId, env = process.env) {
  try {
    const text = await readFile(versionIndexPath(storyId, env), "utf8")
    const parsed = JSON.parse(text)
    const versions = Array.isArray(parsed?.versions) ? parsed.versions : []
    return versions
      .filter((v) => v && v.id)
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
  } catch {
    return []
  }
}

// Persist a version bundle + prepend its metadata to the index. Returns the
// stored entry. maxVersions (when > 0) prunes the oldest bundles beyond the cap.
export async function saveVersion({ storyRoot, storyId, versionId, label = "", turnCount = 0, env = process.env, maxVersions = 0 }) {
  if (!storyId) throw new Error("saveVersion: storyId is required")
  if (!versionId) throw new Error("saveVersion: versionId is required")
  const bundle = await createSnapshot({ storyRoot, storyId, label })
  await writeSnapshotToFile(bundle, versionPath(storyId, versionId, env))
  const at = bundle.snapshotAt
  const existing = await listVersions(storyId, env)
  let versions = [{ id: versionId, label, turnCount, at }, ...existing.filter((v) => v.id !== versionId)]
  if (maxVersions > 0 && versions.length > maxVersions) {
    const dropped = versions.slice(maxVersions)
    versions = versions.slice(0, maxVersions)
    for (const d of dropped) await rm(versionPath(storyId, d.id, env), { force: true }).catch(() => {})
  }
  await mkdir(versionsDir(storyId, env), { recursive: true })
  await writeFile(versionIndexPath(storyId, env), JSON.stringify({ versions }, null, 2), "utf8")
  return { id: versionId, label, turnCount, at }
}

// Remove one version's bundle and its index entry.
export async function deleteVersion(storyId, versionId, env = process.env) {
  await rm(versionPath(storyId, versionId, env), { force: true }).catch(() => {})
  const versions = (await listVersions(storyId, env)).filter((v) => v.id !== versionId)
  await mkdir(versionsDir(storyId, env), { recursive: true })
  await writeFile(versionIndexPath(storyId, env), JSON.stringify({ versions }, null, 2), "utf8")
  return versions
}
