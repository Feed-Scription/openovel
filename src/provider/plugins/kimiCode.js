import { kimiCliHeaders } from "../kimiCliHeaders.js"
import { settingsEnv } from "../../config/settings.js"

// Toggle thinking mode for kimi-for-coding / kimi-code.
// Default: OFF — narrator latency is the priority; thinking adds seconds.
// Override: KIMI_THINKING=high|medium|low to enable + set effort, or =off to
// force off (same as default). The body fields mirror kimi-cli/kosong's
// `with_thinking()` exactly: `thinking.type` + optional `reasoning_effort`.
function kimiThinkingTransform(body, { thinking } = {}) {
  const raw = String(settingsEnv().KIMI_THINKING || "off").toLowerCase()
  const next = { ...body }
  // Per-call hint wins over the env default. "disabled"/"enabled" force the
  // call regardless of KIMI_THINKING; undefined falls back to the env default.
  const envOn = !(raw === "off" || raw === "disabled" || raw === "" || raw === "no" || raw === "false")
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

export const kimiCodeProvider = {
  id: "kimi-code",
  name: "Kimi Code",
  kind: "openai-compatible",
  billingMode: "subscription-quota",
  baseUrl: "https://api.kimi.com/coding/v1",
  apiKeyEnv: ["KIMI_API_KEY"],
  baseUrlEnv: ["KIMI_BASE_URL", "KIMI_CODE_BASE_URL"],
  concurrencyEnv: ["KIMI_CONCURRENCY"],
  defaultModel: "kimi-for-coding",
  defaultBackgroundModel: "kimi-for-coding",
  concurrency: 4,
  auth: {
    type: "bearer",
  },
  // Kimi For Coding gates access to the `kimi_cli` platform via these headers
  // — without them the endpoint returns 403 access_terminated_error. See
  // src/provider/kimiCliHeaders.js for the why and the Python reference.
  headers: kimiCliHeaders(),
  bodyTransform: kimiThinkingTransform,
  capabilities: {
    reasoning: {
      supported: true,
      effort: true,
      fields: ["reasoning_content"],
    },
    response: {
      reasoningFields: ["reasoning_content"],
    },
  },
  errorHints: {
    401: "Kimi Code API key is invalid or expired. Make sure it was created in the Kimi Code console.",
    402: "Kimi Code membership benefits are unavailable. Check subscription and quota status.",
    403: "Kimi For Coding endpoint rejected the request. If you see access_terminated_error, the kimi_cli platform headers may have failed validation — try clearing home/kimi-device-id (under your OPENOVEL_HOME directory) and retry.",
    429: "Kimi Code rate limit reached. Wait for the rolling window or lower background concurrency.",
  },
}
