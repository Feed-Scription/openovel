import test from "node:test"
import assert from "node:assert/strict"
import {
  parsePanelScript,
  deriveProseFromScript,
  injectPanelImagePaths,
  comicPanelRelPath,
  panelImagePathIssue,
  resolveComicPanelStatus,
  visibleComicPanelCount,
  parseCharacterSheetIndex,
  matchCharacterSheets,
  COMIC_IMAGE_PREFIX,
} from "../src/lib/comicScript.js"
import { comicScriptOutputContract, foregroundNarratorContract } from "../src/prompts/agentContracts.js"
import { buildNarratorMessages } from "../src/lib/narrator.js"

const SCRIPT = [
  "```ovl:panel",
  "prompt: a quiet alley at dusk, ink-wash register, medium shot",
  "caption: 巷子尽头的灯一盏盏亮起来。",
  "```",
  "```ovl:panel",
  "prompt: close on a hand pushing a wooden door",
  "多行提示词的第二行",
  "caption: 她推开了那扇门。",
  "```",
  "```ovl:synopsis",
  "主角在黄昏进入小巷，推开木门。",
  "```",
].join("\n")

test("parsePanelScript: panels + synopsis + multi-line fields", () => {
  const { panels, synopsis, isComic } = parsePanelScript(SCRIPT)
  assert.equal(isComic, true)
  assert.equal(panels.length, 2)
  assert.equal(panels[0].caption, "巷子尽头的灯一盏盏亮起来。")
  assert.match(panels[1].prompt, /close on a hand/)
  assert.match(panels[1].prompt, /多行提示词的第二行/)
  assert.equal(synopsis, "主角在黄昏进入小巷，推开木门。")
  // No image lines yet (the runtime injects them): flagged, not thrown.
  assert.equal(panels[0].image, "")
  assert.ok(panels[0].imageIssue)
})

test("parsePanelScript: trailing open fence streams as a partial panel", () => {
  const partial = SCRIPT + "\n```ovl:panel\nprompt: wide shot of the courtyard\ncaption: 院子里"
  const { panels } = parsePanelScript(partial)
  assert.equal(panels.length, 3)
  assert.equal(panels[2].open, true)
  assert.equal(panels[2].caption, "院子里")
})

test("parsePanelScript: prose without panel fences is not comic", () => {
  const { isComic, panels } = parsePanelScript("她推开了那扇门。\n\n灯亮了。")
  assert.equal(isComic, false)
  assert.equal(panels.length, 0)
})

test("injectPanelImagePaths: deterministic paths, idempotent, validation passes", () => {
  const injected = injectPanelImagePaths(SCRIPT, "turn_42_abc")
  const { panels } = parsePanelScript(injected)
  assert.equal(panels[0].image, comicPanelRelPath("turn_42_abc", 0))
  assert.equal(panels[1].image, comicPanelRelPath("turn_42_abc", 1))
  assert.equal(panels[0].imageIssue, "")
  assert.ok(panels[0].image.startsWith(COMIC_IMAGE_PREFIX))
  // Idempotent: re-injecting replaces rather than duplicates the image line.
  const twice = injectPanelImagePaths(injected, "turn_42_abc")
  assert.equal(twice, injected)
})

test("panelImagePathIssue: refuses escapes and non-comic include paths", () => {
  assert.equal(panelImagePathIssue(comicPanelRelPath("t", 0)), "")
  assert.ok(panelImagePathIssue("story/includes/cover.png"))
  assert.ok(panelImagePathIssue("story/includes/comic/../cover.png"))
  assert.ok(panelImagePathIssue("/etc/passwd"))
  assert.ok(panelImagePathIssue("story/includes/comic/t/p1.svg"))
})

test("deriveProseFromScript: captions + synopsis, no prompts, no fences", () => {
  const prose = deriveProseFromScript(SCRIPT)
  assert.match(prose, /巷子尽头的灯一盏盏亮起来。/)
  assert.match(prose, /她推开了那扇门。/)
  assert.match(prose, /主角在黄昏进入小巷/)
  assert.ok(!prose.includes("```"))
  assert.ok(!prose.includes("ink-wash"))
  // Non-comic text derives to empty (caller falls back to the raw narration).
  assert.equal(deriveProseFromScript("普通散文。"), "")
})

