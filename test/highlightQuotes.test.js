import test from "node:test"
import assert from "node:assert/strict"

import { rehypeHighlightQuotes, splitDialogueQuoteSegments } from "../src/electron/renderer/lib/highlightQuotes.js"

const run = (tree) => {
  rehypeHighlightQuotes()(tree)
  return tree
}
const text = (value) => ({ type: "text", value })
const el = (tagName, children) => ({ type: "element", tagName, properties: {}, children })
const para = (...children) => el("p", children)

const dqSpans = (node, acc = []) => {
  if (node.type === "element" && node.tagName === "span" && node.properties?.className?.includes("dq")) {
    acc.push(node.children.map((c) => c.value).join(""))
  }
  for (const c of node.children || []) dqSpans(c, acc)
  return acc
}

test("wraps full-width curly dialogue", () => {
  const tree = run(para(text("他说“你好”然后离开了")))
  assert.deepEqual(dqSpans(tree), ["“你好”"])
  // surrounding text is preserved, in order
  const flat = tree.children.map((c) => (c.type === "text" ? c.value : `[${c.children[0].value}]`)).join("")
  assert.equal(flat, "他说[“你好”]然后离开了")
})

test("wraps straight ASCII dialogue and multiple quotes in one node", () => {
  const tree = run(para(text('She said "hi" and "bye"')))
  assert.deepEqual(dqSpans(tree), ['"hi"', '"bye"'])
})

test("highlights from the opening quote to end while streaming (no closer yet)", () => {
  const tree = run(para(text("他说“你好")))
  assert.deepEqual(dqSpans(tree), ["“你好"])
  const flat = tree.children.map((c) => (c.type === "text" ? c.value : `[${c.children[0].value}]`)).join("")
  assert.equal(flat, "他说[“你好]")
})

test("highlights a closed quote then an open trailing quote", () => {
  const tree = run(para(text('She said "hi" and "by')))
  assert.deepEqual(dqSpans(tree), ['"hi"', '"by'])
})

test("wraps CJK corner brackets — single 「」 and double 『』", () => {
  assert.deepEqual(dqSpans(run(para(text("他说「你好」然后离开了")))), ["「你好」"])
  assert.deepEqual(dqSpans(run(para(text("匾上写着『逆命之河』四字")))), ["『逆命之河』"])
})

test("corner brackets highlight open-to-end while streaming", () => {
  assert.deepEqual(dqSpans(run(para(text("他说「你好")))), ["「你好"])
  assert.deepEqual(dqSpans(run(para(text("他说『你好")))), ["『你好"])
})

test("a 『…』 nested inside 「…」 is one span", () => {
  assert.deepEqual(dqSpans(run(para(text("他说「她说『走吧』」")))), ["「她说『走吧』」"])
})

test("descends into nested inline elements", () => {
  const tree = run(para(text("他低声说"), el("em", [text("“走吧”")])))
  assert.deepEqual(dqSpans(tree), ["“走吧”"])
})

test("does not tint quotes inside code", () => {
  const tree = run(para(el("code", [text('print("hi")')])))
  assert.deepEqual(dqSpans(tree), [])
})

test("splitDialogueQuoteSegments mirrors streaming quote highlighting", () => {
  assert.deepEqual(splitDialogueQuoteSegments("他说“你好"), [
    { text: "他说", quoted: false },
    { text: "“你好", quoted: true },
  ])
  assert.deepEqual(splitDialogueQuoteSegments('She said "hi" and "by'), [
    { text: "She said ", quoted: false },
    { text: '"hi"', quoted: true },
    { text: " and ", quoted: false },
    { text: '"by', quoted: true },
  ])
})
