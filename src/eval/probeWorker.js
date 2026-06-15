// Scripted-action probe worker. Mirrors modelPlayer.js's per-turn loop but
// (a) feeds a deterministic action sequence from a probe definition, and
// (b) bypasses the LLM player entirely. Each `query` turn captures the
// narration and runs assertion validators against it.
//
// CLI:
//   node src/eval/probeWorker.js \
//     --probe-id <id> --variant <name> --run-id <n> \
//     --output-dir <path> [--story-root <path>] [--no-init]
//
// Variant is metadata only; ablation flags are passed via env (the orchestrator
// sets OPENOVEL_ABLATION_DISABLE_BACKGROUND etc.). The worker reads runtimeAblations()
// to decide whether to invoke the initializer or to fold the worldbook into turn 1.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { writeJson, writeText } from "../lib/files.js"
import { installHeapSnapshotWatcher } from "../lib/heapSnapshot.js"
import { getStorySnapshot, initializeStory } from "../lib/storyStore.js"
import { chatMessage, hasModelKey, modelInfo } from "../provider/provider.js"
import { backgroundJobs } from "../runtime/backgroundJob.js"
import { bus } from "../runtime/bus.js"
import { sessionProcessor, runtimeAblations } from "../runtime/sessionProcessor.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { registerDefaultTools } from "../tools/registerTools.js"
import {
  check as checkGuardState,
  createGuardState,
  looksLikeBillingError,
  recordModelCall,
  recordTurn,
} from "./probeGuards.js"
import { fillerActionAt, getProbeById, timePassageFillerAt } from "./worldConsistencyProbes.js"

const PASS_THRESHOLD = 0.7
const PARTIAL_THRESHOLD = 0.4

