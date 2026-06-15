import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CUSTOM_PROVIDERS_ENV,
  customProviderKeyEnv,
  customProviderBaseUrlEnv,
  normalizeCustomProvidersList,
} from "../provider/customProviders.js"

const PROJECT_DIR = ".openovel"
const LEGACY_PROJECT_DIR = ".ai-story"
const CONFIG_FILENAMES = ["settings.jsonc", "settings.json", "config.jsonc", "config.json"]

const DEFAULT_SETTINGS = {
  provider: {
    foreground: "kimi-code",
    background: "",
    order: ["kimi-code", "mimo-token-plan-sgp", "mimo-token-plan-cn", "mimo-token-plan-ams"],
    allowPaidFallback: false,
    baseUrl: "",
    capabilities: {},
    modelCapabilities: {},
    providers: {},
    // User-defined custom LLM endpoints (Settings → API Keys, advanced).
    // Each: { id: "custom:<slug>", name, kind: "openai-compatible"|"anthropic",
    // baseUrl, defaultModel, defaultBackgroundModel }. API keys live in the
    // standard providers[<id>].apiKey slot above, NOT here.
    customProviders: [],
  },
  modelProfiles: {
    small: "",
    large: "",
    routes: {},
  },
  agents: {
    residentTeam: true,
    overrides: {},
  },
  workspace: {
    home: "",
    storyRoot: "",
    storyId: "",
  },
  tui: {
    optionsEnabled: true,
    displayPacing: true,
    displayCpm: 720,
    displayFrameMs: 80,
    punctuationPauses: true,
  },
  tools: {
    bash: false,
    // Opt-in: let the background loop author a per-story rich-render "format
    // contract" (ovl: fenced blocks + scoped CSS). Off by default. See
    // lib/formatContract.js.
    formatContract: false,
    // Opt-in (experimental): the background Image agent finds/generates images
    // into story/includes/ ahead of the plot, and vision-capable models can
    // read images. Off by default. Implies formatContract + storyIncludes (so
    // the prepared images actually render). See lib/formatContract.js.
    imageGen: false,
    // Opt-in (experimental): the background Music agent curates a forward-looking
    // catalog of immersive music the narrator cues by semantic short id; the
    // now-playing bar streams it via a privileged resolver. Off by default.
    // Independent of formatContract (the ovl:music cue fence is a narration
    // control channel). Provider creds ride OPENOVEL_MUSIC_* / Settings → Music.
    musicGen: false,
    permissions: {
      askFallback: "deny",
      rules: [],
    },
  },
  webSearch: {
    provider: "duckduckgo-html",
    order: ["duckduckgo-html", "custom-http-search", "kimi-search-service", "exa-mcp", "parallel-mcp"],
    writeResults: true,
    providers: {},
  },
  image: {
    generation: {
      provider: "custom",
      baseUrl: "",
      apiKey: "",
      model: "",
      // Empty so the provider preset's path + size apply (e.g. volcengine wants
      // size "2K"). A hardcoded default here would be emitted to OPENOVEL_IMAGE_*
      // and override the preset, forcing every provider to 1024x1024.
      path: "",
      size: "",
    },
  },
  server: {
    port: 4317,
  },
}

export function loadSettings({ cwd = process.cwd(), env = process.env } = {}) {
  const layers = discoverSettingsLayers({ cwd, env })
  let settings = structuredClone(DEFAULT_SETTINGS)
  const sources = []
  const errors = []

  for (const layer of layers) {
    const loaded = loadSettingsLayer(layer, env)
    if (loaded.error) {
      errors.push(loaded.error)
      continue
    }
    if (!loaded.settings) continue
    settings = mergeSettings(settings, loaded.settings)
    sources.push({ source: layer.source, path: layer.path || "", kind: layer.kind })
  }

  const envPatch = settingsFromEnv(env)
  if (Object.keys(envPatch).length) {
    settings = mergeSettings(settings, envPatch)
    sources.push({ source: "environment", path: "", kind: "env" })
  }

  return {
    settings,
    env: settingsToEnv(settings, env),
    sources,
    errors,
    paths: {
      globalDir: globalConfigDir(env),
      globalDirs: globalConfigDirs(env),
      projectDirs: projectConfigDirs(cwd),
    },
  }
}

