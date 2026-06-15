import path from "node:path"
import { fileURLToPath } from "node:url"
import { readText, writeJson, writeText } from "../lib/files.js"
import { runAblationSuite } from "./ablationSuite.js"

const DEFAULT_VARIANTS = "control,no-background,no-storykeeper,no-memory-review,no-context-inserts"

export async function prepareTellMeAStoryCases(options = {}) {
  const args = normalizePrepareOptions(options)
  const examples = loadTellMeAStoryExamples(await readText(args.dataset, ""))
  const selected = examples.slice(args.offset, args.offset + args.limit)
  const cases = selected.map((example, index) =>
    convertTellMeAStoryExample(example, {
      split: args.split,
      index: args.offset + index,
      includeTargets: args.includeTargets,
      turns: args.turns,
      variants: args.variants,
    }),
  )

  await Promise.all(
    cases.map((item) => writeJson(path.join(args.outDir, `${safeName(item.caseId)}.json`), item)),
  )
  await writeJson(path.join(args.outDir, "manifest.json"), {
    source: "tell_me_a_story",
    dataset: args.dataset,
    split: args.split,
    offset: args.offset,
    limit: args.limit,
    count: cases.length,
    includeTargets: args.includeTargets,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      exampleId: item.sourceExampleId,
      file: `${safeName(item.caseId)}.json`,
    })),
  })
  return {
    outDir: args.outDir,
    count: cases.length,
    cases,
  }
}

export async function runTellMeAStoryCases(options = {}) {
  const args = normalizeRunOptions(options)
  const prepared = await prepareTellMeAStoryCases(args)
  const results = await mapWithConcurrency(prepared.cases, args.parallelCases, async (item) => {
    const outputDir = path.join(args.outputDir, safeName(item.caseId))
    const summary = await runAblationSuite({
      goal: item.evalGoal,
      persona: item.playerPersona,
      turns: args.turns,
      variants: args.variants,
      outputDir,
      runId: safeName(item.caseId),
      waitEvery: args.waitEvery,
      waitBackground: args.waitBackground,
      finalWaitBackground: args.finalWaitBackground,
      optionsEnabled: args.optionsEnabled,
      parallelVariants: args.parallelVariants,
      processTimeoutMs: args.processTimeoutMs,
      timeoutMs: args.timeoutMs,
      playerModel: args.playerModel,
      judge: args.judge,
      pairwise: args.pairwise,
      codexReview: args.codexReview,
    })
    await writeJson(path.join(outputDir, "tms-case.json"), item)
    await writeText(path.join(outputDir, "tms-reference.md"), renderReferencePacket(item))
    return {
      caseId: item.caseId,
      exampleId: item.sourceExampleId,
      outputDir,
      ok: summary.ok,
      completedVariants: summary.variants?.filter((variant) => variant.status === "completed").length || 0,
    }
  })

  const runSummary = {
    source: "tell_me_a_story",
    dataset: args.dataset,
    outputDir: args.outputDir,
    preparedCasesDir: args.outDir,
    turns: args.turns,
    variants: args.variants,
    parallelCases: args.parallelCases,
    parallelVariants: args.parallelVariants,
    results,
  }
  await writeJson(path.join(args.outputDir, "tms-run-summary.json"), runSummary)
  return runSummary
}

export function loadTellMeAStoryExamples(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`Invalid Tell Me A Story JSONL at line ${index + 1}: ${error.message}`)
      }
    })
    .filter((item) => typeof item.inputs === "string" && item.inputs.trim())
}

