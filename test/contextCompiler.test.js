import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { buildForegroundUserContext } from "../src/context/contextCapsule.js"
import { compileForegroundContext, contextBudgetDefaults, formatContextReport, stripVolatileGuidanceLines } from "../src/context/contextCompiler.js"
import { discoverContextCardIndex, discoverContextCards, fastActivateContextCards, writeCardManifest } from "../src/context/foregroundInserts.js"
import { loadForegroundGuidance } from "../src/lib/foregroundCompose.js"
import { addMemoryEntry, removeMemoryEntry } from "../src/memory/memoryStore.js"
import { getStorySnapshot, initializeStory, paths } from "../src/lib/storyStore.js"

test("context compiler reports foreground guidance, memory, and source budgets", async () => {
  process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-context-${Date.now()}`)
  await initializeStory()
  const marker = `likes concise scene options ${Date.now()}`
  await addMemoryEntry("user", marker)

  try {
    const snapshot = await getStorySnapshot()
    const compiled = await compileForegroundContext({
      snapshot,
      action: "inspect context",
      persist: false,
      maxMemoryChars: 10000,
    })

    assert.equal(compiled.foregroundGuidance, stripVolatileGuidanceLines(snapshot.foregroundGuidance))
    assert.match(compiled.foregroundGuidance, /Foreground Guidance/)
    assert.ok(compiled.foregroundMemory.some((block) => block.entries.some((entry) => entry.includes(marker))))
    const prompt = buildForegroundUserContext({ action: "inspect context", compiledContext: compiled })
    assert.ok(prompt.indexOf("## Foreground Guidance") < prompt.indexOf("## Reader Action"))
    assert.doesNotMatch(prompt, /context_budget_report|generatedAt/)

    const reportText = formatContextReport(compiled.report)
    assert.match(reportText, /Context Report/)
    assert.match(reportText, /foreground_guidance story\/guidance\/FOREGROUND\.md/)
    assert.match(reportText, /memory home\/memory\/USER\.md/)
  } finally {
    await removeMemoryEntry("user", marker)
  }
})

test("context compiler reports raw growth, clipping pressure, and env budgets", async () => {
  const root = path.join(os.tmpdir(), `openovel-context-pressure-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  process.env.OPENOVEL_CONTEXT_GUIDANCE_CHARS = "80"
  process.env.OPENOVEL_CONTEXT_RECENT_CANON_CHARS = "90"
  process.env.OPENOVEL_CONTEXT_MEMORY_CHARS = "60"
  await initializeStory()

  await writeFile(paths.foregroundGuidance, `# Foreground Guidance\n\n${"guidance ".repeat(80)}`)
  await writeFile(paths.chapters, `${"canon ".repeat(120)}`)

  try {
    const defaults = contextBudgetDefaults()
    assert.equal(defaults.maxGuidanceChars, 80)
    assert.equal(defaults.recentCanonChars, 90)

    const compiled = await compileForegroundContext({ action: "pressure test", persist: false })
    assert.equal(compiled.foregroundGuidance.length, 80)
    assert.equal(compiled.recentCanonExcerpt.length, 90)
    assert.equal(compiled.report.budgets.foregroundGuidance.rawChars > compiled.report.budgets.foregroundGuidance.usedChars, true)
    assert.equal(compiled.report.pressure.truncatedSources >= 2, true)
    assert.match(compiled.report.pressure.truncatedSourceIds.join(","), /foreground-guidance/)
    assert.match(formatContextReport(compiled.report), /context source/)
  } finally {
    delete process.env.OPENOVEL_CONTEXT_GUIDANCE_CHARS
    delete process.env.OPENOVEL_CONTEXT_RECENT_CANON_CHARS
    delete process.env.OPENOVEL_CONTEXT_MEMORY_CHARS
  }
})

test("a trigger-matched card composes into FOREGROUND.md via @include (cards.auto.md)", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-context-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()

  const cardDir = path.join(paths.contextCards, "new-character")
  await mkdir(cardDir, { recursive: true })
  await writeFile(
    path.join(cardDir, "CARD.md"),
    [
      "---",
      "name: new-character",
      "kind: character",
      "description: 阿衡是火星穹顶维修员",
      "triggers: 阿衡, 维修员, 火星穹顶",
      "---",
      "# 阿衡",
      "",
      "阿衡熟悉穹顶外壳维修，但害怕真空事故。",
    ].join("\n"),
  )

  const snapshot = await getStorySnapshot()
  const activated = await fastActivateContextCards({
    action: "我向阿衡询问火星穹顶裂缝。",
    snapshot,
  })
  assert.equal(activated.activated[0].name, "new-character")

  // The card body is now @included into the composed FOREGROUND.md — there is
  // no separate "Foreground Context Inserts" section any more.
  const composed = await loadForegroundGuidance()
  assert.match(composed, /阿衡熟悉穹顶外壳维修/)
  const auto = await readFile(paths.cardsAuto, "utf8")
  assert.match(auto, /@include story\/context-cards\/new-character\/CARD\.md/)

  const compiled = await compileForegroundContext({ action: "inspect", persist: false })
  const prompt = buildForegroundUserContext({ action: "我继续问阿衡。", compiledContext: compiled })
  assert.doesNotMatch(prompt, /Foreground Context Inserts/)
})

