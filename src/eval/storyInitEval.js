// Story-init eval. Compares runStoryInit({depth:"standard"}) vs
// runStoryInit({depth:"deep"}) across the 8 initFixtures × N rounds.
//
// Unlike the JSON-envelope `initializerWorkflow` path used by
// sessionProcessor.initializeFromWorldbook, this harness
// exercises the CONVERSATIONAL path used by the Electron new-story flow.
// That path is the one with the standard / deep mode distinction.
//
// ask_user is auto-responded (pick options[0] or "你决定"). The interaction
// log is captured per cell so a human can read what the model asked and
// whether the chosen default was sane.
//
// Output layout (one runDir per invocation):
//   <runDir>/
//     summary.json
//     report.md
//     <fixture>-<mode>-r<round>/
//       worldbook.md
//       interaction.jsonl
//       artifacts/{chapters,foregroundGuidance,foreground/,characters/,state/}
//       workspace/
//
// CLI:
//   node src/eval/storyInitEval.js                              # all 8x2x5 = 80 cells
//   node src/eval/storyInitEval.js --only 3body-xianxia         # one category
//   node src/eval/storyInitEval.js --rounds 1                   # smoke
//   node src/eval/storyInitEval.js --modes standard             # one mode only
//   node src/eval/storyInitEval.js --parallel 2                 # bounded concurrency
//   node src/eval/storyInitEval.js --max-cost-usd-per-cell 5    # safety cap

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..")
const DEFAULT_FIXTURES_DIR = path.join(PROJECT_ROOT, "story", "evals", "initFixtures")
const DEFAULT_MODES = ["standard", "deep"]
const DEFAULT_ROUNDS = 5
const DEFAULT_PARALLEL = 2

export async function runStoryInitEval(opts = {}) {
  const args = normalizeOptions(opts)
  await mkdir(args.outputDir, { recursive: true })

  const fixtures = await discoverFixtures(args.fixturesDir, args.only)
  if (!fixtures.length) {
    throw new Error(`No fixtures found under ${args.fixturesDir} (only=${args.only || "all"})`)
  }

  const tasks = []
  for (const fixture of fixtures) {
    for (const mode of args.modes) {
      for (let round = 1; round <= args.rounds; round++) {
        tasks.push({
          fixture, mode, round,
          id: `${fixture.id}-${mode}-r${round}`,
          cellDir: path.join(args.outputDir, `${fixture.id}-${mode}-r${round}`),
        })
      }
    }
  }
  // --skip-completed lets a 补 run reuse a partial output dir. A
  // cell is considered "completed" if its artifacts/foregroundGuidance.md
  // exists with non-trivial bytes — anything less means the cell either
  // never ran, died at preflight, or stalled before producing FG output.
  // We still inspect skipped cells after the run so the final report
  // aggregates them alongside the freshly-run ones.
  const skipped = []
  if (args.skipCompleted) {
    const beforeCount = tasks.length
    const fresh = []
    for (const t of tasks) {
      const fgPath = path.join(t.cellDir, "artifacts", "foregroundGuidance.md")
      let size = 0
      try { size = (await stat(fgPath)).size } catch {}
      if (size > 500) {
        skipped.push(t)
      } else {
        fresh.push(t)
      }
    }
    process.stderr.write(`[storyInitEval] skipCompleted: ${skipped.length}/${beforeCount} cells already done; re-running ${fresh.length}\n`)
    tasks.length = 0
    tasks.push(...fresh)
  }
  process.stderr.write(
    `[storyInitEval] ${tasks.length} cells (${fixtures.length} fixtures × ${args.modes.length} modes × ${args.rounds} rounds), parallel=${args.parallel}\n` +
      `[storyInitEval] output: ${args.outputDir}\n`,
  )

  const results = []
  // Bounded-parallel queue. Workers pull from a shared index; same pattern
  // as worldConsistencyProbe.js so the timing/race characteristics match
  // the existing eval harness.
  let cursor = 0
  let completed = 0
  async function worker(workerId) {
    while (cursor < tasks.length) {
      const taskIdx = cursor++
      if (taskIdx >= tasks.length) return
      const task = tasks[taskIdx]
      process.stderr.write(`[storyInitEval] worker#${workerId} ${task.id} → init...\n`)
      const result = await runOneCell({ task, args }).catch((err) => ({
        id: task.id,
        ok: false,
        error: String(err?.message || err),
      }))
      results.push(result)
      completed++
      process.stderr.write(
        `[storyInitEval] ${completed}/${tasks.length} ${task.id} ${result.ok ? "ok" : "FAIL"} ` +
          `dur=${result.durationMs}ms cost=$${(result.cost ?? 0).toFixed(4)} asks=${result.askCount ?? "—"}\n`,
      )
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, (_, i) => worker(i + 1)))

  // Rehydrate results from disk for cells that were skipped because their
  // output already exists. The report has to see the full picture.
  for (const task of skipped) {
    const fromDisk = await loadCellResultFromDisk({ task })
    if (fromDisk) results.push(fromDisk)
  }

  results.sort((a, b) => a.id.localeCompare(b.id))
  const report = buildReport({ tasks, results, args })
  await writeFile(path.join(args.outputDir, "report.md"), report)
  await writeFile(
    path.join(args.outputDir, "summary.json"),
    JSON.stringify({ args, results }, null, 2),
  )
  process.stderr.write(`[storyInitEval] report: ${path.join(args.outputDir, "report.md")}\n`)
  return { outputDir: args.outputDir, results }
}

