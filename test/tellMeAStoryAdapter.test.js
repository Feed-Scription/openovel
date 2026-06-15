import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import {
  buildEvalGoal,
  convertTellMeAStoryExample,
  loadTellMeAStoryExamples,
  prepareTellMeAStoryCases,
} from "../src/eval/tellMeAStoryAdapter.js"

test("Tell Me A Story JSONL loader accepts rows with inputs", () => {
  const rows = loadTellMeAStoryExamples(
    [
      JSON.stringify({ example_id: "a", inputs: "Write a story about a moon courier.", targets: "Target story." }),
      JSON.stringify({ example_id: "skip", targets: "No input." }),
    ].join("\n"),
  )

  assert.equal(rows.length, 1)
  assert.equal(rows[0].example_id, "a")
})

test("Tell Me A Story example converts to Openovel eval case without feeding target to player", () => {
  const item = convertTellMeAStoryExample(
    {
      example_id: "mars-001",
      inputs: "A botanist on Mars must decide whether to betray a colony to save Earth.",
      targets: "Human reference story text.",
    },
    { split: "validation", turns: 50, variants: "control,no-background" },
  )

  assert.equal(item.caseId, "tms_mars-001")
  assert.match(item.openovelOpening, /Tell Me A Story writing prompt/)
  assert.match(item.evalGoal, /A botanist on Mars/)
  assert.doesNotMatch(item.evalGoal, /Human reference story text/)
  assert.equal(item.referenceTarget, "Human reference story text.")
  assert.match(item.targetUse, /evaluator-only/)
})

test("Tell Me A Story prepare writes case files and manifest", async () => {
  const root = path.join(os.tmpdir(), `openovel-tms-${Date.now()}`)
  const dataset = path.join(root, "validation.jsonl")
  const outDir = path.join(root, "cases")
  await mkdir(root, { recursive: true })
  await writeFile(
    dataset,
    [
      JSON.stringify({ example_id: "one", inputs: "A clockmaker finds a second sun.", targets: "Reference one." }),
      JSON.stringify({ example_id: "two", inputs: "A child maps a city of glass.", targets: "Reference two." }),
    ].join("\n"),
  )

  const result = await prepareTellMeAStoryCases({
    dataset,
    outDir,
    split: "validation",
    limit: 1,
    includeTargets: false,
  })

  assert.equal(result.count, 1)
  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"))
  assert.equal(manifest.count, 1)
  const caseFile = JSON.parse(await readFile(path.join(outDir, "tms_one.json"), "utf8"))
  assert.equal(caseFile.referenceTarget, "")
  assert.match(caseFile.evalGoal, /clockmaker/)
})

test("Tell Me A Story eval goal stresses prompt fulfillment and long-run anchors", () => {
  const goal = buildEvalGoal({
    inputPrompt: "A courier carries a forbidden song across a desert empire.",
    turns: 50,
  })

  assert.match(goal, /50 turns/)
  assert.match(goal, /premise, characters, objects, locations/)
  assert.match(goal, /revisit early anchors/)
  assert.match(goal, /forbidden song/)
})
