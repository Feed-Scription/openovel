const PREFS_KEY = "openovel.web.prefs"
const STATE_KEY = "openovel.web.state"
const MEMORY_KEY = "openovel.web.userMemory"
const API_KEYS_KEY = "openovel.web.apiKeys"
const LLM_CONFIG_KEY = "openovel.web.llmConfig"
const SEARCH_CONFIG_KEY = "openovel.web.searchConfig"
const IMAGE_SETTINGS_KEY = "openovel.web.imageSettings"
const TTS_SETTINGS_KEY = "openovel.web.ttsSettings"

const DEFAULT_PREFS = {
  locale: "en",
  colorTheme: "default",
  fontFamily: "serif",
  fontSize: 18,
  narrationCpm: 720,
  layoutScale: 1,
  backgroundArt: false,
  autoScroll: true,
  highlightDialogue: true,
  highlightNames: true,
  customRichBlocks: true,
  sceneBackdrop: true,
}

const DEFAULT_OPTIONS = [
  { id: "opt_1", label: "Ask what the lighthouse remembers." },
  { id: "opt_2", label: "Open the brass hatch under the console." },
  { id: "opt_3", label: "Call out to whoever is walking above." },
]

const DEMO_NARRATIONS = [
  "The console wakes under your hand with a soft amber pulse. Somewhere below the floor, old relays answer one another in sequence, like a building remembering how to breathe. On the rain-streaked glass, the lighthouse beam turns once and catches a shape moving along the pier.",
  "Your words travel into the stairwell and come back thinner. The answer is not a voice at first, but a change in the room: dust lifting from the map table, pins trembling over routes that no ship has sailed in twenty years.",
  "The hatch gives with a reluctant metallic sigh. Cold air rises from below, carrying salt, machine oil, and the unmistakable scent of paper kept dry against all odds. A ledger waits on the first step, already open to tonight's date.",
  "The figure outside stops beneath the beam. For one bright second you see a raincoat, a gloved hand, and a face turned deliberately away from the glass. Then the light moves on, and the pier is empty again.",
]

const DEMO_STORY = {
  id: "github-pages-demo",
  displayName: "GitHub Pages demo",
  touchedAt: nowIso(),
  bytes: 4096,
}

const API_KEY_SPECS = [
  { id: "deepseek", label: "DeepSeek API key", category: "llm", providerId: "deepseek" },
  { id: "kimi", label: "Kimi API key", category: "llm", providerId: "kimi-code" },
  { id: "mimo", label: "MiMo API key", category: "llm", providerId: "mimo-token-plan-cn" },
  { id: "openrouter", label: "OpenRouter API key", category: "llm", providerId: "openrouter" },
  { id: "anthropic", label: "Anthropic API key", category: "llm", providerId: "anthropic" },
  { id: "openai", label: "OpenAI-compatible API key", category: "llm", providerId: "custom-openai" },
  { id: "kimi-search", label: "Kimi Search API key", category: "search", providerId: "kimi-search-service" },
  { id: "exa", label: "Exa API key", category: "search", providerId: "exa-mcp" },
]

const DEFAULT_LLM_CONFIG = {
  provider: "deepseek",
  baseUrl: "",
  smallModel: "deepseek-v4-flash",
  largeModel: "deepseek-v4-pro",
  paidFallback: true,
  providerOrder: [],
}

const DEFAULT_SEARCH_CONFIG = { provider: "" }

const IMAGE_PROVIDERS = [
  {
    id: "custom",
    label: "Custom",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultPath: "/images/generations",
    defaultSize: "1024x1024",
    request: "openai-images",
  },
  {
    id: "volcengine",
    label: "Volcengine",
    defaultModel: "doubao-seedream-3-0-t2i-250415",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultPath: "/images/generations",
    defaultSize: "1024x1024",
    request: "openai-images",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultPath: "/images/generations",
    defaultSize: "1024x1024",
    request: "openai-images",
  },
]

const DEFAULT_IMAGE_SETTINGS = {
  config: {
    provider: "custom",
    baseUrl: "",
    apiKey: { set: false, masked: "" },
    model: "",
    path: "/images/generations",
    size: "1024x1024",
  },
  customProviders: [],
}

