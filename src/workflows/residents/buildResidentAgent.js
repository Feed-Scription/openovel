import { readFileSync } from "node:fs"
import path from "node:path"
import { createResidentAgent } from "../residentAgent.js"
import { createStorykeeperAgent } from "../storykeeperWorkflow.js"
import { showrunnerContract } from "../storykeeperContext.js"
import {
  worldKeeperContract,
  directorContract,
  cardManagerContract,
  memoryContract,
  renderManagerContract,
  imageAgentContract,
  musicAgentContract,
  backgroundAgentContract,
  subAgentOutputContract,
} from "../../prompts/agentContracts.js"
import { hasImageGenerationConfig } from "../../provider/imageGeneration.js"
import { isImageBackgroundEnabled, isCharacterSheetsEnabled, isCustomRichBlocksEnabled, isMusicGenEnabled } from "../../lib/formatContract.js"
import { subAgentBehavior } from "./subAgent.js"

function imageGenerationConfigured(config) {
  if (config.id !== "image" && config.prompt !== "imageAgentContract") return true
  return hasImageGenerationConfig()
}

// Each Agent Card declares its own tools (every resident card lists `explain` so
// it can surface a one-line, operator-facing status note in the Agents panel).
// The only adjustment here is dropping generate_image when image generation
// isn't configured.
function effectiveIncludeTools(config) {
  const tools = config.includeTools
  if (!Array.isArray(tools) || imageGenerationConfigured(config)) return tools
  return tools.filter((tool) => tool !== "generate_image")
}

// Built-in named prompts — the "batteries-included" defaults. A config can pick
// one with `prompt: <name>`, OR author its own prompt entirely from config via
// `systemPrompt:` (inline) / `promptFile:` (a path next to the YAML) — so a third
// party can define a brand-new agent, or override a built-in, WITHOUT touching JS.
const PROMPTS = {
  showrunnerContract,
  worldKeeperContract,
  directorContract,
  cardManagerContract,
  memoryContract,
  renderManagerContract,
  imageAgentContract,
  musicAgentContract,
}

// Resolve a config to a () => string system-prompt function.
// Precedence: inline systemPrompt > promptFile > named built-in. Exported for tests.
export function resolvePromptFn(config) {
  const inline = typeof config.systemPrompt === "string" && config.systemPrompt.trim() ? config.systemPrompt : null
  const customText = inline ?? (config.promptFile ? readPromptFile(config) : null)
  if (customText != null) return () => wrapCustomPrompt(config, customText)
  const fn = PROMPTS[config.prompt]
  if (!fn) {
    throw new Error(
      `resident agent "${config.id}": no system prompt — set systemPrompt (inline), promptFile (a path), or prompt (one of: ${Object.keys(PROMPTS).join(", ")}).`,
    )
  }
  return () => fn(promptOptions(config))
}

function promptOptions(config) {
  if (config.prompt === "imageAgentContract") {
    return {
      generateImageEnabled: imageGenerationConfigured(config),
      imageBackgroundEnabled: isImageBackgroundEnabled(),
      // Sheets need generation: even with the toggle on, an unconfigured image
      // provider (no key) drops the remit along with generate_image itself.
      characterSheetsEnabled: isCharacterSheetsEnabled() && imageGenerationConfigured(config),
    }
  }
  if (config.prompt === "renderManagerContract") {
    return {
      imageBackgroundEnabled: isImageBackgroundEnabled(),
      musicEnabled: isMusicGenEnabled(),
      // Reader display preference (mirrored into env by the Electron prefs
      // store): with custom blocks shown as plain host cards, the contract
      // shifts the Render Manager to reserved-channel upkeep. Read per run
      // (this builder is a thunk), so a Settings flip applies next wake.
      customBlocksDisplayed: isCustomRichBlocksEnabled(),
    }
  }
  return {}
}

function readPromptFile(config) {
  const base = config.source ? path.dirname(config.source) : process.cwd()
  const file = path.isAbsolute(config.promptFile) ? config.promptFile : path.join(base, config.promptFile)
  try {
    return readFileSync(file, "utf8")
  } catch (error) {
    throw new Error(`resident agent "${config.id}": promptFile ${file} is unreadable: ${error?.message || error}`)
  }
}

// A custom SUB-AGENT prompt is wrapped (unless includeContract:false) with the
// shared safety contract + the standard sub-agent output envelope, so a
// config-authored prompt only states its domain-specific guidance yet still
// returns the { status, filesTouched, forShowrunner, forAgents } shape the runtime expects.
// A custom COORDINATOR prompt is used verbatim (it owns the full storykeeper
// envelope — advanced authors take full control).
function wrapCustomPrompt(config, text) {
  if (config.includeContract === false || config.role === "coordinator") return text
  return [
    backgroundAgentContract({ allowSubagents: false, allowWrites: true }),
    "",
    String(text).trim(),
    "",
    subAgentOutputContract(config.domain || config.id),
  ].join("\n")
}

// Turn a declarative Agent Card (from loadAgentConfigs) into a runnable agent for
// BackgroundAgentRuntime. Coordinator → the Storykeeper composer specialized as
// the Showrunner (own thread, channel inbox, showrunner prompt). Sub-agent → the
// generic createResidentAgent scaffold + the shared sub-agent behavior.
export function buildResidentAgent(config) {
  const promptFn = resolvePromptFn(config)
  const includeTools = effectiveIncludeTools(config)
  const behavior = typeof config.behaviorFactory === "function"
    ? config.behaviorFactory(config)
    : (config.behavior || subAgentBehavior(config))

  if (config.role === "coordinator") {
    return createStorykeeperAgent({
      id: config.id,
      systemPrompt: promptFn,
      threadPath: config.threadPath,
      drainAgent: config.id,
      modelProfile: config.modelProfile,
      maxSteps: config.maxSteps,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      toolConcurrency: config.toolConcurrency,
      includeTools,
    })
  }

  return createResidentAgent({
    id: config.id,
    kind: config.kind,
    modelProfile: config.modelProfile,
    maxSteps: config.maxSteps,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    toolConcurrency: config.toolConcurrency,
    includeTools,
    includeDangerous: config.includeDangerous === true,
    threadPath: config.threadPath,
    threadSource: config.id,
    systemPrompt: () => promptFn(),
    ...behavior,
  })
}
