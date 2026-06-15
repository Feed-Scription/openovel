import test from "node:test"
import assert from "node:assert/strict"

import { stripOvlFences, shareImageFilename } from "../src/electron/renderer/lib/shareText.js"

test("stripOvlFences removes ovl:* fenced blocks, keeps surrounding prose", () => {
  const text = [
    "他走到终端前。",
    "",
    "```ovl:include",
    "@include story/includes/scenes/a.png",
    "```",
    "",
    "屏幕亮了。",
  ].join("\n")
  const out = stripOvlFences(text)
  assert.doesNotMatch(out, /ovl:/)
  assert.doesNotMatch(out, /@include/)
  assert.equal(out, "他走到终端前。\n\n屏幕亮了。")
})

test("stripOvlFences leaves ordinary prose / non-ovl fences untouched", () => {
  assert.equal(stripOvlFences("纯粹的散文，没有围栏。"), "纯粹的散文，没有围栏。")
  const code = "看这段代码：\n```js\nconst x = 1\n```"
  assert.equal(stripOvlFences(code), code)
})

test("stripOvlFences is total over empty/null", () => {
  assert.equal(stripOvlFences(""), "")
  assert.equal(stripOvlFences(null), "")
})

test("shareImageFilename slugifies the story name and is filesystem-safe", () => {
  assert.equal(shareImageFilename("朱桐的妙妙假期"), "openovel-朱桐的妙妙假期.png")
  assert.equal(shareImageFilename("My Story: Part 1/2"), "openovel-My-Story-Part-1-2.png")
  assert.equal(shareImageFilename(""), "openovel-paragraph.png")
  assert.equal(shareImageFilename(null), "openovel-paragraph.png")
})
