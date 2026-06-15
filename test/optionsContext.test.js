import test from "node:test"
import assert from "node:assert/strict"

import { optionsContextBlocks } from "../src/lib/narrator.js"

test("merged narrative_so_far ends with THIS turn's beat (no one-beat-behind)", () => {
  const out = optionsContextBlocks({
    action: "推开窗",
    narration: "冷风灌进来，他眯起眼。",
    compiledContext: {
      recentCanonExcerpt: "**读者选择**：醒来\n\n他睁开眼，天还没亮。",
    },
  })
  // single merged timeline, no separate streamed/action blocks
  assert.ok(out.includes("<narrative_so_far>"))
  assert.ok(!out.includes("reader_action_just_taken"))
  assert.ok(!out.includes("streamed_narration"))
  assert.ok(!out.includes("story_so_far"))
  // prior canon present AND the current beat is the tail
  assert.ok(out.includes("他睁开眼，天还没亮。"))
  const idxPrior = out.indexOf("他睁开眼")
  const idxNow = out.indexOf("冷风灌进来")
  assert.ok(idxNow > idxPrior, "current beat must come after prior canon")
  assert.ok(out.includes("**读者选择**：推开窗"), "current action is inline in the timeline")
  // the very end of the narrative block is the current narration
  assert.ok(out.trimEnd().endsWith("</narrative_so_far>"))
})

test("narrative_so_far shares the 24k budget, tail-anchored (current beat kept)", () => {
  const huge = "旧情节。".repeat(8000) // ~32k chars of prior canon, over budget
  const out = optionsContextBlocks({
    action: "回头",
    narration: "他听见身后有脚步声，霍然回头。",
    compiledContext: { recentCanonExcerpt: huge },
  })
  // extract the narrative_so_far block
  const m = out.match(/<narrative_so_far>\n([\s\S]*?)\n<\/narrative_so_far>/)
  assert.ok(m, "narrative_so_far block present")
  const body = m[1]
  assert.ok(body.length <= 24000, `expected <=24000, got ${body.length}`)
  assert.ok(body.startsWith("…"), "oldest prior canon trimmed from the head")
  // the current beat survives at the tail
  assert.ok(body.includes("他听见身后有脚步声，霍然回头。"))
  assert.ok(body.includes("**读者选择**：回头"))
})

test("last_turn_choices lists the rejected options (chose = excluded), absent when none", () => {
  const withPrev = optionsContextBlocks({
    action: "往火里添根柴",
    narration: "火星窜起。",
    compiledContext: { recentCanonExcerpt: "前情。" },
    previousOptions: ["往火里添根柴", "站起来看窗外的星", "把冲锋衣裹紧睡了"],
  })
  assert.ok(withPrev.includes("<last_turn_choices>"))
  assert.ok(withPrev.includes("读者上一轮选择了：往火里添根柴"))
  assert.ok(withPrev.includes("站起来看窗外的星"))
  assert.ok(withPrev.includes("把冲锋衣裹紧睡了"))
  // the chosen option is NOT repeated in the rejected list
  const rejectedSection = withPrev.split("拒绝了")[1] || ""
  assert.ok(!rejectedSection.includes("- 往火里添根柴"))
  // no previous options → no block at all
  const noPrev = optionsContextBlocks({ action: "走", narration: "他迈步。", compiledContext: { recentCanonExcerpt: "前情。" } })
  assert.ok(!noPrev.includes("last_turn_choices"))
})

test("background blocks (FG / story memory / durable memory) are included when present", () => {
  const out = optionsContextBlocks({
    action: "走",
    narration: "他迈步。",
    compiledContext: {
      foregroundGuidance: "FG body",
      storyMemory: "# Story Memory\n- 旧事",
      foregroundMemory: [{ target: "user", entries: ["喜欢快节奏"] }],
      recentCanonExcerpt: "前情。",
    },
  })
  assert.ok(out.includes("<foreground_guidance>"))
  assert.ok(out.includes("<story_memory>"))
  assert.ok(out.includes("<durable_memory>"))
  assert.ok(out.includes("User Preferences:"))
  assert.ok(out.includes("喜欢快节奏"))
})

test("options-only guidance (director/OPTIONS.md) reaches the options call but NOT the narrator", async () => {
  const { buildNarratorMessages } = await import("../src/lib/narrator.js")
  const cc = { foregroundGuidance: "FG", recentCanonExcerpt: "canon", optionsGuidance: "SECRET_OPTIONS_GUIDE" }
  const ob = optionsContextBlocks({ action: "go", narration: "n", compiledContext: cc })
  assert.ok(ob.includes("<options_guidance>"), "options blocks carry the guidance tag")
  assert.ok(ob.includes("SECRET_OPTIONS_GUIDE"))
  const msgs = buildNarratorMessages({ action: "go", compiledContext: cc })
  assert.ok(!JSON.stringify(msgs).includes("SECRET_OPTIONS_GUIDE"), "narrator never sees options guidance")
})
