import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { ensureDir, readJson, writeJson, writeText } from "../lib/files.js"
import { judgePairwise, judgeRun, renderJudgmentMarkdown } from "./storyJudge.js"
import { writeCodexReviewPacket } from "./codexReviewPacket.js"

export const DEFAULT_ABLATION_VARIANTS = [
  "control",
  "no-background",
  "no-storykeeper",
  "no-memory-review",
  "no-context-inserts",
  // Foreground-side ablation: openovel has multiple concurrent
  // model calls per turn (narrator + signal in parallel; options + context
  // inserts in parallel after narrator). Variants below isolate each.
  "no-foreground-signal",
  "no-options",
]

export async function runAblationSuite(options = {}) {
  const args = normalizeSuiteOptions(options)
  await ensureDir(args.outputDir)
  await writeJson(path.join(args.outputDir, "suite-config.json"), publicSuiteConfig(args))

  const variants = await mapWithConcurrency(args.variants, args.parallelVariants, async (variant) => {
    const variantDir = path.join(args.outputDir, variant)
    await ensureDir(variantDir)
    const child = await runModelPlayerVariant({ args, variant, variantDir })
    const summary = await readJson(path.join(variantDir, "summary.json"), null)
    // When a child dies before writing summary.json (final-wait timeout, fetch
    // abort, etc.), fall back to turns.jsonl to recover the actual turn count.
    const fallback = summary ? null : await readTurnsFallback(variantDir)
    const status = computeVariantStatus({ exitCode: child.code, summary, fallback, requestedTurns: args.turns })
    const record = {
      variant,
      status,
      runDir: variantDir,
      exitCode: child.code,
      completedTurns: summary?.completedTurns ?? fallback?.completedTurns ?? 0,
      requestedTurns: summary?.requestedTurns || args.turns,
      openovel: summary?.openovel || null,
      // Also propagate backgroundUsage from per-variant summary so the
      // cross-variant table can render FG/BG/Total.
      backgroundUsage: summary?.backgroundUsage || null,
      initializer: summary?.initializer || null,
      player: summary?.player || null,
      contextGrowth: summary?.contextGrowth || null,
      final: summary?.final || null,
      error: child.code === 0 ? "" : compact(child.stderr || child.stdout, 1200),
    }
    if (!summary && fallback) {
      record.fallback = fallback
    }

    await writeText(path.join(variantDir, "stdout.log"), child.stdout)
    await writeText(path.join(variantDir, "stderr.log"), child.stderr)
    return record
  })
  const judgments = []
  const pairwise = []

  for (const record of variants) {
    // also judge partial runs that have ≥10 turns of data —
    // loadRunArtifacts already tolerates missing summary.json by defaulting to
    // {} and reads turns.jsonl directly, so the judge still has enough to score.
    const judgeWorthwhile =
      record.status === "completed" ||
      (record.status.startsWith("partial") && record.completedTurns >= 10)
    if (args.judge && judgeWorthwhile) {
      const judgment = await judgeRun({
        runDir: record.runDir,
        goal: args.goal,
        variant: record.variant,
        config: args.judgeConfig,
      })
      judgments.push(judgment)
      await ensureDir(path.join(args.outputDir, "judgments"))
      await writeJson(path.join(args.outputDir, "judgments", `${record.variant}.json`), judgment)
      await writeText(path.join(args.outputDir, "judgments", `${record.variant}.md`), renderJudgmentMarkdown(judgment))
    }
  }

  if (args.judge && args.pairwise && variants.some((item) => item.variant === "control" && item.status === "completed")) {
    const control = variants.find((item) => item.variant === "control" && item.status === "completed")
    for (const candidate of variants.filter((item) => item.variant !== "control" && item.status === "completed")) {
      const comparison = await judgePairwise({
        baselineDir: control.runDir,
        candidateDir: candidate.runDir,
        goal: args.goal,
        baselineVariant: "control",
        candidateVariant: candidate.variant,
        config: args.judgeConfig,
      })
      pairwise.push(comparison)
      await writeJson(path.join(args.outputDir, "judgments", `pairwise_control_vs_${candidate.variant}.json`), comparison)
    }
  }

  const summary = {
    ok: variants.some((item) => item.status === "completed"),
    runId: args.runId,
    outputDir: args.outputDir,
    goal: args.goal,
    turns: args.turns,
    parallelVariants: args.parallelVariants,
    variants,
    judgments: judgments.map(compactJudgment),
    pairwise: pairwise.map(compactPairwise),
  }
  if (args.codexReview) {
    summary.codexReviewPath = await writeCodexReviewPacket({ suiteDir: args.outputDir, summary })
  }
  await writeJson(path.join(args.outputDir, "suite-summary.json"), summary)
  await writeText(path.join(args.outputDir, "report.md"), renderAblationReport(summary))
  return summary
}

