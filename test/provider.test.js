import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { generateForegroundTurn, generateForegroundOptions } from "../src/lib/narrator.js"
import { getStorySnapshot, initializeStory, paths } from "../src/lib/storyStore.js"
import { chatMessage, hasModelKey, modelInfo, providerRoute, registerProvider } from "../src/provider/provider.js"

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_FOREGROUND_PROVIDER",
  "AI_BACKGROUND_PROVIDER",
  "AI_PROVIDER_ORDER",
  "AI_ALLOW_PAID_FALLBACK",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_SMALL_MODEL",
  "AI_LARGE_MODEL",
  "OPENOVEL_PROVIDER_CAPABILITIES",
  "OPENOVEL_MODEL_CAPABILITIES",
  "OPENOVEL_MODEL_PROFILE_ROUTES",
  "KIMI_API_KEY",
  "MIMO_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_THINKING",
  "DEEPSEEK_REASONING_EFFORT",
  "DEEPSEEK_CONCURRENCY",
  "KIMI_CONCURRENCY",
  "MIMO_CONCURRENCY",
  "XIAOMI_MIMO_CONCURRENCY",
  "AI_CONCURRENCY",
  "OPENAI_CONCURRENCY",
  "OPENOVEL_PROVIDER_CONCURRENCY",
  "OPENOVEL_CONFIG",
  "OPENOVEL_CONFIG_DIR",
  "OPENOVEL_CONFIG_CONTENT",
  "OPENOVEL_IGNORE_PROJECT_CONFIG",
  "AI_STORY_CONFIG",
  "AI_STORY_CONFIG_DIR",
  "AI_STORY_CONFIG_CONTENT",
  "OPENOVEL_HOME",
  "OPENOVEL_STORY_ROOT",
  "OPENOVEL_ROOT",
  "OPENOVEL_STORY_ID",
  "OPENOVEL_OPTIONS_ENABLED",
  "AI_STORY_HOME",
  "AI_STORY_ROOT",
  "AI_STORY_ID",
  "TEST_SLOW_KEY",
]

test("defaults to Kimi Code without requiring a vendor client", () => {
  withEnv({}, () => {
    const info = modelInfo()
    assert.equal(info.provider, "kimi-code")
    assert.equal(info.foreground, "kimi-for-coding")
    assert.equal(info.billingMode, "subscription-quota")
  })
})

test("MiMo Token Plan regions resolve to their official base URLs", () => {
  withEnv({}, () => {
    const routes = ["mimo-token-plan-cn", "mimo-token-plan-sgp", "mimo-token-plan-ams"].map((id) => {
      process.env.AI_PROVIDER = id
      return providerRoute({ role: "foreground" })[0]
    })
    assert.equal(routes[0].baseUrl, "https://token-plan-cn.xiaomimimo.com/v1")
    assert.equal(routes[1].baseUrl, "https://token-plan-sgp.xiaomimimo.com/v1")
    assert.equal(routes[2].baseUrl, "https://token-plan-ams.xiaomimimo.com/v1")
  })
})

test("pay-as-you-go fallback is skipped unless explicitly enabled", () => {
  withEnv(
    {
      AI_PROVIDER: "kimi-code",
      AI_PROVIDER_ORDER: "kimi-code,deepseek",
      DEEPSEEK_API_KEY: "sk-deepseek",
    },
    () => {
      assert.equal(hasModelKey(), false)
      assert.deepEqual(
        providerRoute({ role: "foreground" }).map((provider) => provider.id),
        ["kimi-code"],
      )
    },
  )

  withEnv(
    {
      AI_PROVIDER: "kimi-code",
      AI_PROVIDER_ORDER: "kimi-code,deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
    },
    () => {
      assert.equal(hasModelKey(), true)
      assert.deepEqual(
        providerRoute({ role: "foreground" }).map((provider) => provider.id),
        ["kimi-code", "deepseek"],
      )
    },
  )
})

test("AI_FOREGROUND_PROVIDER and AI_BACKGROUND_PROVIDER can be heterogeneous", () => {
  withEnv(
    {
      AI_FOREGROUND_PROVIDER: "kimi-code",
      AI_BACKGROUND_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      KIMI_API_KEY: "sk-kimi",
      DEEPSEEK_API_KEY: "sk-deepseek",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].id, "kimi-code")
      assert.equal(providerRoute({ role: "background" })[0].id, "deepseek")
    },
  )
})

