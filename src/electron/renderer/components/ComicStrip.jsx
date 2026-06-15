import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { parsePanelScript, resolveComicPanelStatus, visibleComicPanelCount } from "../../../lib/comicScript.js"
import { assetUrl } from "../../../lib/includePaths.js"

// Comic mode (experimental): renders a narration entry whose text is a panel
// script as a vertical picture-story strip — image above, caption below.
//
// SEQUENTIAL REVEAL: a live turn discloses the strip like pages being drawn —
// panel K+1 stays hidden until panel K's image has resolved (ready, or failed
// → caption-only), so the reader never reads ahead of the artwork. The
// runtime starts generating each panel the moment its fence closes in the
// stream, so the wait is the first image's latency, not the whole batch.
// Replayed turns carry no live status: everything shows at once and images
// load straight from disk via ovl-asset:// (degrading to caption-only on a
// missing file). The synopsis fence is never rendered.
//
// `panelStatus` is keyed by rel path (durable; the completed text carries the
// injected paths); `liveStatus` by panel index (the only matchable key while
// the text is still streaming, before injection).
export function ComicStrip({ text, animating = false, panelStatus = null, liveStatus = null }) {
  const { panels } = parsePanelScript(text)
  if (!panels.length) return null
  const statuses = { byRel: panelStatus || {}, byIndex: liveStatus || {} }
  // Gate while the text is still streaming OR any of this strip's panels has
  // a live generation status (text done, images still landing). A replayed
  // strip matches neither and shows in full.
  const gated = animating || panels.some((p) => resolveComicPanelStatus(p, statuses) !== undefined)
  const visible = visibleComicPanelCount(panels, statuses, { gated })
  return (
    <div className="comic-strip" aria-label="comic strip">
      {panels.slice(0, visible).map((panel) => (
        <ComicPanel
          key={panel.index}
          panel={panel}
          status={resolveComicPanelStatus(panel, statuses)}
          gated={gated}
          animating={animating}
        />
      ))}
    </div>
  )
}

function ComicPanel({ panel, status, gated, animating }) {
  const { t } = useTranslation()
  const [loadFailed, setLoadFailed] = useState(false)
  // A ready event always re-arms the image (an early 404 must not stick).
  React.useEffect(() => {
    if (status === "ready") setLoadFailed(false)
  }, [status])
  const rel = panel.image && !panel.imageIssue ? panel.image : ""
  const failed = status === "failed" || (loadFailed && status !== "ready")
  // Live (gated) panels wait for the explicit ready event — never racing the
  // <img> against a file still being written. Ungated (replayed) panels load
  // straight from disk.
  const showImage = rel && !failed && (status === "ready" || (!gated && status === undefined))
  return (
    <figure className={`comic-panel${panel.open ? " is-open" : ""}`}>
      {showImage ? (
        <img
          key={`${rel}@${status || "static"}`}
          className="comic-panel-img"
          src={assetUrl(rel)}
          alt={panel.caption ? panel.caption.slice(0, 80) : "comic panel"}
          onError={() => setLoadFailed(true)}
        />
      ) : failed ? (
        <div className="comic-panel-missing" aria-hidden="true">
          <span>{t("comic.panelFailed", { defaultValue: "本格未能成图" })}</span>
        </div>
      ) : (
        // The waiting state is a quiet sheet with a slow ink-bloom at its
        // center (pure CSS) — no border, no label; the motion itself says
        // "being drawn". The aria-label keeps it legible to screen readers.
        <div className="comic-panel-drawing" role="img" aria-label={t("comic.drawing", { defaultValue: "正在作画" })} />
      )}
      {panel.caption && (
        <figcaption className="comic-panel-caption">
          {panel.caption}
          {panel.open && animating ? <span className="entry-cursor" /> : null}
        </figcaption>
      )}
    </figure>
  )
}
