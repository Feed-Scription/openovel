import React from "react"
import { parseFence, fillSlots } from "../lib/richBlockModel.js"
import { IncludeBlock } from "./IncludeBlock.jsx"

// Generic renderer for a contract-defined rich block. ONE component renders
// every block kind by walking the kind's sanitized HTML `template` — an HAST
// tree the Node-side loader (formatContract.js → htmlBlock.js) already cleaned
// to a closed tag/attr allowlist with inline styles property-filtered. Block
// kinds are open (the model composes ordinary HTML); the HTML allowlist is the
// only closed list (the capability/security envelope).
//
// We build React ELEMENTS from the HAST (never innerHTML / dangerouslySetInnerHTML),
// so nothing the model wrote is interpreted as live markup. Slot placeholders
// (`{{name}}`) inside text nodes are filled as PLAIN TEXT from the parsed fence,
// so a slot value can never inject. The whole subtree is wrapped in `.ovl-rich`,
// the scope the CSS sanitizer prefixes every contract rule with. Rendering is a
// total function over partial `code` (streaming-safe): nothing here throws.

const OVL_CLASS_RE = /^ovl-[a-z0-9-]+$/
const MAX_DEPTH = 24
// Void elements in the allowlist — must not be given children.
const VOID_TAGS = new Set(["br", "hr"])

function safeClass(cls) {
  return typeof cls === "string" && OVL_CLASS_RE.test(cls) ? cls : ""
}
function cx(...parts) {
  return parts.filter(Boolean).join(" ")
}

// Parse an (already property-filtered) inline style string into a React style
// object: hyphenated props camelCased, custom properties (--x) left as-is.
function styleStringToObject(str) {
  const obj = {}
  for (const decl of String(str).split(";")) {
    const seg = decl.trim()
    if (!seg) continue
    const colon = seg.indexOf(":")
    if (colon < 0) continue
    const prop = seg.slice(0, colon).trim()
    const value = seg.slice(colon + 1).trim()
    if (!prop || !value) continue
    const camel = prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    obj[camel] = value
  }
  return Object.keys(obj).length ? obj : null
}

// Map a sanitized HAST element's `properties` to React props. Only the curated
// allowlist (className/title/style/colSpan/rowSpan) can be present after
// sanitize; we read it defensively regardless.
function propsFromHast(properties, key) {
  const props = { key }
  if (!properties || typeof properties !== "object") return props
  const cn = properties.className
  if (Array.isArray(cn) && cn.length) props.className = cn.join(" ")
  else if (typeof cn === "string" && cn) props.className = cn
  if (typeof properties.title === "string" && properties.title) props.title = properties.title
  if (typeof properties.style === "string" && properties.style) {
    const styleObj = styleStringToObject(properties.style)
    if (styleObj) props.style = styleObj
  }
  if (properties.colSpan != null) { const n = Number(properties.colSpan); if (Number.isFinite(n)) props.colSpan = n }
  if (properties.rowSpan != null) { const n = Number(properties.rowSpan); if (Number.isFinite(n)) props.rowSpan = n }
  return props
}

// Walk a sanitized HAST node into React. Text → fillSlots(plain text); element →
// React.createElement of its (allowlisted) tag. Depth-capped; unknown node
// shapes render nothing.
function renderHast(node, parsed, key, depth = 0) {
  if (depth > MAX_DEPTH || !node || typeof node !== "object") return null
  if (node.type === "text") return fillSlots(node.value, parsed)
  if (node.type !== "element" || typeof node.tagName !== "string") return null
  const tag = node.tagName
  const props = propsFromHast(node.properties, key)
  if (VOID_TAGS.has(tag)) return React.createElement(tag, props)
  const kids = Array.isArray(node.children)
    ? node.children.map((c, i) => renderHast(c, parsed, i, depth + 1)).filter((x) => x != null)
    : null
  return React.createElement(tag, props, kids)
}

