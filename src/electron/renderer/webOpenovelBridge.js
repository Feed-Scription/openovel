// Browser bridge for the GitHub Pages demo. Stands in for Electron's
// preload-exposed `window.openovel`, but instead of canned text it runs the REAL
// foreground narrator over the two pre-initialized starter stories, BYOK:
//   - story content + media are fetched from ./stories/<id>/ (emitted by
//     scripts/build-pages.mjs from resources/starter-stories/);
//   - narration is a direct browser → provider call with the reader's own key
//     (src/electron/renderer/webProvider.js);
//   - the prompt is the desktop narrator's shape (webNarrator.js), so HUD,
//     scene backdrop, and inline includes all render through the normal renderer.
//
// Anything that needs the local-first runtime — new stories, imports, exports,
// background agents — stays desktop-only and returns desktopRequired().

import { streamChat, BROWSER_SUPPORT } from "./webProvider.js"
import {
  sanitizeReaderAction,
  buildNarratorMessages,
  buildOptionsMessages,
  parseOptions,
  appendRecentCanon,
  buildOpeningEntryText,
} from "./webNarrator.js"
import { normalizeOvlFences } from "../../lib/ovlFences.js"

const PREFS_KEY = "openovel.web.prefs"
const MEMORY_KEY = "openovel.web.userMemory"
const API_KEYS_KEY = "openovel.web.apiKeys"
const LLM_CONFIG_KEY = "openovel.web.llmConfig"
const SEARCH_CONFIG_KEY = "openovel.web.searchConfig"
const IMAGE_SETTINGS_KEY = "openovel.web.imageSettings"
const TTS_SETTINGS_KEY = "openovel.web.ttsSettings"
const ONBOARDED_KEY = "openovel.web.onboarded"

const STORIES_BASE = "stories/"

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

const API_KEY_SPECS = [
  { id: "openrouter", label: "OpenRouter API key", category: "llm", providerId: "openrouter" },
  { id: "anthropic", label: "Anthropic API key", category: "llm", providerId: "anthropic" },
  { id: "openai", label: "OpenAI-compatible API key", category: "llm", providerId: "custom-openai" },
  { id: "deepseek", label: "DeepSeek API key", category: "llm", providerId: "deepseek" },
  { id: "kimi", label: "Kimi API key", category: "llm", providerId: "kimi-code" },
  { id: "mimo", label: "MiMo API key", category: "llm", providerId: "mimo-token-plan-cn" },
]

// provider id → which API_KEY_SPECS slot holds its key.
const PROVIDER_KEY_ID = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  "custom-openai": "openai",
  deepseek: "deepseek",
  "kimi-code": "kimi",
  "mimo-token-plan-cn": "mimo",
}

// OpenRouter and Anthropic are the browser-friendly defaults; ship OpenRouter as
// the default provider so a pasted OpenRouter key Just Works with no model setup.
const DEFAULT_LLM_CONFIG = {
  provider: "openrouter",
  baseUrl: "",
  smallModel: "",
  largeModel: "",
  paidFallback: true,
  providerOrder: [],
}

const DEFAULT_SEARCH_CONFIG = { provider: "" }

