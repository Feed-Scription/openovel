import React, { useEffect } from "react"
import { optionLabel } from "../../../lib/optionLabel.js"

export function OptionList({ options, framing, optionsEnabled, busy, mode, actions }) {
  // Options are display-only objects ({ id, label, key }) or legacy strings; the
  // hidden effect never reaches render state. optionLabel() is the only accessor.
  const cleaned = (options || [])
    .map((o) => optionLabel(o).trim())
    .filter((o) => o.length > 0)
    .slice(0, 4)
  const framingText = String(framing ?? "").trim()

  // Keyboard 1-4 → submit that option directly (matches the new default
  // click-row-to-execute behavior). Held off while typing in the input or
  // while a turn is already in flight.
  useEffect(() => {
    if (!cleaned.length || busy) return
    const onKey = (e) => {
      if (mode !== "idle") return
      if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return
      const n = Number(e.key)
      if (n >= 1 && n <= cleaned.length) {
        e.preventDefault()
        actions.submitOption(n)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cleaned.length, busy, mode, actions])

  if (!optionsEnabled || !cleaned.length || busy) return null

  return (
    <div className="option-list">
      {framingText && <div className="option-decision-framing">{framingText}</div>}
      {cleaned.map((opt, i) => {
        const n = i + 1
        return (
          <div
            key={i}
            className="option-row"
            onClick={() => actions.submitOption(n)}
            title={opt}
          >
            <span className="option-num">{n}.</span>
            <span className="option-text">{opt}</span>
            <button
              type="button"
              className="option-fill"
              onClick={(e) => {
                e.stopPropagation()    // don't bubble to the row's submit handler
                actions.pickOption(n)
              }}
              title="Edit this option before sending"
              aria-label={`Edit option ${n} before sending`}
            >
              {/* Pencil — communicates "modify" / "draft", not "send".
                  Up-arrow was wrong here: in chat UIs ↑ universally means
                  submit, which is what the row click already does. */}
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M11.5 2.5l2 2-8 8H3.5v-2l8-8zM10.5 3.5l2 2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
