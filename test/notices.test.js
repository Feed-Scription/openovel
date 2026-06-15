import test from "node:test"
import assert from "node:assert/strict"

import { createNotices, renderNotices, reportNotices } from "../src/lib/notices.js"

test("createNotices accumulates with levels + meta", () => {
  const n = createNotices("sanitizer")
  n.drop("dropped position")
  n.truncate("activeCharacters", { kept: 8, dropped: 4 })
  n.reject("bad id")
  const items = n.items()
  assert.equal(n.size, 3)
  assert.equal(items[0].level, "drop")
  assert.equal(items[1].level, "truncate")
  assert.equal(items[1].dropped, 4)
  assert.equal(items[2].level, "reject")
  assert.equal(items[0].scope, "sanitizer")
  assert.deepEqual(n.messages(), ["dropped position", "activeCharacters: kept 8, dropped 4", "bad id"])
})

test("renderNotices: empty → '', dedupe, cap, accepts strings + objects + sink", () => {
  assert.equal(renderNotices([]), "")
  assert.equal(renderNotices(null), "")
  // strings + dedupe
  const r = renderNotices(["a", "a", "b"], { header: "Dropped:" })
  assert.match(r, /Dropped:/)
  assert.equal((r.match(/⚠/g) || []).length, 2)
  // cap + overflow line
  const many = Array.from({ length: 12 }, (_, i) => `item${i}`)
  const capped = renderNotices(many, { cap: 5 })
  assert.equal((capped.match(/⚠/g) || []).length, 5)
  assert.match(capped, /and 7 more/)
  // accepts a sink directly
  const n = createNotices()
  n.drop("x")
  assert.match(renderNotices(n), /⚠ x/)
})

test("reportNotices: publishes a bus event + is a no-op when empty", () => {
  const events = []
  const bus = { publish: (e, p) => events.push({ e, p }) }
  reportNotices([], { bus, event: "notice" })
  assert.equal(events.length, 0)
  reportNotices(["scene_log line 3 unparseable"], { bus, event: "data.corruption" })
  assert.equal(events.length, 1)
  assert.equal(events[0].e, "data.corruption")
  assert.deepEqual(events[0].p.notices, ["scene_log line 3 unparseable"])
  // tolerates missing bus
  assert.doesNotThrow(() => reportNotices(["x"], {}))
})
