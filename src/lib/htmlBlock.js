// HTML block-template sanitizer for the format contract (see formatContract.js).
//
// A rich block's `template` is an HTML FRAGMENT the background model authors
// natively (the model is fluent in HTML+CSS; the old primitive-JSON DSL appeared
// nowhere in its training corpus, so it composed it badly). This module is the
// trust boundary on that HTML:
//
//   sanitizeBlockHtml(html) -> { tree, issues }
//
//   tree   = a sanitized, JSON-serializable HAST root the renderer walks into
//            React elements (NO innerHTML). Audited lib `hast-util-sanitize`
//            removes every disallowed tag/attr; inline `style=""` is then run
//            through the SAME CSS property allowlist as the `.css` channel.
//   issues = a SPECIFIC list of what the model wrote that is NOT permitted
//            (`<iframe> tag is not allowed`, `attribute "onclick" on <div> ...`,
//            `inline style "position" on <span> ...`). The write-gate
//            (registerTools.js) REJECTS a contract whose templates produce any
//            issue and hands this list back so the model fixes and retries; the
//            same sanitized `tree` is used at load time as defense-in-depth.
//
// Allowlist (closed) over tagNames + attributes is the only widening surface and
// only widens with a reviewed host change. Slot placeholders (`{{name}}`) live in
// TEXT nodes and are filled as plain text by the renderer, so slot values are
// never injectable. Total: never throws; fails CLOSED (drop on doubt).

import { fromHtml } from "hast-util-from-html"
import { sanitize } from "hast-util-sanitize"
import { sanitizeInlineStyle } from "./cssSanitizer.js"

// Semantic, presentational, content-bearing tags. NO script/style/iframe/object/
// embed/form controls/links/media/svg/math: those are stripped (and rejected by
// the write-gate). Inner layout is the model's to compose from these.
const ALLOWED_TAGS = new Set([
  "div", "span", "p",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "b", "i", "u", "s", "del", "ins",
  "br", "hr", "blockquote", "q", "cite",
  "code", "pre", "kbd", "samp", "var",
  "figure", "figcaption", "small", "sub", "sup", "mark", "abbr", "time",
])

// hast property names (camelCased, as `hast-util-from-html` emits) allowed on any
// element. `style` is allowed here but every declaration is then filtered.
const GLOBAL_ATTRS = new Set(["className", "title", "style"])
// Extra attrs only on table cells.
const CELL_ATTRS = new Set(["colSpan", "rowSpan"])
const CELL_TAGS = new Set(["td", "th"])

const MAX_HTML_CHARS = 20000
const MAX_DEPTH = 24

// hast-util-sanitize schema, derived from the SAME allowlists so the audited
// clean tree and our issue walker can never drift. `strip` lists tags whose TEXT
// content is also dropped (otherwise sanitize lifts a <script>'s body up as
// visible text). Unlisted-but-disallowed tags are unwrapped (children kept).
const SANITIZE_SCHEMA = {
  tagNames: [...ALLOWED_TAGS],
  attributes: {
    "*": ["className", "title", "style"],
    td: ["className", "title", "style", "colSpan", "rowSpan"],
    th: ["className", "title", "style", "colSpan", "rowSpan"],
  },
  strip: [
    "script", "style", "iframe", "object", "embed", "noscript", "template",
    "form", "input", "textarea", "select", "button", "option",
    "link", "meta", "base", "head", "title", "svg", "math", "img", "a",
  ],
  protocols: {},
  clobber: [],
  clobberPrefix: "",
  allowComments: false,
  allowDoctypes: false,
}

// Friendly attribute name for a message: lowercase the hast property name, which
// recovers the HTML attribute the model wrote for the common cases (onClick ->
// onclick, href -> href, id -> id).
function attrLabel(key) {
  return String(key || "").toLowerCase()
}

