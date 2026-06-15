// World-consistency probe orchestrator. Spawns probeWorker.js child processes
// for the cross product (probe × variant × run), aggregates pass-rates per
// probe per variant, and writes report.md.
//
// CLI:
//   node src/eval/worldConsistencyProbe.js \
//     --variants control,no-background \
//     --probes A_passive_scene,B_active_object_state,C_object_travel,D_implicit_time,E_offscreen_NPC \
//     --runs 3 \
//     --parallel 4 \
//     [--output-dir <path>] [--timeout-ms <ms>]
//
// If --probes is omitted, all PROBES are run.

import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFile, mkdir } from "node:fs/promises"
import { createWriteStream } from "node:fs"

import { writeJson, writeText } from "../lib/files.js"
import { PROBES, listProbeIds } from "./worldConsistencyProbes.js"
import { variantEnvForAblation } from "./ablationSuite.js"

const DEFAULT_VARIANTS = ["control", "no-background"]
const DEFAULT_RUNS = 3
const DEFAULT_PARALLEL = 4
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000 // 12 minutes per probe-worker

export async function runProbeSuite(options = {}) {
  const args = normalizeOptions(options)
  process.stderr.write(
    `[probeSuite] variants=${args.variants.join(",")} probes=${args.probeIds.join(",")} runs=${args.runs} parallel=${args.parallel}\n`,
  )
  await writeJson(path.join(args.outputDir, "suite-config.json"), publicSuiteConfig(args))

  // Build the full task list (probe × variant × run)
  const tasks = []
  for (const probeId of args.probeIds) {
    for (const variant of args.variants) {
      for (const fillerTurns of args.fillerTurnsList) {
        for (let runIdx = 1; runIdx <= args.runs; runIdx++) {
          const fillerTag = fillerTurns > 0 ? `_f${fillerTurns}` : ""
          const runId = `${probeId}_${variant}${fillerTag}_run${runIdx}`
          const runDir = path.join(args.outputDir, probeId, `f${fillerTurns}`, variant, `run${runIdx}`)
          tasks.push({ probeId, variant, runIdx, runId, runDir, fillerTurns })
        }
      }
    }
  }

  process.stderr.write(`[probeSuite] ${tasks.length} total child processes\n`)

  const results = []
  const queue = tasks.slice()
  const inflight = new Set()
  let completed = 0

  const launchNext = async () => {
    if (!queue.length) return
    const task = queue.shift()
    const promise = runOneProbeWorker(task, args).then((res) => {
      completed++
      process.stderr.write(
        `[probeSuite] ${completed}/${tasks.length} ${task.probeId} ${task.variant} f${task.fillerTurns} run${task.runIdx} → ${res.verdict || res.error?.slice(0, 60) || "?"}\n`,
      )
      results.push(res)
      inflight.delete(promise)
    })
    inflight.add(promise)
  }

  // Initial fill up
  while (inflight.size < args.parallel && queue.length) await launchNext()
  // Drain
  while (inflight.size > 0) {
    await Promise.race(inflight)
    while (inflight.size < args.parallel && queue.length) await launchNext()
  }

  // Aggregate
  const aggregate = aggregateResults({ results, args })
  await writeJson(path.join(args.outputDir, "suite-summary.json"), aggregate)
  await writeText(path.join(args.outputDir, "report.md"), renderReport(aggregate))
  return aggregate
}

