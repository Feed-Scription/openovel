import test from "node:test"
import assert from "node:assert/strict"

import { extractPrelude } from "../src/lib/prelude.js"
import { STORY_INIT_SYSTEM_PROMPT } from "../src/workflows/storyInitWorkflow.js"

test("extractPrelude returns the body and strips the ## Prelude heading", () => {
  const md = "## Prelude\n少年握紧那枚旧硬币。\n夜色压低了屋檐。\n"
  assert.equal(extractPrelude(md), "少年握紧那枚旧硬币。\n夜色压低了屋檐。")
})

test("extractPrelude stops at the next ## heading", () => {
  const md = "## Prelude\n前情一句。\n\n## Tone\n冷峻、克制。\n"
  assert.equal(extractPrelude(md), "前情一句。")
})

test("extractPrelude finds the Prelude inside a composed foreground guidance", () => {
  const md = "# Foreground\n\n## Prelude\n背景。\n\n## Scene\n当前场景。\n## Constants\n- 事实\n"
  assert.equal(extractPrelude(md), "背景。")
})

test("extractPrelude returns '' when there is no Prelude", () => {
  assert.equal(extractPrelude("## Scene\n只有场景。\n"), "")
  assert.equal(extractPrelude(""), "")
  assert.equal(extractPrelude(null), "")
})

test("extractPrelude is case-insensitive and CRLF-tolerant", () => {
  assert.equal(extractPrelude("## prelude\r\nbody line\r\n## tone\r\nx\r\n"), "body line")
})

test("init guidance frames the Prelude as a reader-facing 序, still spoiler-free", () => {
  const p = String(STORY_INIT_SYSTEM_PROMPT)
  assert.match(p, /序/) // reader-facing preface
  assert.match(p, /READER-FACING|reader-facing|preface/)
  assert.match(p, /spoil/i) // keeps the no-spoiler guardrail
  assert.match(p, /raise the curtain|raise it|opening scene/i) // still doesn't open the story
})
