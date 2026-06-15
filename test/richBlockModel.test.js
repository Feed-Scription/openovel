import test from "node:test"
import assert from "node:assert/strict"

import {
  parseFence,
  parseHudFromText,
  mergedHudPairsFromEntries,
  fillSlots,
  stripHudFencesFromText,
  stripBgFencesFromText,
  parseBackgroundFromText,
  latestBackgroundFromEntries,
  parseMusicCueFromText,
} from "../src/electron/renderer/lib/richBlockModel.js"

test("fillSlots: {{body}}/{{raw}} → whole fence body (body-mode block)", () => {
  const parsed = parseFence("$ ls\nfile.txt", "raw")
  assert.equal(fillSlots("output: {{body}}", parsed), "output: $ ls\nfile.txt")
  assert.equal(fillSlots("{{raw}}", parsed), "$ ls\nfile.txt")
})

test("fillSlots: in a keyvalue block {{body}} fills from the body: line, never the raw dump", () => {
  // The chat-slip shape: named slots + a {{body}} message slot. The narrator
  // addresses every slot as a key:value line; {{body}} must take its pair's
  // value (returning the whole raw here leaked `sender:`/`time:` keys into
  // the rendered message).
  const parsed = parseFence("sender: 老陈\ntime: 出发前\nbody: 巴士少，现金带一点。", "keyvalue")
  assert.equal(fillSlots("{{sender}}", parsed), "老陈")
  assert.equal(fillSlots("{{body}}", parsed), "巴士少，现金带一点。")
  // A keyvalue parse without a body: line renders empty, like any absent slot.
  const noBody = parseFence("sender: 老陈", "keyvalue")
  assert.equal(fillSlots("[{{body}}]", noBody), "[]")
})

test("fillSlots: {{Key}} → that keyvalue pair value, missing → empty", () => {
  const parsed = parseFence("HP: 42\nName: Zhu", "keyvalue")
  assert.equal(fillSlots("HP {{HP}} / {{Name}}", parsed), "HP 42 / Zhu")
  assert.equal(fillSlots("[{{Missing}}]", parsed), "[]")
})

test("fillSlots: CJK keys and whitespace inside braces resolve; non-slot text untouched", () => {
  const parsed = parseFence("根绳: 第二扣更紧", "keyvalue")
  assert.equal(fillSlots("{{ 根绳 }}", parsed), "第二扣更紧")
  assert.equal(fillSlots("no placeholders here", parsed), "no placeholders here")
})

test("fillSlots: total over partial/garbage input, never throws", () => {
  assert.doesNotThrow(() => fillSlots("{{HP}}", parseFence("HP:", "keyvalue")))
  assert.equal(fillSlots("{{HP}}", parseFence("HP:", "keyvalue")), "")
  assert.equal(fillSlots(null, parseFence("", "raw")), "")
  assert.equal(fillSlots("{{body}}", { raw: undefined, pairs: null }), "")
})

test("parseFence raw mode returns full text, no pairs", () => {
  const p = parseFence("$ ls\nfile.txt", "raw")
  assert.equal(p.raw, "$ ls\nfile.txt")
  assert.deepEqual(p.pairs, [])
})

test("parseFence keyvalue splits pairs, ignores incomplete trailing line", () => {
  const p = parseFence("HP: 42\nLocation: 苏州\nIncomplete", "keyvalue")
  assert.deepEqual(p.pairs, [["HP", "42"], ["Location", "苏州"]])
})

test("parseFence never throws on empty/partial/garbage", () => {
  assert.doesNotThrow(() => parseFence("", "keyvalue"))
  assert.doesNotThrow(() => parseFence("HP:", "keyvalue"))
  assert.doesNotThrow(() => parseFence(null, "raw"))
  assert.deepEqual(parseFence("HP:", "keyvalue").pairs, [["HP", ""]])
})

test("parseHudFromText: fences merge per key, later value wins; null when none", () => {
  assert.equal(parseHudFromText("just prose, no hud"), null)
  const text = "他出门了。\n\n```ovl:hud\nhp: 50\ntime: 黄昏\n```\n\n后来受伤。\n\n```ovl:hud\nhp: 30\nloc: 城外\n```\n"
  // hp updated by the later fence, time kept from the earlier one
  assert.deepEqual(parseHudFromText(text), [["hp", "30"], ["time", "黄昏"], ["loc", "城外"]])
})

