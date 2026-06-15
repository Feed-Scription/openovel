// Advanced configuration for model routing + resident-agent controls.
// Shares the same settings.local.json used by API keys and mirrors writes into
// process.env so the next model call / next agent launch picks them up.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import { providerRegistry, publicProviderInfo } from "../provider/registry.js"
import { listModelProfiles, resolveModelProfile } from "../provider/modelProfiles.js"
import { settingsEnv } from "../config/settings.js"
import { readAgentConfigCards } from "../agents/loadAgentConfigs.js"
import { registerDefaultTools } from "../tools/registerTools.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { hydrateProcessEnvFromSettings } from "./apiKeysStore.js"

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    const text = await readFile(settingsFilePath(), "utf8")
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

export async function getAdvancedConfigSnapshot() {
  await hydrateProcessEnvFromSettings()
  registerDefaultTools(toolRegistry)
  const settings = await readSettingsFile()
  const env = settingsEnv()
  const providers = providerRegistry.all().map((provider) => {
    const resolved = providerRegistry.resolve({ id: provider.id, role: "foreground", env })
    return {
      ...publicProviderInfo(resolved),
      defaultModel: provider.defaultModel || "",
      defaultBackgroundModel: provider.defaultBackgroundModel || "",
    }
  })
  const routes = combinedModelProfileRoutes(settings)
  const agents = await readAgentConfigCards({ includeInactive: true })
  const agentOverrides = settings.agents?.overrides || {}

  return {
    filePath: settingsFilePath(),
    providers,
    modelCatalog: modelCatalog(settings, providers),
    modelProfiles: listModelProfiles({ env }).map((profile) => ({
      ...profile,
      route: routes[profile.id] || null,
      overridden: Boolean(routes[profile.id]),
    })),
    agents: agents.map((agent) => {
      const route = routes[`agent:${agent.id}`] || null
      const profile = resolveModelProfile(agent.modelProfile || "storykeeper", { env })
      return {
        id: agent.id,
        kind: agent.kind,
        role: agent.role,
        domain: agent.domain,
        enabledWhen: agent.enabledWhen,
        modelProfile: agent.modelProfile,
        model: route || {
          provider: profile.provider?.id || "",
          model: profile.model || "",
          role: profile.role || "background",
        },
        tools: agent.includeTools || [],
        writeScope: agent.writeScope || [],
        readScope: agent.readScope || [],
        maxSteps: agent.maxSteps,
        maxTokens: agent.maxTokens,
        temperature: agent.temperature,
        toolConcurrency: agent.toolConcurrency,
        source: agent.source || "",
        override: agentOverrides[agent.id] || null,
      }
    }),
    tools: toolRegistry.manifest({ modelVisibleOnly: true }),
    routes,
  }
}

export async function setModelCatalogItem(item = {}) {
  const provider = String(item.provider || "").trim()
  const model = String(item.model || "").trim()
  if (!provider || !model) throw new Error("provider and model are required")
  const id = modelId(provider, model)
  const settings = await readSettingsFile()
  settings.provider = settings.provider || {}
  const existing = normalizeModelCatalog(settings.provider.modelCatalog)
    .filter((entry) => entry.id !== id)
  existing.push({
    id,
    provider,
    model,
    label: String(item.label || "").trim(),
  })
  settings.provider.modelCatalog = existing
  await writeSettingsFile(settings)
  await hydrateProcessEnvFromSettings()
  return { ok: true, id, filePath: settingsFilePath() }
}

export async function removeModelCatalogItem(id) {
  const settings = await readSettingsFile()
  const models = normalizeModelCatalog(settings.provider?.modelCatalog)
    .filter((entry) => entry.id !== id)
  settings.provider = settings.provider || {}
  if (models.length) settings.provider.modelCatalog = models
  else delete settings.provider.modelCatalog
  await writeSettingsFile(settings)
  await hydrateProcessEnvFromSettings()
  return { ok: true, filePath: settingsFilePath() }
}

