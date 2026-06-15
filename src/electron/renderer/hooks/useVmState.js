import { useEffect, useState } from "react"

// Subscribe to the main-process SessionViewModel via the preload bridge.
// Returns the latest state snapshot. The initial fetch is async, so callers
// must handle the `null` first render.
//
// Perf: narration reveal pushes a fresh full-state snapshot many times a
// second. Committing each to React re-renders the whole app at the reveal
// cadence, which stutters on long transcripts. We coalesce snapshots to at most
// one commit per animation frame and keep only the latest — React never needs
// the intermediate frames — so reveal stays smooth under the churn.
export function useVmState() {
  const [state, setState] = useState(null)

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let pending = null
    const commit = () => {
      raf = 0
      if (cancelled || pending == null) return
      const snap = pending
      pending = null
      setState(snap)
    }
    const schedule = (snap) => {
      pending = snap
      if (raf) return
      raf = requestAnimationFrame(commit)
    }
    window.openovel.getState().then((snap) => {
      if (!cancelled) setState(snap)
    })
    const off = window.openovel.subscribe((snap) => {
      if (!cancelled) schedule(snap)
    })
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      off()
    }
  }, [])

  return state
}