async function runOneProbeWorker(task, args) {
  const { probeId, variant, runIdx, runId, runDir, fillerTurns } = task
  // Absolute path to probeWorker.js — child cwd is runDir so V8's
  // --heapsnapshot-near-heap-limit dumps land beside the run artifacts;
  // resolving the worker script relatively would break under that cwd.
  const workerScript = path.resolve(args.cwd || process.cwd(), "src/eval/probeWorker.js")
  const childArgs = [
    workerScript,
    "--probe-id", probeId,
    "--variant", variant,
    "--run-id", runId,
    "--output-dir", runDir,
    "--story-root", path.join(runDir, "workspace"),
    "--timeout-ms", String(args.workerTimeoutMs),
  ]
  if (fillerTurns > 0) childArgs.push("--filler-turns", String(fillerTurns))
  if (args.interQueryFiller > 0) childArgs.push("--inter-query-filler", String(args.interQueryFiller))
  if (args.finalDrainTimeoutMs > 0) childArgs.push("--final-drain-timeout-ms", String(args.finalDrainTimeoutMs))
  if (args.maxCostUSD > 0) childArgs.push("--max-cost-usd", String(args.maxCostUSD))
  if (args.maxConsecutiveErrors > 0) childArgs.push("--max-consecutive-errors", String(args.maxConsecutiveErrors))
  // --heapsnapshot-signal=SIGUSR2: manual capture via `kill -USR2 <pid>`, no
  // automatic trigger. Always-on, costs nothing until you signal.
  //
  // --heapsnapshot-near-heap-limit=1: V8 dumps the heap to disk when memory
  // is close to --max-old-space-size, BEFORE the FATAL ERROR aborts. The
  // ONLY reliable way to capture a snapshot during a sort+alloc+GC tight
  // loop (setInterval-based watchers get starved). But the dump can be
  // 5–15 GB on disk for an 8 GB heap, and with parallel probes each
  // worker may write its own. gate this behind
  // OPENOVEL_PROBE_HEAP_LIMIT_SNAPSHOT=1 — opt-in for memory debugging
  // only. Default off to keep disk safe on long ablation runs.
  const heapLimitOptIn = ["1", "true", "yes", "on"].includes(
    String(process.env.OPENOVEL_PROBE_HEAP_LIMIT_SNAPSHOT || "").toLowerCase(),
  )
  const nodeOptions = [
    process.env.NODE_OPTIONS || "",
    "--max-old-space-size=8192",
    "--expose-gc",
    heapLimitOptIn ? "--heapsnapshot-near-heap-limit=1" : "",
    "--heapsnapshot-signal=SIGUSR2",
  ].filter(Boolean).join(" ").trim()
  const env = {
    ...process.env,
    ...variantEnvForAblation(variant),
    OPENOVEL_HOME: path.join(runDir, "home"),
    OPENOVEL_STORY_ROOT: path.join(runDir, "workspace"),
    OPENOVEL_HEAP_SNAPSHOT_DIR: process.env.OPENOVEL_HEAP_SNAPSHOT_DIR || runDir,
    NODE_OPTIONS: nodeOptions,
  }
  // Ensure runDir exists before spawn (V8's heap snapshot writer cwd's into
  // it; runChild also tees stderr there).
  await mkdir(runDir, { recursive: true }).catch(() => {})
  const childResult = await runChild(process.execPath, childArgs, {
    cwd: runDir,
    env,
    timeoutMs: args.processTimeoutMs,
    stderrPath: path.join(runDir, "worker.stderr.log"),
  })
  // Always try to read summary.json — even on failure the worker may have
  // emitted partial output.
  let summary = null
  try {
    summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"))
  } catch {}
  return {
    probeId,
    variant,
    fillerTurns,
    runIdx,
    runId,
    runDir,
    exitCode: childResult.code,
    stderrTail: childResult.stderr.split("\n").slice(-10).join("\n"),
    verdict: summary?.verdict,
    score: summary?.score,
    queries: summary?.perQuery,
    summary,
    error: childResult.code !== 0 && !summary ? childResult.stderr.slice(-400) : null,
  }
}

