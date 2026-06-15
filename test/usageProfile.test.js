import assert from "node:assert/strict"
import test from "node:test"

import { createUsageProfile, estimateCostUSD, normalizeUsage, recordModelCall, recordProfileEvent, runWithUsageProfile, summarizeUsageProfile } from "../src/telemetry/usageProfile.js"

test("usage profile normalizes DeepSeek cache hit/miss fields and estimates cost", () => {
  const usage = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
  })
  const cost = estimateCostUSD({ model: "deepseek-v4-flash", usage })

  assert.equal(usage.inputTokens, 1000)
  assert.equal(usage.cacheReadInputTokens, 600)
  assert.equal(usage.cacheMissInputTokens, 400)
  assert.equal(usage.outputTokens, 200)
  assert.equal(cost.knownPricing, true)
  assert.equal(cost.estimatedUSD, 0.00011368)
})

test("usage profile aggregates model calls by role and model", async () => {
  const profile = createUsageProfile({ action: "test", turnId: "turn_test" })
  await runWithUsageProfile(profile, async () => {
    recordModelCall({
      role: "foreground",
      modelProfile: "signal",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      telemetry: {
        durationMs: 10,
        firstFrameMs: 3,
        firstContentMs: 4,
        lastFrameMs: 9,
        frameCount: 2,
        streamed: true,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
        },
      },
    })
  })
  const summary = summarizeUsageProfile(profile).summary
  assert.equal(summary.modelCalls, 1)
  assert.equal(summary.firstFrameMs, 3)
  assert.equal(summary.lastFrameMs, 9)
  assert.equal(summary.byRole.foreground.streamedCalls, 1)
  assert.equal(summary.byModelProfile.signal.streamedCalls, 1)
  assert.equal(summary.byRole.foreground.inputTokens, 100)
  assert.equal(summary.byModel["deepseek-v4-flash"].outputTokens, 20)
  assert.ok(summary.estimatedCostUSD > 0)
})

test("usage profile summarizes pre-first-chunk timeline events", async () => {
  const profile = createUsageProfile({ action: "test", turnId: "turn_timeline" })
  await runWithUsageProfile(profile, async () => {
    recordProfileEvent({
      name: "get_story_snapshot",
      category: "pre_first_chunk",
      durationMs: 12.345,
      metadata: { inboxItems: 2 },
    })
    recordProfileEvent({
      name: "first_foreground_chunk",
      category: "pre_first_chunk",
      metadata: { sinceSubmitMs: 42, chunkChars: 3 },
    })
  })

  const completed = summarizeUsageProfile(profile)
  assert.equal(completed.timeline.length, 2)
  assert.equal(completed.summary.preFirstChunk.sinceSubmitMs, 42)
  assert.equal(completed.summary.preFirstChunk.chunkChars, 3)
  assert.equal(completed.summary.preFirstChunk.topSpans[0].name, "get_story_snapshot")
  assert.equal(completed.summary.preFirstChunk.topSpans[0].durationMs, 12.35)
})
