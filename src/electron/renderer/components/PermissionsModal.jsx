import React, { useCallback, useEffect, useState } from "react"
import { useDraggable } from "../lib/useDraggable.js"

// /permissions used to dump pending requests as text; user then had to
// /approve <id> or /deny <id> by typing. GUI version: tabular list, two
// buttons per pending row. Auto-refreshes on tool.permission bus events so
// a new ask shows up without re-opening the modal.

function statusTone(status) {
  if (status === "approved") return "tone-ok"
  if (status === "denied") return "tone-error"
  return "tone-info"
}

function relTime(iso) {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (!t) return ""
  const d = Date.now() - t
  const m = Math.floor(d / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(t).toISOString().slice(0, 10)
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return ""
  const keys = ["filePath", "path", "url", "query", "target", "command"]
  for (const k of keys) {
    if (input[k]) return `${k}=${String(input[k]).slice(0, 80)}`
  }
  return Object.keys(input).join(", ")
}

export function PermissionsModal({ actions, onClose }) {
  const drag = useDraggable()
  const [requests, setRequests] = useState(null)
  const [filter, setFilter] = useState("pending")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const list = await actions.listPermissions({ status: filter, limit: 100 })
      setRequests(Array.isArray(list) ? list : [])
      setError("")
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [actions, filter])

  useEffect(() => { refresh() }, [refresh])

  // Listen for live permission bus events so a fresh ask shows up without
  // re-opening the modal.
  useEffect(() => {
    const off = window.openovel.onBusEvent((name) => {
      if (name === "tool.permission") refresh()
    })
    return off
  }, [refresh])

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const onApprove = useCallback(async (req) => {
    setPending(req.requestId)
    try {
      await actions.approvePermission(req.requestId)
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setPending(null)
    }
  }, [actions, refresh])

  const onDeny = useCallback(async (req) => {
    setPending(req.requestId)
    try {
      await actions.denyPermission(req.requestId, "")
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setPending(null)
    }
  }, [actions, refresh])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" style={drag.style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" onPointerDown={drag.onHandleDown}>
          <span>Permissions</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="perm-filter-row">
          {["pending", "approved", "denied", "all"].map((opt) => (
            <button
              key={opt}
              type="button"
              className={`perm-filter${filter === opt ? " is-active" : ""}`}
              onClick={() => setFilter(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="perm-modal-body">
          {error && <div className="perm-modal-error">{error}</div>}
          {requests === null && !error && (
            <div className="perm-modal-empty">loading…</div>
          )}
          {requests && requests.length === 0 && (
            <div className="perm-modal-empty">
              no {filter === "all" ? "" : filter + " "}permission requests
            </div>
          )}
          {requests && requests.length > 0 && (
            <table className="perm-table">
              <thead>
                <tr>
                  <th>status</th>
                  <th>tool</th>
                  <th>pattern</th>
                  <th>input</th>
                  <th>when</th>
                  <th>action</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((req) => {
                  const status = req.status || "pending"
                  const tool = req.permission || req.toolId || "tool"
                  const pattern = req.matchedPattern || req.patterns?.[0] || "*"
                  const inputSummary = summarizeInput(req.input)
                  const when = relTime(req.updatedAt || req.createdAt)
                  const isPending = status === "pending"
                  const isBusy = pending === req.requestId
                  return (
                    <tr key={req.requestId} className={isBusy ? "is-busy" : ""}>
                      <td><span className={`perm-status ${statusTone(status)}`}>{status}</span></td>
                      <td className="perm-tool">{tool}</td>
                      <td className="perm-pattern">{pattern}</td>
                      <td className="perm-input">{inputSummary}</td>
                      <td className="perm-when">{when}</td>
                      <td className="perm-actions">
                        {isPending ? (
                          <>
                            <button
                              type="button"
                              className="perm-btn perm-btn-approve"
                              disabled={isBusy}
                              onClick={() => onApprove(req)}
                            >Approve</button>
                            <button
                              type="button"
                              className="perm-btn perm-btn-deny"
                              disabled={isBusy}
                              onClick={() => onDeny(req)}
                            >Deny</button>
                          </>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-footer">
          <span className="dim">Live · auto-refreshes on new asks · Esc to close</span>
          <button className="modal-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
