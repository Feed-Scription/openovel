import { appendFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { ensureDir } from "../lib/files.js"
import { reportNotices } from "../lib/notices.js"
import { completeUsageProfile, createUsageProfile, runWithUsageProfile } from "../telemetry/usageProfile.js"
import { runPinnedToStoryRoot } from "../lib/storyContext.js"
import { storyPaths } from "../lib/workspacePaths.js"

const JOB_LEDGER_EVENTS = new Set(["started", "completed", "error", "abandoned"])
// Job types whose completion output is consumed by a caller (via
// waitForBackgroundJob or the .completion promise). These retain `job.output`
// in memory; fire-and-forget jobs drop output after publishing to keep the Map small.
const OUTPUT_CONSUMER_TYPES = new Set(["initializer", "subagent"])

// BackgroundJobRegistry writes an append-only JSONL ledger in addition to the
// in-memory Map used for fast .get() / .list() during the current process. The
// ledger gives us:
//   - audit trail: every spawn, success, failure, and abandonment is on disk
//   - recovery: after a crash/restart, recover() scans the ledger and marks
//     orphaned "started" jobs as "abandoned" so the next session can tell
//     "this job didn't finish" apart from "this job didn't run"
//   - external inspection: the UI or eval tooling can read the ledger
//     without going through the in-memory state
// Events written: started, completed, error, abandoned. Pending inbox items
// from abandoned jobs are recovered naturally — Storykeeper's next turn sees
// them in INBOX.md and picks them up.

export class BackgroundJobRegistry {
  #jobs = new Map()
  #ledgerPath = ""
  // Serialize ledger writes so events for the same job arrive in insertion
  // order. Without this, fire-and-forget appendFile calls can race and produce
  // out-of-order [completed, started, ...] lines that confuse recovery.
  #writeQueue = Promise.resolve()

  // Bind a JSONL ledger path. Idempotent for the same path; a different path
  // swaps the binding. Returns true if a recovery sweep was performed.
  async bindLedger({ path: ledgerPath } = {}) {
    if (!ledgerPath) return false
    if (this.#ledgerPath === ledgerPath) return false
    this.#ledgerPath = ledgerPath
    await ensureDir(path.dirname(ledgerPath))
    return this.recoverAbandoned()
  }

  ledgerPath() {
    return this.#ledgerPath
  }

  // Wait for the serialized ledger write queue to drain. Called by the app's
  // shutdown path so the "started" events of jobs that were in-flight at
  // exit are durable, which lets the next session's recoverAbandoned()
  // discover them.
  async flushLedger() {
    try { await this.#writeQueue } catch { /* ignore */ }
  }

  // Scan the ledger for jobs with a "started" event but no terminal event
  // (completed, error, abandoned). Write an "abandoned" event for each; they
  // were running when the process exited.
  async recoverAbandoned() {
    if (!this.#ledgerPath) return 0
    const events = await this.readLedger()
    const states = new Map()
    for (const e of events) {
      if (!JOB_LEDGER_EVENTS.has(e?.event)) continue
      if (!e?.id) continue
      const prev = states.get(e.id) || {}
      states.set(e.id, { ...prev, ...e, lastEvent: e.event })
    }
    let recovered = 0
    for (const [id, state] of states) {
      if (state.lastEvent === "started") {
        await this.#appendEvent({
          event: "abandoned",
          id,
          type: state.type,
          at: new Date().toISOString(),
          reason: "process restart (no terminal event in ledger)",
          startedAt: state.startedAt || state.at,
        })
        recovered++
      }
    }
    return recovered
  }

  // Read the ledger and return parsed events. Tolerates partial last-line
  // writes by skipping unparseable entries.
  async readLedger() {
    if (!this.#ledgerPath || !existsSync(this.#ledgerPath)) return []
    const raw = await readFile(this.#ledgerPath, "utf8")
    const events = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // skip torn/corrupt lines
      }
    }
    return events
  }

  // `ledgerPathOverride` lets a job's lifecycle events target the ledger that
  // was bound when the job STARTED (see start()); audit/recovery writes that
  // pass nothing keep targeting the currently-bound ledger.
  #appendEvent(event, ledgerPathOverride) {
    const ledgerPath = ledgerPathOverride ?? this.#ledgerPath
    if (!ledgerPath) return Promise.resolve()
    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await ensureDir(path.dirname(ledgerPath))
        await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, "utf8")
      } catch (error) {
        // The durable ledger is the crash-recovery mechanism. Callers fire-and-
        // forget these writes; swallowing a failure silently would let recovery
        // miss a started/completed/error record. Surface it instead.
        reportNotices(
          [`failed to write background-job ledger event "${event.event}" for ${event.id || "?"}: ${error.message || error}`],
          { event: "ledger.write_failed", prefix: "backgroundJob" },
        )
      }
    })
    return this.#writeQueue
  }

  recordAudit(event = {}) {
    const at = event.at || new Date().toISOString()
    const id = event.id || `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`
    return this.#appendEvent({
      ...event,
      event: event.event || "audit",
      id,
      at,
      output: compactForLedger(event.output),
    })
  }

  start({ id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`, type, title, metadata = {}, run, bus }) {
    const startedAt = new Date().toISOString()
    // Pin this job to the story that is active RIGHT NOW (start() runs
    // synchronously while the launching turn's env is still in place, before the
    // reader can switch). Every file-write tool call inside run() then resolves
    // against THIS root regardless of a later switchActiveStory() env flip — so
    // the job finishes writing to its own story instead of polluting whichever
    // story the reader switched to. See src/lib/storyContext.js.
    const jobStoryRoot = storyPaths().root
    // Capture the ledger bound RIGHT NOW for the same reason: this job's
    // lifecycle events must land in ITS story's ledger even when they fire
    // after a switch re-bound the registry to another story's ledger. A
    // completion written to the wrong ledger left the origin story's ledger
    // at "started" forever, so reopening that story re-woke an agent that had
    // actually finished.
    const jobLedgerPath = this.#ledgerPath
    const job = {
      id,
      type,
      title,
      status: "running",
      metadata,
      startedAt,
      // Which story this job belongs to. Consumers: the UI session filters
      // out foreign-story job events after a switch; the exit-time resume
      // snapshot (agentResume.js) records only the leaving story's jobs.
      storyRoot: jobStoryRoot,
    }
    this.#jobs.set(id, job)
    // Keep the in-memory Map bounded. Long sessions can accumulate one entry
    // per background job, including bulky tool-loop outputs. Evict the oldest
    // terminal jobs when the map exceeds the soft cap; running jobs are never
    // evicted, and the durable ledger retains the full history.
    this.#evictOldTerminalJobs()
    bus?.publish("background.job.started", { job })

    // Fire and forget — the ledger writes are independent of the run promise.
    // We track all writes so they complete before the in-memory state is read.
    this.#appendEvent({ event: "started", id, type, title, metadata, at: startedAt }, jobLedgerPath).catch(() => {})

    // Bind a per-job UsageProfile so model calls inside background work
    // (storykeeper, memory-review, signal, initializer, subagent task) land in
    // a profile the UI/eval layer can summarize. Background jobs often run
    // after the launching turn's AsyncLocalStorage scope has closed, so they
    // need their own profile.
    const usageProfile = createUsageProfile({
      action: title,
      turnId: metadata?.turnId || "",
      kind: `background:${type}`,
    })

    Promise.resolve()
      .then(() => runWithUsageProfile(usageProfile, () => runPinnedToStoryRoot(jobStoryRoot, run)))
      .then((output) => {
        const completedAt = new Date().toISOString()
        const completed = completeUsageProfile(usageProfile)
        // Only retain `output` for job types that have a real consumer waiting
        // on it (initializer ready signal, subagent tool-call result).
        // Fire-and-forget background jobs can produce large tool-loop results;
        // the ledger records a compact summary instead.
        const retainOutput = OUTPUT_CONSUMER_TYPES.has(type)
        Object.assign(job, {
          status: "completed",
          output: retainOutput ? output : undefined,
          completedAt,
          usage: completed?.summary || null,
        })
        bus?.publish("background.job.completed", { job })
        bus?.publish("background.usage", { jobId: id, type, summary: completed?.summary || null })
        this.#appendEvent({
          event: "completed",
          id,
          type,
          at: completedAt,
          startedAt,
          output: compactForLedger(output),
        }, jobLedgerPath).catch(() => {})
      })
      .catch((error) => {
        const completedAt = new Date().toISOString()
        const message = error?.message || String(error)
        // Failed jobs may still incur usage before throwing, so publish any
        // recorded usage with the error event.
        const completed = completeUsageProfile(usageProfile)
        Object.assign(job, { status: "error", error: message, completedAt, usage: completed?.summary || null })
        bus?.publish("background.job.error", { job })
        bus?.publish("background.usage", { jobId: id, type, summary: completed?.summary || null, error: message })
        this.#appendEvent({
          event: "error",
          id,
          type,
          at: completedAt,
          startedAt,
          error: message,
        }, jobLedgerPath).catch(() => {})
      })

    return job
  }

  get(id) {
    return this.#jobs.get(id)
  }

  list() {
    return [...this.#jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  // Bound the in-memory Map. Insertion order is preserved by JS Maps, and
  // start() always appends, so the first entries are the oldest. Running jobs
  // are never evicted because callers may still be awaiting them.
  #evictOldTerminalJobs() {
    const cap = 256
    if (this.#jobs.size <= cap) return
    const overflow = this.#jobs.size - cap
    let removed = 0
    for (const [id, job] of this.#jobs) {
      if (removed >= overflow) break
      if (job.status === "running") continue
      this.#jobs.delete(id)
      removed++
    }
  }

  // Drop in-memory job entries. Used during a hot story-switch after callers
  // have already drained in-flight jobs with waitForAllBackgroundJobs.
  // Leaves the ledger binding in place — call bindLedger again to switch it.
  reset() {
    this.#jobs.clear()
  }

  // Format a one-line-per-job summary for the UI or eval logs.
  async renderLedgerSummary({ limit = 20 } = {}) {
    const jobs = await this.listFromLedger({ limit })
    if (!jobs.length) return "(no jobs in ledger)"
    const ICON = { started: "⚪", completed: "✓", error: "✗", abandoned: "✗·" }
    return jobs
      .map((j) => {
        const icon = ICON[j.lastEvent] || "?"
        const idTail = String(j.id || "").slice(-10)
        const type = (j.type || "?").padEnd(16)
        const startedAt = (j.startedAt || j.at || "").slice(11, 19) // HH:MM:SS
        const outputKeys = j.event === "completed" && j.output && typeof j.output === "object"
          ? Object.keys(j.output).slice(0, 3).join(",")
          : j.event === "error"
          ? String(j.error || "").slice(0, 60)
          : j.event === "abandoned"
          ? String(j.reason || "")
          : ""
        return `${icon}  ${startedAt}  ${type}  ${idTail}  ${outputKeys}`
      })
      .join("\n")
  }

  // Aggregate ledger state into a job summary. Returns the latest event per job
  // id, sorted by start time.
  async listFromLedger({ limit = 50, since = null } = {}) {
    const events = await this.readLedger()
    const states = new Map()
    for (const e of events) {
      if (!JOB_LEDGER_EVENTS.has(e?.event)) continue
      if (!e?.id) continue
      if (since && e.at < since) continue
      const prev = states.get(e.id) || {}
      states.set(e.id, { ...prev, ...e, lastEvent: e.event })
    }
    return [...states.values()]
      .sort((a, b) => (b.startedAt || b.at || "").localeCompare(a.startedAt || a.at || ""))
      .slice(0, limit)
  }
}

// Keep heavy output objects from bloating the ledger. Storykeeper patches and
// large outputs are inspectable via scene_log.jsonl; the ledger records the
// job lifecycle and a compact output summary.
function compactForLedger(output) {
  if (!output || typeof output !== "object") return output
  if (Array.isArray(output)) return output.slice(0, 10)
  const compact = {}
  let keys = 0
  for (const [k, v] of Object.entries(output)) {
    if (keys++ >= 12) break
    if (typeof v === "string" && v.length > 280) {
      compact[k] = `${v.slice(0, 280)}...[truncated ${v.length - 280}]`
    } else if (Array.isArray(v)) {
      compact[k] = v.length > 10 ? [...v.slice(0, 10), `...[${v.length - 10} more]`] : v
    } else if (v && typeof v === "object") {
      compact[k] = "[object]"
    } else {
      compact[k] = v
    }
  }
  return compact
}

export const backgroundJobs = new BackgroundJobRegistry()
