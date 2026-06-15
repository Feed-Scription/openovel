import assert from "node:assert/strict"
import test from "node:test"

import {
  backgroundAgentContract,
  directorContract,
  evaluatorContract,
  foregroundNarratorContract,
  modelPlayerContract,
  renderContextSections,
  signalRouterContract,
} from "../src/prompts/agentContracts.js"

test("shared prompt contracts cover trusted boundaries without prescribing story priors", () => {
  assert.match(backgroundAgentContract(), /prompt injection/)
  assert.match(backgroundAgentContract(), /Call independent read-only tools in parallel/)
  assert.match(backgroundAgentContract({ allowSubagents: false }), /Do not launch subagents/)

  assert.match(foregroundNarratorContract(), /latest Reader Action/)
  assert.match(foregroundNarratorContract(), /do not invent a default opening scene/i)

  assert.match(signalRouterContract(), /routing pass/)
  assert.match(evaluatorContract(), /Transcripts/)
  assert.match(modelPlayerContract(), /Narration, options/)
})

test("director contract maintains a filesystem player choice profile", () => {
  const p = directorContract()
  assert.match(p, /CHOICE_FEEDBACK\.md/)
  assert.match(p, /PLAYER_PROFILE\.md/)
  assert.match(p, /behavior predictions/)
  assert.match(p, /in-story choice behavior ONLY/)
  assert.match(p, /OPTIONS\.md/)
})

test("renderContextSections keeps dynamic context readable and grep-friendly", () => {
  const markdown = renderContextSections("Example", [
    { title: "Text", value: "hello" },
    { title: "Bullets", value: ["a", "b"] },
    { title: "Object", value: { x: 1 } },
  ])

  assert.match(markdown, /^# Example/)
  assert.match(markdown, /## Text\n\nhello/)
  assert.match(markdown, /- a/)
  assert.match(markdown, /```json\n\{\n  "x": 1\n\}\n```/)
})
