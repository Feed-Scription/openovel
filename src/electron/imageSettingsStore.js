// Image generation provider settings. Stored in settings.local.json under
// image.generation and mirrored into OPENOVEL_IMAGE_* for the runtime. The
// renderer sees only a redacted API-key snapshot and test preview data.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

import {
  IMAGE_PROVIDER_PRESETS,
  generateImageBytes,
  hasImageGenerationConfig,
  normalizeImageProvider,
  resolveImageConfig,
} from "../provider/imageGeneration.js"
import { slugifyCustomProviderName } from "../provider/customProviders.js"
import { sniffImageKind } from "../lib/imageWrite.js"

const FIELDS = [
  { key: "provider", path: ["image", "generation", "provider"], env: "OPENOVEL_IMAGE_PROVIDER", default: "custom" },
  { key: "baseUrl", path: ["image", "generation", "baseUrl"], env: "OPENOVEL_IMAGE_BASE_URL", default: "" },
  { key: "apiKey", path: ["image", "generation", "apiKey"], env: "OPENOVEL_IMAGE_API_KEY", default: "", secret: true },
  { key: "model", path: ["image", "generation", "model"], env: "OPENOVEL_IMAGE_MODEL", default: "" },
  { key: "path", path: ["image", "generation", "path"], env: "OPENOVEL_IMAGE_PATH", default: "/images/generations" },
  { key: "size", path: ["image", "generation", "size"], env: "OPENOVEL_IMAGE_SIZE", default: "1024x1024" },
]

const TEST_PROMPT = "A photorealistic test photo of a white ceramic mug on a wooden desk in soft daylight, no text."
const MIME_BY_KIND = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(settingsFilePath(), "utf8"))
  } catch {
    return {}
  }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

