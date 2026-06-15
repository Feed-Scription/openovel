import { settingsEnv } from "../config/settings.js"
import { providerRegistry, publicProviderInfo, isCustomProvider } from "./registry.js"

export const MODEL_PROFILES = {
  small: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "cheap helper model for routing, labels, extraction, and compact summaries",
  },
  large: {
    role: "background",
    modelEnv: ["AI_LARGE_MODEL"],
    costTier: "large",
    purpose: "capable reasoning model for slow-loop maintenance and broad synthesis",
  },
  foreground: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "low-latency foreground narration",
  },
  // Narrator prose runs on the LARGE model for quality, but stays on the
  // foreground provider so it inherits that provider's thinking setting —
  // which defaults to OFF (KIMI_THINKING=off), keeping narration non-thinking
  // and low-latency. Falls back to AI_SMALL_MODEL, then the provider default,
  // when AI_LARGE_MODEL is unset.
  narrator: {
    role: "foreground",
    modelEnv: ["AI_LARGE_MODEL", "AI_SMALL_MODEL"],
    costTier: "large",
    purpose: "foreground narration prose on the large model (non-thinking)",
  },
  background: {
    role: "background",
    modelEnv: ["AI_LARGE_MODEL"],
    costTier: "large",
    purpose: "slow-loop background maintenance",
  },
  signal: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "cheap foreground-to-background routing decisions",
  },
  // Reader-facing choices run on the LARGE model for quality (the same shape as
  // the narrator profile), but stay on the FOREGROUND provider so they inherit
  // its thinking=OFF default and low latency. Falls back to AI_SMALL_MODEL, then
  // the provider default, when AI_LARGE_MODEL is unset. Kept out of
  // THINKING_ON_PROFILES so the per-call thinking hint stays "disabled".
  "foreground-options": {
    role: "foreground",
    modelEnv: ["AI_LARGE_MODEL", "AI_SMALL_MODEL"],
    costTier: "large",
    purpose: "reader-facing option generation after narration on the large model (non-thinking)",
  },
  memory: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "durable memory review and dedupe",
  },
  summary: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "short labels, file summaries, and compact reports",
  },
  compaction: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "conversation handoff and context compaction",
  },
  webfetch: {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "cheap WebFetch extraction over fetched markdown",
  },
  storykeeper: {
    role: "background",
    modelEnv: ["AI_LARGE_MODEL"],
    costTier: "large",
    purpose: "canon, timeline, and foreground guidance maintenance",
  },
  subagent: {
    role: "background",
    modelEnv: ["AI_LARGE_MODEL"],
    costTier: "large",
    purpose: "default background subagent work",
  },
  "subagent-continuity": {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "continuity checks over canon files",
  },
  "subagent-research": {
    role: "background",
    modelEnv: ["AI_LARGE_MODEL"],
    costTier: "large",
    purpose: "web and file research with grounded evidence",
  },
  "subagent-planner": {
    role: "foreground",
    modelEnv: ["AI_SMALL_MODEL"],
    costTier: "small",
    purpose: "branch planning and pacing analysis",
  },
}

// Which call-types should run with thinking ON. These are the multi-step,
// tool-using reasoning AGENTS — they benefit from deliberate reasoning. Every
// other call (narrator prose, options, signal routing, memory review, labels,
// extraction, compaction) is a fast single-shot and runs thinking OFF.
// The hint is a PREFERENCE: the provider's bodyTransform still applies its own
// model-capability knowledge (e.g. deepseek-v4-flash can't think and stays
// off even when hinted on).
const THINKING_ON_PROFILES = new Set([
  "large",
  "background",
  "storykeeper",
  "subagent",
  "subagent-research",
  "subagent-continuity",
  "subagent-planner",
])

