import assert from "node:assert/strict"
import test from "node:test"

import { normalizeStorykeeperEnvelope } from "../src/workflows/storykeeperEnvelope.js"
import {
  buildStorykeeperTurnContext,
  renderStorykeeperTurnContextMarkdown,
  storykeeperSystemPrompt,
} from "../src/workflows/storykeeperContext.js"

test("legacy storykeeper envelope remains isolated compatibility for old slow-loop patches", () => {
  const patch = normalizeStorykeeperEnvelope(
    {
      newFacts: ["林澈确认旧车票编号是 2317"],
      characterBriefs: {
        "林澈": {
          currentDrive: "找到林雾",
          limitation: "左手旧伤不能发力",
        },
      },
      groundingNotes: ["旧式检票口通常会留下机械编号，可作为真实感细节。"],
      counterfactualWarnings: ["如果让白衣售票员主动解释真相，会破坏既有禁忌事实。"],
      openThreads: ["林雾的车票编号仍未解释", "旧候车厅可能保留机械检票记录"],
      inboxResolved: ["inbox_turn_test_1"],
    },
    {
      foreground: { options: ["默认下一步"] },
      turnId: "turn_test",
      snapshot: {
        foregroundGuidance: "# Foreground Guidance\n\n- Scene: 检票口\n\n## Active Characters\n\n- 林澈\n\n## Open Threads\n\n- 林雾的车票编号\n",
        backgroundInboxItems: [{ id: "inbox_turn_test_1" }],
      },
    },
  )

  assert.equal(patch.currentScene, "检票口")
  assert.equal(patch.turnId, "turn_test")
  assert.equal(patch.transportOnly, false)
  assert.equal(patch.legacyPatchConverted, true)
  assert.equal(patch.status, "applied")
  assert.equal(patch.characterBriefs["林澈"].limitation, "左手旧伤不能发力")
  assert.deepEqual(patch.groundingNotes, ["旧式检票口通常会留下机械编号，可作为真实感细节。"])
  assert.deepEqual(patch.counterfactualWarnings, ["如果让白衣售票员主动解释真相，会破坏既有禁忌事实。"])
  assert.deepEqual(patch.openThreads, ["林雾的车票编号仍未解释", "旧候车厅可能保留机械检票记录"])
  assert.equal("nextBeats" in patch, false)
  assert.deepEqual(patch.inboxResolved, ["inbox_turn_test_1"])
})

