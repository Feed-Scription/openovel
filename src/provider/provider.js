import { createChatCompletion, createChatMessage } from "./openaiCompatible.js"
import { createAnthropicMessage } from "./anthropic.js"
import { adaptChatRequestToCapabilities, resolveProviderCapabilities } from "./capabilities.js"
import { providerRegistry, publicProviderInfo, registerProvider as registerProviderPlugin } from "./registry.js"
import { recordModelCall } from "../telemetry/usageProfile.js"
import { recordRawCall } from "../telemetry/callRecorder.js"
import { settingsEnv } from "../config/settings.js"
import { listModelProfiles, profileThinkingHint, resolveModelProfile } from "./modelProfiles.js"

const semaphores = new Map()

// Two loops, two retry budgets. Foreground calls (narration / options / signal)
// are latency-sensitive and sit in front of a provider fallback chain, so a slow
// or dead provider must fail over fast rather than burn the long background
// budget first. Background agents hold accumulated state, so they keep the
// default budget (createChatMessage's 8 attempts, ~2 min) to ride out a blip.
// An explicit caller maxAttempts (e.g. the connection test's 1) always wins.
const FOREGROUND_MAX_ATTEMPTS = 2

export function providerConfig({ role = "foreground" } = {}) {
  const route = providerRegistry.route({ role })
  return route[0]
}

export function providerRoute({ role = "foreground", providerId = "" } = {}) {
  return providerRegistry.route({ role, providerId })
}

export function hasModelKey({ role = "foreground", providerId = "", modelProfile = "" } = {}) {
  const profile = modelProfile ? resolveModelProfile(modelProfile) : null
  const pinnedProvider = providerId || (profile?.providerPinned ? profile.provider?.id : "")
  return providerRoute({ role: profile?.role || role, providerId: pinnedProvider }).some((provider) => provider.keyConfigured)
}

export function modelInfo() {
  const foreground = selectUsableProvider("foreground")
  const background = selectUsableProvider("background")
  const env = settingsEnv()
  const fallbackAllowed = ["1", "true", "yes", "on"].includes(
    String(env.AI_ALLOW_PAID_FALLBACK || "").toLowerCase(),
  )

  return {
    provider: foreground.id,
    providerName: foreground.name,
    kind: foreground.kind,
    billingMode: foreground.billingMode,
    baseUrl: foreground.baseUrl,
    foreground: foreground.model,
    background: background.model,
    foregroundProvider: publicProviderInfo(foreground),
    backgroundProvider: publicProviderInfo(background),
    modelProfiles: listModelProfiles({ env }),
    keyConfigured: foreground.keyConfigured,
    backgroundKeyConfigured: background.keyConfigured,
    paidFallbackAllowed: fallbackAllowed,
  }
}

export function diagnoseProviders() {
  const env = settingsEnv()
  return {
    ...providerRegistry.diagnose({ env }),
    modelProfiles: listModelProfiles({ env }),
  }
}

export async function chatCompletion(options) {
  const message = await chatMessage(options)
  return message.content?.trim() || ""
}

