import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, readdir, readFile, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { ensureDir, readJson, writeAtomic } from "../lib/files.js"
import { displayWorkspacePath } from "../lib/workspacePaths.js"
import { paths } from "../lib/storyStore.js"

const ACTIVE_STATUSES = new Set(["preparing", "writing"])

export async function withStoryTransaction({ source = "runtime", turnId = "", jobId = "", callID = "", files = [] } = {}, task) {
  const tx = await beginStoryTransaction({ source, turnId, jobId, callID, files })
  try {
    await writeManifest(tx, { ...tx.manifest, status: "writing", writingAt: nowIso() })
    const output = await task(tx)
    await finalizeStoryTransaction(tx)
    return { output, transaction: tx.manifest }
  } catch (error) {
    await writeManifest(tx, {
      ...tx.manifest,
      status: "error",
      error: error?.message || String(error),
      erroredAt: nowIso(),
    }).catch(() => {})
    throw error
  }
}

export async function beginStoryTransaction({ source = "runtime", turnId = "", jobId = "", callID = "", files = [] } = {}) {
  await ensureDir(paths.transactions)
  const txId = `tx_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const root = path.join(paths.transactions, txId)
  const beforeDir = path.join(root, "before")
  const afterDir = path.join(root, "after")
  await Promise.all([ensureDir(beforeDir), ensureDir(afterDir)])
  const normalizedFiles = []
  for (const filePath of unique(files).map((file) => path.resolve(file))) {
    const snapshot = await snapshotFile(filePath, beforeDir)
    normalizedFiles.push({
      path: filePath,
      displayPath: displayWorkspacePath(filePath),
      before: snapshot,
      after: null,
    })
  }
  const manifest = {
    txId,
    source,
    turnId,
    jobId,
    callID,
    status: "preparing",
    startedAt: nowIso(),
    committedAt: "",
    files: normalizedFiles,
  }
  const tx = { txId, root, beforeDir, afterDir, manifest }
  await writeManifest(tx, manifest)
  return tx
}

export async function finalizeStoryTransaction(tx) {
  const files = []
  for (const file of tx.manifest.files) {
    const after = await snapshotFile(file.path, tx.afterDir)
    files.push({ ...file, after })
  }
  const committed = {
    ...tx.manifest,
    status: "committed",
    committedAt: nowIso(),
    files,
  }
  await writeManifest(tx, committed)
  tx.manifest = committed
  return committed
}

export async function listStoryTransactions({ limit = 20 } = {}) {
  await ensureDir(paths.transactions)
  const max = Math.max(1, Number(limit) || 20)
  const names = await readdir(paths.transactions).catch(() => [])
  const rows = []
  for (const name of names.filter((item) => item.startsWith("tx_"))) {
    const manifest = await readJson(path.join(paths.transactions, name, "manifest.json"), null).catch(() => null)
    if (!manifest) continue
    insertRecentTransaction(rows, manifest, max)
  }
  return rows
}

function insertRecentTransaction(rows, manifest, limit) {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (String(manifest.startedAt || "").localeCompare(String(rows[mid].startedAt || "")) > 0) hi = mid
    else lo = mid + 1
  }
  if (lo >= limit) return
  rows.splice(lo, 0, manifest)
  if (rows.length > limit) rows.pop()
}

export async function recoverAbandonedStoryTransactions() {
  const transactions = await listStoryTransactions({ limit: 10000 })
  let abandoned = 0
  for (const manifest of transactions) {
    if (!ACTIVE_STATUSES.has(manifest.status)) continue
    const tx = txFromManifest(manifest)
    await writeManifest(tx, { ...manifest, status: "abandoned", abandonedAt: nowIso() })
    abandoned++
  }
  return abandoned
}

export async function rollbackStoryTransaction(txId) {
  const manifest = await readJson(path.join(paths.transactions, txId, "manifest.json"), null)
  if (!manifest) throw new Error(`Transaction not found: ${txId}`)
  if (!Array.isArray(manifest.files)) throw new Error(`Transaction ${txId} has no files to roll back`)
  const rolledBack = []
  for (const file of manifest.files) {
    const before = file.before || {}
    await ensureDir(path.dirname(file.path))
    if (before.exists) {
      const snapshotPath = path.join(paths.transactions, txId, "before", before.snapshot)
      await copyFile(snapshotPath, file.path)
      rolledBack.push({ path: file.displayPath || displayWorkspacePath(file.path), action: "restored" })
    } else if (existsSync(file.path)) {
      await unlink(file.path)
      rolledBack.push({ path: file.displayPath || displayWorkspacePath(file.path), action: "deleted" })
    }
  }
  await writeManifest(txFromManifest(manifest), {
    ...manifest,
    rollback: {
      at: nowIso(),
      files: rolledBack,
    },
  })
  return { txId, rolledBack }
}

export function formatTransactions(transactions = []) {
  if (!transactions.length) return "(no transactions)"
  return transactions
    .map((tx) => {
      const files = (tx.files || []).map((file) => file.displayPath || displayWorkspacePath(file.path)).slice(0, 4)
      const suffix = files.length ? ` · ${files.join(", ")}` : ""
      return `${tx.txId}  ${tx.status || "unknown"}  ${tx.source || "runtime"}  ${tx.startedAt || ""}${suffix}`
    })
    .join("\n")
}

async function snapshotFile(filePath, dir) {
  const name = encodeSnapshotName(displayWorkspacePath(filePath))
  if (!existsSync(filePath)) return { exists: false, snapshot: name, size: 0, mtimeMs: 0, hash: "" }
  const info = await stat(filePath)
  if (!info.isFile()) return { exists: false, snapshot: name, size: info.size, mtimeMs: info.mtimeMs, hash: "" }
  await ensureDir(dir)
  const snapshot = name
  await copyFile(filePath, path.join(dir, snapshot))
  const bytes = await readFile(filePath)
  return {
    exists: true,
    snapshot,
    size: info.size,
    mtimeMs: info.mtimeMs,
    hash: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function writeManifest(tx, manifest) {
  await ensureDir(tx.root)
  await writeAtomic(path.join(tx.root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

function txFromManifest(manifest) {
  const root = path.join(paths.transactions, manifest.txId)
  return {
    txId: manifest.txId,
    root,
    beforeDir: path.join(root, "before"),
    afterDir: path.join(root, "after"),
    manifest,
  }
}

function encodeSnapshotName(displayPath) {
  return encodeURIComponent(String(displayPath || "file")).replaceAll("%", "_") || "file"
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function nowIso() {
  return new Date().toISOString()
}
