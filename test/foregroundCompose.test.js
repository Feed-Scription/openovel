import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import {
  composeFromTemplate,
  detectRichRenderingWarnings,
  detectUnusedRichRenderingGap,
  loadForegroundGuidance,
  parseForegroundGuidance,
  validateForegroundTemplate,
  writeForegroundGuidance,
  migrateLegacyForegroundIfNeeded,
  FOREGROUND_SECTIONS,
} from "../src/lib/foregroundCompose.js"

async function newWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "openovel-fg-"))
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  process.env.OPENOVEL_HOME = path.join(root, "home")
  await initializeStory()
  return root
}

test("parseForegroundGuidance splits a unified FG.md into constants and sections", () => {
  const text = [
    "# Foreground Guidance",
    "",
    "Intro advisory paragraph.",
    "",
    "## Scene",
    "",
    "campus / library / afternoon",
    "",
    "## Tone",
    "",
    "matter-of-fact",
    "",
    "## Constants",
    "",
    "- protagonist promised X to Y at turn 6",
    "",
    "## Open Threads",
    "",
    "- who left the note?",
  ].join("\n")
  const sections = parseForegroundGuidance(text)
  assert.match(sections.header, /Intro advisory paragraph/)
  assert.equal(sections.scene.trim(), "campus / library / afternoon")
  assert.equal(sections.tone.trim(), "matter-of-fact")
  assert.match(sections.constants, /promised X to Y at turn 6/)
  assert.match(sections["open-threads"], /who left the note/)
  assert.equal(sections.forbidden, "")
})

test("legacy Must Keep heading parses into constants", () => {
  const sections = parseForegroundGuidance("# Foreground Guidance\n\n## Must Keep\n\n- legacy fact\n")
  assert.equal(sections.constants.trim(), "- legacy fact")
  assert.equal(sections["must-keep"].trim(), "- legacy fact")
})

test("Active Pressures section parses and round-trips", () => {
  const text = [
    "# Foreground Guidance",
    "",
    "## Constants",
    "",
    "- protagonist owes Y 1000 yuan since turn 6",
    "",
    "## Active Pressures",
    "",
    "1. [URGENT] deadline tomorrow 6pm — 28h left",
    "2. [HIGH] missed 3pm interview with Zhang Kechang",
    "3. [SHADOW] Y debt — unspoken",
  ].join("\n")
  const sections = parseForegroundGuidance(text)
  assert.match(sections["active-pressures"], /URGENT.*deadline/i)
  assert.match(sections["active-pressures"], /Zhang Kechang/)
  assert.match(sections["active-pressures"], /SHADOW.*Y debt/i)
})

