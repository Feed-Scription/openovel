import { settingsEnv } from "../config/settings.js"

export class PermissionDeniedError extends Error {
  constructor(decision) {
    const subject = decision.permission || decision.toolId || "tool"
    const pattern = (decision.patterns || ["*"])[0]
    const reason = decision.reason ? ` ${decision.reason}` : ""
    const action = decision.action === "ask" ? "requires approval" : "was denied"
    super(`Tool ${subject} ${action} for pattern "${pattern}".${reason}`)
    this.name = "PermissionDeniedError"
    this.code = "OPENOVEL_PERMISSION_DENIED"
    this.permissionDecision = decision
  }
}

export function resolveToolPermission({ tool, input = {}, context = {}, env = settingsEnv() } = {}) {
  if (!tool) throw new Error("tool is required")
  const permission = canonicalPermission(tool)
  const permissionNames = [...new Set([permission, tool.id, ...(tool.aliases || [])].filter(Boolean))]
  const patterns = normalizePatterns(
    context.permissionPatterns || permissionPatternsForTool(permission, input),
  )
  const rules = [
    ...defaultPermissionRules({ env }),
    ...parsePermissionRules(env.OPENOVEL_TOOL_PERMISSION_RULES),
    ...normalizeRules(context.permissionRules),
  ]

  const perPattern = patterns.map((pattern) => {
    const matched = lastMatchingRule(rules, { permissionNames, pattern })
    if (matched) {
      return {
        action: normalizeAction(matched.action),
        reason: matched.reason || "",
        rule: compactRule(matched),
        pattern,
      }
    }
    return {
      action: defaultActionForTool(tool, env),
      reason: defaultReasonForTool(tool, env),
      rule: null,
      pattern,
    }
  })

  const denied = perPattern.find((item) => item.action === "deny")
  const asks = perPattern.find((item) => item.action === "ask")
  const final = denied || asks || perPattern[0] || {
    action: defaultActionForTool(tool, env),
    reason: defaultReasonForTool(tool, env),
    rule: null,
    pattern: "*",
  }

  return {
    action: final.action,
    reason: final.reason,
    rule: final.rule,
    permission,
    permissionNames,
    toolId: permission,
    patterns,
    matchedPattern: final.pattern,
    askFallback: normalizeAskFallback(env.OPENOVEL_PERMISSION_ASK_FALLBACK),
  }
}

export async function assertToolPermission({ tool, input = {}, context = {}, env = settingsEnv() } = {}) {
  const decision = resolveToolPermission({ tool, input, context, env })
  if (decision.action === "allow") return decision

  if (decision.action === "ask") {
    const handler = context.askPermission || context.permission?.ask
    if (handler) {
      const response = await handler(decision)
      if (response === true || response?.action === "allow" || response?.allowed === true) {
        return { ...decision, action: "allow", approvedByHandler: true }
      }
      const reason = response?.reason || decision.reason || "Approval handler rejected the request."
      throw new PermissionDeniedError({ ...decision, action: "deny", reason })
    }
    if (decision.askFallback === "allow") {
      return { ...decision, action: "allow", approvedByFallback: true }
    }
  }

  throw new PermissionDeniedError(decision)
}

export function permissionPatternsForTool(permission, input = {}) {
  if (["read", "write", "edit"].includes(permission)) return workspacePathPatterns(input.filePath || input.path)
  if (["glob", "grep"].includes(permission)) {
    return workspacePathPatterns(input.path || input.searchPath || ".")
  }
  if (permission === "webfetch") return urlPatterns(input.url)
  if (permission === "websearch") {
    return [
      input.provider ? `provider:${input.provider}` : "provider:default",
      input.query ? `query:${input.query}` : "query:*",
    ]
  }
  if (permission === "memory") {
    const action = input.action || "read"
    const target = input.target || "memory"
    return [`${action}:${target}`, target]
  }
  if (permission === "task") {
    return [input.subagent_type || "*", input.background === true ? "background" : "foreground"]
  }
  if (permission === "task_status") return [input.task_id || "*"]
  if (permission === "agent_message") return [input.agent || input.to || "*", input.type || "*"]
  if (permission === "monitor") return [input.action || "*", input.id || input.filePath || input.source || "*"]
  if (permission === "loop") return [input.action || "*", input.id || input.type || "*"]
  if (permission === "bash") return [input.command || "*"]
  return fallbackPatterns(input)
}

