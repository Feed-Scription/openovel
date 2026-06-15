import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { OptionList } from "./OptionList.jsx"
import { optionLabel } from "../../../lib/optionLabel.js"

export function Footer({ state, actions }) {
  const { t } = useTranslation()
  const inputRef = useRef(null)

  // IME-safe input value. The input is driven by a LOCAL value (synchronous)
  // rather than directly by state.input. state.input round-trips through
  // Electron IPC (renderer → main-process VM → state patch → re-render), and
  // an async value update during an active IME composition overwrites the
  // composing text and resets the input method — which made CJK input
  // impossible here. We mirror state.input into local value only when not
  // composing and the two genuinely diverge (VM-driven changes: clearInput on
  // submit, pickOption filling an option to edit).
  const [value, setValue] = useState(state.input || "")
  const composingRef = useRef(false)
  useEffect(() => {
    if (composingRef.current) return
    if ((state.input || "") !== value) setValue(state.input || "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.input])

  useEffect(() => {
    if (!state.busy) inputRef.current?.focus()
  }, [state.busy])

  // Slash commands are disabled in the Electron reader input: no typeahead
  // popup, and a "/"-prefixed line is sent to the narrator as plain text (the
  // submit interceptor in App.jsx handles routing). Those functions are reached
  // through the GUI (menus / modals) instead.

  const onChange = useCallback((e) => {
    const v = e.target.value
    setValue(v)                                 // synchronous: keeps IME stable
    if (!composingRef.current) actions.setInput(v) // sync to VM between compositions
  }, [actions])

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])

  const onCompositionEnd = useCallback((e) => {
    composingRef.current = false
    const v = e.target.value
    setValue(v)
    actions.setInput(v)                         // commit the composed text to the VM
  }, [actions])

  const onKeyDown = useCallback((e) => {
    // Never treat keys as commands mid-IME-composition: Enter confirms the
    // candidate, arrows move the candidate list, Esc cancels composition.
    // keyCode 229 / isComposing both flag an in-flight composition.
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      actions.submit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      actions.clearInput()
    }
  }, [actions])

  const prefix = state.busy ? "" : "›"
  const promptClass = state.busy ? "footer-prompt busy" : "footer-prompt"

  // Authoritative turn count from the VM: reader_action events in the full
  // scene_log (slash commands don't count; survives restart). reader_action is
  // logged at turn START, so this already includes the turn being written — no
  // busy adjustment needed.
  const turnCount = state.turnCount || 0
  // Mirror OptionList's visibility test (and its max-4 cap) so the choose-hint
  // sits in the progress row (right) only while options are on screen, and its
  // key range tracks the actual option count: "1–3" for three, "1" for one.
  const optionCount = (state.options || [])
    .map((o) => optionLabel(o).trim())
    .filter((o) => o.length > 0)
    .slice(0, 4).length
  const optionsShowing = state.optionsEnabled && !state.busy && optionCount > 0
  const optionKeys = optionCount === 1 ? "1" : `1–${optionCount}`

  return (
    <footer className={`footer${state.busy ? " footer-quiet" : ""}`}>
      <div className="footer-anchor">
        <div className="footer-card">
          <OptionList
            options={state.options}
            framing={state.decisionFraming}
            optionsEnabled={state.optionsEnabled}
            busy={state.busy}
            mode={state.mode}
            actions={actions}
          />
          <div className="input-row">
            <span className={promptClass}>{prefix}</span>
            <input
              ref={inputRef}
              className="input-field"
              type="text"
              value={value}
              onChange={onChange}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onKeyDown={onKeyDown}
              disabled={state.busy}
              placeholder={state.busy ? t("footer.busy", { defaultValue: "narrator is writing…" }) : t("footer.placeholder")}
              autoFocus
            />
          </div>
          <div className="progress-row">
            <span className="progress-left">{turnCount > 0 ? t("footer.turn", { count: turnCount, defaultValue: "turn {{count}}" }) : ""}</span>
            {optionsShowing && (
              <span className="progress-right">
                {t("options.hint", { keys: optionKeys, defaultValue: "Press {{keys}} or click to choose · use the pencil to edit before sending" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </footer>
  )
}