test("writeForegroundGuidance writes per-section files + composed FG.md", async () => {
  await newWorkspace()
  const sections = {
    header: "Intro line.",
    scene: "campus / library",
    tone: "matter-of-fact",
    constants: "- promise at turn 6",
    "open-threads": "- mystery note",
    forbidden: "- no telepathy",
  }
  const result = await writeForegroundGuidance({ sections, turnId: "turn_test_1" })
  assert.ok(result.written.length >= 6, "should write each non-empty section")

  // Check one section file
  const sceneFile = path.join(paths.foregroundDir, "scene.md")
  const sceneContent = await readFile(sceneFile, "utf8")
  assert.match(sceneContent, /^---/)
  assert.match(sceneContent, /section: scene/)
  assert.match(sceneContent, /updatedTurn: turn_test_1/)
  assert.match(sceneContent, /campus \/ library/)

  // Composed FG.md
  const composed = await readFile(paths.foregroundGuidance, "utf8")
  assert.match(composed, /## Scene/)
  assert.match(composed, /campus \/ library/)
  assert.match(composed, /## Tone/)
  assert.match(composed, /## Constants/)
  assert.match(composed, /## Forbidden \/ Avoid/)
})

test("composeFromTemplate round-trips through parseForegroundGuidance", async () => {
  await newWorkspace()
  const sections = {
    header: "",
    scene: "气闸 D-05",
    tone: "克制",
    "active-characters": "- 主角: 情报员\n- 林同: 怀疑者",
    constants: "- 主角承诺过不暴露身份",
    "open-threads": "- 顾医师为何转院",
    forbidden: "",
  }
  await writeForegroundGuidance({ sections, turnId: "turn_round_trip" })
  const composed = await composeFromTemplate()
  const reparsed = parseForegroundGuidance(composed)
  assert.equal(reparsed.scene.trim(), sections.scene)
  assert.equal(reparsed.tone.trim(), sections.tone)
  assert.equal(reparsed.constants.trim(), sections.constants)
})

test("loadForegroundGuidance reads template + section files", async () => {
  await newWorkspace()
  // After initializeStory the template manifest + seed sections exist,
  // so the composed read returns the canonical # Foreground Guidance.
  const initial = await loadForegroundGuidance()
  assert.match(initial, /Foreground Guidance/)

  // After writing more sections, the composed view reflects them.
  await writeForegroundGuidance({
    sections: { scene: "气闸 D-05 仓储隔间" },
    turnId: "turn_dir_priority",
  })
  const composed = await loadForegroundGuidance()
  assert.match(composed, /气闸 D-05 仓储隔间/)
  assert.match(composed, /## Scene/)
})

test("pending-consequence composes when written and stays absent when empty (P4)", async () => {
  await newWorkspace()
  // The default template (init) already @includes pending-consequence, and the
  // empty stub composes to nothing — no naked heading on a normal turn.
  const empty = await loadForegroundGuidance()
  assert.equal(empty.includes("## Pending Consequence"), false, "empty stub composes to nothing")

  // Showrunner authors a consequence → it appears under its heading next turn.
  await writeForegroundGuidance({
    sections: { "pending-consequence": "守卫已被惊动，下一拍必须直面追兵。" },
    turnId: "turn_pc",
  })
  const withPc = await loadForegroundGuidance()
  assert.match(withPc, /## Pending Consequence/)
  assert.match(withPc, /守卫已被惊动/)

  // Cleared (empty) → heading vanishes again (no dangling section).
  await writeForegroundGuidance({ sections: { "pending-consequence": "" }, turnId: "turn_pc2" })
  const cleared = await loadForegroundGuidance()
  assert.equal(cleared.includes("## Pending Consequence"), false, "cleared consequence composes to nothing")
})

test("default template manifest includes pending-consequence in the volatile tail (P4)", async () => {
  await newWorkspace()
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.match(tpl, /@include story\/frontend\/pending-consequence\.md/)
  // It renders in the volatile tail, before the card manifests.
  assert.ok(
    tpl.indexOf("pending-consequence.md") < tpl.indexOf("story/guidance/cards.md"),
    "pending-consequence precedes the card manifests",
  )
})

test("directed-beat composes as '## This Turn' when written and stays absent when empty (directed-beat)", async () => {
  await newWorkspace()
  // Default template @includes directed-beat, but the empty stub composes to
  // nothing — no naked heading on a normal turn.
  const empty = await loadForegroundGuidance()
  assert.equal(empty.includes("## This Turn"), false, "empty directed-beat stub composes to nothing")

  // Showrunner authors a world event → composed under the in-world "## This Turn".
  await writeForegroundGuidance({
    sections: { "directed-beat": "洁依在不寝王子的鸟居旁停下整理背包，抬头与走近的两人对上视线。" },
    turnId: "turn_db",
  })
  const withDb = await loadForegroundGuidance()
  assert.match(withDb, /## This Turn/)
  assert.match(withDb, /洁依在不寝王子/)
  // The internal id never leaks an authorial/screenwriting heading to the narrator.
  assert.equal(withDb.includes("## Directed Beat"), false, "narrator sees the in-world heading, not the machinery name")

  // Cleared (empty) → heading vanishes again.
  await writeForegroundGuidance({ sections: { "directed-beat": "" }, turnId: "turn_db2" })
  const cleared = await loadForegroundGuidance()
  assert.equal(cleared.includes("## This Turn"), false, "cleared directed-beat composes to nothing")
})

test("default template includes directed-beat, rendered before pending-consequence (directed-beat)", async () => {
  await newWorkspace()
  const tpl = await readFile(paths.foregroundTemplate, "utf8")
  assert.match(tpl, /@include story\/frontend\/directed-beat\.md/)
  // Volatile-tail ordering: world acts THIS turn (directed-beat) before honoring
  // LAST turn's choice (pending-consequence), both before the card manifests.
  assert.ok(
    tpl.indexOf("directed-beat.md") < tpl.indexOf("pending-consequence.md"),
    "directed-beat precedes pending-consequence",
  )
  assert.ok(
    tpl.indexOf("pending-consequence.md") < tpl.indexOf("story/guidance/cards.md"),
    "pending-consequence precedes the card manifests",
  )
})

test("template validation ignores @include examples inside schema comments", async () => {
  await newWorkspace()
  const content = [
    "<!--",
    "  @include path/to/file.md",
    "-->",
    "# Foreground Guidance",
    "",
    "@include story/frontend/header.md",
  ].join("\n")
  const result = await validateForegroundTemplate(content)
  assert.equal(result.issues.length, 0)
  assert.deepEqual(result.includes.map((item) => item.path), ["story/frontend/header.md"])
})

test("section schema is stable and ordered for cache-friendliness", () => {
  // Filenames are unprefixed (<id>.md); render order comes from array position.
  const filenames = FOREGROUND_SECTIONS.map((s) => s.filename).sort()
  const expected = [...FOREGROUND_SECTIONS.map((s) => s.filename)].sort()
  assert.deepEqual(filenames, expected)
  // Each section has a stable id
  const ids = new Set(FOREGROUND_SECTIONS.map((s) => s.id))
  assert.ok(ids.has("scene"))
  assert.ok(ids.has("tone"))
  assert.ok(ids.has("constants"))
  assert.ok(ids.has("open-threads"))
  assert.ok(ids.has("forbidden"))
})

test("composed output orders sections stable-first → volatile-last", async () => {
  // The volatile tail (Active Pressures et al.) must appear AFTER stable sections
  // so the cacheable prefix stays valid when only the volatile tail changes
  // between turns. This is what the FOREGROUND_SECTIONS array order declares;
  // verify compose honors it instead of falling back to filename-alphabetical.
  await newWorkspace()
  await writeForegroundGuidance({
    sections: {
      header: "Header line.",
      tone: "matter-of-fact",
      forbidden: "- no telepathy",
      constants: "- promise at turn 6",
      "active-characters": "- Alice: investigator",
      scene: "campus",
      "open-threads": "- who left the note",
      "active-pressures": "- [URGENT] meet the contact by noon",
    },
    turnId: "turn_cache_order",
  })
  const composed = await composeFromTemplate()
  // Index of each section's heading in the composed text
  const idx = (heading) => composed.indexOf(`## ${heading}`)
  const tone = idx("Tone")
  const constants = idx("Constants")
  const active = idx("Active Characters")
  const scene = idx("Scene")
  const pressures = idx("Active Pressures")
  // Stable-first invariant: tone < constants < active-chars < scene < active-pressures
  assert.ok(tone > 0 && tone < constants, `Tone (${tone}) should precede Constants (${constants})`)
  assert.ok(constants < active, `Constants (${constants}) should precede Active Characters (${active})`)
  assert.ok(active < scene, `Active Characters (${active}) should precede Scene (${scene})`)
  assert.ok(scene < pressures, `Scene (${scene}) should precede Active Pressures (${pressures})`)
})

// Regression: rich-rendering.md is `optional`, so the default FG_template never
// lists it. If a pipeline fills the file without adding an @include line, the
// narrator silently misses the rich-render protocol. composeFromTemplate now
// appends a non-placeholder rich-rendering.md when the template omits it.
test("compose auto-appends a filled rich-rendering.md missing from the template", async () => {
  const { writeFile } = await import("node:fs/promises")
  await newWorkspace()
  const richFile = path.join(paths.foregroundDir, "rich-rendering.md")

  // 1. Placeholder body → NOT appended (plain-prose stories stay clean).
  await writeFile(richFile, [
    "---", "section: rich-rendering", "---", "",
    "## Rich Rendering", "",
    "_(placeholder — init agent or storykeeper rewrites this section)_",
  ].join("\n"))
  let composed = await composeFromTemplate()
  assert.ok(!composed.includes("## Rich Rendering"), "placeholder body must not compose")

  // 2. Real content, template has no @include → appended to the composed view.
  await writeFile(richFile, [
    "---", "section: rich-rendering", "---", "",
    "## Rich Rendering", "",
    "当正文抵达纪伊田边巴士换乘时，在段落之间单独发出：", "",
    "```ovl:bg", "set: story/includes/bg/kii_tanabe_winter_bus_stop.jpg", "```",
  ].join("\n"))
  composed = await composeFromTemplate()
  assert.match(composed, /## Rich Rendering/)
  assert.match(composed, /ovl:bg/)
  assert.match(composed, /kii_tanabe_winter_bus_stop\.jpg/)

  // 3. Template DOES reference it → composed in place, never duplicated.
  const template = await readFile(paths.foregroundTemplate, "utf8")
  await writeFile(paths.foregroundTemplate, `${template.trimEnd()}\n@include story/frontend/rich-rendering.md\n`)
  composed = await composeFromTemplate()
  const occurrences = composed.split("## Rich Rendering").length - 1
  assert.equal(occurrences, 1, "the section composes exactly once when the @include exists")
})

test("plain-blocks mode warns custom rich-rendering guidance without requiring stale block coverage", async () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  const savedMusic = process.env.OPENOVEL_ENABLE_MUSIC_GEN
  try {
    process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
    delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
    await newWorkspace()
    await mkdir(path.join(paths.formatDir, "blocks"), { recursive: true })
    await writeFile(path.join(paths.formatDir, "blocks", "status-card.html"), "<div>{{body}}</div>", "utf8")

    await writeFile(
      path.join(paths.foregroundDir, "rich-rendering.md"),
      [
        "---",
        "section: rich-rendering",
        "---",
        "",
        "## Rich Rendering",
        "",
        "Keep the HUD current with `ovl:hud`.",
        "Old cue guidance says to emit `ovl:music` when the room quiets.",
        "```ovl:music",
        "bgm: quiet-room",
        "```",
        "When the dossier appears, emit ```ovl:status-card```.",
        "```ovl:status-card",
        "body: dossier",
        "```",
      ].join("\n"),
      "utf8",
    )

    const warnings = await detectRichRenderingWarnings()
    assert.ok(warnings.some((w) => /plain-blocks mode/.test(w) && /ovl:status-card/.test(w)))
    assert.ok(warnings.some((w) => /plain-blocks mode/.test(w) && /ovl:music/.test(w)))
    assert.ok(!warnings.some((w) => /never mentioned as `ovl:status-card`/.test(w)))

    await writeFile(paths.foregroundTemplate, "@include story/frontend/rich-rendering.md\n", "utf8")
    const composed = await composeFromTemplate()
    assert.match(composed, /ovl:hud/)
    assert.doesNotMatch(composed, /ovl:music/)
    assert.doesNotMatch(composed, /quiet-room/)
    assert.doesNotMatch(composed, /ovl:status-card/)
    assert.doesNotMatch(composed, /dossier appears/)
    assert.doesNotMatch(composed, /body: dossier/)

    await writeFile(
      path.join(paths.foregroundDir, "rich-rendering.md"),
      [
        "---",
        "section: rich-rendering",
        "---",
        "",
        "## Rich Rendering",
        "",
      ].join("\n"),
      "utf8",
    )
    const gap = await detectUnusedRichRenderingGap()
    assert.equal(gap.gap, false, "stale custom block files alone should not force rich-rendering.md in plain-blocks mode")
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
    if (savedMusic === undefined) delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
    else process.env.OPENOVEL_ENABLE_MUSIC_GEN = savedMusic
  }
})
