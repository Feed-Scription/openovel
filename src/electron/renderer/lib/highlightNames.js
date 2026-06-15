// rehype plugin factory: wrap character names in <span class="np"> so the
// reading view can tint the cast. The name list comes from CHARACTER context
// cards (card name + triggers, VM state `characterNames`), pre-sorted longest
// first so an alias contained in a longer alias never shadows it. Latin names
// match on word boundaries (so "Ann" never lights inside "Anna"); CJK names
// match as substrings (no word boundaries exist).
//
// Wired AFTER streamdown's sanitize/harden defaults and after the dialogue
// quote tint (see Entry.jsx) — a name inside a quoted line nests its span
// inside the .dq span and takes the name tint over the dialogue tint.

const SKIP_TAGS = new Set(["code", "pre"])
const ASCII_RE = /^[\x20-\x7e]+$/

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// One alternation over all names, longest-first (the list arrives pre-sorted;
// sort again defensively since match preference follows alternation order).
export function buildNameRegex(names = []) {
  const cleaned = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  if (!cleaned.length) return null
  const parts = cleaned.map((name) =>
    ASCII_RE.test(name) ? `\\b${escapeRegex(name)}\\b` : escapeRegex(name),
  )
  return new RegExp(parts.join("|"), "gu")
}

export function splitNameSegments(value, regex) {
  const out = []
  let last = 0
  let match
  regex.lastIndex = 0
  while ((match = regex.exec(value))) {
    if (match.index > last) out.push({ text: value.slice(last, match.index), name: false })
    out.push({ text: match[0], name: true })
    last = match.index + match[0].length
    if (match[0].length === 0) regex.lastIndex += 1 // safety: never loop on an empty match
  }
  if (!out.length) return [{ text: value, name: false }]
  if (last < value.length) out.push({ text: value.slice(last), name: false })
  return out
}

export function rehypeHighlightNames(names = []) {
  const regex = buildNameRegex(names)
  return () => (tree) => {
    if (regex) transform(tree, regex)
  }
}

function transform(node, regex) {
  if (!Array.isArray(node.children)) return
  const next = []
  for (const child of node.children) {
    regex.lastIndex = 0
    if (child.type === "text" && regex.test(child.value)) {
      next.push(...splitNameSegments(child.value, regex).map((segment) => (
        segment.name
          ? {
              type: "element",
              tagName: "span",
              properties: { className: ["np"] },
              children: [{ type: "text", value: segment.text }],
            }
          : { type: "text", value: segment.text }
      )))
    } else {
      if (child.type === "element" && !SKIP_TAGS.has(child.tagName)) transform(child, regex)
      next.push(child)
    }
  }
  node.children = next
}