function readNested(obj, pathArr) {
  let cur = obj
  for (const key of pathArr) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

function writeNested(obj, pathArr, value) {
  let cur = obj
  for (let i = 0; i < pathArr.length - 1; i++) {
    cur[pathArr[i]] = cur[pathArr[i]] || {}
    cur = cur[pathArr[i]]
  }
  cur[pathArr[pathArr.length - 1]] = value
}

function deleteNested(obj, pathArr) {
  const parent = readNested(obj, pathArr.slice(0, -1))
  if (parent && typeof parent === "object") delete parent[pathArr[pathArr.length - 1]]
}

function coerce(field, value) {
  if (field.key === "provider") return normalizeImageProvider(value)
  if (typeof value === "string" && value.trim()) return value.trim()
  return field.default
}

function maskKey(value) {
  const s = String(value || "")
  if (!s) return ""
  if (s.length <= 8) return "*".repeat(s.length)
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function providerDefault(provider, field) {
  const preset = IMAGE_PROVIDER_PRESETS[normalizeImageProvider(provider)]
  if (!preset) return field.default
  return preset[field.key] ?? field.default
}

function effectiveProvider(settings) {
  const field = FIELDS.find((f) => f.key === "provider")
  const envValue = process.env[field.env]
  if (envValue !== undefined && envValue !== "") return normalizeImageProvider(envValue)
  const fileValue = readNested(settings, field.path)
  if (fileValue !== undefined && fileValue !== null && fileValue !== "") return normalizeImageProvider(fileValue)
  return field.default
}

function providerFallbackKey(provider) {
  if (provider === "volcengine") return process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || ""
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY || ""
  return ""
}

function effectiveValue(settings, field) {
  const provider = effectiveProvider(settings)
  if (field.key === "provider") return provider
  const envValue = process.env[field.env]
  if (envValue !== undefined && envValue !== "") return envValue
  const fileValue = readNested(settings, field.path)
  if (fileValue !== undefined && fileValue !== null && fileValue !== "") return fileValue
  if (field.key === "apiKey") return providerFallbackKey(provider)
  return providerDefault(provider, field)
}

function snapshotEnv(settings) {
  const out = {}
  for (const field of FIELDS) out[field.env] = effectiveValue(settings, field)
  out.ARK_API_KEY = process.env.ARK_API_KEY || ""
  out.VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY || ""
  out.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ""
  return out
}

function cleanupEmptyContainers(settings) {
  if (settings.image?.generation && Object.keys(settings.image.generation).length === 0) delete settings.image.generation
  if (settings.image && Object.keys(settings.image).length === 0) delete settings.image
}

// ── Per-provider config bags + custom entries ───────────────────────────
// The flat image.generation.{baseUrl,apiKey,model,path,size} fields are the
// ACTIVE provider's compiled config (what the runtime envs mirror). Each
// provider — built-in or custom:<slug> — additionally keeps its own bag under
// image.generation.providers[<id>], so switching providers swaps the flat
// fields instead of wiping them: nothing typed for one provider is lost by
// trying another. Custom entries' identities (id + display name) live under
// image.generation.customProviders; their fields live in the same bags.

const BAG_KEYS = ["baseUrl", "apiKey", "model", "path", "size"]

function providerBags(settings) {
  const bags = readNested(settings, ["image", "generation", "providers"])
  return bags && typeof bags === "object" ? bags : {}
}

function imageCustomEntries(settings) {
  const list = readNested(settings, ["image", "generation", "customProviders"])
  if (!Array.isArray(list)) return []
  return list
    .map((raw) => {
      const name = String(raw?.name || "").trim()
      const slug = slugifyCustomProviderName(String(raw?.id || "").replace(/^custom:/, "") || name)
      return slug ? { id: `custom:${slug}`, name: name || slug } : null
    })
    .filter(Boolean)
}

// Snapshot the current flat fields into the given provider's bag.
function saveFlatIntoBag(settings, providerId) {
  if (!providerId) return
  const bag = {}
  for (const key of BAG_KEYS) {
    const field = FIELDS.find((f) => f.key === key)
    const value = readNested(settings, field.path)
    if (value !== undefined && value !== null && value !== "") bag[key] = value
  }
  writeNested(settings, ["image", "generation", "providers", providerId], bag)
}

// Load a provider's bag into the flat fields + env mirrors. Missing bag keys
// CLEAR the flat field so the provider's preset defaults apply.
function loadBagIntoFlat(settings, providerId) {
  const bag = providerBags(settings)[providerId] || {}
  for (const key of BAG_KEYS) {
    const field = FIELDS.find((f) => f.key === key)
    const value = bag[key]
    if (value !== undefined && value !== null && value !== "") {
      writeNested(settings, field.path, value)
      process.env[field.env] = String(value)
    } else {
      deleteNested(settings, field.path)
      delete process.env[field.env]
    }
  }
}

export async function hydrateImageEnvFromSettings() {
  const settings = await readSettingsFile()
  for (const field of FIELDS) {
    const fileValue = readNested(settings, field.path)
    if (fileValue === undefined || fileValue === null || fileValue === "") continue
    process.env[field.env] = field.key === "provider" ? normalizeImageProvider(fileValue) : String(fileValue)
  }
}

export async function getImageSettingsSnapshot() {
  const settings = await readSettingsFile()
  const effectiveEnv = snapshotEnv(settings)
  const resolved = resolveImageConfig(effectiveEnv)
  const config = {}
  for (const field of FIELDS) {
    const effective = effectiveEnv[field.env]
    if (field.secret) {
      config[field.key] = { set: Boolean(effective), masked: maskKey(effective) }
    } else {
      config[field.key] = coerce(field, effective)
    }
  }
  // User-defined entries surface alongside the built-in presets so the UI can
  // render one pill row; each carries its bag (key redacted to a set flag).
  const bags = providerBags(settings)
  const customProviders = imageCustomEntries(settings).map((entry) => {
    const bag = bags[entry.id] || {}
    return {
      id: entry.id,
      name: entry.name,
      baseUrl: bag.baseUrl || "",
      model: bag.model || "",
      path: bag.path || "",
      size: bag.size || "",
      keySet: Boolean(bag.apiKey),
      maskedKey: maskKey(bag.apiKey),
    }
  })
  return {
    config,
    provider: resolved.provider,
    providers: Object.values(IMAGE_PROVIDER_PRESETS).map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModel: provider.model,
      defaultBaseUrl: provider.baseUrl,
      defaultPath: provider.path,
      defaultSize: provider.size,
      request: provider.request,
    })),
    customProviders,
    request: resolved.request,
    configured: hasImageGenerationConfig(effectiveEnv),
    filePath: settingsFilePath(),
  }
}

