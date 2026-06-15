import path from "node:path"
import { fileURLToPath } from "node:url"
import { readJson, readText, writeJson, writeText } from "../lib/files.js"
import { parseJsonObject } from "../lib/json.js"
import { createChatMessage } from "../provider/openaiCompatible.js"
import { withRetry } from "../lib/retry.js"
import { estimateCostUSD, normalizeUsage } from "../telemetry/usageProfile.js"
import { evaluatorContract } from "../prompts/agentContracts.js"

// createChatMessage now retries transient errors itself; judgeRun's own
// retry wrapping is redundant. Keep callJudgeWithRetry exported as a thin alias
// for back-compat with existing tests.
export const callJudgeWithRetry = withRetry

const DEFAULT_JUDGE_MODEL = "deepseek-v4-pro"
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
const DEFAULT_JUDGE_MAX_TOKENS = 384000
const QUALITY_DIMENSIONS = ["plot", "creativity", "development", "languageUse", "styleFidelity", "overall"]
const CONTINUITY_DIMENSIONS = [
  "playerActionContinuity",
  "entityPersistence",
  "consequenceTracking",
  "storyCoherence",
  "overall",
]

export async function judgeRun({ runDir, goal = "", variant = "", config = {} } = {}) {
  if (!runDir) throw new Error("judgeRun needs runDir")
  const artifacts = await loadRunArtifacts(runDir)
  const judgeConfig = normalizeJudgeConfig(config)
  const messages = buildContinuityJudgeMessages({
    goal: goal || artifacts.summary?.goal || "",
    variant: variant || artifacts.summary?.runId || path.basename(runDir),
    summary: artifacts.summary,
    turns: artifacts.turns,
  })
  // createChatMessage retries transient failures internally.
  const message = await createChatMessage({
    baseUrl: judgeConfig.baseUrl,
    apiKey: judgeConfig.apiKey,
    model: judgeConfig.model,
    messages,
    temperature: judgeConfig.temperature,
    maxTokens: judgeConfig.maxTokens,
    timeoutMs: judgeConfig.timeoutMs,
    json: true,
    bodyTransform: deepseekJudgeBodyTransform,
  })
  const raw = message.content || ""
  const parsed = parseJsonObject(raw, {})
  const judgment = normalizeContinuityJudgment(parsed, {
    goal: goal || artifacts.summary?.goal || "",
    variant: variant || artifacts.summary?.runId || path.basename(runDir),
    runDir,
  })
  if (!Object.keys(parsed).length) {
    judgment.parseWarning = "Judge response was not parseable JSON. Increase OPENOVEL_EVAL_JUDGE_MAX_TOKENS or use a non-reasoning judge model."
    judgment.rawPreview = compact(raw || message.reasoning_content || "", 1000)
  }
  judgment.judge = judgeTelemetry({ message, config: judgeConfig })
  return judgment
}

export async function judgePairwise({ baselineDir, candidateDir, goal = "", baselineVariant = "control", candidateVariant = "", config = {} } = {}) {
  if (!baselineDir || !candidateDir) throw new Error("judgePairwise needs baselineDir and candidateDir")
  const [baseline, candidate] = await Promise.all([loadRunArtifacts(baselineDir), loadRunArtifacts(candidateDir)])
  const judgeConfig = normalizeJudgeConfig(config)
  const messages = buildPairwiseJudgeMessages({
    goal: goal || baseline.summary?.goal || candidate.summary?.goal || "",
    baseline: {
      variant: baselineVariant || baseline.summary?.runId || path.basename(baselineDir),
      summary: baseline.summary,
      turns: baseline.turns,
    },
    candidate: {
      variant: candidateVariant || candidate.summary?.runId || path.basename(candidateDir),
      summary: candidate.summary,
      turns: candidate.turns,
    },
  })
  // createChatMessage retries transient failures internally.
  const message = await createChatMessage({
    baseUrl: judgeConfig.baseUrl,
    apiKey: judgeConfig.apiKey,
    model: judgeConfig.model,
    messages,
    temperature: judgeConfig.temperature,
    maxTokens: judgeConfig.maxTokens,
    timeoutMs: judgeConfig.timeoutMs,
    json: true,
    bodyTransform: deepseekJudgeBodyTransform,
  })
  const raw = message.content || ""
  const parsed = parseJsonObject(raw, {})
  const comparison = normalizePairwiseJudgment(parsed, {
    baselineVariant,
    candidateVariant,
    baselineDir,
    candidateDir,
  })
  if (!Object.keys(parsed).length) {
    comparison.parseWarning = "Judge response was not parseable JSON. Increase OPENOVEL_EVAL_JUDGE_MAX_TOKENS or use a non-reasoning judge model."
    comparison.rawPreview = compact(raw || message.reasoning_content || "", 1000)
  }
  comparison.judge = judgeTelemetry({ message, config: judgeConfig })
  return comparison
}

