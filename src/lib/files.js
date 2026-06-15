import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

// atomic write via temp file + rename. POSIX rename(2) is
// atomic when source/destination are on the same filesystem. Protects against
// half-written files when the writer is interrupted mid-stream (process kill,
// disk full, etc.). Use for any file whose readers must never see a torn write.
export async function writeAtomic(file, value) {
  await ensureDir(path.dirname(file))
  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  try {
    await writeFile(tempPath, value, "utf8")
    await rename(tempPath, file)
  } catch (error) {
    // Best-effort cleanup of the staged temp file
    try {
      await unlink(tempPath)
    } catch {
      // ignore cleanup failure
    }
    throw error
  }
}

// Atomic binary write (temp + rename), no encoding — for image/media bytes.
// Separate from writeAtomic (which is utf8) so a Buffer is never stringified.
export async function writeBinary(file, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("writeBinary expects a Buffer")
  await ensureDir(path.dirname(file))
  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  try {
    await writeFile(tempPath, buffer)
    await rename(tempPath, file)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // ignore cleanup failure
    }
    throw error
  }
}

export async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  const text = await readFile(file, "utf8")
  return JSON.parse(text)
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file))
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" })
}

export async function readText(file, fallback = "") {
  if (!existsSync(file)) return fallback
  return readFile(file, "utf8")
}

// read only the trailing N bytes of a file as utf-8 text. Used for
// append-only logs (chapters.md, scene_log.jsonl) where consumers downstream
// only need the recent tail — loading the full file is wasteful (memory) and
// scales linearly with session length, working against the 100h stability
// goal. The first read byte is aligned to a utf-8 character boundary by
// trimming any leading continuation byte, so the returned string is always
// valid utf-8. If the file is smaller than maxBytes, returns the whole file.
export async function readTailText(file, maxBytes, fallback = "") {
  if (!existsSync(file)) return fallback
  const info = await stat(file)
  if (info.size === 0) return fallback
  if (info.size <= maxBytes) return readFile(file, "utf8")
  const start = info.size - maxBytes
  const fh = await open(file, "r")
  try {
    const buf = Buffer.alloc(maxBytes)
    await fh.read(buf, 0, maxBytes, start)
    // utf-8 continuation bytes start with 10xxxxxx (0x80-0xBF). Step forward
    // until we find a leading byte (anything that is not 10xxxxxx). Bounded
    // to 4 bytes since a utf-8 character is at most 4 bytes.
    let offset = 0
    while (offset < 4 && offset < buf.length && (buf[offset] & 0xc0) === 0x80) {
      offset++
    }
    return buf.toString("utf8", offset)
  } finally {
    await fh.close()
  }
}

export async function writeText(file, value) {
  await ensureDir(path.dirname(file))
  await writeFile(file, value, "utf8")
}

// append text without reading the existing file. O(1) per call
// regardless of file size. The caller is responsible for any leading
// separator (newline, blank line, header) — we just write the bytes through.
// Use this for append-only canon files where read-modify-write loops would
// otherwise become O(N²) over a long session.
export async function appendText(file, value) {
  await ensureDir(path.dirname(file))
  await writeFile(file, value, { encoding: "utf8", flag: "a" })
}
