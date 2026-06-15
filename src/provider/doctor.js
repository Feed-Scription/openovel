import { diagnoseProviders } from "./provider.js"

const diagnosis = diagnoseProviders()

console.log("openovel provider doctor")
console.log(`default: ${diagnosis.defaultProvider}`)
console.log(`order: ${diagnosis.providerOrder.join(", ")}`)
console.log(`paid fallback: ${diagnosis.allowPaidFallback ? "enabled" : "disabled"}`)
console.log("")
printRoute("foreground", diagnosis.foreground)
printRoute("background", diagnosis.background)
printProfiles(diagnosis.modelProfiles || [])

function printRoute(label, route) {
  console.log(`${label}:`)
  for (const provider of route) {
    const key = provider.keyConfigured ? "key=yes" : `key=missing(${provider.keyEnv || "-"})`
    const caps = capabilitySummary(provider.capabilities)
    const conc = `conc=${provider.concurrency ?? "-"}`
    console.log(
      `  - ${provider.id} ${provider.billingMode} model=${provider.model || "-"} ${key} ${conc} caps=${caps} base=${provider.baseUrl || "-"}`,
    )
  }
  console.log("")
}

function printProfiles(profiles) {
  console.log("model profiles:")
  for (const profile of profiles) {
    console.log(
      `  - ${profile.id} role=${profile.role} model=${profile.model || "-"} provider=${profile.provider?.id || "-"} tier=${profile.costTier} source=${profile.modelSource}`,
    )
  }
  console.log("")
}

function capabilitySummary(capabilities = {}) {
  const request = capabilities.request || {}
  const reasoning = capabilities.reasoning || {}
  const limits = capabilities.limits || {}
  const flags = [
    request.streaming === false ? "no-stream" : "stream",
    request.tools === false ? "no-tools" : "tools",
    request.jsonMode === false ? "no-json" : "json",
    request.temperature === false ? "no-temp" : "temp",
    reasoning.supported ? "reasoning" : "no-reasoning",
  ]
  const output = limits.outputTokens ? `out=${limits.outputTokens}` : ""
  return [...flags, output].filter(Boolean).join(",")
}