function aggregateResults({ results, args }) {
  // group by (probe, filler, variant). Filler is the new long-range
  // axis — same probe, same variant, different filler N produces a different
  // group so we can plot the slow-loop gap vs gap-distance.
  const groups = {}
  for (const r of results) {
    const key = `${r.probeId}::${r.fillerTurns ?? 0}::${r.variant}`
    ;(groups[key] ||= []).push(r)
  }

  const per = {} // { probeId: { fillerN: { variant: { mean, std, runs:[...] } } } }
  for (const probeId of args.probeIds) {
    per[probeId] = {}
    for (const fillerTurns of args.fillerTurnsList) {
      per[probeId][fillerTurns] = {}
      for (const variant of args.variants) {
        const runs = groups[`${probeId}::${fillerTurns}::${variant}`] || []
        // aborted cells (cost ceiling / consecutive errors) produce
        // a score derived from an incomplete transcript — averaging them in
        // would hide the abort and bias the variant's mean toward 0. Drop
        // them from the score aggregate; they remain visible in verdictCounts.
        const scores = runs
          .filter((r) => r.verdict !== "aborted")
          .map((r) => (typeof r.score === "number" ? r.score : null))
          .filter((s) => s !== null)
        const verdicts = runs.map((r) => r.verdict || "error")
        const verdictCounts = {}
        for (const v of verdicts) verdictCounts[v] = (verdictCounts[v] || 0) + 1
        const mean = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null
        const std = scores.length > 1
          ? Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length)
          : 0
        per[probeId][fillerTurns][variant] = {
          mean,
          std,
          runs: runs.map((r) => ({
            runIdx: r.runIdx,
            verdict: r.verdict,
            score: r.score,
            exitCode: r.exitCode,
            error: r.error,
          })),
          verdictCounts,
          sampleSize: scores.length,
        }
      }
    }
  }

  // Per-(probe, filler) pairwise delta (variant[0] vs variant[1])
  const baselines = args.variants
  const deltas = {}
  if (baselines.length >= 2) {
    for (const probeId of args.probeIds) {
      deltas[probeId] = {}
      for (const fillerTurns of args.fillerTurnsList) {
        const a = per[probeId][fillerTurns]?.[baselines[0]]?.mean
        const b = per[probeId][fillerTurns]?.[baselines[1]]?.mean
        deltas[probeId][fillerTurns] = a != null && b != null ? a - b : null
      }
    }
  }

  return {
    runId: args.runId,
    outputDir: args.outputDir,
    variants: args.variants,
    probes: args.probeIds,
    fillerTurnsList: args.fillerTurnsList,
    runsPerCell: args.runs,
    totalChildren: results.length,
    per,
    deltas,
    rawResults: results.map((r) => ({
      probeId: r.probeId,
      variant: r.variant,
      fillerTurns: r.fillerTurns,
      runIdx: r.runIdx,
      runDir: r.runDir,
      verdict: r.verdict,
      score: r.score,
      exitCode: r.exitCode,
      error: r.error,
    })),
  }
}

function renderReport(aggregate) {
  const lines = [
    `# World-Consistency Probe Suite ${aggregate.runId}`,
    ``,
    `Probes: ${aggregate.probes.length}, Variants: ${aggregate.variants.join(" vs ")}, Runs per cell: ${aggregate.runsPerCell}`,
    `Total child processes: ${aggregate.totalChildren}`,
    ``,
    `## Score by probe × filler-turns`,
    ``,
    ...aggregate.probes.flatMap((probeId) => {
      const lines = [
        `### ${probeId}`,
        ``,
        `| filler | ${aggregate.variants.join(" | ")} | Δ (${aggregate.variants[0]} − ${aggregate.variants[1] || ""}) |`,
        `| ---: | ${aggregate.variants.map(() => "---:").join(" | ")} | ---: |`,
      ]
      for (const filler of aggregate.fillerTurnsList) {
        const cells = aggregate.variants.map((v) => {
          const cell = aggregate.per[probeId]?.[filler]?.[v]
          if (!cell || cell.mean == null) return "—"
          return `${cell.mean.toFixed(3)}±${cell.std.toFixed(3)} (n=${cell.sampleSize})`
        })
        const delta = aggregate.deltas[probeId]?.[filler]
        lines.push(`| ${filler} | ${cells.join(" | ")} | ${delta != null ? delta.toFixed(3) : "—"} |`)
      }
      lines.push(``)
      return lines
    }),
    ``,
    `## Notes`,
    ``,
    `- Score is the weighted fraction of assertions passed per query, averaged across queries within a probe and then across runs.`,
    `- Verdict thresholds: score ≥ 0.7 = pass; ≥ 0.4 = partial; < 0.4 = fail.`,
    `- Each cell is an independent subprocess with a fresh workspace; no state leaks between runs.`,
    `- Δ > 0 means the first variant scored higher than the second on that probe.`,
    `- Assertion vocabularies are intentionally generous (multiple synonyms accepted) to avoid false-negatives on phrasing.`,
    `- Manual review of failing transcripts is the canonical adjudication; see each runDir/transcript.md.`,
  ]
  return lines.join("\n")
}

function runChild(command, args, { cwd, env, timeoutMs, stderrPath }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    // Tee stderr to disk so the watcher-armed log, GC log, FATAL ERROR
    // header, and full v8 stack are recoverable after the worker dies. Past
    // OOMs lost all of this because runChild only kept the last 10 lines.
    // Keep an in-memory tail buffer (capped) for the existing fail-reporting
    // path that wants a short error string in suite-summary.
    let stderr = ""
    const STDERR_TAIL_MAX = 16 * 1024
    const stderrStream = stderrPath ? createWriteStream(stderrPath, { flags: "w" }) : null
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      if (stderrStream) stderrStream.write(chunk)
      stderr += text
      if (stderr.length > STDERR_TAIL_MAX) stderr = stderr.slice(-STDERR_TAIL_MAX)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (stderrStream) stderrStream.end()
      resolve({ code: killed ? 124 : code, signal, stdout, stderr })
    })
  })
}

