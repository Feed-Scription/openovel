import { BackgroundAgentRuntime } from "../runtime/backgroundAgentRuntime.js"
import { bus } from "../runtime/bus.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { createMemoryReviewAgent } from "../workflows/memoryReviewWorkflow.js"

export async function runMemoryReview({ turnId, action, foreground, backgroundSignal }) {
  const runtime = new BackgroundAgentRuntime({
    registry: toolRegistry,
    bus,
    role: "background",
  })
  return runtime.run({
    agent: createMemoryReviewAgent(),
    input: { turnId, action, foreground, backgroundSignal },
  })
}