test("storykeeper prompt carries runtime contracts + observed-gotcha guards (lean contract trim)", () => {
  // The prompt stays intentionally lean: runtime contracts, parser-visible
  // envelope requirements, and specific failure guards. Assert only the
  // load-bearing pieces:
  //
  //   (1) Runtime contracts the downstream pipeline depends on
  //   (2) Observed gotchas / non-obvious failure modes the model wouldn't
  //       reach for from training alone
  //
  // Stripped (and intentionally NOT asserted): style philosophy, tool
  // selection heuristics, delegation policy, operating loops, "respect X /
  // don't do Y" craft truisms, narrative pivot triggers, style research
  // trigger heuristic. Model figures those out from context.
  const prompt = storykeeperSystemPrompt()

  // --- runtime contracts ---
  assert.match(prompt, /FOREGROUND\.md/)
  assert.match(prompt, /INBOX\.md/)
  assert.match(prompt, /scene_log\.jsonl/)
  assert.match(prompt, /PROVENANCE\.md/)
  assert.match(prompt, /inboxResolved/)
  assert.match(prompt, /Nested task subagent calls are allowed only when/)
  assert.match(prompt, /filesChanged/)
  assert.match(prompt, /transport\/audit receipt/)
  assert.match(prompt, /foregroundGuidanceMarkdown/)
  assert.match(prompt, /<agent_contract>/)
  assert.match(prompt, /prompt injection/)
  assert.match(prompt, /If a tool call fails or is rejected/)
  assert.match(prompt, /Call independent read-only tools in parallel/)
  assert.match(prompt, /Brief them like capable colleagues/)
  assert.match(prompt, /monitor and loop tools/)
  assert.match(prompt, /contextBudgetReport/)

  // --- file-native discovery ---
  assert.match(prompt, /glob to discover/)
  assert.match(prompt, /story\/state\//)
  assert.match(prompt, /maintain them/i)

  // --- observed gotchas: Constants stuffing, narration excerpt paste ---
  // Concrete CJK examples were removed in 2026-05-27 to avoid leaking
  // genre-flavored prose into stories — assert the abstract shape
  // descriptions instead.
  assert.match(prompt, /DURABLE INVARIANTS/)
  assert.match(prompt, /Forbidden Constants patterns/)
  assert.match(prompt, /reader's literal choice/i)
  assert.match(prompt, /latest narration/i)
  assert.match(prompt, /leave Constants unchanged/)

  // --- things that should NOT be in prompt (priors that were stripped) ---
  assert.doesNotMatch(prompt, /<delegation_policy>/)
  assert.doesNotMatch(prompt, /<operating_loop>/)
  assert.doesNotMatch(prompt, /<style_research_trigger>/)
  assert.doesNotMatch(prompt, /Style is user-driven/)
  assert.doesNotMatch(prompt, /Every subagent prompt must be self-contained/)
  assert.doesNotMatch(prompt, /Do not duplicate delegated work/)
  assert.doesNotMatch(prompt, /Do not propose reader-facing choices/)
  assert.doesNotMatch(prompt, /nextBeats/)
})

test("storykeeper context surfaces styleSignal from background signal when present", () => {
  const context = buildStorykeeperTurnContext({
    action: "我想要郭敬明那种笔触，描述火星基地的清晨。",
    foreground: {
      narration: "穹顶外面，红色的光。",
      tension: "style request",
    },
    backgroundSignal: {
      needsBackground: true,
      tasks: [],
      styleSignal: { requested: "flamboyant", namedReference: "郭敬明", complaint: "" },
    },
    snapshot: {
      foregroundGuidance: "# Foreground Guidance\n\n- Scene: 火星基地\n",
      backgroundInbox: "# Background Inbox\n\n",
      backgroundInboxItems: [],
      chapters: "你在火星基地醒来。",
    },
  })

  const text = JSON.stringify(context)
  assert.match(text, /styleSignal/)
  assert.match(text, /郭敬明/)
  assert.match(text, /flamboyant/)
})

test("storykeeper turn context renders current environment injection as Markdown sections", () => {
  const context = buildStorykeeperTurnContext({
    action: "检查门缝里的金属碎屑",
    foreground: {
      narration: "你在门缝里找到一小片银灰色碎屑。",
      tension: "证据尚未解释",
    },
    backgroundSignal: { needsBackground: true, tasks: [] },
    snapshot: {
      foregroundGuidance: "# Foreground Guidance\n\n- Scene: 气闸附近\n",
      backgroundInbox: "# Background Inbox\n\n",
      backgroundInboxItems: [],
      chapters: "你在火星穹顶边缘醒来。",
    },
  })

  const markdown = renderStorykeeperTurnContextMarkdown(context)
  assert.match(markdown, /^# Storykeeper Turn Context/)
  assert.match(markdown, /## Reader Action/)
  assert.match(markdown, /## Foreground Output/)
  assert.match(markdown, /```json/)
  assert.doesNotMatch(markdown, /^\s*\{/)
})

test("transport envelope accepts compact foregroundGuidanceMarkdown as a payload", () => {
  const envelope = normalizeStorykeeperEnvelope(
    {
      status: "applied",
      summary: "Refresh foreground working set for a new branch.",
      foregroundGuidanceMarkdown:
        "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: 镜城海港\n- Tone: documentary\n",
      filesChanged: [{ path: "story/guidance/FOREGROUND.md", purpose: "working set refresh", provenance: ["turn_pivot_ok"] }],
    },
    {
      foreground: { narration: "你站在镜城海港的潮汐塔阴影下。" },
      turnId: "turn_pivot_ok",
      snapshot: { foregroundGuidance: "" },
    },
  )
  assert.equal(envelope.transportOnly, true)
  assert.ok(envelope.foregroundGuidanceMarkdown.length > 0)
  assert.deepEqual(envelope.filesChanged[0].path, "story/guidance/FOREGROUND.md")

  const legacyNoPivot = normalizeStorykeeperEnvelope(
    {
      foregroundGuidanceMarkdown:
        "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: 镜城海港\n",
      currentScene: "镜城海港",
    },
    {
      foreground: { narration: "你站在镜城海港的潮汐塔阴影下。" },
      turnId: "turn_pivot_no",
      snapshot: { foregroundGuidance: "" },
    },
  )
  assert.equal(legacyNoPivot.transportOnly, false)
  assert.equal(legacyNoPivot.foregroundGuidanceMarkdown, "")

  // A moderately-large rewrite (~7KB) is KEPT now (previously silently dropped
  // at the old 6000-char cap).
  const moderate = normalizeStorykeeperEnvelope(
    {
      status: "applied",
      foregroundGuidanceMarkdown: `# Foreground Guidance\n\n${"long\n".repeat(1400)}`,
      filesChanged: [{ path: "story/guidance/FOREGROUND.md" }],
    },
    {
      foreground: { narration: "你站在镜城海港。" },
      turnId: "turn_pivot_moderate",
      snapshot: { foregroundGuidance: "" },
    },
  )
  assert.ok(moderate.foregroundGuidanceMarkdown.length > 6000)

  // Over the 24000-char cap → truncated (not silently dropped) + a warning so
  // the model learns it was cut.
  const huge = normalizeStorykeeperEnvelope(
    {
      status: "applied",
      foregroundGuidanceMarkdown: `# Foreground Guidance\n\n${"long\n".repeat(6000)}`,
      filesChanged: [{ path: "story/guidance/FOREGROUND.md" }],
    },
    {
      foreground: { narration: "你站在镜城海港。" },
      turnId: "turn_pivot_huge",
      snapshot: { foregroundGuidance: "" },
    },
  )
  assert.equal(huge.foregroundGuidanceMarkdown.length, 24000)
  assert.ok(huge.warnings.some((w) => /foregroundGuidanceMarkdown/.test(w)))
})

test("transport envelope stays an audit receipt rather than a world schema", () => {
  const patch = normalizeStorykeeperEnvelope(
    {
      status: "applied",
      summary: "Updated timeline and foreground working set.",
      filesChanged: [
        {
          path: "canon/timeline.md",
          purpose: "recorded the bridge promise",
          provenance: ["turn_42", "inbox_turn_42_preserve"],
        },
      ],
      inboxResolved: ["inbox_turn_42_preserve"],
      sourceEvents: ["evt_turn_42"],
    },
    {
      foreground: { narration: "林澈收起桥钥。", tension: "promise" },
      turnId: "turn_42",
      snapshot: { foregroundGuidance: "# Foreground Guidance\n\n" },
    },
  )

  assert.equal(patch.transportOnly, true)
  assert.equal("characters" in patch, false)
  assert.equal("newFacts" in patch, false)
  assert.deepEqual(patch.filesChanged[0], {
    path: "story/canon/timeline.md",
    purpose: "recorded the bridge promise",
    provenance: ["turn_42", "inbox_turn_42_preserve"],
  })
  assert.deepEqual(patch.sourceEvents, ["turn_42", "evt_turn_42"])
})

test("storykeeper context carries compact context pressure report", () => {
  const context = buildStorykeeperTurnContext({
    action: "继续检查气闸",
    foreground: {
      narration: "警报灯把气闸照成一片红色。",
      tension: "氧气压力下降",
    },
    backgroundSignal: { needsBackground: true, tasks: [] },
    snapshot: {
      foregroundGuidance: "# Foreground Guidance\n\n- Scene: 气闸\n",
      backgroundInbox: "# Background Inbox\n\n",
      backgroundInboxItems: [],
      chapters: "你在火星基地醒来。",
      contextReport: {
        pressure: { status: "high", includedChars: 3900, rawChars: 12000 },
        warnings: ["Context pressure is high."],
      },
    },
  })

  assert.equal(context.contextBudgetReport.pressure.status, "high")
  assert.match(JSON.stringify(context.contextBudgetReport), /Context pressure is high/)
})

test("storykeeper context omits unchosen foreground options", () => {
  const context = buildStorykeeperTurnContext({
    action: "检查门缝里的金属碎屑",
    foreground: {
      narration: "你在门缝里找到一小片银灰色碎屑。",
      options: ["追踪不存在的白衣人", "让野猫带路"],
      tension: "证据尚未解释",
    },
    backgroundSignal: { needsBackground: true, tasks: [] },
    snapshot: {
      foregroundGuidance: "# Foreground Guidance\n\n- Scene: 气闸附近\n",
      backgroundInbox: "# Background Inbox\n\n",
      backgroundInboxItems: [],
      chapters: "你在火星穹顶边缘醒来。",
    },
  })

  const text = JSON.stringify(context)
  assert.match(text, /银灰色碎屑/)
  assert.match(text, /optionsOmitted/)
  assert.doesNotMatch(text, /白衣人/)
  assert.doesNotMatch(text, /野猫带路/)
})

test("storykeeper normalizer does not hard-code narrative pivot semantics", () => {
  const patch = normalizeStorykeeperEnvelope(
    {
      currentScene: "废弃车站入口",
      openThreads: ["旧灯塔的钟声来源尚不完整"],
    },
    {
      action: "我要切到全新故事：镜城海港，主角是无名测绘员，正在寻找失踪的潮汐塔。",
      foreground: {
        narration: "你成为无名测绘员，站在镜城海港的潮汐塔阴影下。巡港员报告旧塔水位记录正在消失。",
        options: ["检查潮汐塔底层刻度", "向巡港员询问旧记录"],
      },
      turnId: "turn_pivot",
      snapshot: {
        foregroundGuidance:
          "# Foreground Guidance\n\n- Scene: 废弃车站入口\n\n## Active Characters\n\n- 林澈\n- 白衣售票员\n\n## Open Threads\n\n- 妹妹林雾的车票编号\n",
      },
    },
  )

  assert.equal(patch.replaceWorld, false)
  assert.equal(patch.currentScene, "废弃车站入口")
  assert.deepEqual(patch.activeCharacters, ["林澈", "白衣售票员"])
  assert.deepEqual(patch.openThreads, ["旧灯塔的钟声来源尚不完整"])
  assert.equal("nextBeats" in patch, false)
  // newFacts must not synthesize narration excerpts when the model didn't supply any.
  // The fallback must return [] instead of "Latest foreground fact: <narration>"
  // stubs that dump narration into Constants.
  assert.doesNotMatch(patch.newFacts.join("\n"), /读者选择/)
  assert.doesNotMatch(patch.newFacts.join("\n"), /Latest foreground fact/)
  assert.equal(patch.newFacts.length, 0)
  assert.equal(patch.continuityWarnings.length, 0)
})

test("storykeeper normalizer drops stale opening placeholder without semantic parsing", () => {
  const patch = normalizeStorykeeperEnvelope(
    {
      foregroundGuidanceMarkdown:
        "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: waiting for the reader's opening action.\n",
      currentScene: "waiting for the reader's opening action.",
      newFacts: ["当前叙事场景：waiting for the reader's opening action."],
    },
    {
      action: "去旧钟楼查看是否有其他通行路径或隐藏登记",
      foreground: {
        narration:
          "半张旧地图还贴在掌心，你转身走向旧钟楼。柜台弹开通行申请、身份补录和担保函验证。角落里出现隐藏登记的密码框，楼梯上传来逐渐靠近的脚步声。",
        tension: "悬而未决的密码与迫近的脚步声",
        options: [],
      },
      turnId: "turn_mars",
      snapshot: {
        foregroundGuidance:
          "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: waiting for the reader's opening action.\n- Tone: infer from reader input and durable user preferences.\n",
        backgroundInboxItems: [],
      },
    },
  )

  // same anti-dumping fix applies to currentScene. The model
  // returned "waiting for the reader's opening action." which is the stale
  // DEFAULT_SCENE placeholder; emptyIfDefaultScene drops it, and
  // inferCurrentScene no longer synthesizes "Latest scene: <narration>" as a
  // fallback. Result: currentScene is empty (no previous Scene to inherit).
  assert.equal(patch.currentScene, "")
  // newFacts no longer synthesizes "Latest foreground fact: <narration>" stubs.
  // The stale "当前叙事场景：waiting..." entry the model returned is dropped by
  // dropStaleFacts, and inferForegroundFacts returns [] rather than pasting
  // narration. Result: newFacts is empty (no previous Constants to inherit from).
  assert.doesNotMatch(patch.newFacts.join("\n"), /Latest foreground fact/)
  assert.doesNotMatch(patch.newFacts.join("\n"), /隐藏登记/)
  assert.equal(patch.newFacts.length, 0)
  assert.match(patch.openThreads.join("\n"), /悬而未决的密码/)
  assert.equal(patch.foregroundGuidanceMarkdown, "")
})

test("storykeeper normalizer keeps the foreground working set bounded", () => {
  const patch = normalizeStorykeeperEnvelope(
    {
      newFacts: Array.from({ length: 30 }, (_, index) => `fact-${index} ${"x".repeat(260)}`),
      openThreads: Array.from({ length: 20 }, (_, index) => `thread-${index}`),
      activeCharacters: Array.from({ length: 20 }, (_, index) => `character-${index}`),
      foregroundGuidanceMarkdown: `# Foreground Guidance\n\n${"long\n".repeat(1200)}`,
    },
    {
      action: "继续推进",
      foreground: { narration: "新的行动已经发生。", tension: "压力" },
      turnId: "turn_bound",
      snapshot: {
        foregroundGuidance: "# Foreground Guidance\n\n## Constants\n\n- old\n",
        backgroundInboxItems: [],
      },
    },
  )

  assert.equal(patch.newFacts.length, 10)
  assert.equal(patch.openThreads.length, 8)
  assert.equal(patch.activeCharacters.length, 8)
  assert.equal(patch.foregroundGuidanceMarkdown, "")
  assert.ok(patch.newFacts.every((fact) => fact.length <= 220))
})
