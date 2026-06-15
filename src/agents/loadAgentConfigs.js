import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { paths } from "../lib/storyStore.js"
import { isFormatContractEnabled, isImageGenEnabled, isMusicGenEnabled } from "../lib/formatContract.js"
import { reportNotices } from "../lib/notices.js"
import { setAgentRegistry } from "./agentRegistry.js"
import { setAgentInboxRegistry } from "../runtime/agentChannel.js"
import { settingsEnv } from "../config/settings.js"

// Loads the resident-agent "Agent Cards" — declarative YAML descriptors that
// specialize the ONE generic scaffold (createResidentAgent) by tool permissions,
// file domain, and system prompt. Repo defaults live in src/agents/*.agent.yaml;
// a story may override any by id with story/agents/*.agent.yaml. Instantiating a
// new resident agent is therefore just dropping in a new YAML — no code change.
//
// This returns DECLARATIVE configs (params + domain-derived paths + prompt NAME).
// The per-agent BEHAVIOR (buildContext/normalize/apply/fallback) is supplied by
// JS in P5 and merged in before createResidentAgent; prompt names resolve then.

const REPO_AGENTS_DIR = path.dirname(fileURLToPath(import.meta.url))

export async function readAgentConfigCards({ root = paths.root, formatEnabled = isFormatContractEnabled(), imageEnabled = isImageGenEnabled(), musicEnabled = isMusicGenEnabled(), includeInactive = false } = {}) {
  const defaults = await readYamlConfigs(REPO_AGENTS_DIR)
  const overrides = await readYamlConfigs(path.join(root, "agents"))
  const globalOverrides = parseAgentOverrides(settingsEnv().OPENOVEL_AGENT_OVERRIDES)
  // Per-story overrides replace repo defaults by id (shallow merge).
  const merged = new Map()
  for (const c of defaults) merged.set(c.id, c)
  for (const c of overrides) merged.set(c.id, { ...(merged.get(c.id) || {}), ...c })
  for (const [id, override] of Object.entries(globalOverrides)) {
    const current = merged.get(id)
    if (!current) continue
    merged.set(id, applyAgentOverride(current, override, id))
  }

  const configs = [...merged.values()]
    .filter((c) => c.enabled !== false)
    .filter((c) => includeInactive || enabledForEnv(c, { formatEnabled, imageEnabled, musicEnabled }))
    .map((c) => normalizeConfig(c, { root }))

  return configs
}

export async function loadAgentConfigs({ root = paths.root, formatEnabled = isFormatContractEnabled(), imageEnabled = isImageGenEnabled(), musicEnabled = isMusicGenEnabled() } = {}) {
  const configs = await readAgentConfigCards({ root, formatEnabled, imageEnabled, musicEnabled })

  setAgentRegistry(configs)
  setAgentInboxRegistry(configs.map((c) => [c.id, c.inboxPath]))
  return configs
}

async function readYamlConfigs(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.yaml")) continue
    const file = path.join(dir, entry.name)
    try {
      const parsed = YAML.parse(await readFile(file, "utf8"))
      if (parsed && typeof parsed === "object" && parsed.id) {
        out.push({ ...parsed, _source: file })
      } else {
        reportNotices([`agent config ${file} is missing an id; skipped`], { event: "agent.config", prefix: "load" })
      }
    } catch (error) {
      reportNotices([`agent config ${file} failed to parse: ${error?.message || error}`], { event: "agent.config", prefix: "load" })
    }
  }
  return out
}

function enabledForEnv(config, { formatEnabled, imageEnabled, musicEnabled }) {
  const when = config.enabledWhen || "always"
  if (when === "format-contract") return Boolean(formatEnabled)
  if (when === "image-gen") return Boolean(imageEnabled)
  if (when === "music-gen") return Boolean(musicEnabled)
  return true
}

function normalizeConfig(config, { root }) {
  const domain = String(config.domain || config.id)
  const domainDir = path.join(root, domain)
  const readScope = arr(config.readScope)
  return {
    id: String(config.id),
    kind: config.kind || "resident-agent",
    role: config.role === "coordinator" ? "coordinator" : "subagent",
    modelProfile: config.modelProfile || "storykeeper",
    maxSteps: numberOr(config.maxSteps, 40),
    maxTokens: numberOr(config.maxTokens, 12000),
    temperature: numberOr(config.temperature, 0.35),
    toolConcurrency: numberOr(config.toolConcurrency, 4),
    includeTools: arr(config.tools),
    // Let the dangerous-gated tools (currently only `bash`) through for an agent
    // that explicitly opts in; the tool registry still filters them out unless
    // this is set, and bash stays globally gated + OS-sandboxed on top.
    includeDangerous: config.includeDangerous === true,
    writeScope: arr(config.writeScope),
    readScope: readScope.length ? readScope : ["story/**"],
    // System prompt, in precedence order (resolved in buildResidentAgent):
    //   systemPrompt (inline) > promptFile (path, relative to this YAML) > prompt (built-in name).
    // includeContract wraps a CUSTOM sub-agent prompt with the shared safety +
    // output contracts so a config-only agent works without boilerplate.
    prompt: String(config.prompt || ""),
    systemPrompt: typeof config.systemPrompt === "string" ? config.systemPrompt : "",
    promptFile: config.promptFile ? String(config.promptFile) : "",
    includeContract: config.includeContract !== false,
    coordinates: arr(config.coordinates),
    domain,
    domainDir,
    threadPath: path.join(domainDir, "thread.jsonl"),
    threadSource: String(config.id),
    lockPath: path.join(domainDir, "agent.lock"),
    inboxPath: path.join(domainDir, "inbox.queue.jsonl"),
    enabledWhen: config.enabledWhen || "always",
    // Turn-broadcast wake policy, evaluated PER BROADCAST in residentTeam.js
    // (unlike enabledWhen, which gates registration at load): "always", or a
    // dynamic condition like "custom-rich-blocks" (joins turn broadcasts only
    // while the reader displays custom blocks). An ineligible agent stays
    // registered and message-woken via its inbox (forAgents → wakeAgent).
    turnBroadcastWhen: config.turnBroadcastWhen || "always",
    source: config._source || "",
  }
}

function applyAgentOverride(config, override, id) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return config
  const out = { ...config }
  if (override.enabled === false) out.enabled = false
  if (typeof override.modelProfile === "string" && override.modelProfile.trim()) out.modelProfile = override.modelProfile.trim()
  if (override.model && typeof override.model === "object" && !Array.isArray(override.model)) {
    out.modelProfile = `agent:${id}`
  }
  if (Array.isArray(override.tools)) out.tools = override.tools.map((tool) => String(tool || "").trim()).filter(Boolean)
  if (typeof override.includeDangerous === "boolean") out.includeDangerous = override.includeDangerous
  if (Array.isArray(override.readScope)) out.readScope = override.readScope
  if (Array.isArray(override.writeScope)) out.writeScope = override.writeScope
  for (const key of ["maxSteps", "maxTokens", "temperature", "toolConcurrency"]) {
    if (override[key] !== undefined && override[key] !== "") out[key] = override[key]
  }
  return out
}

function parseAgentOverrides(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function arr(value) {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : []
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