export async function loadRunArtifacts(runDir) {
  const summary = await readJson(path.join(runDir, "summary.json"), {})
  const turnsText = await readText(path.join(runDir, "turns.jsonl"), "")
  const turns = turnsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { summary, turns }
}

export function buildContinuityJudgeMessages({ goal = "", variant = "", summary = {}, turns = [] } = {}) {
  return [
    {
      role: "system",
      content: [
        "<role>",
        "You are a rigorous evaluator for long interactive fiction systems.",
        "</role>",
        "",
        evaluatorContract(),
        "",
        "<method>",
        "Adapt the Tell Me A Story evaluation spirit: judge long narratives on plot, creativity, development, language use, and overall quality.",
        "For Openovel, add a strict continuity audit focused on player-caused facts across many turns.",
        "Evaluate only the transcript evidence. Do not assume hidden state. Do not reward a system for facts that are only in internal notes and never affect reader-facing prose.",
        "</method>",
        "",
        "<continuity_focus>",
        "Track anchors introduced by the player or confirmed by narration: recruited people, companions, tools, injuries, promises, locations, constraints, discovered facts, relationships, debts, resource limits, time pressure, and irreversible actions.",
        "A later scene should preserve or naturally resolve those anchors. Penalize unexplained disappearances, reversals, renamed entities, reset locations, ignored consequences, and contradictions.",
        "Do not penalize optional UI choices that the player did not select.",
        "</continuity_focus>",
        "",
        "<scoring>",
        "Use 1-5 integer scores. 5 means consistently strong; 3 means usable but with visible weaknesses; 1 means severe failure.",
        "playerActionContinuity: earlier player actions influence later events.",
        "entityPersistence: recruited/introduced characters, tools, and locations do not vanish or mutate without cause.",
        "consequenceTracking: costs, injuries, commitments, clues, constraints, and discoveries keep mattering.",
        "storyCoherence: the world, timeline, causality, and scene transitions remain understandable.",
        "quality.plot / creativity / development / languageUse follow the Tell Me A Story dimensions.",
        "quality.styleFidelity: the prose honors explicit reader/user style requests. Plain requests should stay plain; ornate/flamboyant requests should become intentionally heightened without becoming incoherent. Judge operational fit, not exact imitation.",
        "</scoring>",
        "",
        "<output>",
        "Return JSON only. No Markdown.",
        "Schema: {",
        '  "variant": string,',
        '  "scores": { "playerActionContinuity": number, "entityPersistence": number, "consequenceTracking": number, "storyCoherence": number, "overall": number },',
        '  "quality": { "plot": number, "creativity": number, "development": number, "languageUse": number, "styleFidelity": number, "overall": number },',
        '  "anchors": [{ "anchor": string, "introducedTurn": number, "expectedLaterEffect": string, "status": "preserved|resolved|forgotten|contradicted|not_tested", "evidence": string, "severity": "none|minor|major|critical" }],',
        '  "forgottenOrContradicted": [string],',
        '  "strengths": [string],',
        '  "recommendations": [string],',
        '  "assessment": string',
        "}",
        "</output>",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          evalGoal: goal,
          variant,
          runSummary: compactSummary(summary),
          transcript: compactTurns(turns),
        },
        null,
        2,
      ),
    },
  ]
}

export function buildPairwiseJudgeMessages({ goal = "", baseline = {}, candidate = {} } = {}) {
  return [
    {
      role: "system",
      content: [
        "<role>",
        "You are a side-by-side evaluator for Openovel ablation experiments.",
        "</role>",
        "",
        evaluatorContract(),
        "",
        "<method>",
        "Follow the Tell Me A Story pairwise preference pattern: compare Story A and Story B on plot, creativity, development, language use, and overall quality.",
        "Also compare Openovel-specific continuity: player-action continuity, entity persistence, consequence tracking, and story coherence.",
        "Also compare style fidelity: whether the story adapts to the user's requested prose style without relying on hard-coded templates.",
        "Prefer the transcript that better preserves player-caused anchors over 50-turn interaction.",
        "</method>",
        "",
        "<output>",
        "Return JSON only. No Markdown.",
        "Use A for baseline and B for candidate.",
        "Schema: {",
        '  "baselineVariant": string,',
        '  "candidateVariant": string,',
        '  "winners": { "playerActionContinuity": "A|B|Same", "entityPersistence": "A|B|Same", "consequenceTracking": "A|B|Same", "storyCoherence": "A|B|Same", "plot": "A|B|Same", "creativity": "A|B|Same", "development": "A|B|Same", "languageUse": "A|B|Same", "styleFidelity": "A|B|Same", "overall": "A|B|Same" },',
        '  "evidence": [string],',
        '  "regressions": [string],',
        '  "assessment": string',
        "}",
        "</output>",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          evalGoal: goal,
          storyA: {
            variant: baseline.variant || "control",
            runSummary: compactSummary(baseline.summary || {}),
            transcript: compactTurns(baseline.turns || []),
          },
          storyB: {
            variant: candidate.variant || "candidate",
            runSummary: compactSummary(candidate.summary || {}),
            transcript: compactTurns(candidate.turns || []),
          },
        },
        null,
        2,
      ),
    },
  ]
}