async function discoverFixtures(fixturesDir, only) {
  if (!existsSync(fixturesDir)) return []
  const cats = (await readdir(fixturesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  const fixtures = []
  for (const cat of cats) {
    if (only && cat !== only) continue
    const dir = path.join(fixturesDir, cat)
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()
    for (const f of files) {
      const size = (await stat(path.join(dir, f))).size
      fixtures.push({
        id: `${cat}-${f.replace(/\.md$/, "")}`,
        category: cat,
        size: f.replace(/\.md$/, ""),
        path: path.join(dir, f),
        bytes: size,
      })
    }
  }
  return fixtures
}

async function runOneCell({ task, args }) {
  await mkdir(task.cellDir, { recursive: true })
  await copyFile(task.fixture.path, path.join(task.cellDir, "worldbook.md"))
  const workspace = path.join(task.cellDir, "workspace")
  await mkdir(workspace, { recursive: true })

  const childArgs = [
    SCRIPT_PATH,
    "--child",
    "--fixture-path", task.fixture.path,
    "--depth", task.mode,
    "--cell-dir", task.cellDir,
    "--workspace", workspace,
    "--max-cost-usd", String(args.maxCostUSDPerCell),
    "--max-consecutive-errors", String(args.maxConsecutiveErrors),
  ]
  if (args.skipPreflight) childArgs.push("--skip-preflight")

  const env = {
    ...process.env,
    OPENOVEL_HOME: path.join(task.cellDir, "home"),
    OPENOVEL_STORY_ROOT: workspace,
  }
  const started = Date.now()
  const child = await runChild(process.execPath, childArgs, {
    cwd: PROJECT_ROOT, env, timeoutMs: args.cellTimeoutMs,
  })
  const durationMs = Date.now() - started

  // Inspect produced artifacts. runStoryInit does NOT write chapters.md
  // (canon is the narrator's later job), so readiness scoring shifts:
  // we look at foreground/* sections + context-cards/* instead.
  const artifacts = await inspectArtifacts(workspace, task.cellDir)

  // Interaction log
  let askCount = 0
  let asks = []
  const logPath = path.join(task.cellDir, "interaction.jsonl")
  if (existsSync(logPath)) {
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean)
    asks = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    askCount = asks.filter((a) => a.kind === "asked").length
  }

  return {
    id: task.id,
    fixture: task.fixture.id,
    category: task.fixture.category,
    fixtureSize: task.fixture.size,
    mode: task.mode,
    round: task.round,
    ok: child.exitCode === 0,
    exitCode: child.exitCode,
    durationMs,
    cost: child.output?.cost ?? null,
    modelCalls: child.output?.modelCalls ?? null,
    toolCalls: child.output?.toolCalls ?? null,
    stepCount: child.output?.stepCount ?? null,
    askCount,
    askLabels: asks.filter((a) => a.kind === "asked").map((a) => ({ q: a.question.slice(0, 80), chose: a.chose })),
    artifacts,
    childError: child.output?.error || child.stderrTail || null,
  }
}

// Reconstruct a result record for a completed cell so reruns can skip execution
// while still including it in the final report. Pulls usage from
// cellDir/usageProfile.json + interaction.jsonl + the workspace artifacts.
// Returns null if the cell directory is missing
// the bare minimum (no FOREGROUND.md).
async function loadCellResultFromDisk({ task }) {
  const fgPath = path.join(task.cellDir, "artifacts", "foregroundGuidance.md")
  let fgBytes = 0
  try { fgBytes = (await stat(fgPath)).size } catch { return null }
  if (fgBytes < 500) return null

  let usage = null
  try {
    usage = JSON.parse(await readFile(path.join(task.cellDir, "usageProfile.json"), "utf8"))
  } catch {}
  const summary = usage ? summarizeProfileLite(usage) : null
  const workspace = path.join(task.cellDir, "workspace")
  const artifacts = await inspectArtifacts(workspace, task.cellDir)

  let asks = []
  const logPath = path.join(task.cellDir, "interaction.jsonl")
  if (existsSync(logPath)) {
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean)
    asks = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
  return {
    id: task.id,
    fixture: task.fixture.id,
    category: task.fixture.category,
    fixtureSize: task.fixture.size,
    mode: task.mode,
    round: task.round,
    ok: true,
    exitCode: 0,
    durationMs: summary?.modelDurationMs || null,
    cost: summary?.estimatedCostUSD ?? null,
    modelCalls: summary?.modelCalls ?? null,
    toolCalls: summary?.toolCalls ?? null,
    stepCount: null,
    askCount: asks.filter((a) => a.kind === "asked").length,
    askLabels: asks.filter((a) => a.kind === "asked").map((a) => ({ q: a.question.slice(0, 80), chose: a.chose })),
    artifacts,
    childError: null,
    fromDisk: true,
  }
}

function summarizeProfileLite(profile) {
  const calls = profile.modelCalls || []
  const tools = profile.toolCalls || []
  const ok = calls.filter((c) => c.ok)
  return {
    modelCalls: ok.length,
    toolCalls: tools.length,
    modelDurationMs: ok.reduce((s, c) => s + (c.durationMs || 0), 0),
    estimatedCostUSD: ok.reduce((s, c) => s + (c.cost?.estimatedUSD || 0), 0),
  }
}

async function inspectArtifacts(workspace, cellDir) {
  const artifacts = {}
  const tryRead = async (relPath, mirrorName) => {
    const text = await readFile(path.join(workspace, relPath), "utf8").catch(() => "")
    if (text && mirrorName) {
      const mirror = path.join(cellDir, "artifacts", mirrorName)
      await mkdir(path.dirname(mirror), { recursive: true })
      await writeFile(mirror, text)
    }
    return text
  }

  const fgGuidance = await tryRead("guidance/FOREGROUND.md", "foregroundGuidance.md")
  const fgTemplate = await tryRead("guidance/FG_template.md", "foregroundTemplate.md")
  const memory = await tryRead("memory/MEMORY.md", "memory.md")
  artifacts.foregroundGuidance = { bytes: fgGuidance.length }
  artifacts.foregroundTemplate = { bytes: fgTemplate.length }
  artifacts.memory = { bytes: memory.length }

  // foreground/<sections>.md
  const fgDir = path.join(workspace, "foreground")
  if (existsSync(fgDir)) {
    const sections = []
    for (const f of (await readdir(fgDir)).sort()) {
      if (!f.endsWith(".md")) continue
      const text = await readFile(path.join(fgDir, f), "utf8").catch(() => "")
      sections.push({ name: f, bytes: text.length })
      if (text) {
        const mirror = path.join(cellDir, "artifacts", "foreground", f)
        await mkdir(path.dirname(mirror), { recursive: true })
        await writeFile(mirror, text)
      }
    }
    artifacts.foregroundSections = sections
  } else {
    artifacts.foregroundSections = []
  }

  // context-cards/<slug>/CARD.md (the conversational init's character format)
  const cardsDir = path.join(workspace, "context-cards")
  artifacts.contextCards = []
  if (existsSync(cardsDir)) {
    for (const sub of (await readdir(cardsDir, { withFileTypes: true })).sort()) {
      if (!sub.isDirectory()) continue
      const cardPath = path.join(cardsDir, sub.name, "CARD.md")
      const text = await readFile(cardPath, "utf8").catch(() => "")
      if (!text) continue
      artifacts.contextCards.push({ slug: sub.name, bytes: text.length })
      const mirror = path.join(cellDir, "artifacts", "context-cards", sub.name, "CARD.md")
      await mkdir(path.dirname(mirror), { recursive: true })
      await writeFile(mirror, text)
    }
  }

  // state/*  (initializer may write character digests / numeric state)
  const stateDir = path.join(workspace, "state")
  artifacts.state = []
  if (existsSync(stateDir)) {
    for (const f of (await readdir(stateDir)).sort()) {
      const text = await readFile(path.join(stateDir, f), "utf8").catch(() => "")
      if (!text) continue
      artifacts.state.push({ name: f, bytes: text.length })
      const mirror = path.join(cellDir, "artifacts", "state", f)
      await mkdir(path.dirname(mirror), { recursive: true })
      await writeFile(mirror, text)
    }
  }

  // ResearchNotes.md (deep mode scratchpad; search-log.md is append-only audit)
  const researchNotes = await tryRead("research/ResearchNotes.md", "research-notes.md")
  artifacts.researchNotes = { bytes: researchNotes.length }

  artifacts.totalBytes =
    fgGuidance.length + fgTemplate.length + memory.length +
    artifacts.foregroundSections.reduce((s, x) => s + x.bytes, 0) +
    artifacts.contextCards.reduce((s, x) => s + x.bytes, 0) +
    artifacts.state.reduce((s, x) => s + x.bytes, 0) +
    researchNotes.length

  return artifacts
}

function buildReport({ tasks, results, args }) {
  const lines = [
    `# storyInit eval — ${args.runId}`,
    "",
    `**Fixtures dir**: \`${path.relative(PROJECT_ROOT, args.fixturesDir)}\``,
    `**Output dir**: \`${path.relative(PROJECT_ROOT, args.outputDir)}\``,
    `**Total cells**: ${results.length} (planned ${tasks.length})`,
    `**Modes**: ${args.modes.join(", ")}`,
    `**Rounds per (fixture, mode)**: ${args.rounds}`,
    "",
    "## Per-cell summary",
    "",
    "| cell | ok | duration | cost | calls | tools | steps | asks | FG.md | sections | cards | state | research |",
    "| --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const r of results) {
    const a = r.artifacts || {}
    lines.push(
      `| \`${r.id}\` | ${r.ok ? "✓" : "✗"} | ${formatMs(r.durationMs)} | $${(r.cost ?? 0).toFixed(4)} | ` +
        `${r.modelCalls ?? "—"} | ${r.toolCalls ?? "—"} | ${r.stepCount ?? "—"} | ${r.askCount} | ` +
        `${a.foregroundGuidance?.bytes ?? 0} | ${(a.foregroundSections || []).length} | ` +
        `${(a.contextCards || []).length} | ${(a.state || []).length} | ${a.researchNotes?.bytes ?? 0} |`,
    )
  }

  // Cross-mode aggregates per fixture (mean + std)
  lines.push("", "## Cross-mode aggregates per fixture", "")
  lines.push("| fixture | mode | n | mean FG bytes | mean cards | mean asks | mean cost | mean duration |")
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
  const byFixtureMode = {}
  for (const r of results) {
    if (!r.ok) continue
    const key = `${r.fixture}::${r.mode}`
    ;(byFixtureMode[key] ||= []).push(r)
  }
  for (const key of Object.keys(byFixtureMode).sort()) {
    const [fixture, mode] = key.split("::")
    const cells = byFixtureMode[key]
    const fgBytes = mean(cells.map((c) => c.artifacts?.foregroundGuidance?.bytes ?? 0))
    const cards = mean(cells.map((c) => (c.artifacts?.contextCards || []).length))
    const asks = mean(cells.map((c) => c.askCount ?? 0))
    const cost = mean(cells.map((c) => c.cost ?? 0))
    const dur = mean(cells.map((c) => c.durationMs ?? 0))
    lines.push(
      `| ${fixture} | ${mode} | ${cells.length} | ${fgBytes.toFixed(0)} | ${cards.toFixed(1)} | ${asks.toFixed(1)} | $${cost.toFixed(4)} | ${formatMs(dur)} |`,
    )
  }

  // ask_user roll-up — interaction quality glance
  lines.push("", "## ask_user roll-up (interaction quality)", "")
  lines.push("Total ask_user calls per mode:")
  const askByMode = {}
  for (const r of results) askByMode[r.mode] = (askByMode[r.mode] || 0) + (r.askCount || 0)
  for (const m of Object.keys(askByMode).sort()) {
    lines.push(`- ${m}: ${askByMode[m]} questions across ${results.filter((r) => r.mode === m).length} cells`)
  }
  lines.push("", "Cells with at least one ask_user (sample):", "")
  for (const r of results.filter((r) => (r.askCount || 0) > 0).slice(0, 20)) {
    lines.push(`- \`${r.id}\` (${r.askCount} asks)`)
    for (const a of r.askLabels.slice(0, 3)) {
      lines.push(`    - Q: ${a.q} → chose \`${a.chose}\``)
    }
  }
  return lines.join("\n") + "\n"
}

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, x) => s + x, 0) / arr.length
}
function formatMs(ms) {
  if (!ms) return "—"
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`
}

function normalizeOptions(options = {}) {
  const runId = options.runId || `storyInitEval_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(
    options.outputDir || path.join(PROJECT_ROOT, "story", "evals", runId),
  )
  const modes = parseList(options.modes, DEFAULT_MODES)
  const validModes = modes.filter((m) => DEFAULT_MODES.includes(m))
  if (!validModes.length) throw new Error(`No valid modes; got ${modes}`)
  return {
    runId,
    outputDir,
    fixturesDir: path.resolve(options.fixturesDir || DEFAULT_FIXTURES_DIR),
    modes: validModes,
    rounds: Math.max(1, Number(options.rounds) || DEFAULT_ROUNDS),
    parallel: Math.max(1, Number(options.parallel) || DEFAULT_PARALLEL),
    only: options.only || null,
    skipPreflight: options.skipPreflight === true,
    skipCompleted: options.skipCompleted === true,
    maxCostUSDPerCell: Math.max(0, Number(options.maxCostUSDPerCell) || 5),
    maxConsecutiveErrors: Math.max(1, Number(options.maxConsecutiveErrors) || 5),
    // Deep mode can chew through 200 steps + websearch easily — 25 min cap.
    // Standard is usually < 5 min but we use the same number for simplicity.
    cellTimeoutMs: Math.max(60_000, Number(options.cellTimeoutMs) || 25 * 60_000),
  }
}

