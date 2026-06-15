// auto-responder for ask_user during scripted storyInit eval runs.
// Subscribes to `agent.ask_user.requested` and immediately resolves via
// askUserRegistry, picking options[0].label when the model surfaced choices,
// or a fallback free-form answer otherwise. Also logs every round-trip to
// disk so we can read the interaction quality after the fact.
//
// The picking policy is intentionally simple: the scripted user always picks
// the first recommended option, or says "你决定" to free-form questions. That
// gives both modes the same systematic bias for apples-to-apples comparison.

import { appendFile } from "node:fs/promises"

import { bus } from "../runtime/bus.js"
import { askUserRegistry } from "../runtime/askUserRegistry.js"

const DEFAULT_FREEFORM_ANSWER = "你决定"

export function installAutoResponder({ logPath, freeformAnswer = DEFAULT_FREEFORM_ANSWER } = {}) {
  const events = []
  const unsubRequested = bus.subscribe("agent.ask_user.requested", async (event) => {
    const { id, question, options } = event.properties || {}
    const answer = pickAnswer({ options, freeformAnswer })
    const record = {
      at: new Date().toISOString(),
      kind: "asked",
      id,
      question,
      options: (options || []).map((o) => ({ label: o.label, description: o.description })),
      chose: answer,
    }
    events.push(record)
    if (logPath) {
      await appendFile(logPath, JSON.stringify(record) + "\n").catch(() => {})
    }
    // Tiny delay so any "resolved" subscriber sees a clean event sequence.
    // Resolve synchronously after the next tick.
    setImmediate(() => {
      askUserRegistry.resolve(id, answer)
    })
  })
  const unsubResolved = bus.subscribe("agent.ask_user.resolved", async (event) => {
    const { id, answer } = event.properties || {}
    const record = { at: new Date().toISOString(), kind: "resolved", id, answer }
    events.push(record)
    if (logPath) {
      await appendFile(logPath, JSON.stringify(record) + "\n").catch(() => {})
    }
  })
  return {
    events,
    askCount: () => events.filter((e) => e.kind === "asked").length,
    uninstall: () => {
      unsubRequested?.()
      unsubResolved?.()
    },
  }
}

function pickAnswer({ options, freeformAnswer }) {
  if (Array.isArray(options) && options.length > 0) {
    return options[0].label
  }
  return freeformAnswer
}
