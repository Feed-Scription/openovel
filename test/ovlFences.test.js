import assert from "node:assert/strict"
import test from "node:test"

import { normalizeOvlFences, listOvlFenceKinds, RESERVED_OVL_KINDS } from "../src/lib/ovlFences.js"
import { parseHudFromText, stripHudFencesFromText, parseBackgroundFromText } from "../src/electron/renderer/lib/richBlockModel.js"

test("normalizeOvlFences leaves well-formed fences untouched", () => {
  const text = "prose\n\n```ovl:hud\ndate: 1999-05\nplace: 公司楼下\n```\n\nmore prose"
  const out = normalizeOvlFences(text)
  assert.equal(out.text, text)
  assert.deepEqual(out.fixes, [])
})

test("normalizeOvlFences moves an inline key/value payload into the body, one pair per line", () => {
  // Observed in save s_e9973d79: the whole HUD payload jammed on the opener.
  const text = "prose\n\n```ovl:hud date: 1999-05 place: 公司楼下 quota: 3/3 cash: 未清点\n```\n\nafter"
  const out = normalizeOvlFences(text)
  assert.deepEqual(out.fixes, ["hud"])
  assert.match(out.text, /```ovl:hud\ndate: 1999-05\nplace: 公司楼下\nquota: 3\/3\ncash: 未清点\n```/)
})

test("normalizeOvlFences keeps a payload without pair boundaries on a single body line", () => {
  // HTML-attribute style payload (quotes, no `key: ` separators) moves down whole.
  const text = '```ovl:image src="story/includes/beats/x.jpg" alt="一段描述"\n```'
  const out = normalizeOvlFences(text)
  assert.deepEqual(out.fixes, ["image"])
  assert.match(out.text, /```ovl:image\nsrc="story\/includes\/beats\/x\.jpg" alt="一段描述"\n```/)
})

test("normalizeOvlFences does not split on protocol-style colons", () => {
  const text = "```ovl:note ref: https://example.com/a id: 7\n```"
  const out = normalizeOvlFences(text)
  assert.match(out.text, /```ovl:note\nref: https:\/\/example\.com\/a\nid: 7\n```/)
})

test("normalizeOvlFences recovers a collapsed bg directive that the bg parser can then read", () => {
  const text = "```ovl:bg set: story/includes/bg/old-office-1999.jpg\n```"
  const out = normalizeOvlFences(text)
  assert.deepEqual(out.fixes, ["bg"])
  const directive = parseBackgroundFromText(text)
  assert.equal(directive?.verb, "set")
  assert.equal(directive?.rel, "story/includes/bg/old-office-1999.jpg")
})

test("normalizeOvlFences is idempotent", () => {
  const text = "```ovl:hud date: 1999-05 place: 公司楼下\n```"
  const once = normalizeOvlFences(text)
  const twice = normalizeOvlFences(once.text)
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.fixes, [])
})

test("renderer hud parse and strip recover the inline-collapsed fence", () => {
  const text = "之河盯着它。\n\n```ovl:hud date: 1999-05 place: 公司楼下 quota: 3/3\n```\n\n他没有急着点开。"
  const pairs = parseHudFromText(text)
  assert.deepEqual(pairs, [["date", "1999-05"], ["place", "公司楼下"], ["quota", "3/3"]])
  const stripped = stripHudFencesFromText(text)
  assert.ok(!stripped.includes("ovl:hud"))
  assert.ok(stripped.includes("之河盯着它。"))
  assert.ok(stripped.includes("他没有急着点开。"))
})

test("listOvlFenceKinds returns unique kinds in order; reserved set matches the contract", () => {
  const text = "```ovl:bg\nclear\n```\n\n```ovl:image\nx\n```\n\n```ovl:bg\nclear\n```"
  assert.deepEqual(listOvlFenceKinds(text), ["bg", "image"])
  assert.deepEqual([...RESERVED_OVL_KINDS].sort(), ["bg", "hud", "include", "music", "panel", "synopsis"])
})

test("parseIncludeFence carries alt/caption attributes into the descriptor", async () => {
  const { parseIncludeFence } = await import("../src/electron/renderer/lib/richBlockModel.js")
  const body = "@include story/includes/beats/a.jpg\nalt: 一句无障碍描述\ncaption: 一句图注"
  const [item] = parseIncludeFence(body, { allow: ["image"] })
  assert.equal(item.error, null)
  assert.equal(item.kind, "image")
  assert.equal(item.alt, "一句无障碍描述")
  assert.equal(item.caption, "一句图注")
})

test("a collapsed include opener normalizes into @include plus attribute lines", () => {
  const text = "```ovl:include @include story/includes/beats/a.jpg alt: 一句描述 caption: 一句图注\n```"
  const out = normalizeOvlFences(text)
  assert.deepEqual(out.fixes, ["include"])
  assert.match(out.text, /```ovl:include\n@include story\/includes\/beats\/a\.jpg\nalt: 一句描述\ncaption: 一句图注\n```/)
})
