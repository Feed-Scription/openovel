// Read + write API keys and provider configuration via the global settings
// layer at $OPENOVEL_HOME/.openovel/settings.local.json (default ~/.openovel/).
//
// This file manages three orthogonal concerns:
//   1. API keys (per LLM + search provider, redacted from snapshot)
//   2. LLM provider config (which provider, paid-fallback, base URL, small/large model)
//   3. Search provider config (which search provider tries first)
//
// All writes go to a single settings.local.json AND mirror to process.env so
// the runtime picks changes up on the next request without restart.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import { IMAGE_PROVIDER_PRESETS, normalizeImageProvider } from "../provider/imageGeneration.js"
import { loadSettings } from "../config/settings.js"
import {
  CUSTOM_PROVIDER_PREFIX,
  CUSTOM_PROVIDERS_ENV,
  customProviderKeyEnv,
  normalizeCustomProviderEntry,
  normalizeCustomProvidersList,
  slugifyCustomProviderName,
} from "../provider/customProviders.js"

// Storage slots for API keys. Each entry maps a friendly id to where the key
// lives inside settings.local.json + the env var the runtime ultimately reads.
// Each preset has its OWN key slot, even when several presets share the
// same OpenAI-compatible plugin shape. Sharing the slot used to overwrite
// keys when the user switched presets (save a DeepSeek key, switch to
// OpenRouter, paste a different key → DeepSeek key gone). One slot per
// preset means switching is non-destructive.
const KEYS = [
  // ── LLM provider keys ──
  { id: "deepseek",       category: "llm",    label: "DeepSeek",            envKey: "DEEPSEEK_API_KEY",                     providerId: "deepseek" },
  { id: "kimi",           category: "llm",    label: "Kimi (Moonshot)",     envKey: "KIMI_API_KEY",                         providerId: "kimi-code" },
  { id: "mimo",           category: "llm",    label: "MiMo Token Plan",     envKey: "MIMO_API_KEY",                         providerId: "mimo-token-plan-cn" },
  { id: "openrouter",     category: "llm",    label: "OpenRouter",          envKey: "OPENROUTER_API_KEY",                   providerId: "openrouter" },
  // Anthropic (Claude) key — hydrated to ANTHROPIC_API_KEY, which both the
  // official `anthropic` and `custom-anthropic` providers read.
  { id: "anthropic",      category: "llm",    label: "Anthropic (Claude)",  envKey: "ANTHROPIC_API_KEY",                    providerId: "anthropic" },
  // Generic OpenAI-compatible key — used by the "Custom URL" preset for any
  // endpoint that isn't one of the named presets above.
  { id: "openai",         category: "llm",    label: "OpenAI-compatible",   envKey: "AI_API_KEY",                           providerId: "custom-openai" },
  // ── Web search provider keys ──
  { id: "kimi-search",    category: "search", label: "Kimi Search",         envKey: "KIMI_SEARCH_API_KEY",                  providerId: "kimi-search-service" },
  { id: "exa",            category: "search", label: "Exa",                 envKey: "EXA_API_KEY",                          providerId: "exa-mcp" },
  { id: "parallel",       category: "search", label: "Parallel",            envKey: "PARALLEL_MCP_API_KEY",                 providerId: "parallel-mcp" },
  { id: "custom-search",  category: "search", label: "Custom HTTP Search",  envKey: "OPENOVEL_CUSTOM_HTTP_SEARCH_API_KEY",  providerId: "custom-http-search" },
]

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    const text = await readFile(settingsFilePath(), "utf8")
    return JSON.parse(text)
  } catch { return {} }
}

// Self-heal stale state where provider.foreground was updated but
// provider.background was left pointing at the old provider — there's no UI
// to diverge the two, so a mismatch is always a leftover from a previous
// session. Returns true when the file was rewritten so callers can refresh
// their in-process env.
async function healStaleBackgroundProvider() {
  const settings = await readSettingsFile()
  const fg = settings?.provider?.foreground
  const bg = settings?.provider?.background
  if (!fg || !bg || fg === bg) return false
  settings.provider.background = fg
  // Mirror to process.env too so the running session picks it up without
  // needing the user to restart the app.
  process.env.AI_BACKGROUND_PROVIDER = fg
  await writeSettingsFile(settings)
  return true
}

