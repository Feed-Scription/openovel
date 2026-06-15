// Image generation through a small set of configurable provider adapters.
// Not a chat-model route — separate provider/mode, separate config. Honors the
// global undici proxy (installed in lib/networkProxy.js) automatically via fetch.
//
// Config (env, merged by settingsEnv): OPENOVEL_IMAGE_PROVIDER,
// OPENOVEL_IMAGE_BASE_URL, OPENOVEL_IMAGE_API_KEY, OPENOVEL_IMAGE_MODEL,
// optional OPENOVEL_IMAGE_PATH + OPENOVEL_IMAGE_SIZE + OPENOVEL_IMAGE_TIMEOUT_MS
// + OPENOVEL_IMAGE_WATERMARK (provider-stamped badge, default off).

import { settingsEnv } from "../config/settings.js"

// Image generation is slow (the per-attempt timeout lives on the resolved config,
// OPENOVEL_IMAGE_TIMEOUT_MS). Transient failures (rate-limit 429, gateway/server
// 5xx, network drop, timeout) are retried with exponential backoff; deterministic
// failures (other 4xx, an unparseable / wrong-shape body) are surfaced at once,
// since retrying the identical prompt would only fail the same way.
const IMAGE_MAX_ATTEMPTS = 3 // 1 initial + 2 retries on transient failures
const IMAGE_RETRY_BASE_MS = 2000 // backoff: 2s, then 4s

export const IMAGE_PROVIDER_PRESETS = {
  volcengine: {
    id: "volcengine",
    label: "Volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    path: "/images/generations",
    model: "doubao-seedream-5-0-260128",
    size: "2K",
    request: "volcengine-images",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    path: "/chat/completions",
    model: "",
    size: "1K",
    request: "openrouter-chat",
  },
  custom: {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    path: "/images/generations",
    model: "",
    size: "1024x1024",
    request: "openai-images",
  },
}

export function normalizeImageProvider(value) {
  const id = String(value || "custom").trim().toLowerCase()
  // User-defined endpoints ("custom:<slug>", managed by imageSettingsStore)
  // keep their id; they resolve with the custom preset's request shape and the
  // entry's own baseUrl/model/path/size compiled into the flat envs.
  if (id.startsWith("custom:")) return id
  if (id === "customer") return "custom"
  return IMAGE_PROVIDER_PRESETS[id] ? id : "custom"
}

function providerApiKey(provider, env) {
  if (env.OPENOVEL_IMAGE_API_KEY) return String(env.OPENOVEL_IMAGE_API_KEY)
  if (provider === "volcengine") return String(env.ARK_API_KEY || env.VOLCENGINE_API_KEY || "")
  if (provider === "openrouter") return String(env.OPENROUTER_API_KEY || "")
  return ""
}

export function resolveImageConfig(env = settingsEnv()) {
  const provider = normalizeImageProvider(env.OPENOVEL_IMAGE_PROVIDER)
  // custom:<slug> entries share the generic OpenAI-images preset shape.
  const preset = IMAGE_PROVIDER_PRESETS[provider] || IMAGE_PROVIDER_PRESETS.custom
  return {
    provider,
    request: preset.request,
    baseUrl: String(env.OPENOVEL_IMAGE_BASE_URL || preset.baseUrl || "").replace(/\/+$/, ""),
    apiKey: providerApiKey(provider, env),
    model: String(env.OPENOVEL_IMAGE_MODEL || preset.model || ""),
    path: String(env.OPENOVEL_IMAGE_PATH || preset.path || "/images/generations"),
    size: String(env.OPENOVEL_IMAGE_SIZE || preset.size || "1024x1024"),
    // Generation can be slow (observed up to ~4-5 min on some providers/sizes),
    // so a tight timeout just guarantees failure. Default 5 min, override with
    // OPENOVEL_IMAGE_TIMEOUT_MS for slower models. Timeouts are retried (transient).
    timeoutMs: Math.max(1, Number(env.OPENOVEL_IMAGE_TIMEOUT_MS) || 300 * 1000),
    // Provider-stamped corner badge ("AI生成" on Volcengine). Off by default:
    // it defeats the contracts' no-watermark rule on covers/backdrops. Local
    // personal reading needs no mark; operators distributing generated images
    // publicly can opt back in (mainland China labeling rules) with
    // OPENOVEL_IMAGE_WATERMARK=1.
    watermark: /^(1|true|yes|on)$/i.test(String(env.OPENOVEL_IMAGE_WATERMARK || "")),
  }
}

