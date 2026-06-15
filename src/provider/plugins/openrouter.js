// OpenRouter — OpenAI-compatible gateway that fronts many model providers.
// Split out from the generic custom-openai plugin so it owns its own key
// slot (OPENROUTER_API_KEY) — sharing AI_API_KEY meant switching between
// the DeepSeek / OpenRouter / Custom URL presets silently overwrote keys.

export const openrouterProvider = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "openai-compatible",
  billingMode: "pay-as-you-go",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnv: ["OPENROUTER_API_KEY"],
  baseUrlEnv: ["OPENROUTER_BASE_URL"],
  concurrencyEnv: ["OPENROUTER_CONCURRENCY"],
  defaultModel: "",
  defaultBackgroundModel: "",
  concurrency: 4,
  auth: { type: "bearer" },
  errorHints: {
    401: "OpenRouter API key is invalid or missing.",
    402: "OpenRouter credits exhausted — top up at https://openrouter.ai/credits.",
    429: "OpenRouter rate limit reached.",
  },
}
