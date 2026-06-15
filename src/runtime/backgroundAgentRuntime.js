import { hasModelKey } from "../provider/provider.js"
import { resolveModelProfile } from "../provider/modelProfiles.js"
import { isAgentRunResult, normalizeBackgroundAgentPack } from "./agentPack.js"
import { runToolLoop } from "./toolLoop.js"

export class BackgroundAgentRuntime {
  constructor({ registry, bus, role = "background" }) {
    this.registry = registry
    this.bus = bus
    this.role = role
  }

  async run({
    agent,
    workflow,
    input = {},
    model,
    maxSteps,
    toolConcurrency,
    includeDangerous,
    temperature,
    maxTokens,
    json,
    toolResultWindow,
    assistantArgsWindow,
    context = {},
  }) {
    const pack = normalizeBackgroundAgentPack(agent || workflow)

    const startedAt = new Date().toISOString()
    const modelProfile = resolveModelProfile(pack.modelProfile || this.role)
    const runContext = await pack.buildInitialMessages({
      input,
      registry: this.registry,
      bus: this.bus,
      context,
    })

    const trace = {
      agent: pack.id,
      workflow: pack.id,
      agentKind: pack.kind,
      legacyWorkflow: pack.legacyWorkflow,
      turnId: input.turnId,
      startedAt,
      input: pack.traceInput?.(input) || input,
      modelProfile: {
        id: modelProfile.id,
        role: modelProfile.role,
        model: model || modelProfile.model,
        provider: modelProfile.provider?.id,
        costTier: modelProfile.costTier,
      },
    }
    await pack.onEvent?.("background_agent_started", trace)
    this.bus?.publish?.("background.agent.started", trace)

    try {
      const raw = hasModelKey({
        role: modelProfile.role,
        modelProfile: modelProfile.id,
        providerId: modelProfile.providerPinned ? modelProfile.provider?.id : "",
      }) && pack.forceFallback !== true
        ? await runToolLoop({
            role: modelProfile.role,
            model: model || modelProfile.model,
            modelProfile: modelProfile.id,
            registry: this.registry,
            bus: this.bus,
            messages: runContext.messages,
            context: {
              ...context,
              ...(runContext.context || {}),
              agent: pack.id,
              workflow: pack.id,
              turnId: input.turnId,
            },
            maxSteps: maxSteps ?? pack.maxSteps ?? 4,
            toolConcurrency: toolConcurrency ?? pack.toolConcurrency ?? 4,
            includeDangerous: includeDangerous ?? pack.includeDangerous ?? false,
            // Foreground/interactive-only tools that make no sense in a
            // background pack: `ask_user` pauses for a chat-pane response
            // (background packs have no watching user, so it would just hang),
            // and `preview_narration` / `preview_options` run the live FG narrator
            // (+ options generator) — the slow loop must never drive them (that's
            // the foreground budget). Default-exclude all unless the pack's own
            // includeTools whitelist opts in; the conversational init agent is an
            // agent pack too, and opts in via its config when it needs them.
            excludeTools: (() => {
              const foregroundOnly = ["ask_user", "preview_narration", "preview_options"]
              const whitelisted = new Set(pack.includeTools || [])
              const dropped = foregroundOnly.filter((id) => !whitelisted.has(id))
              return [...new Set([...(pack.excludeTools || []), ...dropped])]
            })(),
            includeTools: pack.includeTools,
            temperature: temperature ?? pack.temperature ?? 0.35,
            maxTokens: maxTokens ?? pack.maxTokens ?? 900,
            json: json ?? pack.json ?? true,
            toolResultWindow: toolResultWindow ?? pack.toolResultWindow,
            assistantArgsWindow: assistantArgsWindow ?? pack.assistantArgsWindow,
            drainQueuedContext: typeof pack.drainQueuedContext === "function"
              ? (args) => pack.drainQueuedContext({
                  ...args,
                  input,
                  runContext,
                  registry: this.registry,
                  bus: this.bus,
                })
              : undefined,
          })
        : await fallbackRun({ pack, input, runContext, registry: this.registry, bus: this.bus })

      const handled = await pack.handleResult({
        input,
        context: runContext,
        raw,
        registry: this.registry,
        bus: this.bus,
      })
      const output = isAgentRunResult(handled) ? handled.output : handled
      const traceOutput = isAgentRunResult(handled) ? handled.trace : output
      const completed = {
        agent: pack.id,
        workflow: pack.id,
        agentKind: pack.kind,
        legacyWorkflow: pack.legacyWorkflow,
        turnId: input.turnId,
        startedAt,
        completedAt: new Date().toISOString(),
        steps: raw.steps,
        normalized: pack.traceOutput?.(traceOutput) || traceOutput,
      }
      await pack.onEvent?.("background_agent_completed", completed)
      this.bus?.publish?.("background.agent.completed", completed)
      return output
    } catch (error) {
      const failed = {
        agent: pack.id,
        workflow: pack.id,
        agentKind: pack.kind,
        legacyWorkflow: pack.legacyWorkflow,
        turnId: input.turnId,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error.message || String(error),
      }
      await pack.onEvent?.("background_agent_error", failed)
      this.bus?.publish?.("background.agent.error", failed)
      throw error
    }
  }
}

async function fallbackRun({ pack, input, runContext, registry, bus }) {
  const content = await pack.fallback?.({ input, context: runContext, registry, bus })
  return {
    content,
    messages: runContext.messages.concat({ role: "assistant", content: content || "" }),
    steps: 0,
  }
}
