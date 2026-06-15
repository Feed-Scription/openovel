export const customOpenAIProvider = {
  id: "custom-openai",
  name: "Custom OpenAI Compatible",
  kind: "openai-compatible",
  billingMode: "unknown",
  baseUrl: "",
  apiKeyEnv: ["AI_API_KEY", "OPENAI_API_KEY"],
  baseUrlEnv: ["AI_BASE_URL", "OPENAI_BASE_URL"],
  concurrencyEnv: ["AI_CONCURRENCY", "OPENAI_CONCURRENCY"],
  defaultModel: "",
  defaultBackgroundModel: "",
  concurrency: 4,
  auth: {
    type: "bearer",
  },
}
