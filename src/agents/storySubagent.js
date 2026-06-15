import { hasModelKey } from "../provider/provider.js"
import { resolveModelProfile, subagentModelProfile } from "../provider/modelProfiles.js"
import { FileStateCache } from "../runtime/fileStateCache.js"
import { runToolLoop } from "../runtime/toolLoop.js"
import { getStorySnapshot } from "../lib/storyStore.js"
import { buildStoryContextCapsule } from "../context/contextCapsule.js"
import { backgroundAgentContract, renderContextSections } from "../prompts/agentContracts.js"
import { DEFAULT_SUBAGENT_TYPE, getSubagentDefinition, listSubagentDefinitions } from "./subagentDefinitions.js"

export function listStorySubagents(options = {}) {
  return listSubagentDefinitions(options)
}

export async function runStorySubagent({
  description,
  prompt,
  subagentType = DEFAULT_SUBAGENT_TYPE,
  modelProfile,
  tools,
  disallowedTools,
  registry,
  bus,
  context = {},
}) {
  const agent = getSubagentDefinition(subagentType, { cwd: context.cwd || process.cwd() })
  if (!agent) throw new Error(`Unknown subagent_type: ${subagentType}`)

  const snapshot = await getStorySnapshot()
  const effectiveModelProfile = modelProfile || agent.modelProfile || subagentModelProfile(agent.name)
  const profile = resolveModelProfile(effectiveModelProfile)
  if (!hasModelKey({
    role: profile.role,
    modelProfile: profile.id,
    providerId: profile.providerPinned ? profile.provider?.id : "",
  })) {
    return [
      `subagent: ${agent.name}`,
      `description: ${description || agent.description}`,
      `modelProfile: ${profile.id}`,
      "",
      "No model API key is configured, so this fallback subagent only reports the current state summary.",
      `foregroundGuidance: ${firstLines(snapshot.foregroundGuidance, 8) || "-"}`,
      `prompt: ${prompt}`,
    ].join("\n")
  }

  const effectiveTools = normalizeToolList(tools || agent.tools)
  const effectiveDisallowedTools = normalizeToolList(disallowedTools || agent.disallowedTools)
  const allowSubagents = toolIsAvailable("task", effectiveTools, effectiveDisallowedTools)
  const capsule = buildStoryContextCapsule(snapshot, { canonChars: agent.canonBudget || agentCanonBudget(agent.name) })
  const result = await runToolLoop({
    role: profile.role,
    model: profile.model,
    modelProfile: profile.id,
    registry,
    bus,
    temperature: agent.temperature ?? 0.25,
    // Expanded budget: aligned with Storykeeper's 75/16k posture. Subagents
    // need budget to do multi-source websearch+webfetch+synthesize+write
    // without taking shortcuts. Safety bound is wallclock + cost, not steps.
    maxTokens: agent.maxTokens || 16000,
    maxSteps: agent.maxSteps || 75,
    includeDangerous: false,
    includeTools: effectiveTools,
    excludeTools: effectiveDisallowedTools,
    toolConcurrency: 4,
    context: {
      ...context,
      readFileState: new FileStateCache(),
      depth: (context.depth || 0) + 1,
      agentType: agent.name,
      allowSubagents,
    },
    messages: [
      {
        role: "system",
        content: [
          `<role>You are a focused background subagent for an interactive novel: ${agent.name}.</role>`,
          agent.description,
          backgroundAgentContract({ allowSubagents, allowWrites: toolIsAvailable("write", effectiveTools, effectiveDisallowedTools) || toolIsAvailable("edit", effectiveTools, effectiveDisallowedTools) }),
          subagentInstructions(agent),
          "<scope>",
          "Do only the delegated narrow task.",
          "Do not continue the story prose.",
          "Do not modify main state files unless the task explicitly asks you to write research notes or an auxiliary file.",
          "</scope>",
          "<tool_strategy>",
          "Prefer parallel read, grep, glob, websearch, and webfetch calls for independent evidence gathering.",
          "websearch is discovery only and auto-appends source candidates to story/research/search-log.md (READ-ONLY for you, runtime manages it). **webfetch REQUIRES a `prompt` argument**, one sentence stating what to extract from the page, framed around your current task. The raw page is never returned; a small extractor model reads it against your prompt and hands back a focused synthesis. story/research/ResearchNotes.md is the model-editable scratchpad if you want to organize findings.",
          allowSubagents
            ? "You may launch another task subagent only when the parent prompt explicitly permits it and the nested task is independent."
            : "Do not launch another task subagent; the task tool is not available in this subagent context.",
          "Use grep/glob before broad reads. Use read offset/limit for narrow slices.",
          "</tool_strategy>",
          "<output>",
          "Return a concise report with: findings, evidence paths or URLs, uncertainty, and recommendations for the parent Storykeeper.",
          "Separate confirmed canon/source facts from hypotheses. Do not present optional reader choices as canon.",
          "Write the report in the language most useful for the current project context.",
          "</output>",
        ].join("\n"),
      },
      {
        role: "user",
        content: renderContextSections("Subagent Task Context", [
          {
            title: "Delegated Task",
            value: {
              type: agent.name,
              description,
              prompt,
              modelProfile: profile.id,
              tools: effectiveTools || "default",
              disallowedTools: effectiveDisallowedTools || [],
            },
          },
          {
            title: "Context Engineering",
            value: {
              nativeToolSchemas: "Tool schemas are already available through the model tool API.",
              searchFirst: "Use grep/glob before reading broad files.",
              webResearch: "Use websearch for discovery before webfetch retrieval when you need external evidence and do not already know the URL.",
              evidenceRequired: "Cite exact story paths, line ranges when available, or URLs for claims.",
              mainStateWrites: "Avoid writes to main state files unless explicitly requested by the parent task.",
            },
          },
          { title: "Story Context", value: capsule },
        ]),
      },
    ],
  })

  return result.content
}

function subagentInstructions(agent) {
  return [
    "<specialist_guidance>",
    agent.prompt || "Follow the delegated task precisely. Gather evidence first, then return a compact synthesis for the parent agent.",
    "</specialist_guidance>",
  ].join("\n")
}

function agentCanonBudget(agentName) {
  if (agentName === "research") return 2000
  if (agentName === "planner") return 4500
  return 6000
}

function normalizeToolList(value) {
  if (!Array.isArray(value)) return null
  const names = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
  return names.length ? names : null
}

function toolIsAvailable(toolName, includeTools, excludeTools) {
  if (excludeTools?.includes("*") || excludeTools?.includes(toolName)) return false
  if (includeTools) return includeTools.includes("*") || includeTools.includes(toolName)
  return true
}

function firstLines(text, count) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count)
    .join(" / ")
}
