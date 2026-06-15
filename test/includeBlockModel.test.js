import test from "node:test"
import assert from "node:assert/strict"

import { parseIncludeFence } from "../src/electron/renderer/lib/richBlockModel.js"

test("parseIncludeFence resolves valid includes into renderable descriptors", () => {
  const items = parseIncludeFence("@include story/includes/scenes/a.png\n@include story/includes/clip.mp4")
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, "image")
  assert.equal(items[0].error, null)
  assert.match(items[0].src, /^ovl-asset:\/\/local\//)
  assert.equal(items[1].kind, "video")
})

test("parseIncludeFence accepts path equals syntax with equals attrs", () => {
  const [item] = parseIncludeFence(
    "path=story/includes/beats/opening-office-codex.jpg\nalt=旧办公室里的未来笔记本\ncaption=真正的王牌已经被他攥在手里",
  )
  assert.equal(item.kind, "image")
  assert.equal(item.error, null)
  assert.equal(item.rel, "story/includes/beats/opening-office-codex.jpg")
  assert.equal(item.alt, "旧办公室里的未来笔记本")
  assert.equal(item.caption, "真正的王牌已经被他攥在手里")
})

test("parseIncludeFence rejects paths outside story/includes/", () => {
  const items = parseIncludeFence("@include story/canon/secret.png\n@include ../etc/passwd")
  assert.equal(items.length, 2)
  for (const item of items) {
    assert.equal(item.src, null)
    assert.ok(item.error)
  }
})

test("parseIncludeFence flags unsupported file types", () => {
  const [item] = parseIncludeFence("@include story/includes/evil.exe")
  assert.equal(item.kind, "unknown")
  assert.equal(item.src, null)
  assert.match(item.error, /unsupported/i)
})

test("parseIncludeFence honors the contract's allow list", () => {
  const items = parseIncludeFence(
    "@include story/includes/a.png\n@include story/includes/clip.mp4",
    { allow: ["image"] },
  )
  assert.equal(items[0].error, null)           // image allowed
  assert.ok(items[1].error)                    // video not permitted
  assert.equal(items[1].src, null)
})

test("parseIncludeFence is total over partial/empty input", () => {
  assert.doesNotThrow(() => parseIncludeFence(""))
  assert.deepEqual(parseIncludeFence(""), [])
  assert.doesNotThrow(() => parseIncludeFence("@include story/includes/"))
})
