import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_WEBSEARCH_PROVIDER,
  WebSearchProviderRegistry,
  webSearchProviderRegistry,
} from "../src/search/registry.js"

test("web search provider registry exposes built-in discovery providers", () => {
  const ids = webSearchProviderRegistry.all().map((provider) => provider.id)
  assert.equal(DEFAULT_WEBSEARCH_PROVIDER, "duckduckgo-html")
  assert.deepEqual(ids, [
    "duckduckgo-html",
    "kimi-search-service",
    "exa-mcp",
    "parallel-mcp",
    "anthropic-server-websearch",
    "custom-http-search",
  ])
})

test("web search default route starts with a free provider", () => {
  const route = webSearchProviderRegistry.route({ env: {} })
  assert.equal(route[0].id, "duckduckgo-html")
  assert.equal(route[0].billingMode, "free")
  assert.equal(route[0].configured, true)
})

test("web search routing resolves configured custom provider without hard-coded search implementation", () => {
  const diagnosis = webSearchProviderRegistry.diagnose({
    env: {
      OPENOVEL_WEBSEARCH_PROVIDER: "custom-http-search",
      CUSTOM_HTTP_SEARCH_URL: "https://search.example.test?q={query}",
    },
  })
  assert.equal(diagnosis.active[0].id, "custom-http-search")
  assert.equal(diagnosis.active[0].configured, true)
  assert.equal(diagnosis.active[0].baseUrl, "https://search.example.test?q={query}")
})

test("web search registry accepts new providers through the common interface", async () => {
  const registry = new WebSearchProviderRegistry()
  registry.register({
    id: "test-provider",
    name: "Test Provider",
    baseUrl: "memory://search",
    search: async (_config, input) => [
      {
        title: `Result for ${input.query}`,
        url: "https://example.com/result",
        snippet: "discovery snippet",
      },
    ],
  })

  const result = await registry.search({ query: "mars return", provider: "test-provider", env: {} })
  assert.equal(result.provider.id, "test-provider")
  assert.equal(result.results[0].url, "https://example.com/result")
})

test("web search registry defaults to ten results", async () => {
  const registry = new WebSearchProviderRegistry()
  registry.register({
    id: "default-limit-provider",
    name: "Default Limit Provider",
    baseUrl: "memory://search",
    search: async (_config, input) => {
      assert.equal(input.limit, 10)
      return Array.from({ length: input.limit }, (_, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: "",
      }))
    },
  })

  const result = await registry.search({ query: "default limit", provider: "default-limit-provider", env: {} })
  assert.equal(result.results.length, 10)
})
