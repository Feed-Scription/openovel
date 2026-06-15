import { BackgroundAgentRuntime } from "./backgroundAgentRuntime.js"
import { backgroundJobs } from "./backgroundJob.js"
import { bus } from "./bus.js"
import { toolRegistry } from "./toolRegistry.js"
import { acquireAgentLease } from "./agentLease.js"
import { broadcastAgentMessage, listAgentMessages, registeredAgentIds, setAgentInboxRegistry } from "./agentChannel.js"
import { loadAgentConfigs } from "../agents/loadAgentConfigs.js"
import { setAgentRegistry } from "../agents/agentRegistry.js"
import { paths } from "../lib/storyStore.js"
import { isCustomRichBlocksEnabled } from "../lib/formatContract.js"
import { buildResidentAgent } from "../workflows/residents/buildResidentAgent.js"
import { registerDefaultTools } from "../tools/registerTools.js"

function compactForBroadcast(value, max) {
  const t = String(value || "").replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3))}...`
}

// The resident-team orchestrator. On by default; set OPENOVEL_RESIDENT_TEAM=0
// to fall back to the single-Storykeeper path (the test suite pins it off).
// When on: every reader action AND every narration broadcasts a
// short summary + a pointer to the latest narrative into every background agent's
// inbox, and each sub-agent runs once per turn (writing only its own domain). The
// Showrunner coordinates + composes the frontend via the normal storykeeper loop
// (it uses the showrunner config — see runStorykeeper).

// Default ON: the resident team runs unless explicitly disabled (Settings →
// Behavior toggle off → OPENOVEL_RESIDENT_TEAM="0"). Tests pin it off via the
// npm test script so the suite exercises the legacy single-Storykeeper path.
export function isResidentTeamEnabled(env = process.env) {
  const v = String(env.OPENOVEL_RESIDENT_TEAM ?? "").trim().toLowerCase()
  if (["0", "false", "no", "off"].includes(v)) return false
  return true
}

// Cache the parsed Agent Cards PER STORY ROOT. The cards bake ABSOLUTE
// per-story paths (threadPath, inboxPath, lockPath), and the agent/inbox
// registries they populate are themselves slotted by root, so each root's
// configs stay valid independently. Keying on the caller's live (pin-aware)
// root means a story-A agent finishing after the reader switched to story B
// keeps resolving A's configs without evicting B's, and every switch path is
// self-correcting on the next broadcast/launch (every caller flows
// through here) — a single-slot cache here used to thrash between the two
// roots, and before that a stale cache wired story B's turns to story A's
// agent threads and inboxes. resetResidentConfigs stays for config edits
// (Settings agent overrides).
const configCache = new Map() // story root → configs
export async function getResidentConfigs() {
  const root = paths.root
  let configs = configCache.get(root)
  if (!configs) {
    configs = await loadAgentConfigs()
    configCache.set(root, configs)
  } else {
    // Cache hit: re-assert this root's registry slots. An init workflow may
    // have replaced them with the init team (setAgentRegistry/setAgentInbox-
    // Registry write the same per-root slots), and broadcastTurn relies on
    // getResidentConfigs leaving the inbox registry populated.
    setAgentRegistry(configs)
    setAgentInboxRegistry(configs.map((c) => [c.id, c.inboxPath]))
  }
  return configs
}
export function resetResidentConfigs() {
  configCache.clear()
}

export async function getCoordinatorConfig() {
  return (await getResidentConfigs()).find((c) => c.role === "coordinator") || null
}
export async function getSubAgentConfigs() {
  return (await getResidentConfigs()).filter((c) => c.role !== "coordinator")
}

// Build the Showrunner agent from its Agent Card (used by runStorykeeper in team
// mode in place of the default Storykeeper).
export async function buildShowrunnerAgent() {
  const coord = await getCoordinatorConfig()
  return coord ? buildResidentAgent(coord) : null
}

function withRuntimeHooks(config) {
  return {
    ...config,
    wakeAgent: (agentId, input) => wakeAgent(agentId, input),
  }
}

// Per-agent turn-broadcast wake policy (Agent Card `turnBroadcastWhen`),
// evaluated fresh at every broadcast so a Settings flip applies to the very
// next turn. An ineligible agent is left out of BOTH the inbox fan-out and the
// per-turn launch — not just the launch, or stale turn broadcasts would pile
// up in its queue and wake it on every app resume. It stays registered and
// message-woken (forAgents → wakeAgent), so requests still reach it instantly.
function turnBroadcastEligible(config) {
  const when = config?.turnBroadcastWhen || "always"
  if (when === "custom-rich-blocks") return isCustomRichBlocksEnabled()
  return true
}

// Fan a turn summary + a pointer to the latest narrative out to every agent inbox.
// Never the full prose — agents read it themselves from the pointed-at file.
export async function broadcastTurn({ event, turnId, action = "", foreground = null, selectedEffect = null, backgroundSignal = null, wakeSubAgents = false } = {}) {
  const configs = await getResidentConfigs() // ensure the inbox registry is populated
  const skip = new Set(configs.filter((c) => c.role !== "coordinator" && !turnBroadcastEligible(c)).map((c) => c.id))
  const summary = event === "narration_generated"
    ? `Narration generated (${foreground?.tension || "—"}). ${compactForBroadcast(foreground?.narration, 240)}`
    : `Reader action: ${compactForBroadcast(action, 240)}`
  const payload = {
    event,
    summary,
    narrativePointer: { dir: "story/canon", file: "chapters.recent.md", turnId },
  }
  // The reader committed to a consequential option: surface its hidden effect so an
  // ALREADY-running agent picks it up via its inbox (idle agents get it through
  // buildContext input instead). Background-only; never reaches the reader.
  if (selectedEffect && typeof selectedEffect === "object") {
    payload.selectedEffect = compactSelectedEffect(selectedEffect)
  }
  const messages = await broadcastAgentMessage(
    { from: "runtime", type: event, priority: "next", turnId, payload },
    { bus, agents: skip.size ? registeredAgentIds().filter((id) => !skip.has(id)) : null },
  )
  const jobs = wakeSubAgents && event === "narration_generated"
    ? await wakeSubAgentsFromBroadcast({ turnId, action, foreground, backgroundSignal, selectedEffect, event })
    : []
  return { messages, jobs }
}

// Trim a chosen-option effect to the fields the sub-agents act on. Keeps it small
// for the inbox broadcast; the full effect also rides buildContext input.
function compactSelectedEffect(effect) {
  const out = {}
  if (effect.intent) out.intent = compactForBroadcast(effect.intent, 200)
  if (effect.consequence) out.consequence = compactForBroadcast(effect.consequence, 280)
  if (effect.risk) out.risk = String(effect.risk)
  if (effect.difficulty) out.difficulty = compactForBroadcast(effect.difficulty, 200)
  if (Array.isArray(effect.stateHints) && effect.stateHints.length) out.stateHints = effect.stateHints.slice(0, 8)
  if (typeof effect.reversible === "boolean") out.reversible = effect.reversible
  return out
}

// Per-agent loop-active guard so concurrent turns don't double-launch one
// agent. Keyed by story root + agent id, NOT id alone: a story-A agent still
// finishing after the reader switched to story B runs detached (pinned to A)
// and must not hold B's same-named agent out of its turn — a global id key
// once made B's first World Keeper broadcast a silent skip while A's tail run
// held the slot. paths.root is pin-aware, so the run's finally clause (inside
// the pinned job) and a fresh broadcast (under the live env) each address
// their own story's slot.
const active = new Map()
function activeKey(agentId) {
  return `${paths.root}\u0000${agentId}`
}

// Launch each sub-agent once for this turn (all every turn). Each runs a single
// background batch under its own lease — six separate lock files, so they never
// contend. Returns the started jobs (fire-and-forget).
export async function launchSubAgents({ turnId, action, foreground, backgroundSignal, selectedEffect = null } = {}) {
  return wakeSubAgentsFromBroadcast({ turnId, action, foreground, backgroundSignal, selectedEffect, event: "turn" })
}

async function wakeSubAgentsFromBroadcast({ turnId, action, foreground, backgroundSignal, selectedEffect = null, event = "broadcast" } = {}) {
  const configs = await getSubAgentConfigs()
  const jobs = []
  for (const config of configs) {
    if (!turnBroadcastEligible(config)) continue // message-woken only (see turnBroadcastEligible)
    const job = startResidentAgent(config, { turnId, action, foreground, backgroundSignal, selectedEffect }, { wakeReason: `broadcast ${event}` })
    if (job) jobs.push(job)
  }
  return jobs
}

// Reopen-time resume (the counterpart of agentResume.js's exit snapshot): wake
// every sub-agent that still has PENDING inbox messages (queued by a turn
// broadcast it never got to run for) or that was mid-run when the previous
// session exited (`interruptedAgents`, derived from the exit snapshot
// cross-checked against the jobs ledger). Already-running agents and
// coordinators are skipped by wakeAgent itself — the Showrunner resumes
// through the existing INBOX.md kickstart path. Agents carry no in-memory
// state worth restoring beyond this: their notebook/thread/domain files ARE
// the state, so a fresh wake picks up exactly where the files left off.
export async function resumeResidentAgents({ interruptedAgents = [], turnId = "" } = {}) {
  if (!isResidentTeamEnabled()) return { woken: [], turnId: "" }
  const configs = await getSubAgentConfigs()
  const interrupted = new Set((interruptedAgents || []).filter(Boolean))
  const resumeTurnId = turnId || `resume_${Date.now().toString(36)}`
  const woken = []
  for (const config of configs) {
    let hasPending = false
    if (!interrupted.has(config.id)) {
      try {
        const pending = await listAgentMessages({ queuePath: config.inboxPath, status: "pending", limit: 1 })
        hasPending = pending.length > 0
      } catch { /* no queue file yet — nothing pending */ }
      if (!hasPending) continue
    }
    const result = await wakeAgent(config.id, { turnId: resumeTurnId, action: "", sourceAgent: "session-resume" })
    if (result.started) woken.push(config.id)
  }
  return { woken, turnId: resumeTurnId }
}

// Wake one idle peer sub-agent after a `forAgents` inbox message is queued. If it
// is already running, do nothing: its drainQueuedContext hook will read the
// pending inbox item between tool calls. Coordinators are not woken here; use
// `forShowrunner` for the Showrunner's existing composition loop.
export async function wakeAgent(agentId, { turnId, action, foreground, backgroundSignal, selectedEffect = null, sourceAgent } = {}) {
  const id = String(agentId || "")
  if (!id) return { started: false, reason: "missing-agent" }
  const config = (await getResidentConfigs()).find((c) => c.id === id) || null
  if (!config) return { started: false, reason: "unknown-agent", agent: id }
  if (config.role === "coordinator") return { started: false, reason: "coordinator-not-woken", agent: id }
  if (active.get(activeKey(config.id))) return { started: false, reason: "already-active", agent: id }
  const job = startResidentAgent(config, { turnId, action, foreground, backgroundSignal, selectedEffect }, { wakeReason: sourceAgent ? `message from ${sourceAgent}` : "inbox message" })
  return job ? { started: true, agent: id, jobId: job.id } : { started: false, reason: "already-active", agent: id }
}

// Last-finisher → Showrunner wake signal. Observed race (s_a9853e6d): the
// Showrunner composes in ~20s while sub-agents run for minutes, so their
// forShowrunner handoffs land in a queue nobody re-reads until the NEXT reader
// turn — and if the app closes first, never (generated illustrations the
// narrator was never told about). After a sub-agent's run settles, when it was
// the LAST active sub-agent and the coordinator inbox still holds pending
// messages, publish a bus event; the session layer (which owns the
// storykeeper/Showrunner job machinery) wakes one composition pass. The
// loop-flag + lease over there make this safe to over-signal.
export async function signalShowrunnerHandoffsIfIdle({ completedAgent = "", turnId = "" } = {}) {
  try {
    const subs = await getSubAgentConfigs()
    if (subs.some((c) => c.id !== completedAgent && active.get(activeKey(c.id)))) {
      return { signaled: false, reason: "siblings-active" }
    }
    const coord = await getCoordinatorConfig()
    if (!coord) return { signaled: false, reason: "no-coordinator" }
    const pending = await listAgentMessages({ queuePath: coord.inboxPath, status: "pending", limit: 1 })
    if (!pending.length) return { signaled: false, reason: "no-pending" }
    bus.publish("resident.handoffs.pending", { completedAgent, turnId, coordinator: coord.id })
    return { signaled: true, coordinator: coord.id }
  } catch (error) {
    // Signal-only path: never let it fail or delay the sub-agent's own run.
    return { signaled: false, reason: error?.message || String(error) }
  }
}

function startResidentAgent(config, { turnId, action, foreground, backgroundSignal, selectedEffect = null } = {}, { wakeReason = "" } = {}) {
  // Capture the key: the launch context (live env or wake pin) and the run's
  // finally clause (pinned to the job's story) resolve the same root, but the
  // captured key makes the pairing explicit and switch-proof.
  const key = activeKey(config.id)
  if (active.get(key)) return null
  active.set(key, true)
  const title = wakeReason
    ? `${config.id} wake ${shortId(turnId)}`
    : `${config.id} turn ${shortId(turnId)}`
  const metadata = { turnId, agent: config.id }
  if (wakeReason) metadata.wakeReason = wakeReason
  try {
    return backgroundJobs.start({
      type: `resident:${config.id}`,
      title,
      metadata,
      bus,
      run: async () => {
        let lease = null
        try {
          lease = await acquireAgentLease({
            lockPath: config.lockPath,
            owner: `${config.id}:${turnId || `wake_${Date.now()}`}`,
            audit: (event) => backgroundJobs.recordAudit(event),
          })
          if (!lease.acquired) {
            return { agent: config.id, delegatedTo: lease.lock?.lockId || "", reason: `lease ${lease.reason}` }
          }
          registerDefaultTools(toolRegistry)
          const runtime = new BackgroundAgentRuntime({ registry: toolRegistry, bus, role: "background" })
          return await runtime.run({
            agent: buildResidentAgent(withRuntimeHooks(config)),
            input: { turnId, action, foreground, backgroundSignal, selectedEffect },
          })
        } finally {
          await lease?.release?.().catch(() => {})
          active.delete(key)
          // Fire-and-forget: wake the Showrunner if this was the last finisher
          // and its handoffs are still sitting unconsumed (see the export above).
          void signalShowrunnerHandoffsIfIdle({ completedAgent: config.id, turnId })
        }
      },
    })
  } catch (error) {
    active.delete(key)
    throw error
  }
}

function shortId(turnId) {
  const v = String(turnId || "")
  return v.length > 8 ? v.slice(-8) : v
}