test("parseHudFromText: accepts equals syntax from plain-blocks saves", () => {
  const text = [
    "```ovl:hud",
    "时间/地点=1999 · 深圳 · 小软件公司办公室",
    "Codex 额度=离线可用 · 重型调用 3/24h",
    "```",
  ].join("\n")
  assert.deepEqual(parseHudFromText(text), [
    ["时间/地点", "1999 · 深圳 · 小软件公司办公室"],
    ["Codex 额度", "离线可用 · 重型调用 3/24h"],
  ])
})

test("parseHudFromText: tolerates partial trailing fence (streaming)", () => {
  assert.doesNotThrow(() => parseHudFromText("```ovl:hud\nhp: 4"))
  // unterminated block isn't matched → null (HUD keeps previous values)
  assert.equal(parseHudFromText("```ovl:hud\nhp: 4"), null)
})

test("stripHudFencesFromText: hides reserved HUD channel from narration", () => {
  const text = "他继续走。\n\n```ovl:hud\nlocation: 山路\ntime: 上午\n```\n\n风从杉林里过来。"
  assert.equal(stripHudFencesFromText(text), "他继续走。\n\n风从杉林里过来。")
})

test("stripHudFencesFromText: hides trailing partial HUD fence while streaming", () => {
  const text = "他继续走。\n\n```ovl:hud\nlocation: 山路"
  assert.equal(stripHudFencesFromText(text), "他继续走。\n\n")
})

test("mergedHudPairsFromEntries: recovers persistent HUD from earlier narration", () => {
  const entries = [
    { type: "narration", text: "旧状态\n```ovl:hud\nlocation: 车站\n```" },
    { type: "user", text: "继续" },
    { type: "narration", text: "这一回合没有 HUD，应该沿用旧值。" },
  ]
  assert.deepEqual(mergedHudPairsFromEntries(entries), [["location", "车站"]])
})

test("mergedHudPairsFromEntries: newest value per key wins across replayed transcript", () => {
  const entries = [
    { type: "narration", text: "```ovl:hud\nlocation: 车站\n```" },
    { type: "narration", text: "```ovl:hud\nlocation: 山路\ncompanion: 一飞\n```" },
  ]
  assert.deepEqual(mergedHudPairsFromEntries(entries), [["location", "山路"], ["companion", "一飞"]])
})

test("mergedHudPairsFromEntries: a fence that omits a key keeps that key's value", () => {
  // The narrator is told to emit only the keys it is updating; an omitted key
  // must not blank its slot.
  const entries = [
    { type: "narration", text: "```ovl:hud\nlocation: 车站\nweather: 小雨\n```" },
    { type: "narration", text: "```ovl:hud\nlocation: 山路\n```" },
  ]
  assert.deepEqual(mergedHudPairsFromEntries(entries), [["location", "山路"], ["weather", "小雨"]])
})

test("mergedHudPairsFromEntries: an explicit empty value clears the key (slot hides)", () => {
  const entries = [
    { type: "narration", text: "```ovl:hud\nlocation: 车站\ntrouble: 丢了车票\n```" },
    { type: "narration", text: "```ovl:hud\ntrouble:\n```" },
  ]
  assert.deepEqual(mergedHudPairsFromEntries(entries), [["location", "车站"], ["trouble", ""]])
})

test("parseBackgroundFromText: set → validated ovl-asset src; latest directive wins", () => {
  const text = "夜色降临。\n\n```ovl:bg\nset: story/includes/bg/dusk.jpg\n```\n\n后来。\n\n```ovl:bg\nset: story/includes/bg/night.png\n```\n"
  assert.deepEqual(parseBackgroundFromText(text), {
    verb: "set",
    rel: "story/includes/bg/night.png",
    src: "ovl-asset://local/story/includes/bg/night.png",
  })
})

test("parseBackgroundFromText: accepts path equals syntax from plain-blocks saves", () => {
  assert.deepEqual(parseBackgroundFromText("```ovl:bg\npath=story/includes/bg/opening-office-1999.jpg\n```"), {
    verb: "set",
    rel: "story/includes/bg/opening-office-1999.jpg",
    src: "ovl-asset://local/story/includes/bg/opening-office-1999.jpg",
  })
})

