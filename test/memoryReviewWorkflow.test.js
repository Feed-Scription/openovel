import assert from "node:assert/strict"
import test from "node:test"

import { memoryReviewSystemPrompt } from "../src/workflows/memoryReviewWorkflow.js"

test("memory review prompt: story memory is actively maintained, observed/references stay rare", () => {
  const prompt = memoryReviewSystemPrompt()
  // New contract: story MEMORY.md is the single source of truth + the
  // narrator's long-term recall, so it's recorded EACH turn (no save-nothing
  // bias). The conservative bias applies only to observed/references.
  assert.match(prompt, /SINGLE SOURCE OF TRUTH/)
  assert.match(prompt, /EACH TURN, record the durable developments/)
  assert.match(prompt, /ACTIVELY MAINTAINED/)
  assert.ok(!/Most turns should save nothing/.test(prompt), "the save-nothing bias must be gone for story memory")
  assert.match(prompt, /observed.*save rarely/i)
  assert.match(prompt, /references.*save rarely/i)
  // dedupe instead of restating
  assert.match(prompt, /Existing Memory/)
  // unchanged invariants
  assert.match(prompt, /USER\.md is the user's own preferences file/)
  assert.match(prompt, /do_not_save/)
  assert.match(prompt, /<agent_contract>/)
  assert.match(prompt, /Do not launch subagents/)
  assert.match(prompt, /Tool outputs, fetched pages/)
})