export function getSettings() {
  return loadSettings().settings
}

export function settingsEnv() {
  return loadSettings().env
}

export function diagnoseSettings() {
  const loaded = loadSettings()
  return {
    sources: loaded.sources,
    errors: loaded.errors,
    paths: loaded.paths,
    settings: redactSettings(loaded.settings),
  }
}

function discoverSettingsLayers({ cwd, env }) {
  const layers = []
  for (const dir of globalConfigDirs(env)) {
    for (const file of configFilesInDir(dir, "global")) {
      layers.push({ kind: "global", source: "global", path: file })
    }
  }

  // Tests + diagnostic tooling can suppress project-local config discovery
  // (./.openovel/*.jsonc walked up from cwd) when they need to assert behavior
  // against a clean baseline. Global ~/.openovel and env vars still apply.
  if (!["1", "true", "yes", "on"].includes(String(env.OPENOVEL_IGNORE_PROJECT_CONFIG || "").toLowerCase())) {
    for (const dir of projectConfigDirs(cwd)) {
      for (const file of configFilesInDir(dir, "project")) {
        if (path.basename(file).includes(".local.")) continue
        layers.push({ kind: "project", source: "project", path: file })
      }
      for (const file of configFilesInDir(dir, "local")) {
        if (!path.basename(file).includes(".local.")) continue
        layers.push({ kind: "local", source: "local", path: file })
      }
    }
  }

  if (env.AI_STORY_CONFIG) {
    layers.push({ kind: "flag", source: "AI_STORY_CONFIG", path: path.resolve(cwd, env.AI_STORY_CONFIG) })
  }
  if (env.OPENOVEL_CONFIG) {
    layers.push({ kind: "flag", source: "OPENOVEL_CONFIG", path: path.resolve(cwd, env.OPENOVEL_CONFIG) })
  }
  if (env.AI_STORY_CONFIG_CONTENT) {
    layers.push({ kind: "inline", source: "AI_STORY_CONFIG_CONTENT", text: env.AI_STORY_CONFIG_CONTENT })
  }
  if (env.OPENOVEL_CONFIG_CONTENT) {
    layers.push({ kind: "inline", source: "OPENOVEL_CONFIG_CONTENT", text: env.OPENOVEL_CONFIG_CONTENT })
  }

  return dedupeLayers(layers)
}

function configFilesInDir(dir, kind) {
  const names = kind === "local" ? ["settings.local.jsonc", "settings.local.json"] : CONFIG_FILENAMES
  return names.map((name) => path.join(dir, name)).filter((file) => existsSync(file))
}

function projectConfigDirs(cwd) {
  const dirs = []
  const ancestors = []
  let current = path.resolve(cwd)
  while (true) {
    ancestors.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const dir of ancestors) {
    for (const name of [LEGACY_PROJECT_DIR, PROJECT_DIR]) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) dirs.push(candidate)
    }
  }
  return dirs
}

function globalConfigDir(env) {
  return path.resolve(env.OPENOVEL_CONFIG_DIR || env.AI_STORY_CONFIG_DIR || path.join(os.homedir(), PROJECT_DIR))
}

function globalConfigDirs(env) {
  const explicit = [env.AI_STORY_CONFIG_DIR, env.OPENOVEL_CONFIG_DIR].filter(Boolean).map((dir) => path.resolve(dir))
  if (explicit.length) return [...new Set(explicit)]
  const legacy = path.resolve(path.join(os.homedir(), LEGACY_PROJECT_DIR))
  const current = path.resolve(path.join(os.homedir(), PROJECT_DIR))
  return legacy === current ? [current] : [legacy, current]
}

function loadSettingsLayer(layer, env) {
  try {
    const text = layer.text ?? readFileSync(layer.path, "utf8")
    const baseDir = layer.path ? path.dirname(layer.path) : process.cwd()
    return { settings: JSON.parse(substituteConfigText(stripJsonC(text), { baseDir, env })) }
  } catch (error) {
    return {
      settings: null,
      error: {
        source: layer.source,
        path: layer.path || "",
        message: error.message || String(error),
      },
    }
  }
}

