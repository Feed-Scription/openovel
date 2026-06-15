// Any endpoint speaking the Anthropic Messages format (a proxy, gateway, or
// self-hosted server). baseUrl / key / model all come from env or the Settings
// preset. kind:"anthropic" routes through the translation adapter.
export const customAnthropicProvider = {
  id: "custom-anthropic",
  name: "Custom Anthropic",
  kind: "anthropic",
  billingMode: "unknown",
  baseUrl: "",
  apiKeyEnv: ["ANTHROPIC_API_KEY", "AI_API_KEY"],
  baseUrlEnv: ["ANTHROPIC_BASE_URL", "AI_BASE_URL"],
  concurrencyEnv: ["ANTHROPIC_CONCURRENCY", "AI_CONCURRENCY"],
  path: "/v1/messages",
  auth: { type: "api-key", header: "x-api-key" },
  headers: { "anthropic-version": "2023-06-01" },
  defaultModel: "",
  defaultBackgroundModel: "",
  concurrency: 4,
}
