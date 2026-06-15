import { getStorySnapshot, paths, recordSceneEvent } from "../../lib/storyStore.js"
import { parseJsonObject } from "../../lib/json.js"
import { readText } from "../../lib/files.js"
import { reportNotices } from "../../lib/notices.js"
import {
  drainAgentMessages,
  enqueueAgentMessage,
  markAgentMessagesForTurnInjected,
  registeredAgentIds,
  renderAgentInbox,
} from "../../runtime/agentChannel.js"
import { resolveActiveStoryMode } from "../../lib/storyDirectory.js"
import { storyModeContextNote } from "../storykeeperContext.js"

// The generic resident SUB-AGENT behavior (World Keeper, Director, Card Manager,
// Memory, Render Manager). All share this one behavior; they differ only by their
// Agent Card config (tools, file domain, system prompt). The actual work happens
// via the file tools during the run — read canon + the agent's own domain, then
// write/edit files under that domain. The returned envelope is a small status
// receipt; durable state lives in the files. Mirrors the Showrunner's
// tools-do-the-work shape but with a minimal envelope and no frontend authority.
//
// Per turn the agent is driven by a broadcast in its inbox (a summary + a pointer
// to the latest full narrative), drained mid-run via drainQueuedContext. Anything
// it wants the Showrunner to fold into the narrator-facing frontend it returns in
// `forShowrunner`, which is forwarded to the Showrunner's inbox. Peer requests
// travel through `forAgents` and reuse the same per-agent inbox queues; an idle
// target can be woken by the resident-team runtime hook.
// A forAgents target that means "the coordinator": the model addressing it by
// its current id, its role name, or the legacy single-agent name. Such a
// message is a coordinator-bound recommendation that took the wrong field, so
// the apply step reroutes it into the coordinator's inbox (same shape as
// forShowrunner) instead of dropping it; the observed drops were continuity
// alarms, exactly the messages that must not vanish on an addressing slip.
export function isCoordinatorAlias(to, coordinatorId = "showrunner") {
  const t = String(to || "").trim().toLowerCase()
  if (!t) return false
  return t === String(coordinatorId).trim().toLowerCase() || ["showrunner", "storykeeper", "coordinator"].includes(t)
}