function substituteConfigText(text, { baseDir, env }) {
  return String(text)
    .replace(/\{env:([^}]+)\}/g, (_match, name) => env[name] || "")
    .replace(/\{file:([^}]+)\}/g, (_match, rawPath) => {
      const file = path.resolve(baseDir, rawPath.trim())
      return readFileSync(file, "utf8")
    })
}

function stripJsonC(text) {
  let output = ""
  let inString = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      output += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    output += char
  }
  return output.replace(/,\s*([}\]])/g, "$1")
}

function mergeSettings(target, source) {
  if (!isObject(source)) return target
  const out = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (Array.isArray(value)) out[key] = [...value]
    else if (isObject(value) && isObject(out[key])) out[key] = mergeSettings(out[key], value)
    else out[key] = value
  }
  return out
}

function settingsFromEnv(env) {
  // Invalid JSON in the env var is ignored (like parseJson elsewhere) instead
  // of collapsing to [] — an empty array is a real value that would wipe the
  // file-layer definitions on merge.
  const customProvidersEnv = parseJson(env[CUSTOM_PROVIDERS_ENV])
  const provider = compactObject({
    foreground: env.AI_PROVIDER,
    background: env.AI_BACKGROUND_PROVIDER,
    order: env.AI_PROVIDER_ORDER ? splitList(env.AI_PROVIDER_ORDER) : undefined,
    allowPaidFallback: parseBool(env.AI_ALLOW_PAID_FALLBACK),
    baseUrl: env.AI_BASE_URL,
    capabilities: parseJson(env.OPENOVEL_PROVIDER_CAPABILITIES),
    modelCapabilities: parseJson(env.OPENOVEL_MODEL_CAPABILITIES),
    customProviders: Array.isArray(customProvidersEnv) ? normalizeCustomProvidersList(customProvidersEnv) : undefined,
  })

  const providers = compactObject({
    "kimi-code": compactObject({
      apiKey: env.KIMI_API_KEY,
      baseUrl: env.KIMI_BASE_URL || env.KIMI_CODE_BASE_URL,
    }),
    mimo: compactObject({
      apiKey: env.MIMO_API_KEY || env.XIAOMI_MIMO_API_KEY,
      baseUrl: env.MIMO_BASE_URL || env.XIAOMI_MIMO_BASE_URL,
    }),
    deepseek: compactObject({
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      thinking: env.DEEPSEEK_THINKING,
      reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
    }),
    openrouter: compactObject({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
    }),
    "custom-openai": compactObject({
      apiKey: env.AI_API_KEY || env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
    }),
  })
  if (Object.keys(providers).length) provider.providers = providers

  const modelProfiles = compactObject({
    small: env.AI_SMALL_MODEL,
    large: env.AI_LARGE_MODEL,
    routes: parseJson(env.OPENOVEL_MODEL_PROFILE_ROUTES),
  })

  const agents = compactObject({
    overrides: parseJson(env.OPENOVEL_AGENT_OVERRIDES),
  })

  const tui = compactObject({
    optionsEnabled: parseBool(envValue(env, "OPENOVEL_OPTIONS_ENABLED", "AI_STORY_OPTIONS_ENABLED")),
    displayPacing: parseBool(envValue(env, "OPENOVEL_DISPLAY_PACING", "AI_STORY_DISPLAY_PACING")),
    displayCpm: parseNumber(
      envValue(env, "OPENOVEL_DISPLAY_CPM", "OPENOVEL_DISPLAY_CHARS_PER_MINUTE", "AI_STORY_DISPLAY_CPM", "AI_STORY_DISPLAY_CHARS_PER_MINUTE"),
    ),
    displayWpm: parseNumber(envValue(env, "OPENOVEL_DISPLAY_WPM", "AI_STORY_DISPLAY_WPM")),
    displayFrameMs: parseNumber(envValue(env, "OPENOVEL_DISPLAY_FRAME_MS", "AI_STORY_DISPLAY_FRAME_MS")),
    punctuationPauses: parseBool(
      envValue(env, "OPENOVEL_DISPLAY_PUNCTUATION_PAUSES", "AI_STORY_DISPLAY_PUNCTUATION_PAUSES"),
    ),
  })
  const toolPermissions = compactObject({
    askFallback: envValue(env, "OPENOVEL_PERMISSION_ASK_FALLBACK", "AI_STORY_PERMISSION_ASK_FALLBACK"),
    rules: parseJson(envValue(env, "OPENOVEL_TOOL_PERMISSION_RULES", "OPENOVEL_TOOL_PERMISSIONS")),
  })
  const tools = compactObject({
    bash: parseBool(envValue(env, "OPENOVEL_ENABLE_BASH_TOOL", "AI_STORY_ENABLE_BASH_TOOL")),
    formatContract: parseBool(envValue(env, "OPENOVEL_ENABLE_FORMAT_CONTRACT")),
    imageGen: parseBool(envValue(env, "OPENOVEL_ENABLE_IMAGE_GEN")),
    musicGen: parseBool(envValue(env, "OPENOVEL_ENABLE_MUSIC_GEN")),
    permissions: Object.keys(toolPermissions).length ? toolPermissions : undefined,
  })
  const webSearch = compactObject({
    provider: env.OPENOVEL_WEBSEARCH_PROVIDER,
    order: env.OPENOVEL_WEBSEARCH_PROVIDER_ORDER ? splitList(env.OPENOVEL_WEBSEARCH_PROVIDER_ORDER) : undefined,
    writeResults: parseBool(env.OPENOVEL_WEBSEARCH_WRITE_RESULTS),
  })
  const webSearchProviders = compactObject({
    "kimi-search-service": compactObject({
      apiKey: env.KIMI_SEARCH_API_KEY,
      baseUrl: env.KIMI_SEARCH_BASE_URL,
    }),
    "exa-mcp": compactObject({
      apiKey: env.EXA_API_KEY || env.EXA_MCP_API_KEY,
      baseUrl: env.EXA_MCP_URL || env.OPENOVEL_EXA_MCP_URL,
      toolName: env.EXA_MCP_TOOL || env.OPENOVEL_EXA_MCP_TOOL,
    }),
    "parallel-mcp": compactObject({
      apiKey: env.PARALLEL_API_KEY || env.PARALLEL_MCP_API_KEY,
      baseUrl: env.PARALLEL_MCP_URL || env.OPENOVEL_PARALLEL_MCP_URL,
      toolName: env.PARALLEL_MCP_TOOL || env.OPENOVEL_PARALLEL_MCP_TOOL,
    }),
    "anthropic-server-websearch": compactObject({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
      model: env.ANTHROPIC_SEARCH_MODEL || env.ANTHROPIC_MODEL,
    }),
    "custom-http-search": compactObject({
      apiKey: env.CUSTOM_HTTP_SEARCH_API_KEY || env.OPENOVEL_CUSTOM_HTTP_SEARCH_API_KEY,
      baseUrl: env.CUSTOM_HTTP_SEARCH_URL || env.OPENOVEL_CUSTOM_HTTP_SEARCH_URL,
      method: env.CUSTOM_HTTP_SEARCH_METHOD || env.OPENOVEL_CUSTOM_HTTP_SEARCH_METHOD,
    }),
  })
  if (Object.keys(webSearchProviders).length) webSearch.providers = webSearchProviders
  const imageGeneration = compactObject({
    provider: env.OPENOVEL_IMAGE_PROVIDER,
    baseUrl: env.OPENOVEL_IMAGE_BASE_URL,
    apiKey: env.OPENOVEL_IMAGE_API_KEY,
    model: env.OPENOVEL_IMAGE_MODEL,
    path: env.OPENOVEL_IMAGE_PATH,
    size: env.OPENOVEL_IMAGE_SIZE,
  })
  const image = compactObject({
    generation: Object.keys(imageGeneration).length ? imageGeneration : undefined,
  })
  const workspace = compactObject({
    home: envValue(env, "OPENOVEL_HOME", "AI_STORY_HOME"),
    storyRoot: envValue(env, "OPENOVEL_STORY_ROOT", "OPENOVEL_ROOT", "AI_STORY_ROOT"),
    storyId: envValue(env, "OPENOVEL_STORY_ID", "AI_STORY_ID"),
  })
  const server = compactObject({ port: parseNumber(env.PORT) })

  return compactObject({
    provider: Object.keys(provider).length ? provider : undefined,
    modelProfiles: Object.keys(modelProfiles).length ? modelProfiles : undefined,
    agents: Object.keys(agents).length ? agents : undefined,
    workspace: Object.keys(workspace).length ? workspace : undefined,
    tui: Object.keys(tui).length ? tui : undefined,
    tools: Object.keys(tools).length ? tools : undefined,
    webSearch: Object.keys(webSearch).length ? webSearch : undefined,
    image: Object.keys(image).length ? image : undefined,
    server: Object.keys(server).length ? server : undefined,
  })
}

