// preload runs in a privileged context with access to Node + Electron, but
// the renderer it loads into is fully sandboxed (no Node, no openovel). We
// expose ONLY `window.openovel` with explicit methods — the renderer never
// touches the filesystem or our runtime directly.

const { contextBridge, ipcRenderer } = require("electron")

const stateListeners = new Set()
const busListeners = new Set()
const menuListeners = new Set()
const ttsListeners = new Set()

ipcRenderer.on("vm:state", (_event, snapshot) => {
  for (const fn of stateListeners) {
    try { fn(snapshot) } catch { /* ignore */ }
  }
})
ipcRenderer.on("vm:bus", (_event, payload) => {
  for (const fn of busListeners) {
    try { fn(payload.name, payload.properties) } catch { /* ignore */ }
  }
})
ipcRenderer.on("menu:command", (_event, name) => {
  for (const fn of menuListeners) {
    try { fn(name) } catch { /* ignore */ }
  }
})
// TTS audio/lifecycle events from the main-process bridge. One channel carries
// { type: "audio"|"end"|"cancel"|"error", ... } so useTtsKaraoke subscribes once.
ipcRenderer.on("tts:event", (_event, payload) => {
  for (const fn of ttsListeners) {
    try { fn(payload) } catch { /* ignore */ }
  }
})

contextBridge.exposeInMainWorld("openovel", {
  getState() {
    return ipcRenderer.invoke("vm:get-state")
  },
  subscribe(listener) {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  },
  onBusEvent(handler) {
    busListeners.add(handler)
    return () => busListeners.delete(handler)
  },
  dispatch(method, ...args) {
    return ipcRenderer.invoke("vm:dispatch", { method, args })
  },
  getPrefs() {
    return ipcRenderer.invoke("prefs:get")
  },
  setPrefs(prefs) {
    return ipcRenderer.invoke("prefs:set", prefs)
  },
  onMenuCommand(handler) {
    menuListeners.add(handler)
    return () => menuListeners.delete(handler)
  },
  getServiceStatus() {
    return ipcRenderer.invoke("service:status")
  },
  getStoryCover(storyId) {
    return ipcRenderer.invoke("story:cover", { storyId })
  },
  getApiKeys() {
    return ipcRenderer.invoke("apikeys:get")
  },
  setApiKeys(patch) {
    return ipcRenderer.invoke("apikeys:set", patch)
  },
  setLlmConfig(patch) {
    return ipcRenderer.invoke("llm:set", patch)
  },
  setTicPatterns(providerId, patterns) {
    return ipcRenderer.invoke("llm:set-tics", { providerId, patterns })
  },
  setProviderAlias(providerId, alias) {
    return ipcRenderer.invoke("llm:set-alias", { providerId, alias })
  },
  saveCustomProvider(patch) {
    return ipcRenderer.invoke("llm:custom-provider-save", patch)
  },
  deleteCustomProvider(id) {
    return ipcRenderer.invoke("llm:custom-provider-delete", { id })
  },
  getAdvancedConfig() {
    return ipcRenderer.invoke("advanced:get")
  },
  setModelCatalogItem(item) {
    return ipcRenderer.invoke("advanced:model-catalog-set", item)
  },
  removeModelCatalogItem(id) {
    return ipcRenderer.invoke("advanced:model-catalog-remove", { id })
  },
  setModelProfileRoute(profileId, route) {
    return ipcRenderer.invoke("advanced:model-route-set", { profileId, route })
  },
  setAgentOverride(agentId, patch) {
    return ipcRenderer.invoke("advanced:agent-set", { agentId, patch })
  },
  setSearchConfig(patch) {
    return ipcRenderer.invoke("search:set", patch)
  },
  testLlmConnection() {
    return ipcRenderer.invoke("llm:test")
  },
  getBehavior() {
    return ipcRenderer.invoke("behavior:get")
  },
  setBehavior(patch) {
    return ipcRenderer.invoke("behavior:set", patch)
  },
  getImageSettings() {
    return ipcRenderer.invoke("image:get")
  },
  setImageSettings(patch) {
    return ipcRenderer.invoke("image:set", patch)
  },
  testImageGeneration() {
    return ipcRenderer.invoke("image:test")
  },
  // Music feature (NetEase 个人接入 + 扫码登录 + the active catalog).
  getMusicAuth() {
    return ipcRenderer.invoke("music:auth-status")
  },
  setMusicConfig(patch) {
    return ipcRenderer.invoke("music:config-set", patch)
  },
  setMusicToken(token) {
    return ipcRenderer.invoke("music:token-set", { token })
  },
  musicLogout() {
    return ipcRenderer.invoke("music:logout")
  },
  musicQrStart() {
    return ipcRenderer.invoke("music:qr-start")
  },
  musicQrPoll(key) {
    return ipcRenderer.invoke("music:qr-poll", { key })
  },
  testMusicConnection() {
    return ipcRenderer.invoke("music:test")
  },
  getMusicCatalog() {
    return ipcRenderer.invoke("music:catalog")
  },
  getTts() {
    return ipcRenderer.invoke("tts:get")
  },
  setTts(patch) {
    return ipcRenderer.invoke("tts:set", patch)
  },
  ttsControl(action) {
    return ipcRenderer.invoke("tts:control", { action })
  },
  onTtsEvent(handler) {
    ttsListeners.add(handler)
    return () => ttsListeners.delete(handler)
  },
  getEnvironment() {
    return ipcRenderer.invoke("environment:get")
  },
  setEnvironment(patch) {
    return ipcRenderer.invoke("environment:set", patch)
  },
  exportStory(storyId, kind) {
    return ipcRenderer.invoke("story:export", { storyId, kind })
  },
  exportNovel(storyId, format, locale) {
    return ipcRenderer.invoke("story:exportNovel", { storyId, format, locale })
  },
  copyShareImage(dataUrl) {
    return ipcRenderer.invoke("share:copyImage", { dataUrl })
  },
  saveShareImage(dataUrl, filename) {
    return ipcRenderer.invoke("share:saveImage", { dataUrl, filename })
  },
  importStory() {
    return ipcRenderer.invoke("story:import")
  },
  getUserMemory() {
    return ipcRenderer.invoke("user-memory:get")
  },
  setUserMemory(content) {
    return ipcRenderer.invoke("user-memory:set", { content })
  },
  getMemorySnapshot() {
    return ipcRenderer.invoke("memory:get")
  },
  clearMemoryTarget(target) {
    return ipcRenderer.invoke("memory:clear", { target })
  },
  getPreferenceTagGroups(locale) {
    return ipcRenderer.invoke("preferences:tag-groups", { locale })
  },
  getInitDepth() {
    return ipcRenderer.invoke("init-depth:get")
  },
  setInitDepth(value) {
    return ipcRenderer.invoke("init-depth:set", { value })
  },
})
