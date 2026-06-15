import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  applyStorykeeperPatch,
  enqueueBackgroundInbox,
  getStorySnapshot,
  initializeStory,
  paths,
  resolveBackgroundInbox,
} from "../src/lib/storyStore.js"

process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-inbox-home-${Date.now()}`)
process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-inbox-story-${Date.now()}`)

test("background inbox records fast-loop tasks and archives resolved items", async () => {
  await initializeStory()
  const enqueued = await enqueueBackgroundInbox({
    turnId: "turn_inbox",
    action: "记住木桥只能过轻装步兵",
    foreground: {
      narration: "侦察科长把木桥圈出来，提醒桥面已经被雨泡软。",
      options: ["改走干沟", "夜探乱葬岗"],
    },
    signal: {
      needsBackground: true,
      priority: "now",
      tasks: [
        {
          type: "continuity",
          instruction: "把木桥承重限制合并到前台指导或战场地形文件。",
          anchors: ["木桥", "轻装步兵"],
        },
      ],
      preserve: ["木桥只能过轻装步兵"],
    },
  })

  assert.deepEqual(enqueued.added, ["inbox_turn_inbox_1", "inbox_turn_inbox_preserve"])
  let snapshot = await getStorySnapshot()
  assert.equal(snapshot.backgroundInboxItems.length, 2)
  assert.match(snapshot.backgroundInbox, /木桥承重限制/)
  assert.doesNotMatch(snapshot.backgroundInbox, /改走干沟/)
  assert.doesNotMatch(snapshot.backgroundInbox, /夜探乱葬岗/)
  assert.match(snapshot.backgroundInbox, /Unchosen options are UI affordances, not canon/)

  const resolved = await resolveBackgroundInbox(["inbox_turn_inbox_1"], {
    turnId: "turn_inbox",
    note: "merged into terrain notes",
  })
  assert.deepEqual(resolved.resolvedIds, ["inbox_turn_inbox_1"])
  snapshot = await getStorySnapshot()
  assert.equal(snapshot.backgroundInboxItems.length, 1)
  assert.match(snapshot.backgroundInbox, /inbox_turn_inbox_preserve/)
})

test("storykeeper patch can resolve visible inbox items after merging guidance", async () => {
  await enqueueBackgroundInbox({
    turnId: "turn_apply",
    action: "提醒后台别忘了乱葬岗无守军",
    foreground: { narration: "你让参谋在地图西侧画下乱葬岗。", options: [] },
    signal: {
      needsBackground: true,
      tasks: [
        {
          type: "continuity",
          instruction: "将乱葬岗无守军合并到下一轮可用指导。",
          anchors: ["乱葬岗", "无守军"],
        },
      ],
    },
  })

  const applied = await applyStorykeeperPatch({
    turnId: "turn_apply",
    currentScene: "镜城港区测绘所",
    newFacts: ["乱葬岗暂未设防。"],
    inboxResolved: ["*"],
    inboxNotes: ["merged into foreground guidance"],
  })

  assert.match(applied.foregroundGuidance, /乱葬岗暂未设防/)
  assert.ok(applied.inboxResolved.includes("inbox_turn_apply_1"))
  const provenance = await readFile(paths.provenance, "utf8")
  assert.match(provenance, /legacy structured patch/)
  assert.match(provenance, /inbox_turn_apply_1/)
  const snapshot = await getStorySnapshot()
  assert.equal(snapshot.backgroundInboxItems.length, 0)
})

test("storykeeper markdown guidance strips suggested next beats", async () => {
  const applied = await applyStorykeeperPatch({
    turnId: "turn_no_beats",
    foregroundGuidanceMarkdown: [
      "# Foreground Guidance",
      "",
      "## Current Working Set",
      "",
      "- Scene: 火星穹顶边缘",
      "",
      "## Suggested Next Beats",
      "",
      "- 让玩家去仓库",
      "- 让玩家联系地球",
      "",
      "## Open Threads",
      "",
      "- 返回地球的窗口仍不确定",
    ].join("\n"),
  })

  assert.doesNotMatch(applied.foregroundGuidance, /Suggested Next Beats/)
  assert.doesNotMatch(applied.foregroundGuidance, /让玩家去仓库/)
  assert.match(applied.foregroundGuidance, /返回地球的窗口仍不确定/)
})

