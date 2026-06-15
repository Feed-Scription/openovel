import assert from "node:assert/strict"
import test from "node:test"

import {
  CONTINUE_INSTRUCTION,
  mergeContinuation,
  runStreamingWithRecovery,
  trimToLastParagraph,
} from "../src/provider/streamRecovery.js"

function transientError(partialContent) {
  const error = new Error("socket hang up")
  error._partial = { content: partialContent }
  return error
}

test("mergeContinuation stitches a genuine continuation verbatim", () => {
  const merged = mergeContinuation("第一段写完了。\n\n第二段才开了个", "头，然后继续往下走。")
  assert.equal(merged.rewriteDropped, false)
  assert.equal(merged.content, "第一段写完了。\n\n第二段才开了个头，然后继续往下走。")
})

test("mergeContinuation trims the overlap when the model backs up before resuming", () => {
  const assembled = "他把收据折好，放进记事本夹层。\n\n清华经理低声问"
  const merged = mergeContinuation(assembled, "清华经理低声问：“这单我值不值一成？”")
  assert.equal(merged.rewriteDropped, false)
  assert.equal(merged.overlapTrimmed, "清华经理低声问".length)
  assert.equal(merged.content, `${assembled}：“这单我值不值一成？”`)
})

test("mergeContinuation drops a continuation that re-answers instead of continuing", () => {
  const paragraphs = [
    "之河没有回出租屋开 Codex，这三个小时他只做一件事。",
    "华强北的卷帘门哗啦啦往上拉，柜台里堆着主板和内存条。",
    "清华经理比约定早到十分钟，手里多了一只黑色公文包。",
    "老板看向之河问他们是哪家公司，这个问题来得很早。",
    "他从抽屉里摸出一沓现金，数了十二张百元拍在桌上。",
    "清华经理立刻拿出收据本，动作快，字也写得很稳当。",
  ]
  const assembled = paragraphs.join("\n\n")
  // A rewrite: the model restarts from the top, re-emitting the scene with one
  // fresh closing line.
  const rewrite = [...paragraphs.slice(0, 5), "钱进来了，债也跟着进来了。"].join("\n\n")
  const merged = mergeContinuation(assembled, rewrite)
  assert.equal(merged.rewriteDropped, true)
  assert.equal(merged.content, assembled)
  assert.ok(merged.duplicateLines >= 5)
})

test("mergeContinuation leaves short continuations alone (below the rewrite floor)", () => {
  const assembled = "前文很长的一段叙述，已经完整给读者看过了。"
  const merged = mergeContinuation(assembled, "前文很长的一段叙述，已经完整给读者看过了。")
  // One duplicated material line is not enough evidence of a rewrite.
  assert.equal(merged.rewriteDropped, false)
})

test("continue recovery keeps a re-answered scene exactly once and sheds the garbage tail", async () => {
  const scene = [
    "之河没有回出租屋开 Codex，这三个小时他只做一件事。",
    "华强北的卷帘门哗啦啦往上拉，柜台里堆着主板和内存条。",
    "清华经理比约定早到十分钟，手里多了一只黑色公文包。",
    "老板看向之河问他们是哪家公司，这个问题来得很早。",
    "他从抽屉里摸出一沓现金，数了十二张百元拍在桌上。",
    "“让钱别变成雷。”之河说。",
  ].join("\n\n")
  const garbageTail = "rayele \n        finalissami       "
  const seenMessages = []
  let round = 0
  const message = await runStreamingWithRecovery({
    recovery: "continue",
    maxAttempts: 2,
    label: "test-narrator",
    messages: [{ role: "user", content: "继续剧情" }],
    json: false,
    runAttempt: async ({ messages, progress }) => {
      round += 1
      seenMessages.push(messages)
      if (round === 1) {
        progress.framesReceived = 42
        throw transientError(`${scene}${garbageTail}`)
      }
      return { role: "assistant", content: scene }
    },
  })
  assert.equal(round, 2)
  // Round 2 was a resume: original messages + assistant prefill + continue nudge.
  const resume = seenMessages[1]
  assert.equal(resume.at(-2).role, "assistant")
  assert.ok(resume.at(-2).content.startsWith(scene.slice(0, 20)))
  assert.equal(resume.at(-1).content, CONTINUE_INSTRUCTION)
  // The re-answer was dropped: the scene appears once, garbage tail trimmed.
  assert.equal(message.content, trimToLastParagraph(`${scene}${garbageTail}`))
  const first = message.content.indexOf("这三个小时他只做一件事")
  assert.ok(first >= 0)
  assert.equal(message.content.indexOf("这三个小时他只做一件事", first + 1), -1)
  assert.ok(!message.content.includes("rayele"))
})

test("continue recovery still stitches a genuine resume onto the partial", async () => {
  let round = 0
  const message = await runStreamingWithRecovery({
    recovery: "continue",
    maxAttempts: 2,
    label: "test-narrator",
    messages: [{ role: "user", content: "继续剧情" }],
    json: false,
    runAttempt: async ({ progress }) => {
      round += 1
      if (round === 1) {
        progress.framesReceived = 7
        throw transientError("第一段写完了。\n\n第二段才开了个")
      }
      return { role: "assistant", content: "头，然后继续往下走，直到收尾。" }
    },
  })
  assert.equal(message.content, "第一段写完了。\n\n第二段才开了个头，然后继续往下走，直到收尾。")
})