export function convertTellMeAStoryExample(example, options = {}) {
  const sourceExampleId = stringOr(example.example_id, `row_${options.index ?? 0}`)
  const inputPrompt = String(example.inputs || "").trim()
  const referenceTarget = String(example.targets || "").trim()
  const caseId = `tms_${safeName(sourceExampleId)}`
  const turns = Math.max(1, Number(options.turns) || 50)
  const variants = String(options.variants || DEFAULT_VARIANTS)
  return {
    caseId,
    source: "tell_me_a_story",
    sourceExampleId,
    split: stringOr(options.split, "unknown"),
    inputPrompt,
    referenceTarget: options.includeTargets === false ? "" : referenceTarget,
    targetUse: "evaluator-only; never include referenceTarget in foreground/model-player prompts",
    openovelOpening: buildOpenovelOpening(inputPrompt),
    evalGoal: buildEvalGoal({ inputPrompt, turns }),
    playerPersona: buildPlayerPersona(),
    evaluatorNotes: [
      "Treat the TMS input prompt as the binding premise for Openovel.",
      "Use the human target only as evaluator-side reference for plot, development, style, and language quality. Do not expect exact plot matching.",
      "Judge interactive continuity separately: player-caused anchors over the run matter more than matching the reference target.",
      "Check whether the foreground prose preserves style implied by the prompt without hard-coded named-style templates.",
    ],
    recommendedRun: {
      turns,
      variants,
      parallelVariants: 5,
      noOptions: true,
    },
  }
}

export function buildOpenovelOpening(inputPrompt) {
  return [
    "Start a new Openovel interactive story from this Tell Me A Story writing prompt.",
    "Preserve its premise, characters, constraints, tone, implied genre, and style cues.",
    "",
    inputPrompt.trim(),
  ].join("\n")
}

export function buildEvalGoal({ inputPrompt, turns = 50 }) {
  return [
    "Start an interactive Openovel story from the Tell Me A Story prompt below.",
    `Interact for ${turns} turns as a demanding reader-player.`,
    "Stress-test whether the premise, characters, objects, locations, constraints, conflicts, and style cues from the prompt remain visible after long gaps.",
    "Deliberately revisit early anchors later in the run. Correct the system if it forgets or contradicts them.",
    "Do not reveal or rely on the human reference target; evaluate the Openovel system from the prompt and transcript.",
    "",
    "Tell Me A Story prompt:",
    inputPrompt.trim(),
  ].join("\n")
}

function buildPlayerPersona() {
  return [
    "A demanding but fair interactive fiction reader.",
    "They pursue the TMS prompt's premise, test continuity, revisit old anchors, and notice style drift.",
    "They prefer free-form inputs over simply following options.",
  ].join(" ")
}

function renderReferencePacket(item) {
  return [
    `# Tell Me A Story Case ${item.caseId}`,
    "",
    `Source example id: ${item.sourceExampleId}`,
    `Split: ${item.split}`,
    "",
    "## Input Prompt",
    "",
    item.inputPrompt,
    "",
    "## Reference Target",
    "",
    item.referenceTarget || "_Not included._",
    "",
    "## Evaluator Reminder",
    "",
    "- Reference target is evaluator-only.",
    "- Do not require exact plot matching.",
    "- Score prompt fulfillment, long-run continuity, style fidelity, and story quality.",
  ].join("\n")
}

function normalizePrepareOptions(options = {}) {
  const dataset = options.dataset || process.env.OPENOVEL_TMS_DATASET
  if (!dataset) throw new Error("Tell Me A Story adapter needs --dataset <decrypted-jsonl>.")
  return {
    dataset: path.resolve(dataset),
    outDir: path.resolve(options.outDir || options.out || path.join(process.cwd(), "story", "evals", "tms-cases")),
    split: stringOr(options.split, "unknown"),
    offset: Math.max(0, Number(options.offset) || 0),
    limit: Math.max(1, Number(options.limit) || 10),
    includeTargets: options.includeTargets !== false,
    turns: Math.max(1, Number(options.turns) || 50),
    variants: String(options.variants || DEFAULT_VARIANTS),
  }
}

