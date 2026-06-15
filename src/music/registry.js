// Unified music-provider registry — the single routing point for music search /
// detail / play-url resolution, mirroring src/search/registry.js. Only NetEase
// (个人接入) is wired this pass; the registry stays generic so QQ Music / an
// aggregator slot in later by `register()`-ing another provider with the same
// interface.
//
// Provider interface:
//   { id, name, resolveConfig(env) -> config, configured(config) -> bool,
//     hasAuth(config) -> bool, search(config, {query,limit,fetchImpl}),
//     trackDetail(config, {trackId,fetchImpl}),
//     resolvePlayUrl(config, {trackId,fetchImpl}) -> {url}|null,
//     auth: { qrStart, qrPoll, refresh } }

import { settingsEnv } from "../config/settings.js"
import { neteaseProvider } from "./providers/netease.js"

export const DEFAULT_MUSIC_PROVIDER = "netease"

export class MusicProviderRegistry {
  #providers = new Map()

  constructor(providers = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider) {
    if (!provider?.id) throw new Error("Music provider must have an id")
    if (typeof provider.search !== "function") throw new Error(`Music provider ${provider.id} must have search()`)
    this.#providers.set(provider.id, provider)
    return provider
  }

  get(id) {
    return this.#providers.get(id)
  }

  all() {
    return [...this.#providers.values()]
  }

  // Resolve a provider + its env-derived config + configured/auth flags.
  resolve({ id, env = settingsEnv() } = {}) {
    const providerId = id || env.OPENOVEL_MUSIC_PROVIDER || DEFAULT_MUSIC_PROVIDER
    const provider = this.get(providerId) || this.get(DEFAULT_MUSIC_PROVIDER)
    if (!provider) throw new Error(`Unknown music provider: ${providerId}`)
    const config = provider.resolveConfig ? provider.resolveConfig(env) : { id: provider.id }
    return {
      provider,
      config,
      configured: Boolean(provider.configured ? provider.configured(config) : config),
      authorized: Boolean(provider.hasAuth ? provider.hasAuth(config) : false),
    }
  }

  #resolveOrThrow({ provider, env }) {
    const resolved = this.resolve({ id: provider, env })
    if (!resolved.configured) {
      throw new Error(
        `Music provider "${resolved.provider.id}" is not configured. Set OPENOVEL_MUSIC_CLIENT_ID (and a token via Settings → Music 扫码登录, or OPENOVEL_MUSIC_TOKEN).`,
      )
    }
    return resolved
  }

  async search({ query, limit = 8, provider, env = settingsEnv(), fetchImpl } = {}) {
    const resolved = this.#resolveOrThrow({ provider, env })
    const max = Math.max(1, Math.min(25, Number(limit) || 8))
    const results = await resolved.provider.search(resolved.config, { query: String(query || "").trim(), limit: max, fetchImpl })
    return { provider: resolved.provider.id, query, results: Array.isArray(results) ? results.slice(0, max) : [] }
  }

  async trackDetail({ trackId, provider, env = settingsEnv(), fetchImpl } = {}) {
    const resolved = this.#resolveOrThrow({ provider, env })
    return resolved.provider.trackDetail
      ? resolved.provider.trackDetail(resolved.config, { trackId, fetchImpl })
      : null
  }

  // Used by the privileged main-process resolver — returns { url }|null.
  async resolvePlayUrl({ trackId, provider, env = settingsEnv(), fetchImpl } = {}) {
    const resolved = this.resolve({ id: provider, env })
    if (!resolved.authorized) return null
    return resolved.provider.resolvePlayUrl
      ? resolved.provider.resolvePlayUrl(resolved.config, { trackId, fetchImpl })
      : null
  }

  diagnose({ env = settingsEnv() } = {}) {
    const active = this.resolve({ env })
    return {
      defaultProvider: DEFAULT_MUSIC_PROVIDER,
      active: { id: active.provider.id, name: active.provider.name, configured: active.configured, authorized: active.authorized },
      providers: this.all().map((p) => ({ id: p.id, name: p.name })),
    }
  }
}

export const musicProviderRegistry = new MusicProviderRegistry([neteaseProvider])

export function registerMusicProvider(provider) {
  return musicProviderRegistry.register(provider)
}

// True when the active provider has a usable user token (playback is possible).
export function hasMusicAuth(env = settingsEnv()) {
  try {
    return musicProviderRegistry.resolve({ env }).authorized
  } catch {
    return false
  }
}

// True when the active provider is at least configured enough to search.
export function isMusicConfigured(env = settingsEnv()) {
  try {
    return musicProviderRegistry.resolve({ env }).configured
  } catch {
    return false
  }
}
