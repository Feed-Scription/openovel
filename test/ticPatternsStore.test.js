import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

// Isolated home; clear the env this store hydrates so assertions are clean.
process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-ticstore-${Date.now()}`)
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
delete process.env.AI_PROVIDER
delete process.env.OPENOVEL_NARRATOR_TIC_PATTERNS

const { setLlmConfig, setTicPatterns, getApiKeysSnapshot } = await import("../src/electron/apiKeysStore.js")

test("setTicPatterns persists per-provider and hydrates the active provider's patterns into env", async () => {
  await setLlmConfig({ provider: "deepseek" })
  await setTicPatterns("deepseek", "不由得\n/仿佛/")

  assert.match(process.env.OPENOVEL_NARRATOR_TIC_PATTERNS || "", /不由得/, "active provider's patterns hydrated for the runtime scan")

  const snap = await getApiKeysSnapshot()
  const deepseek = snap.keys.find((k) => k.providerId === "deepseek")
  assert.ok(deepseek, "deepseek key entry present")
  assert.match(deepseek.ticPatterns, /不由得/, "snapshot surfaces the per-provider patterns")
})

test("patterns are per-provider — switching swaps the hydrated set", async () => {
  await setTicPatterns("deepseek", "不由得")
  await setLlmConfig({ provider: "kimi-code" }) // kimi-code has no patterns configured
  assert.equal(process.env.OPENOVEL_NARRATOR_TIC_PATTERNS, undefined, "no active patterns → env unset")

  await setLlmConfig({ provider: "deepseek" }) // back to the one with patterns
  assert.match(process.env.OPENOVEL_NARRATOR_TIC_PATTERNS || "", /不由得/, "deepseek's patterns restored")
})

test("clearing a provider's patterns unsets the hydrated env", async () => {
  await setLlmConfig({ provider: "deepseek" })
  await setTicPatterns("deepseek", "不由得")
  assert.match(process.env.OPENOVEL_NARRATOR_TIC_PATTERNS || "", /不由得/)
  await setTicPatterns("deepseek", "")
  assert.equal(process.env.OPENOVEL_NARRATOR_TIC_PATTERNS, undefined)
})
