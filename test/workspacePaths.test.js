import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { displayWorkspacePath, resolveWorkspacePath, workspaceLayout } from "../src/lib/workspacePaths.js"

test("workspace paths separate global home, shared references, and story root", () => {
  const cwd = path.join(os.tmpdir(), "openovel-workspace-test")
  const env = {
    OPENOVEL_HOME: path.join(os.tmpdir(), "openovel-home-test"),
    OPENOVEL_STORY_ID: "suyu-campaign",
  }
  const layout = workspaceLayout({ cwd, env })
  assert.equal(layout.storyRoot, path.join(env.OPENOVEL_HOME, "stories", "suyu-campaign"))
  assert.equal(layout.userMemory, path.join(env.OPENOVEL_HOME, "memory", "USER.md"))
  assert.equal(layout.sharedReferenceIndex, path.join(env.OPENOVEL_HOME, "references", "INDEX.md"))

  const shared = resolveWorkspacePath("shared/history/suzhong.md", { cwd, env })
  assert.equal(shared.displayPath, "shared/history/suzhong.md")
  assert.equal(displayWorkspacePath(layout.userMemory, { cwd, env }), "home/memory/USER.md")
})

test("home/ scope resolves the memory/references/context-card subtrees", () => {
  const cwd = path.join(os.tmpdir(), "openovel-home-scope-test")
  const env = {
    OPENOVEL_HOME: path.join(os.tmpdir(), "openovel-home-scope-home"),
    OPENOVEL_STORY_ID: "s_x",
  }
  const layout = workspaceLayout({ cwd, env })
  // The display paths emitted by the runtime must round-trip back through the
  // resolver — this is the bug that made the storykeeper's reads of
  // home/memory/USER.md fail with "File not found".
  for (const rel of ["home/memory/USER.md", "home/memory/OBSERVED.md", "home/references/INDEX.md", "home/context-cards/x/CARD.md"]) {
    const r = resolveWorkspacePath(rel, { cwd, env })
    assert.equal(r.scope, "home")
    assert.equal(r.displayPath, rel)
    assert.ok(r.path.startsWith(layout.home))
  }
})

test("home/ scope refuses secrets and other stories", () => {
  const cwd = path.join(os.tmpdir(), "openovel-home-deny-test")
  const env = {
    OPENOVEL_HOME: path.join(os.tmpdir(), "openovel-home-deny-home"),
    OPENOVEL_STORY_ID: "s_x",
  }
  for (const rel of [
    "home/settings.local.json",      // API keys
    "home/kimi-device-id",
    "home/electron-prefs.json",
    "home/stories/other/canon/chapters.md", // cross-story leak
    "home/../.ssh/id_rsa",           // traversal escape
  ]) {
    assert.throws(() => resolveWorkspacePath(rel, { cwd, env }), /Refusing to access/, `expected ${rel} to be refused`)
  }
})

test("workspace paths accept legacy ai-story env names", () => {
  const cwd = path.join(os.tmpdir(), "openovel-legacy-workspace-test")
  const env = {
    AI_STORY_HOME: path.join(os.tmpdir(), "legacy-ai-story-home-test"),
    AI_STORY_ID: "legacy-campaign",
  }
  const layout = workspaceLayout({ cwd, env })
  assert.equal(layout.storyRoot, path.join(env.AI_STORY_HOME, "stories", "legacy-campaign"))
  assert.equal(displayWorkspacePath(layout.userMemory, { cwd, env }), "home/memory/USER.md")
})
