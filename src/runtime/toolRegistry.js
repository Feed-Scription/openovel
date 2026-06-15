import { backgroundJobs } from "./backgroundJob.js"
import { resolveToolPermission } from "./permissionPolicy.js"
import { permissionService } from "./permissionService.js"
import { recordToolCall } from "../telemetry/usageProfile.js"

export class ToolRegistry {
  #tools = new Map()

  register(tool) {
    if (!tool?.id) throw new Error("Tool must have an id")
    if (!tool.execute) throw new Error(`Tool ${tool.id} must have execute()`)
    this.#tools.set(tool.id, tool)
    for (const alias of tool.aliases || []) {
      this.#tools.set(alias, { ...tool, id: alias, canonicalId: tool.id })
    }
    return tool
  }

  get(id) {
    return this.#tools.get(id)
  }

  all() {
    return [...this.#tools.values()].filter((tool) => !tool.canonicalId)
  }

  manifest({ modelVisibleOnly = false } = {}) {
    return this.all()
      .filter((tool) => !modelVisibleOnly || tool.exposeToModel !== false)
      .map((tool) => ({
      id: tool.id,
      description: tool.description,
      readOnly: typeof tool.readOnly === "function" ? undefined : Boolean(tool.readOnly),
      destructive: Boolean(tool.destructive),
      concurrencySafe: typeof tool.concurrencySafe === "function" ? undefined : Boolean(tool.concurrencySafe),
      parameters: tool.parameters || {},
    }))
  }

  openAITools({ includeDangerous = false, includeTools = null, excludeTools = null } = {}) {
    const include = normalizeToolSet(includeTools, { wildcard: "all" })
    const explicitlyIncluded = explicitToolSet(includeTools)
    const exclude = normalizeToolSet(excludeTools, { wildcard: "set" })
    return this.all()
      .filter((tool) => tool.exposeToModel !== false || explicitlyIncluded.has(tool.id))
      .filter((tool) => includeDangerous || !tool.dangerous)
      .filter((tool) => !include || include.has(tool.id))
      .filter((tool) => !exclude || (!exclude.has("*") && !exclude.has(tool.id)))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.id,
          description: tool.description,
          parameters: tool.jsonSchema || jsonSchemaFromParameters(tool.parameters || {}),
        },
      }))
  }

  async execute(id, input, context = {}) {
    const tool = this.get(id)
    if (!tool) throw new Error(`Unknown tool: ${id}`)
    if (tool.validate) {
      const result = await tool.validate(input, context)
      if (result !== true && result?.ok !== true) {
        throw new Error(result?.message || `Invalid input for tool ${id}`)
      }
    }
    const toolId = tool.canonicalId || tool.id
    const startedAt = Date.now()
    let permissionDecision = null
    let permissionAudited = false
    try {
      permissionDecision = resolveToolPermission({ tool, input, context })
      permissionDecision = await permissionService.assert({ tool, input, context, decision: permissionDecision })
      await recordToolPermissionAudit({ toolId, decision: permissionDecision, input, context })
      permissionAudited = true
      context.bus?.publish?.("tool.permission", publicPermissionEvent(toolId, permissionDecision))
      context.bus?.publish?.("tool.started", { id: toolId, input })
      const result = await tool.execute(input, context)
      const normalized = normalizeToolResult(result)
      context.bus?.publish?.("tool.completed", {
        id: toolId,
        title: normalized.title,
        metadata: normalized.metadata,
        durationMs: Date.now() - startedAt,
      })
      await recordToolCall({
        id: toolId,
        input,
        ok: true,
        output: normalized.output,
        durationMs: Date.now() - startedAt,
      })
      return normalized
    } catch (error) {
      permissionDecision = error.permissionDecision || permissionDecision || null
      if (permissionDecision && !permissionAudited) {
        await recordToolPermissionAudit({ toolId, decision: permissionDecision, input, context, error })
        context.bus?.publish?.("tool.permission", publicPermissionEvent(toolId, permissionDecision, error))
      }
      context.bus?.publish?.("tool.error", {
        id: toolId,
        error: error.message || String(error),
        durationMs: Date.now() - startedAt,
      })
      await recordToolCall({
        id: toolId,
        input,
        ok: false,
        error: error.message || String(error),
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }
}

export const toolRegistry = new ToolRegistry()

function normalizeToolSet(value, { wildcard = "set" } = {}) {
  if (!Array.isArray(value)) return null
  const names = value.map((item) => String(item || "").trim()).filter(Boolean)
  if (names.includes("*") && wildcard === "all") return null
  return names.length ? new Set(names) : null
}

function explicitToolSet(value) {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.map((item) => String(item || "").trim()).filter((name) => name && name !== "*"))
}

function jsonSchemaFromParameters(parameters) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "string") {
      const optional = value.endsWith("?")
      const type = optional ? value.slice(0, -1) : value
      properties[key] = { type: mapType(type) }
      if (!optional) required.push(key)
      continue
    }
    properties[key] = value
    required.push(key)
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function mapType(type) {
  if (type === "number") return "number"
  if (type === "integer") return "integer"
  if (type === "boolean") return "boolean"
  if (type === "array") return "array"
  if (type === "object") return "object"
  return "string"
}

function normalizeToolResult(result) {
  if (typeof result === "string") {
    return { title: "", metadata: {}, output: result }
  }
  return {
    title: result?.title || "",
    metadata: result?.metadata || {},
    output: stringifyOutput(result?.output ?? result),
    attachments: result?.attachments,
    // Structured media (e.g. an image read for a vision model). Kept OUT of
    // `output` so base64 never hits the text/truncation path; the tool loop
    // routes it into a follow-up message and the adapter strips it for
    // non-vision models.
    mediaParts: Array.isArray(result?.mediaParts) ? result.mediaParts : undefined,
  }
}

function stringifyOutput(value) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

async function recordToolPermissionAudit({ toolId, decision, input, context, error }) {
  if (!decision) return
  try {
    await backgroundJobs.recordAudit({
      event: "tool_permission",
      type: "tool",
      jobId: context.jobId,
      workflow: context.workflow,
      turnId: context.turnId,
      callID: context.callID,
      tool: toolId,
      action: decision.action,
      matchedPattern: decision.matchedPattern,
      patterns: (decision.patterns || []).slice(0, 12),
      reason: decision.reason,
      rule: decision.rule,
      input: summarizeToolInput(input),
      error: error?.message || "",
    })
  } catch {
    // Permission checks must not fail because an audit sink is unavailable.
  }
}

function publicPermissionEvent(toolId, decision, error) {
  return {
    id: toolId,
    action: decision.action,
    matchedPattern: decision.matchedPattern,
    patterns: decision.patterns,
    reason: decision.reason,
    denied: Boolean(error),
  }
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return input
  const out = {}
  for (const key of ["filePath", "path", "url", "query", "target", "action", "subagent_type", "task_id", "command"]) {
    if (input[key] === undefined) continue
    const value = String(input[key])
    out[key] = value.length > 240 ? `${value.slice(0, 240)}...[truncated ${value.length - 240}]` : value
  }
  return out
}
