import test from "node:test"
import assert from "node:assert/strict"

import {
  parseTicPatterns,
  scanTicPatterns,
  scanNarratorTicPatterns,
  renderTicPatternMatches,
} from "../src/lib/ticPatterns.js"

test("parses bare + /pattern/flags lines, skips blanks/comments, collects invalid", () => {
  const { patterns, errors } = parseTicPatterns("不由得\n/仿佛/i\n# a comment\n\n(unclosed")
  assert.equal(patterns.length, 2)
  assert.equal(patterns[0].source, "不由得")
  assert.ok(patterns[1].re.flags.includes("g"), "global always enforced for counting")
  assert.ok(patterns[1].re.flags.includes("i"), "explicit flags preserved")
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 5, "invalid regex reported with its line number")
})

test("counts total + this-turn occurrences per pattern", () => {
  const windowText = "他不由得停。她不由得笑。我不由得想。" // 不由得 ×3
  const recentText = "他不由得停。"                          // ×1 this turn
  const res = scanTicPatterns(windowText, parseTicPatterns("不由得"), { recentText })
  assert.equal(res.length, 1)
  assert.equal(res[0].count, 3)
  assert.equal(res[0].newCount, 1)
})

test("supports real regexes (not just literals) and drops zero-match patterns", () => {
  const res = scanTicPatterns(
    "他仿佛看见。她仿佛听见。",
    parseTicPatterns("/仿佛.{0,2}(?:看|听)/\n从来不出现"),
    {},
  )
  assert.equal(res.length, 1, "the never-matching literal is dropped")
  assert.match(res[0].source, /仿佛/)
  assert.equal(res[0].count, 2)
})

test("scanNarratorTicPatterns short-circuits empty config; render is null when nothing matched", () => {
  assert.deepEqual(scanNarratorTicPatterns("text", ""), [])
  assert.deepEqual(scanNarratorTicPatterns("text", "   "), [])
  assert.equal(renderTicPatternMatches([]), null)

  const block = renderTicPatternMatches([{ source: "不由得", count: 5, newCount: 2 }])
  assert.match(block, /不由得/)
  assert.match(block, /total 5/)
  assert.match(block, /\+2 this turn/)
})

test("zero-width / greedy patterns terminate via the match cap", () => {
  const res = scanTicPatterns("aaaa bbbb aaaa", parseTicPatterns("a*"), {})
  assert.equal(res.length, 1)
  assert.ok(res[0].count > 0 && res[0].count <= 2000, "bounded, not infinite")
})