// Public hook so the Electron main process can heal on startup. Idempotent.
export async function ensureProviderConsistent() {
  return await healStaleBackgroundProvider()
}

// Mirror everything that's saved in settings.local.json into process.env so
// downstream code (provider.js, providerRoute, registry.route → resolveProvider)
// reads consistent values regardless of when settings were last written and
// whether settingsEnv()'s derivation happened to fire before/after a key
// save. Idempotent: re-reading the same settings produces the same env.
//
// Why this exists at all (since settingsEnv() already derives env from file):
//   1. The "Test connection" button has been reported as failing on the very
//      first click after opening Settings, then succeeding after the user
//      clicks away and back. We can't fully reproduce a single root cause,
//      but every failure mode bottoms out on "process.env didn't have the
//      key at the moment of route resolution". Forcing a sync removes that
//      class of bug entirely.
//   2. Hot-reloading settings into env also keeps any code that reads
//      process.env directly (legacy paths, child processes spawned without a
//      derived env) honest.
// Hydrate the ACTIVE foreground provider's custom verbal-tic regexes into
// OPENOVEL_NARRATOR_TIC_PATTERNS (newline-separated), which the runtime's tic
// scanner reads. Patterns are stored per-provider so switching providers swaps
// in that model's known-tic set. No active provider / no patterns → unset.
function applyNarratorTicEnv(settings) {
  const provider = settings?.provider || {}
  const active = process.env.AI_PROVIDER || provider.foreground || ""
  const patterns = active ? (provider.providers?.[active]?.ticPatterns || "") : ""
  if (patterns && String(patterns).trim()) process.env.OPENOVEL_NARRATOR_TIC_PATTERNS = patterns
  else delete process.env.OPENOVEL_NARRATOR_TIC_PATTERNS
}

// Mirror the user-defined custom provider set into process.env so the
// registry's dynamic sync (and any spawned child) sees the current set: one
// JSON definitions blob (no key material) + one derived key env per provider.
// Tracks what it hydrated so a deleted provider's stale key env is removed on
// the next pass instead of lingering for the rest of the session.
const hydratedCustomKeyEnvs = new Set()
function applyCustomProvidersEnv(settings) {
  const providerSection = settings?.provider || {}
  const providers = providerSection.providers || {}
  const entries = normalizeCustomProvidersList(providerSection.customProviders)

  if (entries.length) process.env[CUSTOM_PROVIDERS_ENV] = JSON.stringify(entries)
  else delete process.env[CUSTOM_PROVIDERS_ENV]

  const nextEnvs = new Set()
  for (const entry of entries) {
    const envName = customProviderKeyEnv(entry.id)
    const apiKey = providers?.[entry.id]?.apiKey
    if (apiKey) {
      process.env[envName] = apiKey
      nextEnvs.add(envName)
    } else {
      delete process.env[envName]
    }
  }
  for (const envName of hydratedCustomKeyEnvs) {
    if (!nextEnvs.has(envName)) delete process.env[envName]
  }
  hydratedCustomKeyEnvs.clear()
  for (const envName of nextEnvs) hydratedCustomKeyEnvs.add(envName)
}

// Mirror per-provider display aliases (providers[<id>].alias) into
// OPENOVEL_PROVIDER_ALIASES so the registry shows them on the next resolve.
function applyProviderAliasesEnv(settings) {
  const providers = settings?.provider?.providers || {}
  const aliases = {}
  for (const [id, config] of Object.entries(providers)) {
    const alias = typeof config?.alias === "string" ? config.alias.trim() : ""
    if (alias) aliases[id] = alias
  }
  if (Object.keys(aliases).length) process.env.OPENOVEL_PROVIDER_ALIASES = JSON.stringify(aliases)
  else delete process.env.OPENOVEL_PROVIDER_ALIASES
}

function applyAdvancedRoutingEnv(settings) {
  const routes = { ...(settings?.modelProfiles?.routes || {}) }
  for (const [agentId, override] of Object.entries(settings?.agents?.overrides || {})) {
    const model = override?.model
    if (!model || typeof model !== "object" || (!model.provider && !model.model)) continue
    routes[`agent:${agentId}`] = {
      role: model.role || override.role || "background",
      provider: model.provider || "",
      model: model.model || "",
    }
  }
  if (Object.keys(routes).length) process.env.OPENOVEL_MODEL_PROFILE_ROUTES = JSON.stringify(routes)
  else delete process.env.OPENOVEL_MODEL_PROFILE_ROUTES

  const agentOverrides = settings?.agents?.overrides || {}
  if (Object.keys(agentOverrides).length) process.env.OPENOVEL_AGENT_OVERRIDES = JSON.stringify(agentOverrides)
  else delete process.env.OPENOVEL_AGENT_OVERRIDES
}

