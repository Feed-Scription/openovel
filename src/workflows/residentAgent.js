import { agentRunResult } from "../runtime/agentPack.js"
import {
  appendStorykeeperThreadMessages,
  loadStorykeeperThread,
  maybeCompactStorykeeperThread,
  messagesToAppendAfterRun,
  storykeeperRunAppendStart,
} from "../runtime/storykeeperThread.js"

// The ONE resident-agent scaffold. Every background agent — the Showrunner
// coordinator and each specialized sub-agent (Card Manager, World Keeper,
// Director, Memory, Render Manager) — is the SAME code path, differing only in a
// `config` descriptor (its "Agent Card"): which tools it may use, which files it
// owns, and its system prompt. This module owns the run lifecycle ONCE: load +
// compact the agent's own conversation thread, assemble [system, thread,
// turn-context] messages, hand off to the tool loop (via BackgroundAgentRuntime),
// normalize + apply the result, and append the thread. Everything scope-specific
// is supplied by `config`, so there is a single implementation — not one per
// agent. (Generalized from the prior createStorykeeperAgent; the Storykeeper is
// now just createResidentAgent(storykeeperConfig).)
//
// config descriptor:
//   id, kind, modelProfile, json, maxSteps, maxTokens, temperature,
//   toolConcurrency, includeDangerous, includeTools?, excludeTools?,
//   threadPath (required), threadSource,
//   systemPrompt(): string,
//   async prepare?({ input, registry, bus }): void          — pre-build side effects
//   async buildContext({ input, registry, bus }):           — the turn-context message
//       → { snapshot, contextMarkdown, expectedStoryRoot?, extraContext? }
//   async normalize(rawContent, { input, snapshot }): normalized
//   async apply(normalized, { input, snapshot, expectedStoryRoot, raw, context, registry, bus }): applied
//   async fallback({ input, snapshot }): string (a JSON envelope)
//   drainQueuedContext?, onEvent?, traceInput?, traceOutput?
export function createResidentAgent(config) {
  if (!config || !config.id) throw new Error("createResidentAgent requires a config with an id")
  if (!config.threadPath) throw new Error(`resident agent ${config.id} requires a threadPath`)

  const agent = {
    id: config.id,
    kind: config.kind || "resident-agent",
    modelProfile: config.modelProfile || "storykeeper",
    json: config.json !== false,
    maxSteps: config.maxSteps ?? 75,
    maxTokens: config.maxTokens ?? 16000,
    temperature: config.temperature ?? 0.35,
    toolConcurrency: config.toolConcurrency ?? 4,
    includeDangerous: Boolean(config.includeDangerous),

    async buildInitialMessages({ input, registry, bus }) {
      await maybeCompactStorykeeperThread({ ledgerPath: config.threadPath, turnId: input.turnId })
      await config.prepare?.({ input, registry, bus })
      const thread = await loadStorykeeperThread({ ledgerPath: config.threadPath })
      const built = await config.buildContext({ input, registry, bus })
      const messages = [
        { role: "system", content: config.systemPrompt() },
        ...thread.messages,
        { role: "user", content: built.contextMarkdown },
      ]
      return {
        snapshot: built.snapshot,
        messages,
        // Sibling to snapshot so apply reads context.expectedStoryRoot. Binds the
        // run to the story it started on so a mid-run story switch can't clobber
        // the other story's files.
        expectedStoryRoot: built.expectedStoryRoot,
        context: {
          residentThreadAppendStart: storykeeperRunAppendStart(messages, thread.messages.length),
          residentThreadMessages: thread.messages.length,
          residentThreadBoundary: thread.boundary?.boundaryId || "",
          ...(built.extraContext || {}),
        },
      }
    },

    async fallback({ input, context }) {
      return config.fallback({ input, snapshot: context.snapshot })
    },

    async handleResult({ input, context, raw, registry, bus }) {
      const normalized = await config.normalize(raw.content, { input, snapshot: context.snapshot })
      const applied = await config.apply(normalized, {
        input,
        snapshot: context.snapshot,
        expectedStoryRoot: context.expectedStoryRoot,
        raw,
        context,
        registry,
        bus,
      })
      await appendStorykeeperThreadMessages(
        messagesToAppendAfterRun(raw.messages || [], context.context?.residentThreadAppendStart || 0),
        { ledgerPath: config.threadPath, turnId: input.turnId, source: config.threadSource || config.id },
      )
      return agentRunResult(applied, { trace: normalized })
    },

    async onEvent(type, payload) {
      await config.onEvent?.(type, payload)
    },

    traceInput(input) {
      return config.traceInput ? config.traceInput(input) : input
    },

    traceOutput(out) {
      return config.traceOutput ? config.traceOutput(out) : out
    },
  }

  if (config.includeTools) agent.includeTools = config.includeTools
  if (config.excludeTools) agent.excludeTools = config.excludeTools
  if (typeof config.drainQueuedContext === "function") {
    agent.drainQueuedContext = (args) => config.drainQueuedContext(args)
  }
  return agent
}
