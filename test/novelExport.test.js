import test from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdir, writeFile, rm } from "node:fs/promises"
import JSZip from "jszip"

import { parseChaptersMd } from "../src/services/export/parseChaptersMd.js"
import { collectNovelData } from "../src/services/export/collectNovelData.js"
import { generateTxt } from "../src/services/export/generateTxt.js"
import { generateEpub } from "../src/services/export/generateEpub.js"

test("parseChaptersMd splits on **读者选择** headers", () => {
  const md = `

**读者选择**：环顾四周

夜色压低了屋檐。

第二段。

**读者选择**：走向窗台

她迈出半步。
`
  const chapters = parseChaptersMd(md)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].turn, 1)
  assert.equal(chapters[0].action, "环顾四周")
  assert.deepEqual(chapters[0].paragraphs, ["夜色压低了屋檐。", "第二段。"])
  assert.equal(chapters[1].turn, 2)
  assert.equal(chapters[1].action, "走向窗台")
  assert.deepEqual(chapters[1].paragraphs, ["她迈出半步。"])
})

test("parseChaptersMd treats pre-header prose as turn 0 prologue", () => {
  const md = `开场介绍段落。

更多前情。

**读者选择**：开始

第一回合的正文。
`
  const chapters = parseChaptersMd(md)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].turn, 0)
  assert.equal(chapters[0].action, "")
  assert.deepEqual(chapters[0].paragraphs, ["开场介绍段落。", "更多前情。"])
  assert.equal(chapters[1].turn, 1)
  assert.equal(chapters[1].action, "开始")
})

test("parseChaptersMd returns [] for empty input", () => {
  assert.deepEqual(parseChaptersMd(""), [])
  assert.deepEqual(parseChaptersMd(null), [])
})

