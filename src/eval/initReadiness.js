// Readiness analyzer. Post-processes a runInitEval output directory
// against the user's verification criterion: "init 文件夹内容是否完备 / 能否
//支持快速模型". Runs without making any model calls — pure file inspection.
//
// Each cell scored on 6 readiness axes a small foreground narrator depends on:
//
//   1. chaptersInitial — chapters.md exists with ≥ 200 chars of clean prose
//      (no markdown headings / no list bullets — narrator-voice opening)
//   2. constants — guidance has a non-empty Constants section. Without this
//      a small narrator drifts on durable facts after a few turns.
//   3. characters — at least one character card written. The small model
//      doesn't infer character roles from prose alone; cards are the
//      identity anchor.
//   4. scene — FG.md has a non-empty Scene section grounding where the
//      protagonist currently is.
//   5. tone — FG.md has a non-empty Tone section. Cheap models default to a
//      generic register without one.
//   6. forbidden — FG.md has Forbidden section. Catches narrator drift
//      into wrong genres / explicit content the worldbook prohibits.
//
// A cell that hits all 6 + non-empty FG.md template is "ready for small
// model". 4-5 hits = "small model with caveats". ≤ 3 = "small model will
// drift fast / needs large model".
//
// Usage:
//   node src/eval/initReadiness.js <runDir>
//   node src/eval/initReadiness.js                  # latest initEval_* in story/evals/

import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { readFile, readdir, writeFile } from "node:fs/promises"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const READINESS_THRESHOLDS = {
  ready: 6,             // all 6 axes hit
  ready_with_caveats: 4, // 4-5 axes
  // < 4 → not ready
}

const MIN_CHAPTERS_CHARS = 200
const MIN_SECTION_CHARS = 20  // avoid counting "—" or " " as a real section

export async function analyzeRun(runDir) {
  if (!existsSync(runDir)) throw new Error(`Run dir not found: ${runDir}`)
  const summaryPath = path.join(runDir, "summary.json")
  if (!existsSync(summaryPath)) throw new Error(`No summary.json under ${runDir}`)
  const summary = JSON.parse(await readFile(summaryPath, "utf8"))

  const cells = []
  for (const result of summary.results) {
    const cellDir = path.join(runDir, result.id)
    if (!existsSync(cellDir)) {
      cells.push({ id: result.id, found: false, scores: null })
      continue
    }
    const scores = await scoreCell(cellDir)
    cells.push({ id: result.id, category: result.category, size: result.size, found: true, scores })
  }
  const report = buildReadinessReport({ summary, cells, runDir })
  const outPath = path.join(runDir, "readiness.md")
  await writeFile(outPath, report)
  process.stderr.write(`[initReadiness] ${outPath}\n`)
  return { runDir, cells, reportPath: outPath }
}

async function scoreCell(cellDir) {
  const artifactsDir = path.join(cellDir, "artifacts")
  const fgDir = path.join(artifactsDir, "foreground")
  const charsDir = path.join(artifactsDir, "characters")

  const chapters = await readFile(path.join(artifactsDir, "chapters.md"), "utf8").catch(() => "")
  const fgGuidance = await readFile(path.join(artifactsDir, "foregroundGuidance.md"), "utf8").catch(() => "")
  const fgTemplate = await readFile(path.join(artifactsDir, "foregroundTemplate.md"), "utf8").catch(() => "")

  const sectionFiles = existsSync(fgDir)
    ? (await readdir(fgDir)).filter((f) => f.endsWith(".md"))
    : []
  const sections = {}
  for (const f of sectionFiles) {
    const text = await readFile(path.join(fgDir, f), "utf8").catch(() => "")
    sections[f.replace(/^\d+-/, "").replace(/\.md$/, "")] = text
  }

  const characterFiles = existsSync(charsDir)
    ? (await readdir(charsDir)).filter((f) => f.endsWith(".md"))
    : []

  const axes = {
    chaptersInitial: scoreChapters(chapters),
    constants: scoreSection(sections.constants || sections["must-keep"] || pickSection(fgGuidance, "Constants") || pickSection(fgGuidance, "Must Keep")),
    characters: scoreCharacters(characterFiles, sections["active-characters"]),
    scene: scoreSection(sections["scene"] || pickSection(fgGuidance, "Scene")),
    tone: scoreSection(sections["tone"] || pickSection(fgGuidance, "Tone")),
    forbidden: scoreSection(sections["forbidden"] || pickSection(fgGuidance, "Forbidden")),
  }
  const hits = Object.values(axes).filter((a) => a.pass).length
  let verdict
  if (hits >= READINESS_THRESHOLDS.ready) verdict = "ready"
  else if (hits >= READINESS_THRESHOLDS.ready_with_caveats) verdict = "ready_with_caveats"
  else verdict = "needs_large_model"
  return { axes, hits, verdict, fgBytes: fgGuidance.length, templateBytes: fgTemplate.length }
}