function parseList(value, fallback) {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean)
  }
  return fallback
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--child") out.child = true
    else if (a === "--fixture-path") out.fixturePath = argv[++i]
    else if (a === "--depth") out.depth = argv[++i]
    else if (a === "--workspace") out.workspace = argv[++i]
    else if (a === "--cell-dir") out.cellDir = argv[++i]
    else if (a === "--fixtures-dir") out.fixturesDir = argv[++i]
    else if (a === "--output-dir") out.outputDir = argv[++i]
    else if (a === "--run-id") out.runId = argv[++i]
    else if (a === "--only") out.only = argv[++i]
    else if (a === "--rounds") out.rounds = Number(argv[++i])
    else if (a === "--modes") out.modes = argv[++i]
    else if (a === "--parallel") out.parallel = Number(argv[++i])
    else if (a === "--max-cost-usd-per-cell") out.maxCostUSDPerCell = Number(argv[++i])
    else if (a === "--max-cost-usd") out.maxCostUSDPerCell = Number(argv[++i])
    else if (a === "--max-consecutive-errors") out.maxConsecutiveErrors = Number(argv[++i])
    else if (a === "--cell-timeout-ms") out.cellTimeoutMs = Number(argv[++i])
    else if (a === "--skip-preflight") out.skipPreflight = true
    else if (a === "--skip-completed") out.skipCompleted = true
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
      // Don't tee to parent stderr — too noisy with parallel cells. Logged to file via child redirect.
    })
    const killer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
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

