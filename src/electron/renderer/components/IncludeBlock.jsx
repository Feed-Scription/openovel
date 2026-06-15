import React, { useEffect, useState } from "react"
import { Streamdown } from "streamdown"
import { parseIncludeFence } from "../lib/richBlockModel.js"
import { includeExtension } from "../../../lib/includePaths.js"

// Renders one reserved `ovl:include` fence: the narrator's render-time @include
// directive (LaTeX-\input style) that pulls text/image/video/audio from the
// story's dedicated story/includes/ folder. Bytes are served by the main
// process's ovl-asset:// protocol, which re-validates every path — so this
// component only has to map a resolved descriptor to the right element.
//
// Streaming contract: while the fence is still arriving we DON'T resolve media
// (a half-typed path would 404 and flash a broken image). We show the raw
// @include lines as a muted placeholder until the closer arrives.

function basename(rel) {
  const parts = String(rel || "").split("/")
  return parts[parts.length - 1] || rel
}

// Fetches a text include (.md / .txt) through the ovl-asset:// protocol and
// renders it. Markdown goes through a nested, plain Streamdown (no rich
// renderers → no ovl:include recursion); plain text renders verbatim.
function IncludeText({ src, rel }) {
  const [state, setState] = useState({ status: "loading", text: "" })
  useEffect(() => {
    let cancelled = false
    setState({ status: "loading", text: "" })
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => { if (!cancelled) setState({ status: "ok", text }) })
      .catch(() => { if (!cancelled) setState({ status: "error", text: "" }) })
    return () => { cancelled = true }
  }, [src])

  if (state.status === "loading") {
    return <div className="ovl-include-text ovl-include-loading">loading {basename(rel)}…</div>
  }
  if (state.status === "error") {
    return <div className="ovl-include-error">⚠ could not load include: {rel}</div>
  }
  const ext = includeExtension(rel)
  if (ext === "md" || ext === "markdown") {
    return (
      <div className="ovl-include-text ovl-include-md">
        <Streamdown controls={false}>{state.text}</Streamdown>
      </div>
    )
  }
  return <pre className="ovl-include-text ovl-include-plain">{state.text}</pre>
}

// Media with an optional visible caption renders as a <figure>/<figcaption>
// pair; without one the bare element keeps the old DOM shape. alt/caption are
// narrator-authored plain text (parseIncludeDirectives' closed attribute set),
// inserted only as text content, never markup.
function withCaption(node, caption) {
  if (!caption) return node
  return (
    <figure className="ovl-include-figure">
      {node}
      <figcaption className="ovl-include-caption">{caption}</figcaption>
    </figure>
  )
}

function IncludeItem({ item }) {
  const { kind, src, rel, error, alt, caption } = item
  if (error || !src) {
    return <div className="ovl-include-error">⚠ {error || "include unavailable"}: {rel}</div>
  }
  switch (kind) {
    case "image":
      return withCaption(<img className="ovl-include-img" src={src} alt={alt || caption || basename(rel)} loading="lazy" />, caption)
    case "video":
      return withCaption(<video className="ovl-include-video" src={src} aria-label={alt || caption || undefined} controls preload="metadata" />, caption)
    case "audio":
      return withCaption(<audio className="ovl-include-audio" src={src} aria-label={alt || caption || undefined} controls preload="metadata" />, caption)
    case "text":
      return <IncludeText src={src} rel={rel} />
    default:
      return <div className="ovl-include-error">⚠ unsupported include: {rel}</div>
  }
}

export function IncludeBlock({ contract, code, isIncomplete }) {
  // Don't resolve media mid-stream — render the directive text as a placeholder
  // until the fence closes.
  if (isIncomplete) {
    return <pre className="ovl-include-pending">{String(code ?? "")}</pre>
  }
  const allow = contract?.include?.allow ?? null
  const items = parseIncludeFence(code, { allow })
  if (!items.length) return null
  return (
    <div className="ovl-include">
      {items.map((item, i) => (
        <IncludeItem key={`${item.rel}:${i}`} item={item} />
      ))}
    </div>
  )
}
