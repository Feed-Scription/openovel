// Shared retry helper for transient provider failures (DeepSeek/Kimi/OpenAI etc.
// occasionally return AbortError, "fetch failed", 5xx, rate-limit). Used by
// chatCompletion (main path) and storyJudge. Same policy as opencode's
// retry-with-backoff — matches what mature agent runtimes do at the API layer.

// With exponential backoff capped at 30s, 8 attempts covers roughly two
// minutes of total wait. That is long enough to survive brief network/provider
// hiccups without dropping accumulated background-agent work.
export const DEFAULT_RETRY_MAX_ATTEMPTS = 8
export const DEFAULT_RETRY_BASE_DELAY_MS = 2000
export const DEFAULT_RETRY_MAX_DELAY_MS = 30000

export function isTransientError(error) {
  if (!error) return false
  const text = String(error?.message || error || "").toLowerCase()
  if (error.name === "AbortError") return true
  if (
    text.includes("aborted") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("epipe") ||
    text.includes("socket hang up") ||
    text.includes("fetch failed") ||
    text.includes("network error") ||
    text.includes("network request failed") ||
    // DNS / network reachability errors. Brief reconnects can surface as
    // ENOTFOUND, EAI_AGAIN, or getaddrinfo failures; treat them as retryable.
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("enetunreach") ||
    text.includes("getaddrinfo") ||
    text.includes("ehostunreach") ||
    text.includes("econnrefused") ||
    // undici's "terminated" can surface when the server closes an HTTP stream
    // mid-flight. Treat it as a transient close rather than a fatal provider
    // failure.
    text === "terminated" ||
    /\bterminated\b/.test(text) ||
    // Our AbortController emits this when no bytes arrive for chunkTimeoutMs.
    // It is retryable for the same reason as other transient stalls.
    text.includes("stream stalled") ||
    // Symmetric with the chunk-stall abort above: createChatMessage's
    // overall-deadline abort ("overall timeout after Nms") is the same kind of
    // transient, retryable timeout, not a fatal error. Without this entry a
    // non-streaming call that trips the overall timer was treated as fatal and
    // never retried (unlike the stall timer, which was already retryable).
    text.includes("overall timeout") ||
    /\brate.?limit/.test(text) ||
    /\btoo many requests/.test(text)
  ) return true
  // 5xx status code patterns
  if (/\b5\d{2}\b/.test(text)) return true
  if (Number.isFinite(error.status) && error.status >= 500 && error.status < 600) return true
  if (Number.isFinite(error.status) && error.status === 429) return true
  return false
}

export async function withRetry(
  fn,
  {
    maxAttempts = DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    label = "call",
    onRetry,
    isRetryable = isTransientError,
  } = {},
) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const transient = isRetryable(error)
      if (!transient || attempt === maxAttempts) throw error
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const message = String(error?.message || error || "").slice(0, 160)
      if (typeof onRetry === "function") {
        onRetry({ attempt, maxAttempts, delay, error })
      } else {
        console.warn(`[retry:${label}] attempt ${attempt}/${maxAttempts} failed: ${message}. retrying in ${delay}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}