const DEFAULT_TTS_SETTINGS = {
  config: {
    enabled: false,
    provider: "volcano",
    voiceType: "zh_female_cancan_mars_bigtts",
    speed: 1,
    appId: "",
    accessToken: { set: false, masked: "" },
    cluster: "volcano_tts",
  },
  customProviders: [],
  voices: [
    { id: "zh_female_cancan_mars_bigtts", label: "灿灿 · 女声" },
    { id: "zh_female_wanwanxiaohe_moon_bigtts", label: "湾湾小何 · 女声" },
    { id: "en_female_anna_mars_bigtts", label: "Anna · English" },
  ],
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return clone(fallback)
    return { ...clone(fallback), ...JSON.parse(raw) }
  } catch {
    return clone(fallback)
  }
}

function maskKey(value) {
  const s = String(value || "")
  if (!s) return ""
  if (s.length <= 8) return "*".repeat(s.length)
  return `${s.slice(0, 4)}...${s.slice(-4)}`
}

function storySelectorState() {
  return {
    cursor: 0,
    query: "",
    sortBy: "recent",
    comicModeAvailable: false,
    fastModeAvailable: false,
    allStories: [clone(DEMO_STORY)],
    items: [
      { id: "(new)", isNew: true, label: "+ New story..." },
      { id: "(import)", isImport: true, label: "Import..." },
      clone(DEMO_STORY),
    ],
  }
}

function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

function nowIso() {
  return new Date().toISOString()
}

function makeEntry(type, text, extra = {}) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    text,
    complete: true,
    at: nowIso(),
    ...extra,
  }
}

function initialState() {
  return {
    mode: "story-selector",
    booting: false,
    entries: [
      makeEntry(
        "narration",
        "Welcome to the GitHub Pages build of openovel's current Electron renderer. This browser version uses a local demo bridge in place of Electron's filesystem, model, and native APIs, so you can explore the client UI directly from the web.",
      ),
      makeEntry(
        "narration",
        "Rain taps against the abandoned ferry terminal. The emergency lights have failed, but the old lighthouse across the water still sweeps its gold beam through the windows every twelve seconds. The reader action bar is live below.",
      ),
    ],
    input: "",
    compose: null,
    onboarding: null,
    storySelector: storySelectorState(),
    storyNaming: null,
    initChat: null,
    options: clone(DEFAULT_OPTIONS),
    decisionFraming: "What do you do next?",
    optionsEnabled: true,
    foregroundGuidance: "",
    formatContract: null,
    comicPanels: {},
    comicPanelsLive: {},
    characterNames: ["lighthouse", "ferry terminal"],
    inboxCount: 0,
    turnCount: 0,
    status: "web demo ready",
    busy: false,
    currentStory: null,
    pacing: { cpm: 720, charsPerTick: 2, tickMs: 25 },
    jobs: [],
    activeTools: [],
    storyTree: [],
    storyTreeExpanded: [],
    activity: [
      {
        id: "web-demo",
        at: Date.now(),
        source: "Web bridge",
        label: "Electron renderer running in browser demo mode",
        status: "done",
        meta: {},
      },
    ],
    aggregate: {
      jobs: 0,
      toolCalls: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      charactersStreamed: 0,
      filesWritten: 0,
    },
    liveStream: null,
    lastError: null,
  }
}

function readState() {
  const saved = readJson(STATE_KEY, {})
  if (!saved || !saved.entries) return initialState()
  return {
    ...initialState(),
    ...saved,
    mode: "story-selector",
    booting: false,
    currentStory: null,
    storySelector: storySelectorState(),
  }
}

function desktopRequired(feature) {
  return {
    ok: false,
    error: `${feature} requires the Electron desktop app.`,
  }
}

