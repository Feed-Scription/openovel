import React, { useCallback, useEffect, useState } from "react"
import { useDraggable } from "../lib/useDraggable.js"

// /transactions used to print a text list of file-write transactions;
// /rollback <txId> reverted one. GUI version: list of tx rows, each row
// expands to show its file manifest, with a one-click Rollback button.

function statusTone(status) {
  if (status === "finalized") return "tone-ok"
  if (status === "aborted" || status === "abandoned") return "tone-error"
  if (status === "rolled-back") return "tone-warn"
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

function fileLabel(file) {
  return file.displayPath || file.path || "(unknown)"
}

export function TransactionsModal({ actions, onClose }) {
  const drag = useDraggable()
  const [transactions, setTransactions] = useState(null)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState(null)
  const [pendingTx, setPendingTx] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [lastResult, setLastResult] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const list = await actions.listTransactions({ limit: 50 })
      setTransactions(Array.isArray(list) ? list : [])
      setError("")
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [actions])

  useEffect(() => { refresh() }, [refresh])

  // Files changed → some tx finalized; refresh.
  useEffect(() => {
    const off = window.openovel.onBusEvent((name) => {
      if (name === "story.files_changed") refresh()
    })
    return off
  }, [refresh])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (confirming) setConfirming(null)
        else onClose?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, confirming])

  const onRollback = useCallback(async (tx) => {
    setPendingTx(tx.txId)
    setConfirming(null)
    try {
      const result = await actions.rollbackTransaction(tx.txId)
      setLastResult({ txId: tx.txId, rolledBack: result?.rolledBack || [] })
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setPendingTx(null)
    }
  }, [actions, refresh])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" style={drag.style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" onPointerDown={drag.onHandleDown}>
          <span>Transactions</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="tx-modal-body">
          {error && <div className="tx-modal-error">{error}</div>}
          {lastResult && (
            <div className="tx-result">
              Rolled back <code>{lastResult.txId}</code> — {lastResult.rolledBack.length} file{lastResult.rolledBack.length === 1 ? "" : "s"} restored
            </div>
          )}
          {transactions === null && !error && (
            <div className="tx-modal-empty">loading…</div>
          )}
          {transactions && transactions.length === 0 && (
            <div className="tx-modal-empty">no transactions yet</div>
          )}
          {transactions && transactions.length > 0 && (
            <ul className="tx-list">
              {transactions.map((tx) => {
                const isOpen = expanded === tx.txId
                const isBusy = pendingTx === tx.txId
                const fileCount = Array.isArray(tx.files) ? tx.files.length : 0
                const canRollback = tx.status === "finalized" && fileCount > 0 && !tx.rollback
                const status = tx.rollback ? "rolled-back" : (tx.status || "unknown")
                return (
                  <li key={tx.txId} className={`tx-row${isBusy ? " is-busy" : ""}`}>
                    <button
                      type="button"
                      className="tx-row-header"
                      onClick={() => setExpanded(isOpen ? null : tx.txId)}
                    >
                      <span className="tx-row-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                      <span className={`tx-status ${statusTone(status)}`}>{status}</span>
                      <code className="tx-id">{tx.txId}</code>
                      <span className="tx-source">{tx.source || "runtime"}</span>
                      <span className="tx-count">{fileCount} file{fileCount === 1 ? "" : "s"}</span>
                      <span className="tx-when">{relTime(tx.startedAt)}</span>
                    </button>
                    {isOpen && (
                      <div className="tx-row-detail">
                        <div className="tx-meta">
                          {tx.turnId && <span>turn <code>{tx.turnId}</code></span>}
                          {tx.jobId && <span>job <code>{tx.jobId}</code></span>}
                          {tx.callID && <span>call <code>{tx.callID}</code></span>}
                        </div>
                        {fileCount > 0 && (
                          <ul className="tx-files">
                            {tx.files.map((file, i) => (
                              <li key={i} className="tx-file">
                                <span className="tx-file-action">{file.before?.exists ? "modified" : "created"}</span>
                                <code className="tx-file-path">{fileLabel(file)}</code>
                              </li>
                            ))}
                          </ul>
                        )}
                        {canRollback && (
                          confirming === tx.txId ? (
                            <div className="tx-confirm">
                              <span>Restore {fileCount} file{fileCount === 1 ? "" : "s"} to before this transaction?</span>
                              <button
                                type="button"
                                className="perm-btn perm-btn-deny"
                                onClick={() => onRollback(tx)}
                                disabled={isBusy}
                              >Confirm rollback</button>
                              <button
                                type="button"
                                className="perm-btn"
                                onClick={() => setConfirming(null)}
                                disabled={isBusy}
                              >Cancel</button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="tx-rollback-btn"
                              onClick={() => setConfirming(tx.txId)}
                              disabled={isBusy}
                            >Rollback</button>
                          )
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="modal-footer">
          <span className="dim">Click a row to expand · Rollback restores the before-snapshot · Esc to close</span>
          <button className="modal-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
