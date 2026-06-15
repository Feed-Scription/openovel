import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"

// Pin an isolated story root BEFORE importing storyStore (paths snapshot at
// import). Ignore project config + skip onboarding so init is offline + fast.
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
process.env.OPENOVEL_SKIP_ONBOARDING = "1"
const root = path.join(os.tmpdir(), `openovel-bgmigrate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
process.env.OPENOVEL_STORY_ROOT = root

const { initializeStory, getStorySnapshot, paths } = await import("../src/lib/storyStore.js")
const {
  storykeeperSystemPrompt,
  buildStorykeeperTurnContext,
  renderStorykeeperTurnContextMarkdown,
} = await import("../src/workflows/storykeeperContext.js")

test("storykeeper prompt enforces tic control + the foreground/background split", () => {
  const p = storykeeperSystemPrompt()
  assert.match(p, /TIC CONTROL/)
  assert.match(p, /Repeated N-grams/)
  assert.match(p, /口癖/)
  assert.match(p, /FOREGROUND vs BACKGROUND/)
  assert.match(p, /story\/director\/QUALITY\.md/)
  // The entity-vs-tic distinction the user asked for.
  assert.match(p, /named entities/i)
  assert.match(p, /forbidden\.md/)
})

// The reports are computed by buildTicReports (ngramStore.js, tested separately)
// and PASSED IN; the context builder just places them into the rendered sections.
function baseSnapshot(overrides = {}) {
  return { foregroundGuidance: "", backgroundInbox: "", backgroundInboxItems: [], chapters: "", contextReport: null, ...overrides }
}

test("turn context renders the passed-in n-gram + custom-pattern reports as their own sections", () => {
  const ctx = buildStorykeeperTurnContext({
    action: "环顾四周",
    foreground: { narration: "x", tension: "", source: "test" },
    backgroundSignal: null,
    snapshot: baseSnapshot(),
    memorySnapshot: null,
    registry: null,
    repeatedNgrams: "「仿佛」  total 5  · +1 this turn",
    ticPatternMatches: "「不由得」  total 3  · +1 this turn",
  })
  assert.equal(ctx.repeatedNgrams, "「仿佛」  total 5  · +1 this turn")
  assert.equal(ctx.ticPatternMatches, "「不由得」  total 3  · +1 this turn")
  const md = renderStorykeeperTurnContextMarkdown(ctx)
  assert.match(md, /Repeated N-grams \(tic candidates\)/)
  assert.match(md, /仿佛/)
  assert.match(md, /Custom Tic Patterns \(this model\)/)
  assert.match(md, /不由得/)
})

test("turn context omits the tic sections when no reports are passed", () => {
  const ctx = buildStorykeeperTurnContext({
    action: "x",
    foreground: { narration: "y" },
    backgroundSignal: null,
    snapshot: baseSnapshot(),
    memorySnapshot: null,
    registry: null,
    // repeatedNgrams / ticPatternMatches default to null
  })
  assert.equal(ctx.repeatedNgrams, null)
  assert.equal(ctx.ticPatternMatches, null)
  const md = renderStorykeeperTurnContextMarkdown(ctx)
  assert.doesNotMatch(md, /Repeated N-grams/)
  assert.doesNotMatch(md, /Custom Tic Patterns/)
})

test("legacy story/QUALITY.md migrates into story/director/QUALITY.md on init", async () => {
  await mkdir(root, { recursive: true })
  const legacy = path.join(root, "QUALITY.md")
  await writeFile(legacy, "# Story Quality Analysis\n\nMY EXISTING NOTES\n")

  await initializeStory()

  const moved = path.join(root, "director", "QUALITY.md")
  assert.equal(paths.qualityLog, moved, "qualityLog path points at director/")
  assert.ok(existsSync(moved), "director/QUALITY.md exists after migration")
  assert.match(await readFile(moved, "utf8"), /MY EXISTING NOTES/, "existing content preserved")
  assert.ok(!existsSync(legacy), "legacy root QUALITY.md no longer present")
})

// ---- ARC.md: plot-arc / pacing / foreshadowing ledger ----
// NOTE: the init-based tests below run AFTER the migration test on purpose —
// initializeStory seeds director/QUALITY.md, which would defeat the migration
// test's `!existsSync(p.qualityLog)` guard if it ran first.

test("storykeeper prompt carries the PACING · ARC · SETUPS directive + the ARC ledger", () => {
  const p = storykeeperSystemPrompt()
  assert.match(p, /PACING · ARC · SETUPS/)
  assert.match(p, /story\/director\/ARC\.md/)
  assert.match(p, /story\/director\/PLAYER_PROFILE\.md/)
  assert.match(p, /near-future behavior predictions/)
  // pacing frames + the foreshadowing ledger the user asked for
  assert.match(p, /Scene\/Sequel|Fichtean/)
  assert.match(p, /伏笔|埋坑|草蛇灰线/)
  // the load-bearing background→foreground translation (ARC.md never reaches the narrator)
  assert.match(p, /active-pressures\.md/)
})

test("turn context renders the tension trajectory when passed, omits it otherwise", () => {
  const withTraj = buildStorykeeperTurnContext({
    action: "x", foreground: { narration: "y" }, backgroundSignal: null,
    snapshot: baseSnapshot(), memorySnapshot: null, registry: null,
    tensionTrajectory: [{ turn: "turn_001", tension: "平稳" }, { turn: "turn_002", tension: "紧张上升" }],
  })
  const md = renderStorykeeperTurnContextMarkdown(withTraj)
  assert.match(md, /Tension Trajectory \(recent turns\)/)
  assert.match(md, /turn_002: 紧张上升/)

  const without = buildStorykeeperTurnContext({
    action: "x", foreground: { narration: "y" }, backgroundSignal: null,
    snapshot: baseSnapshot(), memorySnapshot: null, registry: null,
  })
  assert.equal(without.tensionTrajectory, null)
  assert.doesNotMatch(renderStorykeeperTurnContextMarkdown(without), /Tension Trajectory/)
})

test("initializeStory seeds director/ARC.md with the skeleton and never clobbers edits", async () => {
  await initializeStory()
  const arc = path.join(root, "director", "ARC.md")
  const profile = path.join(root, "director", "PLAYER_PROFILE.md")
  assert.equal(paths.arcLog, arc, "arcLog points at director/ARC.md")
  assert.equal(paths.playerProfile, profile, "playerProfile points at director/PLAYER_PROFILE.md")
  assert.ok(existsSync(arc), "ARC.md seeded")
  assert.ok(existsSync(profile), "PLAYER_PROFILE.md seeded")
  const seeded = await readFile(arc, "utf8")
  const seededProfile = await readFile(profile, "utf8")
  assert.match(seeded, /Story Arc · Pacing · Setups/)
  assert.match(seeded, /伏笔与回收/)
  assert.match(seeded, /停滞预警/)
  assert.match(seededProfile, /Player Choice Profile/)
  assert.match(seededProfile, /Predictions/)
  // idempotent: a later init must not overwrite Storykeeper edits
  await writeFile(arc, seeded + "\n<!-- SK EDIT -->\n")
  await writeFile(profile, seededProfile + "\n<!-- PROFILE EDIT -->\n")
  await initializeStory()
  assert.match(await readFile(arc, "utf8"), /SK EDIT/, "existing ARC.md preserved across re-init")
  assert.match(await readFile(profile, "utf8"), /PROFILE EDIT/, "existing PLAYER_PROFILE.md preserved across re-init")
})

test("getStorySnapshot.recentTensions reads the per-turn tension trajectory from scene_log", async () => {
  await initializeStory()
  // synthetic event stream incl. a junk line to prove partial-line tolerance
  const log = [
    JSON.stringify({ type: "reader_action", turnId: "turn_001" }),
    JSON.stringify({ type: "foreground_turn", turnId: "turn_001", foreground: { tension: "平稳", options: ["a"] } }),
    "{ partial broken line",
    JSON.stringify({ type: "foreground_turn", turnId: "turn_002", foreground: { tension: "紧张上升" } }),
    JSON.stringify({ type: "foreground_turn", turnId: "turn_003", foreground: { tension: "对峙" } }),
    "",
  ].join("\n")
  await writeFile(paths.sceneLog, log)
  const snap = await getStorySnapshot()
  assert.ok(Array.isArray(snap.recentTensions))
  assert.deepEqual(snap.recentTensions.map((t) => t.tension), ["平稳", "紧张上升", "对峙"])
  assert.equal(snap.recentTensions[2].turn, "turn_003")
})

test("getStorySnapshot.previousOptions survives large background events after the last foreground turn", async () => {
  await initializeStory()
  const options = [
    { id: "opt_turn_big_1", label: "把话题拉回徒步本身——前面还有多远到近露" },
    { id: "opt_turn_big_2", label: "沉默一会儿，让对话自然歇一歇" },
  ]
  const log = [
    JSON.stringify({
      type: "foreground_turn",
      turnId: "turn_big",
      foreground: { tension: "对话余韵", options },
    }),
    JSON.stringify({
      type: "background_patch",
      turnId: "turn_big",
      patch: { summary: "x".repeat(180 * 1024) },
    }),
    JSON.stringify({ type: "background_agent_completed", turnId: "turn_big" }),
    "",
  ].join("\n")
  await writeFile(paths.sceneLog, log)

  const snap = await getStorySnapshot()
  assert.deepEqual(snap.previousOptions, options)
  assert.deepEqual(snap.recentTensions.map((t) => t.tension), ["对话余韵"])
})

test("recordSceneEvent caches the latest foreground turn for option binding", async () => {
  await initializeStory()
  const { recordSceneEvent } = await import("../src/lib/storyStore.js")
  const options = [{ id: "opt_cached_1", label: "选缓存里的动作", effect: { consequence: "hidden" } }]
  await recordSceneEvent({
    type: "foreground_turn",
    turnId: "turn_cached",
    action: "上一轮动作",
    foreground: { narration: "n", tension: "t", options },
  })
  await recordSceneEvent({
    type: "background_patch",
    turnId: "turn_cached",
    patch: { summary: "x".repeat(180 * 1024) },
  })

  const snap = await getStorySnapshot()
  assert.deepEqual(snap.previousOptions, options)
  assert.ok(existsSync(paths.latestForegroundTurn), "latest foreground cache written")
})
