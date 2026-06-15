import { settingsEnv } from "../../config/settings.js"

const MIMO_DEFAULTS = {
  defaultModel: "mimo-v2.5",
  defaultBackgroundModel: "mimo-v2.5-pro",
  // Per-model vision input. MiMo v2.5 + v2-omni accept images (OpenAI image_url
  // / base64). Other models stay text-only (the default). Verified 2026-06-08;
  // MiMo-V2-Pro/Omni auto-migrate to V2.5. Glob patterns match versioned names.
  modelCapabilities: {
    "mimo-v2.5*": { modalities: { input: ["text", "image"] } },
    "mimo-v2-omni*": { modalities: { input: ["text", "image"] } },
  },
}

// Toggle thinking for MiMo models. Same protocol as Kimi For Coding —
// `thinking.type` plus optional `reasoning_effort`. All v2.5 models
// reason by default; we default OFF for narrator latency. Override via
// MIMO_THINKING=high|medium|low.
function mimoThinkingTransform(body, { thinking } = {}) {
  const raw = String(settingsEnv().MIMO_THINKING || "off").toLowerCase()
  const next = { ...body }
  const envOn = !(raw === "off" || raw === "disabled" || raw === "" || raw === "no" || raw === "false")
  // Per-call hint wins over the env default.
  const on = thinking === "enabled" ? true : thinking === "disabled" ? false : envOn
  if (!on) {
    next.thinking = { type: "disabled" }
    delete next.reasoning_effort
    return next
  }
  const effort = (raw === "low" || raw === "medium" || raw === "high") ? raw : "high"
  next.thinking = { type: "enabled" }
  next.reasoning_effort = effort
  return next
}

function tokenPlanProvider(region, label, baseUrl) {
  return {
    id: `mimo-token-plan-${region}`,
    name: `Xiaomi MiMo Token Plan (${label})`,
    kind: "openai-compatible",
    billingMode: "token-plan",
    baseUrl,
    apiKeyEnv: ["MIMO_API_KEY", "XIAOMI_MIMO_API_KEY"],
    baseUrlEnv: ["MIMO_BASE_URL", "XIAOMI_MIMO_BASE_URL"],
    concurrencyEnv: ["MIMO_CONCURRENCY", "XIAOMI_MIMO_CONCURRENCY"],
    ...MIMO_DEFAULTS,
    concurrency: 3,
    auth: {
      type: "api-key",
      header: "api-key",
    },
    maxTokensField: "max_completion_tokens",
    bodyTransform: mimoThinkingTransform,
    capabilities: {
      request: {
        maxTokensField: "max_completion_tokens",
      },
      reasoning: {
        supported: true,
        fields: ["reasoning_content"],
      },
      response: {
        reasoningFields: ["reasoning_content"],
      },
    },
    errorHints: {
      401: "MiMo Token Plan key is invalid. Token Plan keys start with tp- and cannot be mixed with pay-as-you-go keys. Some Token Plans are region-locked — try a different region.",
      402: "MiMo Token Plan quota or subscription is unavailable.",
      429: "MiMo Token Plan rate limit reached. Reduce background concurrency or retry later.",
    },
  }
}

export const mimoTokenPlanProviders = [
  tokenPlanProvider("cn", "China", "https://token-plan-cn.xiaomimimo.com/v1"),
  tokenPlanProvider("sgp", "Singapore", "https://token-plan-sgp.xiaomimimo.com/v1"),
  tokenPlanProvider("ams", "Europe", "https://token-plan-ams.xiaomimimo.com/v1"),
]

export const mimoApiProvider = {
  id: "mimo-api",
  name: "Xiaomi MiMo API",
  kind: "openai-compatible",
  billingMode: "pay-as-you-go",
  baseUrl: "https://api.xiaomimimo.com/v1",
  apiKeyEnv: ["MIMO_API_KEY", "XIAOMI_MIMO_API_KEY"],
  baseUrlEnv: ["MIMO_BASE_URL", "XIAOMI_MIMO_BASE_URL"],
  concurrencyEnv: ["MIMO_CONCURRENCY", "XIAOMI_MIMO_CONCURRENCY"],
  ...MIMO_DEFAULTS,
  concurrency: 3,
  auth: {
    type: "api-key",
    header: "api-key",
  },
  maxTokensField: "max_completion_tokens",
  bodyTransform: mimoThinkingTransform,
  capabilities: {
    request: {
      maxTokensField: "max_completion_tokens",
    },
    reasoning: {
      supported: true,
      fields: ["reasoning_content"],
    },
    response: {
      reasoningFields: ["reasoning_content"],
    },
  },
  errorHints: {
    401: "MiMo API key is invalid. Pay-as-you-go keys start with sk- and cannot be mixed with Token Plan keys.",
    402: "MiMo API account has insufficient balance.",
    429: "MiMo API rate limit reached.",
  },
}
