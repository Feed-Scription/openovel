import React, { useState } from "react"
import { useTranslation } from "react-i18next"

// Modal that pops on the first new-story flow. Asks the user to pick an
// initialization depth: zero / standard / deep. Choice is persisted via
// `window.openovel.setInitDepth` so subsequent stories skip this modal.
//
// Three modes:
//   zero     — no agent. The user's brief is placed verbatim into the
//              Prelude; the narrator picks it up from there. Fastest /
//              cheapest start; relies on the narrator to flesh things out
//              turn-by-turn.
//   standard — current default. The init agent uses file tools to
//              scaffold FG_template + section files + a small set of
//              character cards. Mid cost / mid time.
//   deep     — init agent + websearch / webfetch. The agent researches
//              before writing: for fan-fiction (二创) it pulls canon
//              worldbuilding + character profiles + relationships; for
//              real-world settings it grounds itself in era / domain
//              facts. Highest cost / longest init time. Best for stories
//              built on top of an existing universe.

const DEPTH_IDS = ["zero", "standard", "deep"]
const BADGES = { zero: "0", standard: "1", deep: "∞" }

export function InitDepthModal({ pending, actions, onChosen }) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(null)
  const [error, setError] = useState(null)

  const choose = async (depth) => {
    if (picking) return
    setPicking(depth)
    setError(null)
    try {
      const r = await window.openovel.setInitDepth(depth)
      if (!r || (r.error && !r.value)) throw new Error(r?.error || "save failed")
      onChosen?.(depth)
      actions.continueInitWithDepth(depth)
    } catch (e) {
      setError(e?.message || String(e))
      setPicking(null)
    }
  }

  if (!pending) return null

  return (
    <div className="modal-backdrop">
      <div className="modal-shell init-depth-modal">
        <header className="modal-head">
          <h2 className="modal-title">{t("initDepth.title")}</h2>
          <p className="modal-sub">{t("initDepth.subtitle")}</p>
        </header>
        <ul className="init-depth-options">
          {DEPTH_IDS.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={`init-depth-option${picking === id ? " is-picking" : ""}`}
                onClick={() => choose(id)}
                disabled={Boolean(picking)}
                title={t(`initDepth.${id}.body`)}
              >
                <span className="init-depth-badge">{BADGES[id]}</span>
                <div className="init-depth-text">
                  <div className="init-depth-title">{t(`initDepth.${id}.title`)}</div>
                  <div className="init-depth-short">{t(`initDepth.${id}.short`)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="modal-error">{error}</p>}
        <footer className="modal-foot">
          <p className="modal-hint">{t("initDepth.hint")}</p>
        </footer>
      </div>
    </div>
  )
}
