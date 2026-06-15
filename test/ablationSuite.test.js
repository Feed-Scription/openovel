import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  computeVariantStatus,
  deriveProcessTimeoutMs,
  parseVariantList,
  readTurnsFallback,
  renderAblationReport,
  variantEnvForAblation,
} from "../src/eval/ablationSuite.js"
import { renderCodexReviewPacket } from "../src/eval/codexReviewPacket.js"
import { runtimeAblations } from "../src/runtime/sessionProcessor.js"
import { contextInsertsDisabled } from "../src/context/foregroundInserts.js"

test("ablation variants map to isolated runtime flags", () => {
  assert.deepEqual(parseVariantList("control,no-background,no-context-inserts"), [
    "control",
    "no-background",
    "no-context-inserts",
  ])

  const noBackground = variantEnvForAblation("no-background")
  assert.equal(noBackground.OPENOVEL_ABLATION_DISABLE_BACKGROUND, "1")
  assert.equal(runtimeAblations(noBackground).disableStorykeeper, true)
  assert.equal(runtimeAblations(noBackground).disableMemoryReview, true)

  const noStorykeeper = variantEnvForAblation("no-storykeeper")
  assert.equal(runtimeAblations(noStorykeeper).disableSignal, false)
  assert.equal(runtimeAblations(noStorykeeper).disableStorykeeper, true)

  const noContext = variantEnvForAblation("no-context-inserts")
  assert.equal(contextInsertsDisabled(noContext), true)

  // foreground-side variants
  const noSignal = variantEnvForAblation("no-foreground-signal")
  assert.equal(noSignal.OPENOVEL_ABLATION_DISABLE_BACKGROUND_SIGNAL, "1")
  assert.equal(runtimeAblations(noSignal).disableSignal, true)
  // Other slow-loop components NOT disabled when only foreground signal is gone
  assert.equal(runtimeAblations(noSignal).disableStorykeeper, false)
  assert.equal(runtimeAblations(noSignal).disableMemoryReview, false)
  assert.equal(runtimeAblations(noSignal).disableOptions, false)

  const noOptions = variantEnvForAblation("no-options")
  assert.equal(noOptions.OPENOVEL_ABLATION_DISABLE_OPTIONS, "1")
  assert.equal(runtimeAblations(noOptions).disableOptions, true)
  // no-options must NOT affect any other component
  assert.equal(runtimeAblations(noOptions).disableSignal, false)
  assert.equal(runtimeAblations(noOptions).disableStorykeeper, false)
  assert.equal(runtimeAblations(noOptions).disableMemoryReview, false)
})

test("ablation report summarizes variants and judge scores", () => {
  const report = renderAblationReport({
    runId: "ablation_test",
    goal: "Probe continuity.",
    turns: 50,
    parallelVariants: 3,
    variants: [
      {
        variant: "control",
        status: "completed",
        completedTurns: 50,
        requestedTurns: 50,
        openovel: { estimatedCostUSD: 0.12, firstFrameMs: [100, 200], lastFrameMs: [3000, 4000] },
      },
    ],
    judgments: [
      {
        variant: "control",
        scores: { overall: 4 },
        quality: { overall: 5, styleFidelity: 4 },
      },
    ],
    codexReviewPath: "/tmp/ablation/codex-review.md",
    pairwise: [
      {
        candidateVariant: "no-background",
        winners: { overall: "A", playerActionContinuity: "A", entityPersistence: "A", consequenceTracking: "A" },
      },
    ],
  })

  assert.match(report, /Openovel Ablation Suite/)
  assert.match(report, /Parallel variants: 3/)
  assert.match(report, /control/)
  assert.match(report, /no-background/)
  assert.match(report, /Continuity overall/)
  // surface styleFidelity in the variants table so we measure
  // style adherence per variant (the rubric already supports it).
  assert.match(report, /Style fidelity/)
  // surface prompt-cache hit ratio in the variants table so a
  // cache-unfriendly system-prompt regression is visible at a glance.
  assert.match(report, /Cache hit%/)
  assert.match(report, /Codex Evaluator/)
})

test("ablation report renders cache hit ratio when input/cache tokens present", () => {
  const report = renderAblationReport({
    runId: "ablation_cache_test",
    goal: "verify cache surface",
    turns: 10,
    parallelVariants: 1,
    variants: [
      {
        variant: "control",
        status: "completed",
        completedTurns: 10,
        requestedTurns: 10,
        openovel: {
          estimatedCostUSD: 0.05,
          firstFrameMs: [200],
          lastFrameMs: [3000],
          inputTokens: 10000,
          cacheReadInputTokens: 7000,
        },
      },
    ],
  })
  // 7000/10000 = 70% — appears in the table row
  assert.match(report, /70%/)
})

