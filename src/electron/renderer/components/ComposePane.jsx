import React, { useCallback, useEffect, useRef, useState } from "react"

// Worldbook editor. The textarea is intentionally **uncontrolled**
// (defaultValue + ref) so IME composition (pinyin / kana / zhuyin) can own
// the DOM value until the user confirms a candidate. A controlled textarea
// reading `value={vm.buffer}` would re-render mid-composition and break
// the IME — which is exactly what was happening in this pane.
//
// We sync the local DOM value back into the VM buffer in two cases:
//   - on every `input` event WHEN we're NOT mid-composition (Latin typing,
//     paste, backspace, etc.)
//   - on `compositionend` (the IME confirmed a final string)
// This way the VM's `compose.buffer` stays accurate for the submit handler
// without ever interrupting the IME.
export function ComposePane({ state, actions }) {
  const c = state.compose
  const ref = useRef(null)
  const composingRef = useRef(false)
  // Local byte count, updated alongside the textarea so the header counter
  // doesn't have to wait for VM round-trips on every keystroke.
  const [byteCount, setByteCount] = useState(0)

  useEffect(() => {
    ref.current?.focus()
    // Seed the byte counter from the initial buffer.
    setByteCount(new TextEncoder().encode(c?.buffer || "").length)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const syncBuffer = useCallback(() => {
    if (!ref.current) return
    const text = ref.current.value
    actions.setComposeBuffer(text)
    setByteCount(new TextEncoder().encode(text).length)
  }, [actions])

  const onInput = useCallback(() => {
    if (composingRef.current) return
    syncBuffer()
  }, [syncBuffer])

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])
  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
    syncBuffer()
  }, [syncBuffer])

  const onKeyDown = useCallback(
    (e) => {
      // Don't intercept while the IME is composing — the IME owns Enter for
      // candidate selection during composition.
      if (composingRef.current) return
      if (e.key === "Escape") {
        e.preventDefault()
        actions.cancelCompose()
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault()
        syncBuffer()
        actions.submitCompose()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault()
        syncBuffer()
        actions.submitCompose()
      }
    },
    [actions, syncBuffer],
  )

  if (!c) return null

  if (state.busy) {
    return (
      <div className="compose-pane compose-busy">
        <div className="pane-header pane-header-yellow">
          <span className="spinner" /> Submitting worldbook for "{c.storyName}"
        </div>
        <div className="compose-status">{state.status}</div>
        <pre className="compose-preview-dim">{c.buffer || ""}</pre>
      </div>
    )
  }

  return (
    <div className="compose-pane">
      <div className="pane-header">
        <span>Worldbook editor for new story "{c.storyName}"</span>
        <span className="dim"> ({byteCount}B)</span>
      </div>
      <textarea
        ref={ref}
        className="compose-textarea"
        defaultValue={c.buffer || ""}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="Paste or type the worldbook. Ctrl-Enter / Cmd-Enter to submit. Esc to cancel."
        autoFocus
      />
      <div className="compose-hint">
        Ctrl-Enter (or Cmd-Enter / Ctrl-D) to submit · Esc to cancel · paste freely
      </div>
    </div>
  )
}
