import React from "react"
import { useTranslation } from "react-i18next"
import { Streamdown, defaultRehypePlugins, useIsCodeFenceIncomplete } from "streamdown"
import { ComicStrip } from "./ComicStrip.jsx"
import { rehypeHighlightQuotes } from "../lib/highlightQuotes.js"
import { stripHudFencesFromText, stripMusicFencesFromText, stripBgFencesFromText, escapeStandaloneListMarkers } from "../lib/richBlockModel.js"

// Streamdown's rehypePlugins prop REPLACES its defaults (raw/sanitize/harden),
// so we spread them back in and append our quote highlighter last — running
// after sanitize means the spans we inject survive the cleanup pass.
export const NARRATION_REHYPE = [...Object.values(defaultRehypePlugins), rehypeHighlightQuotes]

const LANGUAGE_CLASS_RE = /(?:^|\s)language-([^\s]+)/

function languageFromClassName(className) {
  if (typeof className !== "string") return ""
  return className.match(LANGUAGE_CLASS_RE)?.[1] || ""
}

function codeTextFromChildren(children) {
  if (typeof children === "string") return children
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" ? child : "")).join("")
  }
  if (
    React.isValidElement(children) &&
    children.props &&
    typeof children.props.children === "string"
  ) {
    return children.props.children
  }
  return children == null ? "" : String(children)
}

function findRichRenderer(renderers, language) {
  if (!language || !Array.isArray(renderers)) return null
  return renderers.find((renderer) => {
    const langs = renderer?.language
    return Array.isArray(langs) ? langs.includes(language) : langs === language
  }) || null
}

function isRichFenceElement(node, richRenderers) {
  if (!React.isValidElement(node)) return false
  return Boolean(findRichRenderer(richRenderers, languageFromClassName(node.props?.className)))
}

// Streamdown handles paragraph splitting, inline emphasis, and (critically
// for token-by-token streaming) leaves unclosed markers like `*Artif` as
// literal text until the closer arrives — no flicker, no half-rendered
// italics. We override the default `<p>` so it carries the existing
// `.entry-para` class (Kindle-style first-line indent + paragraph rhythm).
export function buildNarrationComponents(richRenderers = null) {
  return {
    p: ({ children, ...props }) => (
      <p className="entry-para" {...props}>
        {children}
      </p>
    ),
    // Replace Streamdown's default CodeBlock (shiki syntax highlighting +
    // download/copy buttons + language header) with a quiet, plain block. In a
    // novel those controls are noise, and the shiki chrome needs CSS we don't
    // ship; a plain monospace block on a soft background fits the reading view
    // and also avoids loading the heavy shiki chunk at all. For contract-defined
    // `ovl:*` fences, keep Streamdown's custom renderer path alive before the
    // plain-code fallback, otherwise rich blocks render as raw grey code cards.
    pre: ({ children }) => {
      const childArray = React.Children.toArray(children)
      const onlyChild = childArray.length === 1 ? childArray[0] : null
      if (isRichFenceElement(onlyChild, richRenderers)) return onlyChild
      return <pre className="entry-codeblock">{children}</pre>
    },
    code: ({ node, className, children, ...props }) => {
      const isIncomplete = useIsCodeFenceIncomplete()
      const language = languageFromClassName(className)
      const isBlock = typeof className === "string" && className.includes("language-")
      const renderer = isBlock ? findRichRenderer(richRenderers, language) : null
      if (renderer?.component) {
        const RichRenderer = renderer.component
        return (
          <RichRenderer
            code={codeTextFromChildren(children)}
            isIncomplete={isIncomplete}
            language={language}
            meta={node?.properties?.metastring}
          />
        )
      }
      return (
        <code className={isBlock ? "entry-code-block" : "entry-code-inline"} {...props}>
          {children}
        </code>
      )
    },
  }
}

export const NARRATION_COMPONENTS = buildNarrationComponents()

function NarrationLoading() {
  return (
    <div className="entry-loading" role="status" aria-label="Narration loading">
      <span className="entry-loading-dot" />
      <span className="entry-loading-dot" />
      <span className="entry-loading-dot" />
    </div>
  )
}

// A slash command is a system interaction, not an in-world action; we render
// the echo and its output as a paired terminal-style block instead of as a
// reader-action quote. The output detection is "system entry whose prev is a
// command echo" — slash commands push exactly one system response.
function isCommandEcho(entry) {
  return entry?.type === "user" && typeof entry.text === "string" && entry.text.startsWith("/")
}

