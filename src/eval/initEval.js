// Initializer eval. Runs sessionProcessor.initializeFromWorldbook against
// each fixture under story/evals/initFixtures/<category>/{oneliner.md, full.md}
// and dumps the resulting artifacts (chapters.md, foreground/, characters,
// state files) into a timestamped run directory for human-eye review.
//
// Scope decisions:
//   - Init-only pass. No scripted reader turns. We are evaluating the
//     initializer's faithfulness to the worldbook, not story play.
//   - Each fixture runs in an ISOLATED workspace under the run dir, so
//     fixtures cannot bleed into each other.
//   - The 魔改 (3body-xianxia) fixtures get a quant pass: dual-system
//     keyword co-occurrence. The other categories are human-eye only.
//
// Usage:
//   node src/eval/initEval.js                           # all fixtures
//   node src/eval/initEval.js --only 3body-xianxia      # one category
//   node src/eval/initEval.js --fixtures-dir <path>     # custom fixtures
//   node src/eval/initEval.js --skip-preflight          # offline tests

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..")
const DEFAULT_FIXTURES_DIR = path.join(PROJECT_ROOT, "story", "evals", "initFixtures")

// 魔改 dual-system keyword sets. 三体修仙 fixtures should produce init output
// that exercises BOTH columns. The co-occurrence metric rewards fusion at the
// sentence/paragraph level, not just both lists appearing in different files.
const SCI_KEYWORDS = [
  "智子", "三体", "红岸", "面壁人", "黑暗森林", "锁死",
  "光粒", "水滴", "曲率", "维度", "科学边界",
]
const XIANXIA_KEYWORDS = [
  "修真", "修仙", "金丹", "渡劫", "元神", "心斋", "灵识",
  "雷劫", "散修", "道家", "周易", "太上感应篇", "符箓",
  "心法", "气海", "丹田",
]

export async function runInitEval(opts = {}) {
  const args = normalizeOptions(opts)
  await mkdir(args.outputDir, { recursive: true })

  const fixtures = await discoverFixtures(args.fixturesDir, args.only)
  if (!fixtures.length) {
    throw new Error(`No fixtures found under ${args.fixturesDir} (filter: ${args.only || "none"})`)
  }

  process.stderr.write(
    `[initEval] ${fixtures.length} fixtures → ${args.outputDir}\n` +
      fixtures.map((f) => `  - ${f.id}`).join("\n") + "\n",
  )

  const results = []
  for (const fixture of fixtures) {
    process.stderr.write(`[initEval] ${fixture.id} → init...\n`)
    const cellDir = path.join(args.outputDir, fixture.id)
    const cellResult = await runOneFixture({ fixture, cellDir, args })
    results.push(cellResult)
    process.stderr.write(
      `[initEval] ${fixture.id} ${cellResult.ok ? "ok" : "FAIL"} in ${cellResult.durationMs}ms\n`,
    )
  }

  const report = buildReport({ fixtures, results, args })
  await writeFile(path.join(args.outputDir, "report.md"), report)
  await writeFile(
    path.join(args.outputDir, "summary.json"),
    JSON.stringify({ args, results }, null, 2),
  )
  process.stderr.write(`[initEval] report: ${path.join(args.outputDir, "report.md")}\n`)
  return { outputDir: args.outputDir, results }
}

