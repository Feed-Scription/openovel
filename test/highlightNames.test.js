import test from "node:test"
import assert from "node:assert/strict"

import { buildNameRegex, splitNameSegments, rehypeHighlightNames } from "../src/electron/renderer/lib/highlightNames.js"
import { extractCharacterHighlightNames } from "../src/context/foregroundInserts.js"

test("extractCharacterHighlightNames: character cards only, cleaned, longest-first, deduped", () => {
  const names = extractCharacterHighlightNames([
    { kind: "character", name: "朱博", triggers: ["朱博", "朱总", "Zhu Bo"] },
    { kind: "character", name: "陈静", triggers: ["陈静", "静姐", "x"] },          // "x" too short → dropped
    { kind: "place", name: "深圳", triggers: ["深圳", "华强北"] },                  // non-character → ignored
    { kind: "faction", name: "启明软件", triggers: ["启明"] },                       // non-character → ignored
    { kind: "character", name: "马化腾", triggers: ["马化腾", "小马哥", "bad,trigger"] }, // comma'd → dropped
  ])
  assert.ok(names.includes("朱博") && names.includes("Zhu Bo") && names.includes("小马哥"))
  assert.ok(!names.includes("深圳") && !names.includes("启明") && !names.includes("x") && !names.includes("bad,trigger"))
  // longest first: "Zhu Bo" (6) before 2-char CJK names
  assert.ok(names.indexOf("Zhu Bo") < names.indexOf("朱博"))
  // deduped (朱博 appears as name AND trigger)
  assert.equal(names.filter((n) => n === "朱博").length, 1)
})

test("splitNameSegments: CJK substring + Latin word-boundary matching", () => {
  const regex = buildNameRegex(["朱博", "Ann"])
  const cjk = splitNameSegments("朱博笑了，朱博的笔记本还亮着。", regex)
  assert.deepEqual(cjk.filter((s) => s.name).map((s) => s.text), ["朱博", "朱博"])
  // "Ann" must not light inside "Anna"
  const latin = splitNameSegments("Anna met Ann at noon.", regex)
  assert.deepEqual(latin.filter((s) => s.name).map((s) => s.text), ["Ann"])
})

test("longest alias wins over a contained shorter alias", () => {
  const regex = buildNameRegex(["陈", "陈振华"])
  const segs = splitNameSegments("陈振华点头，陈没说话。", regex)
  assert.deepEqual(segs.filter((s) => s.name).map((s) => s.text), ["陈振华", "陈"])
})

test("rehypeHighlightNames: wraps text nodes in span.np, skips code, recurses into spans", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [
          { type: "text", value: "朱博看着屏幕。" },
          {
            type: "element",
            tagName: "span",
            properties: { className: ["dq"] },
            children: [{ type: "text", value: "“朱博，你疯了。”" }],
          },
          { type: "element", tagName: "code", children: [{ type: "text", value: "朱博" }] },
        ],
      },
    ],
  }
  rehypeHighlightNames(["朱博"])()(tree)
  const p = tree.children[0]
  // plain text split into span.np + rest
  assert.equal(p.children[0].tagName, "span")
  assert.deepEqual(p.children[0].properties.className, ["np"])
  assert.equal(p.children[0].children[0].value, "朱博")
  // nested inside the dialogue span too
  const dq = p.children.find((c) => c.tagName === "span" && c.properties?.className?.includes("dq"))
  assert.ok(dq.children.some((c) => c.tagName === "span" && c.properties?.className?.includes("np")))
  // code untouched
  const code = p.children.find((c) => c.tagName === "code")
  assert.equal(code.children[0].type, "text")
})

test("empty name list is a no-op plugin", () => {
  const tree = { type: "root", children: [{ type: "text", value: "朱博" }] }
  rehypeHighlightNames([])()(tree)
  assert.equal(tree.children[0].type, "text")
})
