// Browser-side BYOK provider client for the GitHub Pages demo.
//
// The desktop runtime routes every model call through src/provider/provider.js
// (Node, undici, server-held keys). The web demo has no server — the reader
// brings their OWN key and the call goes straight from the browser to the
// provider. That only works for providers that send permissive CORS headers:
// OpenRouter and Anthropic (with its explicit browser-access header) do; most
// raw OpenAI-compatible endpoints (DeepSeek, Kimi, MiMo) do NOT, so we surface a
// clear "use a browser-capable provider or the desktop app" message instead of a
// cryptic network error.
//
// Two request shapes only: OpenAI-style /chat/completions and Anthropic
// /v1/messages, both streamed (SSE) so prose appears as it is written.

const DEFAULT_BASE = {
  deepseek: "https://api.deepseek.com",
  "kimi-code": "https://api.kimi.com/coding/v1",
  "mimo-token-plan-cn": "https://api.xiaomimimo.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
}

// Sensible default narration model per provider, used when the reader hasn't set
// one in Settings. Deliberately mainstream ids; the reader can override.
const DEFAULT_MODEL = {
  deepseek: "deepseek-chat",
  "kimi-code": "kimi-k2-0905-preview",
  "mimo-token-plan-cn": "mimo-7b-rl",
  openrouter: "anthropic/claude-3.5-sonnet",
  anthropic: "claude-3-5-sonnet-latest",
}

// Browser-call viability per provider (drives the Settings hint). "yes" = sends
// CORS headers; "header" = needs (and gets) a special opt-in header; "no" = will
// almost certainly be blocked by the browser; "maybe" = depends on the endpoint.
export const BROWSER_SUPPORT = {
  openrouter: "yes",
  anthropic: "header",
  "custom-openai": "maybe",
  "custom-anthropic": "maybe",
  deepseek: "no",
  "kimi-code": "no",
  "mimo-token-plan-cn": "no",
}

function isAnthropic(provider) {
  return provider === "anthropic" || provider === "custom-anthropic"
}

function joinUrl(base, suffix) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`
}

function resolveEndpoint(provider, baseUrl) {
  const base = baseUrl || DEFAULT_BASE[provider] || ""
  if (!base) return ""
  return isAnthropic(provider) ? joinUrl(base, "v1/messages") : joinUrl(base, "chat/completions")
}

// A network/CORS failure surfaces as a TypeError from fetch with no response.
function friendlyError(provider, err, status, body) {
  if (status === 401 || status === 403) return "API key was rejected (401/403). Check the key for this provider in Settings."
  if (status === 402) return "This provider reports the account is out of credit (402)."
  if (status === 429) return "Rate limited by the provider (429) — wait a moment and try again."
  if (status === 404) return "Model or endpoint not found (404). Check the model id and base URL in Settings."
  if (status >= 500) return `Provider server error (${status}). Try again shortly.`
  if (status) return `Request failed (${status})${body ? `: ${String(body).slice(0, 200)}` : ""}.`
  // No status → almost always CORS/network from the browser.
  const support = BROWSER_SUPPORT[provider]
  if (support === "no") {
    return `${provider} blocks direct browser calls (CORS). For the online demo use OpenRouter or Anthropic, or run the desktop app where any provider works.`
  }
  return "Couldn't reach the provider from the browser (likely a CORS/network block). Try OpenRouter or Anthropic, or use the desktop app."
}

// Parse one SSE `data:` payload and push any text delta to onDelta. Returns false
// on the stream-terminator, true otherwise.
function consumeSseLine(line, provider, onDelta) {
  if (!line.startsWith("data:")) return true
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return payload !== "[DONE]"
  let json
  try { json = JSON.parse(payload) } catch { return true }
  if (isAnthropic(provider)) {
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") onDelta(json.delta.text || "")
    if (json.type === "message_stop") return false
  } else {
    const delta = json.choices?.[0]?.delta?.content
    if (delta) onDelta(delta)
    if (json.choices?.[0]?.finish_reason) return true
  }
  return true
}

// Stream a completion. `messages` is the OpenAI-style array (with a leading
// system message); for Anthropic the system message is lifted to the top-level
// `system` param. Returns the full concatenated text; calls onDelta(token) as
// tokens arrive. Throws Error(friendlyMessage) on failure.
export async function streamChat({
  provider,
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.8,
  maxTokens = 1400,
  onDelta = () => {},
  signal,
}) {
  if (!apiKey) throw new Error("No API key set for this provider. Add one in Settings → API Keys.")
  const endpoint = resolveEndpoint(provider, baseUrl)
  if (!endpoint) throw new Error("No base URL for this provider. Set one in Settings → API Keys.")
  const useModel = model || DEFAULT_MODEL[provider] || ""
  if (!useModel) throw new Error("No model set for this provider. Set one in Settings → API Keys.")

  const headers = { "Content-Type": "application/json" }
  let body
  if (isAnthropic(provider)) {
    headers["x-api-key"] = apiKey
    headers["anthropic-version"] = "2023-06-01"
    headers["anthropic-dangerous-direct-browser-access"] = "true"
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
    const rest = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }))
    body = { model: useModel, system, messages: rest, max_tokens: maxTokens, temperature, stream: true }
  } else {
    headers.Authorization = `Bearer ${apiKey}`
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = typeof location !== "undefined" ? location.origin : "https://openovel.app"
      headers["X-Title"] = "openovel web demo"
    }
    body = { model: useModel, messages, temperature, max_tokens: maxTokens, stream: true }
  }

  let res
  try {
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal })
  } catch (err) {
    if (err?.name === "AbortError") throw err
    throw new Error(friendlyError(provider, err, 0, ""))
  }
  if (!res.ok) {
    let errText = ""
    try { errText = await res.text() } catch { /* ignore */ }
    throw new Error(friendlyError(provider, null, res.status, errText))
  }
  if (!res.body) {
    // No streaming body — fall back to a whole-response read.
    const data = await res.json().catch(() => null)
    const whole = isAnthropic(provider)
      ? (data?.content || []).map((b) => b.text || "").join("")
      : (data?.choices?.[0]?.message?.content || "")
    onDelta(whole)
    return whole
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let full = ""
  const collect = (t) => { full += t; onDelta(t) }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      if (!consumeSseLine(line, provider, collect)) { try { await reader.cancel() } catch { /* ignore */ } return full }
    }
  }
  if (buffer.trim()) consumeSseLine(buffer.trim(), provider, collect)
  return full
}
