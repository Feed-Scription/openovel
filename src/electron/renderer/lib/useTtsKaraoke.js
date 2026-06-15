import { useCallback, useEffect, useRef, useState } from "react"

// Audio-driven karaoke playback for streaming TTS.
//
// The main-process bridge streams one PCM clip per narration sentence over the
// "tts:event" channel. This hook plays them gaplessly through a single
// AudioContext (sample-accurate scheduling = no clicks between sentences) and,
// crucially, makes the AUDIO the clock for text: each sentence's on-screen text
// is revealed in proportion to how far its audio clip has played. So the words
// light up exactly as they're spoken (the "卡拉OK" sync the user asked for).
//
// State exposed to the transcript:
//   textByTurn[ttsTurnId]  → the revealed prefix to show for that narration entry
//   activeTurns[ttsTurnId] → true while that turn is still being spoken
// When a turn goes inactive the entry falls back to its full (VM) text — and on
// any cancel/error the entry also reverts, so audio failure never hides prose.

function pcmToAudioBuffer(ctx, pcm, sampleRate) {
  // pcm is a Uint8Array of little-endian s16 mono samples.
  const u8 = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const sampleCount = Math.floor(u8.byteLength / 2)
  const view = new DataView(u8.buffer, u8.byteOffset, sampleCount * 2)
  const f32 = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    f32[i] = view.getInt16(i * 2, true) / 32768
  }
  const buffer = ctx.createBuffer(1, sampleCount || 1, sampleRate || 24000)
  buffer.copyToChannel(f32, 0)
  return buffer
}

export function useTtsKaraoke() {
  const [textByTurn, setTextByTurn] = useState({})
  const [activeTurns, setActiveTurns] = useState({})

  const ctxRef = useRef(null)
  const nextStartRef = useRef(0)
  const schedRef = useRef([])        // [{ turnId, seq, text, startAt, endAt }]
  const endedTurnsRef = useRef(new Set()) // turns the VM said are fully emitted
  const sourcesRef = useRef(new Set())
  const rafRef = useRef(0)

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return null
      ctxRef.current = new AudioCtx()
    }
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume().catch(() => {})
    }
    return ctxRef.current
  }, [])

  // Recompute revealed text from the audio clock, and retire finished turns.
  const tick = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) { rafRef.current = 0; return }
    const now = ctx.currentTime

    const byTurn = {}
    for (const s of schedRef.current) {
      const prev = byTurn[s.turnId] || ""
      if (now >= s.endAt) {
        byTurn[s.turnId] = prev + s.text
      } else if (now > s.startAt) {
        const frac = (now - s.startAt) / Math.max(1e-3, s.endAt - s.startAt)
        byTurn[s.turnId] = prev + s.text.slice(0, Math.ceil(s.text.length * frac))
      } else {
        // not started yet — leave whatever earlier sentences contributed
        if (!(s.turnId in byTurn)) byTurn[s.turnId] = prev
      }
    }

    // A turn is finished when the VM has emitted its end AND every scheduled
    // sentence has fully played.
    const stillActive = {}
    for (const turnId of Object.keys(byTurn)) {
      const sentences = schedRef.current.filter((s) => s.turnId === turnId)
      const allPlayed = sentences.every((s) => now >= s.endAt)
      const ended = endedTurnsRef.current.has(turnId)
      // Keep the turn active until every clip has played AND the VM has signaled
      // the turn is fully emitted; only then does the entry revert to full text.
      if (!(allPlayed && ended)) stillActive[turnId] = true
    }

    setTextByTurn((prev) => shallowEqual(prev, byTurn) ? prev : byTurn)
    setActiveTurns((prev) => shallowEqual(prev, stillActive) ? prev : stillActive)

    if (Object.keys(stillActive).length) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      rafRef.current = 0
    }
  }, [])

  const startRaf = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // Schedule any newly-arrived clip(s) gaplessly after whatever is queued.
  const enqueue = useCallback((clip) => {
    const ctx = ensureCtx()
    if (!ctx) return
    const buffer = pcmToAudioBuffer(ctx, clip.pcm, clip.sampleRate)
    const startAt = Math.max(ctx.currentTime + 0.02, nextStartRef.current || 0)
    const endAt = startAt + buffer.duration
    nextStartRef.current = endAt

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => {
      sourcesRef.current.delete(source)
      startRaf()
    }
    sourcesRef.current.add(source)
    source.start(startAt)

    schedRef.current.push({ turnId: clip.turnId, seq: clip.seq, text: clip.text, startAt, endAt })
    startRaf()
  }, [ensureCtx, startRaf])

  // Stop everything for a turn (cancel/error) or, with no turnId, everything.
  const stopTurn = useCallback((turnId) => {
    for (const source of sourcesRef.current) {
      try { source.stop() } catch { /* already stopped */ }
    }
    sourcesRef.current.clear()
    if (turnId) {
      schedRef.current = schedRef.current.filter((s) => s.turnId !== turnId)
      endedTurnsRef.current.delete(turnId)
    } else {
      schedRef.current = []
      endedTurnsRef.current.clear()
    }
    nextStartRef.current = ctxRef.current ? ctxRef.current.currentTime : 0
    // Drop the turn(s) from the reveal state so the entry reverts to full text.
    setActiveTurns((prev) => {
      if (!turnId) return Object.keys(prev).length ? {} : prev
      if (!(turnId in prev)) return prev
      const next = { ...prev }; delete next[turnId]; return next
    })
    setTextByTurn((prev) => {
      if (!turnId) return Object.keys(prev).length ? {} : prev
      if (!(turnId in prev)) return prev
      const next = { ...prev }; delete next[turnId]; return next
    })
  }, [])

  useEffect(() => {
    if (!window.openovel?.onTtsEvent) return undefined
    const off = window.openovel.onTtsEvent((payload) => {
      if (!payload) return
      switch (payload.type) {
        case "audio":
          enqueue(payload)
          break
        case "end":
          if (payload.turnId) endedTurnsRef.current.add(payload.turnId)
          startRaf()
          break
        case "cancel":
        case "error":
          stopTurn(payload.turnId)
          break
        default:
          break
      }
    })
    return () => {
      try { off?.() } catch { /* ignore */ }
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      stopTurn()
    }
  }, [enqueue, startRaf, stopTurn])

  const stop = useCallback(() => {
    stopTurn()
    try { window.openovel?.ttsControl?.("stop") } catch { /* ignore */ }
  }, [stopTurn])

  const speaking = Object.keys(activeTurns).length > 0

  return { textByTurn, activeTurns, speaking, stop }
}

function shallowEqual(a, b) {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}