test("AI_FOREGROUND_PROVIDER is retired — AI_PROVIDER wins for both roles", () => {
  // The settingsToEnv layer now explicitly strips AI_FOREGROUND_PROVIDER so
  // a stale shell env can't shadow the canonical AI_PROVIDER pin chosen via
  // Settings → API Keys. The legacy split-env behavior is intentionally gone.
  withEnv(
    {
      AI_PROVIDER: "kimi-code",
      AI_FOREGROUND_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      KIMI_API_KEY: "sk-kimi",
      DEEPSEEK_API_KEY: "sk-deepseek",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].id, "kimi-code")
      assert.equal(providerRoute({ role: "background" })[0].id, "kimi-code")
    },
  )
})

test("DEEPSEEK_CONCURRENCY overrides provider concurrency default", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      DEEPSEEK_CONCURRENCY: "8",
    },
    () => {
      const fg = providerRoute({ role: "foreground" })[0]
      const bg = providerRoute({ role: "background" })[0]
      assert.equal(fg.concurrency, 8)
      assert.equal(bg.concurrency, 8)
    },
  )
})

test("OPENOVEL_PROVIDER_CONCURRENCY is a global fallback for any provider", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      OPENOVEL_PROVIDER_CONCURRENCY: "6",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].concurrency, 6)
    },
  )
})

test("Provider-specific concurrency env wins over global fallback", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      DEEPSEEK_CONCURRENCY: "10",
      OPENOVEL_PROVIDER_CONCURRENCY: "2",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].concurrency, 10)
    },
  )
})

test("Invalid concurrency value falls back to provider default", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      DEEPSEEK_CONCURRENCY: "not-a-number",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].concurrency, 4)
    },
  )
})

test("AI_SMALL_MODEL and AI_LARGE_MODEL route foreground and background roles", () => {
  withEnv(
    {
      AI_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_SMALL_MODEL: "small-model",
      AI_LARGE_MODEL: "large-model",
    },
    () => {
      assert.equal(providerRoute({ role: "foreground" })[0].model, "small-model")
      assert.equal(providerRoute({ role: "background" })[0].model, "large-model")
    },
  )
})

test("global model override applies to the active provider only, not fallbacks", () => {
  withEnv(
    {
      AI_PROVIDER: "custom-openai",
      AI_PROVIDER_ORDER: "custom-openai,deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_SMALL_MODEL: "gpt-5.5",
    },
    () => {
      const route = providerRoute({ role: "foreground" })
      // route[0] is the primary; it honors AI_SMALL_MODEL. The deepseek fallback
      // keeps its own default (so it isn't asked for gpt-5.5, which it 400s on).
      assert.equal(route[0].id, "custom-openai")
      assert.equal(route[0].model, "gpt-5.5")
      assert.equal(route.find((provider) => provider.id === "deepseek")?.model, "deepseek-v4-flash")
    },
  )
})

