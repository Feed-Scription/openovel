import assert from "node:assert/strict"
import test from "node:test"

import {
  BILLING_ERROR_RE,
  check,
  createGuardState,
  looksLikeBillingError,
  recordModelCall,
  recordTurn,
} from "../src/eval/probeGuards.js"

test("createGuardState defaults are safe (no ceiling, 5-error streak)", () => {
  const s = createGuardState()
  assert.equal(s.maxCostUSD, 0)
  assert.equal(s.maxConsecutiveErrors, 5)
  assert.equal(s.aborted, false)
  assert.equal(check(s), null)
})

test("cost ceiling fires when cumulative spend reaches the cap", () => {
  const s = createGuardState({ maxCostUSD: 0.10 })
  recordModelCall(s, { ok: true, cost: { estimatedUSD: 0.04 } })
  recordModelCall(s, { ok: true, cost: { estimatedUSD: 0.05 } })
  assert.equal(check(s), null) // 0.09 < 0.10
  recordModelCall(s, { ok: true, cost: { estimatedUSD: 0.02 } })
  const reason = check(s)
  assert.match(reason, /cost_ceiling/)
  assert.equal(s.aborted, true)
})

test("cost ceiling of 0 disables the ceiling entirely", () => {
  const s = createGuardState({ maxCostUSD: 0 })
  recordModelCall(s, { ok: true, cost: { estimatedUSD: 1000 } })
  assert.equal(check(s), null)
  assert.equal(s.aborted, false)
})

test("consecutive provider errors trip after N (default 5)", () => {
  const s = createGuardState({ maxConsecutiveErrors: 3 })
  recordModelCall(s, { ok: false, cost: { estimatedUSD: 0 } })
  recordModelCall(s, { ok: false, cost: { estimatedUSD: 0 } })
  assert.equal(check(s), null)
  recordModelCall(s, { ok: false, cost: { estimatedUSD: 0 } })
  assert.match(check(s), /consecutive_provider_errors_3/)
})

test("provider-error streak resets on any successful call", () => {
  const s = createGuardState({ maxConsecutiveErrors: 3 })
  recordModelCall(s, { ok: false })
  recordModelCall(s, { ok: false })
  recordModelCall(s, { ok: true }) // resets
  recordModelCall(s, { ok: false })
  recordModelCall(s, { ok: false })
  assert.equal(check(s), null) // 2 errors, still under 3
})

test("consecutive narrator errors trip independently of provider errors", () => {
  const s = createGuardState({ maxConsecutiveErrors: 2 })
  recordTurn(s, { turnError: "boom", narration: "" })
  recordTurn(s, { turnError: "boom again", narration: "" })
  assert.match(check(s), /consecutive_turn_errors_2/)
})

test("provider-error-shell narration counts as a turn error (the provider-error shell regression)", () => {
  const s = createGuardState({ maxConsecutiveErrors: 2 })
  // Without the shell-detection regex these provider errors would score as real
  // turns and accumulate a misleading floor score.
  const errShell = "**ERROR**: [deepseek] Provider API 402: {\"error\":{\"message\":\"Insufficient Balance\"}}"
  recordTurn(s, { turnError: null, narration: errShell })
  recordTurn(s, { turnError: null, narration: errShell })
  assert.match(check(s), /consecutive_turn_errors_2/)
})

test("real narration resets the turn-error counter", () => {
  const s = createGuardState({ maxConsecutiveErrors: 2 })
  recordTurn(s, { turnError: "x", narration: "" })
  recordTurn(s, { turnError: null, narration: "Real prose lands here." })
  recordTurn(s, { turnError: "x", narration: "" })
  assert.equal(check(s), null) // streak broken by the real narration
})

test("check() is idempotent — aborted state sticks", () => {
  const s = createGuardState({ maxConsecutiveErrors: 1 })
  recordTurn(s, { turnError: "x", narration: "" })
  const first = check(s)
  const second = check(s)
  assert.equal(first, second)
  assert.equal(s.aborted, true)
})

test("looksLikeBillingError catches every signature we know about", () => {
  // The actual surface area of provider billing-error strings we've observed
  // in the wild. If a provider returns something not on this list, the
  // pre-flight will warn but not throw — by design (only fast-fail on
  // confirmed billing signatures).
  const billingMessages = [
    "Provider API 402: Insufficient Balance",
    "Provider API 401: Unauthorized",
    "insufficient_quota",
    "payment_required",
    "Your billing account has been suspended",
    "402 PAYMENT_REQUIRED",
  ]
  for (const m of billingMessages) {
    assert.ok(BILLING_ERROR_RE.test(m), `expected billing match: ${m}`)
    assert.ok(looksLikeBillingError(new Error(m)), `looksLikeBillingError: ${m}`)
  }
})

test("non-billing errors do NOT trigger the pre-flight regex", () => {
  // Transient / network / rate-limit errors must not fast-fail — they should
  // let the real workload's retry layer handle them. Only confirmed billing
  // errors warrant aborting before init.
  const nonBilling = [
    "fetch failed",
    "ECONNRESET",
    "Provider API 500: Internal Server Error",
    "Provider API 429: rate limited",
    "AbortError: The operation was aborted",
    "socket hang up",
  ]
  for (const m of nonBilling) {
    assert.equal(BILLING_ERROR_RE.test(m), false, `should NOT match: ${m}`)
  }
})
