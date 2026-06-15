import React, { useEffect, useRef, useState } from "react"
import { musicAssetUrl } from "../../../lib/musicAsset.js"

// The now-playing bar. Driven by the latest `ovl:music` cue parsed from
// narration ({ verb, shortId }). It resolves the cue's display metadata from the
// catalog and plays the stream through the privileged ovl-music:// resolver —
// the renderer never holds a track id or a URL. Playback is Electron-only
// (window.openovel).
//
// Autoplay respects the browser gesture policy: until the reader presses play
// once (arming the player), a cue only loads + shows a ▶ affordance; afterwards
// subsequent cues autoplay.

function fmtArtist(entry) {
  return [entry.title, entry.artist].filter(Boolean).join(" — ") || entry.id
}

export function NowPlaying({ cue }) {
  const audioRef = useRef(null)
  const [entry, setEntry] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [armed, setArmed] = useState(false)
  const [volume, setVolume] = useState(0.7)
  const [coverFailed, setCoverFailed] = useState(false)

  const shortId = cue && cue.verb !== "stop" ? cue.shortId : ""

  // Resolve the cue's catalog entry whenever the active short id changes.
  useEffect(() => {
    let cancelled = false
    setCoverFailed(false)
    if (!shortId || !window.openovel?.getMusicCatalog) {
      setEntry(null)
      return undefined
    }
    window.openovel
      .getMusicCatalog()
      .then((catalog) => {
        if (cancelled) return
        const found = catalog?.entries?.[shortId] || null
        setEntry(found)
      })
      .catch(() => {
        if (!cancelled) setEntry(null)
      })
    return () => {
      cancelled = true
    }
  }, [shortId])

  // Drive the <audio> element from the cue + entry.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (!entry) {
      el.pause()
      setPlaying(false)
      return
    }
    el.loop = cue?.verb === "bgm"
    el.src = musicAssetUrl(entry.id)
    el.volume = volume
    if (armed) {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      setPlaying(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, cue?.verb])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  if (!entry) return null

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      setArmed(true)
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
  }

  const stop = () => {
    const el = audioRef.current
    if (el) {
      el.pause()
      el.currentTime = 0
    }
    setPlaying(false)
    setEntry(null)
  }

  const coverSrc = !coverFailed ? musicAssetUrl(entry.id, "cover") : ""

  return (
    <div className="ovl-nowplaying" role="region" aria-label="Now playing">
      <button
        className="ovl-np-toggle"
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "⏸" : "▶"}
      </button>
      {coverSrc ? (
        <img className="ovl-np-cover" src={coverSrc} alt="" onError={() => setCoverFailed(true)} />
      ) : (
        <span className="ovl-np-cover ovl-np-cover-empty" aria-hidden="true">♪</span>
      )}
      <div className="ovl-np-meta">
        <span className="ovl-np-title">{fmtArtist(entry)}</span>
        {entry.album ? <span className="ovl-np-album">{entry.album}</span> : null}
      </div>
      <input
        className="ovl-np-volume"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        title="Volume"
        aria-label="Volume"
      />
      <button className="ovl-np-stop" onClick={stop} title="Stop" aria-label="Stop">
        ⏹
      </button>
      <audio ref={audioRef} preload="none" onEnded={() => setPlaying(false)} />
    </div>
  )
}
