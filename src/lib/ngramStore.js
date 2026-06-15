// Incremental, file-backed n-gram tic counter.
//
// The pure profiler (ngramProfile.js) re-tokenizes whatever text it's handed.
// Doing that over the full prose window every Storykeeper turn is wasteful and
// caps "total" at the window size. Instead we persist accumulated counts plus a
// byte checkpoint into canon/chapters.md, and each turn fold ONLY the prose
// appended since last run. Counts are therefore cumulative across the whole
// story (cheaply), and the per-run increment doubles as the "added this turn"
// delta. Robust to the Storykeeper's singleton-loop coalescing (one run can
// cover several turns) and to crashes: the checkpoint advances only after a
// successful fold, and re-reading past the checkpoint yields an empty increment.

import { open, stat } from "node:fs/promises"
import { readJson, writeJson } from "./files.js"
import { countNgrams, computeNgramProfile, rankNgramCandidates, renderNgramGrams } from "./ngramProfile.js"
import { parseTicPatterns, scanTicPatterns, renderTicPatternMatches } from "./ticPatterns.js"

const STORE_VERSION = 1
const MIN_N = 2
const MAX_N = 6
// First run on an existing story backfills only recent prose, not the entire
// (possibly multi-MB) history — that one-time read would otherwise be huge.
const INITIAL_BACKFILL_BYTES = 512 * 1024
// How many ranked phrases to surface in the report shown to the Storykeeper.
// The store keeps the COMPLETE counts table; this only bounds the rendered view.
const REPORT_TOP = 50

// Read bytes [startByte, EOF) of a file as UTF-8. Appends are whole UTF-8
// strings, so the byte length is always on a char boundary — no split chars.
async function readFrom(file, startByte) {
  let size = 0
  try { size = (await stat(file)).size } catch { return { text: "", size: 0 } }
  if (startByte >= size) return { text: "", size }
  const fh = await open(file, "r")
  try {
    const len = size - startByte
    const buf = Buffer.allocUnsafe(len)
    await fh.read(buf, 0, len, startByte)
    return { text: buf.toString("utf8"), size }
  } finally {
    await fh.close()
  }
}

function normalizeStore(raw) {
  if (raw && raw.version === STORE_VERSION && typeof raw.processedBytes === "number" && raw.counts && typeof raw.counts === "object") {
    return raw
  }
  return { version: STORE_VERSION, processedBytes: 0, counts: {} }
}

// Fold prose appended to chaptersPath since last run into the persisted store.
// Returns { counts: Map(key -> {n,gram,count}), deltas: Map(key -> count), incrementText }.
export async function updateNgramStore({ chaptersPath, storePath }) {
  const store = normalizeStore(await readJson(storePath, null))

  let curSize = 0
  try { curSize = (await stat(chaptersPath)).size } catch { curSize = 0 }

  let start = store.processedBytes
  // First-ever fold on an existing story → start from a recent backfill point.
  if (start === 0 && curSize > INITIAL_BACKFILL_BYTES) start = curSize - INITIAL_BACKFILL_BYTES
  // File shrank/replaced (story reset/switch reusing the same path) → recount
  // from the backfill point so stale counts don't linger.
  if (start > curSize) {
    store.counts = {}
    start = curSize > INITIAL_BACKFILL_BYTES ? curSize - INITIAL_BACKFILL_BYTES : 0
  }

  const { text: incrementText, size } = await readFrom(chaptersPath, start)
  const deltas = new Map()
  if (incrementText) {
    const { counts } = countNgrams(incrementText, MIN_N, MAX_N)
    for (const { n, gram, count } of counts.values()) {
      const key = `${n} ${gram}`
      deltas.set(key, count)
      store.counts[key] = (store.counts[key] || 0) + count
    }
  }
  store.processedBytes = size
  // Keep the COMPLETE counts table — no pruning. Slowly-accumulating tics
  // (one occurrence every few turns) must survive to cross the report
  // threshold, and a long story's full table is still small JSON.
  await writeJson(storePath, store)

  const total = new Map()
  for (const [key, count] of Object.entries(store.counts)) {
    const sep = key.indexOf(" ")
    const n = Number(key.slice(0, sep))
    const gram = key.slice(sep + 1)
    total.set(key, { n, gram, count })
  }
  return { counts: total, deltas, incrementText }
}

// Self-check a one-off preview sample with the SAME detectors used on live
// prose — the operator's configured tic regexes + repeated phrases — so the
// init narrator-preview tool can flag tics in the audition before the story
// opens. Pure (no I/O); returns display lines (empty when prose is blank).
// minCount is 2 because a preview sample is short: even a phrase repeated twice
// is worth surfacing here.
export function previewSelfCheckLines(prose, patternsText = "") {
  const text = String(prose || "")
  if (!text.trim()) return []
  const lines = []
  if (patternsText && patternsText.trim()) {
    const hits = scanTicPatterns(text, parseTicPatterns(patternsText), {})
    lines.push(hits.length
      ? `⚠ Configured tic patterns tripped: ${hits.map((h) => `「${h.source}」×${h.count}`).join(", ")} — operator-flagged tics for this model; revise tone.md / forbidden.md so the voice avoids them, then preview again.`
      : "✓ Configured tic patterns: none tripped by this sample.")
  } else {
    lines.push("Configured tic patterns: none set for this model.")
  }
  const grams = computeNgramProfile(text, { minCount: 2, top: 12 }).grams
  lines.push(grams.length
    ? `Repeated phrases in this sample: ${grams.map((g) => `「${g.gram}」×${g.count}`).join("  ")}`
    : "Repeated phrases in this sample: nothing repeats twice or more.")
  return lines
}

// One-stop builder for the Storykeeper's two tic reports:
//   - repeatedNgrams: ranked maximal-unit phrases from the cumulative store,
//     with this-run's increment as the per-phrase "added this turn" delta.
//   - ticPatternMatches: operator regexes scanned over `windowText` (total) +
//     the increment (this turn). null when no patterns are configured.
export async function buildTicReports({ chaptersPath, storePath, windowText = "", ticPatternsText = "" }) {
  const { counts, deltas, incrementText } = await updateNgramStore({ chaptersPath, storePath })
  const grams = rankNgramCandidates([...counts.values()], {
    top: REPORT_TOP,
    newCountOf: (n, gram) => deltas.get(`${n} ${gram}`),
  })
  const repeatedNgrams = renderNgramGrams(grams)
  const ticPatternMatches = ticPatternsText && ticPatternsText.trim()
    ? renderTicPatternMatches(scanTicPatterns(windowText, parseTicPatterns(ticPatternsText), { recentText: incrementText }))
    : null
  return { repeatedNgrams, ticPatternMatches }
}