export async function chatMessage(options = {}) {
  const {
    messages,
    model,
    role,
    tools,
    toolChoice,
    temperature,
    maxTokens,
    json = false,
  // undefined defers to createChatMessage's DEFAULT_TIMEOUT_MS
  // (300_000ms, opencode-aligned). The previous hard 18s default was the
  // silent cause of long reasoning generations aborting. Callers who need
  // a shorter timeout (e.g. eval player picking a turn) still override.
    timeoutMs,
    chunkTimeoutMs,
    stream = false,
    onDelta,
    modelProfile = role,
  // Force thinking OFF for this call regardless of provider/model defaults.
  // Used by the narrator: prose runs on the large model but must stay
  // non-thinking even if the user picked a thinking model.
    disableThinking = false,
  // Diagnostic callers (Settings → Test connection) want a single attempt
  // so transient failures surface immediately rather than being hidden
  // behind 30s of exponential backoff. Default undefined → use the
  // standard 5-attempt policy.
    maxAttempts,
  // Pin this call to ONE provider (no fallback). Used by the connection test
  // so the error reflects the active provider the user is testing, instead of
  // walking the fallback chain and reporting unrelated providers' errors.
    providerId = "",
  } = options
  const profile = resolveModelProfile(modelProfile || role || "foreground")
  const effectiveRole = role || profile.role || "foreground"
  const effectiveModel = model ?? (profile.modelPinned ? profile.model : "")
  const effectiveModelProfile = modelProfile || profile.id || effectiveRole
  const effectiveTemperature = temperature ?? profile.temperature ?? 0.8
  const effectiveMaxTokens = maxTokens ?? profile.maxTokens ?? 700
  const effectiveTimeoutMs = timeoutMs ?? profile.timeoutMs
  const effectiveChunkTimeoutMs = chunkTimeoutMs ?? profile.chunkTimeoutMs
  // Foreground fails over fast; background keeps the long budget (see above).
  const effectiveMaxAttempts = maxAttempts ?? (effectiveRole === "foreground" ? FOREGROUND_MAX_ATTEMPTS : undefined)
  // An explicit caller pin wins over the profile's pin; either restricts the
  // route to a single provider (registry returns no fallback for a pin).
  const pinnedProvider = providerId || (profile.providerPinned ? profile.provider?.id : "")
  // Resolve the thinking preference for this call: an explicit disableThinking
  // override wins; otherwise the model profile / role decides (agents on,
  // fast single-shot calls off — see profileThinkingHint). Passed as a hint to
  // the provider bodyTransform, which applies it with the correct shape.
  const thinking = disableThinking ? "disabled" : profileThinkingHint(effectiveModelProfile)
  const route = providerRoute({ role: effectiveRole, providerId: pinnedProvider }).filter((provider) => provider.keyConfigured)
  if (!route.length) {
    const first = providerRoute({ role: effectiveRole, providerId: pinnedProvider })[0] || providerConfig({ role: effectiveRole })
    throw new Error(
      `Missing provider API key for ${first.name}. Set ${first.keyEnv || "the provider API key env var"}.`,
    )
  }

  const errors = []
  for (let index = 0; index < route.length; index++) {
    const config = route[index]
    // The pinned/explicit model names a model in the PRIMARY provider's
    // namespace (route[0]): an AI_*_MODEL cost-tier env pin or an explicit
    // caller model. Fallback providers use different model names, so each keeps
    // its own registry-resolved default (config.model) instead of inheriting
    // route[0]'s model. Forwarding the primary's model to a fallback makes it
    // reject an unknown model (a custom-openai "gpt-5.5" pin landing on the
    // deepseek fallback 400s) and silently kills the failover.
    const providerModel = index === 0 && effectiveModel ? effectiveModel : config.model
    try {
      const request = adaptChatRequestToCapabilities(config, {
        tools,
        toolChoice,
        temperature: effectiveTemperature,
        maxTokens: effectiveMaxTokens,
        json,
        stream,
      })
      // Dispatch by wire format: anthropic providers translate through the
      // Anthropic Messages adapter; everything else uses the OpenAI client.
      // Both take the same options and return an OpenAI-style message.
      const send = config.kind === "anthropic" ? createAnthropicMessage : createChatMessage
      // Does the resolved model accept image input? Adapters strip image parts
      // for non-vision models so the request still runs (text-only).
      const resolvedCaps = resolveProviderCapabilities(config, { model: providerModel, role: effectiveRole })
      const imageInput = Array.isArray(resolvedCaps?.modalities?.input) && resolvedCaps.modalities.input.includes("image")
      const message = await withProviderSlot(config, () =>
        send({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: providerModel,
          messages,
          imageInput,
          tools: request.tools,
          toolChoice: request.toolChoice,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          json: request.json,
          timeoutMs: effectiveTimeoutMs,
          chunkTimeoutMs: effectiveChunkTimeoutMs,
          path: config.path,
          headers: config.headers,
          maxTokensField: request.maxTokensField,
          bodyTransform: config.bodyTransform,
          thinking,
          stream: request.stream,
          streamOptions: request.streamOptions,
          onDelta,
          maxAttempts: effectiveMaxAttempts,
          // Role-aware mid-stream stall recovery: the foreground narrator has
          // already shown its prose to the reader, so it resumes from the
          // breakpoint ("断点续写") rather than restarting; background agents only
          // stream progress/telemetry, so they retry the whole call from scratch.
          streamRecovery: effectiveRole === "foreground" ? "continue" : "retry",
        }),
      )
      recordModelCall({
        role: effectiveRole,
        modelProfile: effectiveModelProfile,
        provider: config.id,
        model: providerModel,
        telemetry: message._apiTelemetry,
        ok: true,
      })
      // Opt-in raw call dump (OPENOVEL_RECORD_CALLS). Fire-and-forget so it
      // never adds latency to the foreground narrator path. Captures the exact
      // request (messages incl. system + the adapted tool schemas) and the full
      // response — the one place verbatim input->output pairs are persisted.
      void recordRawCall({
        role: effectiveRole,
        modelProfile: effectiveModelProfile,
        provider: config.id,
        model: providerModel,
        params: {
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          json: request.json,
          stream: request.stream,
        },
        messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        message,
        telemetry: message._apiTelemetry,
      })
      return message
    } catch (error) {
      recordModelCall({
        role: effectiveRole,
        modelProfile: effectiveModelProfile,
        provider: config.id,
        model: providerModel,
        telemetry: { durationMs: 0, usage: {} },
        ok: false,
        error: error.message || String(error),
      })
      errors.push(formatProviderError(config, error))
    }
  }
  throw new Error(errors.join("\n"))
}