// Walk the ORIGINAL (pre-sanitize) tree to COLLECT specific issues for the
// write-gate. Does not mutate. Descends into disallowed tags too so a nested
// allowed-tag-with-bad-attr is still named.
function collectIssues(root) {
  const issues = []
  const seenTag = new Set()
  const visit = (node) => {
    if (!node || typeof node !== "object") return
    if (node.type === "element") {
      const tag = node.tagName
      if (!ALLOWED_TAGS.has(tag)) {
        if (!seenTag.has(tag)) { issues.push(`<${tag}> tag is not allowed`); seenTag.add(tag) }
      } else {
        const props = node.properties || {}
        for (const key of Object.keys(props)) {
          if (key === "style") {
            const { dropped } = sanitizeInlineStyle(props.style)
            for (const d of dropped) {
              issues.push(`inline style "${d.prop}" on <${tag}> is not allowed (${d.reason})`)
            }
            continue
          }
          const ok = GLOBAL_ATTRS.has(key) || (CELL_TAGS.has(tag) && CELL_ATTRS.has(key))
          if (!ok) issues.push(`attribute "${attrLabel(key)}" on <${tag}> is not allowed`)
        }
      }
    }
    const kids = node.children
    if (Array.isArray(kids)) for (const c of kids) visit(c)
  }
  visit(root)
  return issues
}

// Walk the SANITIZED tree to (a) re-filter every inline `style` through the CSS
// allowlist, (b) drop `position`/`data` metadata so the tree stays small over
// IPC. Mutates in place and returns the deepest nesting level seen.
function finalizeTree(root) {
  let maxDepth = 0
  const visit = (node, depth) => {
    if (!node || typeof node !== "object") return
    if (depth > maxDepth) maxDepth = depth
    if (node.position) delete node.position
    if (node.type === "element") {
      const props = node.properties
      if (props && typeof props.style === "string") {
        const { style } = sanitizeInlineStyle(props.style)
        if (style) props.style = style
        else delete props.style
      }
    }
    const kids = node.children
    if (Array.isArray(kids)) for (const c of kids) visit(c, depth + 1)
  }
  visit(root, 0)
  return maxDepth
}

// Does the tree carry any renderable element? (an all-stripped template -> drop)
function hasElement(node) {
  if (!node || typeof node !== "object") return false
  if (node.type === "element") return true
  const kids = node.children
  if (Array.isArray(kids)) return kids.some(hasElement)
  return false
}

export function sanitizeBlockHtml(input) {
  const issues = []
  let html = String(input ?? "")
  if (html.length > MAX_HTML_CHARS) {
    issues.push(`template is ${html.length} chars, over the ${MAX_HTML_CHARS} limit (trim it)`)
    html = html.slice(0, MAX_HTML_CHARS)
  }
  let parsed
  try {
    parsed = fromHtml(html, { fragment: true })
  } catch {
    // fromHtml is tolerant, but never let a parse fault escape.
    return { tree: { type: "root", children: [] }, issues, empty: true }
  }
  // Collect issues from what the model actually wrote (pre-sanitize).
  for (const issue of collectIssues(parsed)) issues.push(issue)
  // Produce the audited clean tree (defense-in-depth) and finalize it.
  let clean
  try {
    clean = sanitize(parsed, SANITIZE_SCHEMA)
  } catch {
    return { tree: { type: "root", children: [] }, issues, empty: true }
  }
  if (clean.type !== "root") clean = { type: "root", children: clean ? [clean] : [] }
  const depth = finalizeTree(clean)
  if (depth > MAX_DEPTH) issues.push(`template nests ${depth} levels deep, over the ${MAX_DEPTH} limit (flatten it)`)
  const empty = !hasElement(clean)
  return { tree: clean, issues, empty }
}

export const _internals = { ALLOWED_TAGS, GLOBAL_ATTRS, CELL_ATTRS, SANITIZE_SCHEMA, MAX_HTML_CHARS, MAX_DEPTH }
