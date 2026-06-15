import path from "node:path"
import { fileURLToPath } from "node:url"
import { readJson, writeText } from "../lib/files.js"

export async function writeCodexReviewPacket({ suiteDir, summary, outputPath } = {}) {
  if (!suiteDir && !summary?.outputDir) throw new Error("writeCodexReviewPacket needs suiteDir or summary.outputDir")
  const root = path.resolve(suiteDir || summary.outputDir)
  const data = summary || (await readJson(path.join(root, "suite-summary.json"), {}))
  const file = outputPath || path.join(root, "codex-review.md")
  await writeText(file, renderCodexReviewPacket({ summary: data, suiteDir: root }))
  return file
}

export function renderCodexReviewPacket({ summary = {}, suiteDir = summary.outputDir || "" } = {}) {
  const variants = Array.isArray(summary.variants) ? summary.variants : []
  const root = suiteDir || summary.outputDir || "-"
  return [
    `# Codex Evaluation Packet ${summary.runId || ""}`.trim(),
    "",
    "This packet is for Codex acting as the LLM evaluator. Do not treat automatic judge outputs as authoritative; use them only as optional comparison evidence if present.",
    "",
    "## Task",
    "",
    `Goal: ${summary.goal || "-"}`,
    `Requested turns: ${summary.turns || "-"}`,
    `Suite directory: ${root}`,
    "",
    "Evaluate whether Openovel remains coherent over long interactive play, whether earlier player actions remain visible later, whether prose follows the user's requested style, and whether the system controls context growth instead of relying on unbounded prompt expansion.",
    "",
    "## Required Evidence",
    "",
    "- Read `suite-summary.json` and `report.md` first for metrics.",
    "- For each variant, read `summary.json`, `turns.jsonl`, and `transcript.md`.",
    "- Inspect each variant workspace when needed: `workspace/guidance/FOREGROUND.md`, `workspace/canon/chapters.md`, `workspace/canon/scene_log.jsonl`, `workspace/inbox/INBOX.md`, and `workspace/memory/MEMORY.md`.",
    "- Use automatic `judgments/*.json` only as a secondary signal if they exist.",
    "",
    "## Variant Artifacts",
    "",
    "| Variant | Status | Turns | Transcript | Turns JSONL | Summary | Workspace |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
    ...variants.map((item) =>
      [
        item.variant,
        item.status,
        `${item.completedTurns || 0}/${item.requestedTurns || summary.turns || 0}`,
        rel(root, path.join(item.runDir || "", "transcript.md")),
        rel(root, path.join(item.runDir || "", "turns.jsonl")),
        rel(root, path.join(item.runDir || "", "summary.json")),
        rel(root, path.join(item.runDir || "", "workspace")),
      ].join(" | "),
    ).map((row) => `| ${row} |`),
    "",
    "## Evaluation Rubric",
    "",
    "Use 1-5 scores with evidence. 5 means consistently strong; 3 means usable but visibly weak; 1 means severe failure.",
    "",
    "- `playerActionContinuity`: earlier player choices affect later narration and available situation.",
    "- `entityPersistence`: recruited people, companions, tools, places, injuries, promises, and constraints do not vanish or mutate without cause.",
    "- `consequenceTracking`: costs, discoveries, resources, debts, timing pressure, and irreversible actions continue to matter.",
    "- `storyCoherence`: timeline, location, causality, viewpoint, and scene transitions stay understandable.",
    "- `quality.plot`: dramatic progression has causality and payoff.",
    "- `quality.creativity`: imagery, premise, and turns are lively without breaking coherence.",
    "- `quality.development`: characters, tensions, and situation deepen over time.",
    "- `quality.languageUse`: prose is fluent, readable, and appropriate to the user's style request.",
    "- `styleFidelity`: the prose obeys the user's requested writing texture. Plain means plain; ornate/flamboyant means intentionally heightened. Judge fit to user intent, not closeness to a hard-coded author template.",
    "- `styleAdaptation`: the background loop notices style feedback, searches or inspects references when useful, and turns them into compact editable craft/context cards rather than fixed presets.",
    "- `contextControl`: inserted foreground context remains bounded; raw growth is measured; high pressure triggers useful compaction rather than silent loss.",
    "",
    "## Anchor Audit Instructions",
    "",
    "Extract player-caused anchors from early and middle turns. For each anchor, record:",
    "",
    "- anchor",
    "- introduced turn",
    "- expected later effect",
    "- status: `preserved`, `resolved`, `forgotten`, `contradicted`, or `not_tested`",
    "- evidence with turn numbers",
    "- severity: `none`, `minor`, `major`, or `critical`",
    "",
    "Do not count unchosen reader-facing options as canon. Judge only what the player selected and what narration confirmed.",
    "",
    "## Style Fidelity Checks",
    "",
    "For each variant, inspect the original goal/persona and the transcript for explicit style requests or corrections. Then answer:",
    "",
    "- Did the prose follow plain/ornate/flamboyant/documentary/etc. requests when present?",
    "- Did the style remain compatible with agency, causality, and scene clarity?",
    "- Did the background loop create or update compact style guidance, research notes, or context cards when a style reference required grounding?",
    "- Did the system avoid static named-author templates and instead use editable operational traits?",
    "- Did style drift across turns, especially after long context growth or background updates?",
    "",
    "## Context Growth Checks",
    "",
    "For each variant, inspect `summary.json.contextGrowth` and answer:",
    "",
    "- How fast did included foreground context grow per turn?",
    "- How fast did raw underlying context grow per turn?",
    "- Was the foreground context bounded by compiler budgets?",
    "- Were sources clipped, and did clipping hide important continuity?",
    "- Did Storykeeper or memory review actively compact or maintain the fast-path working set?",
    "- Did `FOREGROUND.md` stay compact and useful, or become a dumping ground?",
    "",
    "## Output Format For Codex",
    "",
    "Write a concise report with:",
    "",
    "1. Overall verdict.",
    "2. Per-variant score table.",
    "3. Anchor audit table with turn evidence.",
    "4. Style fidelity findings.",
    "5. Context growth/control findings.",
    "6. Notable continuity failures and examples.",
    "7. Story quality findings.",
    "8. Recommended next fixes, ordered by impact.",
    "",
    "## Metric Snapshot",
    "",
    "| Variant | Cost | First frame p50 | Last frame p50 | Context verdict | Included chars/turn | Raw chars/turn | High pressure | Truncated turns |",
    "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |",
    ...variants.map((item) =>
      [
        item.variant,
        item.openovel?.estimatedCostUSD ?? "",
        medianString(item.openovel?.firstFrameMs),
        medianString(item.openovel?.lastFrameMs),
        item.contextGrowth?.controllability?.verdict ?? "",
        item.contextGrowth?.growthPerTurn?.includedChars ?? "",
        item.contextGrowth?.growthPerTurn?.rawChars ?? "",
        item.contextGrowth?.pressure?.highPressureTurns ?? "",
        item.contextGrowth?.pressure?.truncatedTurns ?? "",
      ].join(" | "),
    ).map((row) => `| ${row} |`),
    "",
  ].join("\n")
}

function rel(root, file) {
  if (!file || file === ".") return "-"
  const resolvedRoot = path.resolve(root || ".")
  const resolvedFile = path.resolve(file)
  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/") || "."
}

function medianString(values) {
  if (!Array.isArray(values) || !values.length) return ""
  const sorted = values.filter((item) => Number.isFinite(Number(item))).map(Number).sort((a, b) => a - b)
  if (!sorted.length) return ""
  return String(sorted[Math.floor(sorted.length / 2)])
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--suite-dir") out.suiteDir = argv[++i]
    else if (arg.startsWith("--suite-dir=")) out.suiteDir = arg.slice("--suite-dir=".length)
    else if (arg === "--output") out.outputPath = argv[++i]
    else if (arg.startsWith("--output=")) out.outputPath = arg.slice("--output=".length)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = await writeCodexReviewPacket(args)
  process.stdout.write(`${file}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
