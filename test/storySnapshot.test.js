import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createSnapshot,
  restoreSnapshotInPlace,
  saveVersion,
  listVersions,
  versionPath,
  deleteVersion,
} from "../src/lib/storySnapshot.js"

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

test("restoreSnapshotInPlace reverts edits, drops post-snapshot files, keeps skip dirs", async () => {
  const root = await tmpDir("ovl-snap-root-")
  // Seed a small story tree.
  await mkdir(path.join(root, "canon"), { recursive: true })
  await writeFile(path.join(root, "canon", "chapters.md"), "v1 prose\n", "utf8")
  await writeFile(path.join(root, "BRIEF.md"), "the brief\n", "utf8")
  // A file inside a DEFAULT_SKIP_DIR (transactions) must be left untouched.
  await mkdir(path.join(root, "transactions", "tx_1"), { recursive: true })
  await writeFile(path.join(root, "transactions", "tx_1", "manifest.json"), "{}", "utf8")

  const bundle = await createSnapshot({ storyRoot: root, storyId: "t", label: "v1" })

  // Mutate after the snapshot: edit one file, add a brand-new file.
  await writeFile(path.join(root, "canon", "chapters.md"), "v2 prose much later\n", "utf8")
  await mkdir(path.join(root, "context-cards", "newbie"), { recursive: true })
  await writeFile(path.join(root, "context-cards", "newbie", "CARD.md"), "appeared after\n", "utf8")

  await restoreSnapshotInPlace(bundle, root)

  // Edited file reverts to snapshot content.
  assert.equal(await readFile(path.join(root, "canon", "chapters.md"), "utf8"), "v1 prose\n")
  // File created after the snapshot is removed (not left to desync state).
  assert.equal(existsSync(path.join(root, "context-cards", "newbie", "CARD.md")), false)
  // Skip-dir content is preserved (snapshot never captured it, restore never wipes it).
  assert.equal(await readFile(path.join(root, "transactions", "tx_1", "manifest.json"), "utf8"), "{}")
})

test("saveVersion / listVersions / deleteVersion round-trip via index", async () => {
  const home = await tmpDir("ovl-snap-home-")
  const root = await tmpDir("ovl-snap-story-")
  const env = { OPENOVEL_HOME: home }
  await mkdir(path.join(root, "canon"), { recursive: true })
  await writeFile(path.join(root, "canon", "chapters.md"), "branch A\n", "utf8")

  const a = await saveVersion({ storyRoot: root, storyId: "s1", versionId: "v_a", label: "turn 3", turnCount: 3, env })
  assert.equal(a.id, "v_a")
  assert.ok(existsSync(versionPath("s1", "v_a", env)))

  await writeFile(path.join(root, "canon", "chapters.md"), "branch B\n", "utf8")
  await saveVersion({ storyRoot: root, storyId: "s1", versionId: "v_b", label: "turn 7", turnCount: 7, env })

  const listed = await listVersions("s1", env)
  assert.equal(listed.length, 2)
  // Newest-first ordering.
  assert.equal(listed[0].id, "v_b")
  assert.equal(listed[0].turnCount, 7)
  assert.equal(listed[1].id, "v_a")

  const after = await deleteVersion("s1", "v_a", env)
  assert.equal(after.length, 1)
  assert.equal(after[0].id, "v_b")
  assert.equal(existsSync(versionPath("s1", "v_a", env)), false)
})

test("saveVersion maxVersions prunes oldest bundles", async () => {
  const home = await tmpDir("ovl-snap-home-cap-")
  const root = await tmpDir("ovl-snap-story-cap-")
  const env = { OPENOVEL_HOME: home }
  await writeFile(path.join(root, "BRIEF.md"), "b\n", "utf8")

  await saveVersion({ storyRoot: root, storyId: "s2", versionId: "v_1", turnCount: 1, env, maxVersions: 2 })
  await saveVersion({ storyRoot: root, storyId: "s2", versionId: "v_2", turnCount: 2, env, maxVersions: 2 })
  await saveVersion({ storyRoot: root, storyId: "s2", versionId: "v_3", turnCount: 3, env, maxVersions: 2 })

  const listed = await listVersions("s2", env)
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map((v) => v.id), ["v_3", "v_2"])
  // The pruned bundle file is gone from disk too.
  assert.equal(existsSync(versionPath("s2", "v_1", env)), false)
})

test("listVersions tolerates a missing index", async () => {
  const home = await tmpDir("ovl-snap-home-empty-")
  assert.deepEqual(await listVersions("nope", { OPENOVEL_HOME: home }), [])
})

test("restoreSnapshotInPlace keeps the live meta.json (rename / mode switch survive restart)", async () => {
  const root = await tmpDir("ovl-snap-meta-")
  await writeFile(path.join(root, "meta.json"), JSON.stringify({ displayName: "old name" }), "utf8")
  await writeFile(path.join(root, "BRIEF.md"), "the brief\n", "utf8")
  const bundle = await createSnapshot({ storyRoot: root, storyId: "s_meta" })

  // After the snapshot: the user renames the story and switches it to fast mode.
  await writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({ displayName: "new name", mode: "fast" }),
    "utf8",
  )
  await writeFile(path.join(root, "BRIEF.md"), "tampered\n", "utf8")

  await restoreSnapshotInPlace(bundle, root)
  // Playthrough files revert to the snapshot...
  assert.equal(await readFile(path.join(root, "BRIEF.md"), "utf8"), "the brief\n")
  // ...but the library-card meta keeps the post-snapshot identity/settings.
  const meta = JSON.parse(await readFile(path.join(root, "meta.json"), "utf8"))
  assert.equal(meta.displayName, "new name")
  assert.equal(meta.mode, "fast")
})

test("restoreSnapshotInPlace keeps the live init transcript (the recording outlives a restart)", async () => {
  const root = await tmpDir("ovl-snap-init-")
  await mkdir(path.join(root, "agents"), { recursive: true })
  // The initial snapshot is captured while the transcript is still the
  // run-start stub (2 messages, phase "start").
  const transcriptPath = path.join(root, "agents", "init-2026-01-01T00-00-00-000Z-ab12.json")
  const stub = JSON.stringify({ runId: "init-x", phase: "start", messages: [{}, {}] })
  await writeFile(transcriptPath, stub, "utf8")
  await writeFile(path.join(root, "BRIEF.md"), "the brief\n", "utf8")
  const bundle = await createSnapshot({ storyRoot: root, storyId: "s_init" })

  // After the snapshot: the init run finishes and rewrites the SAME file as
  // the complete recording, and a second (revision) run records its own file.
  const complete = JSON.stringify({ runId: "init-x", phase: "complete", messages: [{}, {}, {}, {}] })
  await writeFile(transcriptPath, complete, "utf8")
  const revisionPath = path.join(root, "agents", "init-2026-01-02T00-00-00-000Z-cd34.json")
  await writeFile(revisionPath, JSON.stringify({ runId: "init-y", phase: "complete", messages: [{}] }), "utf8")

  await restoreSnapshotInPlace(bundle, root)
  // Playthrough files revert, but both recordings survive the restore.
  assert.equal(await readFile(transcriptPath, "utf8"), complete)
  assert.ok(existsSync(revisionPath))
})