export function normalizeContinuityJudgment(parsed = {}, defaults = {}) {
  const scores = normalizeScoreObject(parsed.scores, CONTINUITY_DIMENSIONS)
  const quality = normalizeScoreObject(parsed.quality, QUALITY_DIMENSIONS)
  const anchors = Array.isArray(parsed.anchors)
    ? parsed.anchors.map(normalizeAnchor).filter((item) => item.anchor).slice(0, 60)
    : []
  return {
    variant: stringOr(parsed.variant, defaults.variant || ""),
    goal: defaults.goal || "",
    runDir: defaults.runDir || "",
    scores,
    quality,
    anchors,
    forgottenOrContradicted: stringArray(parsed.forgottenOrContradicted).slice(0, 30),
    strengths: stringArray(parsed.strengths).slice(0, 20),
    recommendations: stringArray(parsed.recommendations).slice(0, 20),
    assessment: compact(parsed.assessment, 3000),
  }
}

export function normalizePairwiseJudgment(parsed = {}, defaults = {}) {
  const winnerKeys = [
    ...CONTINUITY_DIMENSIONS.filter((item) => item !== "overall"),
    "plot",
    "creativity",
    "development",
    "languageUse",
    "styleFidelity",
    "overall",
  ]
  const winners = {}
  for (const key of winnerKeys) winners[key] = normalizeWinner(parsed.winners?.[key])
  return {
    baselineVariant: stringOr(parsed.baselineVariant, defaults.baselineVariant || "control"),
    candidateVariant: stringOr(parsed.candidateVariant, defaults.candidateVariant || ""),
    baselineDir: defaults.baselineDir || "",
    candidateDir: defaults.candidateDir || "",
    winners,
    evidence: stringArray(parsed.evidence).slice(0, 30),
    regressions: stringArray(parsed.regressions).slice(0, 30),
    assessment: compact(parsed.assessment, 3000),
  }
}

export function renderJudgmentMarkdown(judgment) {
  const anchors = Array.isArray(judgment.anchors) ? judgment.anchors : []
  return [
    `# Openovel Judge: ${judgment.variant || "run"}`,
    "",
    `Run: ${judgment.runDir || "-"}`,
    judgment.parseWarning ? `Warning: ${judgment.parseWarning}` : "",
    "",
    "## Continuity Scores",
    "",
    ...Object.entries(judgment.scores || {}).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Story Quality",
    "",
    ...Object.entries(judgment.quality || {}).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Anchor Audit",
    "",
    ...(anchors.length
      ? anchors.map((item) => `- T${item.introducedTurn || "?"} ${item.anchor}: ${item.status} (${item.severity}) — ${item.evidence}`)
      : ["- No anchors returned by judge."]),
    "",
    "## Assessment",
    "",
    judgment.assessment || "-",
  ].join("\n")
}

function compactSummary(summary = {}) {
  return {
    runId: summary.runId,
    requestedTurns: summary.requestedTurns,
    completedTurns: summary.completedTurns,
    stopReason: summary.stopReason,
    providers: summary.providers,
    openovel: summary.openovel,
    player: summary.player,
    final: summary.final,
  }
}

function compactTurns(turns = [], maxNarrationChars = 1400) {
  return turns.map((turn) => ({
    turn: turn.turn,
    playerAction: compact(turn.player?.action, 700),
    playerFocus: compact(turn.player?.focus, 180),
    narration: compact(turn.openovel?.narration, maxNarrationChars),
    tension: compact(turn.openovel?.tension, 160),
    backgroundJobs: (turn.backgroundJobs || []).map((job) => ({
      type: job.type,
      status: job.status,
      error: compact(job.error, 240),
    })),
    context: {
      foregroundGuidanceChars: String(turn.foregroundGuidance || "").length,
      inboxPending: turn.inboxPending,
      sources: (turn.contextReport?.sources || []).map((source) => ({
        type: source.type,
        included: source.included,
        chars: source.chars,
        truncated: source.truncated,
      })),
    },
  }))
}

