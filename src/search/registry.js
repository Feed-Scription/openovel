import { settingsEnv } from "../config/settings.js"
import { builtinWebSearchProviders } from "./providers/builtin.js"

export const DEFAULT_WEBSEARCH_PROVIDER = "duckduckgo-html"
export const DEFAULT_WEBSEARCH_PROVIDER_ORDER = [
  "duckduckgo-html",
  "custom-http-search",
  "kimi-search-service",
  "exa-mcp",
  "parallel-mcp",
]

export class WebSearchProviderRegistry {
  #providers = new Map()

  constructor(providers = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider) {
    if (!provider?.id) throw new Error("Web search provider must have an id")
    if (typeof provider.search !== "function") throw new Error(`Web search provider ${provider.id} must have search()`)
    this.#providers.set(provider.id, normalizeProvider(provider))
    return provider
  }

  get(id) {
    return this.#providers.get(id)
  }

  all() {
    return [...this.#providers.values()]
  }

  resolve({ id, env = settingsEnv() } = {}) {
    const provider = this.get(id || DEFAULT_WEBSEARCH_PROVIDER) || this.get(DEFAULT_WEBSEARCH_PROVIDER)
    return resolveProvider(provider, env)
  }

  route({ env = settingsEnv() } = {}) {
    const primaryId = env.OPENOVEL_WEBSEARCH_PROVIDER || DEFAULT_WEBSEARCH_PROVIDER
    const configuredOrder = splitList(env.OPENOVEL_WEBSEARCH_PROVIDER_ORDER)
    const order = unique([primaryId, ...(configuredOrder.length ? configuredOrder : DEFAULT_WEBSEARCH_PROVIDER_ORDER)])
    return order.map((id) => this.get(id)).filter(Boolean).map((provider) => resolveProvider(provider, env))
  }

  async search({ query, limit = 10, provider: providerId, timeoutSeconds, env = settingsEnv() } = {}) {
    const candidates = providerId ? [this.resolve({ id: providerId, env })] : this.route({ env })
    const provider = candidates.find((item) => item.configured) || candidates[0]
    if (!provider?.configured) {
      throw new Error(
        `No configured web search provider. Set OPENOVEL_WEBSEARCH_PROVIDER plus the provider credentials. Tried: ${candidates.map((item) => item.id).join(", ") || "none"}.`,
      )
    }
    const max = Math.max(1, Math.min(20, Number(limit) || 10))
    const results = await provider.search(provider, {
      query: String(query || "").trim(),
      limit: max,
      timeoutSeconds,
    })
    return {
      provider: publicWebSearchProviderInfo(provider),
      query,
      results: results.slice(0, max),
    }
  }

  diagnose({ env = settingsEnv() } = {}) {
    return {
      defaultProvider: DEFAULT_WEBSEARCH_PROVIDER,
      providerOrder: splitList(env.OPENOVEL_WEBSEARCH_PROVIDER_ORDER).length
        ? splitList(env.OPENOVEL_WEBSEARCH_PROVIDER_ORDER)
        : DEFAULT_WEBSEARCH_PROVIDER_ORDER,
      active: this.route({ env }).map(publicWebSearchProviderInfo),
      providers: this.all().map((provider) => publicWebSearchProviderInfo(resolveProvider(provider, env))),
    }
  }
}

export const webSearchProviderRegistry = new WebSearchProviderRegistry(builtinWebSearchProviders)

export function registerWebSearchProvider(provider) {
  return webSearchProviderRegistry.register(provider)
}

export function publicWebSearchProviderInfo(config) {
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    billingMode: config.billingMode,
    baseUrl: config.baseUrl,
    keyConfigured: config.keyConfigured,
    keyEnv: config.keyEnv,
    configured: config.configured,
    model: config.model,
  }
}

function normalizeProvider(provider) {
  return {
    kind: "http-json",
    billingMode: "unknown",
    apiKeyEnv: [],
    baseUrlEnv: [],
    modelEnv: [],
    auth: { type: "bearer" },
    baseUrl: "",
    defaultModel: "",
    headers: {},
    configured: (config) => Boolean(config.baseUrl),
    ...provider,
  }
}

function resolveProvider(provider, env) {
  if (!provider) throw new Error("Unknown web search provider")
  const apiKeyLookup = firstEnv(env, provider.apiKeyEnv)
  const baseUrl = firstEnv(env, provider.baseUrlEnv)?.value || provider.baseUrl
  const modelLookup = firstEnv(env, provider.modelEnv)
  const config = {
    ...provider,
    env,
    baseUrl,
    model: modelLookup?.value || provider.defaultModel || "",
    apiKey: apiKeyLookup?.value || "",
    keyEnv: apiKeyLookup?.name || first(provider.apiKeyEnv),
    keyConfigured: Boolean(apiKeyLookup?.value),
  }
  config.headers = buildHeaders(config, config.apiKey)
  config.configured = Boolean(provider.configured?.(config))
  return config
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

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function first(value) {
  return Array.isArray(value) ? value[0] : value
}