test("chatMessage failover sends the fallback provider's own model, not the primary's pinned model", async () => {
  // Regression (init/background agent retry): AI_LARGE_MODEL / an explicit
  // caller model names a model in the PRIMARY provider's namespace. When the
  // primary stalls and the route falls over to deepseek, the fallback must use
  // ITS OWN model (deepseek-v4-pro), not inherit the primary's "gpt-5.5" — which
  // deepseek 400s on, silently killing the failover. The background/init agent
  // passes model: modelProfile.model explicitly into the tool loop, so the pin
  // reaches chatMessage as an explicit `model`.
  await withEnvAsync(
    {
      AI_BACKGROUND_PROVIDER: "custom-openai",
      AI_PROVIDER_ORDER: "custom-openai,deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_LARGE_MODEL: "gpt-5.5",
    },
    async () => {
      const previousFetch = globalThis.fetch
      const deepseekCalls = []
      let primaryAttempts = 0
      globalThis.fetch = async (url, options) => {
        if (String(url).includes("example.test")) {
          primaryAttempts++
          throw new Error("stream stalled for 60000ms")
        }
        deepseekCalls.push({ url: String(url), body: JSON.parse(options.body) })
        return okResponse()
      }
      try {
        const message = await chatMessage({
          role: "background",
          model: "gpt-5.5",
          messages: [{ role: "user", content: "init" }],
          maxAttempts: 1,
        })
        assert.equal(message.content, "ok", "failover to deepseek succeeded")
        assert.equal(primaryAttempts, 1, "primary tried once then failed over")
        assert.equal(deepseekCalls.length, 1, "deepseek fallback was called")
        assert.equal(
          deepseekCalls[0].body.model,
          "deepseek-v4-pro",
          "fallback keeps its own background model, not the primary's pinned gpt-5.5",
        )
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("Kimi Code request uses the stable model id", async () => {
  await withFetch(
    {
      AI_PROVIDER: "kimi-code",
      KIMI_API_KEY: "sk-kimi",
    },
    async (calls) => {
      await chatMessage({ messages: [{ role: "user", content: "hi" }] })
      assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/chat/completions")
      assert.equal(calls[0].body.model, "kimi-for-coding")
      assert.equal(calls[0].headers.Authorization, "Bearer sk-kimi")
      assert.equal(calls[0].body.max_tokens, 700)
    },
  )
})

test("MiMo request uses api-key auth and max_completion_tokens", async () => {
  await withFetch(
    {
      AI_PROVIDER: "mimo-token-plan-sgp",
      MIMO_API_KEY: "tp-mimo",
    },
    async (calls) => {
      await chatMessage({ messages: [{ role: "user", content: "hi" }], maxTokens: 123 })
      assert.equal(calls[0].url, "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions")
      assert.equal(calls[0].headers["api-key"], "tp-mimo")
      // Foreground role uses defaultModel (= "mimo-v2.5" now, was -pro);
      // -pro stays as defaultBackgroundModel for storykeeper/research.
      assert.equal(calls[0].body.model, "mimo-v2.5")
      assert.equal(calls[0].body.max_completion_tokens, 123)
      assert.equal(calls[0].body.max_tokens, undefined)
    },
  )
})

test("custom OpenAI-compatible provider keeps standard max_tokens", async () => {
  await withFetch(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async (calls) => {
      await chatMessage({ messages: [{ role: "user", content: "hi" }], maxTokens: 321 })
      assert.equal(calls[0].url, "https://example.test/v1/chat/completions")
      assert.equal(calls[0].body.model, "custom-model")
      assert.equal(calls[0].body.max_tokens, 321)
    },
  )
})

test("model profile route parameters become chat defaults", async () => {
  await withFetch(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      OPENOVEL_MODEL_PROFILE_ROUTES: JSON.stringify({
        summary: {
          provider: "custom-openai",
          model: "summary-model",
          role: "foreground",
          temperature: 0.22,
          maxTokens: 1234,
        },
      }),
    },
    async (calls) => {
      await chatMessage({ messages: [{ role: "user", content: "hi" }], modelProfile: "summary" })
      assert.equal(calls[0].body.model, "summary-model")
      assert.equal(calls[0].body.temperature, 0.22)
      assert.equal(calls[0].body.max_tokens, 1234)

      await chatMessage({
        messages: [{ role: "user", content: "hi" }],
        modelProfile: "summary",
        temperature: 0.7,
        maxTokens: 55,
      })
      assert.equal(calls[1].body.temperature, 0.7)
      assert.equal(calls[1].body.max_tokens, 55)
    },
  )
})

test("provider capabilities adapt request fields without vendor-specific clients", async () => {
  registerProvider({
    id: "test-limited-capabilities",
    name: "Test Limited Capabilities",
    kind: "openai-compatible",
    billingMode: "subscription-quota",
    baseUrl: "https://limited.test/v1",
    apiKeyEnv: ["TEST_SLOW_KEY"],
    defaultModel: "limited-model",
    capabilities: {
      request: {
        temperature: false,
        jsonMode: false,
      },
      limits: {
        outputTokens: 100,
      },
    },
  })

  await withFetch(
    {
      AI_PROVIDER: "test-limited-capabilities",
      TEST_SLOW_KEY: "sk-limited",
    },
    async (calls) => {
      await chatMessage({
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        maxTokens: 321,
        json: true,
      })
      assert.equal(calls[0].body.model, "limited-model")
      assert.equal(calls[0].body.max_tokens, 100)
      assert.equal(calls[0].body.temperature, undefined)
      assert.equal(calls[0].body.response_format, undefined)
    },
  )
})

test("provider capabilities route around providers that cannot satisfy required tools", async () => {
  registerProvider({
    id: "test-no-tools",
    name: "Test No Tools",
    kind: "openai-compatible",
    billingMode: "subscription-quota",
    baseUrl: "https://no-tools.test/v1",
    apiKeyEnv: ["TEST_SLOW_KEY"],
    defaultModel: "no-tools-model",
    capabilities: {
      request: {
        tools: false,
      },
    },
  })
  registerProvider({
    id: "test-with-tools",
    name: "Test With Tools",
    kind: "openai-compatible",
    billingMode: "subscription-quota",
    baseUrl: "https://with-tools.test/v1",
    apiKeyEnv: ["TEST_SLOW_KEY"],
    defaultModel: "with-tools-model",
    capabilities: {
      request: {
        tools: true,
      },
    },
  })

  await withFetch(
    {
      AI_PROVIDER: "test-no-tools",
      AI_PROVIDER_ORDER: "test-no-tools,test-with-tools",
      TEST_SLOW_KEY: "sk-tools",
    },
    async (calls) => {
      await chatMessage({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        toolChoice: "auto",
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, "https://with-tools.test/v1/chat/completions")
      assert.equal(calls[0].body.model, "with-tools-model")
      assert.equal(calls[0].body.tools.length, 1)
    },
  )
})

test("provider and model capability overrides can come from settings/env metadata", async () => {
  await withFetch(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_PROVIDER_CAPABILITIES: JSON.stringify({
        "custom-openai": {
          request: { temperature: false },
          limits: { outputTokens: 64 },
        },
      }),
      OPENOVEL_MODEL_CAPABILITIES: JSON.stringify({
        "custom-openai/custom-model": {
          request: { jsonMode: false },
          reasoning: { supported: true, effort: true },
        },
      }),
    },
    async (calls) => {
      const route = providerRoute({ role: "foreground" })
      assert.equal(route[0].capabilities.request.temperature, false)
      assert.equal(route[0].capabilities.request.jsonMode, false)
      assert.equal(route[0].capabilities.reasoning.supported, true)
      assert.equal(route[0].capabilities.limits.outputTokens, 64)

      await chatMessage({
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        maxTokens: 128,
        json: true,
      })
      assert.equal(calls[0].body.max_tokens, 64)
      assert.equal(calls[0].body.temperature, undefined)
      assert.equal(calls[0].body.response_format, undefined)
    },
  )
})

test("streaming retries pre-frame failures and succeeds without double-delivery", async () => {
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async () => {
      const previousFetch = globalThis.fetch
      const chunks = []
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) {
          // simulate a pre-frame network failure (DNS / TCP / 503)
          const err = new Error("fetch failed")
          throw err
        }
        return sseResponse([
          { id: "chatcmpl-test", choices: [{ delta: { content: "fresh" }, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ])
      }
      try {
        const message = await chatMessage({
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          onDelta: (delta) => chunks.push(delta.content),
        })
        assert.equal(attempt, 2, "should have retried exactly once")
        assert.equal(message.content, "fresh")
        // onDelta only fires for the successful attempt; no partial duplicate.
        assert.deepEqual(chunks, ["fresh"])
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("streaming skips malformed SSE frames instead of throwing the whole stream", async () => {
  // A single corrupted/truncated frame should not kill the whole batch. Skip
  // the bad frame and keep streaming.
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async () => {
      const previousFetch = globalThis.fetch
      const chunks = []
      globalThis.fetch = async () => {
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
            ))
            // a malformed frame in the middle of the stream
            controller.enqueue(encoder.encode("data: {oops truncat\n\n"))
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}\n\n`,
            ))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return { ok: true, status: 200, body }
      }
      try {
        const message = await chatMessage({
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          onDelta: (delta) => chunks.push(delta.content),
        })
        assert.equal(message.content, "hello world", "good frames flowed despite the bad one in the middle")
        assert.deepEqual(chunks, ["hello", " world"])
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

// Helper: a streamed response that delivers one content frame, then aborts
// mid-stream on the next pull (reader.read() rejects). Mirrors a chunk-stall.
function midStreamStallResponse(segment) {
  const encoder = new TextEncoder()
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: segment } }] })}\n\n`),
        )
        return
      }
      // The same abort the chunk-stall timer would raise (createChatMessage's
      // controller.abort), classified transient by isTransientError.
      throw new Error("stream stalled for 60000ms")
    },
  })
  return { ok: true, status: 200, body }
}

test("foreground stream resumes from the breakpoint after a mid-stream stall (断点续写)", async () => {
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async () => {
      const previousFetch = globalThis.fetch
      const chunks = []
      const bodies = []
      let attempt = 0
      globalThis.fetch = async (_url, options) => {
        attempt++
        bodies.push(JSON.parse(options.body))
        // Round 1 streams a partial then stalls; round 2 (the continuation) finishes.
        if (attempt === 1) return midStreamStallResponse("前半段。")
        return sseResponse([{ id: "x", choices: [{ delta: { content: "后半段。" }, finish_reason: "stop" }] }])
      }
      try {
        const message = await chatMessage({
          role: "foreground",
          messages: [{ role: "user", content: "继续故事" }],
          stream: true,
          onDelta: (delta) => chunks.push(delta.content),
        })
        assert.equal(attempt, 2, "stalled foreground stream resumes with a second (continuation) request")
        assert.equal(message.content, "前半段。后半段。", "continuation is stitched onto the partial the reader saw")
        assert.deepEqual(chunks, ["前半段。", "后半段。"], "onDelta sees each segment once — no replay of the partial")
        // The continuation request prefills the streamed partial as an assistant
        // turn and appends a resume instruction.
        const round2 = bodies[1].messages
        const prefill = round2.find((m) => m.role === "assistant")
        assert.ok(prefill && prefill.content === "前半段。", "continuation prefills the streamed partial as an assistant turn")
        assert.ok(
          round2.some((m) => m.role === "user" && /cut off/i.test(m.content)),
          "continuation appends a resume instruction",
        )
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("background stream retries the whole call from scratch after a mid-stream stall", async () => {
  await withEnvAsync(
    {
      AI_PROVIDER: "deepseek",
      AI_BACKGROUND_PROVIDER: "deepseek",
      AI_ALLOW_PAID_FALLBACK: "true",
      DEEPSEEK_API_KEY: "sk-deepseek",
      AI_LARGE_MODEL: "deepseek-v4-pro",
    },
    async () => {
      const previousFetch = globalThis.fetch
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        // Background onDelta only feeds progress/telemetry, so a mid-stream stall
        // retries from scratch (no breakpoint resume) and returns the clean re-run.
        if (attempt === 1) return midStreamStallResponse("half")
        return sseResponse([{ id: "x", choices: [{ delta: { content: "fresh whole answer" }, finish_reason: "stop" }] }])
      }
      try {
        const message = await chatMessage({
          role: "background",
          messages: [{ role: "user", content: "do work" }],
          stream: true,
        })
        assert.equal(attempt, 2, "mid-stream stall on a background call retries from scratch")
        assert.equal(message.content, "fresh whole answer", "background returns the clean re-run, not a stitched partial")
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground keeps the partial trimmed to the last complete paragraph when continuation is exhausted", async () => {
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async () => {
      const previousFetch = globalThis.fetch
      let attempt = 0
      // Every round stalls mid-stream; with 2 foreground rounds the assembled
      // partial is "第一段完整。\n\n第二段未完成且仍未结束" — its dangling final
      // paragraph is trimmed off, keeping the last COMPLETE paragraph.
      const segments = ["第一段完整。\n\n第二段未完", "成且仍未结束"]
      globalThis.fetch = async () => {
        const seg = segments[attempt] ?? "更多未完成内容"
        attempt++
        return midStreamStallResponse(seg)
      }
      try {
        const message = await chatMessage({
          role: "foreground",
          messages: [{ role: "user", content: "继续" }],
          stream: true,
          maxAttempts: 2,
        })
        assert.equal(message.content, "第一段完整。", "dangling incomplete final paragraph dropped; last complete paragraph kept")
        assert.ok(attempt >= 2, "continuation was attempted before keeping the partial")
        assert.equal(message._apiTelemetry?.recovered, true, "result is flagged as a recovered partial")
        assert.equal(message._apiTelemetry?.truncated, true)
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("streaming foreground requests record first and last frame timing", async () => {
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
    },
    async () => {
      const previousFetch = globalThis.fetch
      const chunks = []
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        assert.equal(body.stream, true)
        return sseResponse([
          { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
          { id: "chatcmpl-test", choices: [{ delta: { content: "{\"narration\":" } }] },
          { id: "chatcmpl-test", choices: [{ delta: { content: "\"ok\"}" }, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
        ])
      }
      try {
        const message = await chatMessage({
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          json: true,
          onDelta: (delta) => chunks.push(delta.content),
        })
        assert.equal(message.content, "{\"narration\":\"ok\"}")
        assert.deepEqual(chunks, ["{\"narration\":", "\"ok\"}"])
        assert.equal(message._apiTelemetry.streamed, true)
        assert.equal(message._apiTelemetry.frameCount, 4)
        assert.equal(typeof message._apiTelemetry.firstFrameMs, "number")
        assert.equal(typeof message._apiTelemetry.firstContentMs, "number")
        assert.equal(typeof message._apiTelemetry.lastFrameMs, "number")
        assert.equal(message._apiTelemetry.usage.prompt_tokens, 3)
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground no-options mode skips the choices model call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-no-options-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      const calls = []
      const chunks = []
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        calls.push(body)
        assert.equal(body.stream, true)
        return sseResponse([
          { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
          { id: "chatcmpl-test", choices: [{ delta: { content: "火星" } }] },
          { id: "chatcmpl-test", choices: [{ delta: { content: "居民推开舱门。" }, finish_reason: "stop" }] },
        ])
      }
      try {
        const turn = await generateForegroundTurn({
          action: "我决定自己输入下一步，不要选项。",
          snapshot,
          optionsEnabled: false,
          onNarrationChunk: (chunk) => chunks.push(chunk),
        })
        assert.equal(calls.length, 1)
        assert.equal(turn.narration, "火星居民推开舱门。")
        assert.deepEqual(turn.options, [])
        assert.deepEqual(chunks, ["火星", "居民推开舱门。"])
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground turn returns narration + options without writing context inserts", async () => {
  // narrator no longer owns context-insert writes. The
  // sessionProcessor pipeline handles that via planInsertManifest. This test
  // just verifies the narrator still emits narration + options correctly.
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-narrator-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      const calls = []
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        calls.push(body)
        if (body.stream) {
          return sseResponse([
            { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
            { id: "chatcmpl-test", choices: [{ delta: { content: "火星居民收起返航票。" }, finish_reason: "stop" }] },
          ])
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({ options: ["检查氧气额度"], tension: "departure-window" }),
                  },
                },
              ],
            }
          },
        }
      }

      try {
        const turn = await generateForegroundTurn({
          action: "我检查火星返航票，想回到地球。",
          snapshot,
          optionsEnabled: true,
        })
        // 1 streamed narrator call + 1 options call = 2 total. Context inserts
        // moved out of narrator (no extra calls here).
        assert.equal(calls.length, 2)
        assert.match(turn.narration, /火星居民/)
        assert.deepEqual(turn.options.map((o) => o.label), ["检查氧气额度"])
        // contextInserts is undefined here — sessionProcessor populates it later
        assert.equal(turn.contextInserts, undefined)
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground narration-complete hook starts before options and is not awaited", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-narrator-hook-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      const order = []
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.stream) {
          return sseResponse([
            { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
            { id: "chatcmpl-test", choices: [{ delta: { content: "雾灯照亮站台。" }, finish_reason: "stop" }] },
          ])
        }
        order.push("options-call")
        assert.equal(order.includes("hook"), true, "selector hook should start before options call")
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({ options: ["查看雾灯"], tension: "platform" }),
                  },
                },
              ],
            }
          },
        }
      }

      try {
        const turn = await generateForegroundTurn({
          action: "我停在站台边。",
          snapshot,
          optionsEnabled: true,
          onNarrationComplete: ({ narration, compiledContext }) => {
            order.push("hook")
            assert.equal(narration, "雾灯照亮站台。")
            assert.ok(compiledContext?.report, "hook receives compiled foreground context")
            return new Promise(() => {})
          },
        })
        assert.equal(turn.narration, "雾灯照亮站台。")
        assert.deepEqual(turn.options.map((o) => o.label), ["查看雾灯"])
        assert.deepEqual(order, ["hook", "options-call"])
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground options model can declare storyComplete; runtime threads the flag and suppresses options", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-story-complete-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      let optionsSystemPrompt = null
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.stream) {
          return sseResponse([
            { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
            { id: "chatcmpl-test", choices: [{ delta: { content: "她合上 iPad，灯光渐渐熄灭。" }, finish_reason: "stop" }] },
          ])
        }
        // options call — record system prompt and respond with storyComplete
        optionsSystemPrompt = body.messages?.find((m) => m.role === "system")?.content || ""
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      options: [],
                      tension: "story-complete",
                      storyComplete: true,
                    }),
                  },
                },
              ],
            }
          },
        }
      }
      try {
        const turn = await generateForegroundTurn({
          action: "我看着屏幕一行行变暗。",
          snapshot,
          optionsEnabled: true,
        })
        assert.equal(turn.storyComplete, true, "turn surfaces storyComplete flag")
        assert.deepEqual(turn.options, [], "options stay empty even though fallback would normally fill")
        assert.equal(turn.tension, "story-complete")
        assert.ok(
          optionsSystemPrompt.includes("storyComplete"),
          "options system prompt documents the storyComplete escape hatch",
        )
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground options model omitting storyComplete keeps normal options flow intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-story-not-complete-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.stream) {
          return sseResponse([
            { id: "chatcmpl-test", choices: [{ delta: { role: "assistant" } }] },
            { id: "chatcmpl-test", choices: [{ delta: { content: "她抬头看向门口。" }, finish_reason: "stop" }] },
          ])
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    // No storyComplete field at all
                    content: JSON.stringify({ options: ["走过去开门", "退一步"], tension: "rising" }),
                  },
                },
              ],
            }
          },
        }
      }
      try {
        const turn = await generateForegroundTurn({
          action: "我等。",
          snapshot,
          optionsEnabled: true,
        })
        assert.equal(turn.storyComplete, undefined, "no flag when model didn't set it")
        assert.deepEqual(turn.options.map((o) => o.label), ["走过去开门", "退一步"])
        assert.equal(turn.tension, "rising")
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground options drop a model option that repeats the reader's latest action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-opt-repeat-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.stream) {
          return sseResponse([
            { id: "c", choices: [{ delta: { role: "assistant" } }] },
            { id: "c", choices: [{ delta: { content: "她站在门前。" }, finish_reason: "stop" }] },
          ])
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    // First option verbatim-repeats the reader's latest action and
                    // must be filtered out regardless of prompt compliance.
                    content: JSON.stringify({ options: ["走过去开门", "退一步"], tension: "rising" }),
                  },
                },
              ],
            }
          },
        }
      }
      try {
        const turn = await generateForegroundTurn({ action: "走过去开门", snapshot, optionsEnabled: true })
        assert.deepEqual(turn.options.map((o) => o.label), ["退一步"], "latest-action duplicate dropped")
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("foreground options failure yields tension 'unavailable' distinct from 'unknown'", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-opt-fail-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      await initializeStory()
      const snapshot = await getStorySnapshot()
      const previousFetch = globalThis.fetch
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.stream) {
          return sseResponse([
            { id: "c", choices: [{ delta: { role: "assistant" } }] },
            { id: "c", choices: [{ delta: { content: "夜色压下来。" }, finish_reason: "stop" }] },
          ])
        }
        // The (non-streamed) options call fails — generateForegroundOptions
        // catches it and reports a distinct failure sentinel.
        throw new Error("options provider down")
      }
      try {
        const turn = await generateForegroundTurn({ action: "我等。", snapshot, optionsEnabled: true })
        assert.deepEqual(turn.options, [], "no options on failure (free-text path)")
        assert.equal(turn.tension, "unavailable", "failure tension is distinct from model 'unknown'")
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("generateForegroundOptions carries the failure error out (so the runtime can log it)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-opt-err-"))
  await withEnvAsync(
    {
      AI_PROVIDER: "custom-openai",
      AI_BASE_URL: "https://example.test/v1",
      AI_API_KEY: "sk-custom",
      AI_SMALL_MODEL: "custom-model",
      OPENOVEL_HOME: path.join(root, "home"),
      OPENOVEL_STORY_ROOT: path.join(root, "story"),
    },
    async () => {
      const previousFetch = globalThis.fetch
      globalThis.fetch = async () => { throw new Error("options provider down") }
      try {
        const res = await generateForegroundOptions({ action: "我等。", narration: "夜色压下来。", compiledContext: {}, snapshot: {} })
        assert.deepEqual(res.options, [])
        assert.equal(res.tension, "unavailable")
        // The error is no longer swallowed: it rides out so the runtime can route
        // it to the Error Log instead of the reader silently losing their choices.
        assert.match(res.error, /options provider down/)
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
})

test("DeepSeek V4 flash disables thinking and V4 pro enables thinking for background", async () => {
  await withFetch(
    {
      AI_PROVIDER: "deepseek",
      AI_BACKGROUND_PROVIDER: "deepseek",
      AI_SMALL_MODEL: "deepseek-v4-flash",
      AI_LARGE_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API_KEY: "sk-deepseek",
    },
    async (calls) => {
      const foreground = providerRoute({ role: "foreground" })[0]
      const background = providerRoute({ role: "background" })[0]
      assert.equal(foreground.capabilities.reasoning.supported, false)
      assert.equal(background.capabilities.reasoning.supported, true)
      assert.equal(background.capabilities.request.temperature, false)
      await chatMessage({ role: "foreground", messages: [{ role: "user", content: "hi" }] })
      await chatMessage({ role: "background", messages: [{ role: "user", content: "think" }] })
      assert.equal(calls[0].body.model, "deepseek-v4-flash")
      assert.deepEqual(calls[0].body.thinking, { type: "disabled" })
      assert.equal(calls[1].body.model, "deepseek-v4-pro")
      assert.deepEqual(calls[1].body.thinking, { type: "enabled" })
      assert.equal(calls[1].body.reasoning_effort, "high")
      assert.equal(calls[1].body.temperature, undefined)
    },
  )
})

test("provider semaphore limits concurrent model requests", async () => {
  registerProvider({
    id: "test-slow",
    name: "Test Slow",
    kind: "openai-compatible",
    billingMode: "subscription-quota",
    baseUrl: "https://slow.test/v1",
    apiKeyEnv: ["TEST_SLOW_KEY"],
    defaultModel: "slow-model",
    concurrency: 1,
    auth: { type: "bearer" },
  })

  const calls = []
  let active = 0
  let maxActive = 0
  await withEnvAsync(
    {
      AI_PROVIDER: "test-slow",
      TEST_SLOW_KEY: "sk-slow",
    },
    async () => {
      const previousFetch = globalThis.fetch
      globalThis.fetch = async (url, options) => {
        active++
        maxActive = Math.max(maxActive, active)
        calls.push({ url, body: JSON.parse(options.body) })
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
        return okResponse()
      }
      try {
        await Promise.all([
          chatMessage({ messages: [{ role: "user", content: "one" }] }),
          chatMessage({ messages: [{ role: "user", content: "two" }] }),
        ])
      } finally {
        globalThis.fetch = previousFetch
      }
    },
  )
  assert.equal(calls.length, 2)
  assert.equal(maxActive, 1)
})

async function withFetch(env, fn) {
  await withEnvAsync(env, async () => {
    const previousFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, options) => {
      calls.push({
        url,
        headers: options.headers,
        body: JSON.parse(options.body),
      })
      return okResponse()
    }
    try {
      await fn(calls)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "ok",
            },
          },
        ],
      }
    },
  }
}

function sseResponse(chunks) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    body,
  }
}

function withEnv(env, fn) {
  const saved = saveEnv()
  applyEnv(env)
  try {
    return fn()
  } finally {
    restoreEnv(saved)
  }
}

async function withEnvAsync(env, fn) {
  const saved = saveEnv()
  applyEnv(env)
  try {
    return await fn()
  } finally {
    restoreEnv(saved)
  }
}

function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function applyEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENOVEL_CONFIG_DIR = path.join(os.tmpdir(), "openovel-empty-config")
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}
