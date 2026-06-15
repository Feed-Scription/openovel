import { useCallback, useEffect, useState } from "react"

// Load + persist Electron client prefs. The main process owns the JSON file
// at ~/.openovel/electron-prefs.json. Renderer holds the in-flight value.
export function usePrefs() {
  const [prefs, setPrefs] = useState(null)

  useEffect(() => {
    let cancelled = false
    window.openovel.getPrefs().then((p) => {
      if (!cancelled) setPrefs(p)
    })
    return () => { cancelled = true }
  }, [])

  const update = useCallback(async (next) => {
    setPrefs(next)
    try { await window.openovel.setPrefs(next) } catch { /* ignore */ }
  }, [])

  return [prefs, update]
}