function settingsToEnv(settings, env) {
  const provider = settings.provider || {}
  const providers = provider.providers || {}
  const kimi = providerConfig(providers, "kimi-code", "kimiCode")
  const mimo = providerConfig(providers, "mimo")
  const deepseek = providerConfig(providers, "deepseek")
  const openrouter = providerConfig(providers, "openrouter")
  const custom = providerConfig(providers, "custom-openai", "customOpenai")
  const webSearch = settings.webSearch || {}
  const imageGeneration = settings.image?.generation || {}
  const webSearchProviders = webSearch.providers || {}
  const kimiSearch = providerConfig(webSearchProviders, "kimi-search-service", "kimiSearchService")
  const exaMcp = providerConfig(webSearchProviders, "exa-mcp", "exaMcp")
  const parallelMcp = providerConfig(webSearchProviders, "parallel-mcp", "parallelMcp")
  const anthropicSearch = providerConfig(webSearchProviders, "anthropic-server-websearch", "anthropicServerWebsearch")
  const customSearch = providerConfig(webSearchProviders, "custom-http-search", "customHttpSearch")
  const out = { ...env }

  put(out, "AI_PROVIDER", provider.foreground || provider.default)
  put(out, "AI_BACKGROUND_PROVIDER", provider.background)
  // AI_FOREGROUND_PROVIDER is a legacy alias for AI_PROVIDER that we no
  // longer write. If it survives from an older shell env it can shadow the
  // canonical AI_PROVIDER (registry checks it first), so strip it here so
  // settingsEnv() returns a clean, consistent provider pin.
  delete out.AI_FOREGROUND_PROVIDER
  put(out, "AI_PROVIDER_ORDER", Array.isArray(provider.order) ? provider.order.join(",") : provider.order)
  put(out, "AI_ALLOW_PAID_FALLBACK", boolString(provider.allowPaidFallback))
  put(out, "AI_BASE_URL", provider.baseUrl)
  const providerCapabilities = capabilityOverrides(provider, providers)
  if (Object.keys(providerCapabilities).length) put(out, "OPENOVEL_PROVIDER_CAPABILITIES", JSON.stringify(providerCapabilities))
  if (provider.modelCapabilities && Object.keys(provider.modelCapabilities).length) {
    put(out, "OPENOVEL_MODEL_CAPABILITIES", JSON.stringify(provider.modelCapabilities))
  }

  const modelProfiles = settings.modelProfiles || {}
  put(out, "AI_SMALL_MODEL", modelProfiles.small)
  put(out, "AI_LARGE_MODEL", modelProfiles.large)
  const modelProfileRoutes = combinedModelProfileRoutes(settings)
  if (Object.keys(modelProfileRoutes).length) {
    put(out, "OPENOVEL_MODEL_PROFILE_ROUTES", JSON.stringify(modelProfileRoutes))
  }

  const agentOverrides = settings.agents?.overrides || {}
  if (Object.keys(agentOverrides).length) {
    put(out, "OPENOVEL_AGENT_OVERRIDES", JSON.stringify(agentOverrides))
  }

  put(out, "OPENOVEL_HOME", settings.workspace?.home)
  put(out, "OPENOVEL_STORY_ROOT", settings.workspace?.storyRoot)
  put(out, "OPENOVEL_STORY_ID", settings.workspace?.storyId)

  put(out, "KIMI_API_KEY", kimi.apiKey)
  put(out, "KIMI_BASE_URL", kimi.baseUrl)

  put(out, "MIMO_API_KEY", mimo.apiKey)
  put(out, "MIMO_BASE_URL", mimo.baseUrl)

  put(out, "DEEPSEEK_API_KEY", deepseek.apiKey)
  put(out, "DEEPSEEK_BASE_URL", deepseek.baseUrl)
  put(out, "DEEPSEEK_THINKING", deepseek.thinking)
  put(out, "DEEPSEEK_REASONING_EFFORT", deepseek.reasoningEffort)

  put(out, "OPENROUTER_API_KEY", openrouter.apiKey)
  put(out, "OPENROUTER_BASE_URL", openrouter.baseUrl)

  put(out, "AI_API_KEY", custom.apiKey)
  if (!out.AI_BASE_URL) put(out, "AI_BASE_URL", custom.baseUrl)

  // User-defined custom providers: definitions ride one JSON env var (no key
  // material); each provider's key/baseUrl ride derived per-provider vars
  // sourced from the standard providers[<id>] slot. Real env vars win over
  // file values (env is the final override layer), hence the in-out guards.
  const customProviders = normalizeCustomProvidersList(provider.customProviders)
  if (customProviders.length && !env[CUSTOM_PROVIDERS_ENV]) {
    put(out, CUSTOM_PROVIDERS_ENV, JSON.stringify(customProviders))
  }

  // Operator-assigned display aliases (providers[<id>].alias) — one JSON env
  // var the registry applies at resolve time. A real env var wins.
  const aliases = providerAliasMap(providers)
  if (Object.keys(aliases).length && !env.OPENOVEL_PROVIDER_ALIASES) {
    put(out, "OPENOVEL_PROVIDER_ALIASES", JSON.stringify(aliases))
  }
  for (const entry of customProviders) {
    const cfg = providerConfig(providers, entry.id)
    const keyEnv = customProviderKeyEnv(entry.id)
    const urlEnv = customProviderBaseUrlEnv(entry.id)
    if (!env[keyEnv]) put(out, keyEnv, cfg.apiKey)
    if (!env[urlEnv]) put(out, urlEnv, cfg.baseUrl)
  }

  put(out, "OPENOVEL_DISPLAY_PACING", boolString(settings.tui?.displayPacing))
  put(out, "OPENOVEL_OPTIONS_ENABLED", boolString(settings.tui?.optionsEnabled))
  put(out, "OPENOVEL_DISPLAY_CPM", settings.tui?.displayCpm)
  put(out, "OPENOVEL_DISPLAY_WPM", settings.tui?.displayWpm)
  put(out, "OPENOVEL_DISPLAY_FRAME_MS", settings.tui?.displayFrameMs)
  put(out, "OPENOVEL_DISPLAY_PUNCTUATION_PAUSES", boolString(settings.tui?.punctuationPauses))
  put(out, "OPENOVEL_ENABLE_BASH_TOOL", boolString(settings.tools?.bash))
  put(out, "OPENOVEL_ENABLE_FORMAT_CONTRACT", boolString(settings.tools?.formatContract))
  put(out, "OPENOVEL_ENABLE_IMAGE_GEN", boolString(settings.tools?.imageGen))
  put(out, "OPENOVEL_ENABLE_MUSIC_GEN", boolString(settings.tools?.musicGen))
  put(out, "OPENOVEL_PERMISSION_ASK_FALLBACK", settings.tools?.permissions?.askFallback)
  if (Array.isArray(settings.tools?.permissions?.rules) && settings.tools.permissions.rules.length) {
    put(out, "OPENOVEL_TOOL_PERMISSION_RULES", JSON.stringify(settings.tools.permissions.rules))
  }

  put(out, "OPENOVEL_WEBSEARCH_PROVIDER", webSearch.provider)
  put(out, "OPENOVEL_WEBSEARCH_PROVIDER_ORDER", Array.isArray(webSearch.order) ? webSearch.order.join(",") : webSearch.order)
  put(out, "OPENOVEL_WEBSEARCH_WRITE_RESULTS", boolString(webSearch.writeResults))
  put(out, "OPENOVEL_IMAGE_PROVIDER", imageGeneration.provider)
  put(out, "OPENOVEL_IMAGE_BASE_URL", imageGeneration.baseUrl)
  put(out, "OPENOVEL_IMAGE_API_KEY", imageGeneration.apiKey)
  put(out, "OPENOVEL_IMAGE_MODEL", imageGeneration.model)
  put(out, "OPENOVEL_IMAGE_PATH", imageGeneration.path)
  put(out, "OPENOVEL_IMAGE_SIZE", imageGeneration.size)
  put(out, "KIMI_SEARCH_API_KEY", kimiSearch.apiKey)
  put(out, "KIMI_SEARCH_BASE_URL", kimiSearch.baseUrl)
  put(out, "EXA_API_KEY", exaMcp.apiKey)
  put(out, "EXA_MCP_URL", exaMcp.baseUrl)
  put(out, "EXA_MCP_TOOL", exaMcp.toolName)
  put(out, "PARALLEL_API_KEY", parallelMcp.apiKey)
  put(out, "PARALLEL_MCP_URL", parallelMcp.baseUrl)
  put(out, "PARALLEL_MCP_TOOL", parallelMcp.toolName)
  put(out, "ANTHROPIC_API_KEY", anthropicSearch.apiKey)
  put(out, "ANTHROPIC_BASE_URL", anthropicSearch.baseUrl)
  put(out, "ANTHROPIC_SEARCH_MODEL", anthropicSearch.model)
  put(out, "CUSTOM_HTTP_SEARCH_API_KEY", customSearch.apiKey)
  put(out, "CUSTOM_HTTP_SEARCH_URL", customSearch.baseUrl)
  put(out, "CUSTOM_HTTP_SEARCH_METHOD", customSearch.method)
  put(out, "PORT", settings.server?.port)

  return out
}