export function defaultPermissionRules({ env = settingsEnv() } = {}) {
  const bashEnabled = isTruthy(env.OPENOVEL_ENABLE_BASH_TOOL)
  const allowBuiltins = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webfetch",
    "websearch",
    "memory",
    "task",
    "task_status",
    "agent_message",
    "monitor",
    "loop",
    "fetch_image",
    "generate_image",
  ]
  return [
    ...allowBuiltins.map((permission) => ({
      permission,
      pattern: "*",
      action: "allow",
      source: "default",
    })),
    {
      permission: "bash",
      pattern: "*",
      action: bashEnabled ? "allow" : "deny",
      reason: bashEnabled
        ? "Bash was explicitly enabled by configuration."
        : "Bash is disabled by default. Set OPENOVEL_ENABLE_BASH_TOOL=true to expose it.",
      source: "default",
    },
  ]
}

export function parsePermissionRules(value) {
  if (!value) return []
  try {
    return normalizeRules(JSON.parse(value))
  } catch {
    return []
  }
}

export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return []
  return rules
    .filter((rule) => rule && typeof rule === "object")
    .map((rule) => ({
      permission: rule.permission || rule.tool || "*",
      pattern: rule.pattern || "*",
      action: normalizeAction(rule.action || rule.behavior),
      reason: rule.reason || "",
      source: rule.source || "config",
    }))
    .filter((rule) => ["allow", "ask", "deny"].includes(rule.action))
}

function canonicalPermission(tool) {
  return tool.canonicalId || tool.id
}

function lastMatchingRule(rules, { permissionNames, pattern }) {
  let matched = null
  for (const rule of rules) {
    const permissions = Array.isArray(rule.permission) ? rule.permission : [rule.permission]
    const patterns = Array.isArray(rule.pattern) ? rule.pattern : [rule.pattern]
    const permissionMatch = permissions.some((p) =>
      permissionNames.some((name) => wildcardMatch(String(p || "*"), name)),
    )
    if (!permissionMatch) continue
    const patternMatch = patterns.some((p) => wildcardMatch(String(p || "*"), pattern))
    if (!patternMatch) continue
    matched = rule
  }
  return matched
}

function wildcardMatch(pattern, value) {
  const normalizedPattern = normalizePatternText(pattern)
  const normalizedValue = normalizePatternText(value)
  if (normalizedPattern === "*") return true
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue)
}

function normalizePatterns(patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  const normalized = list.map(normalizePatternText).filter(Boolean)
  return [...new Set(normalized.length ? normalized : ["*"])]
}

function normalizePatternText(value) {
  return String(value || "*").replaceAll("\\", "/").replace(/^\.\//, "").trim() || "*"
}

function workspacePathPatterns(value) {
  const raw = normalizePatternText(value || ".")
  const patterns = [raw]
  if (!raw.startsWith("story/") && !raw.startsWith("shared/")) {
    patterns.push(raw === "." ? "story/" : `story/${raw}`)
  }
  return patterns
}

function urlPatterns(value) {
  const raw = normalizePatternText(value || "*")
  const patterns = [raw]
  try {
    const parsed = new URL(raw)
    patterns.push(parsed.hostname)
    patterns.push(`${parsed.protocol}//${parsed.hostname}${parsed.pathname}`)
  } catch {
    // Keep the raw pattern for invalid or non-URL input.
  }
  return patterns
}

function fallbackPatterns(input) {
  for (const key of ["filePath", "path", "url", "command", "query", "target"]) {
    if (input?.[key]) return [String(input[key])]
  }
  return ["*"]
}

function defaultActionForTool(tool, env) {
  if (canonicalPermission(tool) === "bash") return isTruthy(env.OPENOVEL_ENABLE_BASH_TOOL) ? "allow" : "deny"
  if (tool.dangerous || tool.destructive) return "ask"
  if (typeof tool.readOnly === "function") return "ask"
  if (tool.readOnly === true) return "allow"
  return "ask"
}

function defaultReasonForTool(tool, env) {
  if (canonicalPermission(tool) === "bash" && !isTruthy(env.OPENOVEL_ENABLE_BASH_TOOL)) {
    return "Bash is disabled by default. Set OPENOVEL_ENABLE_BASH_TOOL=true to expose it."
  }
  if (tool.dangerous || tool.destructive) return "No explicit permission rule matched this mutating tool."
  return "No explicit permission rule matched."
}

function normalizeAction(value) {
  const action = String(value || "").toLowerCase()
  if (["allow", "ask", "deny"].includes(action)) return action
  return "ask"
}

function normalizeAskFallback(value) {
  return String(value || "deny").toLowerCase() === "allow" ? "allow" : "deny"
}

function compactRule(rule) {
  if (!rule) return null
  return {
    permission: rule.permission,
    pattern: rule.pattern,
    action: rule.action,
    source: rule.source,
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}