export function registerProvider(idOrProvider, config) {
  if (typeof idOrProvider === "string") {
    return registerProviderPlugin({
      id: idOrProvider,
      kind: "openai-compatible",
      ...config,
    })
  }
  return registerProviderPlugin(idOrProvider)
}

function selectUsableProvider(role) {
  const route = providerRoute({ role })
  return route.find((provider) => provider.keyConfigured) || route[0]
}

function formatProviderError(config, error) {
  const message = error?.message || String(error)
  const status = error?.status || matchStatus(message)
  const hint = status ? config.errorHints?.[status] : ""
  return `[${config.id}] ${message}${hint ? `\nHint: ${hint}` : ""}`
}

function matchStatus(message) {
  const match = String(message || "").match(/\b([1-5][0-9]{2})\b/)
  return match ? Number(match[1]) : null
}

async function withProviderSlot(config, task) {
  const semaphore = getSemaphore(config.id, config.concurrency)
  await semaphore.acquire()
  try {
    return await task()
  } finally {
    semaphore.release()
  }
}

function getSemaphore(id, limit) {
  const max = Math.max(1, Number(limit) || 1)
  const existing = semaphores.get(id)
  if (existing && existing.max === max) return existing
  const semaphore = createSemaphore(max)
  semaphores.set(id, semaphore)
  return semaphore
}

function createSemaphore(max) {
  let active = 0
  const queue = []
  return {
    max,
    async acquire() {
      if (active < max) {
        active++
        return
      }
      await new Promise((resolve) => queue.push(resolve))
      active++
    },
    release() {
      active = Math.max(0, active - 1)
      const next = queue.shift()
      if (next) next()
    },
  }
}

// Image generation (separate, configurable OpenAI-images-compatible endpoint).
export { generateImageBytes as imageGeneration, hasImageGenerationConfig, hasImageKey } from "./imageGeneration.js"

// Music providers (separate registry; resolution short-id → stream lives in the
// privileged Electron-main resolver, never here).
export { musicProviderRegistry, hasMusicAuth, isMusicConfigured } from "../music/registry.js"

export * as Provider from "./provider.js"