const IMAGE_PROVIDERS = [
  { id: "custom", label: "Custom", defaultModel: "", defaultBaseUrl: "", defaultPath: "/images/generations", defaultSize: "1024x1024", request: "openai-images" },
]
const DEFAULT_IMAGE_SETTINGS = {
  config: { provider: "custom", baseUrl: "", apiKey: { set: false, masked: "" }, model: "", path: "/images/generations", size: "1024x1024" },
  customProviders: [],
}
const DEFAULT_TTS_SETTINGS = {
  config: { enabled: false, provider: "volcano", voiceType: "zh_female_cancan_mars_bigtts", speed: 1, appId: "", accessToken: { set: false, masked: "" }, cluster: "volcano_tts" },
  customProviders: [],
  voices: [{ id: "zh_female_cancan_mars_bigtts", label: "灿灿 · 女声" }, { id: "en_female_anna_mars_bigtts", label: "Anna · English" }],
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function nowIso() { return new Date().toISOString() }
function maskKey(value) {
  const s = String(value || "")
  if (!s) return ""
  if (s.length <= 8) return "*".repeat(s.length)
  return `${s.slice(0, 4)}...${s.slice(-4)}`
}
function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return clone(fallback)
    return { ...clone(fallback), ...JSON.parse(raw) }
  } catch { return clone(fallback) }
}
function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}
function makeEntry(type, text, extra = {}) {
  return { id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`, type, text, complete: true, at: nowIso(), ...extra }
}

function desktopRequired(feature) {
  return { ok: false, error: `${feature} requires the openovel desktop app — download it from the Releases page.` }
}

// Onboarding: language → api-key, mirroring the desktop first-run modal shape the
// OnboardingModal renders from.
function languageOnboarding(locale = "en") {
  return {
    phase: "language",
    step: 0,
    questions: [{ id: "language" }],
    currentQuestion: { id: "language", fallback: locale === "zh" ? "Simplified Chinese" : "English" },
    answers: [],
    locale,
  }
}

function emptyStorySelector() {
  return {
    cursor: 0,
    query: "",
    sortBy: "recent",
    comicModeAvailable: false,
    fastModeAvailable: false,
    allStories: [],
    items: [
      { id: "(new)", isNew: true, label: "+ New story..." },
      { id: "(import)", isImport: true, label: "Import..." },
    ],
    loading: true,
  }
}

export function installWebOpenovelBridge() {
  if (window.openovel) return window.openovel

  let prefs = readJson(PREFS_KEY, DEFAULT_PREFS)
  let apiKeys = readJson(API_KEYS_KEY, {})
  let llmConfig = readJson(LLM_CONFIG_KEY, DEFAULT_LLM_CONFIG)
  if (!llmConfig.provider) llmConfig = clone(DEFAULT_LLM_CONFIG)
  let searchConfig = readJson(SEARCH_CONFIG_KEY, DEFAULT_SEARCH_CONFIG)
  let imageSettings = readJson(IMAGE_SETTINGS_KEY, DEFAULT_IMAGE_SETTINGS)
  let ttsSettings = readJson(TTS_SETTINGS_KEY, DEFAULT_TTS_SETTINGS)

  const onboarded = (() => { try { return window.localStorage.getItem(ONBOARDED_KEY) === "1" } catch { return false } })()

  // Per-story data + the rolling recent-canon window live outside React state so
  // the snapshot stays small.
  let storyIndex = [] // [{ id, title, lang, cover }]
  let currentStoryData = null // the fetched ./stories/<id>/story.json
  let recentCanon = ""

  const stateListeners = new Set()
  const busListeners = new Set()
  const menuListeners = new Set()
  const ttsListeners = new Set()

  let state = {
    mode: onboarded ? "story-selector" : "onboarding",
    booting: false,
    entries: [],
    input: "",
    compose: null,
    onboarding: onboarded ? null : languageOnboarding(prefs.locale),
    storySelector: emptyStorySelector(),
    storyNaming: null,
    initChat: null,
    options: [],
    decisionFraming: "What do you do next?",
    optionsEnabled: true,
    foregroundGuidance: "",
    formatContract: null,
    comicPanels: {},
    comicPanelsLive: {},
    characterNames: [],
    inboxCount: 0,
    turnCount: 0,
    status: "web demo ready",
    busy: false,
    currentStory: null,
    pacing: { cpm: prefs.narrationCpm || 720, charsPerTick: 2, tickMs: 25 },
    jobs: [],
    activeTools: [],
    storyTree: [],
    storyTreeExpanded: [],
    activity: [],
    aggregate: { jobs: 0, toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, charactersStreamed: 0, filesWritten: 0 },
    liveStream: null,
    lastError: null,
  }

  const emitState = () => {
    const snap = clone(state)
    for (const fn of stateListeners) { try { fn(snap) } catch { /* ignore */ } }
  }
  const emitBus = (name, properties = {}) => {
    for (const fn of busListeners) { try { fn(name, properties) } catch { /* ignore */ } }
  }
  const patchState = (patch) => { state = { ...state, ...patch }; emitState() }

  // ── story library ──────────────────────────────────────────────────────────

  const buildSelector = () => {
    const books = storyIndex.map((s) => ({
      id: s.id,
      displayName: s.title,
      label: s.title,
      lang: s.lang || "",
      coverFile: s.cover ? "includes/cover.jpg" : "",
      coverVersion: 1,
      isProjectLocal: false,
      mode: "",
      touchedAt: nowIso(),
      bytes: 0,
    }))
    return {
      cursor: 0,
      query: "",
      sortBy: "recent",
      comicModeAvailable: false,
      fastModeAvailable: false,
      allStories: books,
      items: [
        { id: "(new)", isNew: true, label: "+ New story..." },
        { id: "(import)", isImport: true, label: "Import..." },
        ...books,
      ],
      loading: false,
    }
  }

  const loadIndex = async () => {
    try {
      const res = await fetch(`${STORIES_BASE}index.json`, { cache: "no-cache" })
      const data = await res.json()
      storyIndex = Array.isArray(data?.stories) ? data.stories : []
    } catch {
      storyIndex = []
    }
    if (state.mode === "story-selector") patchState({ storySelector: buildSelector() })
    else state = { ...state, storySelector: buildSelector() }
  }

  const enterStory = async (id) => {
    patchState({ mode: "busy", booting: true, status: "loading story…" })
    let story
    try {
      const res = await fetch(`${STORIES_BASE}${id}/story.json`, { cache: "no-cache" })
      story = await res.json()
    } catch {
      patchState({ mode: "story-selector", booting: false, status: "could not load story", storySelector: buildSelector() })
      return { ok: false }
    }
    currentStoryData = story
    recentCanon = ""
    // Serve this story's media (includes/bg, beats, …) over HTTP for assetUrl().
    globalThis.__OPENOVEL_WEB_ASSET_BASE__ = `${STORIES_BASE}${id}/`

    const opening = buildOpeningEntryText({
      prelude: story.prelude,
      hudInitial: story.hudInitial,
      openingBackdrop: story.openingBackdrop,
    })

    patchState({
      mode: "idle",
      booting: false,
      storySelector: null,
      onboarding: null,
      currentStory: { id, displayName: story.displayName, root: "", isProjectLocal: false, mode: "" },
      formatContract: story.formatContract || null,
      foregroundGuidance: story.foreground || "",
      entries: opening ? [makeEntry("narration", opening)] : [],
      options: [],
      turnCount: 0,
      status: "ready",
      lastError: null,
      liveStream: null,
    })
    return { ok: true }
  }

  const goToLibrary = () => {
    currentStoryData = null
    recentCanon = ""
    globalThis.__OPENOVEL_WEB_ASSET_BASE__ = ""
    patchState({
      mode: "story-selector",
      currentStory: null,
      formatContract: null,
      foregroundGuidance: "",
      entries: [],
      options: [],
      storySelector: buildSelector(),
      status: "web demo ready",
    })
  }

  // ── narration ────────────────────────────────────────────────────────────

  const resolveCall = () => {
    const provider = llmConfig.provider || "openrouter"
    const keyId = PROVIDER_KEY_ID[provider] || provider
    return {
      provider,
      apiKey: apiKeys[keyId] || "",
      baseUrl: llmConfig.baseUrl || "",
      narrationModel: llmConfig.largeModel || llmConfig.smallModel || "",
      optionsModel: llmConfig.smallModel || llmConfig.largeModel || "",
    }
  }

  const keyNeededMessage = () => {
    const zh = String(prefs.locale || "").startsWith("zh")
    return zh
      ? "请在设置（右上角齿轮）→ API Keys 填入你自己的 key 才能游玩。浏览器内推荐 OpenRouter 或 Anthropic。"
      : "Add your own API key in Settings (gear, top-right) → API Keys to play. OpenRouter or Anthropic work in the browser."
  }

  const generateOptions = async (action, narration) => {
    const call = resolveCall()
    if (!call.apiKey || !currentStoryData) return
    try {
      const text = await streamChat({
        provider: call.provider,
        baseUrl: call.baseUrl,
        apiKey: call.apiKey,
        model: call.optionsModel,
        temperature: 0.9,
        maxTokens: 300,
        messages: buildOptionsMessages({
          foreground: currentStoryData.foreground,
          recentCanon,
          narration,
          action,
          locale: prefs.locale,
        }),
        onDelta: () => {},
      })
      const options = parseOptions(text)
      if (options.length && !state.busy) patchState({ options })
    } catch { /* options are best-effort */ }
  }

  const submitReaderText = async (raw = state.input) => {
    if (state.busy || !currentStoryData) return { ok: true }
    const sanitized = sanitizeReaderAction(raw, prefs.locale)
    if (!sanitized.ok) { patchState({ status: sanitized.error, input: raw }); return { ok: false, error: sanitized.error } }
    const action = sanitized.text

    const call = resolveCall()
    if (!call.apiKey) {
      const msg = keyNeededMessage()
      patchState({
        input: "",
        entries: [...state.entries, makeEntry("user", action), makeEntry("narration", msg, { systemNote: true })],
        status: msg,
      })
      return { ok: false, error: "missing-key" }
    }

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
      liveStream: { source: "Web narrator", chars: 0, startedAt: Date.now() },
    })

    const messages = buildNarratorMessages({
      foreground: currentStoryData.foreground,
      memory: currentStoryData.memory,
      includesIndex: currentStoryData.includesIndex,
      recentCanon,
      action,
    })

    let acc = ""
    const updatePending = () => {
      const entries = state.entries.slice()
      const last = entries[entries.length - 1]
      if (last && last.id === pending.id) {
        entries[entries.length - 1] = { ...last, text: acc }
        state = { ...state, entries, liveStream: { ...(state.liveStream || {}), chars: acc.length } }
        emitState()
      }
    }

    try {
      await streamChat({
        provider: call.provider,
        baseUrl: call.baseUrl,
        apiKey: call.apiKey,
        model: call.narrationModel,
        temperature: 0.85,
        maxTokens: 1600,
        messages,
        onDelta: (delta) => { acc += delta; updatePending() },
      })
    } catch (err) {
      const message = err?.message || "narration failed"
      const entries = state.entries.slice()
      const last = entries[entries.length - 1]
      if (last && last.id === pending.id) {
        entries[entries.length - 1] = { ...last, text: acc || `⚠️ ${message}`, complete: true, pending: false, error: true }
      }
      patchState({ entries, busy: false, mode: "idle", status: message, liveStream: null, lastError: { scope: "narration", message } })
      return { ok: false, error: message }
    }

    const finalText = normalizeOvlFences(acc).trim() || "…"
    const entries = state.entries.slice()
    const last = entries[entries.length - 1]
    if (last && last.id === pending.id) {
      entries[entries.length - 1] = { ...last, text: finalText, complete: true, pending: false }
    }
    recentCanon = appendRecentCanon(recentCanon, action, finalText)
    patchState({
      entries,
      busy: false,
      mode: "idle",
      status: "ready",
      liveStream: null,
      aggregate: {
        ...state.aggregate,
        modelCalls: state.aggregate.modelCalls + 1,
        charactersStreamed: state.aggregate.charactersStreamed + finalText.length,
      },
      activity: [
        { id: `turn-${turn}`, at: Date.now(), source: "Web narrator", label: `Narrated turn ${turn}`, status: "done", meta: {} },
        ...(state.activity || []),
      ].slice(0, 24),
    })
    emitBus("foreground.turn.completed", { turn })
    if (state.optionsEnabled) generateOptions(action, finalText)
    return { ok: true }
  }

  // ── onboarding ─────────────────────────────────────────────────────────────

  const finishOnboarding = () => {
    try { window.localStorage.setItem(ONBOARDED_KEY, "1") } catch { /* ignore */ }
    patchState({ mode: "story-selector", onboarding: null, storySelector: buildSelector() })
  }

  const localeFromLanguage = (text) => {
    const v = String(text || "").toLowerCase()
    if (v.includes("chinese") || v.includes("中文") || v.includes("简体")) return "zh"
    return "en"
  }

  // ── snapshots for settings panels (unchanged surface) ────────────────────────

  const getApiKeysSnapshot = () => ({
    keys: API_KEY_SPECS.map((spec) => ({
      ...spec,
      set: Boolean(apiKeys[spec.id]),
      masked: maskKey(apiKeys[spec.id]),
      source: apiKeys[spec.id] ? "browser" : "unset",
      browserSupport: BROWSER_SUPPORT[spec.providerId] || "maybe",
      ticPatterns: "",
    })),
    llm: clone(llmConfig),
    search: clone(searchConfig),
    aliases: {},
    customProviders: [],
    image: null,
  })

  const imageSnapshot = () => {
    const cfg = { ...clone(DEFAULT_IMAGE_SETTINGS.config), ...(imageSettings.config || {}) }
    cfg.apiKey = { set: Boolean(imageSettings.apiKeySecret), masked: maskKey(imageSettings.apiKeySecret) }
    return { config: cfg, provider: cfg.provider || "custom", providers: clone(IMAGE_PROVIDERS), customProviders: clone(imageSettings.customProviders || []), request: "openai-images", configured: false, filePath: "browser localStorage" }
  }
  const ttsSnapshot = () => {
    const cfg = { ...clone(DEFAULT_TTS_SETTINGS.config), ...(ttsSettings.config || {}) }
    cfg.accessToken = { set: Boolean(ttsSettings.accessTokenSecret), masked: maskKey(ttsSettings.accessTokenSecret) }
    return { config: cfg, customProviders: clone(ttsSettings.customProviders || []), voices: clone(DEFAULT_TTS_SETTINGS.voices), filePath: "browser localStorage" }
  }

  const bridge = {
    isWeb: true,
    getState: async () => clone(state),
    subscribe(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener) },
    onBusEvent(handler) { busListeners.add(handler); return () => busListeners.delete(handler) },
    onMenuCommand(handler) { menuListeners.add(handler); return () => menuListeners.delete(handler) },
    onTtsEvent(handler) { ttsListeners.add(handler); return () => ttsListeners.delete(handler) },

    async dispatch(method, ...args) {
      switch (method) {
        case "setInput": patchState({ input: String(args[0] || "") }); return { ok: true }
        case "appendInput": patchState({ input: `${state.input || ""}${args[0] || ""}` }); return { ok: true }
        case "backspaceInput": patchState({ input: String(state.input || "").slice(0, -1) }); return { ok: true }
        case "clearInput": patchState({ input: "" }); return { ok: true }
        case "pickOption": { const o = state.options[Math.max(0, Number(args[0]) - 1)]; patchState({ input: o?.label || "" }); return { ok: true } }
        case "submitOption": { const o = state.options[Math.max(0, Number(args[0]) - 1)]; return submitReaderText(o?.label || "") }
        case "submit":
        case "submitReaderText": {
          if (state.mode === "onboarding") return advanceOnboardingFromInput()
          return submitReaderText()
        }
        case "setNarrationCpm": patchState({ pacing: { ...state.pacing, cpm: Number(args[0]) || 0 } }); return { ok: true }
        case "goToLibrary": goToLibrary(); return { ok: true }
        case "switchToStory": return enterStory(String(args[0] || ""))
        case "confirmStorySelection": {
          const sel = state.storySelector
          const item = sel?.items?.[sel.cursor || 0]
          if (!item) return { ok: true }
          if (item.isNew || item.isImport) {
            patchState({ status: keyDesktopOnly() })
            return desktopRequired(item.isNew ? "Creating a new story" : "Importing a story")
          }
          return enterStory(item.id)
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
          const all = state.storySelector?.allStories || []
          const filtered = all.filter((s) => (s.displayName || "").toLowerCase().includes(query.toLowerCase()))
          patchState({ storySelector: { ...state.storySelector, query, cursor: 0, items: [{ id: "(new)", isNew: true, label: "+ New story..." }, { id: "(import)", isImport: true, label: "Import..." }, ...filtered] } })
          return { ok: true }
        }
        case "setStorySort": patchState({ storySelector: { ...state.storySelector, sortBy: args[0] || "recent" } }); return { ok: true }
        // onboarding
        case "skipOnboarding": finishOnboarding(); return { ok: true }
        case "advanceOnboardingFromApiKey": finishOnboarding(); return { ok: true }
        case "goBackInOnboarding":
          if (state.onboarding?.phase === "api-key") patchState({ onboarding: { ...state.onboarding, phase: "language" } })
          return { ok: true }
        case "answerOnboarding": return advanceOnboardingFromInput(String(args[0] || ""))
        case "readStoryFile": return { ok: true, rel: args[0], content: "File preview is unavailable in the web demo." }
        case "expandStoryTreeNode":
        case "collapseStoryTreeNode": return { ok: true }
        default: return desktopRequired(method)
      }
    },

    getPrefs: async () => clone(prefs),
    setPrefs: async (next) => { prefs = { ...prefs, ...(next || {}) }; writeJson(PREFS_KEY, prefs); return clone(prefs) },
    getServiceStatus: async () => ({ ok: true, web: true, desktop: false }),
    getStoryCover: async (id) => {
      const meta = storyIndex.find((s) => s.id === id)
      return meta?.cover ? { ok: true, dataUrl: `${STORIES_BASE}${meta.cover}` } : { ok: false }
    },
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
    setLlmConfig: async (patch = {}) => { llmConfig = { ...llmConfig, ...(patch || {}) }; writeJson(LLM_CONFIG_KEY, llmConfig); return { ok: true, snapshot: getApiKeysSnapshot() } },
    setSearchConfig: async (patch = {}) => { searchConfig = { ...searchConfig, provider: patch?.provider || "" }; writeJson(SEARCH_CONFIG_KEY, searchConfig); return { ok: true, snapshot: getApiKeysSnapshot() } },
    setTicPatterns: async () => ({ ok: true }),
    setProviderAlias: async () => ({ ok: true }),
    saveCustomProvider: async () => desktopRequired("Custom providers"),
    deleteCustomProvider: async () => desktopRequired("Custom providers"),
    getAdvancedConfig: async () => ({ modelCatalog: [], modelProfiles: [], agentOverrides: [] }),
    setModelCatalogItem: async () => desktopRequired("Model-catalog editing"),
    removeModelCatalogItem: async () => desktopRequired("Model-catalog editing"),
    setModelProfileRoute: async () => desktopRequired("Model routing"),
    setAgentOverride: async () => desktopRequired("Agent overrides"),
    testLlmConnection: async () => ({ ok: false, latencyMs: 0, error: "Connection tests run in the desktop app; in the browser, just pick a story and play to verify your key." }),
    getBehavior: async () => ({}),
    setBehavior: async () => ({ ok: true }),
    getImageSettings: async () => imageSnapshot(),
    setImageSettings: async (patch = {}) => {
      const config = { ...clone(DEFAULT_IMAGE_SETTINGS.config), ...(imageSettings.config || {}) }
      const next = { ...imageSettings, config }
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === "apiKey") next.apiKeySecret = String(value || "")
        else next.config[key] = value
      }
      imageSettings = next
      writeJson(IMAGE_SETTINGS_KEY, imageSettings)
      return { ok: true, snapshot: imageSnapshot() }
    },
    testImageGeneration: async () => desktopRequired("Image generation"),
    getMusicAuth: async () => ({ configured: false, signedIn: false }),
    setMusicConfig: async () => desktopRequired("Music"),
    setMusicToken: async () => desktopRequired("Music"),
    musicLogout: async () => ({ ok: true }),
    musicQrStart: async () => desktopRequired("Music"),
    musicQrPoll: async () => desktopRequired("Music"),
    testMusicConnection: async () => desktopRequired("Music"),
    getMusicCatalog: async () => ({ tracks: [] }),
    getTts: async () => ttsSnapshot(),
    setTts: async (patch = {}) => {
      const config = { ...clone(DEFAULT_TTS_SETTINGS.config), ...(ttsSettings.config || {}) }
      const next = { ...ttsSettings, config }
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === "accessToken") next.accessTokenSecret = String(value || "")
        else next.config[key] = value
      }
      ttsSettings = next
      writeJson(TTS_SETTINGS_KEY, ttsSettings)
      return { ok: true, snapshot: ttsSnapshot() }
    },
    ttsControl: async () => ({ ok: true }),
    getEnvironment: async () => ({ variables: [], OPENOVEL_WEB: "1" }),
    setEnvironment: async () => desktopRequired("Environment editing"),
    exportStory: async () => desktopRequired("Story export"),
    exportNovel: async () => desktopRequired("Novel export"),
    copyShareImage: async () => desktopRequired("Native image copy"),
    saveShareImage: async () => desktopRequired("Native image save"),
    importStory: async () => desktopRequired("Story import"),
    getUserMemory: async () => ({ content: window.localStorage.getItem(MEMORY_KEY) || "" }),
    setUserMemory: async (content) => { window.localStorage.setItem(MEMORY_KEY, String(content || "")); return { ok: true } },
    getMemorySnapshot: async () => ({ user: window.localStorage.getItem(MEMORY_KEY) || "", observed: "", stories: [] }),
    clearMemoryTarget: async () => { window.localStorage.removeItem(MEMORY_KEY); return { ok: true } },
    getPreferenceTagGroups: async () => ({ groups: [] }),
    getInitDepth: async () => ({ value: null, sourcedFrom: "unset" }),
    setInitDepth: async () => ({ ok: true }),
  }

  // Onboarding: advance from the language pick (input holds the chosen language)
  // to the api-key step; the modal's Finish/Skip then closes onboarding.
  function advanceOnboardingFromInput(answer) {
    const ob = state.onboarding
    if (!ob) return { ok: true }
    if (ob.phase === "language") {
      const chosen = answer != null ? answer : state.input
      const locale = localeFromLanguage(chosen)
      prefs = { ...prefs, locale }
      writeJson(PREFS_KEY, prefs)
      patchState({ input: "", onboarding: { ...ob, phase: "api-key", locale } })
      return { ok: true }
    }
    finishOnboarding()
    return { ok: true }
  }

  function keyDesktopOnly() {
    const zh = String(prefs.locale || "").startsWith("zh")
    return zh ? "新建故事与导入需要下载桌面版。" : "New stories and imports need the desktop app."
  }

  window.openovel = bridge
  loadIndex()
  return bridge
}
