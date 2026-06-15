import { compileForegroundContext } from "../context/contextCompiler.js"
import { getStorySnapshot, initializeStory } from "../lib/storyStore.js"
import { registerDefaultTools } from "../tools/registerTools.js"
import { backgroundJobs } from "../runtime/backgroundJob.js"
import { sessionProcessor } from "../runtime/sessionProcessor.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { modelInfo } from "../provider/provider.js"
import { persistUsageProfile } from "../telemetry/usageProfile.js"

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.action) throw new Error("Usage: node src/eval/storySmoke.js --action <text> --expect <term> ...")

  await initializeStory()
  registerDefaultTools(toolRegistry)

  const result = await sessionProcessor.processReaderAction({ action: args.action, optionsEnabled: args.optionsEnabled })
  const jobs = [result.signalJob, result.job, result.memoryJob].filter(Boolean)
  if (args.waitBackground) {
    await waitForJobs(jobs, args.timeoutMs)
    await waitForAllBackgroundJobs(args.timeoutMs)
  }
  const profile = result.profile ? await persistUsageProfile(result.profile) : null

  const snapshot = await getStorySnapshot()
  const compiled = await compileForegroundContext({
    snapshot,
    action: "smoke eval",
    turnId: result.turnId,
  })

  const foregroundText = JSON.stringify(result.foreground)
  const guidanceText = snapshot.foregroundGuidance || ""
  const checks = [
    {
      id: "foreground_model_used",
      ok: result.foreground.source !== "fallback",
      detail: `source=${result.foreground.source}`,
    },
    {
      id: "background_jobs_completed",
      ok: jobs.every((job) => job.status === "completed"),
      detail: jobs.map((job) => `${job.type}:${job.status}${job.error ? `:${job.error}` : ""}`).join(", "),
    },
    ...args.expect.map((term) => ({
      id: `guidance_includes:${term}`,
      ok: guidanceText.includes(term),
      detail: term,
    })),
    ...args.expectAny.map((term) => ({
      id: `foreground_or_guidance_includes:${term}`,
      ok: foregroundText.includes(term) || guidanceText.includes(term),
      detail: term,
    })),
    ...args.expectForeground.map((term) => ({
      id: `foreground_includes:${term}`,
      ok: foregroundText.includes(term),
      detail: term,
    })),
    {
      id: "context_report_has_sources",
      ok: Array.isArray(compiled.report.sources) && compiled.report.sources.length >= 3,
      detail: `${compiled.report.sources?.length || 0} sources`,
    },
  ]

  const payload = {
    ok: checks.every((check) => check.ok),
    action: args.action,
    turnId: result.turnId,
    providers: modelInfo(),
    checks,
    foreground: result.foreground,
    backgroundJobs: jobs.map(publicJobInfo),
    profile,
    foregroundGuidance: snapshot.foregroundGuidance,
    inboxPending: snapshot.backgroundInboxItems?.length || 0,
    contextReport: compiled.report,
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  if (!payload.ok) process.exitCode = 1
}

function parseArgs(argv) {
  const out = {
    action: "",
    expect: [],
    expectAny: [],
    expectForeground: [],
    waitBackground: false,
    timeoutMs: 180000,
    optionsEnabled: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--action") out.action = argv[++i] || ""
    else if (arg.startsWith("--action=")) out.action = arg.slice("--action=".length)
    else if (arg === "--expect") out.expect.push(argv[++i] || "")
    else if (arg.startsWith("--expect=")) out.expect.push(arg.slice("--expect=".length))
    else if (arg === "--expect-any") out.expectAny.push(argv[++i] || "")
    else if (arg.startsWith("--expect-any=")) out.expectAny.push(arg.slice("--expect-any=".length))
    else if (arg === "--expect-foreground") out.expectForeground.push(argv[++i] || "")
    else if (arg.startsWith("--expect-foreground=")) out.expectForeground.push(arg.slice("--expect-foreground=".length))
    else if (arg === "--wait-background") out.waitBackground = true
    else if (arg === "--options") out.optionsEnabled = true
    else if (arg === "--no-options") out.optionsEnabled = false
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]) || out.timeoutMs
    else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice("--timeout-ms=".length)) || out.timeoutMs
  }
  out.expect = out.expect.filter(Boolean)
  out.expectAny = out.expectAny.filter(Boolean)
  out.expectForeground = out.expectForeground.filter(Boolean)
  return out
}

function publicJobInfo(job) {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  }
}

async function waitForJobs(jobs, timeoutMs) {
  const started = Date.now()
  while (jobs.some((job) => job.status === "running")) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for background jobs after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function waitForAllBackgroundJobs(timeoutMs) {
  const started = Date.now()
  let quietChecks = 0
  while (quietChecks < 2) {
    const running = backgroundJobs.list().filter((job) => job.status === "running")
    if (!running.length) {
      quietChecks++
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    quietChecks = 0
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for all background jobs after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exit(1)
})
