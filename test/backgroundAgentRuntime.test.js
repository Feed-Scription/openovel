import assert from "node:assert/strict"
import test from "node:test"

import { BackgroundAgentRuntime } from "../src/runtime/backgroundAgentRuntime.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"

test("background runtime can execute a workflow without a configured model", async () => {
  const events = []
  const workflow = {
    id: "test-workflow",
    forceFallback: true,
    async prepare() {
      return {
        contextValue: 42,
        messages: [{ role: "user", content: "hello" }],
      }
    },
    async fallback({ context }) {
      return JSON.stringify({ ok: true, value: context.contextValue })
    },
    async normalize({ raw }) {
      return JSON.parse(raw.content)
    },
    async apply({ normalized }) {
      return { applied: normalized.ok, value: normalized.value }
    },
    async onEvent(type) {
      events.push(type)
    },
  }

  const runtime = new BackgroundAgentRuntime({
    registry: new ToolRegistry(),
    bus: { publish() {} },
  })

  const result = await runtime.run({ workflow })
  assert.deepEqual(result, { applied: true, value: 42 })
  assert.deepEqual(events, ["background_agent_started", "background_agent_completed"])
})

test("background runtime can execute an agent pack without workflow lifecycle hooks", async () => {
  const published = []
  const agent = {
    id: "open-agent",
    kind: "test-agent-pack",
    forceFallback: true,
    async buildInitialMessages() {
      return {
        messages: [{ role: "user", content: "inspect freely" }],
        notes: ["agent-owned context"],
      }
    },
    async fallback({ context }) {
      return `agent report: ${context.notes.join(", ")}`
    },
    async handleResult({ raw }) {
      return { report: raw.content, committedBy: "agent" }
    },
    traceOutput(output) {
      return { committedBy: output.committedBy }
    },
  }

  const runtime = new BackgroundAgentRuntime({
    registry: new ToolRegistry(),
    bus: { publish: (event, payload) => published.push({ event, payload }) },
  })

  const result = await runtime.run({ agent })

  assert.deepEqual(result, { report: "agent report: agent-owned context", committedBy: "agent" })
  assert.equal(published[0].event, "background.agent.started")
  assert.equal(published[0].payload.agent, "open-agent")
  assert.equal(published[0].payload.agentKind, "test-agent-pack")
  assert.equal(published[0].payload.legacyWorkflow, false)
  assert.equal(published[1].event, "background.agent.completed")
  assert.deepEqual(published[1].payload.normalized, { committedBy: "agent" })
})
