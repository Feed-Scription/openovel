import path from "node:path"
import { appendJsonl, ensureDir, readText } from "../lib/files.js"
import { backgroundJobs } from "./backgroundJob.js"
import { paths } from "../lib/storyStore.js"
import { workspaceLayout } from "../lib/workspacePaths.js"
import { PermissionDeniedError } from "./permissionPolicy.js"

export class PermissionRequiredError extends Error {
  constructor(request) {
    super(`Tool ${request.permission || request.toolId || "tool"} requires approval (${request.requestId}). ${request.reason || ""}`.trim())
    this.name = "PermissionRequiredError"
    this.code = "OPENOVEL_PERMISSION_REQUIRED"
    this.permissionRequest = request
    this.permissionDecision = { ...request, action: "ask" }
  }
}

export class PermissionService {
  constructor({ ledgerPath = () => paths.permissionsLedger } = {}) {
    this.ledgerPath = ledgerPath
  }

  async assert({ tool, input = {}, context = {}, decision }) {
    const risk = classifyPermissionRisk({ tool, input, decision })
    const effective = risk.action || decision.action
    const enriched = {
      ...decision,
      action: effective,
      reason: risk.reason || decision.reason || "",
      risk,
    }
    if (effective === "allow") return enriched
    if (effective === "deny") throw new PermissionDeniedError(enriched)

    const handler = context.askPermission || context.permission?.ask
    if (handler) {
      const response = await handler(enriched)
      if (response === true || response?.action === "allow" || response?.allowed === true) {
        return { ...enriched, action: "allow", approvedByHandler: true }
      }
      throw new PermissionDeniedError({
        ...enriched,
        action: "deny",
        reason: response?.reason || enriched.reason || "Approval handler rejected the request.",
      })
    }

    const request = await this.ask({ decision: enriched, input, context })
    if (request.status === "approved") {
      return { ...enriched, action: "allow", approvedByRequest: request.requestId }
    }
    if (request.status === "denied") {
      throw new PermissionDeniedError({ ...enriched, action: "deny", reason: request.reason || enriched.reason })
    }
    throw new PermissionRequiredError(request)
  }

