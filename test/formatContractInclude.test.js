import test from "node:test"
import assert from "node:assert/strict"

import { validateFormatConfig, _internals } from "../src/lib/formatContract.js"

const { sanitizeInclude } = _internals

test("sanitizeInclude: enabled flag is strict boolean; allow defaults to null (all kinds)", () => {
  const issues = []
  assert.deepEqual(sanitizeInclude({ enabled: true }, issues), { enabled: true, allow: null })
  assert.deepEqual(sanitizeInclude({ enabled: "yes" }, issues), { enabled: false, allow: null })
  assert.equal(sanitizeInclude(null, issues), null)
  assert.equal(sanitizeInclude([], issues), null)
})

test("sanitizeInclude: allow keeps known kinds, drops unknown with a notice", () => {
  const issues = []
  const out = sanitizeInclude({ enabled: true, allow: ["image", "VIDEO", "bogus"] }, issues)
  assert.deepEqual(out, { enabled: true, allow: ["image", "video"] })
  assert.ok(issues.some((m) => /bogus/.test(m)))
})

test("validateFormatConfig surfaces the include block", () => {
  const r = validateFormatConfig(JSON.stringify({ version: 1, include: { enabled: true, allow: ["text"] } }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.include, { enabled: true, allow: ["text"] })
})

test("validateFormatConfig: no include block → include is null", () => {
  const r = validateFormatConfig(JSON.stringify({ version: 1 }))
  assert.equal(r.ok, true)
  assert.equal(r.config.include, null)
})