test("a Storykeeper-curated cards.md card is NOT re-added by fast activation (dedup)", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-dedup-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()

  const cardDir = path.join(paths.contextCards, "tide-tower")
  await mkdir(cardDir, { recursive: true })
  await writeFile(
    path.join(cardDir, "CARD.md"),
    "---\nname: tide-tower\nkind: object\ntriggers: 潮汐塔\n---\n# Tide Tower\n\n潮汐塔在夜里发光。\n",
  )

  // Curate it into cards.md (what the Storykeeper would do).
  const cards = await discoverContextCards()
  await writeCardManifest(paths.cardsManifest, cards.filter((c) => c.name === "tide-tower"))

  // A turn that triggers it must NOT duplicate it into cards.auto.md.
  const activated = await fastActivateContextCards({ action: "我望向潮汐塔。" })
  assert.deepEqual(activated.activated.map((c) => c.name), [], "curated card is deduped out of the auto manifest")
  const auto = await readFile(paths.cardsAuto, "utf8")
  assert.doesNotMatch(auto, /tide-tower/)
  // It still reaches the narrator — via cards.md's @include.
  const composed = await loadForegroundGuidance()
  assert.match(composed, /潮汐塔在夜里发光/)
})

test("stripVolatileGuidanceLines removes per-turn timestamps so prompt cache prefix stays stable", () => {
  const withTimestamps = [
    "# Foreground Guidance",
    "",
    "## Current Working Set",
    "",
    "- Scene: 3号穹顶",
    "- Tone: 郭敬明式华丽感伤",
    "",
    "Updated Turn: turn_1779477096308_67c7d146c436a",
    "Updated: 2026-05-23T19:14:25.471Z",
    "",
  ].join("\n")
  const stripped = stripVolatileGuidanceLines(withTimestamps)
  assert.doesNotMatch(stripped, /Updated Turn:/)
  assert.doesNotMatch(stripped, /Updated: 2026-05-23T/)
  assert.match(stripped, /# Foreground Guidance/)
  assert.match(stripped, /Scene: 3号穹顶/)
  assert.match(stripped, /Tone: 郭敬明式华丽感伤/)

  const reStripped = stripVolatileGuidanceLines(stripped)
  assert.equal(reStripped, stripped)

  const noVolatile = "# Foreground Guidance\n\n- Scene: -\n- Tone: infer from reader input.\n"
  assert.equal(stripVolatileGuidanceLines(noVolatile), noVolatile)

  const turn1 = withTimestamps
  const turn2 = withTimestamps
    .replace("turn_1779477096308_67c7d146c436a", "turn_2779477200000_ffffffffffff")
    .replace("2026-05-23T19:14:25.471Z", "2026-05-23T19:18:33.218Z")
  assert.notEqual(turn1, turn2, "raw files must differ (different timestamps)")
  assert.equal(stripVolatileGuidanceLines(turn1), stripVolatileGuidanceLines(turn2), "stripped versions must be cache-equal")
})

test("discoverContextCardIndex exposes slug + description + triggers without leaking body content", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-index-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()
  const cardDir = path.join(paths.contextCards, "rift-station-map")
  await mkdir(cardDir, { recursive: true })
  await writeFile(
    path.join(cardDir, "CARD.md"),
    [
      "---",
      "name: rift-station-map",
      "kind: location",
      "description: 裂谷站布局与禁区",
      "triggers: 裂谷站, 第三货舱, 通风管道",
      "---",
      "# Rift Station Map",
      "",
      "Detailed body content the model should NOT see in the index — only when this card is actually selected.",
    ].join("\n"),
  )
  const index = await discoverContextCardIndex()
  const card = index.find((entry) => entry.slug === "rift-station-map")
  assert.ok(card, "expected discovered card in index")
  assert.equal(card.kind, "location")
  assert.match(card.description, /裂谷站布局与禁区/)
  assert.ok(card.triggers.includes("裂谷站"))
  assert.equal(card.body, undefined)
  assert.doesNotMatch(JSON.stringify(card), /Detailed body content/)
})

test("context card frontmatter uses YAML lists and multiline fields", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-yaml-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()
  const cardDir = path.join(paths.contextCards, "multi-yaml")
  await mkdir(cardDir, { recursive: true })
  await writeFile(
    path.join(cardDir, "CARD.md"),
    [
      "---",
      "name: multi-yaml",
      "kind: procedure",
      "description: >-",
      "  Multi-line docking procedure",
      "  for the ring station.",
      "triggers:",
      "  - docking",
      "  - ring station",
      "always: false",
      "max_chars: 80",
      "---",
      "# Docking",
      "",
      "Approach slowly. Confirm the amber latch before crossing the seal. This tail should be truncated.",
    ].join("\n"),
  )

  const cards = await discoverContextCards()
  const card = cards.find((entry) => entry.name === "multi-yaml")
  assert.ok(card)
  assert.equal(card.description, "Multi-line docking procedure for the ring station.")
  assert.deepEqual(card.triggers, ["docking", "ring station"])
  assert.equal(card.maxChars, 80)
})

