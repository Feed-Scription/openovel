export const DEFAULT_CAPABILITIES = {
  modalities: {
    input: ["text"],
    output: ["text"],
  },
  limits: {
    contextTokens: 128000,
    inputTokens: null,
    outputTokens: 8192,
  },
  request: {
    chat: true,
    streaming: true,
    streamOptions: true,
    tools: true,
    toolChoice: true,
    jsonMode: true,
    temperature: true,
    attachments: false,
    maxTokensField: "max_tokens",
  },
  response: {
    usage: true,
    streamingUsage: true,
    preserveAssistantFields: true,
    reasoningFields: [],
  },
  reasoning: {
    supported: false,
    effort: false,
    fields: [],
  },
  cost: null,
}

export class ProviderCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = "ProviderCapabilityError"
    this.code = "OPENOVEL_PROVIDER_CAPABILITY_UNSUPPORTED"
    this.details = details
  }
}

export function normalizeCapabilities(input = {}, legacy = {}) {
  return mergeCapabilities(DEFAULT_CAPABILITIES, canonicalCapabilityPatch(legacy), canonicalCapabilityPatch(input))
}

export function resolveProviderCapabilities(provider, { model = provider?.model || "", role = provider?.role, env = {} } = {}) {
  let capabilities = normalizeCapabilities(provider.capabilities, {
    request: {
      maxTokensField: provider.maxTokensField,
    },
  })

  for (const patch of modelCapabilityPatches(provider.modelCapabilities, model)) {
    capabilities = mergeCapabilities(capabilities, canonicalCapabilityPatch(patch))
  }

  const providerOverrides = parseJsonObject(env.OPENOVEL_PROVIDER_CAPABILITIES)
  const modelOverrides = parseJsonObject(env.OPENOVEL_MODEL_CAPABILITIES)
  if (providerOverrides[provider.id]) {
    capabilities = mergeCapabilities(capabilities, canonicalCapabilityPatch(providerOverrides[provider.id]))
  }
  const modelKeys = [`${provider.id}/${model}`, model, `${role || ""}/${model}`].filter(Boolean)
  for (const key of modelKeys) {
    if (modelOverrides[key]) capabilities = mergeCapabilities(capabilities, canonicalCapabilityPatch(modelOverrides[key]))
  }

  return normalizeResolvedCapabilities(capabilities)
}

export function adaptChatRequestToCapabilities(provider, request) {
  const capabilities = normalizeResolvedCapabilities(provider.capabilities)
  const out = { ...request }
  const toolCount = Array.isArray(request.tools) ? request.tools.length : request.tools ? 1 : 0

  if (toolCount > 0 && capabilities.request.tools === false) {
    throw new ProviderCapabilityError(`Provider ${provider.id} does not support tool calling.`, {
      provider: provider.id,
      model: provider.model,
      feature: "tools",
    })
  }
  if (request.toolChoice && capabilities.request.toolChoice === false) {
    if (toolCount > 0) {
      throw new ProviderCapabilityError(`Provider ${provider.id} does not support tool_choice.`, {
        provider: provider.id,
        model: provider.model,
        feature: "toolChoice",
      })
    }
    out.toolChoice = undefined
  }
  if (request.stream && capabilities.request.streaming === false) {
    throw new ProviderCapabilityError(`Provider ${provider.id} does not support streaming.`, {
      provider: provider.id,
      model: provider.model,
      feature: "streaming",
    })
  }
  if (request.json && capabilities.request.jsonMode === false) out.json = false
  if (request.temperature !== undefined && capabilities.request.temperature === false) out.temperature = undefined

  const maxOutput = numberOrNull(capabilities.limits.outputTokens)
  if (maxOutput && Number(out.maxTokens) > maxOutput) out.maxTokens = maxOutput
  out.maxTokensField = capabilities.request.maxTokensField || provider.maxTokensField || "max_tokens"
  out.streamOptions = capabilities.request.streamOptions !== false
  return out
}

export function mergeCapabilities(...items) {
  return items.reduce((acc, item) => deepMerge(acc, item || {}), {})
}