export function subAgentBehavior(config) {
  const domainLabel = config.domain || config.id
  const coordinatorId = config.coordinatorId || "showrunner"
  const coordinatorLabel = config.coordinatorLabel || "Showrunner"
  return {
    async prepare({ input }) {
      // Pre-mark only runtime turn broadcasts so buildContext can rely on the
      // summary/pointer without double-injecting it on the first drain. Peer
      // messages for the same turn must remain pending so a woken/active agent
      // can read them between tool calls.
      await markAgentMessagesForTurnInjected(input.turnId, {
        agent: config.id,
        sources: ["runtime"],
        types: ["reader_action", "narration_generated"],
      }).catch(() => {})
    },

    async buildContext({ input }) {
      const snapshot = await getStorySnapshot().catch(() => ({ chapters: "", chaptersRecent: "" }))
      const recent = snapshot.chaptersRecent || (await readText(paths.chaptersRecent, "").catch(() => ""))
      // Per-story pacing mode: the same register note the Showrunner sees, so
      // no sub-agent (the Director's quality audit above all) fights the
      // intended brevity of a fast-mode story.
      const storyMode = await resolveActiveStoryMode().catch(() => "")
      const contextMarkdown = renderSubAgentContext({ config, domainLabel, coordinatorId, coordinatorLabel, input, recent, storyMode })
      return { snapshot, contextMarkdown, expectedStoryRoot: paths.root }
    },

    async normalize(rawContent) {
      return normalizeSubAgentEnvelope(parseJsonObject(rawContent, {}))
    },

    async apply(normalized, { input }) {
      // The file writes already happened via tools. Forward any recommendations to
      // the coordinator (Showrunner in resident mode), and record the pass for the audit.
      if (normalized.forShowrunner.length) {
        const priority = config.id === "director" ? "now" : "next"
        await enqueueAgentMessage({
          from: config.id,
          to: coordinatorId,
          type: "subagent_recommendation",
          priority,
          turnId: input.turnId,
          payload: { from: config.id, recommendations: normalized.forShowrunner },
        }).catch(() => {})
      }
      const registered = new Set(registeredAgentIds())
      for (const message of normalized.forAgents) {
        if (isCoordinatorAlias(message.to, coordinatorId)) {
          reportNotices(
            [`forAgents target "${message.to}" (from "${config.id}") is the coordinator; rerouted to the "${coordinatorId}" inbox as a recommendation (coordinator-bound items belong in forShowrunner)`],
            { event: "agent.channel.coordinator_reroute", prefix: "channel" },
          )
          await enqueueAgentMessage({
            from: config.id,
            to: coordinatorId,
            type: "subagent_recommendation",
            priority: config.id === "director" ? "now" : message.priority,
            turnId: input.turnId,
            payload: { from: config.id, recommendations: [message.message] },
          }).catch(() => {})
          continue
        }
        if (registered.size && !registered.has(message.to)) {
          reportNotices(
            [`forAgents target "${message.to}" (from "${config.id}") is not a registered agent inbox; the request was dropped: ${String(message.message || "").slice(0, 200)}`],
            { event: "agent.channel.unknown_target", prefix: "channel" },
          )
          continue
        }
        await enqueueAgentMessage({
          from: config.id,
          to: message.to,
          type: message.type,
          priority: message.priority,
          turnId: input.turnId,
          payload: {
            from: config.id,
            message: message.message,
          },
        }).catch(() => {})
        await config.wakeAgent?.(message.to, {
          turnId: input.turnId,
          action: input.action,
          foreground: input.foreground,
          backgroundSignal: input.backgroundSignal,
          selectedEffect: input.selectedEffect,
          sourceAgent: config.id,
        }).catch(() => {})
      }
      await recordSceneEvent({
        type: "resident_subagent_patch",
        workflow: config.id,
        turnId: input.turnId,
        patch: normalized,
      }).catch(() => {})
      return { skipped: normalized.status === "skipped", ...normalized }
    },

    async fallback({ input }) {
      return JSON.stringify({
        status: "skipped",
        summary: `No model available; ${config.id} took no action for ${input.turnId}.`,
        filesTouched: [],
        notes: [],
      })
    },

    async drainQueuedContext({ input, bus }) {
      // Drain ALL pending (including this turn's broadcast — it is the trigger).
      const messages = await drainAgentMessages({ agent: config.id, bus })
      return messages.length ? [{ role: "user", content: renderAgentInbox(messages) }] : []
    },

    async onEvent(type, payload) {
      await recordSceneEvent({ type, workflow: config.id, ...payload }).catch(() => {})
    },

    traceInput(input) {
      return { turnId: input.turnId, agent: config.id }
    },

    traceOutput(out) {
      return {
        status: out.status,
        filesTouched: out.filesTouched,
        forShowrunner: out.forShowrunner?.length || 0,
        forAgents: out.forAgents?.length || 0,
      }
    },
  }
}

function renderSubAgentContext({ config, domainLabel, coordinatorId, coordinatorLabel, input, recent, storyMode = "" }) {
  // The valid peer addresses, resolved live from the inbox registry so the
  // model never has to guess ids or address the coordinator by a legacy name.
  const peers = registeredAgentIds().filter((id) => id !== config.id && id !== coordinatorId)
  const modeNote = storyModeContextNote(storyMode)
  return [
    `# ${config.id} Turn Context`,
    "",
    `You maintain the **${domainLabel}** domain. Read the latest narrative and your own domain files, then update YOUR domain (story/${domainLabel}/ and any other paths in your writeScope). Reads across story/ are unrestricted; writes outside your domain are refused.`,
    "",
    ...(modeNote ? ["## Story Mode", modeNote, ""] : []),
    `Reader action this turn: ${compact(input.action, 400) || "(advance / none)"}`,
    renderChosenEffect(input.selectedEffect),
    "",
    "## Latest narrative (just-written beat, full record is story/canon/chapters.md)",
    "```",
    compact(recent, 4000) || "(none yet)",
    "```",
    "",
    `Your inbox (below, if any) carries the turn broadcast (summary + pointer) and any messages from peers. Do your work with the file tools, then return the small status envelope. Put concrete frontend recommendations in \`forShowrunner\`, the ${coordinatorLabel} owns story/frontend/ and story/guidance/. Put concrete peer-agent requests in \`forAgents\` when another resident sub-agent must re-check or update its own domain.`,
    peers.length
      ? `Valid \`forAgents\` recipients this story: ${peers.join(", ")}. The ${coordinatorLabel} is NOT a forAgents target under any name (not "${coordinatorId}", not a legacy coordinator name): anything coordinator-bound goes in forShowrunner.`
      : `No peer sub-agents are registered this story, so use no \`forAgents\` at all: anything coordinator-bound goes in forShowrunner.`,
  ].filter(Boolean).join("\n")
}