  async ask({ decision, input = {}, context = {} }) {
    const key = permissionRequestKey({ decision, input })
    const existing = await findLatestByKey(key, this.ledgerPath())
    if (existing?.status === "approved" || existing?.status === "denied") return existing
    if (existing?.status === "pending") return existing

    const now = new Date().toISOString()
    const request = {
      event: "permission_request",
      requestId: `perm_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      status: "pending",
      key,
      toolId: decision.toolId,
      permission: decision.permission,
      action: decision.action,
      matchedPattern: decision.matchedPattern,
      patterns: (decision.patterns || []).slice(0, 12),
      inputSummary: summarizePermissionInput(input),
      risk: decision.risk || null,
      reason: decision.reason || "",
      workflow: context.workflow || "",
      jobId: context.jobId || "",
      turnId: context.turnId || "",
      callID: context.callID || "",
      createdAt: now,
      updatedAt: now,
    }
    await appendPermissionEvent(request, this.ledgerPath())
    await auditPermission("permission_required", request)
    return request
  }
}

export const permissionService = new PermissionService()

export async function listPermissionRequests({ status = "pending", limit = 20, ledgerPath = paths.permissionsLedger } = {}) {
  const states = await readPermissionStates(ledgerPath)
  const filtered = states
    .filter((request) => status === "all" || !status || request.status === status)
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
  return filtered.slice(0, Math.max(1, Number(limit) || 20))
}

export async function resolvePermissionRequest(requestId, decision = "approved", reason = "", { ledgerPath = paths.permissionsLedger } = {}) {
  const normalized = normalizeResolution(decision)
  const states = await readPermissionStates(ledgerPath)
  const existing = states.find((request) => request.requestId === requestId)
  if (!existing) throw new Error(`Permission request not found: ${requestId}`)
  const event = {
    event: "permission_resolved",
    requestId,
    key: existing.key,
    status: normalized,
    decision: normalized,
    reason: reason || "",
    resolvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await appendPermissionEvent(event, ledgerPath)
  const resolved = { ...existing, ...event }
  await auditPermission("permission_resolved", resolved)
  return resolved
}

export function formatPermissionRequests(requests = []) {
  if (!requests.length) return "(no permission requests)"
  return requests
    .map((request) => {
      const id = request.requestId || "-"
      const status = request.status || "pending"
      const tool = request.permission || request.toolId || "tool"
      const pattern = request.matchedPattern || request.patterns?.[0] || "*"
      const reason = request.reason ? ` - ${request.reason}` : ""
      return `${status.padEnd(8)} ${id} ${tool} ${pattern}${reason}`
    })
    .join("\n")
}

export function permissionRequestKey({ decision, input }) {
  return stableStringify({
    permission: decision.permission || decision.toolId || "",
    matchedPattern: decision.matchedPattern || "",
    input: summarizePermissionInput(input),
  })
}

export function classifyPermissionRisk({ tool, input = {}, decision = {}, cwd = process.cwd(), env = process.env } = {}) {
  const permission = decision.permission || tool?.canonicalId || tool?.id || ""
  if (permission === "bash") return classifyBash(input.command || "", env)

  if (tool?.dangerous) {
    return { action: "deny", level: "high", reason: "Dangerous tool is refused." }
  }

  if (isMutatingTool(tool, input)) {
    const outside = pathInputsOutsideTrustedRoots(input, { cwd, env })
    if (outside.length) {
      return {
        action: "deny",
        level: "outside-workspace",
        reason: `Mutation outside trusted roots is refused: ${outside[0]}`,
        outsidePaths: outside,
      }
    }
  }

  return { action: decision.action || "allow", level: "normal", reason: decision.reason || "" }
}

function classifyBash(command, env) {
  const text = String(command || "").trim()
  if (!text) return { action: "deny", level: "invalid", reason: "Empty bash command." }
  if (!isTruthy(env.OPENOVEL_ENABLE_BASH_TOOL)) {
    return { action: "deny", level: "disabled", reason: "Bash is disabled by default. Set OPENOVEL_ENABLE_BASH_TOOL=true to expose it." }
  }
  // Only obviously-catastrophic system commands are refused outright. Everything
  // else runs inside the OS sandbox (no network; writes limited to the
  // workspace), which is the real boundary, so ordinary mutating commands
  // (mv/rm/chmod inside the workspace, jq in-place edits) are allowed.
  if (isCatastrophicShell(text)) {
    return { action: "deny", level: "catastrophic", reason: "Catastrophic shell command is refused." }
  }
  return { action: "allow", level: "sandboxed-bash", reason: "Runs inside an OS sandbox: no network, writes limited to the workspace." }
}

function isMutatingTool(tool, input) {
  if (!tool) return false
  if (typeof tool.readOnly === "function") {
    try {
      return !tool.readOnly(input)
    } catch {
      return true
    }
  }
  return tool.readOnly !== true
}

function pathInputsOutsideTrustedRoots(input, { cwd, env }) {
  const roots = trustedRoots({ cwd, env })
  const outside = []
  for (const key of ["filePath", "path", "target", "destination", "dest"]) {
    const value = input?.[key]
    if (!value || typeof value !== "string" || !path.isAbsolute(value)) continue
    const resolved = path.resolve(value)
    if (!roots.some((root) => isInside(resolved, root))) outside.push(resolved)
  }
  return outside
}

function trustedRoots({ cwd, env }) {
  const layout = workspaceLayout({ cwd, env })
  return [cwd, layout.storyRoot, layout.sharedReferences, layout.home].map((root) => path.resolve(root))
}

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isCatastrophicShell(command) {
  return [
    /\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i,
    /\bsudo\s+rm\s+-rf\b/i,
    /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    /\bdiskutil\s+erase/i,
    /\bdd\b.*\bof=\/dev\//i,
  ].some((re) => re.test(command))
}

async function readPermissionStates(ledgerPath) {
  const raw = await readText(ledgerPath, "")
  const states = new Map()
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event?.requestId) continue
    const prev = states.get(event.requestId) || {}
    states.set(event.requestId, { ...prev, ...event })
  }
  return [...states.values()]
}

async function findLatestByKey(key, ledgerPath) {
  const states = await readPermissionStates(ledgerPath)
  return states
    .filter((request) => request.key === key)
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null
}

async function appendPermissionEvent(event, ledgerPath) {
  await ensureDir(path.dirname(ledgerPath))
  await appendJsonl(ledgerPath, event)
}

async function auditPermission(event, request) {
  try {
    await backgroundJobs.recordAudit({
      event,
      type: "permission",
      requestId: request.requestId,
      status: request.status,
      tool: request.permission || request.toolId,
      matchedPattern: request.matchedPattern,
      reason: request.reason,
    })
  } catch {
    // Permission decisions must not depend on audit availability.
  }
}

function normalizeResolution(value) {
  const v = String(value || "").toLowerCase()
  if (["approve", "approved", "allow", "allowed"].includes(v)) return "approved"
  if (["deny", "denied", "reject", "rejected"].includes(v)) return "denied"
  throw new Error(`Unknown permission resolution: ${value}`)
}

function summarizePermissionInput(input) {
  if (!input || typeof input !== "object") return input
  const out = {}
  for (const key of ["filePath", "path", "url", "query", "target", "action", "subagent_type", "task_id", "command"]) {
    if (input[key] === undefined) continue
    const value = String(input[key])
    out[key] = value.length > 240 ? `${value.slice(0, 240)}...[truncated ${value.length - 240}]` : value
  }
  return out
}

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}
