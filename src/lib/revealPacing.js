// Pure, Node-free narration reveal-pacing primitives. The single source of
// truth for HOW the local typewriter advances: which unit to reveal next, the
// per-unit delay (cpm-paced glyphs, frame-floored whitespace/punctuation), the
// extra clause/sentence pause at punctuation, and rich-fence detection.
//
// Used by the VM revealer (src/runtime/sessionViewModel.js, the real reading
// surface) AND by the Settings reveal-speed preview, so the preview's cadence
// is byte-for-byte the same as reading — including the punctuation pauses.
// Keep this module dependency-free so the browser bundle can import it.

// Extra clause/sentence pause layered ON TOP of a punctuation unit's own delay,
// so prose breathes at commas and stops the way a reader would.
export function punctuationDelayMs(char) {
  if (!char) return 0
  if (".!?。！？".includes(char)) return 240
  if (",;:、，；：".includes(char)) return 90
  if ("—…".includes(char)) return 140
  return 0
}

// Every visible glyph — CJK ideographs/kana/hangul AND Latin letters/digits —
// is revealed one character at a time, paced by cpm.
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/
const WORD_CHAR = /[A-Za-z0-9_À-ɏͰ-ϿЀ-ӿ]/

function isCjkChar(ch) {
  return !!ch && CJK_CHAR.test(ch)
}
function isWordChar(ch) {
  return !!ch && WORD_CHAR.test(ch)
}

// Given the full target text and a start index, return the next reveal unit:
//   { end, kind }  where kind ∈ "cjk" | "char" | "space" | "other".
export function nextRevealUnit(text, from) {
  const ch = text[from]
  if (isCjkChar(ch)) return { end: from + 1, kind: "cjk" }
  if (isWordChar(ch)) return { end: from + 1, kind: "char" }
  if (/\s/.test(ch)) {
    let i = from + 1
    while (i < text.length && /\s/.test(text[i])) i++
    return { end: i, kind: "space" }
  }
  return { end: from + 1, kind: "other" }
}

// Per-unit reveal delay. Visible glyphs (cjk/char) are paced by cpm; whitespace
// and punctuation advance on the next frame (their reading beat is added
// separately via punctuationDelayMs).
export function revealUnitDelayMs(kind, unitText, pacing) {
  const floor = pacing.frameMs
  if (kind === "cjk" || kind === "char") {
    return Math.max(floor, Math.round(60000 / pacing.cpm))
  }
  return floor
}

// Whether the reveal cursor (end of `prefix`) sits inside an open ```ovl:```
// fence — those blocks read as machine output and reveal at fence speed.
export function insideRichFence(prefix) {
  const re = /```([^\n`]*)/g
  let inFence = false
  let isOvl = false
  let m
  while ((m = re.exec(prefix))) {
    if (!inFence) { inFence = true; isOvl = /^\s*ovl:/i.test(m[1]) }
    else { inFence = false; isOvl = false }
  }
  return inFence && isOvl
}

// `ovl:` fences are CONTROL/RENDER channels, not prose: the typewriter must
// not type them at all (a fence body crawling out character by character is a
// raw protocol dump painted in front of the reader). Given the full streamed
// text and the reveal cursor, return the position the cursor should JUMP to:
//   - inside an ovl fence (or sitting on its opener line, even mid-opener
//     after a chunk seam): past the closing fence when it has arrived, else
//     to the end of the buffer (and the caller keeps jumping as more streams
//     in, since the cursor stays inside the fence).
//   - anywhere else: `from` unchanged (no jump).
export function richFenceSkipEnd(text, from) {
  const s = String(text || "")
  if (from >= s.length) return from
  const pastClose = (searchFrom) => {
    const close = s.indexOf("```", searchFrom)
    if (close < 0) return s.length
    let end = close + 3
    if (s[end] === "\r") end += 1
    if (s[end] === "\n") end += 1
    return end
  }
  if (insideRichFence(s.slice(0, from))) return pastClose(from)
  // Cursor on an ovl opener line (the opener may still be half-revealed when
  // a chunk seam split it, so test the whole line, not text at the cursor).
  const lineStart = s.lastIndexOf("\n", from - 1) + 1
  const lineEndIdx = s.indexOf("\n", lineStart)
  const line = s.slice(lineStart, lineEndIdx < 0 ? s.length : lineEndIdx)
  if (/^```\s*ovl:/i.test(line)) return pastClose(lineStart + 3)
  return from
}
