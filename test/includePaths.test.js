import test from "node:test"
import assert from "node:assert/strict"

import {
  assetUrl,
  classifyInclude,
  includeExtension,
  isUnderIncludes,
  isUnsafeIncludePath,
  parseIncludeLines,
  relFromAssetUrl,
} from "../src/lib/includePaths.js"

test("isUnsafeIncludePath rejects escapes / absolutes / out-of-scope", () => {
  assert.equal(isUnsafeIncludePath("story/includes/a.png"), false)
  assert.equal(isUnsafeIncludePath("shared/references/a.md"), false)
  assert.equal(isUnsafeIncludePath(""), true)
  assert.equal(isUnsafeIncludePath("/etc/passwd"), true)
  assert.equal(isUnsafeIncludePath("C:\\secret"), true)
  assert.equal(isUnsafeIncludePath("~/secret"), true)
  assert.equal(isUnsafeIncludePath("story/../settings.local.json"), true)
  assert.equal(isUnsafeIncludePath("canon/chapters.md"), true) // missing scope head
})

test("isUnderIncludes requires story/includes/<file>", () => {
  assert.equal(isUnderIncludes("story/includes/a.png"), true)
  assert.equal(isUnderIncludes("story/includes/sub/a.png"), true)
  assert.equal(isUnderIncludes("story/includes"), false)        // dir, no file
  assert.equal(isUnderIncludes("story/canon/a.md"), false)
  assert.equal(isUnderIncludes("shared/includes/a.png"), false)
})

test("classifyInclude maps known extensions, unknown otherwise", () => {
  assert.equal(classifyInclude("a/b/c.PNG"), "image")
  assert.equal(classifyInclude("clip.mp4"), "video")
  assert.equal(classifyInclude("ogg-is-audio.ogg"), "audio")
  assert.equal(classifyInclude("ogv-is-video.ogv"), "video")
  assert.equal(classifyInclude("note.md"), "text")
  assert.equal(classifyInclude("note.txt"), "text")
  assert.equal(classifyInclude("evil.exe"), "unknown")
  assert.equal(classifyInclude("noext"), "unknown")
})

test("includeExtension extracts lowercase extension", () => {
  assert.equal(includeExtension("X/Y/Z.JPG"), "jpg")
  assert.equal(includeExtension("noext"), "")
})

test("assetUrl / relFromAssetUrl round-trip (incl. spaces/unicode)", () => {
  const rel = "story/includes/scenes/苏州 dusk.png"
  const url = assetUrl(rel)
  assert.match(url, /^ovl-asset:\/\/local\//)
  assert.equal(relFromAssetUrl(url), rel)
})

test("relFromAssetUrl returns '' for non-asset URLs", () => {
  assert.equal(relFromAssetUrl("https://evil.example/x.png"), "")
  assert.equal(relFromAssetUrl("file:///etc/passwd"), "")
  assert.equal(relFromAssetUrl("not a url"), "")
})

test("parseIncludeLines accepts @include and bare paths, skips blanks/comments", () => {
  const body = [
    "@include story/includes/a.png",
    "",
    "  story/includes/b.mp4  ",
    "# a comment",
    "@include   story/includes/sub/c.md",
  ].join("\n")
  assert.deepEqual(parseIncludeLines(body), [
    "story/includes/a.png",
    "story/includes/b.mp4",
    "story/includes/sub/c.md",
  ])
})

test("parseIncludeLines never throws on empty/garbage", () => {
  assert.doesNotThrow(() => parseIncludeLines(null))
  assert.deepEqual(parseIncludeLines(""), [])
})

test("parseIncludeDirectives attaches alt/caption attribute lines to the preceding include", async () => {
  const { parseIncludeDirectives } = await import("../src/lib/includePaths.js")
  const body = [
    "@include story/includes/beats/a.jpg",
    "alt: 一句无障碍描述",
    "caption: 一句图注",
    "@include story/includes/beats/b.jpg",
    "alt： 全角冒号也可以",
  ].join("\n")
  assert.deepEqual(parseIncludeDirectives(body), [
    { rel: "story/includes/beats/a.jpg", attrs: { alt: "一句无障碍描述", caption: "一句图注" } },
    { rel: "story/includes/beats/b.jpg", attrs: { alt: "全角冒号也可以" } },
  ])
})

test("parseIncludeDirectives accepts inline alt/caption after a media path", async () => {
  const { parseIncludeDirectives } = await import("../src/lib/includePaths.js")
  const body = "@include story/includes/beats/opening-shin-osaka-lone-transfer.jpg alt: 冬天的新大阪换乘空间里，戴宽檐帽和圆框眼镜的朱仝背着包拖着行李，低头看手机确认路线。 caption: 新大阪的换乘口把人流分成几股，朱仝站在中间，像一个刚被系统调度到日本的博士生。"
  assert.deepEqual(parseIncludeDirectives(body), [
    {
      rel: "story/includes/beats/opening-shin-osaka-lone-transfer.jpg",
      attrs: {
        alt: "冬天的新大阪换乘空间里，戴宽檐帽和圆框眼镜的朱仝背着包拖着行李，低头看手机确认路线。",
        caption: "新大阪的换乘口把人流分成几股，朱仝站在中间，像一个刚被系统调度到日本的博士生。",
      },
    },
  ])
})

test("parseIncludeDirectives ignores unknown attribute keys and orphan attributes", async () => {
  const { parseIncludeDirectives } = await import("../src/lib/includePaths.js")
  const body = [
    "alt: 没有归属的属性行",
    "@include story/includes/a.png",
    "title: 不在闭集里",
  ].join("\n")
  const out = parseIncludeDirectives(body)
  assert.equal(out.length, 2) // orphan alt skipped; unknown `title:` falls through as a (rejected) bare path
  assert.deepEqual(out[0], { rel: "story/includes/a.png", attrs: {} })
  assert.equal(out[1].rel, "title: 不在闭集里")
})

test("parseIncludeLines still returns paths only (attribute lines never leak as paths)", () => {
  const body = [
    "@include story/includes/a.png",
    "alt: 描述",
    "caption: 图注",
  ].join("\n")
  assert.deepEqual(parseIncludeLines(body), ["story/includes/a.png"])
})
