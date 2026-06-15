import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { resolveIncludeAssetUrl } from "../src/lib/includeAsset.js"
import { assetUrl } from "../src/lib/includePaths.js"

const INCLUDES = "/tmp/story-xyz/includes"
const storyPathsFn = () => ({ includesDir: INCLUDES })
// identity realpath: file "exists" and resolves to itself (no symlink escape).
const realpathId = (p) => p

test("resolves a valid in-folder asset to an absolute path", () => {
  const r = resolveIncludeAssetUrl(assetUrl("story/includes/scenes/a.png"), { storyPathsFn, realpath: realpathId })
  assert.equal(r.ok, true)
  assert.equal(r.path, path.join(INCLUDES, "scenes/a.png"))
})

test("refuses paths outside story/includes/", () => {
  const r = resolveIncludeAssetUrl(assetUrl("story/canon/secret.md"), { storyPathsFn, realpath: realpathId })
  assert.equal(r.ok, false)
})

test("refuses unsupported extensions", () => {
  const r = resolveIncludeAssetUrl(assetUrl("story/includes/evil.exe"), { storyPathsFn, realpath: realpathId })
  assert.equal(r.ok, false)
  assert.match(r.reason, /unsupported/i)
})

test("refuses non-ovl-asset URLs", () => {
  const r = resolveIncludeAssetUrl("https://evil.example/a.png", { storyPathsFn, realpath: realpathId })
  assert.equal(r.ok, false)
})

test("missing file (realpath null) → not found", () => {
  const r = resolveIncludeAssetUrl(assetUrl("story/includes/a.png"), { storyPathsFn, realpath: () => null })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not found/i)
})

test("symlink that escapes the includes dir is rejected", () => {
  // realpath resolves the file to a location OUTSIDE includesDir.
  const realpath = (p) => (p === INCLUDES ? INCLUDES : "/etc/passwd")
  const r = resolveIncludeAssetUrl(assetUrl("story/includes/a.png"), { storyPathsFn, realpath })
  assert.equal(r.ok, false)
  assert.match(r.reason, /escapes/i)
})
