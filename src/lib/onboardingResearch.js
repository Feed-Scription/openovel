import { BackgroundAgentRuntime } from "../runtime/backgroundAgentRuntime.js"
import { bus } from "../runtime/bus.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { createOnboardingPreferenceAgent } from "../workflows/onboardingPreferenceWorkflow.js"

export async function runOnboardingPreferenceResearch({ turnId, answers, locale, trigger }) {
  const runtime = new BackgroundAgentRuntime({
    registry: toolRegistry,
    bus,
    role: "background",
  })
  return runtime.run({
    agent: createOnboardingPreferenceAgent(),
    input: { turnId, answers, locale, trigger },
  })
}
