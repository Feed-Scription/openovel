import React, { useEffect, useRef, useState } from "react"
import { assetUrl } from "../../../lib/includePaths.js"
import { CodeView } from "../lib/CodeView.jsx"

function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(1)} MB`
}

// Modal-style file preview. Uses CodeView for line numbers + markdown
// syntax highlighting + virtualized line rendering. CodeMirror handles
// scroll preservation internally, so streaming-chapter re-renders no
// longer reset the scroll position or repaint every line.
export function FilePreview({ rel, onClose, dispatch }) {
  const [data, setData] = useState(null)     // { text, size, truncated, ... } | null
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  // Pin the dispatch closure to a ref so re-renders from the parent (e.g.
  // narration streaming on every chunk) don't force the file-fetch effect
  // to re-run with a new identity. Previous behavior flickered + reset
  // scroll on every parent paint.
  const dispatchRef = useRef(dispatch)
  useEffect(() => { dispatchRef.current = dispatch }, [dispatch])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    dispatchRef.current("readStoryFile", rel)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [rel])     // <- only re-fetch when the file path changes, not on every parent paint

  // ESC to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const kind = data?.kind || "text"
  const mediaSrc = data?.assetRel ? assetUrl(data.assetRel) : ""
  const language = guessLanguage(rel)
  const lineCount = data && kind === "text" ? countLines(data.text) : 0
  const meta = data
    ? [
        formatBytes(data.size),
        kind === "text" ? `${lineCount} lines` : mediaLabel(kind),
        data.truncated ? "truncated" : "",
      ].filter(Boolean).join(" · ")
    : ""

  return (
    <div className="preview-backdrop" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <header className="preview-header">
          <div className="preview-header-left">
            <span className="preview-path">{rel}</span>
            {data && (
              <span className="preview-meta">
                {meta}
              </span>
            )}
          </div>
          <button
            className="preview-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close preview"
          >
            ✕
          </button>
        </header>
        <div className="preview-body">
          {loading && <div className="preview-status">loading…</div>}
          {error && <div className="preview-status preview-error">{error}</div>}
          {!loading && !error && data && kind === "image" && mediaSrc && (
            <figure className="preview-media preview-image-shell">
              <img className="preview-image" src={mediaSrc} alt={rel} />
            </figure>
          )}
          {!loading && !error && data && kind === "video" && mediaSrc && (
            <div className="preview-media">
              <video className="preview-video" src={mediaSrc} controls preload="metadata" />
            </div>
          )}
          {!loading && !error && data && kind === "audio" && mediaSrc && (
            <div className="preview-media preview-audio-shell">
              <audio className="preview-audio" src={mediaSrc} controls preload="metadata" />
            </div>
          )}
          {!loading && !error && data && kind === "binary" && (
            <div className="preview-status preview-empty">Binary file preview is only available for story/includes media.</div>
          )}
          {!loading && !error && data && kind === "text" && (
            <CodeView
              value={data.text || ""}
              language={language}
              minHeight="200px"
              maxHeight="72vh"
              className="preview-code-view"
            />
          )}
        </div>
      </div>
    </div>
  )
}

function countLines(text) {
  if (!text) return 0
  const t = text.endsWith("\n") ? text.slice(0, -1) : text
  return t ? t.split(/\r?\n/).length : 0
}

function mediaLabel(kind) {
  switch (kind) {
    case "image": return "image"
    case "video": return "video"
    case "audio": return "audio"
    case "binary": return "binary"
    default: return ""
  }
}

// Pick a language extension based on file extension. Limited set — only
// markdown gets a real grammar; everything else gets plain text with
// line numbers (still better than the old raw <pre>).
function guessLanguage(rel) {
  const ext = String(rel || "").split(".").pop().toLowerCase()
  if (ext === "md" || ext === "markdown") return "markdown"
  // jsonl / json could get a JSON mode later — for now plain is fine.
  return "plain"
}