export function variantEnvForAblation(variant) {
  if (variant === "control") return clearAblationEnv()
  if (variant === "no-background") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_BACKGROUND: "1",
    }
  }
  if (variant === "no-storykeeper") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_STORYKEEPER: "1",
    }
  }
  if (variant === "no-memory-review") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_MEMORY_REVIEW: "1",
    }
  }
  if (variant === "no-context-inserts") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_CONTEXT_INSERTS: "1",
    }
  }
  if (variant === "no-foreground-signal") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_BACKGROUND_SIGNAL: "1",
    }
  }
  if (variant === "no-options") {
    return {
      ...clearAblationEnv(),
      OPENOVEL_ABLATION_DISABLE_OPTIONS: "1",
    }
  }
  throw new Error(`Unknown ablation variant: ${variant}`)
}

export function parseVariantList(value) {
  const variants = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return variants.length ? variants : DEFAULT_ABLATION_VARIANTS
}

export function renderAblationReport(summary = {}) {
  const variants = Array.isArray(summary.variants) ? summary.variants : []
  const judgments = new Map((summary.judgments || []).map((item) => [item.variant, item]))
  const pairwise = Array.isArray(summary.pairwise) ? summary.pairwise : []
  return [
    `# Openovel Ablation Suite ${summary.runId || ""}`.trim(),
    "",
    `Goal: ${summary.goal || "-"}`,
    `Turns: ${summary.turns || "-"}`,
    `Parallel variants: ${summary.parallelVariants || 1}`,
    "",
    "## Variants",
    "",
    "| Variant | Status | Turns | FG cost | BG cost | Total cost | Cache hit% | First frame p50 | Last frame p50 | Context verdict | Ctx chars/turn | Raw chars/turn | Continuity overall | Quality overall | Style fidelity |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...variants.map((item) => {
      const judgment = judgments.get(item.variant) || {}
      const inTokens = item.openovel?.inputTokens || 0
      const cacheRead = item.openovel?.cacheReadInputTokens || 0
      const cacheHit = inTokens > 0 ? `${Math.round((cacheRead / inTokens) * 100)}%` : ""
      // Surface background cost alongside foreground cost so reports show the
      // complete model spend.
      const fgCost = Number(item.openovel?.estimatedCostUSD || 0)
      const bgCost = Number(item.backgroundUsage?.total?.estimatedCostUSD || 0)
      const totalCost = Number((fgCost + bgCost).toFixed(6))
      return [
        item.variant,
        judgment.parseWarning ? `${item.status} (judge parse warning)` : item.status,
        `${item.completedTurns || 0}/${item.requestedTurns || summary.turns || 0}`,
        fgCost || "",
        bgCost || "",
        totalCost || "",
        cacheHit,
        medianString(item.openovel?.firstFrameMs),
        medianString(item.openovel?.lastFrameMs),
        item.contextGrowth?.controllability?.verdict ?? "",
        item.contextGrowth?.growthPerTurn?.includedChars ?? "",
        item.contextGrowth?.growthPerTurn?.rawChars ?? "",
        judgment.scores?.overall ?? "",
        judgment.quality?.overall ?? "",
        judgment.quality?.styleFidelity ?? "",
      ].join(" | ")
    }).map((row) => `| ${row} |`),
    "",
    "## Pairwise Against Control",
    "",
    ...(pairwise.length
      ? pairwise.map((item) => `- ${item.candidateVariant}: overall=${item.winners?.overall || "Same"}, continuity=${item.winners?.playerActionContinuity || "Same"}/${item.winners?.entityPersistence || "Same"}/${item.winners?.consequenceTracking || "Same"}`)
      : ["- Pairwise judging was not run."]),
    "",
    "## Codex Evaluator",
    "",
    summary.codexReviewPath
      ? `- Review packet: ${summary.codexReviewPath}`
      : "- Codex review packet was not generated.",
    "",
    "## Context Growth",
    "",
    ...(variants.length
      ? variants.map((item) => {
          const growth = item.contextGrowth || {}
          return `- ${item.variant}: ${growth.controllability?.verdict || "unknown"}; included ${growth.includedChars?.first ?? 0} -> ${growth.includedChars?.last ?? 0} chars; raw ${growth.rawChars?.first ?? 0} -> ${growth.rawChars?.last ?? 0} chars; high-pressure turns=${growth.pressure?.highPressureTurns ?? 0}; truncated turns=${growth.pressure?.truncatedTurns ?? 0}; compression=${growth.activeCompression?.verdict || "unknown"}`
        })
      : ["- No variant context-growth data."]),
    "",
    "## Notes",
    "",
    "- `no-background` disables the slow loop entirely: no background signal, Storykeeper, or memory review.",
    "- `no-storykeeper` keeps foreground and background signal, but prevents the slow loop from merging continuity into foreground guidance.",
    "- `no-memory-review` removes durable memory review while keeping Storykeeper.",
    "- `no-context-inserts` disables dynamic Markdown context card insertion for the foreground loop.",
    "- `no-foreground-signal` disables the parallel background-signal extraction during the foreground turn. Slow loop loses structured task hints (still has inbox via Storykeeper's own context).",
    "- `no-options` disables the post-narration options model call. The narrator's narration is unchanged; the player-facing choice menu is omitted.",
  ].join("\n")
}