async function discoverFixtures(fixturesDir, only) {
  if (!existsSync(fixturesDir)) return []
  const categories = (await readdir(fixturesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  const fixtures = []
  for (const cat of categories) {
    if (only && cat !== only) continue
    const catDir = path.join(fixturesDir, cat)
    const files = (await readdir(catDir)).filter((f) => f.endsWith(".md")).sort()
    for (const file of files) {
      const size = (await stat(path.join(catDir, file))).size
      fixtures.push({
        id: `${cat}-${file.replace(/\.md$/, "")}`,
        category: cat,
        size: file.replace(/\.md$/, ""),
        path: path.join(catDir, file),
        bytes: size,
      })
    }
  }
  return fixtures
}

// Each fixture runs in its own child process with an isolated workspace.
// Reusing the current process would share sessionProcessor singletons /
// storyStore module state across fixtures, which would corrupt artifacts
// between runs. Spawning is the cleaner boundary.
async function runOneFixture({ fixture, cellDir, args }) {
  await mkdir(cellDir, { recursive: true })
  await copyFile(fixture.path, path.join(cellDir, "worldbook.md"))

  const workspace = path.join(cellDir, "workspace")
  await mkdir(workspace, { recursive: true })

  const childArgs = [
    SCRIPT_PATH,
    "--child",
    "--fixture-path", fixture.path,
    "--workspace", workspace,
    "--cell-dir", cellDir,
  ]
  if (args.skipPreflight) childArgs.push("--skip-preflight")

  const env = {
    ...process.env,
    OPENOVEL_HOME: path.join(cellDir, "home"),
    OPENOVEL_STORY_ROOT: workspace,
  }

  const started = Date.now()
  const childResult = await runChild(process.execPath, childArgs, {
    cwd: PROJECT_ROOT,
    env,
    timeoutMs: args.fixtureTimeoutMs,
  })
  const durationMs = Date.now() - started

  // Quant pass over the produced artifacts.
  const quant = await computeQuant({ fixture, workspace, cellDir })

  return {
    id: fixture.id,
    category: fixture.category,
    size: fixture.size,
    fixtureBytes: fixture.bytes,
    ok: childResult.exitCode === 0,
    exitCode: childResult.exitCode,
    durationMs,
    initStatus: childResult.output?.initStatus || null,
    initError: childResult.output?.initError || childResult.stderrTail || null,
    artifacts: quant.artifacts,
    quant: quant.metrics,
  }
}

async function computeQuant({ fixture, workspace, cellDir }) {
  // Collect produced text. We read whatever exists; missing files just count
  // as 0 bytes (initializer might choose not to write some paths).
  const artifacts = {}
  const fgDir = path.join(workspace, "foreground")
  const candidatePaths = [
    ["chapters", path.join(workspace, "canon", "chapters.md")],
    ["provenance", path.join(workspace, "canon", "PROVENANCE.md")],
    ["foregroundGuidance", path.join(workspace, "guidance", "FOREGROUND.md")],
    ["foregroundTemplate", path.join(workspace, "guidance", "FG_template.md")],
    ["memory", path.join(workspace, "memory", "MEMORY.md")],
  ]
  let combined = ""
  for (const [key, p] of candidatePaths) {
    const text = await readFile(p, "utf8").catch(() => "")
    artifacts[key] = { bytes: text.length, path: path.relative(cellDir, p) }
    if (text) combined += text + "\n\n"
    // Mirror artifact into cellDir/artifacts/ so the user can read everything
    // from one place without dorking around in workspace/.
    if (text) {
      const mirror = path.join(cellDir, "artifacts", key + ".md")
      await mkdir(path.dirname(mirror), { recursive: true })
      await writeFile(mirror, text)
    }
  }
  // foreground/ section files (per-section .md)
  try {
    const sectionFiles = (await readdir(fgDir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name)
    artifacts.foregroundSections = []
    for (const f of sectionFiles.sort()) {
      const text = await readFile(path.join(fgDir, f), "utf8").catch(() => "")
      artifacts.foregroundSections.push({ name: f, bytes: text.length })
      if (text) {
        combined += text + "\n\n"
        const mirror = path.join(cellDir, "artifacts", "foreground", f)
        await mkdir(path.dirname(mirror), { recursive: true })
        await writeFile(mirror, text)
      }
    }
  } catch {
    artifacts.foregroundSections = []
  }
  // state/ + characters/ — initializer may or may not write these.
  for (const sub of ["state", "characters"]) {
    const dir = path.join(workspace, sub)
    if (!existsSync(dir)) {
      artifacts[sub] = []
      continue
    }
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name)
    const list = []
    for (const f of entries.sort()) {
      const text = await readFile(path.join(dir, f), "utf8").catch(() => "")
      list.push({ name: f, bytes: text.length })
      if (text) {
        combined += text + "\n\n"
        const mirror = path.join(cellDir, "artifacts", sub, f)
        await mkdir(path.dirname(mirror), { recursive: true })
        await writeFile(mirror, text)
      }
    }
    artifacts[sub] = list
  }

  const metrics = {
    totalArtifactBytes: combined.length,
    fusionScore: null,
    sciHits: null,
    xianxiaHits: null,
    coOccurringWindows: null,
  }
  // 魔改 quant: dual-system fusion. Only meaningful for 三体修仙 fixtures.
  if (fixture.category === "3body-xianxia" && combined) {
    metrics.sciHits = countKeywordHits(combined, SCI_KEYWORDS)
    metrics.xianxiaHits = countKeywordHits(combined, XIANXIA_KEYWORDS)
    metrics.coOccurringWindows = countCoOccurringWindows(combined, SCI_KEYWORDS, XIANXIA_KEYWORDS, 500)
    // Fusion score: harmonic mean of the two sides' coverage, normalized by
    // total possible. Rewards balance — if either side is empty, score = 0.
    const sciCov = metrics.sciHits.distinct / SCI_KEYWORDS.length
    const xianxiaCov = metrics.xianxiaHits.distinct / XIANXIA_KEYWORDS.length
    metrics.fusionScore =
      sciCov > 0 && xianxiaCov > 0
        ? Number(((2 * sciCov * xianxiaCov) / (sciCov + xianxiaCov)).toFixed(3))
        : 0
  }
  return { artifacts, metrics }
}

function countKeywordHits(text, keywords) {
  const distinct = []
  let total = 0
  for (const kw of keywords) {
    let count = 0
    let idx = text.indexOf(kw)
    while (idx >= 0) {
      count++
      idx = text.indexOf(kw, idx + kw.length)
    }
    if (count > 0) {
      distinct.push({ keyword: kw, count })
      total += count
    }
  }
  return { distinct: distinct.length, total, found: distinct }
}

// Sliding window co-occurrence: count windows of `windowChars` that contain
// at least one keyword from set A AND one from set B. Non-overlapping advance
// by half-window for speed.
function countCoOccurringWindows(text, setA, setB, windowChars) {
  let windows = 0
  const step = Math.max(50, Math.floor(windowChars / 2))
  for (let i = 0; i < text.length; i += step) {
    const slice = text.slice(i, i + windowChars)
    const hasA = setA.some((k) => slice.includes(k))
    const hasB = setB.some((k) => slice.includes(k))
    if (hasA && hasB) windows++
  }
  return windows
}

function buildReport({ fixtures, results, args }) {
  const lines = [
    `# Init eval — ${args.runId}`,
    "",
    `**Fixtures dir**: \`${path.relative(PROJECT_ROOT, args.fixturesDir)}\``,
    `**Output dir**: \`${path.relative(PROJECT_ROOT, args.outputDir)}\``,
    `**Total fixtures**: ${fixtures.length}`,
    "",
    "## Summary table",
    "",
    "| fixture | bytes in | init ok | duration | chapters | FG.md | sections | characters | state | fusionScore |",
    "| --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const r of results) {
    const a = r.artifacts || {}
    lines.push(
      `| \`${r.id}\` | ${r.fixtureBytes} | ${r.ok ? "✓" : "✗"} | ${r.durationMs}ms | ` +
        `${a.chapters?.bytes ?? 0} | ${a.foregroundGuidance?.bytes ?? 0} | ` +
        `${(a.foregroundSections || []).length} | ${(a.characters || []).length} | ${(a.state || []).length} | ` +
        `${r.quant?.fusionScore ?? "—"} |`,
    )
  }

  // 魔改 detail section
  const moegai = results.filter((r) => r.category === "3body-xianxia")
  if (moegai.length) {
    lines.push("", "## 魔改 (三体修仙) dual-system metrics", "")
    lines.push(
      "Fusion score is the harmonic mean of `sci-keyword coverage` and `xianxia-keyword coverage` " +
        "(coverage = distinct hits / keyword-set size). 0 means one column is empty. ",
      "`coOccurringWindows` counts 500-char windows containing keywords from BOTH columns — ",
      "rewards in-paragraph fusion, not just both lists appearing in separate sections.",
      "",
    )
    lines.push("| fixture | sci distinct/total | sci keywords | xianxia distinct/total | xianxia keywords | coOcc windows | fusionScore |")
    lines.push("| --- | ---: | --- | ---: | --- | ---: | ---: |")
    for (const r of moegai) {
      const q = r.quant || {}
      const sciKWs = (q.sciHits?.found || []).map((h) => h.keyword).join(", ")
      const xxKWs = (q.xianxiaHits?.found || []).map((h) => h.keyword).join(", ")
      lines.push(
        `| \`${r.id}\` | ${q.sciHits?.distinct}/${SCI_KEYWORDS.length} | ${sciKWs || "—"} | ` +
          `${q.xianxiaHits?.distinct}/${XIANXIA_KEYWORDS.length} | ${xxKWs || "—"} | ` +
          `${q.coOccurringWindows ?? "—"} | ${q.fusionScore ?? "—"} |`,
      )
    }
  }

  lines.push(
    "",
    "## Next step (human-eye review)",
    "",
    "Per memory rule (no LLM judge): read each fixture's artifacts directory:",
    "",
  )
  for (const r of results) {
    lines.push(`- \`${r.id}\`: \`${path.relative(PROJECT_ROOT, path.join(args.outputDir, r.id, "artifacts"))}/\``)
  }
  return lines.join("\n") + "\n"
}

function normalizeOptions(options = {}) {
  const runId = options.runId || `initEval_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(
    options.outputDir || path.join(PROJECT_ROOT, "story", "evals", runId),
  )
  return {
    runId,
    outputDir,
    fixturesDir: path.resolve(options.fixturesDir || DEFAULT_FIXTURES_DIR),
    only: options.only || null,
    skipPreflight: options.skipPreflight === true,
    fixtureTimeoutMs: Math.max(60_000, Number(options.fixtureTimeoutMs) || 600_000),
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--child") out.child = true
    else if (a === "--fixture-path") out.fixturePath = argv[++i]
    else if (a === "--workspace") out.workspace = argv[++i]
    else if (a === "--cell-dir") out.cellDir = argv[++i]
    else if (a === "--fixtures-dir") out.fixturesDir = argv[++i]
    else if (a === "--output-dir") out.outputDir = argv[++i]
    else if (a === "--run-id") out.runId = argv[++i]
    else if (a === "--only") out.only = argv[++i]
    else if (a === "--skip-preflight") out.skipPreflight = true
    else if (a === "--fixture-timeout-ms") out.fixtureTimeoutMs = Number(argv[++i])
  }
  return out
}

function runChild(cmd, childArgs, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, childArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => {
      const s = d.toString()
      stderr += s
      process.stderr.write(s)
    })
    const killer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch {}
    }, timeoutMs)
    child.on("close", (exitCode) => {
      clearTimeout(killer)
      let output = null
      try {
        const lastBrace = stdout.lastIndexOf("{")
        if (lastBrace >= 0) output = JSON.parse(stdout.slice(lastBrace))
      } catch {}
      resolve({ exitCode, stdout, stderr, stderrTail: stderr.slice(-2000), output })
    })
  })
}

// ───────────── child mode: runs one fixture in isolated workspace ─────────────
async function childMain(args) {
  if (!args.fixturePath || !args.workspace) {
    process.stderr.write("Child mode requires --fixture-path and --workspace\n")
    process.exit(2)
  }
  // Lazy import so the parent process doesn't pay for the runtime stack on
  // startup (and so the child can pick up the workspace env vars set by the
  // parent before any storyStore module reads them).
  const { sessionProcessor } = await import("../runtime/sessionProcessor.js")
  const { initializeStory } = await import("../lib/storyStore.js")
  const { toolRegistry } = await import("../runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../tools/registerTools.js")
  const { chatMessage } = await import("../provider/provider.js")
  const { looksLikeBillingError } = await import("./probeGuards.js")

  await initializeStory()
  registerDefaultTools(toolRegistry)

  if (!args.skipPreflight) {
    try {
      await chatMessage({
        messages: [{ role: "user", content: "ping" }],
        role: "signal",
        maxTokens: 1, temperature: 0, timeoutMs: 20_000,
      })
    } catch (error) {
      if (looksLikeBillingError(error)) {
        process.stderr.write(`[initEval-child] preflight FAIL (billing): ${error?.message}\n`)
        process.stdout.write(JSON.stringify({ initStatus: "preflight_failed", initError: String(error?.message || error) }))
        process.exit(2)
      }
      process.stderr.write(`[initEval-child] preflight warning: ${error?.message}\n`)
    }
  }

  const worldbook = await readFile(args.fixturePath, "utf8")
  const started = Date.now()
  const { ready } = await sessionProcessor.initializeFromWorldbook({
    worldbook,
    sourceHint: `initEval:${path.basename(args.fixturePath)}`,
  })
  const initResult = await ready
  const durationMs = Date.now() - started
  process.stderr.write(
    `[initEval-child] init ${initResult?.status} in ${durationMs}ms (ready=${initResult?.ready})\n`,
  )
  process.stdout.write(JSON.stringify({
    initStatus: initResult?.status,
    ready: initResult?.ready,
    durationMs,
    summary: initResult?.summary,
    filesChanged: initResult?.filesChanged,
  }))
  process.exit(initResult?.ready ? 0 : 1)
}

async function parentMain() {
  const args = parseArgs(process.argv.slice(2))
  try {
    const summary = await runInitEval(args)
    process.stdout.write(`\n=== init eval done: ${summary.results.length} fixtures ===\n`)
    process.stdout.write(`report: ${path.join(summary.outputDir, "report.md")}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`[initEval] FATAL: ${error?.stack || error?.message || error}\n`)
    process.exit(2)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (args.child) childMain(args)
  else parentMain()
}
