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
  // includeDangerous: true so the standalone Storykeeper gets the (OS-sandboxed)
  // bash tool too — in single mode it owns the whole story, so the same jq/grep
  // data-wrangling the resident sub-agents use should be available here. In team
  // mode the sub-agents carry bash; the Showrunner is built separately.
  const agent = isResidentTeamEnabled()
    ? (await buildShowrunnerAgent()) || createStorykeeperAgent({ includeDangerous: true })
    : createStorykeeperAgent({ includeDangerous: true })
  return runtime.run({
    agent,
    input: { turnId, action, foreground, backgroundSignal },
  })
}