function scoreChapters(text) {
  if (!text) return { pass: false, reason: "missing", bytes: 0 }
  // Strip leading meta if present. Narrator-voice means no markdown headings
  // or list bullets in the BODY (a leading "# Chapters" heading is fine).
  const stripped = text.replace(/^#[^\n]*\n+/, "").trim()
  if (stripped.length < MIN_CHAPTERS_CHARS) {
    return { pass: false, reason: `too short (${stripped.length} < ${MIN_CHAPTERS_CHARS})`, bytes: stripped.length }
  }
  // Body should not have heavy markdown / list structure — that's worldbook,
  // not narrator voice. Allow occasional emphasis (**bold**) but flag if
  // ≥ 30% of lines are bullet/heading.
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim())
  const structural = lines.filter((l) => /^(#+\s|[-*+]\s|\d+\.\s)/.test(l)).length
  const ratio = lines.length ? structural / lines.length : 0
  if (ratio > 0.3) {
    return { pass: false, reason: `too markdown-ish (${(ratio * 100).toFixed(0)}% structural lines)`, bytes: stripped.length }
  }
  return { pass: true, bytes: stripped.length, structuralRatio: Number(ratio.toFixed(2)) }
}

function scoreSection(text) {
  if (!text) return { pass: false, reason: "missing", bytes: 0 }
  const body = stripFrontmatterAndHeading(text).trim()
  if (body.length < MIN_SECTION_CHARS) {
    return { pass: false, reason: `too short (${body.length} < ${MIN_SECTION_CHARS})`, bytes: body.length }
  }
  return { pass: true, bytes: body.length }
}

function scoreCharacters(characterFiles, activeCharsSection) {
  // Either real character cards OR an active-characters FG section counts.
  // The latter is the lighter form (no per-character file, just a roster).
  if (characterFiles.length > 0) {
    return { pass: true, kind: "character_cards", count: characterFiles.length }
  }
  if (activeCharsSection) {
    const body = stripFrontmatterAndHeading(activeCharsSection).trim()
    // Need at least one bulleted entry or named role to count.
    const entries = body.split(/\r?\n/).filter((l) => /^[-*+]\s|^\d+\.\s/.test(l))
    if (entries.length >= 1) {
      return { pass: true, kind: "fg_active_characters", count: entries.length }
    }
  }
  return { pass: false, reason: "no character cards and FG/active-characters empty or unbulleted" }
}

function stripFrontmatterAndHeading(text) {
  let out = text
  // YAML frontmatter
  out = out.replace(/^---\n[\s\S]*?\n---\n*/, "")
  // Top-level # / ## heading
  out = out.replace(/^#+\s*[^\n]*\n+/, "")
  return out
}

// When sections only exist as concatenated chunks inside FOREGROUND.md (rather
// than in per-section files), pick them out by heading.
function pickSection(combined, heading) {
  if (!combined) return ""
  const re = new RegExp(`##+\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, "i")
  const m = combined.match(re)
  return m ? m[1] : ""
}

function buildReadinessReport({ summary, cells, runDir }) {
  const rel = (p) => path.relative(PROJECT_ROOT, p)
  const lines = [
    `# Init readiness — ${path.basename(runDir)}`,
    "",
    `Verification criterion: init 文件夹是否完备，能否支持快速 (small) 模型独立 narrate。`,
    "",
    `**Run dir**: \`${rel(runDir)}\``,
    `**Cells**: ${cells.length}`,
    "",
    "## Axes (6 boxes a small foreground narrator needs)",
    "",
    "1. `chaptersInitial` — chapters.md ≥ 200 chars of narrator-voice prose (no heavy markdown/bullets)",
    "2. `constants` — non-empty Constants section (durable invariants the narrator must preserve)",
    "3. `characters` — at least one character card OR a bulleted Active Characters section",
    "4. `scene` — non-empty Scene section",
    "5. `tone` — non-empty Tone section",
    "6. `forbidden` — non-empty Forbidden / Avoid section",
    "",
    "Verdict ladder: 6 hits = `ready`, 4-5 = `ready_with_caveats`, ≤ 3 = `needs_large_model`",
    "",
    "## Summary table",
    "",
    "| fixture | verdict | hits | chapters | constants | chars | scene | tone | forbid | FG.md bytes |",
    "| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: |",
  ]
  for (const cell of cells) {
    if (!cell.found || !cell.scores) {
      lines.push(`| \`${cell.id}\` | missing | — | — | — | — | — | — | — | — |`)
      continue
    }
    const s = cell.scores
    const tick = (a) => (a.pass ? "✓" : "✗")
    lines.push(
      `| \`${cell.id}\` | **${s.verdict}** | ${s.hits}/6 | ${tick(s.axes.chaptersInitial)} | ${tick(s.axes.constants)} | ${tick(s.axes.characters)} | ${tick(s.axes.scene)} | ${tick(s.axes.tone)} | ${tick(s.axes.forbidden)} | ${s.fgBytes} |`,
    )
  }

  lines.push("", "## Detail per cell", "")
  for (const cell of cells) {
    lines.push(`### \`${cell.id}\``, "")
    if (!cell.found) { lines.push(`Cell directory not found.`, ""); continue }
    const s = cell.scores
    lines.push(`Verdict: **${s.verdict}** (${s.hits}/6 axes)`, "")
    lines.push(`FG.md bytes: ${s.fgBytes}; FG_template.md bytes: ${s.templateBytes}`, "")
    for (const [name, axis] of Object.entries(s.axes)) {
      const mark = axis.pass ? "✓" : "✗"
      const extra = []
      if (axis.bytes !== undefined) extra.push(`${axis.bytes}b`)
      if (axis.count !== undefined) extra.push(`n=${axis.count}`)
      if (axis.kind) extra.push(axis.kind)
      if (axis.reason) extra.push(axis.reason)
      lines.push(`- ${mark} **${name}**${extra.length ? ` — ${extra.join(", ")}` : ""}`)
    }
    lines.push("")
  }
  return lines.join("\n") + "\n"
}

function parseArgs(argv) {
  const out = { runDir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) continue
    out.runDir = argv[i]
  }
  return out
}

async function findLatestRunDir() {
  const evalsDir = path.join(PROJECT_ROOT, "story", "evals")
  if (!existsSync(evalsDir)) return null
  const dirs = (await readdir(evalsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("initEval_"))
    .map((d) => d.name)
    .sort()
  return dirs.length ? path.join(evalsDir, dirs[dirs.length - 1]) : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = args.runDir || (await findLatestRunDir())
  if (!runDir) {
    process.stderr.write("No runDir provided and no initEval_* directory found.\n")
    process.exit(2)
  }
  await analyzeRun(runDir)
  process.exit(0)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