test("transport-only storykeeper envelope records file provenance without schema fields", async () => {
  const applied = await applyStorykeeperPatch({
    transportOnly: true,
    turnId: "turn_transport",
    status: "applied",
    summary: "Updated foreground and terrain notes.",
    foregroundGuidanceMarkdown: "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: 木桥北岸\n",
    filesChanged: [
      {
        path: "story/guidance/FOREGROUND.md",
        purpose: "refresh foreground working set",
        provenance: ["turn_transport", "foreground_turn"],
      },
      {
        path: "story/canon/terrain.md",
        purpose: "recorded bridge load limit",
        provenance: ["inbox_turn_transport_preserve"],
      },
    ],
    sourceEvents: ["evt_turn_transport"],
  })

  assert.match(applied.foregroundGuidance, /木桥北岸/)
  assert.equal(applied.filesChanged.length, 2)
  const provenance = await readFile(paths.provenance, "utf8")
  assert.match(provenance, /Updated foreground and terrain notes/)
  assert.match(provenance, /story\/canon\/terrain\.md/)
  assert.match(provenance, /evt_turn_transport/)
})

test("older async storykeeper patches cannot overwrite newer foreground guidance", async () => {
  const newer = await applyStorykeeperPatch({
    turnId: "turn_2000_newer",
    currentScene: "新场景",
    newFacts: ["新事实必须保留。"],
  })
  const stale = await applyStorykeeperPatch({
    turnId: "turn_1000_older",
    currentScene: "旧场景",
    newFacts: ["旧事实不应覆盖。"],
  })

  assert.equal(stale.skipped, true)
  assert.match(newer.foregroundGuidance, /Updated Turn: turn_2000_newer/)
  assert.match(stale.foregroundGuidance, /新事实必须保留/)
  assert.doesNotMatch(stale.foregroundGuidance, /旧事实不应覆盖/)
})

test("omitted inboxResolved leaves inbox pending until explicit disposition", async () => {
  await enqueueBackgroundInbox({
    turnId: "turn_explicit",
    action: "后台需要确认一枚铜钥匙",
    foreground: { narration: "你把铜钥匙压在账簿旁。", options: [] },
    signal: {
      needsBackground: true,
      tasks: [{ type: "continuity", instruction: "记录铜钥匙位置。", anchors: ["铜钥匙"] }],
    },
  })
  const before = await getStorySnapshot()
  assert.ok(before.backgroundInboxItems.some((item) => item.id === "inbox_turn_explicit_1"))

  const applied = await applyStorykeeperPatch({
    transportOnly: true,
    turnId: "turn_explicit",
    status: "skipped",
    summary: "Did not classify pending item.",
    inboxNotes: ["left pending intentionally for test"],
  })
  assert.deepEqual(applied.inboxResolved, [])
  const stillPending = await getStorySnapshot()
  assert.ok(stillPending.backgroundInboxItems.some((item) => item.id === "inbox_turn_explicit_1"))

  const rejected = await applyStorykeeperPatch({
    transportOnly: true,
    turnId: "turn_explicit_2",
    status: "skipped",
    summary: "Reject stale test item.",
    inboxRejected: ["inbox_turn_explicit_1"],
    inboxNotes: ["test cleanup: obsolete"],
  })
  assert.deepEqual(rejected.inboxRejected, ["inbox_turn_explicit_1"])
  const after = await getStorySnapshot()
  assert.ok(!after.backgroundInboxItems.some((item) => item.id === "inbox_turn_explicit_1"))
  const archive = await readFile(paths.backgroundInboxArchive, "utf8")
  assert.match(archive, /Rejected: inbox_turn_explicit_1/)
})
