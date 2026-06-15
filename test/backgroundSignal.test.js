import assert from "node:assert/strict"
import test from "node:test"

import { normalizeSignal } from "../src/lib/backgroundSignal.js"

test("background signal normalizer preserves foreground anchors for slow loop", () => {
  const signal = normalizeSignal({
    priority: "now",
    tasks: [
      {
        type: "research",
        instruction: "核查镜城港区地形和潮汐塔维护制度。",
        anchors: ["镜城港区", "潮汐塔"],
      },
    ],
    preserve: ["无名测绘员", "潮汐塔"],
  })

  assert.equal(signal.needsBackground, true)
  assert.equal(signal.priority, "now")
  assert.equal(signal.tasks[0].type, "research")
  assert.deepEqual(signal.tasks[0].anchors, ["镜城港区", "潮汐塔"])
  assert.deepEqual(signal.preserve, ["无名测绘员", "潮汐塔"])
})

test("background signal creates continuity task from preserve anchors", () => {
  const signal = normalizeSignal({
    needsBackground: true,
    preserve: ["乱葬岗", "干沟", "木桥"],
  })

  assert.equal(signal.tasks.length, 1)
  assert.equal(signal.tasks[0].type, "continuity")
  assert.deepEqual(signal.tasks[0].anchors, ["乱葬岗", "干沟", "木桥"])
})

test("background signal extracts styleSignal when reader names a style reference", () => {
  const signal = normalizeSignal({
    needsBackground: true,
    tasks: [{ type: "research", instruction: "Research 郭敬明 prose traits and write a style card." }],
    styleSignal: {
      requested: "flamboyant",
      namedReference: "郭敬明",
      complaint: "",
    },
  })

  assert.ok(signal.styleSignal, "styleSignal should be present")
  assert.equal(signal.styleSignal.requested, "flamboyant")
  assert.equal(signal.styleSignal.namedReference, "郭敬明")
  assert.equal(signal.styleSignal.complaint, "")
})

test("background signal returns null styleSignal when reader did not signal style intent", () => {
  const signal = normalizeSignal({
    needsBackground: true,
    tasks: [{ type: "continuity", instruction: "Track the boarding gate code RV-7421." }],
  })

  assert.equal(signal.styleSignal, null)
})

test("background signal drops empty styleSignal even when the field is supplied", () => {
  const signal = normalizeSignal({
    needsBackground: true,
    tasks: [{ type: "continuity", instruction: "noop" }],
    styleSignal: { requested: "", namedReference: "", complaint: "" },
  })

  assert.equal(signal.styleSignal, null)
})
