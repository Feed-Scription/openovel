import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { listModelProfiles, resolveModelProfile, subagentModelProfile } from "../src/provider/modelProfiles.js"

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_BACKGROUND_PROVIDER",
  "AI_PROVIDER_ORDER",
  "AI_ALLOW_PAID_FALLBACK",
  "AI_SMALL_MODEL",
  "AI_LARGE_MODEL",
  "OPENOVEL_MODEL_PROFILE_ROUTES",
  "KIMI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENOVEL_CONFIG_DIR",
  "OPENOVEL_CONFIG_CONTENT",
  "OPENOVEL_IGNORE_PROJECT_CONFIG",
  "AI_STORY_CONFIG_DIR",
  "AI_STORY_CONFIG_CONTENT",
]

test("cheap helper profiles inherit the explicit small model before the main model", () => {
  withEnv(
    {
      AI_PROVIDER: "kimi-code",
      KIMI_API_KEY: "sk-kimi",
      AI_SMALL_MODEL: "kimi-small",
    },
    () => {
      const signal = resolveModelProfile("signal")
      const memory = resolveModelProfile("memory")
      const webfetch = resolveModelProfile("webfetch")
      assert.equal(signal.role, "foreground")
      assert.equal(signal.model, "kimi-small")
      assert.equal(signal.modelSource, "AI_SMALL_MODEL")
      assert.equal(memory.model, "kimi-small")
      assert.equal(webfetch.model, "kimi-small")
    },
  )
})

test("storykeeper and research profiles use background routing unless overridden", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_BACKGROUND_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_SMALL_MODEL: "deepseek-v4-flash",
      AI_LARGE_MODEL: "deepseek-v4-pro",
    },
    () => {
      const storykeeper = resolveModelProfile("storykeeper")
      const genericSubagent = resolveModelProfile("subagent")
      const research = resolveModelProfile("subagent-research")
      assert.equal(storykeeper.role, "background")
      assert.equal(storykeeper.model, "deepseek-v4-pro")
      assert.equal(genericSubagent.model, "deepseek-v4-pro")
      assert.equal(research.model, "deepseek-v4-pro")
      assert.equal(subagentModelProfile("research"), "subagent-research")
      assert.equal(subagentModelProfile("custom-agent"), "subagent")
    },
  )
})

test("semantic profiles resolve only to small or large model tiers", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_BACKGROUND_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_SMALL_MODEL: "deepseek-v4-flash",
      AI_LARGE_MODEL: "deepseek-v4-pro",
    },
    () => {
      const profiles = listModelProfiles()
      const research = profiles.find((profile) => profile.id === "subagent-research")
      const continuity = profiles.find((profile) => profile.id === "subagent-continuity")
      const storykeeper = profiles.find((profile) => profile.id === "storykeeper")
      assert.equal(research.model, "deepseek-v4-pro")
      assert.equal(research.modelSource, "AI_LARGE_MODEL")
      assert.equal(continuity.model, "deepseek-v4-flash")
      assert.equal(continuity.modelSource, "AI_SMALL_MODEL")
      assert.equal(storykeeper.modelSource, "AI_LARGE_MODEL")
      assert.equal(research.provider.id, "deepseek")
    },
  )
})

test("model profile routes can carry request defaults", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_BACKGROUND_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk-deepseek",
      OPENOVEL_MODEL_PROFILE_ROUTES: JSON.stringify({
        summary: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          role: "background",
          temperature: 0.25,
          maxTokens: 2048,
          timeoutMs: 120000,
          chunkTimeoutMs: 45000,
        },
      }),
    },
    () => {
      const summary = resolveModelProfile("summary")
      assert.equal(summary.role, "background")
      assert.equal(summary.model, "deepseek-v4-pro")
      assert.equal(summary.provider.id, "deepseek")
      assert.equal(summary.temperature, 0.25)
      assert.equal(summary.maxTokens, 2048)
      assert.equal(summary.timeoutMs, 120000)
      assert.equal(summary.chunkTimeoutMs, 45000)
    },
  )
})

function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENOVEL_CONFIG_DIR = path.join(os.tmpdir(), "openovel-empty-config")
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  try {
    return fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}
