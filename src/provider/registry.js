import { builtinProviders } from "./plugins/index.js"
import { normalizeCapabilities, publicCapabilities, resolveProviderCapabilities } from "./capabilities.js"
import { settingsEnv } from "../config/settings.js"
import { CUSTOM_PROVIDERS_ENV, customProviderSpec, isCustomProviderId, normalizeCustomProvidersList } from "./customProviders.js"

export const DEFAULT_PROVIDER = "kimi-code"
export const DEFAULT_PROVIDER_ORDER = ["kimi-code", "mimo-token-plan-sgp", "mimo-token-plan-cn", "mimo-token-plan-ams"]

export class ProviderRegistry {
  #providers = new Map()
  #dynamicIds = new Set()
  #dynamicSignature = ""

  constructor(providers = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider) {
    if (!provider?.id) throw new Error("Provider must have an id")
    this.#providers.set(provider.id, normalizeProvider(provider))
    return provider
  }

  // Re-sync user-defined custom providers from OPENOVEL_CUSTOM_PROVIDERS
  // (emitted by settingsToEnv / the Electron settings store). Called on every
  // resolve/route/diagnose/all so additions, edits, and deletions made in
  // Settings apply on the next request without a restart. The raw env string
  // doubles as a change signature so the common no-change case is one string
  // compare.
  syncCustomProviders(env = settingsEnv()) {
    const raw = String(env?.[CUSTOM_PROVIDERS_ENV] || "")
    if (raw === this.#dynamicSignature) return
    this.#dynamicSignature = raw
    const entries = normalizeCustomProvidersList(raw)
    const nextIds = new Set(entries.map((entry) => entry.id))
    for (const id of this.#dynamicIds) {
      if (!nextIds.has(id)) this.#providers.delete(id)
    }
    for (const entry of entries) this.register(customProviderSpec(entry))
    this.#dynamicIds = nextIds
  }

  get(id) {
    return this.#providers.get(id)
  }

  all(env = settingsEnv()) {
    this.syncCustomProviders(env)
    return [...this.#providers.values()]
  }

  resolve({ id, role = "foreground", env = settingsEnv() } = {}) {
    this.syncCustomProviders(env)
    const provider = this.get(id || DEFAULT_PROVIDER) || this.get(DEFAULT_PROVIDER)
    return resolveProvider(provider, role, env)
  }

  route({ role = "foreground", env = settingsEnv(), providerId = "" } = {}) {
    this.syncCustomProviders(env)
    // Three modes for resolving the provider chain:
    //
    // 1. User pinned a specific provider (AI_PROVIDER or AI_*_PROVIDER set):
    //    return ONLY that provider — no silent fallback. Connection failures
    //    must surface as visible errors so the user can fix the network /
    //    key / model name, instead of unknowingly running on a different
    //    provider with different cost and behavior.
    //
    // 2. User configured an explicit chain (AI_PROVIDER_ORDER set):
    //    walk that exact list.
    //
    // 3. Default — no pin, no chain: walk DEFAULT_PROVIDER_ORDER (the free
    //    tier providers that share quota patterns; quota-exhausted on one
    //    naturally tries the next). Paid providers stay filtered out unless
    //    AI_ALLOW_PAID_FALLBACK is true.
    const explicitProvider = providerId || (
      role === "background"
        ? env.AI_BACKGROUND_PROVIDER || env.AI_PROVIDER
        : env.AI_FOREGROUND_PROVIDER || env.AI_PROVIDER
    )
    const configuredOrder = splitList(env.AI_PROVIDER_ORDER)
    const allowPaidFallback = truthy(env.AI_ALLOW_PAID_FALLBACK)

    if (providerId) {
      const provider = this.get(providerId)
      return provider ? [resolveProvider(provider, role, env)] : []
    }

    if (explicitProvider && !configuredOrder.length) {
      const provider = this.get(explicitProvider)
      return provider ? [resolveProvider(provider, role, env)] : []
    }

    const order = unique([
      explicitProvider || DEFAULT_PROVIDER,
      ...(configuredOrder.length ? configuredOrder : DEFAULT_PROVIDER_ORDER),
    ])

    return order
      .map((id) => this.get(id))
      .filter(Boolean)
      .filter((provider, index) => {
        if (index === 0) return true
        return allowPaidFallback || provider.billingMode !== "pay-as-you-go"
      })
      .map((provider, index) => resolveProvider(provider, role, env, { isPrimary: index === 0 }))
  }

  diagnose({ env = settingsEnv() } = {}) {
    return {
      defaultProvider: DEFAULT_PROVIDER,
      providerOrder: splitList(env.AI_PROVIDER_ORDER).length ? splitList(env.AI_PROVIDER_ORDER) : DEFAULT_PROVIDER_ORDER,
      allowPaidFallback: truthy(env.AI_ALLOW_PAID_FALLBACK),
      foreground: this.route({ role: "foreground", env }).map(publicProviderInfo),
      background: this.route({ role: "background", env }).map(publicProviderInfo),
      providers: this.all(env).map((provider) => publicProviderInfo(resolveProvider(provider, "foreground", env))),
    }
  }
}

export const providerRegistry = new ProviderRegistry(builtinProviders)

export function registerProvider(provider) {
  return providerRegistry.register(provider)
}

export function publicProviderInfo(config) {
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    billingMode: config.billingMode,
    baseUrl: config.baseUrl,
    model: config.model,
    keyConfigured: config.keyConfigured,
    keyEnv: config.keyEnv,
    concurrency: config.concurrency,
    capabilities: publicCapabilities(config.capabilities),
  }
}

function normalizeProvider(provider) {
  const normalized = {
    kind: "openai-compatible",
    billingMode: "unknown",
    apiKeyEnv: [],
    baseUrlEnv: [],
    auth: { type: "bearer" },
    path: "/chat/completions",
    maxTokensField: "max_tokens",
    concurrency: 4,
    ...provider,
  }
  normalized.capabilities = normalizeCapabilities(normalized.capabilities, {
    request: {
      maxTokensField: normalized.maxTokensField,
    },
  })
  normalized.maxTokensField = normalized.capabilities.request.maxTokensField
  return normalized
}

function resolveProvider(provider, role, env, { isPrimary = true } = {}) {
  if (!provider) throw new Error("Unknown provider")
  // Operator-assigned display alias (Settings → API Keys → Model details).
  // Applied at resolve time so every surface that lists providers (preset
  // pills, Routing/Agents dropdowns, doctor output) shows the same label.
  const alias = providerAliases(env)[provider.id]
  const apiKeyLookup = firstEnv(env, provider.apiKeyEnv)
  const baseUrl = firstEnv(env, [
    ...(provider.baseUrlEnv || []),
    ...(provider.id === env.AI_PROVIDER ||
    provider.id === env.AI_FOREGROUND_PROVIDER ||
    provider.id === env.AI_BACKGROUND_PROVIDER
      ? ["AI_BASE_URL"]
      : []),
  ])?.value || provider.baseUrl

  // The global cost-tier model override (AI_SMALL_MODEL / AI_LARGE_MODEL) names
  // the model for the user's ACTIVE (primary) provider in this role, not every
  // provider in the fallback chain. Applying it to a fallback (e.g.
  // AI_SMALL_MODEL=gpt-5.5 landing on a DeepSeek fallback) makes that provider
  // 400 on a model it cannot serve, so the turn silently loses its fallback.
  // The primary is always route[0]; fallbacks keep their own defaultModel.
  //
  // Custom providers are EXEMPT: their model is the user-typed defaultModel /
  // defaultBackgroundModel on the entry, and the Settings UI never writes
  // AI_SMALL_MODEL/AI_LARGE_MODEL for them. So a global pin present while a
  // custom provider is active is always a leftover from a built-in provider
  // (e.g. AI_SMALL_MODEL=deepseek-v4-flash) and must not override the custom
  // endpoint's own model — that produced "Not supported model" 400s.
  const isCustom = isCustomProvider(provider)
  const modelLookup = isPrimary && !isCustom
    ? firstEnv(env, [role === "background" ? "AI_LARGE_MODEL" : "AI_SMALL_MODEL"])
    : null
  const model =
    modelLookup?.value ||
    (role === "background" ? provider.defaultBackgroundModel || provider.defaultModel : provider.defaultModel)

  // per-provider concurrency override. Default deepseek concurrency=4
  // is a bottleneck when one turn fires narrator + signal, then options +
  // context-card selection + storykeeper + memory-review close together.
  // Plugin sets concurrencyEnv (e.g. ["DEEPSEEK_CONCURRENCY"]); we also honor
  // a global OPENOVEL_PROVIDER_CONCURRENCY fallback. Integer-coerced and
  // floored to 1 to defang fat-fingered values.
  const concurrencyEnvNames = [...(provider.concurrencyEnv || []), "OPENOVEL_PROVIDER_CONCURRENCY"]
  const concurrencyLookup = firstEnv(env, concurrencyEnvNames)
  const concurrencyParsed = concurrencyLookup ? Number(concurrencyLookup.value) : NaN
  const concurrencyOverride =
    Number.isFinite(concurrencyParsed) && concurrencyParsed > 0 ? Math.max(1, Math.floor(concurrencyParsed)) : 0
  const resolved = {
    ...provider,
    name: alias || provider.name,
    role,
    baseUrl,
    model,
    apiKey: apiKeyLookup?.value || "",
    keyEnv: apiKeyLookup?.name || first(provider.apiKeyEnv),
    keyConfigured: Boolean(apiKeyLookup?.value),
    headers: buildHeaders(provider, apiKeyLookup?.value || ""),
    concurrency: concurrencyOverride || provider.concurrency,
  }
  resolved.capabilities = resolveProviderCapabilities(resolved, { model, role, env })
  resolved.maxTokensField = resolved.capabilities.request.maxTokensField
  return resolved
}

function buildHeaders(provider, apiKey) {
  const headers = { ...(provider.headers || {}) }
  if (!apiKey) return headers
  const auth = provider.auth || { type: "bearer" }
  if (auth.type === "api-key") {
    headers[auth.header || "api-key"] = apiKey
  } else if (auth.type === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

function firstEnv(env, names = []) {
  for (const name of names) {
    if (env[name]) return { name, value: env[name] }
  }
  return null
}

// A user-defined custom provider (either freshly synced — source:"custom" — or
// resolved by id shape). Used to exempt them from the global cost-tier pins.
export function isCustomProvider(provider) {
  return provider?.source === "custom" || isCustomProviderId(provider?.id)
}

// Parse OPENOVEL_PROVIDER_ALIASES ({ providerId: label }), memoized on the
// raw string so repeated resolves in one route don't re-parse.
let aliasCacheRaw = null
let aliasCache = {}
function providerAliases(env) {
  const raw = env?.OPENOVEL_PROVIDER_ALIASES || ""
  if (raw === aliasCacheRaw) return aliasCache
  aliasCacheRaw = raw
  aliasCache = {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed)) {
          const label = String(value || "").trim()
          if (label) aliasCache[id] = label
        }
      }
    } catch { /* invalid JSON → no aliases */ }
  }
  return aliasCache
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}

function first(value) {
  return Array.isArray(value) ? value[0] : value
}
