// Node-side resolver behind the `ovl-asset://` custom protocol (see
// src/electron/main.js). This is THE trust boundary for render-time includes:
// the directive path comes from model output, so every request is re-validated
// here before any byte leaves the disk — the media analogue of cssSanitizer.js.
//
// Kept separate from main.js (and free of Electron imports) so the resolve/
// reject decision is unit-testable: inject `storyPathsFn` + `realpath` to avoid
// touching the real workspace / filesystem.

import path from "node:path"
import { realpathSync } from "node:fs"
import { classifyInclude, isUnderIncludes, isUnsafeIncludePath, relFromAssetUrl } from "./includePaths.js"
import { storyPaths } from "./workspacePaths.js"

function isInsideDir(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function realpathSafe(p) {
  try { return realpathSync(p) } catch { return null }
}

// Resolve an incoming ovl-asset URL to a validated absolute file path under the
// active story's includes dir. Returns { ok: true, path } or
// { ok: false, reason }. Layered checks:
//   1. URL must decode to a workspace-relative path.
//   2. Path safety (no .., no absolute) + must live under story/includes/.
//   3. Extension must be in the served allowlist (image/video/audio/text).
//   4. Lexical containment under includesDir.
//   5. realpath containment — defeats symlink escapes; a missing file → 404.
export function resolveIncludeAssetUrl(url, { storyPathsFn = storyPaths, realpath = realpathSafe } = {}) {
  const rel = relFromAssetUrl(url)
  if (!rel) return { ok: false, reason: "not an ovl-asset url" }
  if (isUnsafeIncludePath(rel) || !isUnderIncludes(rel)) return { ok: false, reason: "path outside story/includes/" }
  if (classifyInclude(rel) === "unknown") return { ok: false, reason: "unsupported file type" }

  const includesDir = storyPathsFn().includesDir
  // rel is "story/includes/<sub...>"; strip the two scope segments and join.
  const sub = rel.split("/").slice(2).join("/")
  const target = path.resolve(includesDir, sub)
  if (!isInsideDir(target, includesDir)) return { ok: false, reason: "escapes includes dir" }

  const real = realpath(target)
  if (real === null) return { ok: false, reason: "not found" }
  const realDir = realpath(includesDir) ?? includesDir
  if (!isInsideDir(real, realDir)) return { ok: false, reason: "symlink escapes includes dir" }
  return { ok: true, path: real }
}

export const _internals = { isInsideDir }
