export function normalizeBackgroundAgentPack(pack) {
  if (!pack?.id) throw new Error("Background agent must have an id")

  const buildInitialMessages = pack.buildInitialMessages || pack.prepare
  const legacyWorkflow = !pack.buildInitialMessages && (pack.prepare || pack.normalize || pack.apply)

  return {
    ...pack,
    kind: pack.kind || (legacyWorkflow ? "legacy-workflow-adapter" : "agent-pack"),
    legacyWorkflow: Boolean(legacyWorkflow),

    async buildInitialMessages(args) {
      const prepared = buildInitialMessages ? await buildInitialMessages(args) : { messages: [] }
      return normalizePreparedContext(prepared)
    },

    async handleResult(args) {
      if (typeof pack.handleResult === "function") {
        return pack.handleResult(args)
      }

      const normalized = typeof pack.normalize === "function"
        ? await pack.normalize(args)
        : args.raw?.content
      const output = typeof pack.apply === "function"
        ? await pack.apply({ ...args, normalized })
        : normalized
      return agentRunResult(output ?? normalized, { trace: normalized })
    },
  }
}

export function agentRunResult(output, { trace = output } = {}) {
  return {
    __openovelAgentRunResult: true,
    output,
    trace,
  }
}

export function isAgentRunResult(value) {
  return Boolean(value && typeof value === "object" && value.__openovelAgentRunResult === true)
}

function normalizePreparedContext(prepared) {
  if (Array.isArray(prepared)) return { messages: prepared }
  if (!prepared || typeof prepared !== "object") return { messages: [] }
  return {
    ...prepared,
    messages: Array.isArray(prepared.messages) ? prepared.messages : [],
  }
}
