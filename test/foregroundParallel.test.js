import assert from "node:assert/strict"
import test from "node:test"

import { ForegroundParallelRegistry } from "../src/runtime/foregroundParallel.js"

test("ForegroundParallelRegistry fires all registered handlers concurrently", async () => {
  const reg = new ForegroundParallelRegistry()
  const order = []
  reg.register({
    id: "fast",
    run: async () => {
      order.push("fast-start")
      await new Promise((r) => setTimeout(r, 5))
      order.push("fast-end")
      return { who: "fast" }
    },
  })
  reg.register({
    id: "slow",
    run: async () => {
      order.push("slow-start")
      await new Promise((r) => setTimeout(r, 25))
      order.push("slow-end")
      return { who: "slow" }
    },
  })
  const results = reg.fireAll({ action: "go", snapshot: {}, ablations: {} })
  const [fast, slow] = await Promise.all([results.get("fast"), results.get("slow")])
  assert.deepEqual(fast, { who: "fast" })
  assert.deepEqual(slow, { who: "slow" })
  // Both started before either finished → truly concurrent
  assert.deepEqual(order.slice(0, 2).sort(), ["fast-start", "slow-start"])
})

test("ForegroundParallelRegistry honors isDisabled and uses fallback when disabled", async () => {
  const reg = new ForegroundParallelRegistry()
  let ran = false
  reg.register({
    id: "signal",
    isDisabled: (ablations) => ablations.disableSignal === true,
    run: async () => {
      ran = true
      return { needsBackground: true }
    },
    fallback: ({ disabled }) => ({ needsBackground: false, source: "disabled", wasDisabled: disabled }),
  })
  const results = reg.fireAll({ action: "x", snapshot: {}, ablations: { disableSignal: true } })
  const signal = await results.get("signal")
  assert.equal(ran, false, "run() must not be called when isDisabled returns true")
  assert.deepEqual(signal, { needsBackground: false, source: "disabled", wasDisabled: true })
})

test("ForegroundParallelRegistry isolates handler failures (one throw doesn't reject others)", async () => {
  const reg = new ForegroundParallelRegistry()
  reg.register({
    id: "ok",
    run: async () => ({ ok: true }),
  })
  reg.register({
    id: "broken",
    run: async () => {
      throw new Error("simulated network failure")
    },
    fallback: ({ error }) => ({ error: error.message, recovered: true }),
  })
  const results = reg.fireAll({ action: "x", snapshot: {}, ablations: {} })
  const [ok, broken] = await Promise.all([results.get("ok"), results.get("broken")])
  assert.deepEqual(ok, { ok: true })
  assert.deepEqual(broken, { error: "simulated network failure", recovered: true })
})

test("ForegroundParallelRegistry without fallback returns {error} on throw", async () => {
  const reg = new ForegroundParallelRegistry()
  reg.register({
    id: "no-fallback",
    run: async () => {
      throw new Error("boom")
    },
  })
  const results = reg.fireAll({ action: "x", snapshot: {}, ablations: {} })
  const out = await results.get("no-fallback")
  assert.deepEqual(out, { error: "boom" })
})

test("ForegroundParallelRegistry validates registration shape", () => {
  const reg = new ForegroundParallelRegistry()
  assert.throws(() => reg.register({ run: async () => ({}) }), /id is required/)
  assert.throws(() => reg.register({ id: "no-run" }), /needs a run\(\)/)
})