export function installWebOpenovelBridge() {
  if (window.openovel) return window.openovel

  let prefs = readJson(PREFS_KEY, DEFAULT_PREFS)
  let state = readState()
  let apiKeys = readJson(API_KEYS_KEY, {})
  let llmConfig = readJson(LLM_CONFIG_KEY, DEFAULT_LLM_CONFIG)
  if (!llmConfig.provider) llmConfig = clone(DEFAULT_LLM_CONFIG)
  let searchConfig = readJson(SEARCH_CONFIG_KEY, DEFAULT_SEARCH_CONFIG)
  let imageSettings = readJson(IMAGE_SETTINGS_KEY, DEFAULT_IMAGE_SETTINGS)
  let ttsSettings = readJson(TTS_SETTINGS_KEY, DEFAULT_TTS_SETTINGS)
  const stateListeners = new Set()
  const busListeners = new Set()
  const menuListeners = new Set()
  const ttsListeners = new Set()

  const emitState = () => {
    const snap = clone(state)
    writeJson(STATE_KEY, snap)
    for (const fn of stateListeners) {
      try { fn(snap) } catch { /* ignore */ }
    }
  }

  const emitBus = (name, properties = {}) => {
    for (const fn of busListeners) {
      try { fn(name, properties) } catch { /* ignore */ }
    }
  }

  const patchState = (patch) => {
    state = { ...state, ...patch }
    emitState()
  }

  const enterDemoStory = () => {
    patchState({
      mode: "idle",
      booting: false,
      storySelector: null,
      currentStory: {
        id: DEMO_STORY.id,
        displayName: DEMO_STORY.displayName,
        root: "",
        isProjectLocal: false,
        mode: "",
      },
      status: "web demo ready",
    })
  }

  const getApiKeysSnapshot = () => ({
    keys: API_KEY_SPECS.map((spec) => ({
      ...spec,
      set: Boolean(apiKeys[spec.id]),
      masked: maskKey(apiKeys[spec.id]),
      source: apiKeys[spec.id] ? "browser" : "unset",
      ticPatterns: "",
    })),
    llm: clone(llmConfig),
    search: clone(searchConfig),
    aliases: {},
    customProviders: [],
    image: null,
  })

  const imageSnapshot = () => {
    const cfg = {
      ...clone(DEFAULT_IMAGE_SETTINGS.config),
      ...(imageSettings.config || {}),
    }
    cfg.apiKey = {
      set: Boolean(imageSettings.apiKeySecret),
      masked: maskKey(imageSettings.apiKeySecret),
    }
    const configured = Boolean(cfg.baseUrl && imageSettings.apiKeySecret && cfg.model)
    return {
      config: cfg,
      provider: cfg.provider || "custom",
      providers: clone(IMAGE_PROVIDERS),
      customProviders: clone(imageSettings.customProviders || []),
      request: "openai-images",
      configured,
      filePath: "browser localStorage",
    }
  }

  const ttsSnapshot = () => {
    const cfg = {
      ...clone(DEFAULT_TTS_SETTINGS.config),
      ...(ttsSettings.config || {}),
    }
    cfg.accessToken = {
      set: Boolean(ttsSettings.accessTokenSecret),
      masked: maskKey(ttsSettings.accessTokenSecret),
    }
    return {
      config: cfg,
      customProviders: clone(ttsSettings.customProviders || []),
      voices: clone(DEFAULT_TTS_SETTINGS.voices),
      filePath: "browser localStorage",
    }
  }

  const submitReaderText = async (text = state.input) => {
    const action = String(text || "").trim()
    if (!action || state.busy) return { ok: true }
    const turn = (state.turnCount || 0) + 1
    const userEntry = makeEntry("user", action)
    const pending = makeEntry("narration", "", { complete: false, pending: true })
    patchState({
      input: "",
      busy: true,
      mode: "busy",
      status: "narrator is writing",
      turnCount: turn,
      entries: [...state.entries, userEntry, pending],
      options: [],
      liveStream: { source: "Web demo narrator", chars: 0, startedAt: Date.now() },
    })

    const narration = DEMO_NARRATIONS[turn % DEMO_NARRATIONS.length]
    await new Promise((resolve) => window.setTimeout(resolve, 260))
    const entries = state.entries.slice()
    const last = entries[entries.length - 1]
    entries[entries.length - 1] = {
      ...last,
      text: `${narration}\n\n_Web demo note: Pages is running the Electron renderer with a browser bridge. Install the desktop app for real model calls, file-native stories, imports, exports, and background agents._`,
      complete: true,
      pending: false,
    }
    patchState({
      entries,
      busy: false,
      mode: "idle",
      status: "ready",
      liveStream: null,
      options: clone(DEFAULT_OPTIONS),
      aggregate: {
        ...state.aggregate,
        modelCalls: state.aggregate.modelCalls + 1,
        outputTokens: state.aggregate.outputTokens + 120,
        charactersStreamed: state.aggregate.charactersStreamed + narration.length,
      },
      activity: [
        {
          id: `turn-${turn}`,
          at: Date.now(),
          source: "Web demo narrator",
          label: `Generated demo turn ${turn}`,
          status: "done",
          meta: {},
        },
        ...(state.activity || []),
      ].slice(0, 24),
    })
    emitBus("foreground.turn.completed", { turn })
    return { ok: true }
  }

  const bridge = {
    isWeb: true,
    getState: async () => clone(state),
    subscribe(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onBusEvent(handler) {
      busListeners.add(handler)
      return () => busListeners.delete(handler)
    },
    onMenuCommand(handler) {
      menuListeners.add(handler)
      return () => menuListeners.delete(handler)
    },
    onTtsEvent(handler) {
      ttsListeners.add(handler)
      return () => ttsListeners.delete(handler)
    },
    async dispatch(method, ...args) {
      switch (method) {
        case "setInput":
          patchState({ input: String(args[0] || "") })
          return { ok: true }
        case "appendInput":
          patchState({ input: `${state.input || ""}${args[0] || ""}` })
          return { ok: true }
        case "backspaceInput":
          patchState({ input: String(state.input || "").slice(0, -1) })
          return { ok: true }
        case "clearInput":
          patchState({ input: "" })
          return { ok: true }
        case "pickOption": {
          const option = state.options[Math.max(0, Number(args[0]) - 1)]
          patchState({ input: option?.label || "" })
          return { ok: true }
        }
        case "submitOption": {
          const option = state.options[Math.max(0, Number(args[0]) - 1)]
          return submitReaderText(option?.label || "")
        }
        case "submit":
        case "submitReaderText":
          return submitReaderText()
        case "setNarrationCpm":
          patchState({ pacing: { ...state.pacing, cpm: Number(args[0]) || 0 } })
          return { ok: true }
        case "goToLibrary":
          patchState({
            mode: "story-selector",
            currentStory: null,
            storySelector: storySelectorState(),
          })
          return { ok: true }
        case "switchToStory":
          enterDemoStory()
          return { ok: true }
        case "confirmStorySelection": {
          const item = state.storySelector?.items?.[state.storySelector.cursor || 0]
          if (item?.id === DEMO_STORY.id) enterDemoStory()
          return { ok: true }
        }
        case "moveStorySelector":
          if (state.storySelector?.items?.length) {
            const n = state.storySelector.items.length
            const cursor = ((state.storySelector.cursor || 0) + Number(args[0] || 0) + n) % n
            patchState({ storySelector: { ...state.storySelector, cursor } })
          }
          return { ok: true }
        case "setStorySearch": {
          const query = String(args[0] || "")
          const allStories = state.storySelector?.allStories || []
          const storyItems = allStories.filter((item) => item.displayName.toLowerCase().includes(query.toLowerCase()))
          patchState({
            storySelector: {
              ...state.storySelector,
              query,
              items: [{ id: "(new)", isNew: true, label: "+ New story..." }, { id: "(import)", isImport: true, label: "Import..." }, ...storyItems],
              cursor: 0,
            },
          })
          return { ok: true }
        }
        case "setStorySort":
          patchState({ storySelector: { ...state.storySelector, sortBy: args[0] || "recent" } })
          return { ok: true }
        case "readStoryFile":
          return { ok: true, rel: args[0], content: "This file preview is unavailable in the GitHub Pages build." }
        case "expandStoryTreeNode":
        case "collapseStoryTreeNode":
          return { ok: true }
        default:
          return desktopRequired(method)
      }
    },
    getPrefs: async () => clone(prefs),
    setPrefs: async (next) => {
      prefs = { ...prefs, ...(next || {}) }
      writeJson(PREFS_KEY, prefs)
      return clone(prefs)
    },
    getServiceStatus: async () => ({ ok: true, web: true, desktop: false }),
    getStoryCover: async () => ({ ok: false }),
    getApiKeys: async () => getApiKeysSnapshot(),
    setApiKeys: async (patch = {}) => {
      for (const [id, value] of Object.entries(patch || {})) {
        const text = String(value || "")
        if (text) apiKeys[id] = text
        else delete apiKeys[id]
      }
      writeJson(API_KEYS_KEY, apiKeys)
      return { ok: true, snapshot: getApiKeysSnapshot() }
    },
    setLlmConfig: async (patch = {}) => {
      llmConfig = { ...llmConfig, ...(patch || {}) }
      writeJson(LLM_CONFIG_KEY, llmConfig)
      return { ok: true, snapshot: getApiKeysSnapshot() }
    },
    setSearchConfig: async (patch = {}) => {
      searchConfig = { ...searchConfig, provider: patch?.provider || "" }
      writeJson(SEARCH_CONFIG_KEY, searchConfig)
      return { ok: true, snapshot: getApiKeysSnapshot() }
    },
    setTicPatterns: async () => ({ ok: true }),
    setProviderAlias: async () => ({ ok: true }),
    saveCustomProvider: async () => desktopRequired("custom providers"),
    deleteCustomProvider: async () => desktopRequired("custom providers"),
    getAdvancedConfig: async () => ({ modelCatalog: [], modelProfiles: [], agentOverrides: [] }),
    setModelCatalogItem: async () => desktopRequired("model catalog editing"),
    removeModelCatalogItem: async () => desktopRequired("model catalog editing"),
    setModelProfileRoute: async () => desktopRequired("model routing"),
    setAgentOverride: async () => desktopRequired("agent overrides"),
    testLlmConnection: async () => ({
      ok: false,
      latencyMs: 0,
      error: "GitHub Pages stores API key settings locally, but real model connection tests require the Electron desktop runtime.",
    }),
    getBehavior: async () => ({}),
    setBehavior: async () => ({ ok: true }),
    getImageSettings: async () => imageSnapshot(),
    setImageSettings: async (patch = {}) => {
      const config = { ...clone(DEFAULT_IMAGE_SETTINGS.config), ...(imageSettings.config || {}) }
      const next = { ...imageSettings, config }
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === "apiKey") {
          next.apiKeySecret = String(value || "")
        } else if (key === "upsertCustomProvider") {
          const name = String(value?.name || "").trim()
          if (name) {
            const id = `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "endpoint"}`
            next.customProviders = [...(next.customProviders || []).filter((e) => e.id !== id), { id, name, keySet: false, maskedKey: "" }]
          }
        } else if (key === "deleteCustomProvider") {
          next.customProviders = (next.customProviders || []).filter((e) => e.id !== String(value || ""))
          if (next.config.provider === value) next.config.provider = "custom"
        } else {
          next.config[key] = value
        }
      }
      imageSettings = next
      writeJson(IMAGE_SETTINGS_KEY, imageSettings)
      return { ok: true, snapshot: imageSnapshot() }
    },
    testImageGeneration: async () => ({
      ok: false,
      latencyMs: 0,
      error: "Image generation tests require the Electron desktop runtime.",
    }),
    getMusicAuth: async () => ({ configured: false, signedIn: false }),
    setMusicConfig: async () => desktopRequired("music"),
    setMusicToken: async () => desktopRequired("music"),
    musicLogout: async () => ({ ok: true }),
    musicQrStart: async () => desktopRequired("music"),
    musicQrPoll: async () => desktopRequired("music"),
    testMusicConnection: async () => desktopRequired("music"),
    getMusicCatalog: async () => ({ tracks: [] }),
    getTts: async () => ttsSnapshot(),
    setTts: async (patch = {}) => {
      const config = { ...clone(DEFAULT_TTS_SETTINGS.config), ...(ttsSettings.config || {}) }
      const next = { ...ttsSettings, config }
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === "accessToken") {
          next.accessTokenSecret = String(value || "")
        } else if (key === "upsertCustomProvider") {
          const name = String(value?.name || "").trim()
          if (name) {
            const id = `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "endpoint"}`
            next.customProviders = [...(next.customProviders || []).filter((e) => e.id !== id), {
              id,
              name,
              baseUrl: "",
              model: "",
              voice: "",
              sampleRate: 24000,
              keySet: false,
              maskedKey: "",
            }]
          }
        } else if (key === "deleteCustomProvider") {
          const id = String(value || "")
          next.customProviders = (next.customProviders || []).filter((e) => e.id !== id)
          if (next.config.provider === id) next.config.provider = "volcano"
        } else {
          next.config[key] = value
        }
      }
      ttsSettings = next
      writeJson(TTS_SETTINGS_KEY, ttsSettings)
      return { ok: true, snapshot: ttsSnapshot() }
    },
    ttsControl: async () => ({ ok: true }),
    getEnvironment: async () => ({ variables: [], OPENOVEL_WEB: "1" }),
    setEnvironment: async () => desktopRequired("environment editing"),
    exportStory: async () => desktopRequired("story export"),
    exportNovel: async () => desktopRequired("novel export"),
    copyShareImage: async () => desktopRequired("native clipboard image copy"),
    saveShareImage: async () => desktopRequired("native image save"),
    importStory: async () => desktopRequired("story import"),
    getUserMemory: async () => ({ content: window.localStorage.getItem(MEMORY_KEY) || "" }),
    setUserMemory: async (content) => {
      window.localStorage.setItem(MEMORY_KEY, String(content || ""))
      return { ok: true }
    },
    getMemorySnapshot: async () => ({ user: window.localStorage.getItem(MEMORY_KEY) || "", observed: "", stories: [] }),
    clearMemoryTarget: async () => {
      window.localStorage.removeItem(MEMORY_KEY)
      return { ok: true }
    },
    getPreferenceTagGroups: async () => ({ groups: [] }),
    getInitDepth: async () => ({ value: null, sourcedFrom: "unset" }),
    setInitDepth: async () => ({ ok: true }),
  }

  window.openovel = bridge
  return bridge
}
