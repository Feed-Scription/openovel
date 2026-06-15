import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import { expandForegroundIncludes } from "../src/lib/foregroundCompose.js"

async function newWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "openovel-fg-bin-"))
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  process.env.OPENOVEL_HOME = path.join(root, "home")
  await initializeStory()
  return root
}

test("@include refuses media, oversized, and binary bodies (text only reaches the foreground)", async () => {
  await newWorkspace()
  // A media extension is refused before the read (the file need not exist);
  // a real binary with an unknown extension is caught by the content sniff;
  // an oversized text file is refused on size; plain text still expands.
  await mkdir(path.join(paths.root, "includes"), { recursive: true })
  await writeFile(path.join(paths.root, "includes", "blob.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]))
  await writeFile(path.join(paths.root, "includes", "huge.md"), "x".repeat(300 * 1024), "utf8")
  await writeFile(path.join(paths.root, "includes", "ok.md"), "plain text body", "utf8")
  const out = await expandForegroundIncludes([
    "@include story/includes/bg/scene.jpg",
    "@include story/includes/blob.dat",
    "@include story/includes/huge.md",
    "@include story/includes/ok.md",
  ].join("\n"))
  assert.match(out, /include skipped: story\/includes\/bg\/scene\.jpg is image/)
  assert.match(out, /ovl:include fence/)
  assert.match(out, /include skipped: story\/includes\/blob\.dat is binary/)
  assert.match(out, /include skipped: story\/includes\/huge\.md is 300KB, over the 256KB/)
  assert.match(out, /plain text body/)
  // No raw bytes and no live directive lines leak into the composed view
  // (the diagnostic comments may mention @include in prose).
  assert.doesNotMatch(out, /^\s*@include /m)
  assert.doesNotMatch(out, new RegExp(String.fromCharCode(0)))
})

test("@include lines inside fenced examples pass through verbatim (ovl:include demos survive)", async () => {
  await newWorkspace()
  await mkdir(path.join(paths.root, "includes"), { recursive: true })
  await writeFile(path.join(paths.root, "includes", "ok.md"), "expanded text", "utf8")
  const out = await expandForegroundIncludes([
    "Use the render-time fence like this:",
    "```ovl:include",
    "@include story/includes/bg/night.jpg",
    "alt: a quiet alley",
    "```",
    "And a wrapped demo of the demo:",
    "````markdown",
    "```ovl:include",
    "@include story/includes/bg/dawn.jpg",
    "```",
    "````",
    "@include story/includes/ok.md",
  ].join("\n"))
  // Example directives inside fences reach the narrator untouched...
  assert.match(out, /```ovl:include\n@include story\/includes\/bg\/night\.jpg\nalt: a quiet alley\n```/)
  assert.match(out, /@include story\/includes\/bg\/dawn\.jpg/)
  assert.doesNotMatch(out, /include skipped/)
  // ...while the real top-level directive after the fences still expands.
  assert.match(out, /expanded text/)
})
