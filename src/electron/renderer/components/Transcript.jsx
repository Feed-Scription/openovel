import React, { useCallback, useEffect, useMemo, useRef } from "react"
import { Entry, NARRATION_REHYPE } from "./Entry.jsx"
import { buildRichRenderers } from "./RichBlock.jsx"
import { rehypeHighlightNames } from "../lib/highlightNames.js"

// DOM-native scrolling with a sticky-bottom auto-scroll policy: as new
// content streams in we pin the user to the latest text, but ONLY if
// they were already near the bottom. The moment they scroll up to read
// older entries, auto-scroll backs off. The moment they scroll back to
// the bottom, sticky tracking resumes.
//
// "Near the bottom" uses a 40px threshold so the inevitable 1-2px drift
// from a streaming text shifting layout doesn't accidentally unsticky.
export function Transcript({ entries, formatContract, customRichBlocks = true, characterNames, dialogueTint = true, onShareParagraph, tts, busy, autoScroll = true, comicPanels = null, comicPanelsLive = null }) {
  const ref = useRef(null)
  const lastLen = useRef(0)
  const lastTextLen = useRef(0)
  const stickyBottomRef = useRef(true)
  // Perf: streaming appends text many times/second, and reading scrollHeight /
  // clientHeight forces a synchronous layout flush each time — on a long,
  // justified+hyphenated transcript that reflow is expensive and causes the
  // visible jank. We avoid per-token layout reads entirely:
  //  - clientHeight is cached and only re-measured on resize (clientHRef)
  //  - pinning writes scrollTop = a big number (the browser clamps to max) so
  //    we never READ scrollHeight on the hot path
  //  - onScroll's near-bottom check is rAF-throttled and ignores the scroll
  //    events our own pinning emits (scrollPinnedRef)
  const clientHRef = useRef(0)
  const paddedRef = useRef(false)
  const scrollRafRef = useRef(0)
  const scrollPinnedRef = useRef(false)

  // Built once per contract. Stable identity lets Entry's memo skip re-renders
  // while streaming, and a contract swap produces a NEW reference so completed
  // rich blocks re-render with the updated kinds/CSS.
  const richRenderers = useMemo(
    () => buildRichRenderers(formatContract, { customBlocks: customRichBlocks }),
    [formatContract, customRichBlocks],
  )

  // Character-name highlight: appended after the dialogue-quote tint so name
  // spans nest inside quote spans. Identity is stable per name list (keyed on
  // the joined string, so a fresh-but-equal array from a state patch doesn't
  // re-render every completed entry); with no names this IS NARRATION_REHYPE
  // and the plugin cost disappears entirely.
  const nameKey = Array.isArray(characterNames) ? characterNames.join("\n") : ""
  const narrationRehype = useMemo(
    () => (nameKey ? [...NARRATION_REHYPE, rehypeHighlightNames(nameKey.split("\n"))] : NARRATION_REHYPE),
    [nameKey],
  )

  // Pin to the bottom without reading scrollHeight: a huge scrollTop clamps to
  // the max. Flag the resulting scroll event so onScroll doesn't treat our own
  // pin as the user scrolling away.
  const pinBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    scrollPinnedRef.current = true
    el.scrollTop = 1e9
  }, [])

  const onScroll = useCallback(() => {
    if (scrollPinnedRef.current) { scrollPinnedRef.current = false; return }
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = ref.current
      if (!el) return
      const distance = el.scrollHeight - el.scrollTop - (clientHRef.current || el.clientHeight)
      stickyBottomRef.current = distance < 40
    })
  }, [])

  // Cache the viewport height; refresh only on resize, never per token.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { clientHRef.current = el.clientHeight }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const newest = entries[entries.length - 1]
    const grew =
      entries.length !== lastLen.current ||
      (newest && newest.text.length !== lastTextLen.current)

    if (autoScroll) {
      // Typewriter centering while the narrator is writing: pad the scroll area by
      // ~0.4 viewport so pinning to the end leaves the active line a touch below
      // center (not crawling along the bottom). Too little prose to reach center?
      // the clamp leaves it naturally higher. The pad is toggled ONLY when `busy`
      // flips — never per token — so streaming does no padding work or layout read.
      if (busy && !paddedRef.current) {
        paddedRef.current = true
        el.style.transition = "none"   // instant open so the pin lands centered
        el.style.paddingBottom = `${Math.round((clientHRef.current || el.clientHeight) * 0.4)}px`
        pinBottom()
      } else if (!busy && paddedRef.current) {
        paddedRef.current = false
        el.style.transition = ""        // gentle glide down to rest at turn end
        el.style.paddingBottom = ""
        if (stickyBottomRef.current) pinBottom()
      }

      if (grew) {
        // A brand-new user-typed entry means the reader just submitted; re-pin so
        // they see the narrator's incoming response even if they had scrolled up.
        const userSubmitted =
          entries.length > lastLen.current
          && newest?.type === "user"
        if (userSubmitted) stickyBottomRef.current = true
        if (stickyBottomRef.current) pinBottom()
      }
    } else if (paddedRef.current) {
      // Auto-scroll turned off (possibly mid-stream): release any typewriter pad
      // so the reader's own scroll position isn't fighting reserved blank space.
      paddedRef.current = false
      el.style.transition = ""
      el.style.paddingBottom = ""
    }

    // Bookkeeping stays current regardless of mode, so re-enabling auto-scroll
    // later doesn't see a stale "grew" and jump unexpectedly.
    if (grew) {
      lastLen.current = entries.length
      lastTextLen.current = newest ? newest.text.length : 0
    }
  })

  if (!entries.length) {
    return (
      <div className="transcript transcript-empty">
        <span className="hint">Type a reader action below. /help for commands.</span>
      </div>
    )
  }
  // id="ovl-content" is the structural security boundary for model-authored
  // CSS: it gets `isolation: isolate; overflow: hidden` in theme.css so contract
  // styles can never paint over app chrome (modals/composer render OUTSIDE it).
  return (
    <div
      className={`transcript${busy ? " transcript-locked" : ""}${dialogueTint ? "" : " hl-dq-off"}`}
      id="ovl-content"
      ref={ref}
      onScroll={onScroll}
    >
      {entries.map((entry, i) => {
        // When this narration is being spoken, show the audio-driven (karaoke)
        // prefix instead of the CPM-paced text so words light up as heard.
        const ttsActive = Boolean(entry.tts && tts?.activeTurns?.[entry.tts])
        const ttsText = ttsActive ? (tts?.textByTurn?.[entry.tts] ?? "") : null
        return (
          <Entry
            key={entry.id}
            entry={entry}
            prev={entries[i - 1]}
            richRenderers={richRenderers}
            narrationRehype={narrationRehype}
            onShareParagraph={onShareParagraph}
            ttsText={ttsText}
            ttsActive={ttsActive}
            comicPanels={comicPanels}
            comicPanelsLive={comicPanelsLive}
          />
        )
      })}
    </div>
  )
}
