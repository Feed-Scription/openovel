import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"

import { updateNgramStore, buildTicReports, previewSelfCheckLines } from "../src/lib/ngramStore.js"

test("previewSelfCheckLines flags configured tic patterns + repeated phrases in a sample", () => {
  const sample = "他不由得停下。她不由得笑了。我不由得想起。" // 不由得 ×3
  const lines = previewSelfCheckLines(sample, "不由得")
  assert.equal(lines.length, 2)
  assert.match(lines[0], /tripped/)
  assert.match(lines[0], /不由得/)
  assert.match(lines[1], /Repeated phrases/)
  assert.match(lines[1], /不由得/)
})

test("previewSelfCheckLines reports a clean sample and the no-patterns state", () => {
  const clean = previewSelfCheckLines("黎明时分。傍晚降临。", "不由得")
  assert.match(clean[0], /none tripped/)
  assert.match(clean[1], /nothing repeats/)
  const noPatterns = previewSelfCheckLines("随便一句话。", "")
  assert.match(noPatterns[0], /none set/)
})

test("previewSelfCheckLines returns [] for blank prose", () => {
  assert.deepEqual(previewSelfCheckLines("", "不由得"), [])
  assert.deepEqual(previewSelfCheckLines("   ", "不由得"), [])
})

function tmpDir() {
  return path.join(os.tmpdir(), `openovel-ngramstore-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

test("folds only newly-appended prose — counts accumulate, deltas are per-run", async () => {
  const dir = tmpDir(); await mkdir(dir, { recursive: true })
  const chapters = path.join(dir, "chapters.md")
  const store = path.join(dir, "ngrams.json")

  await writeFile(chapters, "他不由得停。她不由得笑。\n") // 不由得 ×2
  let res = await updateNgramStore({ chaptersPath: chapters, storePath: store })
  assert.equal(res.counts.get("3 不由得")?.count, 2, "first fold counts 2")
  assert.equal(res.deltas.get("3 不由得"), 2, "delta = this run's increment")
  assert.ok(existsSync(store), "store persisted to disk")

  await appendFile(chapters, "我不由得想。风不由得停。\n") // +2 appended
  res = await updateNgramStore({ chaptersPath: chapters, storePath: store })
  assert.equal(res.counts.get("3 不由得")?.count, 4, "cumulative total now 4")
  assert.equal(res.deltas.get("3 不由得"), 2, "delta counts ONLY the appended part (incremental, not full re-scan)")

  res = await updateNgramStore({ chaptersPath: chapters, storePath: store })
  assert.equal(res.counts.get("3 不由得")?.count, 4, "no new prose → total unchanged")
  assert.equal(res.deltas.get("3 不由得"), undefined, "no new prose → empty delta")
})

test("recounts from scratch when the file shrank / was replaced (story reset)", async () => {
  const dir = tmpDir(); await mkdir(dir, { recursive: true })
  const chapters = path.join(dir, "chapters.md")
  const store = path.join(dir, "ngrams.json")
  await writeFile(chapters, "他不由得停。她不由得笑。我不由得想。") // ×3
  await updateNgramStore({ chaptersPath: chapters, storePath: store })
  await writeFile(chapters, "全新的开始，没有旧词。") // replaced with shorter content
  const res = await updateNgramStore({ chaptersPath: chapters, storePath: store })
  assert.equal(res.counts.get("3 不由得"), undefined, "stale counts cleared when the file shrank")
})

test("buildTicReports renders the ranked report + scans custom patterns over the increment", async () => {
  const dir = tmpDir(); await mkdir(dir, { recursive: true })
  const chapters = path.join(dir, "chapters.md")
  const store = path.join(dir, "ngrams.json")
  const prose = "他仿佛看见。她仿佛听见。我仿佛懂了。风仿佛停了。" // 仿佛 ×4
  await writeFile(chapters, prose)

  const { repeatedNgrams, ticPatternMatches } = await buildTicReports({
    chaptersPath: chapters,
    storePath: store,
    windowText: prose,
    ticPatternsText: "仿佛",
  })
  assert.match(repeatedNgrams, /仿佛/)
  assert.match(repeatedNgrams, /total/)
  assert.ok(ticPatternMatches, "custom-pattern report present when patterns configured")
  assert.match(ticPatternMatches, /仿佛/)
})

test("store keeps the COMPLETE table — low-count grams are retained (no pruning)", async () => {
  const dir = tmpDir(); await mkdir(dir, { recursive: true })
  const chapters = path.join(dir, "chapters.md")
  const store = path.join(dir, "ngrams.json")
  await writeFile(chapters, "独一无二的句子。") // every gram occurs once
  await updateNgramStore({ chaptersPath: chapters, storePath: store })
  const raw = JSON.parse(await readFile(store, "utf8"))
  assert.ok(Object.values(raw.counts).some((c) => c === 1), "singleton grams are kept in the full table")
})

test("buildTicReports returns null custom report when no patterns configured", async () => {
  const dir = tmpDir(); await mkdir(dir, { recursive: true })
  const chapters = path.join(dir, "chapters.md")
  await writeFile(chapters, "他仿佛看见。她仿佛听见。我仿佛懂了。")
  const { ticPatternMatches } = await buildTicReports({
    chaptersPath: chapters,
    storePath: path.join(dir, "ngrams.json"),
    windowText: "他仿佛看见。",
    ticPatternsText: "",
  })
  assert.equal(ticPatternMatches, null)
})
