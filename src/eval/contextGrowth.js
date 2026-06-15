export function summarizeContextGrowth(turns = []) {
  const samples = turns.map(contextSample).filter(Boolean)
  if (!samples.length) {
    return {
      ok: false,
      reason: "no context reports",
      samples: 0,
    }
  }

  const included = series(samples, "includedChars")
  const raw = series(samples, "rawChars")
  const utilization = series(samples, "utilization")
  const truncatedTurns = samples.filter((sample) => sample.truncatedSources > 0).length
  const highPressureTurns = samples.filter((sample) => sample.pressureStatus === "high").length
  const storykeeperRuns = turns.filter((turn) =>
    (turn.backgroundJobs || []).some((job) => job.type === "storykeeper" && job.status === "completed"),
  ).length
  const memoryReviewRuns = turns.filter((turn) =>
    (turn.backgroundJobs || []).some((job) => job.type === "memory-review" && job.status === "completed"),
  ).length
  const compressionOpportunityTurns = samples.filter(
    (sample) => sample.pressureStatus === "high" || sample.truncatedSources > 0 || sample.utilization >= 0.9,
  ).length

  return {
    ok: true,
    samples: samples.length,
    includedChars: summarizeSeries(included),
    rawChars: summarizeSeries(raw),
    estimatedTokens: summarizeSeries(series(samples, "estimatedTokens")),
    utilization: summarizeSeries(utilization),
    growthPerTurn: {
      includedChars: slope(included),
      rawChars: slope(raw),
      estimatedTokens: slope(series(samples, "estimatedTokens")),
    },
    pressure: {
      truncatedTurns,
      highPressureTurns,
      maxTruncatedSources: Math.max(...samples.map((sample) => sample.truncatedSources)),
      maxRawToIncludedRatio: round(Math.max(...samples.map((sample) => sample.rawToIncludedRatio || 0))),
      statuses: countBy(samples.map((sample) => sample.pressureStatus || "unknown")),
    },
    controllability: {
      boundedByCompiler: samples.every((sample) => sample.maxChars > 0 && sample.includedChars <= sample.maxChars),
      maxUtilization: round(Math.max(...utilization)),
      finalUtilization: round(utilization[utilization.length - 1] || 0),
      rawOutpacedIncluded: slope(raw) > slope(included) * 1.25,
      verdict: contextVerdict({ samples, highPressureTurns, truncatedTurns }),
    },
    activeCompression: {
      storykeeperRuns,
      memoryReviewRuns,
      compressionOpportunityTurns,
      coverage:
        compressionOpportunityTurns > 0 ? round(Math.min(1, storykeeperRuns / compressionOpportunityTurns)) : 1,
      mechanisms: [
        "foreground source budgets",
        "recent canon tail window",
        "Storykeeper compact FOREGROUND.md rewrite guidance",
        "memory review for durable lessons",
        "context card selection budget",
      ],
      verdict:
        compressionOpportunityTurns === 0
          ? "not-needed"
          : storykeeperRuns > 0
            ? "available-through-storykeeper"
            : "missing-in-this-run",
    },
    bySource: summarizeSources(samples),
  }
}

export function contextSample(turn) {
  const report = turn?.contextReport
  if (!report) return null
  const pressure = report.pressure || {}
  const sources = Array.isArray(report.sources) ? report.sources : []
  const includedChars =
    pressure.includedChars ?? sources.reduce((sum, source) => sum + (source.included ? source.chars || 0 : 0), 0)
  const rawChars =
    pressure.rawChars ?? sources.reduce((sum, source) => sum + (source.rawChars || source.chars || 0), 0)
  const maxChars =
    pressure.maxChars ??
    Object.values(report.budgets || {}).reduce((sum, budget) => sum + (budget?.maxChars || 0), 0)
  return {
    turn: turn.turn,
    includedChars,
    rawChars,
    maxChars,
    estimatedTokens: pressure.estimatedTokens ?? estimateTokens(includedChars),
    utilization: pressure.utilization ?? (maxChars ? includedChars / maxChars : 0),
    rawToIncludedRatio: pressure.rawToIncludedRatio ?? (includedChars ? rawChars / includedChars : 0),
    truncatedSources:
      pressure.truncatedSources ?? sources.filter((source) => source.truncated).length,
    pressureStatus: pressure.status || "unknown",
    sources: sources.map((source) => ({
      id: source.id,
      type: source.type,
      chars: source.chars || 0,
      rawChars: source.rawChars || source.chars || 0,
      maxChars: source.maxChars || 0,
      truncated: Boolean(source.truncated),
    })),
  }
}

function summarizeSources(samples) {
  const groups = new Map()
  for (const sample of samples) {
    for (const source of sample.sources || []) {
      const key = source.id || source.type || "unknown"
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(source)
    }
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, values]) => [
      key,
      {
        chars: summarizeSeries(values.map((item) => item.chars)),
        rawChars: summarizeSeries(values.map((item) => item.rawChars)),
        growthPerTurn: {
          chars: slope(values.map((item) => item.chars)),
          rawChars: slope(values.map((item) => item.rawChars)),
        },
        truncatedTurns: values.filter((item) => item.truncated).length,
      },
    ]),
  )
}

function contextVerdict({ samples, highPressureTurns, truncatedTurns }) {
  if (!samples.every((sample) => sample.maxChars > 0 && sample.includedChars <= sample.maxChars)) return "unbounded"
  if (highPressureTurns > samples.length / 2) return "bounded-but-high-pressure"
  if (truncatedTurns > 0) return "bounded-with-clipping"
  return "bounded"
}

function summarizeSeries(values) {
  const clean = values.filter((item) => Number.isFinite(Number(item))).map(Number)
  if (!clean.length) return { min: 0, p50: 0, p95: 0, max: 0, first: 0, last: 0, delta: 0 }
  return {
    min: Math.min(...clean),
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: Math.max(...clean),
    first: clean[0],
    last: clean[clean.length - 1],
    delta: clean[clean.length - 1] - clean[0],
  }
}

function series(samples, field) {
  return samples.map((sample) => Number(sample[field]) || 0)
}

function slope(values) {
  const clean = values.filter((item) => Number.isFinite(Number(item))).map(Number)
  if (clean.length < 2) return 0
  return round((clean[clean.length - 1] - clean[0]) / (clean.length - 1))
}

function percentile(values, p) {
  const clean = values.filter((item) => Number.isFinite(Number(item))).map(Number).sort((a, b) => a - b)
  if (!clean.length) return 0
  const index = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * p)))
  return clean[index]
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1
    return acc
  }, {})
}

function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) * 0.6)
}

function round(value) {
  return Number((Number(value) || 0).toFixed(4))
}
