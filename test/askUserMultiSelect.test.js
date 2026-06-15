import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.OPENOVEL_HOME ||= path.join(os.tmpdir(), `openovel-askuser-${Date.now()}`)

const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
const { registerDefaultTools } = await import("../src/tools/registerTools.js")
const { askUserRegistry } = await import("../src/runtime/askUserRegistry.js")

function askUserTool() {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  return registry.get("ask_user")
}

// Bus stub that resolves the pending ask_user with `answer` as soon as the
// request event fires — simulating the user submitting from the UI.
function autoAnswerBus(answer) {
  const events = []
  return {
    events,
    publish(name, props) {
      events.push({ name, props })
      if (name === "agent.ask_user.requested") {
        queueMicrotask(() => askUserRegistry.resolve(props.id, answer))
      }
    },
  }
}

test("ask_user exposes a multiSelect parameter", () => {
  const tool = askUserTool()
  assert.ok(tool, "ask_user registered")
  assert.equal(tool.jsonSchema?.properties?.multiSelect?.type, "boolean")
})

test("ask_user validate rejects empty and content-free placeholder questions", async () => {
  const tool = askUserTool()
  assert.equal((await tool.validate({ question: "" })).ok, false)
  assert.equal((await tool.validate({ question: "   " })).ok, false)
  // degenerate placeholders that passed the old non-empty check but render blank
  assert.equal((await tool.validate({ question: "…" })).ok, false)
  assert.equal((await tool.validate({ question: "..." })).ok, false)
  assert.equal((await tool.validate({ question: " — ??? " })).ok, false)
  // a real question (incl. CJK) passes
  assert.equal(await tool.validate({ question: "Who is the protagonist?" }), true)
  assert.equal(await tool.validate({ question: "主角是谁？" }), true)
})

test("ask_user threads multiSelect into the request event and returns the combined answer verbatim", async () => {
  const tool = askUserTool()
  const bus = autoAnswerBus("Action-forward, Lore")
  const answer = await tool.execute(
    {
      question: "Which to emphasize?",
      options: [{ label: "Action-forward" }, { label: "Lore" }],
      multiSelect: true,
    },
    { bus },
  )
  // The tool returns the resolved string as-is (the UI joins the picks).
  assert.equal(answer, "Action-forward, Lore")
  const req = bus.events.find((e) => e.name === "agent.ask_user.requested")
  assert.equal(req.props.multiSelect, true)
  assert.equal(req.props.options.length, 2)
})

test("ask_user accepts a full example sentence as an option label, still caps absurd lengths", async () => {
  const tool = askUserTool()
  // 120 chars: over the old 80-char cap (which would have rejected a real line
  // of example narration), comfortably under the new 200.
  const longSentence = "句".repeat(120)
  const ok = await tool.validate({
    question: "哪一句最贴近你心里的叙述声音？",
    options: [{ label: longSentence, description: "冷峻 · 克制" }, { label: "短句。", description: "舒缓" }],
  })
  assert.equal(ok === true || ok?.ok === true, true, "120-char example-sentence label accepted")

  // The cap still exists — a runaway 201-char label is rejected.
  const tooLong = await tool.validate({
    question: "q",
    options: [{ label: "x".repeat(201), description: "" }, { label: "y", description: "" }],
  })
  assert.equal(tooLong?.ok, false, "labels over 200 chars are still rejected")
})

test("ask_user defaults to single-select", async () => {
  const tool = askUserTool()
  const bus = autoAnswerBus("Action-forward")
  await tool.execute(
    { question: "Pick one", options: [{ label: "Action-forward" }, { label: "Lore" }] },
    { bus },
  )
  const req = bus.events.find((e) => e.name === "agent.ask_user.requested")
  assert.equal(req.props.multiSelect, false)
})

test("ask_user forces multiSelect off when there are no options (nothing to combine)", async () => {
  const tool = askUserTool()
  const bus = autoAnswerBus("freeform reply")
  await tool.execute({ question: "Anything to add?", multiSelect: true }, { bus })
  const req = bus.events.find((e) => e.name === "agent.ask_user.requested")
  assert.equal(req.props.multiSelect, false)
})
