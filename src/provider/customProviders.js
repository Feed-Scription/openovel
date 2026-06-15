// User-defined ("custom") LLM providers, configured in Settings → API Keys
// (advanced mode). Unlike the single built-in `custom-openai` /
// `custom-anthropic` slots, the user can define ANY number of endpoints, each
// with its own id, base URL, key, and default models — so different model
// profiles / resident agents can be routed to different custom endpoints at
// the same time.
//
// This module is PURE (no fs, no settings import) so it can be shared by
// config/settings.js, provider/registry.js, and the Electron stores without
// import cycles.
//
// Flow: settings.provider.customProviders (array of entries) is serialized by
// settingsToEnv into OPENOVEL_CUSTOM_PROVIDERS (definitions only, never key
// material); each provider's API key rides its own derived env var
// (OPENOVEL_CUSTOM_<SLUG>_API_KEY) sourced from the standard
// settings.provider.providers[<id>].apiKey slot. The registry re-syncs its
// dynamic entries from that env on every resolve/route, so all surfaces
// (Electron embedded VM, eval children) see the same set.

export const CUSTOM_PROVIDER_PREFIX = "custom:"

export const CUSTOM_PROVIDERS_ENV = "OPENOVEL_CUSTOM_PROVIDERS"

const CUSTOM_PROVIDER_KINDS = new Set(["openai-compatible", "anthropic"])

// How an OpenAI-compatible custom endpoint should emit the thinking switch:
//   hint      — DEFAULT: follow the runtime's per-call hint (agents think, fast
//               calls like narration don't). Mirrors the built-in Kimi/MiMo
//               providers, so the narrator never wastes reasoning tokens.
//   auto      — passthrough: never add a thinking field (the endpoint's own
//               default applies). Use for generic OpenAI endpoints that 400 on
//               an unknown `thinking` field.
//   disabled  — always send { thinking: { type: "disabled" } }
//   enabled   — always send { thinking: { type: "enabled" } } (+ effort)
// The wire shape matches Kimi/MiMo/DeepSeek and xiaomimimo's API.
const CUSTOM_THINKING_MODES = new Set(["auto", "disabled", "enabled", "hint"])
const DEFAULT_CUSTOM_THINKING = "hint"
const REASONING_EFFORTS = new Set(["low", "medium", "high"])

export function isCustomProviderId(id) {
  return typeof id === "string" && id.startsWith(CUSTOM_PROVIDER_PREFIX)
}

// ASCII-only slug: lowercased, runs of non [a-z0-9] collapse to "-". Returns
// "" when nothing survives (e.g. a fully-CJK name) — callers must fall back
// to a generated id.
export function slugifyCustomProviderName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function envSlug(id) {
  const bare = isCustomProviderId(id) ? id.slice(CUSTOM_PROVIDER_PREFIX.length) : String(id || "")
  return bare.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

export function customProviderKeyEnv(id) {
  return `OPENOVEL_CUSTOM_${envSlug(id)}_API_KEY`
}

export function customProviderBaseUrlEnv(id) {
  return `OPENOVEL_CUSTOM_${envSlug(id)}_BASE_URL`
}

// Validate + canonicalize one user-supplied entry. Returns null when the
// entry has no usable id. Unknown kinds coerce to "openai-compatible".
export function normalizeCustomProviderEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  let id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (id && !isCustomProviderId(id)) {
    const slug = slugifyCustomProviderName(id)
    if (!slug) return null
    id = CUSTOM_PROVIDER_PREFIX + slug
  }
  if (!id) return null
  const kind = CUSTOM_PROVIDER_KINDS.has(raw.kind) ? raw.kind : "openai-compatible"
  const concurrencyRaw = Number(raw.concurrency)
  const concurrency =
    Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.max(1, Math.floor(concurrencyRaw)) : 0
  const thinking = CUSTOM_THINKING_MODES.has(raw.thinking) ? raw.thinking : DEFAULT_CUSTOM_THINKING
  const reasoningEffort = REASONING_EFFORTS.has(raw.reasoningEffort) ? raw.reasoningEffort : ""
  const out = {
    id,
    name: String(raw.name || "").trim() || id.slice(CUSTOM_PROVIDER_PREFIX.length),
    kind,
    baseUrl: String(raw.baseUrl || "").trim(),
    defaultModel: String(raw.defaultModel || "").trim(),
    defaultBackgroundModel: String(raw.defaultBackgroundModel || "").trim(),
  }
  if (concurrency) out.concurrency = concurrency
  // Only persist non-default thinking config so existing blobs stay clean.
  // An entry with no `thinking` field thus resolves to the "hint" default —
  // which is what makes pre-existing custom providers stop over-thinking.
  if (thinking !== DEFAULT_CUSTOM_THINKING) out.thinking = thinking
  if (reasoningEffort) out.reasoningEffort = reasoningEffort
  return out
}