test("codex review packet gives Codex the evaluator handoff", () => {
  const packet = renderCodexReviewPacket({
    suiteDir: "/tmp/openovel-suite",
    summary: {
      runId: "ablation_codex",
      outputDir: "/tmp/openovel-suite",
      goal: "Probe continuity.",
      turns: 50,
      variants: [
        {
          variant: "control",
          status: "completed",
          runDir: "/tmp/openovel-suite/control",
          completedTurns: 50,
          requestedTurns: 50,
          openovel: { estimatedCostUSD: 0.2, firstFrameMs: [100], lastFrameMs: [3000] },
          contextGrowth: {
            controllability: { verdict: "bounded" },
            growthPerTurn: { includedChars: 12, rawChars: 100 },
            pressure: { highPressureTurns: 0, truncatedTurns: 0 },
          },
        },
      ],
    },
  })

  assert.match(packet, /Codex acting as the LLM evaluator/)
  assert.match(packet, /Anchor Audit Instructions/)
  assert.match(packet, /Style Fidelity Checks/)
  assert.match(packet, /contextControl/)
  assert.match(packet, /control\/transcript\.md/)
})

test("computeVariantStatus prefers summary, falls back to turns.jsonl, then failed", () => {
  // 1. Clean completion: summary exists, exit 0
  assert.equal(
    computeVariantStatus({ exitCode: 0, summary: { completedTurns: 50 }, fallback: null, requestedTurns: 50 }),
    "completed",
  )
  // 2. summary exists but exit nonzero (e.g., final-wait timed out after summary was written)
  assert.equal(
    computeVariantStatus({ exitCode: 1, summary: { completedTurns: 50 }, fallback: null, requestedTurns: 50 }),
    "completed",
  )
  // 3. No summary, but turns.jsonl shows partial progress
  assert.equal(
    computeVariantStatus({
      exitCode: 1,
      summary: null,
      fallback: { completedTurns: 31 },
      requestedTurns: 50,
    }),
    "partial",
  )
  // 4. No summary, turns.jsonl says full count (process died at final-wait)
  assert.equal(
    computeVariantStatus({
      exitCode: 1,
      summary: null,
      fallback: { completedTurns: 50 },
      requestedTurns: 50,
    }),
    "partial-no-summary",
  )
  // 5. Nothing at all
  assert.equal(
    computeVariantStatus({ exitCode: 1, summary: null, fallback: null, requestedTurns: 50 }),
    "failed",
  )
  assert.equal(
    computeVariantStatus({ exitCode: 1, summary: null, fallback: { completedTurns: 0 }, requestedTurns: 50 }),
    "failed",
  )
})

test("readTurnsFallback recovers completedTurns from a partial turns.jsonl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ablation-fallback-"))
  await writeFile(
    path.join(dir, "turns.jsonl"),
    [
      JSON.stringify({ turn: 1, turnId: "turn_aaa", player: { action: "x" } }),
      JSON.stringify({ turn: 2, turnId: "turn_bbb", player: { action: "y" } }),
      "", // blank line tolerated
      JSON.stringify({ turn: 3, turnId: "turn_ccc", player: { action: "z" } }),
    ].join("\n"),
    "utf8",
  )
  const fallback = await readTurnsFallback(dir)
  assert.ok(fallback, "fallback should be returned")
  assert.equal(fallback.completedTurns, 3)
  assert.equal(fallback.lastTurnId, "turn_ccc")
  assert.equal(fallback.lastTurn, 3)
})

test("deriveProcessTimeoutMs scales with turns and respects explicit override", () => {
  // explicit value wins over scaling
  assert.equal(deriveProcessTimeoutMs({ processTimeoutMs: 12345 }), 12345)
  // tiny turn counts hit the 45-min floor
  assert.equal(deriveProcessTimeoutMs({ turns: 10 }), 45 * 60 * 1000)
  // 200 turns × 90 s = 18000 s = 5 h
  assert.equal(deriveProcessTimeoutMs({ turns: 200 }), 200 * 90 * 1000)
  // huge turn counts are capped at 8 h
  assert.equal(deriveProcessTimeoutMs({ turns: 100000 }), 8 * 60 * 60 * 1000)
  // bogus values fall back to the floor
  assert.equal(deriveProcessTimeoutMs({}), 45 * 60 * 1000)
  assert.equal(deriveProcessTimeoutMs({ turns: "garbage" }), 45 * 60 * 1000)
})

test("readTurnsFallback returns null when turns.jsonl is missing or empty", async () => {
  const missing = await readTurnsFallback("/nonexistent/dir/that/does/not/exist")
  assert.equal(missing, null)

  const dir = await mkdtemp(path.join(tmpdir(), "ablation-fallback-empty-"))
  await writeFile(path.join(dir, "turns.jsonl"), "", "utf8")
  const empty = await readTurnsFallback(dir)
  assert.equal(empty, null)
})
