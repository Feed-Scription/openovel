import assert from "node:assert/strict"
import test from "node:test"

import { isTransientError, withRetry } from "../src/lib/retry.js"

test("isTransientError recognizes aborted / 5xx / rate-limit / fetch-failed", () => {
  assert.equal(isTransientError(new Error("This operation was aborted")), true)
  assert.equal(isTransientError(new Error("Provider API 503: upstream failed")), true)
  assert.equal(isTransientError(new Error("fetch failed")), true)
  assert.equal(isTransientError(new Error("ECONNRESET")), true)
  assert.equal(isTransientError(new Error("Too Many Requests")), true)
  assert.equal(isTransientError(new Error("rate limit reached")), true)
  assert.equal(isTransientError(new Error("socket hang up")), true)
  // undici "terminated" — observed during storyInit deep-mode runs
  // where DeepSeek closes the HTTP/2 stream mid-flight on large-context calls
  assert.equal(isTransientError(new Error("terminated")), true)
  assert.equal(isTransientError(new Error("[deepseek] terminated mid-stream")), true)
  // Both of our own AbortController deadline messages are transient/retryable.
  assert.equal(isTransientError(new Error("overall timeout after 20000ms")), true)
  assert.equal(isTransientError(new Error("stream stalled for 30000ms")), true)
  // explicit .status hints
  const err429 = new Error("rate limited"); err429.status = 429
  assert.equal(isTransientError(err429), true)
  const err503 = new Error("server"); err503.status = 503
  assert.equal(isTransientError(err503), true)
  // AbortError name
  const ab = new Error("aborted"); ab.name = "AbortError"
  assert.equal(isTransientError(ab), true)
  // NON-transient
  assert.equal(isTransientError(new Error("Bad JSON parse")), false)
  assert.equal(isTransientError(new Error("Provider API 400: bad request")), false)
  const err404 = new Error("not found"); err404.status = 404
  assert.equal(isTransientError(err404), false)
})

test("withRetry retries transient errors with exponential backoff", async () => {
  let attempts = 0
  const out = await withRetry(
    async (n) => {
      attempts = n
      if (n < 3) throw new Error("[deepseek] This operation was aborted")
      return { ok: true, attempt: n }
    },
    { maxAttempts: 5, baseDelayMs: 5, label: "test" },
  )
  assert.equal(attempts, 3)
  assert.deepEqual(out, { ok: true, attempt: 3 })
})

test("withRetry does NOT retry non-transient errors", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          throw new Error("Bad JSON: unexpected token")
        },
        { maxAttempts: 5, baseDelayMs: 5, label: "non-transient" },
      ),
    /Bad JSON/,
  )
  assert.equal(calls, 1)
})

test("withRetry honors custom isRetryable predicate", async () => {
  let calls = 0
  const out = await withRetry(
    async () => {
      calls += 1
      if (calls === 1) throw new Error("custom transient marker")
      return "recovered"
    },
    {
      maxAttempts: 3,
      baseDelayMs: 5,
      label: "custom",
      isRetryable: (err) => String(err.message).includes("custom transient marker"),
    },
  )
  assert.equal(out, "recovered")
  assert.equal(calls, 2)
})

test("withRetry honors onRetry callback in lieu of console.warn", async () => {
  const events = []
  let calls = 0
  await withRetry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error("aborted")
      return "ok"
    },
    {
      maxAttempts: 5,
      baseDelayMs: 5,
      label: "with-callback",
      onRetry: (info) => events.push({ attempt: info.attempt, delay: info.delay }),
    },
  )
  assert.equal(events.length, 2)
  // exponential backoff: 5ms then 10ms
  assert.equal(events[0].delay, 5)
  assert.equal(events[1].delay, 10)
})

test("withRetry caps delay at maxDelayMs", async () => {
  const delays = []
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          throw new Error("aborted")
        },
        {
          maxAttempts: 4,
          baseDelayMs: 100,
          maxDelayMs: 150,
          label: "cap",
          onRetry: (info) => delays.push(info.delay),
        },
      ),
  )
  // base 100 → 100, 150 (capped), 150 (capped)
  assert.deepEqual(delays, [100, 150, 150])
})
