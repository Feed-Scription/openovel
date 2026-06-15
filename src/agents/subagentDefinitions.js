import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { listModelProfileIds } from "../provider/modelProfiles.js"

const PROJECT_DIRS = [".ai-story", ".openovel"]
const AGENT_EXTENSIONS = new Set([".json", ".jsonc"])
const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "glob", "websearch", "webfetch", "memory", "write", "edit"]
export const DEFAULT_SUBAGENT_TYPE = "general-purpose"

export const BUILTIN_SUBAGENTS = {
  "general-purpose": {
    name: "general-purpose",
    description:
      "General-purpose worker for multi-step story maintenance, broad file exploration, and scoped edits. Use when no narrower specialist fits or when independent write work would flood Storykeeper's context.",
    modelProfile: "subagent",
    tools: ["*"],
    disallowedTools: ["task", "task_status"],
    prompt:
      "Complete the delegated story-maintenance task fully, but keep the scope tight. Search broadly when needed, read the exact files you will modify, and prefer editing existing story files over creating new ones. You may write or edit only files explicitly allowed by the parent task or clearly implied by the delegated maintenance goal. Return a concise report with files changed, evidence/provenance, unresolved risks, and anything the parent must merge into its envelope.",
    canonBudget: 6000,
  },
  continuity: {
    name: "continuity",
    description:
      "Audit characters, objects, timeline, causality, and hard facts for continuity risks. Use when multi-turn canon could conflict.",
    modelProfile: "subagent-continuity",
    tools: DEFAULT_SUBAGENT_TOOLS,
    disallowedTools: ["task", "task_status"],
    prompt:
      "Audit canon for contradictions across timeline, place, character status, object ownership, promises, forbidden facts, and foreground guidance. Use story/canon/chapters.md, story/canon/scene_log.jsonl, FOREGROUND.md, memory, and relevant auxiliary files as evidence. Report exact file paths and line numbers when available. Label each issue as confirmed, possible, or stale/superseded.",
    canonBudget: 6000,
  },
  research: {
    name: "research",
    description:
      "Gather source-backed real-world, historical, scientific, technical, or literary-craft details. Use when grounding evidence would improve realism or style.",
    modelProfile: "subagent-research",
    tools: DEFAULT_SUBAGENT_TOOLS,
    disallowedTools: ["task", "task_status"],
    prompt:
      "Prioritize source-backed facts over invention. Use websearch for discovery, then webfetch selected pages. webfetch REQUIRES a `prompt` argument naming exactly what to pull from the page (a small extractor model reads it against that prompt, the raw page is never returned, so vague prompts produce vague results). Capture the source URL and the exact claim it supports. Prefer writing durable research notes only when the parent prompt asks for a file update. Otherwise return a compact evidence table. Flag dated, uncertain, fictionalized, or setting-assumption material explicitly.",
    canonBudget: 2000,
  },
  planner: {
    name: "planner",
    description:
      "Analyze open threads, foreshadowing, branch risk, pacing, and counterfactual consequences. Do not create reader-facing choices.",
    modelProfile: "subagent-planner",
    tools: DEFAULT_SUBAGENT_TOOLS,
    disallowedTools: ["task", "task_status"],
    prompt:
      "Analyze narrative pressure, open threads, branch consequences, and pacing risk. Do not propose reader-facing choices, menu options, or a fixed next beat. Surface constraints and playable pressures instead. Distinguish likely consequences from hard canon. Include counterfactual risks when a plausible branch would break established facts.",
    canonBudget: 4500,
  },
}

export function listSubagentDefinitions({ cwd = process.cwd() } = {}) {
  return Object.values(loadSubagentDefinitions({ cwd }))
}

export function getSubagentDefinition(name, { cwd = process.cwd() } = {}) {
  return loadSubagentDefinitions({ cwd })[name] || null
}

export function loadSubagentDefinitions({ cwd = process.cwd() } = {}) {
  const agents = { ...BUILTIN_SUBAGENTS }
  for (const file of discoverAgentFiles(cwd)) {
    const parsed = readAgentFile(file)
    if (!parsed) continue
    const normalized = normalizeAgent(parsed, file)
    if (!normalized) continue
    agents[normalized.name] = {
      ...(agents[normalized.name] || {}),
      ...normalized,
      source: file,
    }
  }
  return agents
}

export function validateAgentDefinition(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return "agent definition must be an object"
  }
  if (agent.name !== undefined && !isName(agent.name)) {
    return "name must contain only letters, numbers, underscore, dot, or dash"
  }
  if (agent.modelProfile !== undefined && !listModelProfileIds().includes(agent.modelProfile)) {
    return `modelProfile must be one of: ${listModelProfileIds().join(", ")}`
  }
  for (const key of ["tools", "disallowedTools"]) {
    if (agent[key] !== undefined && !isStringArray(agent[key])) {
      return `${key} must be an array of tool names`
    }
  }
  for (const key of ["maxSteps", "maxTokens", "canonBudget"]) {
    if (agent[key] !== undefined && (!Number.isInteger(agent[key]) || agent[key] < 1)) {
      return `${key} must be a positive integer`
    }
  }
  if (agent.temperature !== undefined && (!Number.isFinite(agent.temperature) || agent.temperature < 0 || agent.temperature > 2)) {
    return "temperature must be a number between 0 and 2"
  }
  return ""
}

function discoverAgentFiles(cwd) {
  const files = []
  for (const dir of projectConfigDirs(cwd)) {
    const agentsDir = path.join(dir, "agents")
    if (!existsSync(agentsDir)) continue
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!AGENT_EXTENSIONS.has(path.extname(entry.name))) continue
      files.push(path.join(agentsDir, entry.name))
    }
  }
  files.sort()
  return files
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
    for (const name of PROJECT_DIRS) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) dirs.push(candidate)
    }
  }
  return dirs
}

function readAgentFile(file) {
  try {
    return JSON.parse(stripJsonC(readFileSync(file, "utf8")))
  } catch (error) {
    throw new Error(`Failed to load subagent definition ${file}: ${error.message || String(error)}`)
  }
}

function normalizeAgent(agent, file) {
  const error = validateAgentDefinition(agent)
  if (error) throw new Error(`Invalid subagent definition ${file}: ${error}`)
  const name = String(agent.name || path.basename(file, path.extname(file))).trim()
  if (!isName(name)) throw new Error(`Invalid subagent definition ${file}: invalid agent name`)
  return {
    name,
    description: String(agent.description || "").trim() || `Custom subagent: ${name}`,
    prompt: String(agent.prompt || agent.systemPrompt || "").trim(),
    modelProfile: agent.modelProfile || undefined,
    tools: agent.tools ? normalizeToolList(agent.tools) : undefined,
    disallowedTools: agent.disallowedTools ? normalizeToolList(agent.disallowedTools) : undefined,
    maxSteps: agent.maxSteps,
    maxTokens: agent.maxTokens,
    temperature: agent.temperature,
    canonBudget: agent.canonBudget,
  }
}

function normalizeToolList(value) {
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
}

function isName(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""))
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
