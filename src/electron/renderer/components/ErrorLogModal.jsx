import React, { useEffect } from "react"
import { useDraggable } from "../lib/useDraggable.js"

function formatRelative(at) {
  const t = typeof at === "number" ? at : Date.parse(at)
  if (!t) return ""
  const d = Date.now() - t
  const s = Math.floor(d / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(t).toISOString().slice(0, 16).replace("T", " ")
}

// Per-session error log — collects narrator connection failures and any
// activity-feed rows that ended with status: "error". Newest first.
// Click the red badge in the header to open this.
export function ErrorLogModal({ errors, onClose }) {
  const drag = useDraggable()
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" style={drag.style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" onPointerDown={drag.onHandleDown}>
          <span>Error log</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="error-log-body">
          {errors.length === 0 ? (
            <div className="error-log-empty">No errors this session</div>
          ) : (
            <ul className="error-log-list">
              {errors.map((e, i) => (
                <li key={i} className="error-log-entry">
                  <div className="error-log-meta">
                    <span className="error-log-source">{e.source}</span>
                    <span className="error-log-at">{formatRelative(e.at)}</span>
                  </div>
                  <div className="error-log-message">{e.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-footer">
          <span className="dim">Esc to close</span>
          <button className="modal-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