export function publicCapabilities(capabilities) {
  const normalized = normalizeResolvedCapabilities(capabilities)
  return {
    modalities: normalized.modalities,
    limits: normalized.limits,
    request: normalized.request,
    response: normalized.response,
    reasoning: normalized.reasoning,
    cost: normalized.cost,
  }
}

function normalizeResolvedCapabilities(capabilities = {}) {
  const merged = deepMerge(DEFAULT_CAPABILITIES, capabilities)
  merged.modalities = {
    input: stringArray(merged.modalities?.input, DEFAULT_CAPABILITIES.modalities.input),
    output: stringArray(merged.modalities?.output, DEFAULT_CAPABILITIES.modalities.output),
  }
  merged.limits = {
    contextTokens: numberOrNull(merged.limits?.contextTokens) || DEFAULT_CAPABILITIES.limits.contextTokens,
    inputTokens: numberOrNull(merged.limits?.inputTokens),
    outputTokens: numberOrNull(merged.limits?.outputTokens) || DEFAULT_CAPABILITIES.limits.outputTokens,
  }
  merged.request = {
    ...DEFAULT_CAPABILITIES.request,
    ...(merged.request || {}),
    maxTokensField: merged.request?.maxTokensField || DEFAULT_CAPABILITIES.request.maxTokensField,
  }
  merged.response = {
    ...DEFAULT_CAPABILITIES.response,
    ...(merged.response || {}),
    reasoningFields: stringArray(merged.response?.reasoningFields, []),
  }
  merged.reasoning = {
    ...DEFAULT_CAPABILITIES.reasoning,
    ...(merged.reasoning || {}),
    fields: stringArray(merged.reasoning?.fields, []),
  }
  return merged
}

function canonicalCapabilityPatch(input = {}) {
  if (!input || typeof input !== "object") return {}
  const {
    attachment,
    tool_call,
    temperature,
    reasoning,
    limit,
    modalities,
    request,
    response,
    limits,
    ...rest
  } = input
  const out = { ...rest }
  if (modalities) out.modalities = modalities
  if (limit) {
    out.limits = {
      ...(out.limits || {}),
      contextTokens: limit.context,
      inputTokens: limit.input,
      outputTokens: limit.output,
    }
  }
  if (limits) out.limits = { ...(out.limits || {}), ...limits }
  if (request) out.request = { ...(out.request || {}), ...request }
  if (response) out.response = { ...(out.response || {}), ...response }
  if (attachment !== undefined) out.request = { ...(out.request || {}), attachments: Boolean(attachment) }
  if (tool_call !== undefined) out.request = { ...(out.request || {}), tools: Boolean(tool_call) }
  if (temperature !== undefined) out.request = { ...(out.request || {}), temperature: Boolean(temperature) }
  if (typeof reasoning === "boolean") {
    out.reasoning = { ...(out.reasoning || {}), supported: reasoning }
  } else if (reasoning && typeof reasoning === "object") {
    out.reasoning = { ...(out.reasoning || {}), ...reasoning }
  }
  return out
}

function modelCapabilityPatches(modelCapabilities, model) {
  if (!modelCapabilities || !model) return []
  if (Array.isArray(modelCapabilities)) {
    return modelCapabilities
      .filter((item) => matchesModelPattern(item.match || item.model || item.pattern || "*", model))
      .map((item) => item.capabilities || item)
  }
  if (typeof modelCapabilities === "object") {
    return Object.entries(modelCapabilities)
      .filter(([pattern]) => matchesModelPattern(pattern, model))
      .map(([, patch]) => patch)
  }
  return []
}

function matchesModelPattern(pattern, model) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  return patterns.some((item) => wildcardMatch(String(item || "*"), String(model || "")))
}

function wildcardMatch(pattern, value) {
  if (pattern === "*") return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

function deepMerge(target, source) {
  if (!isPlainObject(target)) target = {}
  if (!isPlainObject(source)) return cloneValue(source)
  const out = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (Array.isArray(value)) out[key] = [...value]
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = cloneValue(value)
  }
  return out
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value]
  if (isPlainObject(value)) return deepMerge({}, value)
  return value
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function stringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.map((item) => String(item)).filter(Boolean)
}

function parseJsonObject(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
