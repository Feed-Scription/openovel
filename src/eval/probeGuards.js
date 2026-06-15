// small standalone state machine for probeWorker abort guards.
// Extracted so the logic is unit-testable without a probeWorker run.
//
// Two failure modes:
//   1. Cost ceiling: cumulative model spend (foreground + background) exceeds
//      a configured cap. Default 0 = no ceiling.
//   2. Consecutive error streak: N back-to-back narrator failures OR
//      provider-side ok=false events. Default 5.
//
// The probeWorker subscribes to `model.call.completed` and feeds each event
// through `recordModelCall`. Between scripted turns it calls `check` to test
// whether either threshold is met. Aborted cells override the final probe
// verdict with `aborted` so downstream aggregation can filter them out
// instead of averaging in a meaningless score derived from an incomplete
// transcript.

export function createGuardState({ maxCostUSD = 0, maxConsecutiveErrors = 5 } = {}) {
  return {
    maxCostUSD: Math.max(0, Number(maxCostUSD) || 0),
    maxConsecutiveErrors: Math.max(1, Number(maxConsecutiveErrors) || 5),
    consumedCostUSD: 0,
    consecutiveProviderErrors: 0,
    consecutiveTurnErrors: 0,
    aborted: false,
    abortReason: null,
  }
}

// Apply one model.call.completed event to the guard state. Resets the
// provider-error counter on any success.
export function recordModelCall(state, { ok, cost } = {}) {
  state.consumedCostUSD += Number(cost?.estimatedUSD) || 0
  if (ok === false) state.consecutiveProviderErrors++
  else state.consecutiveProviderErrors = 0
}

// Apply one turn outcome. A turn is an "error turn" if sessionProcessor threw,
// the narration was empty, or the narration body is the canonical provider-
// error shell (`[provider] Provider API <code>: ...`). Without this guard, a
// provider-error shell can look like ordinary narration to downstream scoring.
export function recordTurn(state, { turnError, narration } = {}) {
  const looksLikeProviderError = /\bProvider API \d{3}\b/.test(narration || "")
  if (turnError || !narration || looksLikeProviderError) {
    state.consecutiveTurnErrors++
  } else {
    state.consecutiveTurnErrors = 0
  }
}

// Returns null when healthy; otherwise an abort reason string and sets
// state.aborted. Idempotent — once aborted the same reason is returned.
export function check(state) {
  if (state.aborted) return state.abortReason
  if (state.maxCostUSD > 0 && state.consumedCostUSD >= state.maxCostUSD) {
    state.aborted = true
    state.abortReason = `cost_ceiling_${state.maxCostUSD}USD`
    return state.abortReason
  }
  if (state.consecutiveTurnErrors >= state.maxConsecutiveErrors) {
    state.aborted = true
    state.abortReason = `consecutive_turn_errors_${state.maxConsecutiveErrors}`
    return state.abortReason
  }
  if (state.consecutiveProviderErrors >= state.maxConsecutiveErrors) {
    state.aborted = true
    state.abortReason = `consecutive_provider_errors_${state.maxConsecutiveErrors}`
    return state.abortReason
  }
  return null
}

// Pre-flight: regex against known billing-error signatures across providers.
// Exported separately so it can be unit-tested without making a real network
// call. Catches:
//   - HTTP 401 / 402 status codes in error messages
//   - DeepSeek "Insufficient Balance"
//   - OpenAI "insufficient_quota"
//   - Generic "billing" / "payment_required"
export const BILLING_ERROR_RE = /\b40[12]\b|Insufficient Balance|insufficient_quota|billing|payment_required/i

export function looksLikeBillingError(error) {
  if (!error) return false
  return BILLING_ERROR_RE.test(String(error?.message || error))
}