test("sequential reveal: panel K+1 waits for panel K to resolve", () => {
  const { panels } = parsePanelScript(injectPanelImagePaths(SCRIPT, "turn_7"))
  const rel0 = comicPanelRelPath("turn_7", 0)
  // Live turn, nothing resolved yet → only panel 1 visible.
  assert.equal(visibleComicPanelCount(panels, { byRel: { [rel0]: "pending" } }, { gated: true }), 1)
  // Panel 1 ready → panel 2 unlocks.
  assert.equal(visibleComicPanelCount(panels, { byRel: { [rel0]: "ready" } }, { gated: true }), 2)
  // A failed panel resolves too (degrade, never block the story).
  assert.equal(visibleComicPanelCount(panels, { byRel: { [rel0]: "failed" } }, { gated: true }), 2)
  // Replay (ungated) shows everything.
  assert.equal(visibleComicPanelCount(panels, {}, { gated: false }), 2)
})

test("resolveComicPanelStatus: byIndex serves the pre-injection stream; ready wins", () => {
  const { panels } = parsePanelScript(SCRIPT) // no image paths yet
  assert.equal(resolveComicPanelStatus(panels[0], { byIndex: { 0: "pending" } }), "pending")
  assert.equal(resolveComicPanelStatus(panels[0], { byIndex: { 0: "ready" } }), "ready")
  assert.equal(resolveComicPanelStatus(panels[0], {}), undefined)
  const injected = parsePanelScript(injectPanelImagePaths(SCRIPT, "t")).panels
  const rel = comicPanelRelPath("t", 0)
  // byRel wins when both present, except ready never downgrades.
  assert.equal(resolveComicPanelStatus(injected[0], { byRel: { [rel]: "pending" }, byIndex: { 0: "ready" } }), "ready")
  assert.equal(resolveComicPanelStatus(injected[0], { byRel: { [rel]: "failed" }, byIndex: { 0: "pending" } }), "failed")
})

test("panel ext follows the provider output format (jpeg providers get .jpg paths)", () => {
  assert.equal(comicPanelRelPath("t", 0), `${COMIC_IMAGE_PREFIX}t/p1.png`)
  assert.equal(comicPanelRelPath("t", 0, "jpeg"), `${COMIC_IMAGE_PREFIX}t/p1.jpg`)
  assert.equal(panelImagePathIssue(comicPanelRelPath("t", 0, "jpeg")), "")
  const injected = injectPanelImagePaths(SCRIPT, "t", { ext: "jpeg" })
  const { panels } = parsePanelScript(injected)
  assert.equal(panels[0].image, `${COMIC_IMAGE_PREFIX}t/p1.jpg`)
  assert.equal(panels[0].imageIssue, "")
})

test("imageRequestBody carries reference images per provider shape", async () => {
  const { imageRequestBody, IMAGE_PROVIDER_PRESETS, expectedImageKind } = await import("../src/provider/imageGeneration.js")
  const refs = [{ mediaType: "image/png", base64: "QUJD" }]
  const volc = imageRequestBody(
    { ...IMAGE_PROVIDER_PRESETS.volcengine, watermark: false },
    { prompt: "p", size: "2K", referenceImages: refs },
  )
  assert.equal(volc.image, "data:image/png;base64,QUJD")
  const volcMulti = imageRequestBody(
    { ...IMAGE_PROVIDER_PRESETS.volcengine, watermark: false },
    { prompt: "p", referenceImages: [...refs, ...refs] },
  )
  assert.equal(volcMulti.image.length, 2)
  const router = imageRequestBody(IMAGE_PROVIDER_PRESETS.openrouter, { prompt: "p", referenceImages: refs })
  assert.equal(router.messages[0].content.length, 2)
  assert.equal(router.messages[0].content[1].type, "image_url")
  // Plain OpenAI images shape has no reference slot.
  const plain = imageRequestBody(IMAGE_PROVIDER_PRESETS.custom, { prompt: "p", referenceImages: refs })
  assert.ok(!("image" in plain))
  // volcengine emits jpeg; others default png.
  assert.equal(expectedImageKind({ OPENOVEL_IMAGE_PROVIDER: "volcengine" }), "jpeg")
  assert.equal(expectedImageKind({ OPENOVEL_IMAGE_PROVIDER: "openrouter" }), "png")
})

