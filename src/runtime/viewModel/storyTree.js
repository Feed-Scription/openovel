import { stat, readdir } from "node:fs/promises"
import path from "node:path"

// Walk the active story root up to `maxDepth` levels deep and return a flat
// list suitable for a side-pane ls-style render. Each entry:
//   { rel, name, isDir, size, depth, mtimeMs }
//
// rel is the slash-joined relative path from `root`. Hidden files and known
// noisy directories are skipped. Large directories are truncated at maxItems.
export async function walkStoryTree(root, { maxDepth = 2, maxItems = 80 } = {}) {
  const entries = []
  if (!root) return entries
  try {
    const rootStat = await stat(root).catch(() => null)
    if (!rootStat || !rootStat.isDirectory()) return entries
  } catch {
    return entries
  }
  await walk(root, "", 0, maxDepth, entries, maxItems)
  return entries
}

async function walk(absDir, relDir, depth, maxDepth, out, maxItems) {
  if (out.length >= maxItems) return
  if (depth > maxDepth) return
  let names
  try {
    names = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  names.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  // Two-pass: push every entry at THIS level first, then recurse. Keeps
  // root-level files (BRIEF.md, meta.json) visible when the budget fills up
  // inside deep subdirectories. A pure DFS would push all root dirs, recurse
  // greedily, and truncate root-level files at the bottom.
  const dirs = []
  for (const dirent of names) {
    if (out.length >= maxItems) break
    if (dirent.name.startsWith(".")) continue
    const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
    const abs = path.join(absDir, dirent.name)
    let size = 0
    let mtimeMs = 0
    try {
      const s = await stat(abs)
      size = s.size
      mtimeMs = s.mtimeMs
    } catch { /* ignore */ }
    out.push({
      rel,
      name: dirent.name,
      isDir: dirent.isDirectory(),
      size,
      depth,
      mtimeMs,
    })
    if (dirent.isDirectory()) dirs.push({ abs, rel })
  }
  for (const d of dirs) {
    if (out.length >= maxItems) break
    await walk(d.abs, d.rel, depth + 1, maxDepth, out, maxItems)
  }
}

export function formatBytes(n) {
  if (!n || n < 1) return ""
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / (1024 * 1024)).toFixed(1)}M`
}
