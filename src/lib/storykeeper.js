import { BackgroundAgentRuntime } from "../runtime/backgroundAgentRuntime.js"
import { bus } from "../runtime/bus.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { createStorykeeperAgent } from "../workflows/storykeeperWorkflow.js"
import { isResidentTeamEnabled, buildShowrunnerAgent } from "../runtime/residentTeam.js"

// Adapter wiring the runtime to the background composition agent. Default: the
// single Storykeeper. Resident-team mode (OPENOVEL_RESIDENT_TEAM): the Showrunner
// — the same composer specialized to coordinate the sub-agents and compose the
// frontend from their domains.
export async function runStorykeeper({ turnId, action, foreground, backgroundSignal }) {
  const runtime = new BackgroundAgentRuntime({ registry: toolRegistry, bus, role: "background" })
  const agent = isResidentTeamEnabled()
    ? (await buildShowrunnerAgent()) || createStorykeeperAgent()
    : createStorykeeperAgent()
  return runtime.run({
    agent,
    input: { turnId, action, foreground, backgroundSignal },
  })
}