export async function runProbeWorker(opts) {
  const args = normalizeOptions(opts)
  const probe = getProbeById(args.probeId)
  if (!probe) throw new Error(`Unknown probe id: ${args.probeId}`)

  // Empirical heap watch — captures snapshot at peak RSS when enabled.
  // See lib/heapSnapshot.js for activation env vars. No-op when disabled.
  installHeapSnapshotWatcher()

  configureWorkspace(args)
  await initializeStory()
  registerDefaultTools(toolRegistry)

  await writeJson(path.join(args.outputDir, "config.json"), publicConfig(args, probe))

  if (!args.allowFallback && !hasModelKey()) {
    const info = modelInfo()
    const expected = info.foregroundProvider?.keyEnv || "the provider API key env var"
    throw new Error(
      `No foreground model key configured for "${info.provider}". Set ${expected}.`,
    )
  }

  // pre-flight balance check. The script-loop guards can't catch a
  // wedged provider during init (initializer agent has its own retry loop and
  // can spend 5-10 min on 402 / insufficient-balance before returning). Ship
  // one tiny chat call up-front; if it fails with anything that looks like a
  // billing error, abort cleanly with a clear message instead of letting init
  // grind. Skip when --skip-preflight is set (offline tests).
  if (!args.skipPreflight) {
    try {
      await chatMessage({
        messages: [{ role: "user", content: "ping" }],
        role: "signal", // cheap small-model route
        maxTokens: 1,
        temperature: 0,
        timeoutMs: 20_000,
      })
    } catch (error) {
      if (looksLikeBillingError(error)) {
        const msg = String(error?.message || error).slice(0, 300)
        throw new Error(`Pre-flight check failed (likely billing): ${msg}`)
      }
      // Other errors (transient / network) are not a reason to abort up-front;
      // let the real workload retry. Log and continue.
      process.stderr.write(
        `[probeWorker] pre-flight warning (non-billing): ${String(error?.message || error).slice(0, 200)}\n`,
      )
    }
  }

  // Subscribe to background job usage (mirror modelPlayer behavior so we get
  // BG cost stats for the variants that have background enabled).
  const backgroundUsage = { byType: {}, total: zeroUsage() }
  const unsubscribeBgUsage = bus.subscribe("background.usage", (event) => {
    const { type, summary } = event.properties || {}
    if (!summary) return
    const bucket = (backgroundUsage.byType[type] ||= { jobs: 0, ...zeroUsage() })
    accumulate(bucket, summary)
    accumulate(backgroundUsage.total, summary)
    bucket.jobs++
    backgroundUsage.total.jobs++
  })

  // Track cumulative cost and consecutive provider errors so a dry account or
  // wedged provider cannot run through scripted turns producing provider-error
  // shells. State machine lives in ./probeGuards.js so it is unit-testable
  // without a live worker run.
  const guardState = createGuardState({
    maxCostUSD: args.maxCostUSD,
    maxConsecutiveErrors: args.maxConsecutiveErrors,
  })
  const unsubscribeModelCall = bus.subscribe("model.call.completed", (event) => {
    recordModelCall(guardState, event.properties || {})
  })

  // Init phase. If background is disabled, the worldbook is folded into the
  // opening action (matches modelPlayer's no-background convention).
  const ablations = runtimeAblations()
  let initResult = null
  if (probe.worldbook && !ablations.disableBackground) {
    process.stderr.write(`[probeWorker] init from worldbook (${probe.worldbook.length} chars)\n`)
    const { ready } = await sessionProcessor.initializeFromWorldbook({
      worldbook: probe.worldbook,
      sourceHint: `probe:${probe.id}`,
    })
    initResult = await ready
    process.stderr.write(
      `[probeWorker] init ${initResult?.status} in ${initResult?.durationMs}ms\n`,
    )
  }

  const turns = []
  const queryResults = []
  let turnNum = 0

  // Thin wrapper so script-loop callers stay readable. Logs at the abort edge.
  function checkGuards() {
    const wasAborted = guardState.aborted
    const reason = checkGuardState(guardState)
    if (reason && !wasAborted) {
      process.stderr.write(
        `[probeWorker] ABORT ${reason} (cost=$${guardState.consumedCostUSD.toFixed(4)} turnErrors=${guardState.consecutiveTurnErrors} providerErrors=${guardState.consecutiveProviderErrors})\n`,
      )
    }
    return Boolean(reason)
  }

  // Turn 1: opening action. For backgrounds-disabled runs we prefix with the
  // worldbook so the narrator has the setting at all.
  const openingAction = ablations.disableBackground && probe.worldbook
    ? `${probe.worldbook}\n\n---\n\n${probe.openingAction}`
    : probe.openingAction
  turnNum++
  await runOneTurn({
    turnNum, kind: "opening", action: openingAction, args, turns, queryResults, guardState,
  })
  checkGuards()

  // long-range gap. Inject N filler turns immediately before the
  // first QUERY step in the probe script. Setup steps run first as before,
  // then N filler turns to stretch the "離開" distance, then queries.
  // This lets us measure whether slow-loop maintenance pulls ahead of
  // raw chapters.md tail-recall at 50/70/100 turn horizons.
  const fillerCount = Math.max(0, Number(args.fillerTurns || 0))
  let firstQueryIdx = probe.script.findIndex((s) => s.kind === "query")
  if (firstQueryIdx < 0) firstQueryIdx = probe.script.length

  // Run pre-query script steps (setup / transit)
  for (let i = 0; i < firstQueryIdx; i++) {
    if (checkGuards()) break
    const step = probe.script[i]
    turnNum++
    await runOneTurn({
      turnNum, kind: step.kind, action: step.action,
      assertions: step.assertions, target: step.target,
      wait: step.wait !== false, args, turns, queryResults, guardState,
    })
  }

  // Inject filler turns. Probes that test time-evolution (F/G/H) declare
  // fillerKind: "time-passage" so each filler turn carries an explicit
  // clock marker — the narrator must acknowledge that hours, not minutes,
  // have passed when the query fires.
  const filler = probe.fillerKind === "time-passage" ? timePassageFillerAt : fillerActionAt
  for (let i = 0; i < fillerCount; i++) {
    if (checkGuards()) break
    turnNum++
    await runOneTurn({
      turnNum, kind: "filler", action: filler(i),
      wait: true, args, turns, queryResults, guardState,
    })
  }

  // Run remaining query steps. Inject N filler turns immediately before
  // each "query" step (in addition to the pre-first-query filler block
  // above). Other step kinds (setup/transit declared inside the script)
  // pass through unchanged.
  const interQueryFiller = Math.max(0, Number(args.interQueryFiller || 0))
  let interQueryFillerCursor = fillerCount
  let queryIdxSeen = 0
  for (let i = firstQueryIdx; i < probe.script.length; i++) {
    if (checkGuards()) break
    const step = probe.script[i]
    if (step.kind === "query") {
      // The very first query already had `fillerCount` turns inserted above.
      // For subsequent queries, lay down `interQueryFiller` turns first.
      if (queryIdxSeen > 0 && interQueryFiller > 0) {
        for (let f = 0; f < interQueryFiller; f++) {
          if (checkGuards()) break
          turnNum++
          await runOneTurn({
            turnNum, kind: "filler", action: filler(interQueryFillerCursor++),
            wait: true, args, turns, queryResults, guardState,
          })
        }
        if (checkGuards()) break
      }
      queryIdxSeen++
    }
    turnNum++
    await runOneTurn({
      turnNum, kind: step.kind, action: step.action,
      assertions: step.assertions, target: step.target,
      wait: step.wait !== false, args, turns, queryResults, guardState,
    })
  }

  // Bounded final drain. Waiting for a huge Storykeeper batch can grow the
  // tool-loop working set past the heap cap before summary.json gets written.
  // The probe's scoring data is captured per-turn AS THE QUERY HAPPENS; the
  // final drain only refines finalSnapshot (FG.md byte count + leftover
  // inbox count). Score data does NOT need drain. So: write the score-bearing
  // summary FIRST, then drain on a short timer, then optionally patch in the
  // final snapshot. If drain OOMs, summary.json still landed on disk.
  unsubscribeBgUsage()
  unsubscribeModelCall()
  const probeResult = scoreProbe({ probe, queryResults })
  // if the cell aborted (cost or consecutive errors), override the
  // probe verdict — the score is meaningless without a full transcript and
  // downstream aggregators should never average it in with real cells.
  const verdict = guardState.aborted ? "aborted" : probeResult.verdict
  const summary = {
    probeId: probe.id,
    probeName: probe.name,
    category: probe.category,
    variant: args.variant,
    runId: args.runId,
    turns: turns.length,
    queries: queryResults.length,
    score: probeResult.totalScore,
    verdict,
    aborted: guardState.aborted,
    abortReason: guardState.abortReason,
    perQuery: probeResult.perQuery,
    initResult,
    backgroundUsage,
    consumedCostUSD: Number(guardState.consumedCostUSD.toFixed(8)),
    finalSnapshot: { foregroundGuidanceBytes: 0, backgroundInboxItems: 0, settled: false },
  }
  await writeJson(path.join(args.outputDir, "summary.json"), summary)
  await writeJson(path.join(args.outputDir, "turns.json"), turns)

  if (global.gc) global.gc()
  if (args.finalWaitBackground) {
    const drainStarted = Date.now()
    try {
      await waitForAllBackgroundJobs(args.finalDrainTimeoutMs)
    } catch (error) {
      process.stderr.write(`[probeWorker] final drain incomplete: ${error?.message || error}\n`)
    }
    process.stderr.write(`[probeWorker] final drain ${Date.now() - drainStarted}ms\n`)
  }

  // Refresh finalSnapshot AFTER drain (best-effort; if drain timed out it
  // will be slightly stale but the score is already on disk).
  let finalSnapshot
  try {
    finalSnapshot = await getStorySnapshot()
    summary.finalSnapshot = {
      foregroundGuidanceBytes: (finalSnapshot.foregroundGuidance || "").length,
      backgroundInboxItems: finalSnapshot.backgroundInboxItems?.length || 0,
      settled: true,
    }
    await writeJson(path.join(args.outputDir, "summary.json"), summary)
  } catch (error) {
    process.stderr.write(`[probeWorker] post-drain snapshot failed: ${error?.message || error}\n`)
    finalSnapshot = { foregroundGuidance: "", backgroundInboxItems: [] }
  }
  await writeText(
    path.join(args.outputDir, "transcript.md"),
    renderTranscript(probe, turns, queryResults, probeResult),
  )
  return summary
}