// Per-call thinking hint for a model profile (or bare role): "enabled" for
// agents, "disabled" for everything else. Unknown profile names (e.g.
// "foreground-options") fall through to "disabled".
export function profileThinkingHint(profileName = "foreground") {
  return THINKING_ON_PROFILES.has(profileName) ? "enabled" : "disabled"
}

export function resolveModelProfile(profileName = "foreground", { env = settingsEnv() } = {}) {
  const profile = MODEL_PROFILES[profileName] || MODEL_PROFILES.foreground
  const override = modelProfileOverride(profileName, env)
  const role = override?.role || profile.role || "foreground"
  const route = providerRegistry.route({ role, env, providerId: override?.provider || "" })
  const provider = route.find((item) => item.keyConfigured) || route[0]
  // Custom providers carry their own model (entry defaultModel/background) and
  // are exempt from the global AI_SMALL_MODEL/AI_LARGE_MODEL pins, which only
  // ever name a built-in provider's model. Without this, a stale pin like
  // AI_SMALL_MODEL=deepseek-v4-flash would be sent to a custom endpoint and 400.
  const modelLookup = isCustomProvider(provider) ? null : firstEnv(env, profile.modelEnv)
  const model = override?.model || modelLookup?.value || provider?.model || ""
  return {
    id: profileName,
    role,
    model,
    modelSource: override ? "route" : (modelLookup?.name || provider?.id || "default"),
    costTier: profile.costTier || "unknown",
    purpose: profile.purpose || "",
    provider: provider ? publicProviderInfo(provider) : null,
    keyConfigured: Boolean(provider?.keyConfigured),
    providerPinned: Boolean(override?.provider),
    modelPinned: Boolean(override?.model || modelLookup?.value),
    temperature: override?.temperature,
    maxTokens: override?.maxTokens,
    timeoutMs: override?.timeoutMs,
    chunkTimeoutMs: override?.chunkTimeoutMs,
  }
}

export function listModelProfiles({ env = settingsEnv() } = {}) {
  return Object.keys(MODEL_PROFILES).map((name) => resolveModelProfile(name, { env }))
}

export function isKnownModelProfile(profileName) {
  return Object.hasOwn(MODEL_PROFILES, profileName)
}

export function listModelProfileIds() {
  return Object.keys(MODEL_PROFILES)
}

export function subagentModelProfile(subagentType = "continuity") {
  if (subagentType === "research") return "subagent-research"
  if (subagentType === "planner") return "subagent-planner"
  if (subagentType === "continuity") return "subagent-continuity"
  return "subagent"
}

function firstEnv(env, names = []) {
  for (const name of names) {
    if (env[name]) return { name, value: env[name] }
  }
  return null
}

function modelProfileOverride(profileName, env) {
  const routes = parseJsonObject(env.OPENOVEL_MODEL_PROFILE_ROUTES)
  const route = routes?.[profileName]
  if (!route) return null
  if (typeof route === "string") {
    const [provider, ...rest] = route.split("/")
    const model = rest.join("/")
    return compactRoute({ provider, model })
  }
  if (typeof route === "object" && !Array.isArray(route)) {
    return compactRoute(route)
  }
  return null
}

function compactRoute(route = {}) {
  const out = {
    provider: String(route.provider || "").trim(),
    model: String(route.model || "").trim(),
    role: ["foreground", "background"].includes(route.role) ? route.role : "",
    temperature: numberInRange(route.temperature, 0, 2),
    maxTokens: positiveInt(route.maxTokens),
    timeoutMs: positiveInt(route.timeoutMs),
    chunkTimeoutMs: positiveInt(route.chunkTimeoutMs),
  }
  return out.provider || out.model || out.role || hasRouteParams(out) ? out : null
}

function hasRouteParams(route) {
  return route.temperature !== undefined
    || route.maxTokens !== undefined
    || route.timeoutMs !== undefined
    || route.chunkTimeoutMs !== undefined
}

function positiveInt(value) {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function numberInRange(value, min, max) {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

function parseJsonObject(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
