import React, { useEffect, useLayoutEffect, useRef, useState } from "react"

const HUD_MAX_HEIGHT_FALLBACK = 30
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function readPixelVar(element, name, fallback) {
  const raw = window.getComputedStyle(element).getPropertyValue(name).trim()
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Persistent status panel defined by the format contract's `hud.slots`. Lives
// OUTSIDE #ovl-content in its own isolated root (#ovl-hud-root) so contract CSS
// still can't reach app chrome. Values arrive via the reserved `ovl:hud` fence
// the narrator emits each turn (parsed upstream into `pairs`); a turn with no
// fence keeps the previous values. A slot whose current value is empty is
// HIDDEN, not rendered as a bare label (the latest hud fence replaces pairs
// wholesale, so a key the narrator stopped emitting drops out of the strip);
// renders nothing until at least one slot has a value.
export function Hud({ slots, pairs, tone = "light" }) {
  const frameRef = useRef(null)
  const rootRef = useRef(null)
  const [safeBox, setSafeBox] = useState({ height: null, scale: 1 })

  useBrowserLayoutEffect(() => {
    const frame = frameRef.current
    const root = rootRef.current
    if (!frame || !root || typeof window === "undefined") return undefined

    let raf = 0
    const measure = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => {
        const maxHeight = readPixelVar(frame, "--ovl-hud-max-height", HUD_MAX_HEIGHT_FALLBACK)
        const availableWidth = frame.clientWidth
        const rawHeight = Math.ceil(root.scrollHeight || root.offsetHeight || root.getBoundingClientRect().height || 0)
        const rawWidth = Math.ceil(root.scrollWidth || root.offsetWidth || root.getBoundingClientRect().width || 0)
        const heightScale = rawHeight > maxHeight ? maxHeight / rawHeight : 1
        const widthScale = availableWidth > 0 && rawWidth > availableWidth ? availableWidth / rawWidth : 1
        const scale = Math.min(1, heightScale, widthScale)
        const height = rawHeight > 0 ? Math.ceil(Math.min(maxHeight, rawHeight * scale)) : null
        setSafeBox((previous) => {
          if (previous.height === height && Math.abs(previous.scale - scale) < 0.001) return previous
          return { height, scale }
        })
      })
    }

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    observer?.observe(frame)
    observer?.observe(root)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      window.cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [slots, pairs])

  if (!Array.isArray(slots) || !slots.length) return null
  const map = new Map(Array.isArray(pairs) ? pairs : [])
  const lookup = (slot) => {
    if (map.has(slot.id)) return map.get(slot.id)
    if (slot.label && map.has(slot.label)) return map.get(slot.label)
    return ""
  }
  const visibleSlots = slots.filter((slot) => String(lookup(slot) ?? "").trim() !== "")
  if (!visibleSlots.length) return null
  return (
    <div
      ref={frameRef}
      className="ovl-hud-frame"
      style={safeBox.height ? { height: `${safeBox.height}px` } : undefined}
    >
      <div
        ref={rootRef}
        id="ovl-hud-root"
        className={`ovl-hud hud-root${tone === "dark" ? " hud-dark" : ""}`}
        role="status"
        aria-label="story status"
        style={{
          margin: 0,
          maxWidth: "100%",
          transform: `scale(${safeBox.scale})`,
        }}
      >
        {visibleSlots.map((slot) => (
          <div key={slot.id} className={`ovl-hud-slot hud-slot ovl-hud-${slot.kind || "text"}`}>
            <span className="ovl-hud-label hud-slot-label">{slot.label}</span>
            <span className="ovl-hud-value hud-slot-value">{lookup(slot)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
