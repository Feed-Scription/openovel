import { settingsEnv } from "../config/settings.js"

export const DEFAULT_MEMORY_PROVIDER = "file-markdown"

export class MemoryProviderRegistry {
  #providers = new Map()

  constructor(providers = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider) {
    if (!provider?.id) throw new Error("Memory provider must have an id")
    for (const method of ["snapshot", "add", "replace", "remove"]) {
      if (typeof provider[method] !== "function") {
        throw new Error(`Memory provider ${provider.id} must have ${method}()`)
      }
    }
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
    const providerId = id || env.OPENOVEL_MEMORY_PROVIDER || DEFAULT_MEMORY_PROVIDER
    const provider = this.get(providerId) || this.get(DEFAULT_MEMORY_PROVIDER)
    if (!provider) throw new Error(`Unknown memory provider: ${providerId}`)
    return resolveProvider(provider, env)
  }

  diagnose({ env = settingsEnv() } = {}) {
    return {
      defaultProvider: DEFAULT_MEMORY_PROVIDER,
      active: publicMemoryProviderInfo(this.resolve({ env })),
      providers: this.all().map((provider) => publicMemoryProviderInfo(resolveProvider(provider, env))),
    }
  }
}

export const memoryProviderRegistry = new MemoryProviderRegistry()

export function registerMemoryProvider(provider) {
  return memoryProviderRegistry.register(provider)
}

export function publicMemoryProviderInfo(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    storage: provider.storage,
    configured: provider.configured,
    writable: provider.capabilities?.write !== false,
    topics: provider.capabilities?.topics !== false,
    scopes: provider.scopes || [],
  }
}

function normalizeProvider(provider) {
  return {
    kind: "file-native",
    storage: "markdown",
    scopes: ["story", "user", "references"],
    capabilities: {
      read: true,
      write: true,
      topics: true,
      grepFriendly: true,
      userEditable: true,
    },
    configured: () => true,
    ...provider,
  }
}

function resolveProvider(provider, env) {
  const resolved = {
    ...provider,
    env,
  }
  resolved.configured = Boolean(provider.configured?.(resolved))
  return resolved
}
