import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory, paths, recordSceneEvent } from "../src/lib/storyStore.js"
import {
  createLoop,
  createMonitor,
  evaluateStoryWatchers,
  listLoops,
  listMonitors,
} from "../src/runtime/storyWatchers.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"
import { registerDefaultTools } from "../src/tools/registerTools.js"

test("foreground regex monitor enqueues background inbox work", async () => {
  await withTempStory(async () => {
    await createMonitor({
      id: "injury-watch",
      description: "Notice new injuries from foreground narration",
      source: "foreground",
      pattern: "扭伤|sprain",
      instruction: "If a new injury appears, merge it into foreground guidance or a character/status file.",
      maxTriggers: 1,
    })
    await recordForeground("turn_watch_1", "我从梯子上跳下", "落地时，左手腕猛地一拧，像有细小的电火花钻进骨缝。")

    const result = await evaluateStoryWatchers({
      turnId: "turn_watch_1",
      action: "我从梯子上跳下",
      foreground: { narration: "落地时，左手腕猛地一拧，像有细小的电火花钻进骨缝。", tension: "左手腕扭伤" },
    })

    assert.equal(result.monitors.triggered.length, 1)
    assert.equal(result.monitors.triggered[0].id, "injury-watch")
    const inbox = await readFile(paths.backgroundInbox, "utf8")
    assert.match(inbox, /monitor-injury-watch-1/)
    assert.match(inbox, /If a new injury appears/)

    const monitors = await listMonitors()
    assert.equal(monitors[0].fireCount, 1)
  })
})

test("javascript monitor can inspect the current foreground turn", async () => {
  await withTempStory(async () => {
    await createMonitor({
      id: "style-complaint-watch",
      description: "Catch explicit style complaints",
      source: "foreground",
      code: "action.includes('不像') && narration.includes('火星')",
      instruction: "Treat the style complaint as a background research/context-card task.",
    })
    await recordForeground("turn_style_1", "这段不像马尔克斯", "火星穹顶外的红尘正在升起。")

    const result = await evaluateStoryWatchers({
      turnId: "turn_style_1",
      action: "这段不像马尔克斯",
      foreground: { narration: "火星穹顶外的红尘正在升起。" },
    })

    assert.equal(result.monitors.triggered.length, 1)
    const inbox = await readFile(paths.backgroundInbox, "utf8")
    assert.match(inbox, /style complaint/)
  })
})

test("loop enqueues recurring background work every N foreground turns", async () => {
  await withTempStory(async () => {
    await createLoop({
      id: "continuity-sweep",
      description: "Periodic continuity audit",
      prompt: "Review unresolved promises, injuries, object ownership, and return only compact file updates.",
      intervalTurns: 2,
      maxRuns: 1,
    })

    await recordForeground("turn_loop_1", "继续", "第一段。")
    let result = await evaluateStoryWatchers({
      turnId: "turn_loop_1",
      action: "继续",
      foreground: { narration: "第一段。" },
    })
    assert.equal(result.loops.triggered.length, 0)

    await recordForeground("turn_loop_2", "检查物资", "第二段。")
    result = await evaluateStoryWatchers({
      turnId: "turn_loop_2",
      action: "检查物资",
      foreground: { narration: "第二段。" },
    })
    assert.equal(result.loops.triggered.length, 1)
    assert.equal(result.loops.triggered[0].id, "continuity-sweep")

    await recordForeground("turn_loop_3", "继续", "第三段。")
    await recordForeground("turn_loop_4", "继续", "第四段。")
    result = await evaluateStoryWatchers({
      turnId: "turn_loop_4",
      action: "继续",
      foreground: { narration: "第四段。" },
    })
    assert.equal(result.loops.triggered.length, 0, "maxRuns should stop after one run")

    const loops = await listLoops()
    assert.equal(loops[0].runCount, 1)
    const inbox = await readFile(paths.backgroundInbox, "utf8")
    assert.match(inbox, /loop-continuity-sweep-1/)
    assert.match(inbox, /Review unresolved promises/)
  })
})

test("monitor and loop tools expose create/list/run actions", async () => {
  await withTempStory(async () => {
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    const monitor = await registry.execute("monitor", {
      action: "create",
      id: "oxygen-watch",
      source: "foreground",
      pattern: "氧气|oxygen",
      instruction: "Track oxygen facts in foreground guidance.",
    })
    assert.match(monitor.output, /oxygen-watch/)

    const monitors = await registry.execute("monitor", { action: "list" })
    assert.match(monitors.output, /oxygen-watch/)

    const loop = await registry.execute("loop", {
      action: "create",
      id: "budget-loop",
      prompt: "Check context budget and compact bulky foreground guidance if needed.",
      intervalTurns: 3,
    })
    assert.match(loop.output, /budget-loop/)

    const run = await registry.execute("loop", { action: "run", id: "budget-loop" })
    assert.match(run.output, /"ran": true/)
    const inbox = await readFile(paths.backgroundInbox, "utf8")
    assert.match(inbox, /Check context budget/)
  })
})

async function withTempStory(fn) {
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
  }
  process.env.OPENOVEL_HOME = await mkdtemp(path.join(os.tmpdir(), "openovel-watch-home-"))
  process.env.OPENOVEL_STORY_ROOT = await mkdtemp(path.join(os.tmpdir(), "openovel-watch-story-"))
  try {
    await initializeStory()
    await fn()
  } finally {
    if (saved.OPENOVEL_HOME === undefined) delete process.env.OPENOVEL_HOME
    else process.env.OPENOVEL_HOME = saved.OPENOVEL_HOME
    if (saved.OPENOVEL_STORY_ROOT === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = saved.OPENOVEL_STORY_ROOT
  }
}

async function recordForeground(turnId, action, narration) {
  await recordSceneEvent({
    type: "foreground_turn",
    turnId,
    action,
    foreground: { narration },
  })
}
