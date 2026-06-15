import React, { useEffect, useMemo, useState } from "react"
import { computeBackdropTreatment } from "../lib/imageTones.js"

// Scene backdrop (experimental, OPENOVEL_ENABLE_IMAGE_BACKGROUND): a prepared
// image from story/includes/bg/ shown as a full-page background behind the
// narration. The narrator selects it via the reserved `ovl:bg` control fence
// (parsed in richBlockModel.parseBackgroundFromText; App.jsx derives the latest
// directive from the transcript, so it persists across turns and replays).
//
// THE SCRIM IS HOST-OWNED: every "don't steal the scene" guarantee lives in
// theme.css (.scene-backdrop) plus the continuous veil/blur variables computed
// here from the sampled tone profile (computeBackdropTreatment — contrast-solved
// center veil, busyness-driven defocus). The CSS base values are only the
// pre-sample fallback. The model can pick WHICH image, never how it is treated.
//
// Crossfade: when src changes we keep the previous image underneath and fade the
// new one in on top (slow, ambient). prefers-reduced-motion kills the animation
// in CSS. A failed load hides the layer entirely (remote transports cannot serve
// ovl-asset:// — degrade to no backdrop, never a broken-image glyph).
export function SceneBackdrop({ src, profile }) {
  const [prevSrc, setPrevSrc] = useState(null)
  const [shownSrc, setShownSrc] = useState(src)
  const [failed, setFailed] = useState(false)
  const treatment = useMemo(() => computeBackdropTreatment(profile), [profile])

  useEffect(() => {
    if (src === shownSrc) return
    setPrevSrc(shownSrc)
    setShownSrc(src)
    setFailed(false)
    const t = setTimeout(() => setPrevSrc(null), 2200) // drop the old layer after the fade
    return () => clearTimeout(t)
  }, [src, shownSrc])

  if (!shownSrc || failed) return null
  return (
    <div className="scene-backdrop" style={treatment} aria-hidden="true">
      {prevSrc && <img key={prevSrc} src={prevSrc} alt="" className="scene-backdrop-prev" />}
      <img key={shownSrc} src={shownSrc} alt="" className="scene-backdrop-img" onError={() => setFailed(true)} />
    </div>
  )
}
