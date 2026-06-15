// rehype plugin: wrap quoted dialogue in <span class="dq"> so the reading view
// can tint spoken lines a different colour. Handles full-width curly quotes
// (“…”), straight ASCII quotes ("…"), and CJK corner brackets — both single
// 「…」 and double/white 『…』 (common in Chinese/Japanese fiction dialogue).
// Highlighting begins at the OPENING mark: while a line is still streaming, an
// open-but-unclosed quote tints from the opener through the end of the text, so
// speech lights up the moment the opening mark arrives rather than at the closer.
//
// Wired AFTER streamdown's sanitize/harden defaults (see Entry.jsx) so the
// spans we add are not stripped. Colour inherits, so any token-level spans
// a streaming-animation plugin adds inside still pick up the dialogue tint.
//
// Per mark style the closed pair is tried first; only if there is no closer
// does the open-to-end alternative match. A 『…』 nested inside 「…」 is swallowed
// by the outer span (one tint for the whole utterance), which is what we want.
const QUOTED = /“[^”]*”|“[^”]*$|"[^"]*"|"[^"]*$|「[^」]*」|「[^」]*$|『[^』]*』|『[^』]*$/g
const HAS_QUOTE = /[“"「『]/

// Don't tint quotes that are really code, not speech.
const SKIP_TAGS = new Set(["code", "pre"])

export function rehypeHighlightQuotes() {
  return (tree) => transform(tree)
}

function transform(node) {
  if (!Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    if (child.type === "text" && HAS_QUOTE.test(child.value)) {
      next.push(...splitDialogueQuoteSegments(child.value).map((segment) => (
        segment.quoted
          ? {
              type: "element",
              tagName: "span",
              properties: { className: ["dq"] },
              children: [{ type: "text", value: segment.text }],
            }
          : { type: "text", value: segment.text }
      )))
    } else {
      if (child.type === "element" && !SKIP_TAGS.has(child.tagName)) transform(child)
      next.push(child)
    }
  }
  node.children = next
}

export function splitDialogueQuoteSegments(value) {
  const out = []
  let last = 0
  let match
  QUOTED.lastIndex = 0
  while ((match = QUOTED.exec(value))) {
    if (match.index > last) out.push({ text: value.slice(last, match.index), quoted: false })
    out.push({ text: match[0], quoted: true })
    last = match.index + match[0].length
  }
  if (!out.length) return [{ text: value, quoted: false }]
  if (last < value.length) out.push({ text: value.slice(last), quoted: false })
  return out
}