async function runOneTurn({ turnNum, kind, action, assertions, target, wait, args, turns, queryResults, guardState }) {
  const startedAt = Date.now()
  process.stderr.write(`[probeWorker] turn ${turnNum} kind=${kind}\n`)

  // query-turn pre-settle. Before scoring a query we want previous
  // turns' storykeeper batches to have actually committed their envelopes
  // — otherwise the narrator sees a stale FOREGROUND.md whose contents
  // depend on how fast storykeeper happened to be in this run, which
  // injects noise into ablation comparisons. Bounded wait: inbox empty +
  // no storykeeper running, or queryPreSettleMs, whichever comes first.
  // This is much shorter than the old synchronous drain (12s vs 90s
  // timeout) and only applies to queries, not every turn.
  if (kind === "query" && args.queryPreSettleMs > 0) {
    await waitForSettleBounded(args.queryPreSettleMs)
  }

  let result
  let turnError = null
  try {
    result = await sessionProcessor.processReaderAction({
      action,
      optionsEnabled: false, // probes don't need options menus
    })
  } catch (error) {
    turnError = error.message || String(error)
    process.stderr.write(`[probeWorker] turn ${turnNum} FAILED: ${turnError}\n`)
    result = {
      turnId: `turn_${Date.now()}_error`,
      foreground: { narration: "", options: [], tension: "error", source: "error" },
    }
  }

  const narration = result?.foreground?.narration || ""

  if (guardState) recordTurn(guardState, { turnError, narration })

  // pace by reading time, not by storykeeper drain. Mirrors
  // production reader-pace semantics (modelPlayer's readerPaceSleep): a human
  // reader spends ~600 chars/min on CJK, ~1200 on EN. storykeeper runs
  // ASYNCHRONOUSLY in parallel during this sleep; if it doesn't finish
  // before the next turn, that's the same race production has,
  // and the probe should reproduce it rather than synchronize it away.
  // Skip the pace sleep on the LAST turn (no further reader action to
  // pace toward) and when --inter-turn-sleep-ms is set as an override.
  if (wait && narration) {
    if (args.interTurnSleepMs > 0) {
      await sleep(args.interTurnSleepMs)
    } else {
      const readMs = computeReaderPaceMs(narration, { cpmZh: args.readingCpmZh, cpmEn: args.readingCpmEn })
      if (readMs > 0) await sleep(readMs)
    }
  }

  const record = {
    turn: turnNum,
    kind,
    target: target || null,
    turnId: result?.turnId,
    wallMs: Date.now() - startedAt,
    action,
    narration,
    error: turnError,
  }
  turns.push(record)

  if (kind === "query" && assertions?.length) {
    const queryResult = evaluateAssertions(narration, assertions, { turn: turnNum, target })
    queryResults.push(queryResult)
  }
}

