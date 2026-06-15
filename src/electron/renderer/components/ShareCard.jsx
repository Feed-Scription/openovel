import React from "react"
import { Streamdown } from "streamdown"
import { NARRATION_COMPONENTS, NARRATION_REHYPE } from "./Entry.jsx"
import { stripOvlFences } from "../lib/shareText.js"
// Inlined as a base64 data URI by esbuild (.png → dataurl loader), so it loads
// under the renderer's strict CSP with no file-path concerns.
import logoMark from "../../../../assets/logo-mark.png"

// Off-screen, fully laid-out card that snapdom rasterizes into the shareable
// PNG. NOT display:none (snapdom needs real layout) — pushed far off-screen.
// Reuses the transcript's narration Streamdown config so the prose looks
// identical (dialogue tinting, paragraph rhythm); rich `ovl:` fences are
// stripped so a share image is always clean prose.
export function ShareCard({ forwardedRef, storyName, text }) {
  const prose = stripOvlFences(text)
  return (
    <div
      aria-hidden="true"
      style={{ position: "fixed", left: "-99999px", top: 0, pointerEvents: "none" }}
    >
      <div ref={forwardedRef} className="ovl-sharecard">
        {storyName ? <div className="ovl-sharecard-head">{storyName}</div> : null}
        <div className="ovl-sharecard-body entry-narration">
          <Streamdown
            components={NARRATION_COMPONENTS}
            rehypePlugins={NARRATION_REHYPE}
            controls={false}
          >
            {prose}
          </Streamdown>
        </div>
        <div className="ovl-sharecard-foot">
          <img className="ovl-sharecard-logo" src={logoMark} alt="" />
          <span className="ovl-sharecard-wordmark">openovel</span>
        </div>
      </div>
    </div>
  )
}