test("collectNovelData demotes the auto-trigger seed action to a turn-0 prologue", async () => {
  const root = path.join(tmpdir(), `openovel-novel-seed-${Date.now()}`)
  await mkdir(path.join(root, "canon"), { recursive: true })
  await writeFile(
    path.join(root, "canon", "chapters.md"),
    [
      "**读者选择**：（开始故事。请根据 FOREGROUND.md 中的 Prelude 与世界设定，写出真正的开场场景。）",
      "",
      "夜色压低了屋檐。",
      "",
      "**读者选择**：走向窗台",
      "",
      "她迈出半步。",
      "",
      "**读者选择**：推开木窗",
      "",
      "冷风扑面。",
    ].join("\n"),
  )
  await writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({ storyId: "s_seed", displayName: "雨夜来客" }),
  )
  try {
    const data = await collectNovelData({ storyRoot: root, locale: "zh" })
    // 3 chapters: prologue (turn 0, seed action stripped) + 2 real chapters
    assert.equal(data.chapters.length, 3)
    assert.equal(data.chapters[0].turn, 0)
    assert.equal(data.chapters[0].action, "")
    assert.equal(data.chapters[0].isAutoSeed, true)
    assert.deepEqual(data.chapters[0].paragraphs, ["夜色压低了屋檐。"])
    // Subsequent chapters renumber from 1, preserving their real action
    assert.equal(data.chapters[1].turn, 1)
    assert.equal(data.chapters[1].action, "走向窗台")
    assert.equal(data.chapters[2].turn, 2)
    assert.equal(data.chapters[2].action, "推开木窗")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("collectNovelData picks title from meta.json displayName", async () => {
  const root = path.join(tmpdir(), `openovel-novel-test-${Date.now()}`)
  await mkdir(path.join(root, "canon"), { recursive: true })
  await writeFile(
    path.join(root, "canon", "chapters.md"),
    "**读者选择**：开门\n\n他推开了门。",
  )
  await writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({ storyId: "s_test", displayName: "雨夜来客" }),
  )
  await writeFile(path.join(root, "BRIEF.md"), "一个雨夜的故事。")
  try {
    const data = await collectNovelData({ storyRoot: root, locale: "zh" })
    assert.equal(data.title, "雨夜来客")
    assert.equal(data.brief, "一个雨夜的故事。")
    assert.equal(data.locale, "zh")
    assert.equal(data.chapters.length, 1)
    assert.equal(data.chapters[0].action, "开门")
    assert.equal(data.stats.turnCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("generateTxt produces UTF-8 BOM + readable layout", () => {
  const data = {
    storyId: "s_a",
    title: "标题",
    brief: "",
    locale: "zh",
    chapters: [
      { turn: 1, action: "看向窗外", paragraphs: ["第一段。", "第二段。"] },
    ],
    stats: { turnCount: 1, paragraphCount: 2, characterCount: 8 },
    exportedAt: "2026-05-28T00:00:00.000Z",
  }
  const buf = generateTxt(data)
  assert.ok(Buffer.isBuffer(buf))
  // BOM is the UTF-8 sequence EF BB BF
  assert.equal(buf[0], 0xef)
  assert.equal(buf[1], 0xbb)
  assert.equal(buf[2], 0xbf)
  const text = buf.toString("utf8")
  assert.ok(text.includes("标题"))
  assert.ok(text.includes("第 1 章"))
  assert.ok(text.includes("› 看向窗外"))
  assert.ok(text.includes("第一段。"))
  // Should NOT have the heavy double-line dividers anymore — the openovel
  // style is single-rule, no decorative walls.
  assert.ok(!text.includes("═"))
})

test("generateTxt strips the action label for the seed prologue", () => {
  const data = {
    storyId: "s_c",
    title: "Title",
    brief: "",
    locale: "en",
    chapters: [
      { turn: 0, action: "", isAutoSeed: true, paragraphs: ["Opening scene paragraph."] },
      { turn: 1, action: "examine the room", paragraphs: ["She stepped forward."] },
    ],
    stats: { turnCount: 2, paragraphCount: 2, characterCount: 30 },
    exportedAt: "2026-05-28T00:00:00.000Z",
  }
  const text = generateTxt(data).toString("utf8")
  assert.ok(text.includes("Prologue"), "prologue heading appears")
  assert.ok(text.includes("Opening scene paragraph."), "prologue body kept")
  // The chevron stage-direction line should only appear for real user actions
  assert.ok(text.includes("› examine the room"))
  // And the seed action text must NOT appear anywhere
  assert.ok(!text.includes("Begin the story"))
})

test("generateEpub renders inline italic / bold / code in paragraphs", async () => {
  const data = {
    storyId: "s_md",
    title: "T",
    brief: "",
    locale: "en",
    chapters: [
      {
        turn: 1,
        action: "browse the shelf",
        paragraphs: [
          "He picked up *Artificial Intelligence*, then *Machine Learning*.",
          "Headlines read **BREAKING** while `code/path.md` blinked.",
        ],
      },
    ],
    stats: { turnCount: 1, paragraphCount: 2, characterCount: 50 },
    exportedAt: "2026-05-28T00:00:00.000Z",
  }
  const buf = await generateEpub(data)
  const zip = await JSZip.loadAsync(buf)
  const html = await zip.file("OEBPS/chapter-1.xhtml").async("string")
  assert.ok(html.includes("<em>Artificial Intelligence</em>"), "italic rendered")
  assert.ok(html.includes("<em>Machine Learning</em>"), "second italic rendered")
  assert.ok(html.includes("<strong>BREAKING</strong>"), "bold rendered")
  assert.ok(html.includes("<code>code/path.md</code>"), "code rendered")
  // Raw asterisks must not survive
  assert.ok(!html.includes("*Artificial Intelligence*"))
})

test("generateEpub leaves incomplete trailing markers as literal text", async () => {
  const data = {
    storyId: "s_partial",
    title: "T",
    brief: "",
    locale: "en",
    chapters: [
      { turn: 1, action: "", paragraphs: ["She muttered *Artif"] }, // streaming
    ],
    stats: { turnCount: 1, paragraphCount: 1, characterCount: 18 },
    exportedAt: "2026-05-28T00:00:00.000Z",
  }
  const buf = await generateEpub(data)
  const zip = await JSZip.loadAsync(buf)
  const html = await zip.file("OEBPS/chapter-1.xhtml").async("string")
  assert.ok(html.includes("*Artif"), "incomplete italic stays literal")
  assert.ok(!html.includes("<em>"), "no <em> emitted for unclosed marker")
})

test("generateEpub produces a valid EPUB zip with mimetype + content.opf", async () => {
  const data = {
    storyId: "s_b",
    title: "测试书",
    brief: "原始构想行。",
    locale: "zh",
    chapters: [
      { turn: 1, action: "醒来", paragraphs: ["晨光透过窗。"] },
      { turn: 2, action: "起身", paragraphs: ["她伸了个懒腰。"] },
    ],
    stats: { turnCount: 2, paragraphCount: 2, characterCount: 12 },
    exportedAt: "2026-05-28T00:00:00.000Z",
  }
  const buf = await generateEpub(data)
  assert.ok(Buffer.isBuffer(buf))
  assert.ok(buf.length > 200, "epub should not be empty")
  // EPUB-spec: the file must begin with the local-header signature for an
  // entry whose filename is exactly "mimetype" and whose body is
  // "application/epub+zip", stored uncompressed.
  const zip = await JSZip.loadAsync(buf)
  const mimetype = await zip.file("mimetype").async("string")
  assert.equal(mimetype, "application/epub+zip")
  assert.ok(zip.file("META-INF/container.xml"), "container.xml must exist")
  assert.ok(zip.file("OEBPS/content.opf"), "content.opf must exist")
  assert.ok(zip.file("OEBPS/toc.xhtml"), "toc.xhtml must exist")
  assert.ok(zip.file("OEBPS/chapter-1.xhtml"), "chapter file must exist")
  assert.ok(zip.file("OEBPS/brief.xhtml"), "brief preface must exist when brief is set")
  const opf = await zip.file("OEBPS/content.opf").async("string")
  assert.ok(opf.includes("<dc:title>测试书</dc:title>"))
  assert.ok(opf.includes("<dc:language>zh-CN</dc:language>"))
})