// bounded settle for query turns. Polls every 200ms; returns
// when no storykeeper job is running AND inbox is empty, OR when the
// deadline expires (logged but not an error). Cheap polling — main
// thread is between turns anyway.
async function waitForSettleBounded(maxMs) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const running = backgroundJobs.list().filter((j) => j.status === "running" && j.type === "storykeeper")
    if (running.length === 0) {
      const snap = await getStorySnapshot().catch(() => ({ backgroundInboxItems: [] }))
      if ((snap.backgroundInboxItems?.length || 0) === 0) return
    }
    await sleep(200)
  }
}

// CJK 600 chars/min, EN 1200 chars/min. Mirrors modelPlayer's
// computeReaderPaceMs so probe pacing matches the rest of the eval surface.
function computeReaderPaceMs(text, { cpmZh = 600, cpmEn = 1200 } = {}) {
  if (!text) return 0
  const cjk = /[㐀-鿿]/.test(text)
  const cpm = cjk ? cpmZh : cpmEn
  if (!Number.isFinite(cpm) || cpm <= 0) return 0
  return Math.round((text.length / cpm) * 60 * 1000)
}

// Returns { passed, total, score, details:[{ id, type, passed, matchedTerms, weight }] }
function evaluateAssertions(narration, assertions, meta = {}) {
  const details = assertions.map((a) => {
    const text = String(narration || "")
    const matched = (a.terms || []).filter((t) => text.includes(t))
    let passed
    if (a.type === "must_mention" || a.type === "should_preserve") {
      passed = matched.length > 0
    } else if (a.type === "must_not_mention") {
      passed = matched.length === 0
    } else {
      passed = false
    }
    return {
      id: a.id,
      type: a.type,
      passed,
      matchedTerms: matched,
      weight: Number(a.weight ?? 1),
    }
  })
  const total = details.reduce((s, d) => s + d.weight, 0)
  const passed = details.reduce((s, d) => s + (d.passed ? d.weight : 0), 0)
  const score = total > 0 ? passed / total : 0
  return { ...meta, narrationLen: narration.length, score, passed, total, details }
}