export async function hydrateProcessEnvFromSettings() {
  const settings = await readSettingsFile()
  const provider = settings?.provider || {}
  const providers = provider.providers || {}
  const webSearch = settings?.webSearch || {}
  const searchProviders = webSearch.providers || {}
  const modelProfiles = settings?.modelProfiles || {}

  // Per-provider API keys.
  for (const spec of KEYS) {
    const bag = spec.category === "llm" ? providers : searchProviders
    const apiKey = bag?.[spec.providerId]?.apiKey
    if (apiKey) process.env[spec.envKey] = apiKey
  }

  // User-defined custom providers: definitions blob + per-provider key envs.
  applyCustomProvidersEnv(settings)

  // Operator-assigned provider display aliases.
  applyProviderAliasesEnv(settings)

  // Provider selection / chain / paid-fallback.
  // Pin follows the user's explicit selection — no inference from which
  // keys happen to be configured. If foreground is empty, AI_PROVIDER
  // stays untouched (and Test connection will report what's missing).
  if (provider.foreground) process.env.AI_PROVIDER = provider.foreground
  if (provider.background) process.env.AI_BACKGROUND_PROVIDER = provider.background
  // Strip the legacy alias so it doesn't shadow AI_PROVIDER.
  delete process.env.AI_FOREGROUND_PROVIDER
  if (Array.isArray(provider.order) && provider.order.length) {
    process.env.AI_PROVIDER_ORDER = provider.order.join(",")
  } else if (provider.order === undefined) {
    delete process.env.AI_PROVIDER_ORDER
  }
  if (provider.allowPaidFallback === true) process.env.AI_ALLOW_PAID_FALLBACK = "true"
  else if (provider.allowPaidFallback === false) delete process.env.AI_ALLOW_PAID_FALLBACK
  if (provider.baseUrl) process.env.AI_BASE_URL = provider.baseUrl

  // Model profile pins.
  if (modelProfiles.small) process.env.AI_SMALL_MODEL = modelProfiles.small
  if (modelProfiles.large) process.env.AI_LARGE_MODEL = modelProfiles.large

  // Active web-search provider pin.
  if (webSearch.provider) process.env.OPENOVEL_WEBSEARCH_PROVIDER = webSearch.provider

  // Init depth — VM reads from env to decide whether the first new-story
  // flow needs the depth-choice Modal. Empty/unset = ask the user.
  const initDepth = settings?.initialization?.depth
  if (initDepth && ["zero", "standard", "deep"].includes(initDepth)) {
    process.env.OPENOVEL_INIT_DEPTH = initDepth
  } else {
    delete process.env.OPENOVEL_INIT_DEPTH
  }

  // Active provider's custom tic regexes (AI_PROVIDER is resolved just above).
  applyNarratorTicEnv(settings)
  applyAdvancedRoutingEnv(settings)
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

function maskKey(value) {
  if (!value) return ""
  const s = String(value)
  if (s.length <= 8) return "*".repeat(s.length)
  return s.slice(0, 4) + "…" + s.slice(-4)
}

// This UI writes the GLOBAL settings.local.json, which sits BELOW the project
// layers (.openovel/settings.jsonc / settings.local.json) in the merge order —
// so a project file pinning provider/models silently overrides every choice
// made here: the pill appears to switch, then the old provider/models resurface
// once this session's env mirrors clear (or on restart). Per the never-silently-
// discard convention, detect that shadowing and surface it in the snapshot so
// the UI can warn instead of losing quietly.
function detectLlmLayerShadowing(uiSettings) {
  let effective, baseline
  try {
    // Strip this session's provider/model env mirrors so the comparison sees
    // the file-layer truth (what rules after a restart), not what the mirrors
    // happen to mask right now.
    const env = { ...process.env }
    for (const k of [
      "AI_PROVIDER", "AI_FOREGROUND_PROVIDER", "AI_BACKGROUND_PROVIDER",
      "AI_PROVIDER_ORDER", "AI_ALLOW_PAID_FALLBACK", "AI_BASE_URL",
      "AI_SMALL_MODEL", "AI_LARGE_MODEL",
    ]) delete env[k]
    // Two merges with the same env: the real stack (defaults + global layers +
    // the cwd-walk layers, which is where project .openovel/ files AND this
    // UI's own settings.local.json come from) vs the same stack with the
    // cwd-walk suppressed via the built-in OPENOVEL_IGNORE_PROJECT_CONFIG
    // escape hatch. Comparing against defaults+globals alone would misread
    // DEFAULT_SETTINGS (e.g. the default provider order) as shadowing.
    effective = loadSettings({ env })
    baseline = loadSettings({ env: { ...env, OPENOVEL_IGNORE_PROJECT_CONFIG: "1" } })
  } catch { return null }
  const eff = effective?.settings || {}
  const base = baseline?.settings || {}
  // The ignore-project baseline also drops this UI's own file (it is found by
  // the same cwd walk), so overlay the UI's values back on top: the question
  // is "does anything beat what THIS PAGE wrote", not "does the UI file beat
  // the globals".
  const ui = uiSettings || {}
  const expect = (uiValue, baseValue) => {
    const v = uiValue ?? baseValue
    return String(v ?? "")
  }
  const conflicts = []
  const check = (key, effValue, expected) => {
    const v = String(effValue ?? "")
    if (v && v !== expected) conflicts.push({ key, effective: v })
  }
  check("provider", eff.provider?.foreground, expect(ui.provider?.foreground, base.provider?.foreground))
  check("provider order", (eff.provider?.order || []).join(","),
    expect(ui.provider?.order?.join?.(","), base.provider?.order?.join?.(",")))
  check("base URL", eff.provider?.baseUrl, expect(ui.provider?.baseUrl, base.provider?.baseUrl))
  check("small model", eff.modelProfiles?.small, expect(ui.modelProfiles?.small, base.modelProfiles?.small))
  check("large model", eff.modelProfiles?.large, expect(ui.modelProfiles?.large, base.modelProfiles?.large))
  if (!conflicts.length) return null
  const baselinePaths = new Set((baseline.sources || []).map((s) => s.path))
  const files = (effective.sources || [])
    .filter((s) => s.path && !baselinePaths.has(s.path) && s.path !== settingsFilePath())
    .map((s) => s.path)
  return { conflicts, files }
}

// ── Snapshot ────────────────────────────────────────────────────────────
// Redacted view for the renderer: never raw key material; surfaces which
// slot is filled, which provider+model+base URL is configured, and which
// search provider is in front of the order.
export async function getApiKeysSnapshot() {
  const settings = await readSettingsFile()
  const providerSection = settings?.provider || {}
  const providerBag = providerSection.providers || {}
  const webSearchSection = settings?.webSearch || {}
  const searchBag = webSearchSection.providers || {}
  const modelProfiles = settings?.modelProfiles || {}

  const keys = []
  for (const spec of KEYS) {
    const envValue = process.env[spec.envKey] || ""
    const fileValue =
      (spec.category === "llm" ? providerBag[spec.providerId]?.apiKey : searchBag[spec.providerId]?.apiKey) || ""
    const effective = envValue || fileValue
    keys.push({
      id: spec.id,
      category: spec.category,
      label: spec.label,
      envKey: spec.envKey,
      providerId: spec.providerId,
      set: Boolean(effective),
      masked: effective ? maskKey(effective) : "",
      sourcedFrom: envValue ? "env" : fileValue ? "file" : "",
      // Per-provider custom verbal-tic regexes (LLM providers only). Surfaced so
      // the advanced UI can edit the active provider's set.
      ticPatterns: spec.category === "llm" ? (providerBag[spec.providerId]?.ticPatterns || "") : "",
    })
  }

  // Image generation, surfaced only when the user has actually configured it
  // (a provider, model, or image key set) so the runtime console can show the
  // active image model alongside the text tiers.
  const imageGen = settings?.image?.generation || {}
  const rawImageProvider = process.env.OPENOVEL_IMAGE_PROVIDER || imageGen.provider || ""
  const rawImageModel = process.env.OPENOVEL_IMAGE_MODEL || imageGen.model || ""
  const imageKeySet = Boolean(process.env.OPENOVEL_IMAGE_API_KEY || imageGen.apiKey)
  let image = null
  if (rawImageProvider || rawImageModel || imageKeySet) {
    const preset = IMAGE_PROVIDER_PRESETS[normalizeImageProvider(rawImageProvider)] || {}
    image = {
      providerLabel: preset.label || "Custom",
      model: rawImageModel || preset.model || "",
      keySet: imageKeySet,
    }
  }

  // User-defined custom providers, redacted like the named key slots: the
  // definition plus whether/which masked key is saved — never raw material.
  const customProviders = normalizeCustomProvidersList(providerSection.customProviders).map((entry) => {
    const envValue = process.env[customProviderKeyEnv(entry.id)] || ""
    const fileValue = providerBag[entry.id]?.apiKey || ""
    const effective = envValue || fileValue
    return {
      ...entry,
      keyEnv: customProviderKeyEnv(entry.id),
      set: Boolean(effective),
      masked: effective ? maskKey(effective) : "",
      sourcedFrom: envValue ? "env" : fileValue ? "file" : "",
      ticPatterns: providerBag[entry.id]?.ticPatterns || "",
    }
  })

  // Display aliases, keyed by provider id (pills + dropdowns label lookup).
  const aliases = {}
  for (const [id, config] of Object.entries(providerBag)) {
    const alias = typeof config?.alias === "string" ? config.alias.trim() : ""
    if (alias) aliases[id] = alias
  }

  return {
    keys,
    customProviders,
    aliases,
    filePath: settingsFilePath(),
    // Non-null when a lower settings layer (project .openovel/*.jsonc etc.)
    // overrides provider/model choices made in this UI — see the detector.
    layerShadowing: detectLlmLayerShadowing(settings),
    image,
    llm: {
      // Primary provider; empty means "use runtime DEFAULT_PROVIDER chain".
      // The canonical env is AI_PROVIDER — registry.js still falls back to
      // legacy AI_FOREGROUND_PROVIDER, but new writes go to AI_PROVIDER.
      provider: process.env.AI_PROVIDER || process.env.AI_FOREGROUND_PROVIDER || providerSection.foreground || "",
      paidFallback:
        process.env.AI_ALLOW_PAID_FALLBACK
          ? ["1", "true", "yes", "on"].includes(String(process.env.AI_ALLOW_PAID_FALLBACK).toLowerCase())
          : Boolean(providerSection.allowPaidFallback),
      baseUrl: process.env.AI_BASE_URL || providerSection.baseUrl || "",
      smallModel: process.env.AI_SMALL_MODEL || modelProfiles.small || "",
      largeModel: process.env.AI_LARGE_MODEL || modelProfiles.large || "",
    },
    search: {
      // first search provider tried; empty means default order (DuckDuckGo first)
      provider: process.env.OPENOVEL_WEBSEARCH_PROVIDER || webSearchSection.provider || "",
    },
  }
}

// ── Key writes (per-slot) ───────────────────────────────────────────────
// Accepts { [keyId]: stringValueOrEmpty }. Empty string clears the key.
// Atomic across patch — one disk write, one settings tree update.
export async function setApiKeys(patch = {}) {
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  settings.provider.providers = settings.provider.providers || {}
  settings.webSearch = settings.webSearch || {}
  settings.webSearch.providers = settings.webSearch.providers || {}

  const changes = []
  for (const [id, raw] of Object.entries(patch || {})) {
    const spec = KEYS.find((k) => k.id === id)
    if (!spec) continue
    const value = typeof raw === "string" ? raw.trim() : ""
    const bag = spec.category === "llm"
      ? settings.provider.providers
      : settings.webSearch.providers
    bag[spec.providerId] = bag[spec.providerId] || {}
    if (value) {
      bag[spec.providerId].apiKey = value
      process.env[spec.envKey] = value
    } else {
      delete bag[spec.providerId].apiKey
      delete process.env[spec.envKey]
      if (Object.keys(bag[spec.providerId]).length === 0) {
        delete bag[spec.providerId]
      }
    }
    changes.push({ id, set: Boolean(value) })
  }

  await writeSettingsFile(settings)
  return { changes, filePath: settingsFilePath() }
}

// ── LLM config (mode switch) ────────────────────────────────────────────
// Accepts a partial LLM config patch and writes it atomically. Pass empty
// string to a field to clear it (returns the runtime to its default).
//
// Fields:
//   provider      → AI_FOREGROUND_PROVIDER (+ AI_BACKGROUND_PROVIDER if unset)
//   paidFallback  → AI_ALLOW_PAID_FALLBACK (true/false)
//   baseUrl       → AI_BASE_URL (used by custom-openai provider)
//   smallModel    → AI_SMALL_MODEL
//   largeModel    → AI_LARGE_MODEL
export async function setLlmConfig(patch = {}) {
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  settings.modelProfiles = settings.modelProfiles || {}

  const writeOrClear = (target, key, value, envKey, envValue) => {
    if (value === undefined) return  // not in patch → don't touch
    if (value === "" || value === null || value === false) {
      delete target[key]
      delete process.env[envKey]
    } else {
      target[key] = value
      process.env[envKey] = envValue !== undefined ? envValue : String(value)
    }
  }

  if ("provider" in patch) {
    // Canonical write is AI_PROVIDER — both foreground and background routes
    // fall back to it in registry.js. We also clear the legacy split env
    // vars so a stale AI_FOREGROUND_PROVIDER from a previous run doesn't
    // shadow the new mode.
    writeOrClear(settings.provider, "foreground", patch.provider, "AI_PROVIDER")
    delete process.env.AI_FOREGROUND_PROVIDER
    // Mirror background to match — there's no UI affordance for diverging
    // the two, and a stale background pin from an earlier session (e.g. a
    // previously-picked DeepSeek that still has provider.background =
    // "deepseek" while foreground is now "kimi-code") would silently break
    // every background agent run. Users who genuinely want a separate
    // background provider can set AI_BACKGROUND_PROVIDER in Environment.
    writeOrClear(settings.provider, "background", patch.provider, "AI_BACKGROUND_PROVIDER")
  }
  if ("providerOrder" in patch) {
    // AI_PROVIDER_ORDER lets a single mode (e.g. MiMo) try multiple regions
    // with the same key — the first one that authenticates wins. Empty array
    // / "" clears the chain so the registry falls back to its defaults.
    const order = Array.isArray(patch.providerOrder)
      ? patch.providerOrder.filter(Boolean)
      : []
    if (order.length) {
      settings.provider.order = order
      process.env.AI_PROVIDER_ORDER = order.join(",")
    } else {
      delete settings.provider.order
      delete process.env.AI_PROVIDER_ORDER
    }
  }
  if ("paidFallback" in patch) {
    const flag = Boolean(patch.paidFallback)
    if (flag) {
      settings.provider.allowPaidFallback = true
      process.env.AI_ALLOW_PAID_FALLBACK = "true"
    } else {
      delete settings.provider.allowPaidFallback
      delete process.env.AI_ALLOW_PAID_FALLBACK
    }
  }
  if ("baseUrl" in patch) {
    writeOrClear(settings.provider, "baseUrl", patch.baseUrl, "AI_BASE_URL")
  }
  if ("smallModel" in patch) {
    writeOrClear(settings.modelProfiles, "small", patch.smallModel, "AI_SMALL_MODEL")
  }
  if ("largeModel" in patch) {
    writeOrClear(settings.modelProfiles, "large", patch.largeModel, "AI_LARGE_MODEL")
  }

  // Provider may have changed — swap in the new active provider's tic regexes.
  applyNarratorTicEnv(settings)
  await writeSettingsFile(settings)
  return { filePath: settingsFilePath() }
}

// Per-provider verbal-tic regexes (one per line), stored alongside the provider
// key in settings.provider.providers[providerId].ticPatterns. When the edited
// provider is the active foreground one, the patterns are immediately hydrated
// into OPENOVEL_NARRATOR_TIC_PATTERNS so the next background turn's tic scan
// picks them up without a restart.
export async function setTicPatterns(providerId, patterns = "") {
  const id = String(providerId || "").trim()
  if (!id) return { ok: false, message: "providerId required" }
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  settings.provider.providers = settings.provider.providers || {}
  settings.provider.providers[id] = settings.provider.providers[id] || {}
  const text = String(patterns || "")
  if (text.trim()) settings.provider.providers[id].ticPatterns = text
  else delete settings.provider.providers[id].ticPatterns
  applyNarratorTicEnv(settings)
  await writeSettingsFile(settings)
  return { ok: true, providerId: id, filePath: settingsFilePath() }
}

// Per-provider display alias, stored alongside the provider key in
// settings.provider.providers[providerId].alias. Shown wherever the provider
// is listed (preset pills, Routing/Agents dropdowns, doctor output). Empty
// string clears the alias, returning to the provider's built-in name.
export async function setProviderAlias(providerId, alias = "") {
  const id = String(providerId || "").trim()
  if (!id) return { ok: false, message: "providerId required" }
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  settings.provider.providers = settings.provider.providers || {}
  settings.provider.providers[id] = settings.provider.providers[id] || {}
  const value = String(alias || "").trim()
  if (value) settings.provider.providers[id].alias = value
  else {
    delete settings.provider.providers[id].alias
    if (Object.keys(settings.provider.providers[id]).length === 0) {
      delete settings.provider.providers[id]
    }
  }
  applyProviderAliasesEnv(settings)
  await writeSettingsFile(settings)
  return { ok: true, providerId: id, alias: value, filePath: settingsFilePath() }
}

// ── Custom providers (user-defined endpoints) ───────────────────────────
// Upsert one custom provider definition. Accepts { id?, name, kind, baseUrl,
// defaultModel, defaultBackgroundModel, apiKey? }. Without an id a new one is
// generated from the name (custom:<slug>, uniquified). apiKey semantics match
// setApiKeys: undefined = leave alone, "" = clear, non-empty = set. Definitions
// live in settings.provider.customProviders; the key rides the standard
// settings.provider.providers[<id>].apiKey slot.
export async function saveCustomProvider(patch = {}) {
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  settings.provider.providers = settings.provider.providers || {}
  const list = normalizeCustomProvidersList(settings.provider.customProviders)

  // Optional explicit alias: the user-chosen slug that becomes the provider
  // id (custom:<alias>). Lets the user pick a readable id up front (CJK names
  // would otherwise generate an opaque one) and rename it later — renames
  // migrate every reference (pin, order, routes, agent overrides, key slot).
  const aliasRaw = typeof patch.alias === "string" ? patch.alias.trim() : ""
  let aliasId = ""
  if (aliasRaw) {
    const slug = slugifyCustomProviderName(aliasRaw)
    if (!slug) return { ok: false, message: "alias must contain at least one ascii letter or digit" }
    aliasId = CUSTOM_PROVIDER_PREFIX + slug
  }

  let id = typeof patch.id === "string" ? patch.id.trim() : ""
  let renamedFrom = ""
  if (id && aliasId && aliasId !== id) {
    // Rename: the target alias must not belong to another entry.
    if (list.some((entry) => entry.id === aliasId)) {
      return { ok: false, message: `alias already in use (${aliasId})` }
    }
    renamedFrom = id
    id = aliasId
  } else if (!id && aliasId) {
    if (list.some((entry) => entry.id === aliasId)) {
      return { ok: false, message: `alias already in use (${aliasId})` }
    }
    id = aliasId
  } else if (!id) {
    let slug = slugifyCustomProviderName(patch.name)
    if (!slug) slug = `provider-${Date.now().toString(36)}`
    let candidate = CUSTOM_PROVIDER_PREFIX + slug
    let n = 2
    while (list.some((entry) => entry.id === candidate)) candidate = `${CUSTOM_PROVIDER_PREFIX}${slug}-${n++}`
    id = candidate
  }

  if (renamedFrom) migrateCustomProviderId(settings, renamedFrom, id)

  const existing = list.find((entry) => entry.id === (renamedFrom || id)) || {}
  const entry = normalizeCustomProviderEntry({ ...existing, ...patch, id })
  if (!entry) return { ok: false, message: "invalid custom provider (need a name with at least one ascii letter/digit, or an id)" }

  const next = list.filter((item) => item.id !== entry.id && item.id !== renamedFrom)
  next.push(entry)
  settings.provider.customProviders = next

  if (typeof patch.apiKey === "string") {
    const bag = settings.provider.providers
    bag[entry.id] = bag[entry.id] || {}
    const value = patch.apiKey.trim()
    if (value) bag[entry.id].apiKey = value
    else {
      delete bag[entry.id].apiKey
      if (Object.keys(bag[entry.id]).length === 0) delete bag[entry.id]
    }
  }

  applyCustomProvidersEnv(settings)
  if (renamedFrom) {
    // The id is referenced from several env mirrors — re-derive them all so
    // the running session routes to the new id without a restart.
    if (settings.provider.foreground) process.env.AI_PROVIDER = settings.provider.foreground
    if (settings.provider.background) process.env.AI_BACKGROUND_PROVIDER = settings.provider.background
    if (Array.isArray(settings.provider.order) && settings.provider.order.length) {
      process.env.AI_PROVIDER_ORDER = settings.provider.order.join(",")
    }
    applyNarratorTicEnv(settings)
    applyAdvancedRoutingEnv(settings)
  }
  await writeSettingsFile(settings)
  return { ok: true, id: entry.id, renamedFrom: renamedFrom || undefined, filePath: settingsFilePath() }
}

// Rewrite every settings reference from one custom provider id to another:
// the per-provider bag (key + tic patterns), the foreground/background pins,
// the provider order chain, model-profile routes (object and "provider/model"
// string forms), and per-agent model overrides. Used by alias renames so a
// rename never strands routing at a provider id that no longer exists.
function migrateCustomProviderId(settings, oldId, newId) {
  const bag = settings.provider?.providers
  if (bag && bag[oldId] && !bag[newId]) {
    bag[newId] = bag[oldId]
    delete bag[oldId]
  }
  for (const field of ["foreground", "background"]) {
    if (settings.provider?.[field] === oldId) settings.provider[field] = newId
  }
  if (Array.isArray(settings.provider?.order)) {
    settings.provider.order = settings.provider.order.map((item) => (item === oldId ? newId : item))
  }
  const routes = settings.modelProfiles?.routes
  if (routes && typeof routes === "object") {
    for (const [profile, route] of Object.entries(routes)) {
      if (typeof route === "string") {
        const [provider, ...rest] = route.split("/")
        if (provider === oldId) routes[profile] = [newId, ...rest].join("/")
      } else if (route && typeof route === "object" && route.provider === oldId) {
        route.provider = newId
      }
    }
  }
  for (const override of Object.values(settings.agents?.overrides || {})) {
    const model = override?.model
    if (model && typeof model === "object" && model.provider === oldId) {
      model.provider = newId
    }
  }
}

// Remove a custom provider definition + its stored key/tic-patterns. If the
// active provider pin referenced it, the pin is cleared (back to the runtime
// default chain) instead of leaving a route to a provider that no longer
// exists.
export async function deleteCustomProvider(providerId) {
  const id = String(providerId || "").trim()
  if (!id.startsWith(CUSTOM_PROVIDER_PREFIX)) return { ok: false, message: "not a custom provider id" }
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  const list = normalizeCustomProvidersList(settings.provider.customProviders)
  settings.provider.customProviders = list.filter((entry) => entry.id !== id)
  if (settings.provider.providers) delete settings.provider.providers[id]

  let pinCleared = false
  for (const field of ["foreground", "background"]) {
    if (settings.provider[field] === id) {
      delete settings.provider[field]
      pinCleared = true
    }
  }
  if (pinCleared) {
    delete process.env.AI_PROVIDER
    delete process.env.AI_BACKGROUND_PROVIDER
  }
  if (Array.isArray(settings.provider.order) && settings.provider.order.includes(id)) {
    settings.provider.order = settings.provider.order.filter((item) => item !== id)
    if (!settings.provider.order.length) delete settings.provider.order
    if (settings.provider.order?.length) process.env.AI_PROVIDER_ORDER = settings.provider.order.join(",")
    else delete process.env.AI_PROVIDER_ORDER
  }

  applyCustomProvidersEnv(settings)
  applyProviderAliasesEnv(settings)
  applyNarratorTicEnv(settings)
  await writeSettingsFile(settings)
  return { ok: true, id, pinCleared, filePath: settingsFilePath() }
}

// ── Search config (mode switch) ─────────────────────────────────────────
// patch.provider — first search provider to try; empty → runtime default order
// (DuckDuckGo HTML free + fallback chain).
export async function setSearchConfig(patch = {}) {
  const settings = await readSettingsFile()
  settings.webSearch = settings.webSearch || {}

  if ("provider" in patch) {
    if (!patch.provider) {
      delete settings.webSearch.provider
      delete process.env.OPENOVEL_WEBSEARCH_PROVIDER
    } else {
      settings.webSearch.provider = patch.provider
      process.env.OPENOVEL_WEBSEARCH_PROVIDER = patch.provider
    }
  }

  await writeSettingsFile(settings)
  return { filePath: settingsFilePath() }
}
