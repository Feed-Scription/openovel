import assert from "node:assert/strict"
import test from "node:test"

import { summarizeContextGrowth } from "../src/eval/contextGrowth.js"

test("context growth summary measures speed, pressure, controllability, and compression coverage", () => {
  const turns = [
    turn(1, { included: 1000, raw: 1000, max: 4000, status: "ok", truncated: 0 }),
    turn(2, { included: 1800, raw: 3000, max: 4000, status: "watch", truncated: 1 }),
    turn(3, { included: 3600, raw: 9000, max: 4000, status: "high", truncated: 2 }),
  ]

  const summary = summarizeContextGrowth(turns)

  assert.equal(summary.ok, true)
  assert.equal(summary.growthPerTurn.includedChars, 1300)
  assert.equal(summary.growthPerTurn.rawChars, 4000)
  assert.equal(summary.pressure.truncatedTurns, 2)
  assert.equal(summary.pressure.highPressureTurns, 1)
  assert.equal(summary.controllability.boundedByCompiler, true)
  assert.equal(summary.controllability.verdict, "bounded-with-clipping")
  assert.equal(summary.activeCompression.storykeeperRuns, 3)
  assert.equal(summary.activeCompression.verdict, "available-through-storykeeper")
})

function turn(index, { included, raw, max, status, truncated }) {
  return {
    turn: index,
    backgroundJobs: [
      { type: "storykeeper", status: "completed" },
      { type: "memory-review", status: index === 3 ? "running" : "completed" },
    ],
    contextReport: {
      pressure: {
        includedChars: included,
        rawChars: raw,
        maxChars: max,
        estimatedTokens: Math.ceil(included * 0.6),
        utilization: included / max,
        rawToIncludedRatio: raw / included,
        truncatedSources: truncated,
        status,
      },
      sources: [
        {
          id: "recent-canon",
          type: "canon_excerpt",
          included: true,
          chars: Math.min(included, 1000),
          rawChars: raw,
          maxChars: 1000,
          truncated: truncated > 0,
        },
      ],
    },
  }
}