function scoreProbe({ probe, queryResults }) {
  if (!queryResults.length) {
    return { totalScore: 0, verdict: "no-queries", perQuery: [] }
  }
  const perQuery = queryResults.map((q) => ({
    turn: q.turn,
    target: q.target,
    score: q.score,
    passed: q.passed,
    total: q.total,
    narrationLen: q.narrationLen,
    details: q.details,
  }))
  // Average across queries (probe C has 2 queries; others have 1)
  const totalScore = perQuery.reduce((s, q) => s + q.score, 0) / perQuery.length
  let verdict
  if (totalScore >= PASS_THRESHOLD) verdict = "pass"
  else if (totalScore >= PARTIAL_THRESHOLD) verdict = "partial"
  else verdict = "fail"
  return { totalScore, verdict, perQuery }
}

function renderTranscript(probe, turns, queryResults, scoreData) {
  const lines = [
    `# Probe: ${probe.name} (${probe.id})`,
    ``,
    `**Category**: ${probe.category}`,
    `**Description**: ${probe.description}`,
    ``,
    `**Verdict**: ${scoreData.verdict} (score=${scoreData.totalScore.toFixed(3)})`,
    ``,
    `## Per-query`,
    ``,
  ]
  for (const q of scoreData.perQuery) {
    lines.push(`### Turn ${q.turn}${q.target ? ` (target=${q.target})` : ""}`)
    lines.push(`- Score: ${q.score.toFixed(3)} (${q.passed}/${q.total})`)
    lines.push(`- Narration length: ${q.narrationLen}`)
    lines.push(``)
    lines.push(`Assertions:`)
    for (const d of q.details) {
      const mark = d.passed ? "PASS" : "FAIL"
      const matched = d.matchedTerms.length ? ` matched=[${d.matchedTerms.join(", ")}]` : ""
      lines.push(`  - [${mark}] ${d.id} (${d.type}, w=${d.weight})${matched}`)
    }
    lines.push(``)
  }
  lines.push(``, `## Full transcript`, ``)
  for (const t of turns) {
    lines.push(`### Turn ${t.turn} [${t.kind}${t.target ? `→${t.target}` : ""}]`)
    lines.push(`**action**: ${t.action.slice(0, 400)}${t.action.length > 400 ? "…" : ""}`)
    lines.push(``)
    lines.push(`**narration** (${t.narration.length}c):`)
    lines.push(``)
    lines.push(t.narration)
    if (t.error) lines.push(``, `**ERROR**: ${t.error}`)
    lines.push(``)
  }
  return lines.join("\n")
}

// ───────────── helpers shamelessly copied from modelPlayer ─────────────
function configureWorkspace(args) {
  process.env.OPENOVEL_STORY_ROOT = args.storyRoot
}

function publicConfig(args, probe) {
  return {
    probeId: probe.id,
    probeName: probe.name,
    category: probe.category,
    variant: args.variant,
    runId: args.runId,
    outputDir: args.outputDir,
    storyRoot: args.storyRoot,
    openovelProviders: modelInfo(),
    runtimeAblations: runtimeAblations(),
  }
}