function EntryView({ entry, prev, richRenderers, narrationRehype = NARRATION_REHYPE, onShareParagraph, ttsText = null, ttsActive = false, comicPanels = null, comicPanelsLive = null }) {
  const { t } = useTranslation()
  const narrationComponents = React.useMemo(() => buildNarrationComponents(richRenderers), [richRenderers])
  const cursor = !entry.complete ? <span className="entry-cursor" /> : null

  if (entry.type === "narration") {
    // While the narrator's voice is reading this turn, the displayed text is
    // the audio-driven prefix (karaoke); otherwise it's the entry's own text.
    const rawText = ttsActive && ttsText != null ? ttsText : (entry.text || "")
    // Comic mode (experimental): a narration whose text carries ovl:panel
    // fences renders as a picture-story strip instead of prose. Entry-level
    // detection keeps the transcript self-describing — prose turns and comic
    // turns coexist in one story (mode switched mid-story) and old saves
    // replay correctly without any renderer-side mode flag.
    if (rawText.includes("```ovl:panel")) {
      // The index-keyed live statuses belong to the CURRENT turn only — apply
      // them to the still-streaming entry, never to completed/replayed strips
      // (their panels resolve by injected rel path or straight from disk).
      return (
        <div className="entry entry-narration entry-comic">
          <ComicStrip
            text={rawText}
            animating={!entry.complete}
            panelStatus={comicPanels}
            liveStatus={entry.complete ? null : comicPanelsLive}
          />
        </div>
      )
    }
    // `ovl:hud` is a reserved data channel, never prose. Strip it even before
    // the first format-contract refresh has reached the renderer; otherwise the
    // inaugural HUD update can briefly degrade into a plain code block.
    // escapeStandaloneListMarkers last: a bare "1999." line would otherwise be
    // parsed as an ordered list and render its marker clipped in the gutter.
    const narrationText = escapeStandaloneListMarkers(stripBgFencesFromText(stripMusicFencesFromText(stripHudFencesFromText(rawText))))
    const animating = !entry.complete || ttsActive
    // Always render narration through Streamdown, including while streaming.
    // Completed entries are memoized, so only the active entry reparses; this
    // avoids brittle markdown-shape heuristics and keeps `---`, headings,
    // lists, tables, and quotes structural from the first paint.
    // richRenderers (when a format contract is active) maps `ovl:<kind>` fences
    // to <RichBlock>; absent that, those fences render as plain code blocks.
    const canShare = entry.complete && !ttsActive && onShareParagraph && String(entry.text || "").trim()
    const awaitingFirstGlyph = Boolean(entry.pending && !entry.complete && narrationText.length === 0)
    return (
      <div className={`entry entry-narration${ttsActive ? " entry-narration-speaking" : ""}`}>
        {awaitingFirstGlyph ? (
          <NarrationLoading />
        ) : (
          <Streamdown
            components={narrationComponents}
            rehypePlugins={narrationRehype}
            plugins={richRenderers ? { renderers: richRenderers } : undefined}
            parseIncompleteMarkdown
            controls={false}
            isAnimating={animating}
          >
            {narrationText}
          </Streamdown>
        )}
        {canShare && (
          <div className="entry-share-toolbar" data-html2canvas-ignore="true">
            <button
              type="button"
              className="entry-share-btn"
              title={t("share.copy", { defaultValue: "Copy as image" })}
              aria-label={t("share.copy", { defaultValue: "Copy as image" })}
              onClick={() => onShareParagraph(entry.text, "copy")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
            </button>
            <button
              type="button"
              className="entry-share-btn"
              title={t("share.save", { defaultValue: "Save as image" })}
              aria-label={t("share.save", { defaultValue: "Save as image" })}
              onClick={() => onShareParagraph(entry.text, "save")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12" />
                <path d="M7 11l5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
            </button>
          </div>
        )}
      </div>
    )
  }

  if (entry.type === "user") {
    if (isCommandEcho(entry)) {
      return (
        <div className="entry entry-command">
          <span className="entry-command-prompt">❯</span>
          <span className="entry-command-text">{entry.text}</span>
          {cursor}
        </div>
      )
    }
    return (
      <div className="entry entry-user">
        <span className="entry-text">{entry.text}</span>
        {cursor}
      </div>
    )
  }

  if (entry.type === "system" && isCommandEcho(prev)) {
    return (
      <div className="entry entry-command-output">
        <pre className="entry-command-output-text">{entry.text}{cursor}</pre>
      </div>
    )
  }

  const prefix = entry.type === "error" ? "! " : "· "
  return (
    <div className={`entry entry-${entry.type}`}>
      <span className="entry-prefix">{prefix}</span>
      <span className="entry-text">{entry.text}</span>
      {cursor}
    </div>
  )
}

// The VM clones the whole entries array on every getState() (state.js spreads
// `entries.map(e => ({...e}))`), so every entry/prev object is a fresh
// reference each render — a default shallow memo would never hit. Compare the
// fields that actually drive output instead: the entry's id/type/text/complete,
// plus whether `prev` is a command echo (the only way prev affects rendering,
// via isCommandEcho). For completed entries these are value-stable, so during
// a streaming turn only the one growing entry re-renders; the other N-1 (each
// a Streamdown markdown+rehype parse) are skipped. This is the fix for the
// long-session main-thread stall: render cost stops scaling with turn count.
function entryPropsEqual(a, b) {
  return (
    a.entry.id === b.entry.id &&
    a.entry.type === b.entry.type &&
    a.entry.complete === b.entry.complete &&
    a.entry.pending === b.entry.pending &&
    a.entry.text === b.entry.text &&
    // richRenderers has a stable identity per contract (Transcript useMemo), so
    // a contract swap forces completed rich blocks to re-render with new kinds.
    a.richRenderers === b.richRenderers &&
    // Same pattern for the rehype list: stable per character-name list, a new
    // list re-renders completed entries so fresh names tint everywhere.
    a.narrationRehype === b.narrationRehype &&
    a.onShareParagraph === b.onShareParagraph &&
    // Karaoke reveal drives the displayed text while speaking — the growing
    // entry must re-render each frame even though entry.text is unchanged.
    a.ttsText === b.ttsText &&
    a.ttsActive === b.ttsActive &&
    // Comic mode: panel lifecycle events swap placeholders for images on
    // completed entries. The map's identity changes only per panel event (a
    // few per comic turn), so the broad re-render this triggers is cheap.
    a.comicPanels === b.comicPanels &&
    a.comicPanelsLive === b.comicPanelsLive &&
    isCommandEcho(a.prev) === isCommandEcho(b.prev)
  )
}

export const Entry = React.memo(EntryView, entryPropsEqual)
