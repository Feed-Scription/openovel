import React, { useCallback, useEffect, useRef, useState } from "react"
import { snapdom } from "@zumer/snapdom"
import { ShareCard } from "../components/ShareCard.jsx"
import { shareImageFilename } from "./shareText.js"

// Owns the paragraph → image → clipboard/file pipeline. The consumer renders the
// returned `card` (an off-screen ShareCard) and calls `shareParagraph(text, mode)`
// from the per-paragraph Copy/Save buttons. Capture happens after the card paints.
//
// mode: "copy" → clipboard (Electron nativeImage via main); "save" → native save
// dialog + write. `status` is a short-lived key ("copied" | "saved" | "failed")
// the consumer can surface as a transient toast.
export function useParagraphShare(storyName = "") {
  const [job, setJob] = useState(null) // { id, text, mode }
  const [status, setStatus] = useState("")
  const cardRef = useRef(null)
  const statusTimer = useRef(null)

  const flash = useCallback((key) => {
    setStatus(key)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    if (key) statusTimer.current = setTimeout(() => setStatus(""), 1800)
  }, [])

  const shareParagraph = useCallback((text, mode) => {
    const t = String(text || "").trim()
    if (!t) return
    setJob({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: t, mode })
  }, [])

  useEffect(() => {
    if (!job) return
    let cancelled = false
    const run = async () => {
      // Wait one frame so the freshly-mounted card has laid out + painted.
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const el = cardRef.current
      if (cancelled || !el) { if (!cancelled) setJob(null); return }
      try {
        const canvas = await snapdom.toCanvas(el, { scale: 2, backgroundColor: "#f4f4f4" })
        const dataUrl = canvas.toDataURL("image/png")
        if (job.mode === "save") {
          const r = await window.openovel.saveShareImage(dataUrl, shareImageFilename(storyName))
          if (r?.cancelled) flash("")
          else flash(r?.ok ? "saved" : "failed")
        } else {
          const r = await window.openovel.copyShareImage(dataUrl)
          flash(r?.ok ? "copied" : "failed")
        }
      } catch (err) {
        console.error("[paragraphShare] capture failed", err)
        flash("failed")
      } finally {
        if (!cancelled) setJob(null)
      }
    }
    run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id])

  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current) }, [])

  const card = job ? <ShareCard forwardedRef={cardRef} storyName={storyName} text={job.text} /> : null
  return { shareParagraph, status, card }
}