export function hasImageKey(env = settingsEnv()) {
  const c = resolveImageConfig(env)
  return Boolean(c.baseUrl && c.apiKey)
}

export function hasImageGenerationConfig(env = settingsEnv()) {
  const c = resolveImageConfig(env)
  return Boolean(c.baseUrl && c.apiKey && c.model)
}

// The image format the configured provider actually emits. Volcengine
// seedream returns jpeg (4.5/4.0 always; 5.0-lite by default), so callers
// that must NAME the output file before generating (the comic panel
// pipeline injects paths into the script) pick the extension from here
// instead of assuming png and failing the byte-sniff afterwards.
export function expectedImageKind(env = settingsEnv()) {
  const c = resolveImageConfig(env)
  if (c.request === "volcengine-images") return "jpeg"
  return "png"
}

// Whether the configured provider's request shape can carry reference images
// (identity/style anchors) alongside the prompt. Volcengine seedream takes an
// `image` array (URL or data URL, up to 14); OpenRouter chat takes image_url
// content parts. The plain OpenAI /images/generations shape has no slot for
// references, so they are skipped there (callers surface that, never silently).
export function supportsReferenceImages(env = settingsEnv()) {
  const c = resolveImageConfig(env)
  return c.request === "volcengine-images" || c.request === "openrouter-chat"
}

function dataUrlToBuffer(value) {
  const match = String(value || "").match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i)
  return match ? Buffer.from(match[1].replace(/\s/g, ""), "base64") : null
}

