import { getAgentWriteScope, allAgentConfigs } from "./agentRegistry.js"
import { reportNotices } from "../lib/notices.js"

// Write-scope guard: the generic mechanism that keeps a resident sub-agent inside
// its own file domain (and out of the Showrunner-owned frontend/guidance). It
// intercepts ONLY the file-mutating tools (write/edit) keyed off the calling
// agent's id (context.agent) and its config writeScope globs. Reads, grep, glob,
// websearch, and webfetch are deliberately NOT guarded — reads are broad so
// agents can ground their work across domains.
//
// Gated by OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE: when OFF (default during rollout)
// a would-be denial is recorded via notices but the write proceeds, so we can
// observe false-denials before enforcing.

const WRITE_TOOLS = new Set(["write", "file_write", "edit"])

function enforcing() {
  return ["1", "true", "yes", "on"].includes(String(process.env.OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE || "").toLowerCase())
}

// Returns a denial reason string when the call should be blocked, else null.
// Callers short-circuit a denial into a non-throwing tool error
// ({ isError: true, output: reason }) so the model sees it as a normal tool failure.
export function agentWriteScopeDenial({ name, args, context } = {}) {
  if (!WRITE_TOOLS.has(name)) return null
  const agent = context?.agent
  if (!agent) return null
  const scope = getAgentWriteScope(agent)
  if (!scope || !scope.length) return null // unregistered/unscoped agent → unrestricted (e.g. legacy storykeeper)
  const filePath = normalizePath(String(args?.filePath || args?.path || ""))
  if (!filePath) return null
  if (scope.some((glob) => globMatch(glob, filePath))) return null

  const reason = `Agent "${agent}" may not write ${filePath}. Its writeScope is: ${scope.join(", ")}. ${ownerHint(agent, filePath)}`
  if (!enforcing()) {
    reportNotices([`write-scope (log-only, not enforced): ${reason}`], { event: "agent.write_scope", prefix: "guard" })
    return null
  }
  return reason
}

// Name the agent(s) whose writeScope covers the path, so the refused model can
// route the change instead of guessing. Coordinators are reached via
// forShowrunner, peers via forAgents; with no registered owner, fall back to
// the generic instruction.
function ownerHint(agent, filePath) {
  const owners = allAgentConfigs().filter((c) => c.id !== agent && (c.writeScope || []).some((glob) => globMatch(glob, filePath)))
  if (!owners.length) return "Edit a file inside your own domain, or route the change to the owning agent via a message."
  const names = owners.map((c) => `"${c.id}"${c.role === "coordinator" ? " (the coordinator: use forShowrunner)" : " (use forAgents)"}`)
  return `That path belongs to agent ${names.join(" / ")}; request the change there instead of writing it yourself.`
}

function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")
}

// Minimal glob: supports `**` (any chars incl. `/`) and `*` (any chars except `/`).
function globMatch(glob, target) {
  return globToRegExp(String(glob)).test(target)
}

function globToRegExp(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
        if (glob[i + 1] === "/") i++ // collapse `**/` so `a/**` and `a/**/b` both work
      } else {
        re += "[^/]*"
      }
    } else if ("\\^$+?.()|[]{}".includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}
