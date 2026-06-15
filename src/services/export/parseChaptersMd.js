// Parse story/canon/chapters.md into structured chapters.
//
// The file is an append-only log written by sessionProcessor.js (see
// appendChapterText). Each turn writes a block of the shape:
//
//   \n\n**读者选择**：<reader action text>\n\n<narration paragraphs>\n
//
// We split on the `**读者选择**：` header marker to recover one chapter per
// turn. The action text becomes the chapter's subtitle; the body becomes the
// chapter's prose paragraphs (one entry per blank-line-separated block).
//
// For exports we want pure prose, so the action header line is NOT included
// inside the chapter body — it's surfaced as metadata instead. UIs can then
// choose to render it as a subtitle (TXT/EPUB) or drop it entirely (pure
// novel mode).

// Matches the action header that appendChapterText writes. The marker is
// hard-coded to "**读者选择**：" today; if it ever becomes locale-aware we
// should extend the alternation here.
const ACTION_HEADER_RE = /^\*\*读者选择\*\*[：:]\s*(.*?)\s*$/m

export function parseChaptersMd(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim()
  if (!raw) return []
  // Split on the action header keeping the header as the section boundary.
  // We use a manual scan rather than .split() because we need to keep the
  // captured action text alongside each block.
  const chapters = []
  let cursor = 0
  let turnIndex = 0
  while (cursor < raw.length) {
    const slice = raw.slice(cursor)
    const match = ACTION_HEADER_RE.exec(slice)
    if (!match) {
      // No more headers. If we have leftover prose at the very start of the
      // file (e.g. legacy stories without action markers), treat it as one
      // unlabeled prologue chapter.
      const body = slice.trim()
      if (body) {
        chapters.push({
          turn: turnIndex + 1,
          action: "",
          paragraphs: splitParagraphs(body),
        })
      }
      break
    }
    // Anything before this header is either prologue (turnIndex===0 only) or
    // the previous chapter's trailing whitespace — skip it.
    if (match.index > 0 && turnIndex === 0) {
      const prelude = slice.slice(0, match.index).trim()
      if (prelude) {
        chapters.push({
          turn: 0,
          action: "",
          paragraphs: splitParagraphs(prelude),
        })
      }
    }
    // Find where this chapter's body ends — the next header or EOF.
    const bodyStart = match.index + match[0].length
    const remainder = slice.slice(bodyStart)
    const nextHeaderRel = ACTION_HEADER_RE.exec(remainder)
    const bodyText = nextHeaderRel
      ? remainder.slice(0, nextHeaderRel.index)
      : remainder
    const paragraphs = splitParagraphs(bodyText)
    turnIndex += 1
    chapters.push({
      turn: turnIndex,
      action: String(match[1] || "").trim(),
      paragraphs,
    })
    cursor += bodyStart + (nextHeaderRel ? nextHeaderRel.index : remainder.length)
  }
  return chapters
}

function splitParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\s+|\s+$/g, ""))
    .filter(Boolean)
}
