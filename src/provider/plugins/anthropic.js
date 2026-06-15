// Official Anthropic (Claude) — Messages API. kind:"anthropic" routes through
// src/provider/anthropic.js (translation adapter) instead of the OpenAI client.
// Pay-as-you-go, so it stays out of DEFAULT_PROVIDER_ORDER — used only when
// pinned (AI_PROVIDER=anthropic) or AI_ALLOW_PAID_FALLBACK is on.
export const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic (Claude)",
  kind: "anthropic",
  billingMode: "pay-as-you-go",
  baseUrl: "https://api.anthropic.com",
  apiKeyEnv: ["ANTHROPIC_API_KEY", "AI_API_KEY"],
  baseUrlEnv: ["ANTHROPIC_BASE_URL", "AI_BASE_URL"],
  concurrencyEnv: ["ANTHROPIC_CONCURRENCY", "AI_CONCURRENCY"],
  path: "/v1/messages",
  // Anthropic auth is `x-api-key` + a required `anthropic-version` header.
  auth: { type: "api-key", header: "x-api-key" },
  headers: { "anthropic-version": "2023-06-01" },
  defaultModel: "claude-haiku-4-5",
  defaultBackgroundModel: "claude-sonnet-4-6",
  concurrency: 4,
}