function providerConfig(providers, ...keys) {
  for (const key of keys) {
    if (isObject(providers[key])) return providers[key]
  }
  return {}
}

function providerAliasMap(providers) {
  const out = {}
  for (const [id, config] of Object.entries(providers || {})) {
    const alias = typeof config?.alias === "string" ? config.alias.trim() : ""
    if (alias) out[id] = alias
  }
  return out
}

function capabilityOverrides(provider, providers) {
  const out = isObject(provider.capabilities) ? { ...provider.capabilities } : {}
  for (const [id, config] of Object.entries(providers || {})) {
    if (isObject(config?.capabilities)) out[id] = config.capabilities
  }
  return out
}

function combinedModelProfileRoutes(settings) {
  const out = isObject(settings.modelProfiles?.routes) ? { ...settings.modelProfiles.routes } : {}
  for (const [agentId, override] of Object.entries(settings.agents?.overrides || {})) {
    const model = isObject(override?.model) ? override.model : null
    if (!model?.provider && !model?.model) continue
    out[`agent:${agentId}`] = {
      role: model.role || override.role || "background",
      provider: model.provider || "",
      model: model.model || "",
    }
  }
  return out
}

function put(target, key, value) {
  if (value === undefined || value === null || value === "") return
  target[key] = String(value)
}

function envValue(env, ...names) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== "") return env[name]
  }
  return undefined
}

function parseBool(value) {
  if (value === undefined) return undefined
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false
  return undefined
}

function parseNumber(value) {
  if (value === undefined || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function parseJson(value) {
  if (value === undefined || value === "") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function boolString(value) {
  if (value === undefined) return undefined
  return value ? "true" : "false"
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined && value !== "" && !(isObject(value) && !Object.keys(value).length),
    ),
  )
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function dedupeLayers(layers) {
  const seen = new Set()
  return layers.filter((layer) => {
    const key = layer.path || `${layer.source}:${layer.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function redactSettings(settings) {
  const copy = structuredClone(settings)
  for (const provider of Object.values(copy.provider?.providers || {})) {
    if (provider.apiKey) provider.apiKey = "<redacted>"
  }
  for (const provider of Object.values(copy.webSearch?.providers || {})) {
    if (provider.apiKey) provider.apiKey = "<redacted>"
  }
  if (copy.image?.generation?.apiKey) copy.image.generation.apiKey = "<redacted>"
  return copy
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
