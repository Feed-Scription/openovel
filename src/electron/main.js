// Electron main process entry. Owns the embedded-VM transport, creates the
// BrowserWindow, and forwards state/bus events to the
// renderer over IPC. The renderer is sandboxed via contextIsolation —
// it can only call into the openovel runtime through the bridge exposed
// in preload.js.

import "../lib/networkProxy.js"   // side-effect: route fetch through HTTPS_PROXY when set
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, shell } from "electron"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"
import { createTransport } from "./transport/index.js"
import { loadElectronPrefs, saveElectronPrefs } from "./settingsStore.js"
import { ASSET_SCHEME } from "../lib/includePaths.js"
import { resolveIncludeAssetUrl } from "../lib/includeAsset.js"
import { MUSIC_SCHEME, resolveMusicTarget } from "../lib/musicAsset.js"
import { parseCatalog } from "../music/catalog.js"
import { musicProviderRegistry } from "../music/registry.js"
import { settingsEnv } from "../config/settings.js"

// Privileged custom schemes. MUST be registered before app `ready`. `standard`
// enables proper URL parsing; `stream` lets <video>/<audio> issue range requests
// for seeking; `supportFetchAPI` lets the renderer fetch() the scheme at all;
// `corsEnabled` puts it on Chromium's CORS-enabled scheme list — without it a
// renderer-side fetch() is CROSS-origin (the page is file://, the asset is
// ovl-asset://local) and Chromium refuses it outright ("Cross origin requests
// are only supported for protocol schemes: ..."), which broke text includes and
// the backdrop tone sampler. The flip side of corsEnabled is that responses to
// those cross-origin fetches must now carry Access-Control-Allow-Origin (the
// file:// origin serializes to "null"), hence withCorsHeaders below. Passive
// loads (<img>/<video>/<audio> src) never needed CORS and are unaffected. We
// deliberately do NOT bypassCSP — the renderer's CSP explicitly allows
// ovl-asset: / ovl-music: (see index.html). ovl-asset:// serves story files;
// ovl-music:// resolves a catalog short id → a live provider stream (token stays
// in main).
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: MUSIC_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

// Re-wrap a handler Response with Access-Control-Allow-Origin so renderer
// fetch() can read it (see corsEnabled above). The allow-all origin is safe
// here: both schemes re-validate every request against their trust boundary,
// and the only client is our own renderer (the response never reaches the web).
// Error responses are wrapped too, so a 403/404 surfaces as a status the
// renderer can handle instead of an opaque CORS failure.
function withCorsHeaders(response) {
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", "*")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// Serve a validated file from the active story's includes/ dir. resolveIncludeAssetUrl
// is the trust boundary (path safety + extension allowlist + realpath containment);
// here we just stream the bytes. net.fetch(file://) is range-aware, so video seeks work.
function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const resolved = resolveIncludeAssetUrl(request.url)
    if (!resolved.ok) {
      process.stderr.write(`[ovl-asset] refused ${request.url} — ${resolved.reason}\n`)
      return withCorsHeaders(new Response("forbidden", { status: 403 }))
    }
    try {
      return withCorsHeaders(await net.fetch(pathToFileURL(resolved.path).toString()))
    } catch (error) {
      process.stderr.write(`[ovl-asset] fetch failed ${resolved.path}: ${error?.message || error}\n`)
      return withCorsHeaders(new Response("not found", { status: 404 }))
    }
  })
}

// Read the active story's music catalog fresh (cheap; the agent rewrites it).
async function readMusicCatalog() {
  try {
    const { paths } = await import("../lib/storyStore.js")
    const { readFile } = await import("node:fs/promises")
    const file = path.join(paths.root, "music", "CATALOG.json")
    return parseCatalog(await readFile(file, "utf8"))
  } catch {
    return parseCatalog("")
  }
}

