import test from "node:test"
import assert from "node:assert/strict"

import { buildNarratorStyleProbeAddendum } from "../src/workflows/storyInitWorkflow.js"

test("style probe names the narrator model and demands a web search", () => {
  const a = buildNarratorStyleProbeAddendum({ modelName: "kimi-k2-0711" })
  assert.match(a, /kimi-k2-0711/)
  assert.match(a, /WEB SEARCH/i)
  assert.match(a, /口癖/)
  // Bans must land where the narrator actually reads them.
  assert.match(a, /story\/frontend\/forbidden\.md/)
  // Explicitly overrides standard mode's "search sparingly" for this task.
  assert.match(a, /EVEN IN STANDARD MODE/i)
})

test("style probe researches tics in the reader's preferred story language", () => {
  const a = buildNarratorStyleProbeAddendum({ modelName: "kimi-k2-0711" })
  assert.match(a, /LANGUAGE TARGETING IS REQUIRED/)
  assert.match(a, /Default story language/)
  assert.match(a, /reader's preferred story language/)
  assert.match(a, /Chinese searches for Chinese narration/)
  assert.match(a, /English tells.*Chinese \/ Japanese \/ bilingual tells/s)
})

test("style probe falls back to a generic name when the model is unknown", () => {
  const a = buildNarratorStyleProbeAddendum({})
  assert.match(a, /the configured foreground model/)
  assert.doesNotMatch(a, /undefined|null/)
})

test("style probe asks for concrete bans paired with a corrective, not vibes", () => {
  const a = buildNarratorStyleProbeAddendum({ modelName: "x" })
  assert.match(a, /CONCRETE, bannable|signature transition phrases/)
  // each ban must carry its corrective (positive-framing), not be a bare prohibition
  assert.match(a, /pair the ban|in place of|corrective/)
})
