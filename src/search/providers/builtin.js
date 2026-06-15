import { parseJsonObject } from "../../lib/json.js"

export const builtinWebSearchProviders = [
  {
    id: "duckduckgo-html",
    name: "DuckDuckGo HTML Search",
    kind: "http-html",
    billingMode: "free",
    baseUrl: "https://duckduckgo.com/html/",
    auth: { type: "none" },
    configured: () => true,
    async search(config, input) {
      const url = new URL(config.baseUrl)
      url.searchParams.set("q", input.query)
      const response = await fetch(url.href, {
        headers: {
          "User-Agent": "openovel/0.1",
          Accept: "text/html,text/plain,*/*;q=0.1",
        },
      })
      const html = await response.text()
      if (!response.ok) {
        throw new Error(`Search provider HTTP ${response.status}: ${html.slice(0, 500)}`)
      }
      return extractDuckDuckGoResults(html).slice(0, input.limit)
    },
  },
  {
    id: "kimi-search-service",
    name: "Kimi Search Service",
    kind: "http-json",
    billingMode: "subscription-quota",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiKeyEnv: ["KIMI_SEARCH_API_KEY", "KIMI_API_KEY"],
    baseUrlEnv: ["KIMI_SEARCH_BASE_URL", "KIMI_BASE_URL", "KIMI_CODE_BASE_URL"],
    auth: { type: "bearer" },
    configured: (config) => Boolean(config.apiKey && config.baseUrl),
    async search(config, input) {
      const response = await fetch(joinUrl(config.baseUrl, "/search"), {
        method: "POST",
        headers: {
          ...config.headers,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          text_query: input.query,
          limit: input.limit,
          enable_page_crawling: false,
          timeout_seconds: input.timeoutSeconds || 10,
        }),
      })
      return parseHttpSearchResponse(response)
    },
  },
  mcpProvider({
    id: "exa-mcp",
    name: "Exa MCP Search",
    apiKeyEnv: ["EXA_API_KEY", "EXA_MCP_API_KEY"],
    baseUrlEnv: ["EXA_MCP_URL", "OPENOVEL_EXA_MCP_URL"],
    toolNameEnv: ["EXA_MCP_TOOL", "OPENOVEL_EXA_MCP_TOOL"],
    defaultToolName: "web_search_exa",
  }),
  mcpProvider({
    id: "parallel-mcp",
    name: "Parallel MCP Search",
    apiKeyEnv: ["PARALLEL_API_KEY", "PARALLEL_MCP_API_KEY"],
    baseUrlEnv: ["PARALLEL_MCP_URL", "OPENOVEL_PARALLEL_MCP_URL"],
    toolNameEnv: ["PARALLEL_MCP_TOOL", "OPENOVEL_PARALLEL_MCP_TOOL"],
    defaultToolName: "web_search",
  }),
  {
    id: "anthropic-server-websearch",
    name: "Anthropic Server Web Search",
    kind: "anthropic-server-tool",
    billingMode: "pay-as-you-go",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    baseUrlEnv: ["ANTHROPIC_BASE_URL"],
    modelEnv: ["ANTHROPIC_SEARCH_MODEL", "ANTHROPIC_MODEL"],
    defaultModel: "claude-3-5-haiku-latest",
    auth: { type: "none" },
    configured: (config) => Boolean(config.apiKey && config.baseUrl && config.model),
    async search(config, input) {
      const response = await fetch(joinUrl(config.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 900,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                "Use web search for discovery only. Do not summarize full page contents.",
                `Query: ${input.query}`,
                `Return at most ${input.limit} source pages as strict JSON: { "results": [{ "title": string, "url": string, "snippet": string }] }`,
              ].join("\n"),
            },
          ],
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 1,
            },
          ],
        }),
      })
      const json = await parseJsonResponse(response)
      const text = Array.isArray(json.content)
        ? json.content
            .filter((block) => block?.type === "text")
            .map((block) => block.text || "")
            .join("\n")
        : ""
      return normalizeSearchResults(parseJsonObject(text, {}))
    },
  },
  {
    id: "custom-http-search",
    name: "Custom HTTP Search",
    kind: "http-json",
    billingMode: "custom",
    baseUrl: "",
    apiKeyEnv: ["CUSTOM_HTTP_SEARCH_API_KEY", "OPENOVEL_CUSTOM_HTTP_SEARCH_API_KEY"],
    baseUrlEnv: ["CUSTOM_HTTP_SEARCH_URL", "OPENOVEL_CUSTOM_HTTP_SEARCH_URL"],
    auth: { type: "bearer" },
    configured: (config) => Boolean(config.baseUrl),
    async search(config, input) {
      const method = String(config.env.CUSTOM_HTTP_SEARCH_METHOD || config.env.OPENOVEL_CUSTOM_HTTP_SEARCH_METHOD || "").toUpperCase()
      const url = customSearchUrl(config.baseUrl, input)
      const useGet = method ? method === "GET" : config.baseUrl.includes("{query}") || config.baseUrl.includes("{limit}")
      const response = await fetch(useGet ? url : config.baseUrl, {
        method: useGet ? "GET" : method || "POST",
        headers: {
          ...config.headers,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: useGet ? undefined : JSON.stringify({ query: input.query, limit: input.limit }),
      })
      return parseHttpSearchResponse(response)
    },
  },
]

