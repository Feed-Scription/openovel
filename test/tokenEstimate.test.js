import test from "node:test"
import assert from "node:assert/strict"

import { estimateTokenCount } from "../src/lib/tokenEstimate.js"

test("empty / non-string inputs are 0", () => {
  assert.equal(estimateTokenCount(""), 0)
  assert.equal(estimateTokenCount(null), 0)
  assert.equal(estimateTokenCount(undefined), 0)
})

test("CJK ~1.5 chars/token, Latin ~4 chars/token", () => {
  assert.equal(estimateTokenCount("字".repeat(1500)), 1000) // 1500 / 1.5
  assert.equal(estimateTokenCount("a".repeat(4000)), 1000) // 4000 / 4
})

test("same token budget allows ~2.6x more English chars than Chinese", () => {
  const cjk = estimateTokenCount("字".repeat(6000)) // 4000 tokens
  const latin = estimateTokenCount("a".repeat(6000)) // 1500 tokens
  assert.ok(cjk > latin)
  // The Latin/CJK char-per-token ratio is 4 / 1.5 ≈ 2.67.
  assert.ok(Math.abs(cjk / latin - 4 / 1.5) < 0.01)
})

test("mixed CJK + Latin sums each bucket", () => {
  // 300 CJK (200 tok) + 400 latin (100 tok) = 300
  assert.equal(estimateTokenCount("字".repeat(300) + "a".repeat(400)), 300)
})