// Build streamdown custom renderers from an active contract: one renderer per
// block kind, each keyed by the `ovl:<kind>` fence language. Returns null when
// no contract is active (Streamdown then renders ovl:* fences as plain code).
//
// `customBlocks: false` (the reader's Display preference) swaps every
// contract-defined kind to the host-styled PlainRichBlock — the fence CONTENT
// still renders (values, message text), but none of the model-authored
// HTML/CSS does. The reserved host channels (hud/music/bg/include) are
// host-rendered anyway and stay fully active.
export function buildRichRenderers(formatContract, { customBlocks = true } = {}) {
  if (!formatContract || !formatContract.enabled) return null
  const blocks = Array.isArray(formatContract.blocks) ? formatContract.blocks : []
  const renderers = blocks.map((block) => ({
    language: `ovl:${block.kind}`,
    component: customBlocks
      ? ({ code, isIncomplete }) => <RichBlock block={block} code={code} isIncomplete={isIncomplete} />
      : ({ code, isIncomplete }) => <PlainRichBlock block={block} code={code} isIncomplete={isIncomplete} />,
  }))
  // Reserved `ovl:hud` fence: its data feeds the persistent HUD panel, so it
  // must NOT render inline. Register an invisible renderer when a HUD is
  // defined. (Only meaningful with hud.slots; harmless otherwise.)
  if (formatContract.hud && Array.isArray(formatContract.hud.slots) && formatContract.hud.slots.length) {
    renderers.push({ language: "ovl:hud", component: () => null })
  }
  // Reserved `ovl:music` cue fence: a control channel for the now-playing bar,
  // never inline prose. Entry.jsx strips it before render regardless of the
  // contract; this is belt-and-suspenders for when a contract IS active so it
  // never degrades into a code block.
  renderers.push({ language: "ovl:music", component: () => null })
  // Reserved `ovl:bg` scene-backdrop fence: same belt-and-suspenders.
  renderers.push({ language: "ovl:bg", component: () => null })
  // Reserved `ovl:include` fence: render-time @include of text/image/video/audio
  // from story/includes/ (experimental). Only wired up when the contract opts in.
  if (formatContract.include && formatContract.include.enabled) {
    renderers.push({
      language: "ovl:include",
      component: ({ code, isIncomplete }) => (
        <IncludeBlock contract={formatContract} code={code} isIncomplete={isIncomplete} />
      ),
    })
  }
  return renderers.length ? renderers : null
}

// Host-styled fallback for a contract-defined block when the reader has turned
// custom rich styling off: the model's template and CSS are ignored entirely;
// the fence content renders in the host's own quiet card (theme.css .ovl-plain).
// keyvalue blocks render label/value rows — except the `body`/`raw` line, which
// is the message text and renders as a plain paragraph; raw blocks render their
// whole body as the paragraph. Total over partial (streaming) input.
export const PlainRichBlock = React.memo(function PlainRichBlock({ block, code, isIncomplete }) {
  const parsed = parseFence(code, block?.parse)
  const rows = []
  let bodyText = ""
  if (block?.parse === "keyvalue") {
    for (const [key, value] of parsed.pairs) {
      if (key === "body" || key === "raw") bodyText = value
      else rows.push([key, value])
    }
  } else {
    bodyText = parsed.raw
  }
  if (!rows.length && !bodyText.trim()) return null
  return (
    <div className="ovl-plain" data-kind={block?.kind || ""} data-incomplete={isIncomplete ? "" : undefined}>
      {rows.length > 0 && (
        <dl className="ovl-plain-rows">
          {rows.map(([key, value], i) => (
            <div className="ovl-plain-row" key={`${key}:${i}`}>
              <dt className="ovl-plain-key">{key}</dt>
              <dd className="ovl-plain-value">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {bodyText.trim() && <p className="ovl-plain-body">{bodyText}</p>}
    </div>
  )
})

// Memoized: during reveal/streaming the growing entry re-renders on EVERY tick,
// but a completed fence's `code` (and its `block` identity, stable per contract)
// does not change, so memo lets React skip re-running parseFence + renderHast +
// reconciliation for it each tick. The props are the full render inputs (the
// component is a pure function of them), so a shallow compare is correct.
export const RichBlock = React.memo(function RichBlock({ block, code, isIncomplete }) {
  const tree = block && block.template
  if (!tree || typeof tree !== "object" || !Array.isArray(tree.children)) {
    // Fallback: render the raw fence text as a plain preformatted block. Covers
    // a legacy primitive contract whose template no longer survives the HTML
    // sanitizer (hard cutover) until the Render Manager re-authors it.
    return <pre className="entry-codeblock">{String(code ?? "")}</pre>
  }
  const parsed = parseFence(code, block.parse)
  const blockClass = safeClass(block.class)
  return (
    <div className="ovl-rich" data-kind={block.kind} data-incomplete={isIncomplete ? "" : undefined}>
      <div className={cx("ovl-block", blockClass)}>
        {tree.children.map((c, i) => renderHast(c, parsed, i, 0))}
      </div>
    </div>
  )
})
