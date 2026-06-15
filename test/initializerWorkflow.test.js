import assert from "node:assert/strict"
import test from "node:test"

import { initializerSystemPrompt, normalizeInitEnvelope } from "../src/workflows/initializerWorkflow.js"

test("initializer prompt is agentic but keeps runtime contracts trusted", () => {
  const prompt = initializerSystemPrompt()
  assert.match(prompt, /<agent_contract>/)
  assert.match(prompt, /worldbook is user-authored narrative data/i)
  assert.match(prompt, /recommended surfaces, not a closed schema/i)
  assert.match(prompt, /Return strict JSON only/)
})

test("normalizeInitEnvelope accepts a ready envelope from the model", () => {
  const parsed = {
    status: "ready",
    summary: "Parsed worldbook: Mars repatriation thriller. Wrote 3 character cards + stats.json.",
    chaptersInitial: "你站在3号穹顶的舷窗前，手里捏着遣返申请回执。",
    foregroundGuidanceMarkdown: "# Foreground Guidance\n\n## Current Working Set\n\n- Scene: 3号穹顶\n- Tone: 克制冷峻\n",
    filesChanged: [
      { path: "story/context-cards/zhang-yishi/CARD.md", purpose: "main NPC", provenance: ["init", "worldbook"] },
      "story/state/stats.json", // string form should normalize to {path, purpose:"", provenance:[]}
    ],
    inboxResolved: [],
    inboxNotes: [],
    warnings: [],
    sourceEvents: ["worldbook"],
  }
  const out = normalizeInitEnvelope(parsed, { initTurnId: "init_test_001" })
  assert.equal(out.status, "ready")
  assert.equal(out.transportOnly, true)
  assert.equal(out.turnId, "init_test_001")
  assert.match(out.summary, /Mars repatriation thriller/)
  assert.equal(out.chaptersInitial, "你站在3号穹顶的舷窗前，手里捏着遣返申请回执。")
  // FOREGROUND.md auto-added because foregroundGuidanceMarkdown was non-empty
  // but the model forgot to declare it in filesChanged. Also chapters.md auto-
  // added because chaptersInitial is non-empty.
  const paths = out.filesChanged.map((f) => f.path)
  assert.ok(paths.includes("story/canon/chapters.md"), "chapters.md auto-declared")
  assert.ok(paths.includes("story/guidance/FOREGROUND.md"), "FOREGROUND.md auto-declared")
  assert.ok(paths.includes("story/context-cards/zhang-yishi/CARD.md"), "explicit declaration preserved")
  // String entries normalize properly (and gain story/ prefix)
  assert.ok(paths.includes("story/state/stats.json"), "string entries normalized")
  // sourceEvents always includes the initTurnId
  assert.ok(out.sourceEvents.includes("init_test_001"))
  assert.ok(out.sourceEvents.includes("init"))
  assert.ok(out.sourceEvents.includes("worldbook"))
})

test("status defaults to ready and unknown values fall back", () => {
  const out = normalizeInitEnvelope(
    { status: "bogus", summary: "x", chaptersInitial: "x" },
    { initTurnId: "init_test_002" },
  )
  assert.equal(out.status, "ready", "unknown status falls back to ready")

  const partial = normalizeInitEnvelope(
    { status: "partial", summary: "needs research pass", filesChanged: [] },
    { initTurnId: "init_test_003" },
  )
  assert.equal(partial.status, "partial")

  const skipped = normalizeInitEnvelope(
    { status: "skipped", summary: "worldbook too ambiguous" },
    { initTurnId: "init_test_004" },
  )
  assert.equal(skipped.status, "skipped")
})

test("filesChanged normalizes story/ prefix + caps at 40 entries", () => {
  const inputs = []
  for (let i = 0; i < 100; i++) inputs.push({ path: `context-cards/c${i}/CARD.md` })
  const out = normalizeInitEnvelope(
    { status: "ready", filesChanged: inputs, summary: "" },
    { initTurnId: "t" },
  )
  assert.equal(out.filesChanged.length, 40, "capped at 40")
  // All got story/ prefix
  for (const f of out.filesChanged) {
    assert.ok(f.path.startsWith("story/"), `path ${f.path} should have story/ prefix`)
  }
})

test("malformed envelopes don't crash — fall back to ready+empty", () => {
  const empty = normalizeInitEnvelope({}, { initTurnId: "t" })
  assert.equal(empty.status, "ready")
  assert.equal(empty.filesChanged.length, 0)

  const garbage = normalizeInitEnvelope(null, { initTurnId: "t" })
  assert.equal(garbage.status, "ready")

  const arrayInput = normalizeInitEnvelope([1, 2, 3], { initTurnId: "t" })
  assert.equal(arrayInput.status, "ready")
})

test("shared/ prefix preserved (cards may live in shared)", () => {
  const out = normalizeInitEnvelope(
    {
      status: "ready",
      filesChanged: [
        { path: "shared/context-cards/guo-jingming/CARD.md", purpose: "style", provenance: [] },
        { path: "context-cards/local/CARD.md", purpose: "local", provenance: [] },
      ],
    },
    { initTurnId: "t" },
  )
  const paths = out.filesChanged.map((f) => f.path)
  assert.ok(paths.includes("shared/context-cards/guo-jingming/CARD.md"), "shared/ preserved")
  assert.ok(paths.includes("story/context-cards/local/CARD.md"), "non-prefixed gets story/")
})