test("panel characters field parses to a name list; absent field stays empty", () => {
  const script = [
    "```ovl:panel",
    "prompt: two figures by the door, ink-wash register",
    "characters: 周岁安、林晚",
    "caption: 两人在门口停住。",
    "```",
    "```ovl:panel",
    "prompt: an empty courtyard at dusk",
    "caption: 院子里没有人。",
    "```",
  ].join("\n")
  const { panels } = parsePanelScript(script)
  assert.deepEqual(panels[0].characters, ["周岁安", "林晚"])
  assert.deepEqual(panels[1].characters, [])
})

test("parseCharacterSheetIndex + matchCharacterSheets map names to sheet paths", () => {
  const md = [
    "# Character Visual Specs",
    "",
    "## 周岁安",
    "短发，灰呢大衣，眉骨有一道旧疤。",
    "sheet: story/includes/characters/zhou-suian-sheet.png",
    "",
    "**林晚**：长发束起，藏青色斗篷。",
    "参考图：story/includes/characters/lin-wan-sheet.jpg",
    "",
    "## 备注",
    "其余路人不入设定。",
  ].join("\n")
  const entries = parseCharacterSheetIndex(md)
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.sheet]))
  assert.equal(byName["周岁安"], "story/includes/characters/zhou-suian-sheet.png")
  assert.equal(byName["林晚：长发束起，藏青色斗篷。"] ?? byName["林晚"], "story/includes/characters/lin-wan-sheet.jpg")
  // Containment matching: a short form finds the full entry; unknown names surface.
  const { sheets, unmatched } = matchCharacterSheets(["岁安", "陌生人"], entries, { cap: 5 })
  assert.deepEqual(sheets, ["story/includes/characters/zhou-suian-sheet.png"])
  assert.deepEqual(unmatched, ["陌生人"])
  // The file title heading carries no sheet and matches nothing harmful.
  const none = matchCharacterSheets([], entries, { cap: 5 })
  assert.deepEqual(none.sheets, [])
})

test("normalizePixelSize scales WxH into the provider window, preserving aspect", async () => {
  const { normalizePixelSize, imageRequestBody, IMAGE_PROVIDER_PRESETS } = await import("../src/provider/imageGeneration.js")
  const parse = (s) => s.split("x").map(Number)
  // Below the floor → scaled up proportionally to at least 2560x1440 pixels.
  const up = parse(normalizePixelSize("1024x1024"))
  assert.ok(up[0] * up[1] >= 2560 * 1440)
  assert.ok(Math.abs(up[0] / up[1] - 1) < 0.02) // aspect preserved
  assert.equal(up[0] % 8, 0)
  // Tall portrait keeps its ratio.
  const tall = parse(normalizePixelSize("832x1248"))
  assert.ok(tall[0] * tall[1] >= 2560 * 1440)
  assert.ok(Math.abs(tall[0] / tall[1] - 832 / 1248) < 0.02)
  // Above the ceiling → scaled down under 4096x4096 pixels.
  const down = parse(normalizePixelSize("8000x8000"))
  assert.ok(down[0] * down[1] <= 4096 * 4096)
  // In-window and named values pass through.
  assert.equal(normalizePixelSize("2048x2048"), "2048x2048")
  assert.equal(normalizePixelSize("2K"), "2K")
  // The volcengine request body carries the normalized size.
  const body = imageRequestBody({ ...IMAGE_PROVIDER_PRESETS.volcengine, watermark: false }, { prompt: "p", size: "1024x1024" })
  const sized = parse(body.size)
  assert.ok(sized[0] * sized[1] >= 2560 * 1440)
})

test("comic narrator messages swap role + output contract", () => {
  const comic = buildNarratorMessages({ action: "推门", compiledContext: {}, comicMode: true })
  const prose = buildNarratorMessages({ action: "推门", compiledContext: {} })
  assert.match(comic[0].content, /picture-story/)
  assert.match(comic[0].content, /ovl:panel/)
  assert.match(comic[0].content, /ovl:synopsis/)
  assert.ok(!prose[0].content.includes("ovl:panel"))
  // Comic contract keeps the no-choice-menu rule and drops the prose demand.
  assert.match(foregroundNarratorContract({ comic: true }), /panel script/)
  assert.match(foregroundNarratorContract({ comic: true }), /choice menu/)
  assert.match(comicScriptOutputContract(), /1 to 4/)
})
