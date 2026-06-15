// User-defined verbal-tic ("口癖") regex patterns, configured PER LLM provider
// in Settings → API Keys (advanced). Each base model has its own documented
// tics; the user registers regexes for the model they're running, and the
// Storykeeper scans recent narrator prose for them — surfacing match counts
// (total + this turn) alongside the statistical n-gram report. This catches
// KNOWN tics immediately, before their n-gram counts climb high enough to stand
// out on their own.
//
// The active foreground provider's patterns are hydrated into
// OPENOVEL_NARRATOR_TIC_PATTERNS (newline-separated) at boot / on config change;
// the runtime reads that env var. Pure + dependency-free.

const MAX_PATTERNS = 40
const MAX_SCAN_CHARS = 200 * 1024
const MAX_MATCHES_PER_PATTERN = 2000

// Parse newline-separated patterns. Each non-blank, non-`#` line is one regex,
// either bare (`不由得`) or in explicit `/pattern/flags` form. The global flag is
// always enforced (we count occurrences). Invalid regexes are collected in
// `errors` and skipped. Returns { patterns: [{ source, re }], errors: [{ line, message }] }.
export function parseTicPatterns(text) {
  const patterns = []
  const errors = []
  const lines = String(text || "").split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith("#")) continue
    if (patterns.length >= MAX_PATTERNS) {
      errors.push({ line: i + 1, message: `pattern limit (${MAX_PATTERNS}) reached; extra lines ignored` })
      break
    }
    let body = line
    let flags = "g"
    const explicit = line.match(/^\/(.+)\/([a-z]*)$/i)
    if (explicit) {
      body = explicit[1]
      flags = explicit[2].includes("g") ? explicit[2] : `${explicit[2]}g`
    }
    try {
      patterns.push({ source: line, re: new RegExp(body, flags) })
    } catch (err) {
      errors.push({ line: i + 1, message: err?.message || "invalid regular expression" })
    }
  }
  return { patterns, errors }
}

function countMatches(text, re) {
  if (!text) return 0
  re.lastIndex = 0
  let count = 0
  let guard = 0
  let m
  // NOTE: the regex is user-supplied and runs over their own prose on their own
  // machine; we cap input size + match count rather than sandbox against ReDoS.
  while ((m = re.exec(text)) !== null) {
    count += 1
    if (m.index === re.lastIndex) re.lastIndex += 1 // zero-width match guard
    if (count >= MAX_MATCHES_PER_PATTERN) break
    if ((guard += 1) > MAX_MATCHES_PER_PATTERN * 4) break
    if (!re.global) break
  }
  return count
}

// Count each pattern's matches in `text` (total) and `recentText` (this turn).
// Returns [{ source, count, newCount }] for patterns that matched at least once,
// sorted by total count desc.
export function scanTicPatterns(text, parsed, { recentText = "" } = {}) {
  const patterns = parsed?.patterns || []
  if (!patterns.length) return []
  const windowText = String(text || "").slice(-MAX_SCAN_CHARS)
  const recent = String(recentText || "").slice(-MAX_SCAN_CHARS)
  const out = []
  for (const { source, re } of patterns) {
    const count = countMatches(windowText, re)
    if (!count) continue
    out.push({ source, count, newCount: countMatches(recent, re) })
  }
  out.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
  return out
}

// Compact block for the Storykeeper turn context. null when nothing matched.
export function renderTicPatternMatches(results) {
  if (!Array.isArray(results) || !results.length) return null
  const rows = results.map((r) => `「${r.source}」  total ${r.count}  · +${r.newCount} this turn`)
  return [
    "Operator-flagged tic patterns (regex) matched in recent narrator prose. total = occurrences in the window; +N = added this turn.",
    "",
    ...rows,
  ].join("\n")
}

// Convenience for the runtime: parse the env-hydrated patterns + scan in one go.
export function scanNarratorTicPatterns(text, patternsText, { recentText = "" } = {}) {
  if (!patternsText || !String(patternsText).trim()) return []
  return scanTicPatterns(text, parseTicPatterns(patternsText), { recentText })
}