function normalizeOptions(options = {}) {
  const runId = options.runId || `probe_suite_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "story", "evals", runId))
  const variants = Array.isArray(options.variants) && options.variants.length
    ? options.variants
    : (typeof options.variants === "string" ? options.variants.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_VARIANTS)
  const probeIds = Array.isArray(options.probes) && options.probes.length
    ? options.probes
    : (typeof options.probes === "string" ? options.probes.split(",").map((s) => s.trim()).filter(Boolean) : listProbeIds())
  for (const probeId of probeIds) {
    if (!PROBES.find((p) => p.id === probeId)) throw new Error(`Unknown probe id: ${probeId}`)
  }
  // filler-turns list. 0 = the baseline ~5-turn probe shape.
  // Larger values insert N filler turns between the last setup and the
  // first query, stretching the gap so slow-loop maintenance can show vs
  // chapters-tail recall.
  const fillerTurnsList = parseIntList(options.fillerTurnsList, [0])
  return {
    runId,
    outputDir,
    variants,
    probeIds,
    fillerTurnsList,
    runs: Math.max(1, Number(options.runs) || DEFAULT_RUNS),
    parallel: Math.max(1, Number(options.parallel) || DEFAULT_PARALLEL),
    workerTimeoutMs: Math.max(10000, Number(options.workerTimeoutMs) || DEFAULT_TIMEOUT_MS),
    processTimeoutMs: Math.max(10000, Number(options.processTimeoutMs) || DEFAULT_TIMEOUT_MS + 60000),
    interQueryFiller: Math.max(0, Number(options.interQueryFiller) || 0),
    finalDrainTimeoutMs: Math.max(0, Number(options.finalDrainTimeoutMs) || 0),
    // Probe guards forwarded to probeWorker. See probeWorker normalizeOptions
    // for semantics. 0 / unset = no ceiling.
    maxCostUSD: Math.max(0, Number(options.maxCostUSD) || 0),
    maxConsecutiveErrors: Math.max(0, Number(options.maxConsecutiveErrors) || 0),
    cwd: options.cwd || process.cwd(),
  }
}

function parseIntList(value, fallback) {
  if (Array.isArray(value)) return value.map((n) => Math.max(0, Number(n) || 0))
  if (typeof value === "string") {
    const list = value.split(",").map((s) => Math.max(0, Number(s.trim()) || 0))
    return list.length ? list : fallback
  }
  return fallback
}

function publicSuiteConfig(args) {
  return {
    runId: args.runId,
    outputDir: args.outputDir,
    variants: args.variants,
    probeIds: args.probeIds,
    fillerTurnsList: args.fillerTurnsList,
    runs: args.runs,
    parallel: args.parallel,
    workerTimeoutMs: args.workerTimeoutMs,
    processTimeoutMs: args.processTimeoutMs,
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--variants") out.variants = argv[++i]
    else if (a === "--probes") out.probes = argv[++i]
    else if (a === "--runs") out.runs = Number(argv[++i])
    else if (a === "--parallel") out.parallel = Number(argv[++i])
    else if (a === "--output-dir") out.outputDir = argv[++i]
    else if (a === "--worker-timeout-ms") out.workerTimeoutMs = Number(argv[++i])
    else if (a === "--process-timeout-ms") out.processTimeoutMs = Number(argv[++i])
    else if (a === "--run-id") out.runId = argv[++i]
    else if (a === "--filler-turns-list") out.fillerTurnsList = argv[++i]
    else if (a === "--inter-query-filler") out.interQueryFiller = Number(argv[++i])
    else if (a === "--final-drain-timeout-ms") out.finalDrainTimeoutMs = Number(argv[++i])
    else if (a === "--max-cost-usd") out.maxCostUSD = Number(argv[++i])
    else if (a === "--max-consecutive-errors") out.maxConsecutiveErrors = Number(argv[++i])
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  try {
    const summary = await runProbeSuite(args)
    process.stdout.write(`\n=== suite done: ${summary.totalChildren} runs ===\n`)
    process.stdout.write(`report: ${path.join(summary.outputDir, "report.md")}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`[probeSuite] FATAL: ${error?.stack || error?.message || error}\n`)
    process.exit(2)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