function normalizeOptions(options = {}) {
  const runId = options.runId || `probe_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(
    options.outputDir || path.join(process.cwd(), "story", "evals", `probe_${runId}`),
  )
  return {
    probeId: options.probeId,
    variant: options.variant || "unspecified",
    runId,
    outputDir,
    storyRoot: options.storyRoot || path.join(outputDir, "workspace"),
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 180000),
    finalWaitBackground: options.finalWaitBackground !== false,
    // default 0 — waitForBackgroundDrained between turns is now the
    // primary mechanism; a fixed sleep on top is rarely useful and slows
    // probes unnecessarily.
    interTurnSleepMs: Math.max(0, Number(options.interTurnSleepMs ?? 0)),
    fillerTurns: Math.max(0, Number(options.fillerTurns ?? 0)),
    // Per-query filler insertion: N filler turns are run BEFORE each query
    // turn (in addition to whatever transit/setup the probe script already
    // declares). Lets a multi-query probe like Z_unified_seven extend total
    // length without changing the script structure — the storykeeper sees
    // more time pass between checkpoints, exercising long-range memory
    // pressure. Uses the same time-passage / filler pool as --filler-turns.
    interQueryFiller: Math.max(0, Number(options.interQueryFiller ?? 0)),
    // Separate from --timeout-ms. Past this per-turn drain cap we log how many
    // inbox items / running jobs were left and continue.
    // 90s is enough headroom for a healthy storykeeper batch; stuck inbox
    // (e.g. storykeeper API error left items unresolved) doesn't justify
    // burning the entire worker wallclock per turn.
    drainTimeoutMs: Math.max(1000, Number(options.drainTimeoutMs ?? 90_000)),
    // probe pacing matches the production reader-pace model
    // (per modelPlayer eval-natural-pace memory). After each turn the worker
    // sleeps for as long as a human reader would spend on the narration
    // (CJK 600 chars/min, EN 1200 chars/min) — storykeeper runs in parallel
    // during this sleep instead of being synchronously awaited. Sync-drain mode
    // was a workaround for old memory pressure; the trim/compact boundary fixes
    // make production-like async pacing the better probe shape. Sync drain
    // turned every probe turn into the slowest-of:
    // narrator vs storykeeper, which inflated probe wallclock 5-10x and
    // diverged from production semantics.
    readingCpmZh: Number.isFinite(Number(options.readingCpmZh)) ? Math.max(0, Number(options.readingCpmZh)) : 600,
    readingCpmEn: Number.isFinite(Number(options.readingCpmEn)) ? Math.max(0, Number(options.readingCpmEn)) : 1200,
    // Before a `query` turn we want the FOREGROUND.md / Active Pressures
    // that previous turns' storykeeper batches WROTE to be visible to the
    // narrator — otherwise different variants are scored on different
    // amounts of slow-loop work. Bound it: wait at most this long for
    // inbox to empty OR storykeeper to go idle; whichever comes first.
    // Default 12s ≈ 2x typical CJK reader-pace on a 100-char narration.
    queryPreSettleMs: Math.max(0, Number(options.queryPreSettleMs ?? 12000)),
    // bounded final drain. Probe scoring already happened per-turn;
    // final drain is only to refine finalSnapshot. Cap at 30s by default so
    // a runaway storykeeper batch can't OOM the worker before summary.json
    // lands on disk.
    finalDrainTimeoutMs: Math.max(0, Number(options.finalDrainTimeoutMs ?? 30_000)),
    // Probe safety guards:
    // - maxCostUSD: cumulative cost ceiling per cell. 0 = no ceiling.
    //   Counts both foreground and background model calls (every emit of
    //   model.call.completed). Intended as a safety valve well above expected
    //   total cell cost — e.g. set to 5x the average healthy cell cost so a
    //   wedged provider can't spend the budget on retry storms.
    // - maxConsecutiveErrors: bail after N back-to-back failures. Counts
    //   either narrator-level turn errors (sessionProcessor threw / empty
    //   narration / provider-error shell narration) OR raw model.call
    //   ok=false events. Either path catches "API is refusing to serve" so
    //   the cell stops grinding through scripted turns producing garbage.
    //   Default 5 gives a few real turns before giving up (each turn typically
    //   does 1-3 model calls).
    maxCostUSD: Math.max(0, Number(options.maxCostUSD ?? 0)),
    maxConsecutiveErrors: Math.max(1, Number(options.maxConsecutiveErrors ?? 5)),
    // one-shot pre-flight chat call before init phase. Catches
    // wedged accounts (402 / insufficient_balance) in seconds instead of
    // letting init burn 5-10 min on retries. Default on.
    skipPreflight: options.skipPreflight === true,
    allowFallback: ["1", "true", "yes", "on"].includes(
      String(options.allowFallback || process.env.OPENOVEL_EVAL_ALLOW_FALLBACK || "").toLowerCase(),
    ),
  }
}

function zeroUsage() {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
  }
}

function accumulate(target, summary) {
  for (const k of Object.keys(zeroUsage())) target[k] = (target[k] || 0) + (summary[k] || 0)
  target.estimatedCostUSD = Number(target.estimatedCostUSD.toFixed(8))
}

async function waitForJobs(jobs, timeoutMs) {
  await Promise.race([
    Promise.allSettled(jobs.map((j) => j?.completion).filter(Boolean)),
    sleep(timeoutMs),
  ])
}

// Historical note: the probe used to synchronously drain the slow loop between
// every turn so turn N+1's narrator saw turn N's Storykeeper output. Production
// is async (reader paces by
// narration length, storykeeper runs in parallel), so the probe should
// reproduce that race rather than serialize it. Sync drain inflated probe
// wallclock 5-10x vs production and diverged from the system's real
// semantics. The old `waitForBackgroundDrained` here was the entry point
// for that sync regime; it's been replaced by `waitForSettleBounded` (a
// short bounded wait only on query turns, so cross-variant scores don't
// depend on storykeeper raw speed) plus per-turn `computeReaderPaceMs`
// pacing (matches modelPlayer's reader-pace model).
const DRAIN_TIMEOUT_DEFAULT_MS = 90 * 1000

// Retained for callers that want the old all-or-nothing drain; not used
// by runOneTurn anymore. waitForAllBackgroundJobs (below) handles the
// final-exit drain. Most paths should use waitForSettleBounded instead.
async function waitForBackgroundDrained(_workerTimeoutMs, drainTimeoutMs = DRAIN_TIMEOUT_DEFAULT_MS) {
  const { backgroundJobs } = await import("../runtime/backgroundJob.js")
  const start = Date.now()
  while (Date.now() - start < drainTimeoutMs) {
    const running = backgroundJobs.list().filter((j) => j.status === "running")
    if (running.length === 0) {
      const snap = await getStorySnapshot()
      if ((snap.backgroundInboxItems?.length || 0) === 0) return
    }
    await sleep(200)
  }
  const running = backgroundJobs.list().filter((j) => j.status === "running")
  const snap = await getStorySnapshot().catch(() => ({ backgroundInboxItems: [] }))
  const inboxLeft = snap.backgroundInboxItems?.length || 0
  process.stderr.write(
    `[probeWorker] drain timed out after ${drainTimeoutMs}ms: ${running.length} jobs still running, ${inboxLeft} inbox items unresolved\n`,
  )
}

async function waitForAllBackgroundJobs(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const running = backgroundJobs.list().filter((j) => j.status === "running")
    if (!running.length) return
    await Promise.race([
      Promise.allSettled(running.map((j) => j.completion).filter(Boolean)),
      sleep(1000),
    ])
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--probe-id") out.probeId = argv[++i]
    else if (a === "--variant") out.variant = argv[++i]
    else if (a === "--run-id") out.runId = argv[++i]
    else if (a === "--output-dir") out.outputDir = argv[++i]
    else if (a === "--story-root") out.storyRoot = argv[++i]
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i])
    else if (a === "--no-final-wait-background") out.finalWaitBackground = false
    else if (a === "--inter-turn-sleep-ms") out.interTurnSleepMs = Number(argv[++i])
    else if (a === "--filler-turns") out.fillerTurns = Number(argv[++i])
    else if (a === "--inter-query-filler") out.interQueryFiller = Number(argv[++i])
    else if (a === "--drain-timeout-ms") out.drainTimeoutMs = Number(argv[++i])
    else if (a === "--reading-cpm-zh") out.readingCpmZh = Number(argv[++i])
    else if (a === "--reading-cpm-en") out.readingCpmEn = Number(argv[++i])
    else if (a === "--query-pre-settle-ms") out.queryPreSettleMs = Number(argv[++i])
    else if (a === "--final-drain-timeout-ms") out.finalDrainTimeoutMs = Number(argv[++i])
    else if (a === "--max-cost-usd") out.maxCostUSD = Number(argv[++i])
    else if (a === "--max-consecutive-errors") out.maxConsecutiveErrors = Number(argv[++i])
    else if (a === "--skip-preflight") out.skipPreflight = true
    else if (a === "--allow-fallback") out.allowFallback = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.probeId) {
    process.stderr.write("Usage: probeWorker --probe-id <id> --variant <name> --run-id <n> --output-dir <path>\n")
    process.exit(2)
  }
  try {
    const summary = await runProbeWorker(args)
    process.stdout.write(JSON.stringify({ ok: true, verdict: summary.verdict, score: summary.score, perQuery: summary.perQuery }, null, 2) + "\n")
    process.exit(summary.verdict === "fail" ? 1 : 0)
  } catch (error) {
    process.stderr.write(`[probeWorker] FATAL: ${error?.stack || error?.message || error}\n`)
    process.exit(2)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