test("parseBackgroundFromText: bare trusted includes path with no verb reads as set", () => {
  // Observed narrator drift: the fence body carries only the file path, no
  // `set:` verb. A trusted includes image path can only mean one thing.
  assert.deepEqual(parseBackgroundFromText("```ovl:bg\nstory/includes/bg/taiji-inner-court-night.jpg\n```"), {
    verb: "set",
    rel: "story/includes/bg/taiji-inner-court-night.jpg",
    src: "ovl-asset://local/story/includes/bg/taiji-inner-court-night.jpg",
  })
  // a bare line that is NOT a trusted includes image path stays ignored
  assert.equal(parseBackgroundFromText("```ovl:bg\nsome prose line\n```"), null)
  assert.equal(parseBackgroundFromText("```ovl:bg\nstory/canon/x.png\n```"), null)
  assert.equal(parseBackgroundFromText("```ovl:bg\nstory/includes/bg/clip.mp4\n```"), null)
})

test("parseBackgroundFromText: clear (bare or verb form); null when no fence", () => {
  assert.deepEqual(parseBackgroundFromText("```ovl:bg\nclear\n```"), { verb: "clear" })
  assert.deepEqual(parseBackgroundFromText("```ovl:bg\nclear: now\n```"), { verb: "clear" })
  assert.equal(parseBackgroundFromText("just prose"), null)
})

test("parseBackgroundFromText: unsafe path / outside includes / non-image → ignored", () => {
  assert.equal(parseBackgroundFromText("```ovl:bg\nset: ../etc/passwd\n```"), null)
  assert.equal(parseBackgroundFromText("```ovl:bg\nset: story/canon/x.png\n```"), null)
  assert.equal(parseBackgroundFromText("```ovl:bg\nset: story/includes/bg/clip.mp4\n```"), null)
  // an invalid directive does not erase a prior valid one in the same text
  const text = "```ovl:bg\nset: story/includes/bg/a.png\n```\n```ovl:bg\nset: ../x.png\n```"
  assert.equal(parseBackgroundFromText(text).rel, "story/includes/bg/a.png")
})

test("parseBackgroundFromText: tolerates partial trailing fence (streaming)", () => {
  assert.doesNotThrow(() => parseBackgroundFromText("```ovl:bg\nset: story/inc"))
  assert.equal(parseBackgroundFromText("```ovl:bg\nset: story/inc"), null)
})

test("stripBgFencesFromText: hides closed + trailing partial bg fences", () => {
  const text = "他抬头。\n\n```ovl:bg\nset: story/includes/bg/dusk.jpg\n```\n\n山风不停。"
  assert.equal(stripBgFencesFromText(text), "他抬头。\n\n山风不停。")
  assert.equal(stripBgFencesFromText("他抬头。\n\n```ovl:bg\nset: sto"), "他抬头。\n\n")
})

test("latestBackgroundFromEntries: persists across turns without a fence; clear wins later", () => {
  const entries = [
    { type: "narration", text: "```ovl:bg\nset: story/includes/bg/a.png\n```" },
    { type: "user", text: "继续" },
    { type: "narration", text: "这一回合没有背景指令。" },
  ]
  assert.equal(latestBackgroundFromEntries(entries).rel, "story/includes/bg/a.png")
  entries.push({ type: "narration", text: "```ovl:bg\nclear\n```" })
  assert.deepEqual(latestBackgroundFromEntries(entries), { verb: "clear" })
})

test("parseFence keyvalue accepts the fullwidth colon ：(CJK narrators) and fills CJK slots", () => {
  const p = parseFence("界面：深色桌面应用\n模型：5.5\nbattery: 76%", "keyvalue")
  assert.deepEqual(p.pairs, [["界面", "深色桌面应用"], ["模型", "5.5"], ["battery", "76%"]])
  assert.equal(fillSlots("<strong>{{界面}}</strong>", p), "<strong>深色桌面应用</strong>")
  assert.equal(fillSlots("{{model}} / {{battery}}", parseFence("model：5.5\nbattery：76%", "keyvalue")), "5.5 / 76%")
})

test("music/bg directives accept the fullwidth colon too", () => {
  assert.deepEqual(parseMusicCueFromText("```ovl:music\nbgm：tense\n```"), { verb: "bgm", shortId: "tense" })
  assert.equal(parseBackgroundFromText("```ovl:bg\nset：story/includes/bg/x.png\n```").rel, "story/includes/bg/x.png")
})
