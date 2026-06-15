import { parseJsonObject } from "../lib/json.js"
import { applyStorykeeperPatch, getStorySnapshot, paths, recordSceneEvent } from "../lib/storyStore.js"
import { getMemorySnapshot } from "../memory/memoryStore.js"
import {
  drainStorykeeperMessages,
  enqueueStorykeeperMessage,
  markStorykeeperMessagesForTurnInjected,
  renderStorykeeperQueuedMessages,
} from "../runtime/agentMessageQueue.js"
import { drainAgentMessages, markAgentMessagesForTurnInjected } from "../runtime/agentChannel.js"
import { normalizeStorykeeperEnvelope } from "./storykeeperEnvelope.js"
import { compactText } from "./storykeeperEnvelopeHelpers.js"
import { buildTicReports } from "../lib/ngramStore.js"
import { resolveActiveStoryMode } from "../lib/storyDirectory.js"
import {
  buildStorykeeperTurnContext,
  renderStorykeeperTurnContextMarkdown,
  storykeeperSystemPrompt,
} from "./storykeeperContext.js"
import { createResidentAgent } from "./residentAgent.js"

// The Storykeeper is now just the resident-agent scaffold (residentAgent.js)
// specialized with the story-maintenance config: its own thread/inbox, the
// storykeeper system prompt, the durable-memory + tic + recent-canon turn
// context, and the envelope-apply pipeline. Thread/inbox lifecycle, message
// framing, and result handoff are owned by the scaffold.
// Builds the Storykeeper / Showrunner composition agent. Defaults reproduce the
// legacy single-Storykeeper (id "storykeeper", storykeeper thread/queue). The
// resident-team launcher passes opts to make it the Showrunner: id "showrunner",
// the showrunner prompt, its own thread, and draining its channel inbox instead
// of the legacy storykeeper queue.
export function createStorykeeperAgent(opts = {}) {
  const id = opts.id || "storykeeper"
  const systemPromptFn = opts.systemPrompt || storykeeperSystemPrompt
  const threadPath = opts.threadPath || paths.storykeeperThread
  const drainAgent = opts.drainAgent || null
  return createResidentAgent({
    id,
    kind: "story-maintenance-agent",
    modelProfile: opts.modelProfile || "storykeeper",
    // Expanded budget: 4 → 75 maxSteps, 900 → 16000 maxTokens. The actual
    // safety bound for the slow loop is wallclock + cost, not step count.
    maxSteps: opts.maxSteps || 75,
    maxTokens: opts.maxTokens || 16000,
    temperature: opts.temperature ?? 0.35,
    toolConcurrency: opts.toolConcurrency || 4,
    includeTools: opts.includeTools,
    threadPath,
    threadSource: id,

    systemPrompt: () => systemPromptFn(),

    async prepare({ input }) {
      if (drainAgent) {
        await markAgentMessagesForTurnInjected(input.turnId, {
          agent: drainAgent,
          sources: ["runtime"],
          types: ["reader_action", "narration_generated"],
        }).catch(() => {})
      } else {
        await markStorykeeperMessagesForTurnInjected(input.turnId, { reason: "included-in-storykeeper-turn-context" })
      }
    },

    async buildContext({ input, registry }) {
      const snapshot = await getStorySnapshot()
      // USER.md + story memory (~/.openovel/memory/*) must constrain storykeeper
      // too. Tolerate failure — memory is a soft input.
      const memorySnapshot = await getMemorySnapshot().catch(() => ({ user: "", memory: "", references: "" }))
      // Incremental tic surveillance: fold only the prose appended since the last
      // run into the persisted counts store, then rank. Advisory — tolerate I/O hiccups.
      const ticReports = await buildTicReports({
        chaptersPath: paths.chapters,
        storePath: paths.ngramStore,
        windowText: snapshot.chapters || "",
        ticPatternsText: process.env.OPENOVEL_NARRATOR_TIC_PATTERNS || "",
      }).catch(() => ({ repeatedNgrams: null, ticPatternMatches: null }))
      // Per-story pacing mode (fast/comic), re-resolved here because the slow
      // loop takes its own fresh snapshot: the session processor's per-turn
      // resolution never reaches this workflow.
      const storyMode = await resolveActiveStoryMode().catch(() => "")
      const contextMarkdown = renderStorykeeperTurnContextMarkdown(
        buildStorykeeperTurnContext({
          action: input.action,
          foreground: input.foreground,
          backgroundSignal: input.backgroundSignal,
          snapshot,
          memorySnapshot,
          registry,
          repeatedNgrams: ticReports.repeatedNgrams,
          ticPatternMatches: ticReports.ticPatternMatches,
          tensionTrajectory: snapshot.recentTensions,
          storyMode,
        }),
      )
      return { snapshot, contextMarkdown, expectedStoryRoot: paths.root }
    },

    async normalize(rawContent, { input, snapshot }) {
      return normalizeStorykeeperEnvelope(parseJsonObject(rawContent, {}), {
        turnId: input.turnId,
        action: input.action,
        foreground: input.foreground,
        snapshot,
      })
    },

    async apply(normalized, { expectedStoryRoot, input }) {
      const applied = await applyStorykeeperPatch(normalized, { expectedStoryRoot })
      // Envelope-application discards (FG markdown truncated, arrays capped,
      // stale/empty patch) are NOT a tool call, so they can't ride a tool result
      // this turn. Push them back into the loop so the NEXT iteration sees them
      // DIRECTLY (rendered as <previous_envelope_feedback>) — PROVENANCE is an
      // audit archive, not a feedback channel the model is required to read.
      const applyWarnings = [
        ...(normalized.warnings || []),
        ...(applied.skipped ? [`Previous envelope was skipped (${applied.reason || "stale"}); its changes were NOT applied.`] : []),
      ]
      if (applyWarnings.length) {
        await enqueueStorykeeperMessage({
          type: "apply_feedback",
          priority: "now",
          source: "runtime",
          turnId: input.turnId,
          payload: { warnings: applyWarnings },
        }).catch(() => {})
      }
      await recordSceneEvent({
        type: applied.skipped ? "background_patch_skipped_stale" : "background_patch",
        turnId: normalized.turnId,
        workflow: "storykeeper",
        patch: normalized,
        foregroundGuidance: applied.foregroundGuidance,
        reason: applied.reason,
        currentTurnId: applied.currentTurnId,
      })
      return applied
    },

    async fallback({ input, snapshot }) {
      return JSON.stringify({
        status: "applied",
        summary: `Fallback Storykeeper noted reader action: ${input.action}`,
        foregroundGuidanceMarkdown: fallbackForegroundGuidanceMarkdown(input),
        filesChanged: [
          {
            path: "story/guidance/FOREGROUND.md",
            purpose: "fallback foreground working-set refresh",
            provenance: [input.turnId, "foreground_turn"],
          },
        ],
        inboxResolved: (snapshot.backgroundInboxItems || []).map((item) => item.id),
        inboxNotes: ["Fallback Storykeeper merged visible inbox items into the rendered foreground guidance."],
      })
    },

    async drainQueuedContext({ input, bus }) {
      const messages = drainAgent
        ? await drainAgentMessages({ agent: drainAgent, bus })
        : await drainStorykeeperMessages({ excludeTurnIds: [input.turnId], bus })
      return messages.length ? [{ role: "user", content: renderStorykeeperQueuedMessages(messages) }] : []
    },

    async onEvent(type, payload) {
      await recordSceneEvent({
        type,
        workflow: "storykeeper",
        ...payload,
      })
    },

    traceInput(input) {
      return {
        turnId: input.turnId,
        action: input.action,
        backgroundSignalTasks: input.backgroundSignal?.tasks?.length || 0,
      }
    },

    traceOutput(patch) {
      return {
        status: patch.status,
        summary: patch.summary,
        filesChanged: patch.filesChanged?.map((file) => file.path),
        warnings: patch.warnings,
        needsFollowup: patch.needsFollowup,
        inboxResolved: patch.inboxResolved,
        inboxDeferred: patch.inboxDeferred,
        inboxRejected: patch.inboxRejected,
      }
    },
  })
}

export function createStorykeeperWorkflow() {
  return createStorykeeperAgent()
}

export { normalizeStorykeeperEnvelope, normalizePatch } from "./storykeeperEnvelope.js"

function fallbackForegroundGuidanceMarkdown(input = {}) {
  return [
    "# Foreground Guidance",
    "",
    "This Markdown file is the small working set for the fast foreground narrator. It is intentionally plain text: editable, grep-able, and replaceable.",
    "",
    "## Tone",
    "",
    "- Continue in the language and style implied by reader input and durable preferences.",
    "",
    "## Scene",
    "",
    "- Scene: infer from recent canon and reader action.",
    "",
    "## Constants",
    "",
    `- Reader action at ${input.turnId || "current turn"} must be reflected: ${compactText(input.action, 220) || "-"}`,
    "",
    "## Open Threads",
    "",
    "- Keep consequences of the latest reader action visible until resolved.",
  ].join("\n")
}