// ───────────── child mode: runs one storyInit cell ─────────────
async function childMain(args) {
  if (!args.fixturePath || !args.workspace || !args.depth) {
    process.stderr.write("Child requires --fixture-path --workspace --depth\n")
    process.exit(2)
  }
  const { runStoryInit } = await import("../workflows/storyInitWorkflow.js")
  const { initializeStory } = await import("../lib/storyStore.js")
  const { toolRegistry } = await import("../runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../tools/registerTools.js")
  const { chatMessage } = await import("../provider/provider.js")
  const { looksLikeBillingError, createGuardState, recordModelCall, check: checkGuard } = await import("./probeGuards.js")
  const { bus } = await import("../runtime/bus.js")
  const { installAutoResponder } = await import("./storyInitAutoResponder.js")
  // model.call.completed events only fire when there's an active
  // usageProfile context. runStoryInit doesn't wrap one, so without this the
  // child gets cost=$0 for every cell. Wrap manually so the bus subscriber
  // captures real usage.
  const { createUsageProfile, runWithUsageProfile, summarizeUsageProfile } = await import("../telemetry/usageProfile.js")

  await initializeStory()
  registerDefaultTools(toolRegistry)

  // Pre-flight — billing check only. previously this was the only
  // place a cell could fast-fail before doing real work, but during a brief
  // network outage (DNS resolver flakes for 1-2s) the preflight chatMessage
  // threw something the retry layer didn't recognize and the child died
  // immediately with $0 cost. To keep brief blips non-fatal: any preflight
  // error is treated as a warning. The workload's own retry layer (now with
  // ENOTFOUND/EAI_AGAIN in the transient set, see lib/retry.js) will
  // bounce the same network condition on its own first model call.
  if (!args.skipPreflight) {
    try {
      await chatMessage({
        messages: [{ role: "user", content: "ping" }],
        role: "background", maxTokens: 1, temperature: 0, timeoutMs: 20_000,
      })
    } catch (error) {
      const isBilling = looksLikeBillingError(error)
      process.stderr.write(
        `[storyInitEval-child] preflight ${isBilling ? "BILLING" : "warn"}: ${String(error?.message || error).slice(0, 200)}\n`,
      )
      // Continue regardless. If it's really billing, the first real model call
      // will fail with the same signature and the workload error path takes
      // over — same outcome, no false-positive cell kills.
    }
  }

  // Guards + cost accounting via model.call.completed.
  const guard = createGuardState({
    maxCostUSD: args.maxCostUSDPerCell || 0,
    maxConsecutiveErrors: args.maxConsecutiveErrors || 5,
  })
  let modelCalls = 0
  let toolCalls = 0
  const unsubModel = bus.subscribe("model.call.completed", (event) => {
    modelCalls++
    recordModelCall(guard, event.properties || {})
    if (checkGuard(guard)) {
      process.stderr.write(`[storyInitEval-child] guard ABORT: ${guard.abortReason}\n`)
      // Best we can do mid-loop: log it. The tool-loop doesn't accept an
      // AbortSignal here, so the loop continues until its own maxSteps or
      // the parent SIGTERM kicks in. The verdict-override in summary handles
      // it.
    }
  })
  const unsubTool = bus.subscribe("tool.completed", () => { toolCalls++ })

  // Install auto-responder BEFORE runStoryInit so the first ask_user gets caught.
  const logPath = path.join(args.cellDir, "interaction.jsonl")
  const responder = installAutoResponder({ logPath })

  const intent = await readFile(args.fixturePath, "utf8")
  const started = Date.now()
  let result, error
  const profile = createUsageProfile({ action: `storyInit:${args.depth}`, turnId: `init_${Date.now()}`, kind: "story-init" })
  try {
    result = await runWithUsageProfile(profile, () => runStoryInit({ intent, depth: args.depth }))
  } catch (err) {
    error = String(err?.message || err)
  }
  const durationMs = Date.now() - started
  const summary = summarizeUsageProfile(profile)
  // Save full profile alongside artifacts for forensic readability.
  await writeFile(path.join(args.cellDir, "usageProfile.json"), JSON.stringify(profile, null, 2)).catch(() => {})

  responder.uninstall()
  unsubModel()
  unsubTool()

  process.stderr.write(
    `[storyInitEval-child] done depth=${args.depth} ${durationMs}ms ` +
      `modelCalls=${modelCalls} cost=$${guard.consumedCostUSD.toFixed(4)} asks=${responder.askCount()}\n`,
  )
  // Prefer the profile summary (authoritative — same totals as the live
  // sidebar uses) over the bus-tap counters. The bus tap stays as a
  // tripwire for the guard.
  process.stdout.write(JSON.stringify({
    depth: args.depth,
    durationMs,
    modelCalls: summary.summary.modelCalls,
    toolCalls: summary.summary.toolCalls,
    inputTokens: summary.summary.inputTokens,
    outputTokens: summary.summary.outputTokens,
    cacheReadInputTokens: summary.summary.cacheReadInputTokens,
    stepCount: result?.steps || result?.stepCount || null,
    cost: summary.summary.estimatedCostUSD,
    askCount: responder.askCount(),
    aborted: guard.aborted,
    abortReason: guard.abortReason,
    error,
  }))
  process.exit(error ? 1 : 0)
}

async function parentMain() {
  const args = parseArgs(process.argv.slice(2))
  try {
    const summary = await runStoryInitEval(args)
    process.stdout.write(`\n=== storyInit eval done: ${summary.results.length} cells ===\n`)
    process.stdout.write(`report: ${path.join(summary.outputDir, "report.md")}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`[storyInitEval] FATAL: ${error?.stack || error?.message || error}\n`)
    process.exit(2)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (args.child) childMain(args)
  else parentMain()
}
