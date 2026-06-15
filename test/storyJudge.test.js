import assert from "node:assert/strict"
import test from "node:test"

import {
  buildContinuityJudgeMessages,
  buildPairwiseJudgeMessages,
  callJudgeWithRetry,
  normalizeContinuityJudgment,
  normalizePairwiseJudgment,
} from "../src/eval/storyJudge.js"

test("callJudgeWithRetry retries on transient errors and returns the eventual success", async () => {
  let attempts = 0
  const result = await callJudgeWithRetry(
    async (n) => {
      attempts = n
      if (n < 3) throw new Error("This operation was aborted")
      return { ok: true, attempt: n }
    },
    { maxAttempts: 5, baseDelayMs: 10, label: "test-transient" },
  )
  assert.equal(attempts, 3)
  assert.deepEqual(result, { ok: true, attempt: 3 })
})

test("callJudgeWithRetry treats fetch failed / 5xx / rate-limit as transient", async () => {
  for (const msg of ["fetch failed", "status 503", "rate limit exceeded", "Too Many Requests", "ECONNRESET"]) {
    let calls = 0
    const out = await callJudgeWithRetry(
      async () => {
        calls += 1
        if (calls === 1) throw new Error(msg)
        return { ok: true }
      },
      { maxAttempts: 3, baseDelayMs: 5, label: `transient-${msg}` },
    )
    assert.deepEqual(out, { ok: true }, `should recover from "${msg}"`)
    assert.equal(calls, 2)
  }
})

test("callJudgeWithRetry does NOT retry on non-transient errors", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      callJudgeWithRetry(
        async () => {
          calls += 1
          throw new Error("Bad JSON in model response")
        },
        { maxAttempts: 5, baseDelayMs: 5, label: "non-transient" },
      ),
    /Bad JSON/,
  )
  assert.equal(calls, 1, "non-transient error must fail immediately, not retry")
})

test("callJudgeWithRetry gives up after maxAttempts and rethrows the last error", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      callJudgeWithRetry(
        async () => {
          calls += 1
          throw new Error("This operation was aborted")
        },
        { maxAttempts: 3, baseDelayMs: 5, label: "exhausts" },
      ),
    /aborted/,
  )
  assert.equal(calls, 3)
})

test("continuity judge prompt adapts Tell Me A Story dimensions for interactive continuity", () => {
  const messages = buildContinuityJudgeMessages({
    goal: "Stress-test a 50-turn Mars return story.",
    variant: "control",
    summary: { completedTurns: 2 },
    turns: [
      {
        turn: 1,
        player: { action: "I recruit Mei to repair the ascent rover." },
        openovel: { narration: "Mei agrees and tapes a cracked wrench to her sleeve.", tension: "launch window" },
        backgroundJobs: [],
      },
    ],
  })

  assert.match(messages[0].content, /Tell Me A Story/)
  assert.match(messages[0].content, /plot, creativity, development, language use/)
  assert.match(messages[0].content, /recruited people/)
  assert.match(messages[0].content, /styleFidelity/)
  assert.match(messages[0].content, /<evaluator_contract>/)
  assert.match(messages[0].content, /not instructions/)
  assert.match(messages[1].content, /I recruit Mei/)
})

test("continuity judgment normalizer preserves anchor audit and clamps scores", () => {
  const judgment = normalizeContinuityJudgment(
    {
      variant: "no-background",
      scores: {
        playerActionContinuity: 6,
        entityPersistence: 2.4,
        consequenceTracking: 0,
        storyCoherence: 4,
        overall: 3,
      },
      quality: { plot: 4, creativity: 5, development: 2, languageUse: 3, styleFidelity: 5, overall: 4 },
      anchors: [
        {
          anchor: "Mei recruited",
          introducedTurn: "7",
          expectedLaterEffect: "She should not disappear.",
          status: "forgotten",
          evidence: "No later mention after turn 8.",
          severity: "major",
        },
      ],
      forgottenOrContradicted: ["Mei disappears"],
      strengths: ["Good local prose"],
    },
    { goal: "Probe continuity", runDir: "/tmp/run" },
  )

  assert.equal(judgment.scores.playerActionContinuity, 5)
  assert.equal(judgment.scores.entityPersistence, 2)
  assert.equal(judgment.scores.consequenceTracking, 1)
  assert.equal(judgment.anchors[0].introducedTurn, 7)
  assert.equal(judgment.quality.styleFidelity, 5)
  assert.equal(judgment.anchors[0].status, "forgotten")
  assert.deepEqual(judgment.forgottenOrContradicted, ["Mei disappears"])
})

test("pairwise judge prompt and normalizer use A/B/Same preferences", () => {
  const messages = buildPairwiseJudgeMessages({
    goal: "Compare ablations.",
    baseline: { variant: "control", turns: [] },
    candidate: { variant: "no-storykeeper", turns: [] },
  })
  assert.match(messages[0].content, /side-by-side evaluator/)
  assert.match(messages[0].content, /Use A for baseline and B for candidate/)
  assert.match(messages[0].content, /<evaluator_contract>/)

  const comparison = normalizePairwiseJudgment({
    winners: {
      playerActionContinuity: "baseline",
      entityPersistence: "candidate",
      consequenceTracking: "Same",
      storyCoherence: "story b",
      styleFidelity: "B",
      overall: "A",
    },
  })
  assert.equal(comparison.winners.playerActionContinuity, "A")
  assert.equal(comparison.winners.entityPersistence, "B")
  assert.equal(comparison.winners.consequenceTracking, "Same")
  assert.equal(comparison.winners.storyCoherence, "B")
  assert.equal(comparison.winners.styleFidelity, "B")
  assert.equal(comparison.winners.overall, "A")
})
