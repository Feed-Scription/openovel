import { createHash } from "node:crypto"
import { stat, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export const FILE_NOT_READ_CODE = "OPENOVEL_FILE_NOT_READ"
export const STALE_WRITE_CODE = "OPENOVEL_STALE_WRITE"

export class FileStateCache {
  #entries = new Map()

  set(filePath, state) {
    this.#entries.set(normalizePath(filePath), { ...state, path: normalizePath(filePath) })
  }

  get(filePath) {
    return this.#entries.get(normalizePath(filePath)) || null
  }

  delete(filePath) {
    this.#entries.delete(normalizePath(filePath))
  }
}

export async function captureFileState(filePath, { isFullRead = false } = {}) {
  const resolved = normalizePath(filePath)
  if (!existsSync(resolved)) {
    return { path: resolved, exists: false, isFullRead, size: 0, mtimeMs: 0, hash: "" }
  }
  const info = await stat(resolved)
  if (!info.isFile()) {
    return { path: resolved, exists: false, isFullRead, size: info.size, mtimeMs: info.mtimeMs, hash: "" }
  }
  const bytes = await readFile(resolved)
  return {
    path: resolved,
    exists: true,
    isFullRead,
    size: info.size,
    mtimeMs: info.mtimeMs,
    hash: sha256(bytes),
  }
}

export async function rememberReadFileState(cache, filePath, { isFullRead = false } = {}) {
  if (!cache) return null
  const state = await captureFileState(filePath, { isFullRead })
  cache.set(filePath, state)
  return state
}

export async function assertFreshWritableFile({ cache, filePath, existed, displayPath }) {
  if (!existed) return true
  const target = displayPath || filePath
  const state = cache?.get?.(filePath)
  if (!state?.isFullRead) {
    throw fileWriteError(
      FILE_NOT_READ_CODE,
      `Refusing to modify ${target}: you must fully read an existing file before write/edit. A partial read (offset/limit) or no read does not authorize a modification. Call read with full=true first, e.g. read({ filePath: "${target}", full: true }), then retry the write/edit.`,
    )
  }
  const current = await captureFileState(filePath, { isFullRead: true })
  if (!current.exists || current.size !== state.size || current.mtimeMs !== state.mtimeMs || current.hash !== state.hash) {
    throw fileWriteError(
      STALE_WRITE_CODE,
      `Refusing to modify ${target}: the file changed on disk since your last full read, so a write now would clobber those changes. Re-read it with full=true, e.g. read({ filePath: "${target}", full: true }), reconcile your edit against the current contents, then retry.`,
    )
  }
  return true
}

export async function updateWrittenFileState(cache, filePath) {
  if (!cache) return null
  const state = await captureFileState(filePath, { isFullRead: true })
  cache.set(filePath, state)
  return state
}

function fileWriteError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizePath(filePath) {
  return path.resolve(filePath)
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