// When the reader committed to a consequential option, surface its (validated,
// server-resolved) hidden effect so the World Keeper can persist it and the
// Director can size pressure from its risk/difficulty. The reader has NOT been
// shown this; it is the forward situation the next beat must honor. Empty string
// (filtered out) for free-typed actions or flavor options with no effect.
function renderChosenEffect(effect) {
  if (!effect || typeof effect !== "object") return ""
  const lines = ["", "## Chosen effect this turn (hidden from the reader, act on it)"]
  if (effect.intent) lines.push(`- intent: ${compact(effect.intent, 300)}`)
  if (effect.consequence) lines.push(`- consequence (the next beat must honor this): ${compact(effect.consequence, 400)}`)
  if (effect.risk) lines.push(`- risk: ${compact(effect.risk, 40)}`)
  if (effect.difficulty) lines.push(`- difficulty seed: ${compact(effect.difficulty, 300)}`)
  if (typeof effect.reversible === "boolean") lines.push(`- reversible: ${effect.reversible}`)
  const hints = Array.isArray(effect.stateHints) ? effect.stateHints.filter((h) => h && typeof h === "object").slice(0, 8) : []
  if (hints.length) {
    lines.push("- stateHints (durable-state nudges to reconcile against canon before writing):")
    for (const h of hints) {
      const parts = [h.key && `key=${compact(h.key, 80)}`, h.op && `op=${compact(h.op, 24)}`, h.value !== undefined && `value=${compact(String(h.value), 80)}`, h.note && `note=${compact(h.note, 160)}`].filter(Boolean)
      lines.push(`  - ${parts.join(", ")}`)
    }
  }
  return lines.join("\n")
}

export function normalizeSubAgentEnvelope(obj = {}) {
  const o = obj && typeof obj === "object" ? obj : {}
  const summary = compact(o.summary, 600)
  const filesTouched = arr(o.filesTouched).map((s) => compact(s, 160)).filter(Boolean).slice(0, 30)
  const notes = arr(o.notes).map((s) => compact(s, 280)).filter(Boolean).slice(0, 10)
  const forShowrunner = arr(o.forShowrunner).map((s) => compact(s, 700)).filter(Boolean).slice(0, 12)
  const forAgents = arr(o.forAgents).map(normalizeAgentRequest).filter(Boolean).slice(0, 12)
  const hasPayload = Boolean(summary || filesTouched.length || notes.length || forShowrunner.length || forAgents.length)
  return {
    status: ["applied", "partial", "skipped"].includes(o.status) ? o.status : hasPayload ? "applied" : "skipped",
    summary,
    filesTouched,
    notes,
    forShowrunner,
    forAgents,
  }
}

function normalizeAgentRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const to = compact(value.to || value.agent || value.target, 80)
  const message = compact(value.message || value.request || value.note || value.summary || value.instruction, 700)
  if (!to || !message) return null
  return {
    to,
    type: compact(value.type || "peer_request", 80) || "peer_request",
    priority: normalizePriority(value.priority),
    message,
  }
}

function normalizePriority(value) {
  const p = String(value || "").trim().toLowerCase()
  return ["now", "next", "later"].includes(p) ? p : "next"
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

function compact(v, max) {
  const t = String(v || "").replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3))}...`
}