function normalizeRunOptions(options = {}) {
  const prepared = normalizePrepareOptions(options)
  return {
    ...prepared,
    outputDir: path.resolve(options.outputDir || path.join(process.cwd(), "story", "evals", `tms_${new Date().toISOString().replace(/[:.]/g, "-")}`)),
    parallelCases: Math.max(1, Number(options.parallelCases) || 1),
    parallelVariants: normalizeParallelVariants(options.parallelVariants),
    waitEvery: Math.max(0, Number(options.waitEvery ?? 10)),
    waitBackground: options.waitBackground === true,
    finalWaitBackground: options.finalWaitBackground !== false,
    optionsEnabled: options.optionsEnabled !== false,
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 300000),
    processTimeoutMs: Math.max(1000, Number(options.processTimeoutMs) || 7200000),
    playerModel: stringOr(options.playerModel, ""),
    judge: options.judge === true,
    pairwise: options.pairwise !== false,
    codexReview: options.codexReview !== false,
  }
}

function parseArgs(argv) {
  const out = { command: "prepare", includeTargets: true, optionsEnabled: true, finalWaitBackground: true, pairwise: true }
  if (argv[0] === "prepare" || argv[0] === "run") out.command = argv.shift()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dataset") out.dataset = argv[++i]
    else if (arg.startsWith("--dataset=")) out.dataset = arg.slice("--dataset=".length)
    else if (arg === "--out" || arg === "--out-dir") out.outDir = argv[++i]
    else if (arg.startsWith("--out=")) out.outDir = arg.slice("--out=".length)
    else if (arg.startsWith("--out-dir=")) out.outDir = arg.slice("--out-dir=".length)
    else if (arg === "--output-dir") out.outputDir = argv[++i]
    else if (arg.startsWith("--output-dir=")) out.outputDir = arg.slice("--output-dir=".length)
    else if (arg === "--split") out.split = argv[++i]
    else if (arg.startsWith("--split=")) out.split = arg.slice("--split=".length)
    else if (arg === "--offset") out.offset = Number(argv[++i])
    else if (arg.startsWith("--offset=")) out.offset = Number(arg.slice("--offset=".length))
    else if (arg === "--limit") out.limit = Number(argv[++i])
    else if (arg.startsWith("--limit=")) out.limit = Number(arg.slice("--limit=".length))
    else if (arg === "--turns") out.turns = Number(argv[++i])
    else if (arg.startsWith("--turns=")) out.turns = Number(arg.slice("--turns=".length))
    else if (arg === "--variants") out.variants = argv[++i]
    else if (arg.startsWith("--variants=")) out.variants = arg.slice("--variants=".length)
    else if (arg === "--parallel-cases") out.parallelCases = Number(argv[++i])
    else if (arg.startsWith("--parallel-cases=")) out.parallelCases = Number(arg.slice("--parallel-cases=".length))
    else if (arg === "--parallel-variants") out.parallelVariants = argv[++i] || "all"
    else if (arg.startsWith("--parallel-variants=")) out.parallelVariants = arg.slice("--parallel-variants=".length)
    else if (arg === "--no-targets") out.includeTargets = false
    else if (arg === "--no-options") out.optionsEnabled = false
    else if (arg === "--wait-background") out.waitBackground = true
    else if (arg === "--final-no-wait-background") out.finalWaitBackground = false
    else if (arg === "--wait-every") out.waitEvery = Number(argv[++i])
    else if (arg.startsWith("--wait-every=")) out.waitEvery = Number(arg.slice("--wait-every=".length))
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i])
    else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice("--timeout-ms=".length))
    else if (arg === "--process-timeout-ms") out.processTimeoutMs = Number(argv[++i])
    else if (arg.startsWith("--process-timeout-ms=")) out.processTimeoutMs = Number(arg.slice("--process-timeout-ms=".length))
    else if (arg === "--player-model") out.playerModel = argv[++i]
    else if (arg.startsWith("--player-model=")) out.playerModel = arg.slice("--player-model=".length)
    else if (arg === "--judge") out.judge = true
    else if (arg === "--no-pairwise") out.pairwise = false
    else if (arg === "--no-codex-review") out.codexReview = false
  }
  return out
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

function normalizeParallelVariants(value) {
  if (String(value || "").toLowerCase() === "all") return 5
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 1
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function safeName(value) {
  return String(value || "case")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "case"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = args.command === "run" ? await runTellMeAStoryCases(args) : await prepareTellMeAStoryCases(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