function normalizeJudgeConfig(config = {}) {
  const apiKey =
    config.apiKey ||
    process.env.OPENOVEL_EVAL_JUDGE_API_KEY ||
    process.env.OPENOVEL_EVAL_DEEPSEEK_API_KEY ||
    process.env.OPENOVEL_EVAL_API_KEY ||
    process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("Missing judge DeepSeek key. Set OPENOVEL_EVAL_JUDGE_API_KEY or OPENOVEL_EVAL_DEEPSEEK_API_KEY.")
  return {
    apiKey,
    baseUrl:
      config.baseUrl ||
      process.env.OPENOVEL_EVAL_JUDGE_BASE_URL ||
      process.env.OPENOVEL_EVAL_DEEPSEEK_BASE_URL ||
      process.env.OPENOVEL_EVAL_BASE_URL ||
      process.env.DEEPSEEK_BASE_URL ||
      DEFAULT_DEEPSEEK_BASE_URL,
    model:
      config.model ||
      process.env.OPENOVEL_EVAL_JUDGE_MODEL ||
      process.env.OPENOVEL_EVAL_LARGE_JUDGE_MODEL ||
      DEFAULT_JUDGE_MODEL,
    temperature: Number(config.temperature ?? process.env.OPENOVEL_EVAL_JUDGE_TEMPERATURE ?? 0.2),
    maxTokens: Number(config.maxTokens ?? process.env.OPENOVEL_EVAL_JUDGE_MAX_TOKENS ?? DEFAULT_JUDGE_MAX_TOKENS),
    timeoutMs: Number(config.timeoutMs ?? process.env.OPENOVEL_EVAL_JUDGE_TIMEOUT_MS ?? 90000),
  }
}

function deepseekJudgeBodyTransform(body) {
  const value = String(body.model || "").toLowerCase()
  if (value === "deepseek-v4-flash") return { ...body, thinking: { type: "disabled" } }
  if (value === "deepseek-v4-pro") {
    const next = { ...body, thinking: { type: "enabled" }, reasoning_effort: process.env.OPENOVEL_EVAL_JUDGE_REASONING_EFFORT || "medium" }
    delete next.temperature
    return next
  }
  return body
}

function judgeTelemetry({ message, config }) {
  const telemetry = message._apiTelemetry || {}
  const usage = normalizeUsage(telemetry.usage || {})
  return {
    provider: "deepseek-eval",
    model: config.model,
    durationMs: telemetry.durationMs || 0,
    usage,
    cost: estimateCostUSD({ model: config.model, usage }),
  }
}

function normalizeScoreObject(value, keys) {
  const out = {}
  for (const key of keys) out[key] = clampScore(value?.[key])
  return out
}

function normalizeAnchor(value = {}) {
  return {
    anchor: compact(value.anchor, 240),
    introducedTurn: positiveInt(value.introducedTurn),
    expectedLaterEffect: compact(value.expectedLaterEffect, 500),
    status: normalizeStatus(value.status),
    evidence: compact(value.evidence, 700),
    severity: normalizeSeverity(value.severity),
  }
}

function normalizeStatus(value) {
  const text = String(value || "").toLowerCase()
  return ["preserved", "resolved", "forgotten", "contradicted", "not_tested"].includes(text) ? text : "not_tested"
}

function normalizeSeverity(value) {
  const text = String(value || "").toLowerCase()
  return ["none", "minor", "major", "critical"].includes(text) ? text : "minor"
}

function normalizeWinner(value) {
  const text = String(value || "").trim().toLowerCase()
  if (text === "a" || text === "story a" || text === "baseline") return "A"
  if (text === "b" || text === "story b" || text === "candidate") return "B"
  return "Same"
}

function clampScore(value) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return 0
  return Math.min(5, Math.max(1, number))
}

function positiveInt(value) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : 0
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => compact(item, 700)) : []
}

function stringOr(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function compact(value, maxChars = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : text
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--run-dir") out.runDir = argv[++i]
    else if (arg.startsWith("--run-dir=")) out.runDir = arg.slice("--run-dir=".length)
    else if (arg === "--goal") out.goal = argv[++i] || ""
    else if (arg.startsWith("--goal=")) out.goal = arg.slice("--goal=".length)
    else if (arg === "--variant") out.variant = argv[++i] || ""
    else if (arg.startsWith("--variant=")) out.variant = arg.slice("--variant=".length)
    else if (arg === "--output") out.output = argv[++i]
    else if (arg.startsWith("--output=")) out.output = arg.slice("--output=".length)
    else if (arg === "--model") out.model = argv[++i]
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const judgment = await judgeRun({
    runDir: args.runDir,
    goal: args.goal,
    variant: args.variant,
    config: { model: args.model },
  })
  const output = args.output || path.join(args.runDir, "judgment.json")
  await writeJson(output, judgment)
  await writeText(output.replace(/\.json$/i, ".md"), renderJudgmentMarkdown(judgment))
  process.stdout.write(`${JSON.stringify(judgment, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
