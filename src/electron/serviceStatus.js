// Assembles a single read-only snapshot of "is everything working" for the
// Settings → Status tab. Pulls from:
//   - provider routing diagnose (which LLM provider is foreground/background,
//     which API key is configured, which model)
//   - search provider registry (DuckDuckGo / Kimi-Search / Exa / Parallel /
//     custom HTTP search — which are configured)
//   - the user's proxy env (so the user can see if their HTTPS_PROXY is being
//     honored — relevant after the undici proxy fix)
//   - process info (node version, platform)
//
// The returned object is JSON-safe and never includes raw API key material.

import process from "node:process"
import { diagnoseProviders } from "../provider/provider.js"
import { webSearchProviderRegistry } from "../search/registry.js"

export async function buildServiceStatus({ getSessionAggregate } = {}) {
  const providers = diagnoseProviders()
  const search = webSearchProviderRegistry.diagnose()
  const proxy = sniffProxyEnv()
  let session = null
  try {
    if (typeof getSessionAggregate === "function") {
      session = await getSessionAggregate()
    }
  } catch { /* tolerate */ }

  return {
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      home: process.env.OPENOVEL_HOME || "",
    },
    proxy,
    providers: {
      defaultProvider: providers.defaultProvider,
      providerOrder: providers.providerOrder,
      allowPaidFallback: providers.allowPaidFallback,
      foreground: (providers.foreground || []).map(redactProvider),
      background: (providers.background || []).map(redactProvider),
      // Full registry — including providers NOT in the current route — so the
      // Status tab can detect "user pinned X but Y is the one actually configured".
      providers: (providers.providers || []).map(redactProvider),
      modelProfiles: providers.modelProfiles || [],
    },
    search: {
      defaultProvider: search.defaultProvider,
      providerOrder: search.providerOrder,
      active: search.active || [],
      providers: (search.providers || []).map(redactSearchProvider),
    },
    session: session || null,
  }
}

function sniffProxyEnv() {
  const slots = [
    ["HTTPS_PROXY", process.env.HTTPS_PROXY || process.env.https_proxy],
    ["HTTP_PROXY",  process.env.HTTP_PROXY  || process.env.http_proxy],
    ["ALL_PROXY",   process.env.ALL_PROXY   || process.env.all_proxy],
    ["NO_PROXY",    process.env.NO_PROXY    || process.env.no_proxy],
  ]
  const active = slots.filter(([, v]) => Boolean(v))
  return {
    enabled: active.some(([k]) => k !== "NO_PROXY"),
    bindings: active.map(([k, v]) => ({ key: k, value: redactProxyUrl(v) })),
  }
}

function redactProxyUrl(url) {
  if (!url) return ""
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = "***"
      u.password = ""
    }
    return u.toString()
  } catch {
    return String(url)
  }
}

function redactProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    model: provider.model,
    billingMode: provider.billingMode,
    baseUrl: provider.baseUrl,
    keyEnv: provider.keyEnv,
    keyConfigured: Boolean(provider.keyConfigured),
    capabilities: provider.capabilities,
    concurrency: provider.concurrency,
  }
}

function redactSearchProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    billingMode: provider.billingMode,
    baseUrl: provider.baseUrl,
    keyEnv: provider.keyEnv,
    keyConfigured: Boolean(provider.keyConfigured),
    configured: Boolean(provider.configured),
    model: provider.model,
  }
}
