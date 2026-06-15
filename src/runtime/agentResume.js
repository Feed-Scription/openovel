// Exit-time snapshot of in-flight background agents, for auto-resume when the
// story is reopened.
//
// Leaving a story (home button / story switch / app quit) does NOT abort
// background agents — in-session they keep running detached, pinned to their
// origin story, and usually finish. What the snapshot records is "who was
// mid-run at the moment of exit" so the NEXT open of this story can tell the
// difference between work that completed after the reader left (ledger shows a
// terminal event → nothing to do) and work that was genuinely interrupted (app
// quit / crash → ledger left at started/abandoned → re-wake the agent; its
// durable files — notebook, thread, inbox — carry its actual state).
//
// The snapshot is deliberately ONLY written when something is running:
// "no running jobs" must NOT delete a previous session's snapshot, because the
// boot path enters the library (and drains) before the reader reopens a story.
// Staleness is harmless — the reopen cross-checks every recorded job against
// the jobs ledger before waking anything, and consume removes the file.

import path from "node:path"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { paths } from "../lib/storyStore.js"

export function agentResumeSnapshotPath() {
  return path.join(paths.agents, "RESUME.json")
}

// Record currently-running background jobs (agents) for the ACTIVE story.
// Call while the env still points at the story being left. Jobs pinned to a
// DIFFERENT story (job.storyRoot — e.g. a previous story's agent still
// finishing detached after a fast switch-away-and-back) are excluded: they
// are not this story's interrupted work, and recording them would make the
// next open re-wake another story's agents. Jobs without a storyRoot
// (older shape) are kept.
export async function writeAgentResumeSnapshot({ registry } = {}) {
  const activeRoot = paths.root
  const running = (registry?.list?.() || [])
    .filter((job) => job.status === "running")
    .filter((job) => !job.storyRoot || job.storyRoot === activeRoot)
  if (!running.length) return { recorded: 0 }
  const activeJobs = running.map((job) => ({
    id: job.id,
    type: job.type || "",
    agent: job.metadata?.agent || "",
    turnId: job.metadata?.turnId || "",
    title: job.title || "",
    startedAt: job.startedAt || "",
  }))
  const file = agentResumeSnapshotPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), activeJobs }, null, 2), "utf8")
  return { recorded: activeJobs.length }
}

// Read AND remove the snapshot (one-shot — a resume pass must not repeat).
// Returns null when absent/unreadable.
export async function consumeAgentResumeSnapshot() {
  const file = agentResumeSnapshotPath()
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    await rm(file, { force: true })
    return parsed && Array.isArray(parsed.activeJobs) ? parsed : null
  } catch {
    return null
  }
}

// Cross-check snapshot jobs against the ledger: only jobs WITHOUT a terminal
// event count as interrupted (a job that finished after the reader went home
// has "completed" in the ledger and needs nothing). Returns the distinct agent
// ids that were genuinely cut off.
export function interruptedAgentsFromLedger(snapshot, ledgerEvents = []) {
  if (!snapshot?.activeJobs?.length) return []
  const lastEvent = new Map()
  for (const event of ledgerEvents) {
    if (event?.id && event?.event) lastEvent.set(event.id, event.event)
  }
  const agents = new Set()
  for (const job of snapshot.activeJobs) {
    const state = lastEvent.get(job.id) || "started"
    if ((state === "started" || state === "abandoned") && job.agent) agents.add(job.agent)
  }
  return [...agents]
}
