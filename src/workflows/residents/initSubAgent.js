import { parseJsonObject } from "../../lib/json.js"
import { readText } from "../../lib/files.js"
import { reportNotices } from "../../lib/notices.js"
import { getStorySnapshot, paths, recordSceneEvent } from "../../lib/storyStore.js"
import {
  drainAgentMessages,
  enqueueAgentMessage,
  registeredAgentIds,
  renderAgentInbox,
} from "../../runtime/agentChannel.js"
import { isCoordinatorAlias, normalizeSubAgentEnvelope } from "./subAgent.js"

// Init-time variant of the resident sub-agent lifecycle. It reuses the same
// createResidentAgent/buildResidentAgent scaffold and the same status envelope,
// but its context is the story brief rather than a just-written narration beat.
export function initSubAgentBehavior(config) {
  const domainLabel = config.domain || config.id
  const coordinatorId = config.coordinatorId || "story-init"
  return {
    async buildContext({ input }) {
      const snapshot = await getStorySnapshot().catch(() => ({ chapters: "", chaptersRecent: "" }))
      const brief = await readText(paths.brief, "").catch(() => "")
      const contextMarkdown = renderInitSubAgentContext({
        config,
        domainLabel,
        input,
        brief: brief || input.originalBrief || input.intent,
      })
      return { snapshot, contextMarkdown, expectedStoryRoot: paths.root }
    },

    async normalize(rawContent) {
      return normalizeSubAgentEnvelope(parseJsonObject(rawContent, {}))
    },

    async apply(normalized, { input }) {
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
        // Same reroute as the play-time sub-agent behavior: a coordinator
        // addressed through forAgents (by any of its names) is a misfiled
        // forShowrunner item, not a droppable unknown target.
        if (isCoordinatorAlias(message.to, coordinatorId)) {
          reportNotices(
            [`forAgents target "${message.to}" (from "${config.id}", init) is the coordinator; rerouted to the "${coordinatorId}" inbox as a recommendation (coordinator-bound items belong in forShowrunner)`],
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
            [`forAgents target "${message.to}" (from "${config.id}", init) is not a registered agent inbox; the request was dropped: ${String(message.message || "").slice(0, 200)}`],
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
      }

      await recordSceneEvent({
        type: "story_init_subagent_patch",
        workflow: config.id,
        turnId: input.turnId,
        patch: normalized,
      }).catch(() => {})
      return { skipped: normalized.status === "skipped", ...normalized }
    },

    async fallback({ input }) {
      return JSON.stringify({
        status: "skipped",
        summary: `No model available; ${config.id} took no init action for ${input.turnId}.`,
        filesTouched: [],
        notes: [],
      })
    },

    async drainQueuedContext({ input, bus }) {
      const messages = await drainAgentMessages({ agent: config.id, bus })
      return messages.length ? [{ role: "user", content: renderAgentInbox(messages) }] : []
    },

    async onEvent(type, payload) {
      await recordSceneEvent({ type, workflow: config.id, ...payload }).catch(() => {})
    },

    traceInput(input) {
      return {
        turnId: input.turnId,
        agent: config.id,
        depth: input.depth,
        intentChars: String(input.intent || "").length,
        revision: Array.isArray(input.history) && input.history.length > 0,
      }
    },

    traceOutput(out) {
      return {
        status: out.status,
        filesTouched: out.filesTouched,
        forCoordinator: out.forShowrunner?.length || 0,
        forAgents: out.forAgents?.length || 0,
      }
    },
  }
}

function renderInitSubAgentContext({ config, domainLabel, input, brief }) {
  const revision = Array.isArray(input.history) && input.history.length > 0
  return [
    `# ${config.id} Initialization Context`,
    "",
    "You are running before the first interactive reader turn. There is no live canon yet; story/BRIEF.md, the user's latest init request, and the conversation history are the authority.",
    "Conflict rule: if existing scaffold/domain files, peer handoffs, research notes, or compacted/truncated context contradict the User Brief below, the brief wins unless the latest init request explicitly revises that exact detail. Treat the other source as drift and repair or report it; do not ask the coordinator/reader to pick between generated contradictions when the brief already answers it.",
    "First-round launch is inbox-driven: the story-init coordinator starts you by queuing an `init_assignment` message in your inbox. That inbox message is your concrete launch contract; satisfy it before broadening within your domain.",
    `You maintain the **${domainLabel}** domain. Read broadly, but write only the paths in your writeScope. The story-init coordinator owns story/frontend/ and story/guidance/; hand narrator-facing recommendations to it via \`forShowrunner\`.`,
    "",
    `Depth: ${input.depth || "standard"}`,
    renderRepairNotice(input),
    revision
      ? "This is an INIT REVISION pass. Update only what the latest request requires and keep earlier accepted scaffold work unless it conflicts."
      : "This is a fresh initialization pass. Seed your domain from the brief so the coordinator can compose the first narrator working set.",
    "",
    "## User Brief",
    "",
    String(brief || "").trim() || "(empty)",
    renderLatestRequest(input),
    renderInitPlan(input.initPlan),
    renderHistory(input.history),
    renderUserPreferences(input.userPreferences),
    "",
    "## Your Domain Task",
    "",
    domainTask(config),
    "",
    "## Coordination",
    "",
    "Your inbox is injected on step 0 and may contain the `init_assignment` or repair request that launched this run. Return the standard sub-agent JSON receipt. Put concrete frontend/guidance recommendations in `forShowrunner`; they will be delivered to the story-init coordinator before it writes the narrator-facing files. Use `forAgents` only for truly blocking peer-domain checks.",
    renderInitPeerLine(config),
  ].filter(Boolean).join("\n")
}

// The valid peer addresses, resolved live from the inbox registry so the model
// never has to guess ids; the coordinator is never a forAgents target.
function renderInitPeerLine(config) {
  const coordinatorId = config.coordinatorId || "story-init"
  const peers = registeredAgentIds().filter((id) => id !== config.id && id !== coordinatorId)
  return peers.length
    ? `Valid \`forAgents\` recipients: ${peers.join(", ")}. The coordinator is NOT a forAgents target under any name (not "${coordinatorId}", not a legacy coordinator name): anything coordinator-bound goes in forShowrunner.`
    : "No peer sub-agents are registered, so use no `forAgents` at all: anything coordinator-bound goes in forShowrunner."
}

function renderLatestRequest(input) {
  const text = String(input.intent || "").trim()
  if (!text) return ""
  return ["", "## Latest Init Request", "", text].join("\n")
}

function renderInitPlan(plan) {
  const text = String(plan || "").trim()
  if (!text) return ""
  return ["", "## Confirmed Init Plan", "", text].join("\n")
}

function renderRepairNotice(input) {
  if (!input?.initRepairRound) return ""
  return [
    `Repair pass: ${input.initRepairRound}`,
    "First drain and satisfy pending inbox repair requests for your own domain. Re-read story/BRIEF.md and any conflicting files before editing. Keep the fix scoped; do not broaden the story.",
  ].join("\n")
}

function renderHistory(history = []) {
  const rows = (Array.isArray(history) ? history : [])
    .map((h) => {
      const role = h?.role === "assistant" ? "assistant" : "user"
      const content = compact(h?.content, 1200)
      return content ? `- ${role}: ${content}` : ""
    })
    .filter(Boolean)
  if (!rows.length) return ""
  return ["", "## Init Conversation So Far", "", ...rows].join("\n")
}

function renderUserPreferences(text) {
  const value = String(text || "").trim()
  if (!value) return ""
  return ["", "## User Preferences", "", value].join("\n")
}

function domainTask(config) {
  const id = String(config.id || "")
  const domain = String(config.domain || "")
  if (id === "worldkeeper" || domain === "worldkeeper") {
    return [
      "Seed story/worldkeeper/ and story/state/ with world logic the brief makes durable: places, factions, resources, rules, constraints, language map, and any numeric/status-tracked state.",
      "For real-world or canon grounding, use websearch/webfetch when your tools allow it, and compress findings into your own domain rather than raw search dumps.",
    ].join("\n")
  }
  if (id === "director" || domain === "director") {
    return [
      "Seed story/director/ARC.md with opening arc position, pressure rhythm, stagnation watch, and 1-few non-reader-facing foreshadowing setups with intended payoffs.",
      "Seed or refine story/director/QUALITY.md with prose/tic audit concerns the coordinator should encode into frontend/forbidden.md. Never write the opening scene.",
      "When researching or auditing narrator tics, target the reader's preferred story language from User Preferences / the init request. Do not import only English AI-writing tells into a Chinese, Japanese, or bilingual story; search and record the phrases, sentence frames, register tells, and correctives that would actually appear in the language the live narrator will use.",
    ].join("\n")
  }
  if (id === "cards" || domain === "cards") {
    return [
      "Author EVERY character / place / faction / durable-object card AS its own file at story/context-cards/<slug>/CARD.md (one directory per entity, slug = lowercase-kebab of the primary name), with frontmatter that carries a triggers list covering every surface form the prose will use for it. This standard path is the ONLY location the runtime literally trigger-matches to auto-load a card the turn its entity appears. A card body kept under story/cards/, or surfaced only by a story/guidance/cards.md @include, does NOT participate in that trigger-based activation.",
      "story/cards/ holds your working/curation notes ONLY, never the authoritative card content. A cards.md @include is the curated always-on set and is ADDITIVE to trigger activation, it is not a substitute for authoring the card at its context-cards path. If you find any entity card the scaffold placed outside story/context-cards/ (or referenced only through an @include), migrate its full body and triggers to the standard story/context-cards/<slug>/CARD.md path so auto-loading turns on.",
      "After authoring the cards, recommend to the coordinator which ones are durably load-bearing enough to also pin into story/guidance/cards.md.",
    ].join("\n")
  }
  if (id === "memory" || domain === "memory") {
    return "Seed story/memory/MEMORY.md and topics/ with compact, durable lore and source-backed canon notes that should survive beyond the opening scaffold."
  }
  if (id === "render" || domain === "render") {
    if (config.customBlocksDisplayed === false) {
      const channels = ["HUD", "include", ...(config.imageBackgroundEnabled ? ["bg"] : []), ...(config.musicEnabled ? ["music"] : [])].join("/")
      return `Custom story-card styling/display is currently OFF. Do not author templates under story/format/blocks/, block CSS, or custom block-fence usage. Seed only story/format/config.json reserved channels (${channels} as enabled) and story/render/ notes, then recommend reserved-channel narrator guidance to the coordinator.`
    }
    return "If this story genuinely benefits from rich rendering, author the contract files under story/format/ (blocks/<kind>.html templates + their .css + config.json when needed) and any render notes under story/render/. Recommend the narrator-facing usage section to the coordinator; do not write frontend files yourself."
  }
  if (id === "image" || domain === "image") {
    return "If image generation/includes are enabled and the opening setup has a concrete visual asset worth preparing, save it under story/includes/ and recommend positive embed guidance to the coordinator. Do not hand off raw source URLs."
  }
  return `Seed or revise story/${domain || id}/ with the durable initialization material your Agent Card owns, then hand coordinator-facing implications to story-init.`
}

function compact(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`
}