function mcpProvider({ id, name, apiKeyEnv, baseUrlEnv, toolNameEnv, defaultToolName }) {
  return {
    id,
    name,
    kind: "mcp-json-rpc",
    billingMode: "external",
    baseUrl: "",
    apiKeyEnv,
    baseUrlEnv,
    toolNameEnv,
    defaultToolName,
    auth: { type: "bearer" },
    configured: (config) => Boolean(config.baseUrl),
    async search(config, input) {
      const toolName = firstEnv(config.env, toolNameEnv)?.value || defaultToolName
      const response = await fetch(config.baseUrl, {
        method: "POST",
        headers: {
          ...config.headers,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `search_${Date.now()}`,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: {
              query: input.query,
              limit: input.limit,
              num_results: input.limit,
              max_results: input.limit,
            },
          },
        }),
      })
      const json = await parseJsonResponse(response)
      const result = json.result || json
      if (result.structuredContent) return normalizeSearchResults(result.structuredContent)
      if (Array.isArray(result.content)) {
        return normalizeSearchResults(
          result.content.map((block) => block?.text || block?.content || "").filter(Boolean).join("\n"),
        )
      }
      return normalizeSearchResults(result)
    },
  }
}

async function parseHttpSearchResponse(response) {
  const json = await parseJsonResponse(response)
  return normalizeSearchResults(json)
}

async function parseJsonResponse(response) {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Search provider HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return parseJsonObject(text, {})
}

export function normalizeSearchResults(value) {
  if (typeof value === "string") {
    const parsed = parseJsonObject(value, null)
    if (parsed) return normalizeSearchResults(parsed)
    return extractUrlResults(value)
  }
  const items = Array.isArray(value)
    ? value
    : Array.isArray(value?.results)
      ? value.results
      : Array.isArray(value?.data)
        ? value.data
        : Array.isArray(value?.items)
          ? value.items
          : []

  return items
    .map((item) => {
      if (typeof item === "string") return { title: item, url: "", snippet: "" }
      return {
        title: compact(item.title || item.name || item.text || item.page_title || item.url || item.link),
        url: compact(item.url || item.link || item.href || item.source_url || item.page_url),
        snippet: compact(item.snippet || item.summary || item.text || item.description || item.content, 700),
        source: compact(item.source || item.provider || ""),
        publishedAt: compact(item.publishedAt || item.published_at || item.date || ""),
        score: typeof item.score === "number" ? item.score : undefined,
      }
    })
    .filter((item) => item.title && item.url)
}

function extractUrlResults(text) {
  const urls = [...String(text || "").matchAll(/https?:\/\/[^\s)>\]]+/g)].map((match) => match[0])
  return [...new Set(urls)].map((url) => ({ title: url, url, snippet: "" }))
}

function extractDuckDuckGoResults(html) {
  const blocks = String(html || "").split(/<div class="result[^"]*">/i).slice(1)
  return blocks
    .map((block) => {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      if (!titleMatch) return null
      return {
        title: decodeHtml(htmlToText(titleMatch[2] || "")),
        url: decodeSearchUrl(decodeHtml(titleMatch[1] || "")),
        snippet: decodeHtml(htmlToText(snippetMatch?.[1] || "")),
      }
    })
    .filter((item) => item?.title && item.url)
}

function decodeSearchUrl(value) {
  try {
    const url = new URL(value, "https://duckduckgo.com")
    const uddg = url.searchParams.get("uddg")
    return uddg || url.href
  } catch {
    return value
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
}

function customSearchUrl(template, input) {
  if (template.includes("{query}") || template.includes("{limit}")) {
    return template
      .replaceAll("{query}", encodeURIComponent(input.query))
      .replaceAll("{limit}", encodeURIComponent(String(input.limit)))
  }
  const url = new URL(template)
  url.searchParams.set("q", input.query)
  url.searchParams.set("limit", String(input.limit))
  return url.href
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`
}

function firstEnv(env, names = []) {
  for (const name of names) {
    if (env[name]) return { name, value: env[name] }
  }
  return null
}

function compact(value, maxChars = 300) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}