// Patch protocol, additive to the original field saves:
//   { provider: "<id>" }                 ← switch; the OLD provider's flat
//     fields are snapshotted into its bag and the NEW provider's bag is loaded
//     back (replaces the old wipe-on-switch behavior).
//   { upsertCustomProvider: { id?, name, baseUrl, model, path, size, apiKey? } }
//   { deleteCustomProvider: "custom:<slug>" }
export async function setImageSettings(patch = {}) {
  const settings = await readSettingsFile()
  const changes = []
  for (const [key, raw] of Object.entries(patch || {})) {
    if (key === "upsertCustomProvider") {
      const name = String(raw?.name || "").trim()
      const slug = slugifyCustomProviderName(String(raw?.id || "").replace(/^custom:/, "") || name)
      if (!slug) continue
      const id = `custom:${slug}`
      const entries = imageCustomEntries(settings)
      const nextEntries = entries.some((e) => e.id === id)
        ? entries.map((e) => (e.id === id ? { id, name: name || slug } : e))
        : [...entries, { id, name: name || slug }]
      writeNested(settings, ["image", "generation", "customProviders"], nextEntries)
      // Entry fields go straight into its bag; an omitted/empty apiKey keeps
      // the saved one (the form redacts it).
      const prevBag = providerBags(settings)[id] || {}
      const bag = {}
      for (const bagKey of BAG_KEYS) {
        const value = bagKey === "apiKey"
          ? (String(raw?.apiKey || "") || prevBag.apiKey || "")
          : String(raw?.[bagKey] ?? "").trim()
        if (value) bag[bagKey] = value
      }
      writeNested(settings, ["image", "generation", "providers", id], bag)
      // Editing the ACTIVE entry must recompile the flat fields immediately.
      if (effectiveProvider(settings) === id) loadBagIntoFlat(settings, id)
      changes.push({ key: id, set: true })
      continue
    }
    if (key === "deleteCustomProvider") {
      const id = String(raw || "")
      writeNested(settings, ["image", "generation", "customProviders"],
        imageCustomEntries(settings).filter((e) => e.id !== id))
      const bags = providerBags(settings)
      delete bags[id]
      writeNested(settings, ["image", "generation", "providers"], bags)
      if (effectiveProvider(settings) === id) {
        // Deleting the active entry falls back to the plain custom preset.
        const providerField = FIELDS.find((f) => f.key === "provider")
        writeNested(settings, providerField.path, "custom")
        process.env[providerField.env] = "custom"
        loadBagIntoFlat(settings, "custom")
      }
      changes.push({ key: id, set: false })
      continue
    }
    const field = FIELDS.find((f) => f.key === key)
    if (!field) continue
    const value = field.key === "provider"
      ? normalizeImageProvider(raw)
      : typeof raw === "string" ? raw.trim() : ""
    if (field.key === "provider") {
      // Switch: park the outgoing provider's flat fields in its bag, then
      // restore the incoming provider's bag (or its preset defaults).
      const previous = effectiveProvider(settings)
      if (value && value !== previous) {
        saveFlatIntoBag(settings, previous)
        writeNested(settings, field.path, value)
        process.env[field.env] = value
        loadBagIntoFlat(settings, value)
      } else if (value) {
        // Re-picking the active provider: still persist the pin (it may only
        // exist as the implicit default so far) — no bag swap needed.
        writeNested(settings, field.path, value)
        process.env[field.env] = value
      }
      changes.push({ key, set: Boolean(value) })
      continue
    }
    if (value) {
      writeNested(settings, field.path, value)
      process.env[field.env] = value
    } else {
      deleteNested(settings, field.path)
      delete process.env[field.env]
    }
    // Keep the active provider's bag in lockstep so a later switch round-trip
    // restores exactly what the user last saved here.
    const active = effectiveProvider(settings)
    if (BAG_KEYS.includes(field.key)) {
      const bag = providerBags(settings)[active] || {}
      if (value) bag[field.key] = value
      else delete bag[field.key]
      writeNested(settings, ["image", "generation", "providers", active], bag)
    }
    changes.push({ key, set: Boolean(value) })
  }
  cleanupEmptyContainers(settings)
  await writeSettingsFile(settings)
  return { changes, filePath: settingsFilePath(), snapshot: await getImageSettingsSnapshot() }
}

export async function testImageGeneration() {
  const t0 = Date.now()
  await hydrateImageEnvFromSettings()
  const settings = await readSettingsFile()
  const effectiveEnv = snapshotEnv(settings)
  const resolved = resolveImageConfig(effectiveEnv)
  if (!hasImageGenerationConfig(effectiveEnv)) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: "Set image provider, API key, and model before testing image generation. Custom providers also need a base URL.",
    }
  }
  try {
    const generated = await generateImageBytes({ prompt: TEST_PROMPT, env: effectiveEnv })
    const buffer = Buffer.isBuffer(generated)
      ? generated
      : generated?.url
        ? await fetchGeneratedUrl(generated.url)
        : null
    const kind = sniffImageKind(buffer)
    if (!kind) throw new Error("image API returned data that is not png/jpeg/gif/webp")
    const mime = MIME_BY_KIND[kind]
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      kind,
      mime,
      bytes: buffer.length,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      provider: resolved.provider,
      model: resolved.model,
      size: resolved.size,
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: error?.message || String(error),
    }
  }
}

async function fetchGeneratedUrl(url) {
  if (!/^https?:\/\//.test(String(url))) throw new Error("image API returned a non-http URL")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30 * 1000)
  try {
    const response = await fetch(url, { headers: { Accept: "image/*" }, signal: controller.signal })
    if (!response.ok) throw new Error(`generated image URL returned HTTP ${response.status}`)
    const contentType = (response.headers.get("content-type") || "").toLowerCase()
    if (contentType && !contentType.startsWith("image/")) throw new Error(`generated image URL returned ${contentType}, not image/*`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