test("context card index is budgeted and sorted by activation count", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-stats-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()

  for (const name of ["cold-card", "warm-card", "hot-card"]) {
    const cardDir = path.join(paths.contextCards, name)
    await mkdir(cardDir, { recursive: true })
    await writeFile(
      path.join(cardDir, "CARD.md"),
      [
        "---",
        `name: ${name}`,
        "kind: note",
        `description: ${name} description`,
        `triggers: ${name}`,
        "---",
        `# ${name}`,
        "",
        `${name} body.`,
      ].join("\n"),
    )
  }

  // Activation count is recorded by the deterministic trigger activation.
  await fastActivateContextCards({ action: "warm-card", maxFastCards: 5 })
  await fastActivateContextCards({ action: "hot-card", maxFastCards: 5 })
  await fastActivateContextCards({ action: "hot-card", maxFastCards: 5 })

  const stats = JSON.parse(await readFile(paths.contextCardStats, "utf8"))
  assert.equal(stats.cards["story/context-cards/hot-card/card.md"].count, 2)
  assert.equal(stats.cards["story/context-cards/warm-card/card.md"].count, 1)

  const index = await discoverContextCardIndex({ maxCards: 2, maxChars: 10000 })
  assert.deepEqual(index.map((entry) => entry.slug), ["hot-card", "warm-card"])
  assert.deepEqual(index.map((entry) => entry.activationCount), [2, 1])
  assert.equal(index.length, 2)
})

test("fast activation matches only exact triggers for the current turn", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-fast-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()

  const fixtures = [
    ["red-key", "red key", "The red key opens the sealed service hatch."],
    ["stationary-decoy", "station", "Should not match stationary."],
    ["moon-gate", "月门", "月门上刻着旧城的纹样。"],
  ]
  for (const [name, trigger, body] of fixtures) {
    const cardDir = path.join(paths.contextCards, name)
    await mkdir(cardDir, { recursive: true })
    await writeFile(
      path.join(cardDir, "CARD.md"),
      ["---", `name: ${name}`, "kind: object", `description: ${body}`, `triggers: ${trigger}`, "---", `# ${name}`, "", body].join("\n"),
    )
  }

  const missed = await fastActivateContextCards({ action: "I study the stationary sign." })
  assert.deepEqual(missed.activated, [])

  const hit = await fastActivateContextCards({ action: "I lift the red key from the tray." })
  assert.deepEqual(hit.activated.map((card) => card.name), ["red-key"])
  // The matched card's body is composed into FOREGROUND.md this turn.
  const composed = await loadForegroundGuidance()
  assert.match(composed, /The red key opens/)

  // Per-turn manifest is non-accumulating: a CJK-only action activates ONLY the
  // CJK card (red-key from the prior turn is not carried over).
  const cjkHit = await fastActivateContextCards({ action: "我检查月门上的刻痕。" })
  assert.deepEqual(cjkHit.activated.map((card) => card.name), ["moon-gate"])
})

test("fast activation automaton handles overlap, fail links, and longest trigger ranking", async () => {
  const root = path.join(os.tmpdir(), `openovel-card-automaton-${Date.now()}`)
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  await initializeStory()

  const fixtures = [
    ["short", "甲乙甲", "Short overlapping trigger."],
    ["long", "甲乙甲乙甲", "Longer overlapping trigger should rank first."],
    ["suffix", "乙甲乙甲", "Suffix trigger should be found via fail links."],
    ["latin-boundary", "station", "Latin trigger requires word boundary."],
    ["cjk-substring", "潮汐塔", "CJK trigger can match inside a sentence."],
  ]
  for (const [name, trigger, body] of fixtures) {
    const cardDir = path.join(paths.contextCards, name)
    await mkdir(cardDir, { recursive: true })
    await writeFile(
      path.join(cardDir, "CARD.md"),
      ["---", `name: ${name}`, "kind: note", `description: ${body}`, `triggers: ${trigger}`, "---", `# ${name}`, "", body].join("\n"),
    )
  }

  const miss = await fastActivateContextCards({ action: "The stationary marker is unrelated.", maxFastCards: 5 })
  assert.deepEqual(miss.activated, [], "word-boundary check should reject station inside stationary")

  const hit = await fastActivateContextCards({ action: "甲乙甲乙甲回声旁边，我回头看见潮汐塔亮起。", maxFastCards: 5 })
  assert.deepEqual(hit.activated.map((card) => card.name), ["long", "suffix", "cjk-substring", "short"])
})
