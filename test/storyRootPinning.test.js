import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"

const { runPinnedToStoryRoot, pinnedStoryRoot } = await import("../src/lib/storyContext.js")
const { resolveWorkspacePath } = await import("../src/lib/workspacePaths.js")

const A = path.resolve("/tmp/openovel-pin-A")
const B = path.resolve("/tmp/openovel-pin-B")
const C = path.resolve("/tmp/openovel-pin-C")

test("a pinned job resolves story paths to its OWN root despite a mid-run env flip", async () => {
  // Reader has switched the active story to B (switchActiveStory mutates env).
  process.env.OPENOVEL_STORY_ROOT = B
  delete process.env.OPENOVEL_STORY_ID

  // Outside any pin → follows the live env (B), not A.
  assert.equal(pinnedStoryRoot(), "")
  assert.ok(resolveWorkspacePath("story/foreground/10-scene.md").path.startsWith(B))

  // A background job pinned to A keeps resolving to A — even as env flips again.
  await runPinnedToStoryRoot(A, async () => {
    assert.equal(pinnedStoryRoot(), A)
    assert.ok(resolveWorkspacePath("story/foreground/10-scene.md").path.startsWith(A))
    await new Promise((r) => setTimeout(r, 5)) // pin survives awaits
    process.env.OPENOVEL_STORY_ROOT = C        // another switch mid-run
    assert.ok(resolveWorkspacePath("story/canon/scene_log.jsonl").path.startsWith(A))
  })

  // After the job, resolution follows the live env again.
  assert.equal(pinnedStoryRoot(), "")
  assert.ok(resolveWorkspacePath("story/foreground/10-scene.md").path.startsWith(C))
  delete process.env.OPENOVEL_STORY_ROOT
})

test("falsy root is a pass-through (no pin established)", () => {
  let inside = "sentinel"
  runPinnedToStoryRoot("", () => { inside = pinnedStoryRoot() })
  assert.equal(inside, "")
})

test("concurrent pins don't bleed into each other", async () => {
  await Promise.all([
    runPinnedToStoryRoot(A, async () => {
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(pinnedStoryRoot(), A)
    }),
    runPinnedToStoryRoot(B, async () => {
      await new Promise((r) => setTimeout(r, 5))
      assert.equal(pinnedStoryRoot(), B)
    }),
  ])
})