// Serve a music short id: resolve it through the catalog + provider into a live
// stream (or cover) URL, then proxy the bytes — forwarding Range so <audio> can
// seek. The provider token never leaves main; resolveMusicTarget is the trust
// boundary (valid short id ∈ catalog, provider authorized).
function registerMusicProtocol() {
  protocol.handle(MUSIC_SCHEME, async (request) => {
    const resolved = await resolveMusicTarget(request.url, {
      catalog: await readMusicCatalog(),
      registry: musicProviderRegistry,
      env: settingsEnv(),
      fetchImpl: net.fetch,
    })
    if (!resolved.ok) {
      process.stderr.write(`[ovl-music] refused ${request.url} — ${resolved.reason}\n`)
      return withCorsHeaders(new Response("forbidden", { status: 403 }))
    }
    try {
      const range = request.headers.get("range")
      return withCorsHeaders(await net.fetch(resolved.streamUrl, range ? { headers: { Range: range } } : undefined))
    } catch (error) {
      process.stderr.write(`[ovl-music] fetch failed ${resolved.streamUrl}: ${error?.message || error}\n`)
      return withCorsHeaders(new Response("not found", { status: 404 }))
    }
  })
}

// ── CLI flag parsing (must run before any code reads OPENOVEL_HOME) ────
// Supported flags (pass via `npm run electron -- --flag value`):
//   --home <path>     Pin OPENOVEL_HOME to <path>. Useful for keeping a
//                     parallel sandbox alongside your real ~/.openovel.
//   --tmp-home        Create a fresh temp dir, set OPENOVEL_HOME to it.
//                     Best for testing the first-run onboarding /
//                     preference-research flow with a guaranteed clean
//                     slate. The dir is NOT deleted on exit so you can
//                     inspect it; rerunning the flag creates a NEW dir.
//   --fresh-cwd       Also point cwd-derived `.openovel/` config to a
//                     temp scratch dir (so project-local settings don't
//                     leak in). Implied by --tmp-home.
//
// Electron prepends its own args + the entrypoint to process.argv, so we
// scan from index 1 onward and tolerate unknown flags (Electron has many
// of its own like --remote-debugging-port).
function parseCliFlags(argv) {
  const out = {}
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf("=")
    const name = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : null
    const next = inline ?? argv[i + 1]
    if (name === "--home") { out.home = next; if (!inline) i++ }
    else if (name === "--tmp-home") { out.tmpHome = true }
    else if (name === "--fresh-cwd") { out.freshCwd = true }
  }
  return out
}

const cliFlags = parseCliFlags(process.argv)
if (cliFlags.tmpHome) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openovel-tmphome-"))
  process.env.OPENOVEL_HOME = dir
  // Force a fresh project-config dir too — otherwise a ./.openovel/ from
  // the launch cwd shadows the temp home's settings.
  cliFlags.freshCwd = cliFlags.freshCwd !== false
  console.log(`[openovel] --tmp-home → OPENOVEL_HOME=${dir}`)
}
if (cliFlags.home) {
  process.env.OPENOVEL_HOME = path.resolve(cliFlags.home)
  console.log(`[openovel] --home → OPENOVEL_HOME=${process.env.OPENOVEL_HOME}`)
}
if (cliFlags.freshCwd) {
  // The settings layer also walks up cwd for .openovel/*.jsonc. In a
  // tmp-home test we want NO project-local override pollution, so steer
  // discovery away from real project dirs by setting the suppression flag
  // documented in src/config/settings.js#discoverSettingsLayers.
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  console.log("[openovel] --fresh-cwd → OPENOVEL_IGNORE_PROJECT_CONFIG=1")
}

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, "..", "..")
const RENDERER_HTML = path.join(ROOT, "dist-electron", "renderer", "index.html")
const PRELOAD = path.join(here, "preload.cjs")
// Two icon files on purpose:
// - icon.png is the bare 1024 square, fed to electron-builder so macOS can
//   apply its own squircle mask when generating the .icns for packaged builds.
// - icon-dev.png is pre-masked with rounded corners; we hand it to
//   app.dock.setIcon() in dev mode because `setIcon` does NOT apply the macOS
//   icon template — so a raw square would sit next to round-cornered neighbors
//   in the dock and look like a debug build.
const ICON_PNG = path.join(ROOT, "build", "icon.png")
const ICON_DOCK = path.join(ROOT, "build", "icon-dev.png")

let mainWindow = null
let transport = null
let isQuitting = false
let transportShutdownPromise = null
let transportBootPromise = null