// Pull image bytes (or a {url}) out of known image-generation response shapes:
// OpenAI Images, Volcengine Ark Images, OpenRouter chat image output, plus a
// tolerant fallback chain for OpenAI-like providers.
export function extractImageResult(data) {
  const chatImage = data?.choices?.[0]?.message?.images?.[0] || data?.message?.images?.[0] || null
  const first = data?.data?.[0] || data?.images?.[0] || data?.output?.images?.[0] || chatImage || null
  const urlish =
    first?.image_url?.url ||
    first?.imageUrl?.url ||
    first?.url ||
    data?.url ||
    (typeof first === "string" && (/^(?:https?:|data:image\/)/i.test(first)) ? first : null)
  const dataUrl = dataUrlToBuffer(urlish)
  if (dataUrl) return dataUrl
  if (urlish && /^https?:\/\//.test(String(urlish))) return { url: String(urlish) }
  // b64_json (preferred — no second hop)
  const b64 = first?.b64_json || data?.b64_json || (typeof first === "string" && !/^https?:\/\//.test(first) ? first : null)
  if (b64) return Buffer.from(b64, "base64")
  return null
}

// Cap on reference images per call. Volcengine allows up to 14, but each ref
// adds upload weight and latency; identity anchoring needs only the few
// character sheets actually relevant.
export const REFERENCE_IMAGE_CAP = 5

// Returns a Buffer of image bytes, or { url } when the provider returned a URL
// (the caller routes that through the validated download path). Throws on
// missing config or an unparseable response.
//
// `referenceImages` (optional): [{ mediaType, base64 }] identity/style anchor
// images (e.g. character sheets) the generation should stay consistent with.
// Carried where the provider's request shape supports it (see
// supportsReferenceImages); silently impossible shapes simply omit them —
// CALLERS that need to surface the omission check supportsReferenceImages().
export async function generateImageBytes({ prompt, size, referenceImages, env = settingsEnv() } = {}) {
  const c = resolveImageConfig(env)
  if (!c.baseUrl || !c.apiKey || !c.model) {
    throw new Error("image generation is not configured — set OPENOVEL_IMAGE_PROVIDER, OPENOVEL_IMAGE_API_KEY, and OPENOVEL_IMAGE_MODEL; custom providers also need OPENOVEL_IMAGE_BASE_URL")
  }
  const body = imageRequestBody(c, { prompt, size, referenceImages })
  const data = await postJson(`${c.baseUrl}${c.path}`, c.apiKey, body, c.timeoutMs)
  const result = extractImageResult(data)
  if (!result) throw new Error("image API response had no b64_json / url / images[0]")
  return result
}

// Volcengine seedream WIDTHxHEIGHT constraints: total pixels must sit inside
// [2560x1440, 4096x4096] (5.0-lite/4.5 floors; 4.0 accepts lower, but a value
// normalized into this window stays valid there too). A request below the
// floor is the most common agent/operator error (the 1024x1024 habit from
// other providers), and it fails the whole generation with HTTP 400 — so
// instead of failing, scale the requested box PROPORTIONALLY into the window:
// aspect ratio preserved, dimensions rounded to multiples of 8 (ceil when
// growing so the floor is guaranteed, floor when shrinking so the ceiling is).
// Named resolutions (2K/3K/4K) and unparseable values pass through untouched.
const VOLC_MIN_PIXELS = 2560 * 1440
const VOLC_MAX_PIXELS = 4096 * 4096

export function normalizePixelSize(value, { minPixels = VOLC_MIN_PIXELS, maxPixels = VOLC_MAX_PIXELS } = {}) {
  const m = String(value || "").trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!m) return String(value || "")
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return String(value || "")
  const px = w * h
  let k = 1
  if (px < minPixels) k = Math.sqrt(minPixels / px)
  else if (px > maxPixels) k = Math.sqrt(maxPixels / px)
  if (k === 1) return `${w}x${h}`
  const grow = k > 1
  const round8 = (n) => Math.max(8, (grow ? Math.ceil(n / 8) : Math.floor(n / 8)) * 8)
  return `${round8(w * k)}x${round8(h * k)}`
}

function referenceDataUrls(referenceImages) {
  return (Array.isArray(referenceImages) ? referenceImages : [])
    .filter((r) => r && r.base64)
    .slice(0, REFERENCE_IMAGE_CAP)
    .map((r) => `data:${r.mediaType || "image/png"};base64,${r.base64}`)
}

export function imageRequestBody(config, { prompt, size, referenceImages } = {}) {
  const text = String(prompt || "")
  const requestedSize = String(size || config.size)
  const refs = referenceDataUrls(referenceImages)
  if (config.request === "volcengine-images") {
    const body = {
      model: config.model,
      prompt: text,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: normalizePixelSize(requestedSize),
      stream: false,
      watermark: config.watermark,
    }
    // seedream reference input: single string or array of URL / data URL.
    if (refs.length) body.image = refs.length === 1 ? refs[0] : refs
    return body
  }
  if (config.request === "openrouter-chat") {
    const content = refs.length
      ? [{ type: "text", text }, ...refs.map((url) => ({ type: "image_url", image_url: { url } }))]
      : text
    const body = {
      model: config.model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      stream: false,
    }
    if (requestedSize) body.image_config = { image_size: requestedSize }
    return body
  }
  // Plain OpenAI /images/generations has no reference slot; refs are omitted
  // (callers gate on supportsReferenceImages to surface that).
  return {
    model: config.model,
    prompt: text,
    n: 1,
    size: requestedSize,
    response_format: "b64_json",
  }
}

// A failure worth retrying with the same prompt: rate limiting, gateway/server
// errors, network drops, and timeouts. Carries the HTTP status when there was one.
class TransientImageError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = "TransientImageError"
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postJsonOnce(url, apiKey, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      // AbortError (our timeout) or a network-level failure: both transient.
      const why = controller.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err?.message || String(err))
      throw new TransientImageError(`image API request failed: ${why}`)
    }
    const text = await response.text()
    if (!response.ok) {
      const detail = `image API HTTP ${response.status}: ${text.slice(0, 300)}`
      // 429 (rate limit) and 5xx (gateway/server) are transient; other 4xx are not.
      if (response.status === 429 || response.status >= 500) throw new TransientImageError(detail, response.status)
      throw new Error(detail)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`image API returned non-JSON: ${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(url, apiKey, body, timeoutMs = 300 * 1000) {
  for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt++) {
    try {
      return await postJsonOnce(url, apiKey, body, timeoutMs)
    } catch (err) {
      const transient = err instanceof TransientImageError || err?.name === "AbortError"
      if (!transient || attempt === IMAGE_MAX_ATTEMPTS) throw err
      await sleep(IMAGE_RETRY_BASE_MS * 2 ** (attempt - 1))
    }
  }
}
