// Pure, dependency-free n-gram frequency profiler over narrative prose.
//
// Purpose: surface the narrator's most-repeated phrases ("口癖" / verbal tics)
// to the Storykeeper so it can tell genuine tics from legitimately-recurring
// named entities and tighten foreground guidance to reduce them. The runtime
// computes this; the model reads it.
//
// Two refinements over a plain fixed-n counter:
//   1. TWO COUNTS per phrase — total (cumulative) occurrences, and how many were
//      added by THIS turn's narration (a phrase whose this-turn count keeps
//      climbing is a tic taking hold).
//   2. MAXIMAL-UNIT MERGING — overlapping fragments are collapsed into the
//      longest repeated unit, so e.g. 人工智能 is counted as ONE phrase rather
//      than reported as its overlapping pieces 人工智 / 工智能. A shorter gram is
//      kept only when it recurs meaningfully MORE than the longest kept gram
//      that contains it (i.e. it lives outside that unit too).
//
// This module is stateless. The incremental, file-backed counter that folds one
// turn's prose at a time lives in ngramStore.js and reuses countNgrams +
// rankNgramCandidates here.
//
// Tokenization is deliberately cheap and multilingual (no segmenter dependency):
// each CJK ideograph / kana / hangul char is its own token; runs of latin
// letters + digits are word tokens; everything else is a boundary. N-grams are
// built WITHIN sentence segments so a gram never spans an unrelated sentence.

const CJK_CLASS = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af"
const TOKEN_RE = new RegExp(`[${CJK_CLASS}]|[A-Za-z0-9][A-Za-z0-9'’]*`, "g")
const SEGMENT_SPLIT_RE = /[。！？!?；;\n\r…]+/
const LATIN_RE = /[A-Za-z0-9]/

// Reader-action header lines the runtime injects into chapters.md
// (e.g. `**读者选择**：<action>`) are structural + reader-authored, not narrator
// prose — strip them so they don't dominate the counts.
function stripStructuralLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\*\*[^*\n]{1,24}\*\*\s*[：:]/.test(line))
    .join("\n")
}

function renderGram(tokens) {
  // CJK char-tokens read naturally with no separator; use spaces once any latin
  // word token is involved (so the gram stays token-aligned + reversible).
  return tokens.some((t) => LATIN_RE.test(t)) ? tokens.join(" ") : tokens.join("")
}

// Reverse of renderGram: a space means latin word tokens; otherwise CJK chars.
function gramTokens(gram) {
  return gram.includes(" ") ? gram.split(" ") : [...gram]
}

// Is `needle` a strictly-shorter contiguous subsequence of `haystack`?
function containsSeq(haystack, needle) {
  if (needle.length >= haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

// Count every n-gram for n in [minN, maxN] within sentence segments.
// Returns { counts: Map(key -> { n, gram, count }), tokensAnalyzed }, key = `${n} ${gram}`.
// Exported so the incremental store can fold one increment of prose at a time
// using the exact same tokenization + segmentation.
export function countNgrams(text, minN, maxN) {
  const cleaned = stripStructuralLines(text)
  const counts = new Map()
  let tokensAnalyzed = 0
  for (const segment of cleaned.split(SEGMENT_SPLIT_RE)) {
    const tokens = segment.match(TOKEN_RE)
    if (!tokens) continue
    tokensAnalyzed += tokens.length
    for (let n = minN; n <= maxN; n += 1) {
      if (tokens.length < n) continue
      for (let i = 0; i + n <= tokens.length; i += 1) {
        const gram = renderGram(tokens.slice(i, i + n))
        const key = `${n} ${gram}`
        const entry = counts.get(key)
        if (entry) entry.count += 1
        else counts.set(key, { n, gram, count: 1 })
      }
    }
  }
  return { counts, tokensAnalyzed }
}

// Merge a set of counted grams into maximal units and rank them. `entries` is
// [{ n, gram, count }] (from one text, or from the accumulated store). A shorter
// gram is dropped when it is essentially just a fragment of an already-kept
// longer gram (its count doesn't exceed the container's by more than keepFactor,
// i.e. it rarely occurs outside that unit), so e.g. 人工智能 wins over its
// overlapping pieces. `newCountOf(n, gram)` supplies the per-phrase "this turn"
// delta. Returns [{ gram, n, count, newCount }], top `top` by total count.
export function rankNgramCandidates(entries, { minCount = 3, top = 24, keepFactor = 1.4, newCountOf = null } = {}) {
  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.count >= minCount)
    .map((e) => ({ n: e.n, gram: e.gram, count: e.count, tokens: gramTokens(e.gram) }))
  candidates.sort((a, b) => b.n - a.n || b.count - a.count || a.gram.localeCompare(b.gram))
  const kept = []
  for (const g of candidates) {
    let maxContainerCount = 0
    for (const h of kept) {
      if (h.n > g.n && containsSeq(h.tokens, g.tokens) && h.count > maxContainerCount) {
        maxContainerCount = h.count
      }
    }
    if (maxContainerCount > 0 && g.count <= maxContainerCount * keepFactor) continue
    kept.push(g)
  }
  kept.sort((a, b) => b.count - a.count || b.n - a.n || a.gram.localeCompare(b.gram))
  return kept.slice(0, top).map((g) => ({
    gram: g.gram,
    n: g.n,
    count: g.count,
    newCount: newCountOf ? (newCountOf(g.n, g.gram) || 0) : 0,
  }))
}

// In-memory profile of a single text (tests + any non-incremental path).
// Returns { minN, maxN, tokensAnalyzed, grams: [{ gram, n, count, newCount }] }.
export function computeNgramProfile(text, {
  minN = 2,
  maxN = 6,
  minCount = 3,
  top = 24,
  keepFactor = 1.4,
  recentText = "",
} = {}) {
  const { counts, tokensAnalyzed } = countNgrams(text, minN, maxN)
  const recent = recentText ? countNgrams(recentText, minN, maxN).counts : new Map()
  const grams = rankNgramCandidates([...counts.values()], {
    minCount,
    top,
    keepFactor,
    newCountOf: (n, gram) => recent.get(`${n} ${gram}`)?.count,
  })
  return { minN, maxN, tokensAnalyzed, grams }
}

// Compact two-column block for the Storykeeper turn context. Takes the ranked
// grams array directly. Returns null when there's nothing worth surfacing.
export function renderNgramGrams(grams) {
  if (!Array.isArray(grams) || !grams.length) return null
  const rows = grams.map((g) => `「${g.gram}」  total ${g.count}  · +${g.newCount} this turn`)
  return [
    "Repeated phrases in recent narrator prose. total = cumulative occurrences; +N = added this turn.",
    "",
    ...rows,
  ].join("\n")
}

export function renderNgramProfile(profile) {
  return renderNgramGrams(profile?.grams)
}