async function runModelPlayerVariant({ args, variant, variantDir }) {
  const childArgs = [
    "src/eval/modelPlayer.js",
    "--goal",
    args.goal,
    "--persona",
    args.persona,
    "--turns",
    String(args.turns),
    "--output-dir",
    variantDir,
    "--story-root",
    path.join(variantDir, "workspace"),
    "--run-id",
    `${args.runId}_${variant}`,
    "--wait-every",
    String(args.waitEvery),
    "--timeout-ms",
    String(args.timeoutMs),
  ]
  if (args.waitBackground) childArgs.push("--wait-background")
  if (!args.finalWaitBackground) childArgs.push("--final-no-wait-background")
  if (!args.optionsEnabled) childArgs.push("--no-options")
  if (args.playerModel) childArgs.push("--player-model", args.playerModel)
  if (args.persistProfiles) childArgs.push("--persist-profiles")
  if (args.openingAction) childArgs.push("--opening-action", args.openingAction)
  if (args.readingCpmZh != null) childArgs.push("--reading-cpm-zh", String(args.readingCpmZh))
  if (args.readingCpmEn != null) childArgs.push("--reading-cpm-en", String(args.readingCpmEn))
  if (args.worldbookFromPath) childArgs.push("--worldbook-from", args.worldbookFromPath)
  if (args.worldbookSourceHint) childArgs.push("--worldbook-source-hint", args.worldbookSourceHint)

  const env = {
    ...process.env,
    ...variantEnvForAblation(variant),
    OPENOVEL_EVAL_SUITE_VARIANT: variant,
    OPENOVEL_HOME: path.join(variantDir, "home"),
    OPENOVEL_STORY_ROOT: path.join(variantDir, "workspace"),
  }
  return runChild(process.execPath, childArgs, { cwd: args.cwd, env, timeoutMs: args.processTimeoutMs })
}