// Build a bodyTransform that emits the Kimi/MiMo-style thinking switch for an
// OpenAI-compatible custom endpoint. Returns null for passthrough ("auto").
export function customThinkingTransform(mode, effort = "") {
  if (!mode || mode === "auto") return null
  return (body, { thinking } = {}) => {
    let on
    if (mode === "disabled") on = false
    else if (mode === "enabled") on = true
    else { // "hint": follow the per-call runtime hint; no hint → passthrough
      if (thinking === "enabled") on = true
      else if (thinking === "disabled") on = false
      else return body
    }
    const next = { ...body }
    if (!on) {
      next.thinking = { type: "disabled" }
      delete next.reasoning_effort
      return next
    }
    next.thinking = { type: "enabled" }
    if (effort) next.reasoning_effort = effort
    return next
  }
}

// Normalize a list (settings array or JSON env string) into a deduped,
// validated array. Later duplicates win so a re-save overrides an older row.
export function normalizeCustomProvidersList(value) {
  let list = value
  if (typeof list === "string") {
    try { list = JSON.parse(list) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const byId = new Map()
  for (const raw of list) {
    const entry = normalizeCustomProviderEntry(raw)
    if (entry) byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

// Build the registry plugin spec for one normalized entry. The apiKey is NOT
// embedded: it resolves through the derived env var like every other
// provider, so env overrides keep working and key material stays out of the
// serialized definition blob.
export function customProviderSpec(entry) {
  const base = {
    id: entry.id,
    name: entry.name,
    billingMode: "unknown",
    baseUrl: entry.baseUrl,
    apiKeyEnv: [customProviderKeyEnv(entry.id)],
    baseUrlEnv: [customProviderBaseUrlEnv(entry.id)],
    concurrencyEnv: [`OPENOVEL_CUSTOM_${envSlug(entry.id)}_CONCURRENCY`],
    defaultModel: entry.defaultModel,
    defaultBackgroundModel: entry.defaultBackgroundModel,
    concurrency: entry.concurrency || 4,
    source: "custom",
  }
  if (entry.kind === "anthropic") {
    return {
      ...base,
      kind: "anthropic",
      path: "/v1/messages",
      auth: { type: "api-key", header: "x-api-key" },
      headers: { "anthropic-version": "2023-06-01" },
    }
  }
  const spec = {
    ...base,
    kind: "openai-compatible",
    auth: { type: "bearer" },
  }
  // Thinking switch (OpenAI-compatible only). An absent field resolves to the
  // "hint" default, so attach the bodyTransform + declare reasoning capability.
  const transform = customThinkingTransform(entry.thinking || DEFAULT_CUSTOM_THINKING, entry.reasoningEffort)
  if (transform) {
    spec.bodyTransform = transform
    spec.capabilities = {
      reasoning: { supported: true, fields: ["reasoning_content"] },
      response: { reasoningFields: ["reasoning_content"] },
    }
  }
  return spec
}
