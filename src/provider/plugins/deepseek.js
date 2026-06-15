import { settingsEnv } from "../../config/settings.js"

export const deepseekProvider = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "openai-compatible",
  billingMode: "pay-as-you-go",
  baseUrl: "https://api.deepseek.com",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  concurrencyEnv: ["DEEPSEEK_CONCURRENCY"],
  defaultModel: "deepseek-v4-flash",
  defaultBackgroundModel: "deepseek-v4-pro",
  concurrency: 4,
  capabilities: {
    response: {
      reasoningFields: ["reasoning_content"],
    },
  },
  modelCapabilities: {
    "deepseek-v4-flash": {
      reasoning: {
        supported: false,
        fields: ["reasoning_content"],
      },
      request: {
        temperature: true,
      },
      // V4-Flash supports up to 384K output per DeepSeek docs
      // (https://api-docs.deepseek.com/zh-cn/quick_start/pricing/).
      // The default capabilities cap of 8192 was silently clamping our
      // narrator (set to 32K) AND background workflows (storykeeper /
      // initializer / subagent all set 16K) down to 8K — wasting half the
      // configured budget on the background side and clipping rich prose
      // on the foreground side.
      limits: {
        outputTokens: 384000,
        contextTokens: 1000000,
      },
    },
    "deepseek-v4-pro": {
      reasoning: {
        supported: true,
        effort: true,
        fields: ["reasoning_content"],
      },
      request: {
        temperature: false,
      },
      response: {
        reasoningFields: ["reasoning_content"],
      },
      // V4-Pro same 384K output / 1M context limits as Flash.
      // Reasoning tokens count against the same output budget; storykeeper
      // batches with deep thinking now get the full budget they were
      // configured for instead of the silent 8192 cap.
      limits: {
        outputTokens: 384000,
        contextTokens: 1000000,
      },
    },
  },
  auth: {
    type: "bearer",
  },
  bodyTransform(body, { thinking } = {}) {
    const thinkingType = deepseekThinkingType(body.model, thinking)
    if (!thinkingType) return body

    const next = {
      ...body,
      thinking: { type: thinkingType },
    }
    if (thinkingType === "enabled") {
      delete next.temperature
      next.reasoning_effort = settingsEnv().DEEPSEEK_REASONING_EFFORT || "high"
    }
    return next
  },
  errorHints: {
    401: "DeepSeek API key is invalid or missing.",
    429: "DeepSeek rate limit reached.",
  },
}

function deepseekThinkingType(model, hint) {
  const value = String(model || "").toLowerCase()
  // Model-capability veto: the flash model cannot reason, so it stays
  // non-thinking even when a caller hints "enabled".
  if (value === "deepseek-v4-flash") return "disabled"
  // Per-call hint (from the call type / model profile) wins over env + model
  // defaults for thinking-capable models.
  if (hint === "disabled") return "disabled"
  if (hint === "enabled") return "enabled"
  const override = String(settingsEnv().DEEPSEEK_THINKING || "").toLowerCase()
  if (override === "enabled" || override === "disabled") return override
  if (value === "deepseek-v4-pro") return "enabled"
  return ""
}