function runChild(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code: killed ? 124 : code, signal, stdout, stderr })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: 1, signal: "", stdout, stderr: `${stderr}\n${error.message || String(error)}` })
    })
  })
}

function normalizeSuiteOptions(options = {}) {
  const goal = compact(options.goal, 1600)
  if (!goal) throw new Error("Ablation suite needs --goal <text>.")
  const runId = options.runId || `ablation_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "story", "evals", runId))
  return {
    runId,
    outputDir,
    cwd: path.resolve(options.cwd || process.cwd()),
    goal,
    persona:
      compact(options.persona, 1400) ||
      "A demanding but fair interactive fiction reader who actively tests whether earlier choices, companions, objects, and consequences persist.",
    turns: Math.max(1, Number(options.turns) || 50),
    variants: parseVariantList(options.variants),
    parallelVariants: normalizeParallelVariants(options.parallelVariants, parseVariantList(options.variants).length),
    // Default: 0. Natural-pace player (--reading-cpm-zh/en) replaces
    // the synthetic sync points with a realistic foreground/background
    // interleaving. Set --wait-every >0 explicitly only when you want hard
    // drain points (e.g., to debug background-job pile-up).
    waitEvery: Math.max(0, Number(options.waitEvery ?? 0)),
    waitBackground: options.waitBackground === true,
    finalWaitBackground: options.finalWaitBackground !== false,
    optionsEnabled: options.optionsEnabled !== false,
    persistProfiles: options.persistProfiles === true,
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 180000),
    // scale per-variant SIGTERM with --turns instead of a fixed
    // 45-min wall. The first 200-turn run got killed at turn 36/50 because
    // 45 min < 200 turns × ~60s/turn. Memory [[eval-harness-timeouts]] tripped
    // Default: turns × 90s, floored at 45 min,
    // capped at 8 h. Explicit --process-timeout-ms still wins.
    processTimeoutMs: deriveProcessTimeoutMs(options),
    playerModel: compact(options.playerModel, 120),
    openingAction: compact(options.openingAction, 1000),
    readingCpmZh: options.readingCpmZh != null ? Number(options.readingCpmZh) : null,
    readingCpmEn: options.readingCpmEn != null ? Number(options.readingCpmEn) : null,
    // worldbook path (resolved per-variant by the child process). The
    // suite stays absent-by-default; eval scripts opt in by passing --worldbook-from.
    worldbookFromPath: options.worldbookFromPath ? String(options.worldbookFromPath) : "",
    worldbookSourceHint: options.worldbookSourceHint ? String(options.worldbookSourceHint) : "",
    judge: options.judge === true,
    pairwise: options.pairwise !== false,
    codexReview: options.codexReview !== false,
    judgeConfig: {
      model: options.judgeModel,
      maxTokens: options.judgeMaxTokens,
      timeoutMs: options.judgeTimeoutMs,
    },
  }
}

function publicSuiteConfig(args) {
  return {
    runId: args.runId,
    outputDir: args.outputDir,
    goal: args.goal,
    persona: args.persona,
    turns: args.turns,
    variants: args.variants,
    parallelVariants: args.parallelVariants,
    waitEvery: args.waitEvery,
    waitBackground: args.waitBackground,
    finalWaitBackground: args.finalWaitBackground,
    optionsEnabled: args.optionsEnabled,
    judge: args.judge,
    pairwise: args.pairwise,
    codexReview: args.codexReview,
    playerModel: args.playerModel,
    openingAction: args.openingAction,
    readingCpmZh: args.readingCpmZh,
    readingCpmEn: args.readingCpmEn,
    judgeModel: args.judgeConfig.model || process.env.OPENOVEL_EVAL_JUDGE_MODEL || process.env.OPENOVEL_EVAL_LARGE_JUDGE_MODEL || "deepseek-v4-pro",
  }
}

function compactJudgment(judgment = {}) {
  return {
    variant: judgment.variant,
    scores: judgment.scores,
    quality: judgment.quality,
    forgottenOrContradicted: judgment.forgottenOrContradicted,
    parseWarning: judgment.parseWarning,
    judge: judgment.judge,
  }
}

function compactPairwise(comparison = {}) {
  return {
    baselineVariant: comparison.baselineVariant,
    candidateVariant: comparison.candidateVariant,
    winners: comparison.winners,
    regressions: comparison.regressions,
    parseWarning: comparison.parseWarning,
    judge: comparison.judge,
  }
}

// derive per-variant SIGTERM wall from --turns. Explicit user value
// always wins. Otherwise: turns × 90s, floored at 45 min, capped at 8 h. The
// 90s/turn leaves headroom for outlier Storykeeper batches while still bounding
// stuck variants.
export function deriveProcessTimeoutMs(options = {}) {
  const explicit = Number(options.processTimeoutMs)
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1000, explicit)
  const turns = Number(options.turns) || 0
  const min = 1000 * 60 * 45
  const max = 1000 * 60 * 60 * 8
  return Math.min(max, Math.max(min, turns * 90 * 1000))
}

function clearAblationEnv() {
  return {
    OPENOVEL_ABLATION_DISABLE_BACKGROUND: "",
    OPENOVEL_ABLATION_DISABLE_BACKGROUND_SIGNAL: "",
    OPENOVEL_ABLATION_DISABLE_STORYKEEPER: "",
    OPENOVEL_ABLATION_DISABLE_MEMORY_REVIEW: "",
    OPENOVEL_ABLATION_DISABLE_CONTEXT_INSERTS: "",
    OPENOVEL_ABLATION_DISABLE_OPTIONS: "",
    OPENOVEL_DISABLE_BACKGROUND: "",
    OPENOVEL_DISABLE_CONTEXT_INSERTS: "",
  }
}

function medianString(values) {
  if (!Array.isArray(values) || !values.length) return ""
  const sorted = values.filter((item) => Number.isFinite(Number(item))).map(Number).sort((a, b) => a - b)
  if (!sorted.length) return ""
  return String(sorted[Math.floor(sorted.length / 2)])
}

function compact(value, maxChars = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : text
}

function parseArgs(argv) {
  const out = { optionsEnabled: true, finalWaitBackground: true, pairwise: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--goal") out.goal = argv[++i] || ""
    else if (arg.startsWith("--goal=")) out.goal = arg.slice("--goal=".length)
    else if (arg === "--persona") out.persona = argv[++i] || ""
    else if (arg.startsWith("--persona=")) out.persona = arg.slice("--persona=".length)
    else if (arg === "--turns") out.turns = Number(argv[++i])
    else if (arg.startsWith("--turns=")) out.turns = Number(arg.slice("--turns=".length))
    else if (arg === "--variants") out.variants = argv[++i]
    else if (arg.startsWith("--variants=")) out.variants = arg.slice("--variants=".length)
    else if (arg === "--parallel-variants") {
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.parallelVariants = argv[++i]
      else out.parallelVariants = "all"
    }
    else if (arg.startsWith("--parallel-variants=")) out.parallelVariants = arg.slice("--parallel-variants=".length)
    else if (arg === "--output-dir") out.outputDir = argv[++i]
    else if (arg.startsWith("--output-dir=")) out.outputDir = arg.slice("--output-dir=".length)
    else if (arg === "--run-id") out.runId = argv[++i]
    else if (arg.startsWith("--run-id=")) out.runId = arg.slice("--run-id=".length)
    else if (arg === "--wait-every") out.waitEvery = Number(argv[++i])
    else if (arg.startsWith("--wait-every=")) out.waitEvery = Number(arg.slice("--wait-every=".length))
    else if (arg === "--wait-background") out.waitBackground = true
    else if (arg === "--final-no-wait-background") out.finalWaitBackground = false
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i])
    else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice("--timeout-ms=".length))
    else if (arg === "--process-timeout-ms") out.processTimeoutMs = Number(argv[++i])
    else if (arg.startsWith("--process-timeout-ms=")) out.processTimeoutMs = Number(arg.slice("--process-timeout-ms=".length))
    else if (arg === "--options") out.optionsEnabled = true
    else if (arg === "--no-options") out.optionsEnabled = false
    else if (arg === "--player-model") out.playerModel = argv[++i]
    else if (arg.startsWith("--player-model=")) out.playerModel = arg.slice("--player-model=".length)
    else if (arg === "--persist-profiles") out.persistProfiles = true
    else if (arg === "--judge") out.judge = true
    else if (arg === "--no-pairwise") out.pairwise = false
    else if (arg === "--no-codex-review") out.codexReview = false
    else if (arg === "--judge-model") out.judgeModel = argv[++i]
    else if (arg.startsWith("--judge-model=")) out.judgeModel = arg.slice("--judge-model=".length)
    else if (arg === "--opening-action") out.openingAction = argv[++i] || ""
    else if (arg.startsWith("--opening-action=")) out.openingAction = arg.slice("--opening-action=".length)
    else if (arg === "--reading-cpm-zh") out.readingCpmZh = Number(argv[++i])
    else if (arg.startsWith("--reading-cpm-zh=")) out.readingCpmZh = Number(arg.slice("--reading-cpm-zh=".length))
    else if (arg === "--reading-cpm-en") out.readingCpmEn = Number(argv[++i])
    else if (arg.startsWith("--reading-cpm-en=")) out.readingCpmEn = Number(arg.slice("--reading-cpm-en=".length))
    else if (arg === "--worldbook-from") out.worldbookFromPath = argv[++i] || ""
    else if (arg.startsWith("--worldbook-from=")) out.worldbookFromPath = arg.slice("--worldbook-from=".length)
    else if (arg === "--worldbook-source-hint") out.worldbookSourceHint = argv[++i] || ""
    else if (arg.startsWith("--worldbook-source-hint=")) out.worldbookSourceHint = arg.slice("--worldbook-source-hint=".length)
  }
  return out
}

export async function readTurnsFallback(variantDir) {
  const turnsPath = path.join(variantDir, "turns.jsonl")
  let raw
  try {
    raw = await readFile(turnsPath, "utf8")
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (!lines.length) return null
  let lastRecord = null
  try {
    lastRecord = JSON.parse(lines[lines.length - 1])
  } catch {
    lastRecord = null
  }
  return {
    completedTurns: lines.length,
    lastTurnId: lastRecord?.turnId || "",
    lastTurn: lastRecord?.turn || lines.length,
    source: "turns.jsonl fallback (summary.json missing)",
  }
}

export function computeVariantStatus({ exitCode, summary, fallback, requestedTurns }) {
  if (exitCode === 0 && summary) return "completed"
  if (summary) return "completed"
  if (fallback && fallback.completedTurns > 0) {
    return fallback.completedTurns >= requestedTurns ? "partial-no-summary" : "partial"
  }
  return "failed"
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

function normalizeParallelVariants(value, variantCount) {
  const envValue = process.env.OPENOVEL_EVAL_PARALLEL_VARIANTS
  const selected = value ?? envValue ?? 1
  if (String(selected).toLowerCase() === "all") return Math.max(1, variantCount)
  const number = Number(selected)
  return Math.min(Math.max(1, Number.isFinite(number) ? Math.floor(number) : 1), Math.max(1, variantCount))
}

async function main() {
  const summary = await runAblationSuite(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
