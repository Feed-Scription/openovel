import { useCallback, useEffect, useRef, useState } from "react"

// Makes a centered modal repositionable by dragging a handle (its header).
// The modal stays flex-centered on the backdrop; we layer a translate() on top,
// so it resets cleanly on remount and never fights the centering math.
//
// Usage:
//   const drag = useDraggable()
//   <div className="modal" style={drag.style}>
//     <div className="modal-header" onPointerDown={drag.onHandleDown}>…</div>
//   </div>
//
// The handle ignores pointer-downs that land on interactive controls
// (buttons, inputs, links) so the close button / header inputs still work.
const INTERACTIVE = "button, a, input, select, textarea, [role='button'], [contenteditable='true']"

export function useDraggable() {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // Live state for the active gesture; refs avoid re-subscribing listeners per move.
  const startRef = useRef({ px: 0, py: 0, ox: 0, oy: 0 })

  const onPointerDown = useCallback((e) => {
    // Only primary button, and never when starting on an interactive control.
    if (e.button !== 0) return
    if (e.target.closest && e.target.closest(INTERACTIVE)) return
    startRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
    setDragging(true)
    e.preventDefault()
  }, [offset.x, offset.y])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const { px, py, ox, oy } = startRef.current
      let x = ox + (e.clientX - px)
      let y = oy + (e.clientY - py)
      // Keep a sliver on-screen so the modal can never be dragged fully away.
      const margin = 48
      const maxX = window.innerWidth / 2 - margin
      const maxY = window.innerHeight / 2 - margin
      x = Math.max(-maxX, Math.min(maxX, x))
      y = Math.max(-maxY, Math.min(maxY, y))
      setOffset({ x, y })
    }
    const stop = () => setDragging(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
  }, [dragging])

  // Once the modal has been moved at all, pin `animation: none` permanently.
  // The `.modal` entrance keyframe (card-rise) ends at `transform: none` with
  // `both` fill, so if we let it re-apply after a drag it would clobber our
  // translate and snap the modal back to center. Keeping the override on for
  // the lifetime of the offset both lets the entrance play on first mount
  // (offset still 0) and prevents the rebound afterward.
  const moved = offset.x !== 0 || offset.y !== 0
  const style = (moved || dragging)
    ? { transform: `translate(${offset.x}px, ${offset.y}px)`, animation: "none" }
    : undefined

  return {
    style,
    dragging,
    onHandleDown: onPointerDown,
  }
}
