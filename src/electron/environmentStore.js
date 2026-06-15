// Read + write environment-level settings (home directory + proxy URL).
//
// These differ from API keys (per-provider strings) and behavior toggles
// (booleans) — they're path / URL strings that affect every other subsystem.
//
// Persistence rules:
//   - workspace.home → ~/.openovel/settings.local.json `workspace.home`
//     Note: we write to the CURRENT home, not the new home. Migrating the
//     data directory is the user's job; the runtime just reads the new path
//     on next boot.
//   - network.proxyUrl + network.noProxy → settings.local.json `network.*`
//     We ALSO update process.env right away so the running session picks
//     them up, and re-install undici's EnvHttpProxyAgent so future fetch()
//     calls honor the new proxy.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    const text = await readFile(settingsFilePath(), "utf8")
    return JSON.parse(text)
  } catch { return {} }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

export async function getEnvironmentSnapshot() {
  const settings = await readSettingsFile()
  const home = process.env.OPENOVEL_HOME || settings?.workspace?.home || path.join(os.homedir(), ".openovel")
  // For proxy display we prefer the unified one — they're typically all set
  // to the same value. HTTPS first since that's the one undici actually uses.
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY  || process.env.http_proxy  ||
    process.env.ALL_PROXY   || process.env.all_proxy   ||
    settings?.network?.proxyUrl || ""
  const noProxy =
    process.env.NO_PROXY || process.env.no_proxy ||
    settings?.network?.noProxy || ""
  return {
    home,
    homeDefault: path.join(os.homedir(), ".openovel"),
    proxyUrl,
    noProxy,
    sourcedFrom: {
      home:     process.env.OPENOVEL_HOME ? "env" : (settings?.workspace?.home ? "file" : "default"),
      proxyUrl: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) ? "env" : (settings?.network?.proxyUrl ? "file" : "default"),
      noProxy:  process.env.NO_PROXY ? "env" : (settings?.network?.noProxy ? "file" : "default"),
    },
    filePath: settingsFilePath(),
  }
}

// Patch shape: { home?, proxyUrl?, noProxy? }. Empty string clears.
export async function setEnvironment(patch = {}) {
  const settings = await readSettingsFile()
  settings.workspace = settings.workspace || {}
  settings.network = settings.network || {}

  const changes = []
  let proxyChanged = false

  if (typeof patch.home === "string") {
    const home = patch.home.trim()
    if (home) settings.workspace.home = home
    else delete settings.workspace.home
    process.env.OPENOVEL_HOME = home || ""
    changes.push({ key: "home", value: home, appliesNextRestart: true })
  }

  if (typeof patch.proxyUrl === "string") {
    const url = patch.proxyUrl.trim()
    if (url) settings.network.proxyUrl = url
    else delete settings.network.proxyUrl
    // Mirror to all three env vars so curl-style + fetch-style + node-fetch
    // libraries all see the same proxy.
    if (url) {
      process.env.HTTPS_PROXY = url
      process.env.HTTP_PROXY  = url
      process.env.ALL_PROXY   = url
    } else {
      delete process.env.HTTPS_PROXY
      delete process.env.HTTP_PROXY
      delete process.env.ALL_PROXY
    }
    changes.push({ key: "proxyUrl", value: url, appliesNextRestart: false })
    proxyChanged = true
  }

  if (typeof patch.noProxy === "string") {
    const noProxy = patch.noProxy.trim()
    if (noProxy) settings.network.noProxy = noProxy
    else delete settings.network.noProxy
    if (noProxy) process.env.NO_PROXY = noProxy
    else delete process.env.NO_PROXY
    changes.push({ key: "noProxy", value: noProxy, appliesNextRestart: false })
    proxyChanged = true
  }

  // Clean up empty parents so the settings file stays tidy.
  if (Object.keys(settings.workspace).length === 0) delete settings.workspace
  if (Object.keys(settings.network).length === 0) delete settings.network

  await writeSettingsFile(settings)

  // Hot-swap undici's dispatcher so the new proxy takes effect on the very
  // next fetch — no restart needed for proxy changes.
  if (proxyChanged) {
    try {
      const { EnvHttpProxyAgent, Agent, setGlobalDispatcher } = await import("undici")
      const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)
      if (hasProxy) setGlobalDispatcher(new EnvHttpProxyAgent())
      else          setGlobalDispatcher(new Agent())   // direct (no proxy)
    } catch (error) {
      process.stderr.write(`[environment] failed to hot-swap proxy: ${error?.message || error}\n`)
    }
  }

  return { changes, filePath: settingsFilePath() }
}