export async function setModelProfileRoute(profileId, route = null) {
  const id = String(profileId || "").trim()
  if (!id) throw new Error("profileId is required")
  const settings = await readSettingsFile()
  settings.modelProfiles = settings.modelProfiles || {}
  settings.modelProfiles.routes = settings.modelProfiles.routes || {}
  if (!route) {
    delete settings.modelProfiles.routes[id]
  } else {
    settings.modelProfiles.routes[id] = normalizeRoute(route)
  }
  if (Object.keys(settings.modelProfiles.routes).length === 0) delete settings.modelProfiles.routes
  await writeSettingsFile(settings)
  await hydrateProcessEnvFromSettings()
  return { ok: true, filePath: settingsFilePath() }
}

export async function setAgentOverride(agentId, patch = null) {
  const id = String(agentId || "").trim()
  if (!id) throw new Error("agentId is required")
  const settings = await readSettingsFile()
  settings.agents = settings.agents || {}
  settings.agents.overrides = settings.agents.overrides || {}

  if (!patch) {
    delete settings.agents.overrides[id]
  } else {
    settings.agents.overrides[id] = sanitizeAgentOverride({
      ...(settings.agents.overrides[id] || {}),
      ...patch,
    })
  }
  if (Object.keys(settings.agents.overrides).length === 0) delete settings.agents.overrides
  await writeSettingsFile(settings)
  await hydrateProcessEnvFromSettings()
  return { ok: true, filePath: settingsFilePath() }
}

function sanitizeAgentOverride(value = {}) {
  const out = {}
  if (value.enabled === false) out.enabled = false
  if (value.model && typeof value.model === "object" && !Array.isArray(value.model)) {
    const route = normalizeRoute({ role: "background", ...value.model })
    if (route.provider || route.model) out.model = route
  }
  if (typeof value.modelProfile === "string" && value.modelProfile.trim()) out.modelProfile = value.modelProfile.trim()
  if (Array.isArray(value.tools)) {
    const tools = [...new Set(value.tools.map((tool) => String(tool || "").trim()).filter(Boolean))]
    out.tools = tools.length ? tools : ["explain"]
  }
  for (const key of ["maxSteps", "maxTokens", "toolConcurrency"]) {
    const n = Number(value[key])
    if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n)
  }
  if (value.temperature !== undefined && value.temperature !== "") {
    const n = Number(value.temperature)
    if (Number.isFinite(n) && n >= 0 && n <= 2) out.temperature = n
  }
  return out
}

function combinedModelProfileRoutes(settings) {
  const out = { ...(settings.modelProfiles?.routes || {}) }
  for (const [agentId, override] of Object.entries(settings.agents?.overrides || {})) {
    const model = override?.model
    if (!model || typeof model !== "object" || (!model.provider && !model.model)) continue
    out[`agent:${agentId}`] = normalizeRoute({ role: "background", ...model })
  }
  return out
}

function normalizeRoute(route = {}) {
  const out = {
    provider: String(route.provider || "").trim(),
    model: String(route.model || "").trim(),
    role: route.role === "foreground" ? "foreground" : "background",
  }
  const temperature = numberInRange(route.temperature, 0, 2)
  if (temperature !== undefined) out.temperature = temperature
  for (const key of ["maxTokens", "timeoutMs", "chunkTimeoutMs"]) {
    const n = positiveInt(route[key])
    if (n !== undefined) out[key] = n
  }
  return out
}

function positiveInt(value) {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function numberInRange(value, min, max) {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

function modelCatalog(settings, providers) {
  const saved = normalizeModelCatalog(settings.provider?.modelCatalog)
  const defaults = []
  for (const provider of providers) {
    for (const model of [provider.defaultModel, provider.defaultBackgroundModel]) {
      if (!model) continue
      defaults.push({
        id: modelId(provider.id, model),
        provider: provider.id,
        model,
        label: provider.name ? `${provider.name} · ${model}` : model,
        builtin: true,
      })
    }
  }
  return dedupeModels([...saved, ...defaults])
}

function normalizeModelCatalog(value) {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([id, item]) => ({ id, ...(item || {}) }))
      : []
  return list
    .map((item) => {
      const provider = String(item.provider || "").trim()
      const model = String(item.model || "").trim()
      if (!provider || !model) return null
      return {
        id: String(item.id || modelId(provider, model)),
        provider,
        model,
        label: String(item.label || "").trim(),
        builtin: Boolean(item.builtin),
      }
    })
    .filter(Boolean)
}

function dedupeModels(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const id = item.id || modelId(item.provider, item.model)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...item, id })
  }
  return out
}

function modelId(provider, model) {
  return `${provider}/${model}`
}
