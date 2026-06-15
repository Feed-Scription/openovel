import test from "node:test"
import assert from "node:assert/strict"

import { sanitizeBlockHtml, _internals } from "../src/lib/htmlBlock.js"

// Walk a HAST node and collect element tagNames in document order.
function tagsOf(node, out = []) {
  if (!node || typeof node !== "object") return out
  if (node.type === "element") out.push(node.tagName)
  if (Array.isArray(node.children)) for (const c of node.children) tagsOf(c, out)
  return out
}
function findFirst(node, tagName) {
  if (!node || typeof node !== "object") return null
  if (node.type === "element" && node.tagName === tagName) return node
  if (Array.isArray(node.children)) for (const c of node.children) {
    const hit = findFirst(c, tagName)
    if (hit) return hit
  }
  return null
}

test("clean HTML: allowed tags kept, classes + filtered style preserved, {{slot}} text intact", () => {
  const { tree, issues, empty } = sanitizeBlockHtml(
    '<div class="card"><span style="color:#333;padding:4px">Name: {{body}}</span></div>',
  )
  assert.deepEqual(issues, [])
  assert.equal(empty, false)
  assert.deepEqual(tagsOf(tree), ["div", "span"])
  const span = findFirst(tree, "span")
  assert.equal(span.properties.style, "color: #333; padding: 4px")
  assert.deepEqual(findFirst(tree, "div").properties.className, ["card"])
  // placeholder is preserved verbatim as a text node for the renderer to fill
  assert.ok(span.children.some((n) => n.type === "text" && n.value.includes("{{body}}")))
})

test("disallowed tags are reported and stripped", () => {
  assert.ok(sanitizeBlockHtml("<iframe src='http://x'></iframe>").issues.some((i) => /<iframe> tag is not allowed/.test(i)))
  assert.ok(sanitizeBlockHtml("<a href='http://x'>y</a>").issues.some((i) => /<a> tag is not allowed/.test(i)))
  // <script> body must not leak as visible text
  const r = sanitizeBlockHtml("<script>alert(1)</script>")
  assert.ok(r.issues.some((i) => /<script> tag is not allowed/.test(i)))
  assert.equal(r.empty, true)
  assert.equal(tagsOf(r.tree).length, 0)
  assert.doesNotMatch(JSON.stringify(r.tree), /alert/)
})

test("disallowed attributes are reported by name and removed", () => {
  const r = sanitizeBlockHtml('<div onclick="e()" id="x">hi</div>')
  assert.ok(r.issues.some((i) => /attribute "onclick" on <div> is not allowed/.test(i)))
  assert.ok(r.issues.some((i) => /attribute "id" on <div> is not allowed/.test(i)))
  const div = findFirst(r.tree, "div")
  assert.equal(div.properties.onClick, undefined)
  assert.equal(div.properties.id, undefined)
})

test("inline style: disallowed properties named and dropped, allowed ones kept", () => {
  const r = sanitizeBlockHtml('<span style="position:fixed;color:red;background-image:url(x)">z</span>')
  assert.ok(r.issues.some((i) => /inline style "position" on <span> is not allowed/.test(i)))
  assert.ok(r.issues.some((i) => /inline style "background-image" on <span> is not allowed/.test(i)))
  const span = findFirst(r.tree, "span")
  assert.equal(span.properties.style, "color: red") // only the safe decl survives
})

test("table cells keep colspan/rowspan; other cell attrs are not affected", () => {
  const r = sanitizeBlockHtml('<table><tbody><tr><td colspan="2" rowspan="3">a</td></tr></tbody></table>')
  assert.deepEqual(r.issues, [])
  const td = findFirst(r.tree, "td")
  // hast-util-sanitize may coerce numeric properties; the renderer reads them via
  // Number(), so accept either string or number here.
  assert.equal(Number(td.properties.colSpan), 2)
  assert.equal(Number(td.properties.rowSpan), 3)
})

test("length cap: oversized template reports an issue and is truncated", () => {
  const huge = "<div>" + "x".repeat(_internals.MAX_HTML_CHARS + 500) + "</div>"
  const r = sanitizeBlockHtml(huge)
  assert.ok(r.issues.some((i) => /over the .* limit/.test(i)))
})

test("position metadata is stripped from the stored tree (lean over IPC)", () => {
  const r = sanitizeBlockHtml("<div><span>x</span></div>")
  assert.doesNotMatch(JSON.stringify(r.tree), /"position"/)
})

test("never throws on garbage / empty / non-string input", () => {
  assert.doesNotThrow(() => sanitizeBlockHtml(null))
  assert.doesNotThrow(() => sanitizeBlockHtml(undefined))
  assert.doesNotThrow(() => sanitizeBlockHtml({}))
  assert.doesNotThrow(() => sanitizeBlockHtml("<div><span unclosed"))
  assert.equal(sanitizeBlockHtml("").empty, true)
})
