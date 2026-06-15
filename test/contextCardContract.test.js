import test from "node:test"
import assert from "node:assert/strict"

import { validateContextCardContent } from "../src/context/foregroundInserts.js"

test("a fully-specified card produces no warnings", () => {
  const raw = `---
name: The Lighthouse Keeper
kind: character
description: Tends the cliff light; knows the protagonist's debt.
triggers: [keeper, the keeper, lighthouse keeper]
---
A weathered figure who trades silence for favors.`
  assert.deepEqual(validateContextCardContent(raw), [])
})

test("missing triggers is flagged (the load-bearing case)", () => {
  const raw = `---
name: The Keeper
description: Tends the cliff light.
---
Body here.`
  const w = validateContextCardContent(raw)
  assert.equal(w.length, 1)
  assert.match(w[0], /triggers/)
  assert.match(w[0], /fast activation/i)
})

test("missing name, description, triggers, and body all flagged", () => {
  const raw = `---
kind: object
---
`
  const w = validateContextCardContent(raw)
  const joined = w.join("\n")
  assert.match(joined, /name/)
  assert.match(joined, /description/)
  assert.match(joined, /triggers/)
  assert.match(joined, /empty body/)
})

test("non-foreground target is flagged as never-loaded", () => {
  const raw = `---
name: Internal Note
target: background
triggers: [note]
---
Body.`
  const w = validateContextCardContent(raw)
  assert.ok(w.some((x) => /not a foreground card/.test(x)))
})

test("description can come from the body's first paragraph", () => {
  const raw = `---
name: X
triggers: [x]
---
This opening line serves as the description.`
  // No explicit description field, but body has a first paragraph → no
  // description warning.
  const w = validateContextCardContent(raw)
  assert.ok(!w.some((x) => /description/.test(x)))
})
