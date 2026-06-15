import test from "node:test"
import assert from "node:assert/strict"

import { computeNgramProfile, renderNgramProfile, rankNgramCandidates } from "../src/lib/ngramProfile.js"

test("rankNgramCandidates honors the top cap (the report surfaces top N)", () => {
  const entries = []
  for (let i = 0; i < 60; i += 1) {
    const ch = String.fromCharCode(0x4e00 + i) // distinct CJK char → distinct 2-gram, no containment
    entries.push({ n: 2, gram: ch + ch, count: 5 })
  }
  assert.equal(rankNgramCandidates(entries, { minCount: 3, top: 50 }).length, 50)
  assert.equal(rankNgramCandidates(entries, { minCount: 3, top: 24 }).length, 24)
})

function byGram(profile) {
  return Object.fromEntries(profile.grams.map((g) => [g.gram, g]))
}

test("surfaces a repeated CJK phrase with the right total count", () => {
  const text = [
    "他不由得停下脚步。",
    "她不由得笑了。",
    "我不由得想起往事。",
    "风一吹，他不由得打了个寒颤。",
  ].join("\n")
  const profile = computeNgramProfile(text, { minN: 2, maxN: 4, minCount: 3 })
  const g = byGram(profile)
  assert.ok(g["不由得"], "不由得 surfaced as a unit")
  assert.equal(g["不由得"].count, 4)
})

test("merges overlapping grams into the maximal unit (人工智能 counts as one, not its fragments)", () => {
  // 人工智能 recurs in VARYING contexts, so the maximal repeated unit is exactly
  // 人工智能 — its overlapping fragments must NOT be listed separately.
  const text = [
    "人工智能很危险。",
    "他研究人工智能。",
    "人工智能是未来。",
    "我害怕人工智能。",
  ].join("\n")
  const profile = computeNgramProfile(text, { minN: 2, maxN: 6, minCount: 3 })
  const g = byGram(profile)
  assert.equal(g["人工智能"]?.count, 4, "人工智能 surfaces as a single unit, count 4")
  assert.equal(g["人工智"], undefined, "3-gram fragment 人工智 suppressed")
  assert.equal(g["工智能"], undefined, "3-gram fragment 工智能 suppressed")
  assert.equal(g["人工"], undefined, "2-gram fragment 人工 suppressed (lives only inside 人工智能)")
})

test("keeps a shorter gram when it recurs well beyond its longest container", () => {
  // 仿佛 appears 6× total; only 2 of those are inside the longer repeat 仿佛看见.
  const text = [
    "他仿佛看见了。", "她仿佛看见了。",   // 仿佛看见 ×2
    "我仿佛懂了。", "风仿佛停了。", "夜仿佛醒了。", "雨仿佛轻了。", // 仿佛 elsewhere
  ].join("\n")
  const profile = computeNgramProfile(text, { minN: 2, maxN: 4, minCount: 3, keepFactor: 1.4 })
  const g = byGram(profile)
  assert.equal(g["仿佛"]?.count, 6, "仿佛 kept independently — it occurs far more than 仿佛看见")
})

test("reports new-this-turn occurrences separately from the window total", () => {
  const windowText = "他仿佛懂了。她仿佛笑了。我仿佛听见。风仿佛停了。夜仿佛醒了。" // 仿佛 ×5
  const recentText = "他仿佛懂了。她仿佛笑了。"                              // 仿佛 ×2 this turn
  const profile = computeNgramProfile(windowText, { minN: 2, maxN: 3, minCount: 3, recentText })
  const g = byGram(profile)
  assert.equal(g["仿佛"].count, 5, "total across the window")
  assert.equal(g["仿佛"].newCount, 2, "added by this turn")
})

test("respects minCount, strips reader-action headers, and stays within sentences", () => {
  // minCount
  const rare = computeNgramProfile("他不由得停。她不由得笑。独特句。", { minN: 3, maxN: 3, minCount: 3 })
  assert.equal(byGram(rare)["不由得"], undefined, "appears twice (<3) → dropped")

  // header stripping
  const withHeaders = [
    "**读者选择**：向北走", "夜色压下来，他向北走。",
    "**读者选择**：向北走", "夜色压下来，他向北走。",
    "**读者选择**：向北走", "夜色压下来，他向北走。",
  ].join("\n")
  const hp = computeNgramProfile(withHeaders, { minN: 2, maxN: 4, minCount: 3 })
  assert.ok(!hp.grams.some((x) => x.gram.includes("读者选择")), "structural header excluded")

  // no cross-sentence grams
  const xs = computeNgramProfile("你还好吗。今天不错。你还好吗。今天不错。你还好吗。今天不错。", { minN: 2, maxN: 2, minCount: 3 })
  assert.equal(byGram(xs)["吗今"], undefined, "no gram spans the sentence break")
})

test("handles latin word tokens (space-joined) and merges them too", () => {
  const text = "out of the blue. out of the blue. out of the blue."
  const profile = computeNgramProfile(text, { minN: 2, maxN: 4, minCount: 3 })
  const g = byGram(profile)
  // The maximal unit "out of the blue" wins; "out of"/"of the" fragments suppressed.
  assert.ok(g["out of the blue"], "maximal latin phrase surfaced")
  assert.equal(g["out of"], undefined, "latin fragment suppressed")
})

test("renderNgramProfile shows both columns, or null when nothing repeats enough", () => {
  assert.equal(renderNgramProfile(computeNgramProfile("一句独特的话。另一句不同的话。", { minCount: 3 })), null)

  const profile = computeNgramProfile("他仿佛看见了。她仿佛听见了。我仿佛懂了。风仿佛停了。", {
    minN: 2, maxN: 3, minCount: 3, recentText: "他仿佛看见了。",
  })
  const block = renderNgramProfile(profile)
  assert.match(block, /仿佛/)
  assert.match(block, /total/i)
  assert.match(block, /this turn/i)
})