// The IPC handlers reach the transport through this, never the bare `transport`
// var. If a renderer crash + window recreate (or a cancelled quit) left the
// transport null, this rebuilds it from disk so the UI recovers instead of
// throwing `Cannot read properties of null (reading 'getState')` forever.
async function ensureTransport() {
  if (transport) return transport
  if (isQuitting) return null
  if (transportBootPromise) return transportBootPromise
  transportBootPromise = (async () => {
    transportShutdownPromise = null // a recreated transport is no longer shutting down
    transport = await createTransport({
      onState: (snapshot) => sendVmState(snapshot),
      onBusEvent: (name, properties) => send("vm:bus", { name, properties }),
    })
    return transport
  })()
  try {
    return await transportBootPromise
  } finally {
    transportBootPromise = null
  }
}

async function createWindow() {
  bootLog("createWindow: new BrowserWindow")
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Matches the renderer's --paper page background. Was #101015 (the
    // pre-redesign dark palette) — caused a brief flash of dark grey on
    // first paint before the bundle loaded.
    backgroundColor: "#f4f4f4",
    // Linux honors BrowserWindow.icon at runtime; macOS uses the bundle
    // icon (and app.dock.setIcon below for dev); Windows uses the .ico
    // baked in by electron-builder for packaged builds.
    icon: ICON_PNG,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses contextBridge but needs Node APIs for IPC
    },
  })
  mainWindow = window

  // CRITICAL: attach ready-to-show BEFORE loadFile to avoid a race where
  // first paint fires before the listener is registered, leaving the window
  // stuck at show: false forever (dock icon bounces, app never appears).
  // Also keep a hard fallback that force-shows after 2s in case ready-to-show
  // never fires for some other reason (renderer crash, blank load, etc.) —
  // a visible window with a console error is always better than an invisible
  // app that can't even be quit cleanly.
  window.once("ready-to-show", () => {
    bootLog("ready-to-show fired")
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
    }
  })
  const fallbackShow = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      bootLog("fallback-show fired (ready-to-show did not fire in 2s)")
      window.show()
      window.focus()
    }
  }, 2000)
  window.once("show", () => { bootLog("window shown"); clearTimeout(fallbackShow) })

  window.once("closed", () => {
    clearTimeout(fallbackShow)
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.on("did-fail-load", (_e, code, desc) => {
    process.stderr.write(`[boot] renderer failed to load: ${code} ${desc}\n`)
  })
  window.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`[boot] render process gone: ${JSON.stringify(details)}\n`)
    // A GPU/renderer crash (exit_code 15) kills the view but NOT the main-process
    // transport. Reload the renderer in place so the UI recovers automatically
    // (its vm:get-state then re-attaches via ensureTransport) instead of leaving
    // a dead window until the user re-activates the app.
    if (isQuitting || details?.reason === "clean-exit" || window.isDestroyed()) return
    setTimeout(() => {
      try {
        if (!window.isDestroyed()) window.reload()
      } catch (e) {
        process.stderr.write(`[boot] reload after crash failed: ${e?.message || e}\n`)
      }
    }, 300)
  })
  window.webContents.on("console-message", (_e, level, message, line, source) => {
    process.stderr.write(`[renderer console L${level}] ${source}:${line} ${message}\n`)
  })

  bootLog("createWindow: loadFile")
  await window.loadFile(RENDERER_HTML)
  bootLog("createWindow: loadFile resolved")

  if (process.env.OPENOVEL_ELECTRON_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" })
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// vm:state is the hot channel: narration reveal emits a full snapshot many
// times a second, and webContents.send structured-clones the whole thing on the
// main thread. Throttle to ~60fps (leading + trailing, latest wins) so a burst
// of sub-frame emits collapses into one serialize+send instead of starving the
// main thread. Latency added is at most one frame — invisible for reveal.
let pendingVmState = null
let vmStateHasPending = false
let vmStateTimer = null
let vmStateLastSentAt = 0
function flushVmState() {
  vmStateTimer = null
  if (!vmStateHasPending) return
  const snap = pendingVmState
  pendingVmState = null
  vmStateHasPending = false
  vmStateLastSentAt = Date.now()
  send("vm:state", snap)
}
function sendVmState(snapshot) {
  const since = Date.now() - vmStateLastSentAt
  if (since >= 16 && !vmStateTimer) {
    vmStateLastSentAt = Date.now()
    send("vm:state", snapshot)
    return
  }
  pendingVmState = snapshot
  vmStateHasPending = true
  if (!vmStateTimer) vmStateTimer = setTimeout(flushVmState, Math.max(0, 16 - since))
}

async function bootTransport() {
  // Load the settings stores and mirror saved values → process.env BEFORE the
  // VM is constructed. The embedded VM reads options / pacing / format-contract
  // off process.env in its INITIAL state (initialState(env)); hydrating AFTER
  // createTransport would leave that first state on defaults — the root of the
  // "行为 toggles don't take effect (来源：file)" report, because
  // settings.local.json under $OPENOVEL_HOME is not a config layer loadSettings()
  // reliably reads, and nothing else mirrors these toggles into process.env.
  const { getApiKeysSnapshot, setApiKeys, setLlmConfig, setTicPatterns, setProviderAlias, setSearchConfig, saveCustomProvider, deleteCustomProvider, ensureProviderConsistent, hydrateProcessEnvFromSettings } = await import("./apiKeysStore.js")
  const { getAdvancedConfigSnapshot, setModelCatalogItem, removeModelCatalogItem, setModelProfileRoute, setAgentOverride } = await import("./advancedConfigStore.js")
  const { getTtsSnapshot, setTts, hydrateTtsEnvFromSettings } = await import("./ttsStore.js")
  const { startTtsBridge } = await import("./ttsBridge.js")
  const { getBehaviorSnapshot, setBehavior, hydrateBehaviorEnvFromSettings } = await import("./behaviorStore.js")
  const { getEnvironmentSnapshot, setEnvironment } = await import("./environmentStore.js")
  const { getImageSettingsSnapshot, setImageSettings, testImageGeneration, hydrateImageEnvFromSettings } = await import("./imageSettingsStore.js")
  const { buildServiceStatus } = await import("./serviceStatus.js")
  const { resetResidentConfigs } = await import("../runtime/residentTeam.js")
  const {
    getMusicAuthSnapshot, setMusicConfig, setMusicToken, clearMusicAuth,
    startMusicQr, pollMusicQr, hydrateMusicEnvFromSettings, testMusicConnection,
  } = await import("./musicAuthStore.js")
  try {
    await hydrateProcessEnvFromSettings()
    await hydrateTtsEnvFromSettings()
    await hydrateBehaviorEnvFromSettings()
    await hydrateMusicEnvFromSettings()
    await hydrateImageEnvFromSettings()
  } catch (e) {
    console.warn("[settings] env hydrate failed:", e?.message || e)
  }
  // Heal stale state where settings.local.json pins a foreground provider but
  // background still points at a previously-selected one (no UI diverges them);
  // otherwise background agent runs fail with "Missing provider API key".
  try {
    const healed = await ensureProviderConsistent()
    if (healed) console.log("[apiKeysStore] healed stale background provider to match foreground")
  } catch (e) {
    console.warn("[apiKeysStore] heal failed:", e?.message || e)
  }

  await ensureTransport()

  // Main-process TTS bridge: synthesizes narration sentences (published on the
  // bus by the VM) and streams audio to the renderer. Idle unless TTS is on.
  const ttsBridge = startTtsBridge({ send })

  // Route through ensureTransport so a null transport (after a renderer crash +
  // window recreate, or a cancelled quit) is rebuilt instead of throwing.
  ipcMain.handle("vm:get-state", async () => {
    const t = await ensureTransport()
    return t ? t.getState() : null
  })
  ipcMain.handle("vm:dispatch", async (_event, { method, args }) => {
    const t = await ensureTransport()
    if (!t) throw new Error("transport unavailable (app is shutting down)")
    return t.dispatch(method, args || [])
  })
  ipcMain.handle("prefs:get", () => loadElectronPrefs())
  ipcMain.handle("prefs:set", (_event, prefs) => saveElectronPrefs(prefs))

  // ── Settings tab IPC ── (stores imported + hydrated above, before the VM)

  ipcMain.handle("service:status", async () => {
    return buildServiceStatus({
      getSessionAggregate: async () => {
        try {
          const snap = await (await ensureTransport())?.getState()
          return {
            aggregate: snap?.aggregate || null,
            inboxCount: snap?.inboxCount || 0,
            currentStory: snap?.currentStory || null,
          }
        } catch { return null }
      },
    })
  })
  // Story share/export: VM builds the bundle, main opens the save dialog
  // so the renderer never touches the filesystem directly.
  // Library cover art for a story card. The id is resolved through
  // listStories (never joined into a path), so a hostile id can't escape the
  // stories root; bytes ride back as a data URI the <img> can use directly.
  ipcMain.handle("story:cover", async (_event, { storyId } = {}) => {
    try {
      const { listStories } = await import("../lib/storyDirectory.js")
      const story = (await listStories()).find((s) => s.id === storyId)
      if (!story?.coverFile) return { ok: false }
      const { readFile } = await import("node:fs/promises")
      const { sniffImageKind } = await import("../lib/imageWrite.js")
      const bytes = await readFile(story.coverFile)
      const kind = sniffImageKind(bytes)
      if (!kind) return { ok: false }
      const mime = kind === "jpeg" ? "image/jpeg" : `image/${kind}`
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, version: story.coverVersion }
    } catch {
      return { ok: false }
    }
  })
  ipcMain.handle("story:export", async (_event, { storyId, kind } = {}) => {
    try {
      const bundle = await (await ensureTransport()).dispatch("exportStorySnapshot", [{ storyId, kind: kind || "current" }])
      const defaultName = `openovel-${bundle.storyId || "story"}-${kind || "current"}.json`
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Export story snapshot",
        defaultPath: defaultName,
        filters: [{ name: "openovel snapshot", extensions: ["json"] }],
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, cancelled: true }
      }
      const { writeFile } = await import("node:fs/promises")
      await writeFile(result.filePath, JSON.stringify(bundle, null, 2), "utf8")
      return { ok: true, path: result.filePath, fileCount: bundle.fileCount }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })
  // Novel export — VM builds an EPUB or TXT, main opens the save dialog and
  // writes the bytes to disk. Distinct from story:export, which exports the
  // full workspace snapshot as JSON for round-trip restore.
  ipcMain.handle("story:exportNovel", async (_event, { storyId, format, locale } = {}) => {
    try {
      const fmt = format === "txt" ? "txt" : "epub"
      const result = await (await ensureTransport()).dispatch("exportStoryNovel", [{ storyId, format: fmt, locale }])
      const filters = fmt === "txt"
        ? [{ name: "Plain text", extensions: ["txt"] }]
        : [{ name: "EPUB e-book", extensions: ["epub"] }]
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        title: fmt === "txt" ? "Export novel as TXT" : "Export novel as EPUB",
        defaultPath: result.filename,
        filters,
      })
      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, cancelled: true }
      }
      const { writeFile } = await import("node:fs/promises")
      await writeFile(saveResult.filePath, result.data)
      return {
        ok: true,
        path: saveResult.filePath,
        format: fmt,
        chapterCount: result.chapterCount,
        title: result.title,
      }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })
  // Paragraph share — the renderer rasterizes a narration paragraph into a PNG
  // data URL (snapdom); main puts it on the clipboard or writes it to disk.
  // Clipboard image write goes through Electron's nativeImage/clipboard (the
  // renderer's navigator.clipboard is unreliable on the file:// origin).
  ipcMain.handle("share:copyImage", async (_event, { dataUrl } = {}) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ""))
      if (img.isEmpty()) return { ok: false, error: "empty image" }
      clipboard.writeImage(img)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })
  ipcMain.handle("share:saveImage", async (_event, { dataUrl, filename } = {}) => {
    try {
      const m = String(dataUrl || "").match(/^data:image\/png;base64,(.+)$/)
      if (!m) return { ok: false, error: "expected a png data URL" }
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save paragraph image",
        defaultPath: filename || "openovel-paragraph.png",
        filters: [{ name: "PNG image", extensions: ["png"] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
      const { writeFile } = await import("node:fs/promises")
      await writeFile(result.filePath, Buffer.from(m[1], "base64"))
      return { ok: true, path: result.filePath }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })
  // Story import — file dialog → JSON parse → dispatch to VM. The
  // renderer never touches the filesystem; main does the IO and the VM
  // restores files into a new story slot.
  ipcMain.handle("story:import", async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Import story snapshot",
        properties: ["openFile"],
        filters: [
          { name: "openovel snapshot", extensions: ["json"] },
          { name: "All files", extensions: ["*"] },
        ],
      })
      if (result.canceled || !result.filePaths?.[0]) {
        return { ok: false, cancelled: true }
      }
      const { readFile } = await import("node:fs/promises")
      const text = await readFile(result.filePaths[0], "utf8")
      let bundle
      try { bundle = JSON.parse(text) }
      catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` } }
      const outcome = await (await ensureTransport()).dispatch("importStorySnapshot", [{ bundle }])
      return outcome
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  })
  ipcMain.handle("apikeys:get", () => getApiKeysSnapshot())
  ipcMain.handle("apikeys:set", (_event, patch) => setApiKeys(patch || {}))
  ipcMain.handle("llm:set", (_event, patch) => setLlmConfig(patch || {}))
  ipcMain.handle("llm:set-tics", (_event, { providerId, patterns } = {}) => setTicPatterns(providerId, patterns))
  ipcMain.handle("llm:set-alias", (_event, { providerId, alias } = {}) => setProviderAlias(providerId, alias))
  ipcMain.handle("llm:custom-provider-save", (_event, patch) => saveCustomProvider(patch || {}))
  ipcMain.handle("llm:custom-provider-delete", (_event, { id } = {}) => deleteCustomProvider(id || ""))
  ipcMain.handle("advanced:get", () => getAdvancedConfigSnapshot())
  ipcMain.handle("advanced:model-catalog-set", (_event, item) => setModelCatalogItem(item || {}))
  ipcMain.handle("advanced:model-catalog-remove", (_event, { id } = {}) => removeModelCatalogItem(id || ""))
  ipcMain.handle("advanced:model-route-set", (_event, { profileId, route } = {}) => setModelProfileRoute(profileId, route || null))
  ipcMain.handle("advanced:agent-set", async (_event, { agentId, patch } = {}) => {
    const result = await setAgentOverride(agentId, patch || null)
    resetResidentConfigs()
    return result
  })
  ipcMain.handle("search:set", (_event, patch) => setSearchConfig(patch || {}))
  ipcMain.handle("llm:test", async () => {
    // Minimal chat ping against the currently-configured foreground route.
    // We use a tiny prompt + low max-tokens so this is cheap (well under
    // a cent on any of the supported providers) and fast (<5s typical).
    const t0 = Date.now()
    // Belt-and-suspenders: also hydrate right before the test. If the user
    // saved a key in another tab / window / panel since startup, this
    // catches it. The hydrate is a single file read — cheap.
    try { await hydrateProcessEnvFromSettings() } catch { /* tolerate */ }
    try {
      const { chatMessage, providerRoute } = await import("../provider/provider.js")
      const fullRoute = providerRoute({ role: "foreground" })
      const route = fullRoute.filter((p) => p.keyConfigured)
      if (!route.length) {
        // Diagnostic — surface WHICH provider got picked and what key env
        // it was looking for. Without this the user only sees the generic
        // "No provider key configured" string and can't tell whether the
        // route resolved to the wrong provider or whether the env var
        // really is empty.
        const first = fullRoute[0]
        const detail = first
          ? `pinned provider: ${first.id} (needs ${Array.isArray(first.keyEnv) ? first.keyEnv.join("/") : first.keyEnv}); set ${(first.keyEnv && (Array.isArray(first.keyEnv) ? first.keyEnv[0] : first.keyEnv)) || "the key env var"} or pick another preset`
          : "no provider matched the current AI_PROVIDER pin"
        return { ok: false, error: `No provider key configured. ${detail}` }
      }
      const message = await chatMessage({
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        role: "foreground",
        // Pin to the active provider (the one we report below). A connection
        // test must probe ONLY that provider, not walk the fallback chain —
        // otherwise the error mixes in unrelated providers (e.g. a deepseek
        // "model not found" when the user is testing a custom gateway).
        providerId: route[0].id,
        maxTokens: 16,
        temperature: 0,
        timeoutMs: 30_000,
        // Diagnostic call — surface the first transient failure to the
        // user instead of silently retrying for 30+ s of backoff. If the
        // proxy / network is flaky, the user wants to see that fact, not
        // a misleading "took 11 seconds" success.
        maxAttempts: 1,
      })
      const text = String(message?.content || "").trim()
      return {
        ok: true,
        provider: route[0].id,
        model: route[0].model,
        latencyMs: Date.now() - t0,
        sample: text.slice(0, 120),
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: error?.message || String(error),
      }
    }
  })
  ipcMain.handle("behavior:get", () => getBehaviorSnapshot())
  ipcMain.handle("behavior:set", (_event, patch) => setBehavior(patch || {}))
  // Image generation provider settings + smoke test. Credentials stay in main;
  // renderer only sees a redacted snapshot and test metadata.
  ipcMain.handle("image:get", () => getImageSettingsSnapshot())
  ipcMain.handle("image:set", (_event, patch) => setImageSettings(patch || {}))
  ipcMain.handle("image:test", () => testImageGeneration())
  // Music feature: 个人接入 credentials + 扫码登录 token + the active catalog.
  ipcMain.handle("music:auth-status", () => getMusicAuthSnapshot())
  ipcMain.handle("music:config-set", (_event, patch) => setMusicConfig(patch || {}))
  ipcMain.handle("music:token-set", (_event, { token } = {}) => setMusicToken(token || ""))
  ipcMain.handle("music:logout", () => clearMusicAuth())
  ipcMain.handle("music:qr-start", () => startMusicQr())
  ipcMain.handle("music:qr-poll", (_event, { key } = {}) => pollMusicQr(key))
  ipcMain.handle("music:test", () => testMusicConnection())
  ipcMain.handle("music:catalog", () => readMusicCatalog())
  ipcMain.handle("tts:get", () => getTtsSnapshot())
  ipcMain.handle("tts:set", (_event, patch) => setTts(patch || {}))
  ipcMain.handle("tts:control", (_event, { action } = {}) => ttsBridge.control(action))
  ipcMain.handle("environment:get", () => getEnvironmentSnapshot())
  ipcMain.handle("environment:set", (_event, patch) => setEnvironment(patch || {}))

  // ── User preferences (~/.openovel/memory/USER.md) ──
  // This file is the durable, narrator-readable record of the user's
  // reading preferences. Onboarding writes it; the user can edit it
  // freeform to teach the runtime taste-changes without needing to re-run
  // first-run setup. Both handlers tolerate "file doesn't exist yet" by
  // returning empty content — the first save creates it.
  ipcMain.handle("user-memory:get", async () => {
    const { readFile } = await import("node:fs/promises")
    const { workspaceLayout } = await import("../lib/workspacePaths.js")
    const layoutPath = workspaceLayout({ env: process.env }).userMemory
    try {
      const content = await readFile(layoutPath, "utf8")
      return { ok: true, path: layoutPath, content, exists: true }
    } catch (err) {
      if (err.code === "ENOENT") return { ok: true, path: layoutPath, content: "", exists: false }
      return { ok: false, path: layoutPath, error: err.message || String(err) }
    }
  })
  ipcMain.handle("user-memory:set", async (_event, { content } = {}) => {
    const { writeFile, mkdir } = await import("node:fs/promises")
    const path = (await import("node:path")).default
    const { workspaceLayout } = await import("../lib/workspacePaths.js")
    const layoutPath = workspaceLayout({ env: process.env }).userMemory
    try {
      await mkdir(path.dirname(layoutPath), { recursive: true })
      await writeFile(layoutPath, String(content ?? ""), "utf8")
      return { ok: true, path: layoutPath }
    } catch (err) {
      return { ok: false, path: layoutPath, error: err.message || String(err) }
    }
  })

  // ── Memory viewer/reset IPC ──
  // Renderer gets a read-only snapshot and can request explicit clears. The
  // filesystem details stay in memoryStore so generated topic files are kept in
  // sync when a target is reset.
  ipcMain.handle("memory:get", async () => {
    try {
      const { getMemorySnapshot } = await import("../memory/memoryStore.js")
      const snap = await getMemorySnapshot({ includeDisabledCrossStory: true })
      return {
        ok: true,
        crossStoryMemoryEnabled: snap.crossStoryMemoryEnabled !== false,
        targets: {
          story: {
            id: "story",
            path: snap.paths?.storyMemory || "",
            content: snap.story || snap.memory || "",
          },
          user: {
            id: "user",
            path: snap.paths?.userMemory || "",
            content: snap.user || "",
          },
          observed: {
            id: "observed",
            path: snap.paths?.userObservedMemory || "",
            content: snap.observed || "",
          },
          references: {
            id: "references",
            path: snap.paths?.sharedReferences || "",
            content: snap.references || "",
          },
        },
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  })
  ipcMain.handle("memory:clear", async (_event, { target } = {}) => {
    try {
      const { clearMemoryTarget } = await import("../memory/memoryStore.js")
      const id = String(target || "").trim()
      const allowed = new Set(["story", "memory", "user", "observed", "references", "crossStory"])
      if (!allowed.has(id)) return { ok: false, error: `Unknown memory target: ${id || "(empty)"}` }
      if (id === "crossStory") {
        const observed = await clearMemoryTarget("observed")
        const references = await clearMemoryTarget("references")
        return { ok: true, target: id, results: { observed, references } }
      }
      const result = await clearMemoryTarget(id)
      return { ok: true, target: id, result }
    } catch (err) {
      return { ok: false, target, error: err?.message || String(err) }
    }
  })

  // Tag groups for the Preferences form view. The canonical source is
  // src/onboarding/preferenceOnboarding.js (node-only — uses fs / path),
  // so the renderer can't import it directly. Surface via IPC.
  ipcMain.handle("preferences:tag-groups", async (_event, { locale = "en" } = {}) => {
    const { preferenceQuestions } = await import("../onboarding/preferenceOnboarding.js")
    const styleQ = preferenceQuestions(locale).find((q) => q.id === "style_comparison")
    return { locale, groups: styleQ?.tagGroups || [] }
  })

  // Initialization depth — null until the user picks one. VM reads it from
  // process.env.OPENOVEL_INIT_DEPTH; renderer reads/writes via these handlers.
  ipcMain.handle("init-depth:get", async () => {
    const { getInitDepth } = await import("./initDepthStore.js")
    return getInitDepth()
  })
  ipcMain.handle("init-depth:set", async (_event, { value } = {}) => {
    const { setInitDepth } = await import("./initDepthStore.js")
    return setInitDepth(value)
  })
}

async function shutdownTransport() {
  if (transportShutdownPromise) return transportShutdownPromise
  transportShutdownPromise = (async () => {
    try { await transport?.shutdown?.() } catch { /* ignore */ }
    transport = null
  })()
  return transportShutdownPromise
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return true
}

function buildMenu() {
  const isMac = process.platform === "darwin"
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "Story",
      submenu: [
        {
          label: "New story…",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu:command", "new-story"),
        },
        {
          label: "Switch story…",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu:command", "switch-story"),
        },
        { type: "separator" },
        {
          label: "Open story folder",
          click: () => mainWindow?.webContents.send("menu:command", "open-story-folder"),
        },
        { type: "separator" },
        // GUI entries for what used to be the /permissions and /transactions
        // text commands — typed slash commands are disabled in the reader input.
        {
          label: "Permissions…",
          click: () => mainWindow?.webContents.send("menu:command", "permissions"),
        },
        {
          label: "Transactions…",
          click: () => mainWindow?.webContents.send("menu:command", "transactions"),
        },
      ],
    },
    // Standard Edit menu — required for Cmd+C / Cmd+V / Cmd+X / Cmd+A to
    // reach input fields on macOS. Without these role-bound items the
    // accelerators are dropped before they hit the renderer.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("menu:command", "open-settings"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "openovel docs",
          click: async () => {
            await shell.openExternal("https://github.com/anthropics/claude-code/issues")
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const BOOT_T0 = Date.now()
let bootLast = BOOT_T0
function bootLog(stage) {
  const now = Date.now()
  const total = now - BOOT_T0
  const delta = now - bootLast
  bootLast = now
  process.stderr.write(`[boot +${String(total).padStart(5)}ms Δ${String(delta).padStart(5)}ms] ${stage}\n`)
}

app.whenReady().then(async () => {
  bootLog("app.whenReady")
  if (process.platform === "darwin" && app.dock) {
    try {
      const { nativeImage } = await import("electron")
      const img = nativeImage.createFromPath(ICON_DOCK)
      if (!img.isEmpty()) app.dock.setIcon(img)
    } catch { /* missing icon shouldn't block boot */ }
  }
  bootLog("dock-icon-set")
  registerAssetProtocol()
  registerMusicProtocol()
  bootLog("assetProtocol")
  try {
    bootLog("bootTransport:start")
    await bootTransport()
    bootLog("bootTransport:done")
  } catch (error) {
    process.stderr.write(`openovel transport failed: ${error.stack || error.message}\n`)
  }
  bootLog("buildMenu")
  buildMenu()
  bootLog("createWindow:start")
  await createWindow()
  bootLog("createWindow:done")
})

app.on("before-quit", (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  void shutdownTransport().finally(() => app.quit())
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", async () => {
  if (showMainWindow()) return
  await createWindow()
  showMainWindow()
})

process.on("SIGINT", () => app.quit())
process.on("SIGTERM", () => app.quit())
