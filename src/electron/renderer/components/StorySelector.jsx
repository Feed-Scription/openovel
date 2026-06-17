import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import i18n from "../lib/i18n.js"
import { HalftoneCover } from "./HalftoneCover.jsx"

// Query the grid's actual rendered column count at this exact moment.
// We read CSS `grid-template-columns` instead of caching a value because
// the grid is `auto-fill, minmax(...)` — column count changes with window
// width, so a cached value would lie after a resize.
function gridColumnCount(el) {
  if (!el) return 1
  const tracks = window.getComputedStyle(el).gridTemplateColumns
  if (!tracks) return 1
  return Math.max(1, tracks.split(" ").filter(Boolean).length)
}

const RELEASES_URL = "https://github.com/Feed-Scription/openovel/releases"

// Web-demo gate copy for desktop-only actions (new story / import).
function desktopOnlyMessage(kind) {
  const zh = String(i18n.language || "").startsWith("zh")
  if (zh) {
    return kind === "import"
      ? `导入故事需要桌面版 openovel。\n下载：${RELEASES_URL}`
      : `新建故事需要桌面版 openovel（含对话式初始化与后台 Agent）。\n下载：${RELEASES_URL}`
  }
  return kind === "import"
    ? `Importing a story needs the openovel desktop app.\nDownload: ${RELEASES_URL}`
    : `Creating a new story needs the openovel desktop app (conversational init + background agents).\nDownload: ${RELEASES_URL}`
}

function formatBytes(n) {
  if (!n || n < 1) return ""
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / (1024 * 1024)).toFixed(1)}M`
}

function formatTouched(iso) {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (!t) return ""
  const d = Date.now() - t
  const m = Math.floor(d / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return new Date(t).toISOString().slice(0, 10)
}

export function StorySelector({ state, actions }) {
  const { t } = useTranslation()
  const sel = state.storySelector
  const gridRef = useRef(null)
  // Per-card popover state: which card's `⋯` menu is open, and which (if
  // any) has Delete armed for a confirm-on-second-click pattern. Click
  // anywhere else closes both.
  const [menuFor, setMenuFor] = useState(null)
  const [deleteArmed, setDeleteArmed] = useState(null)
  // Which card's title is being inline-edited (rename). Electron has no
  // window.prompt, so renaming turns the card name into an editable input.
  const [renamingFor, setRenamingFor] = useState(null)
  if (!sel) return null

  const closeMenu = useCallback(() => {
    setMenuFor(null)
    setDeleteArmed(null)
  }, [])

  // Click outside any menu closes it. Esc too. The menu itself is portaled
  // to document.body, so a click on it has `closest(".story-card-menu")`
  // truthy but not `.story-card-menu-wrap` — we accept either.
  useEffect(() => {
    if (!menuFor) return
    const onDoc = (e) => {
      if (e.target.closest(".story-card-menu-wrap")) return
      if (e.target.closest(".story-card-menu")) return
      closeMenu()
    }
    const onKey = (e) => { if (e.key === "Escape") closeMenu() }
    window.addEventListener("mousedown", onDoc)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDoc)
      window.removeEventListener("keydown", onKey)
    }
  }, [menuFor, closeMenu])

  // Import card → file dialog → VM restores into a new slot. Main does
  // the file IO; we just trigger and surface the outcome.
  const onPickImport = useCallback(async () => {
    closeMenu()
    // In the web demo, importing needs the local-first desktop runtime.
    if (window.openovel?.isWeb) {
      window.alert(desktopOnlyMessage("import"))
      return
    }
    try {
      const r = await window.openovel.importStory()
      if (r?.cancelled) return
      if (!r?.ok) {
        window.alert(`Could not import: ${r?.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`Import failed: ${err?.message || err}`)
    }
  }, [closeMenu])

  // New stories run the conversational initializer + background agents, which
  // only exist in the desktop app; in the web demo point readers to the download.
  const onPickNew = useCallback(() => {
    closeMenu()
    if (window.openovel?.isWeb) {
      window.alert(desktopOnlyMessage("new"))
      return
    }
    actions.confirmStorySelection()
  }, [closeMenu, actions])

  // Export → save dialog → VM creates the bundle, main writes it.
  // `kind` = "current" (live state right now) or "initial" (the
  // auto-saved snapshot from right after init, before any reader turns).
  const onPickExport = useCallback(async (item, kind = "current") => {
    closeMenu()
    try {
      const r = await window.openovel.exportStory(item.id, kind)
      if (r?.cancelled) return
      if (!r?.ok) {
        window.alert(`Could not export: ${r?.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`Export failed: ${err?.message || err}`)
    }
  }, [closeMenu])

  // Novel export → save dialog → VM generates EPUB / TXT, main writes it.
  // Different code path from onPickExport (which dumps a JSON snapshot for
  // round-trip restore); this one builds a readable ebook for the user.
  const onPickExportNovel = useCallback(async (item, format = "epub") => {
    closeMenu()
    try {
      const r = await window.openovel.exportNovel(item.id, format, i18n.language || "zh")
      if (r?.cancelled) return
      if (!r?.ok) {
        window.alert(`Could not export: ${r?.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`Export failed: ${err?.message || err}`)
    }
  }, [closeMenu])

  const onPickReplayInit = useCallback(async (item) => {
    closeMenu()
    try {
      const r = await actions.replayStoryInit(item.id)
      if (r && r.ok === false) window.alert(`Could not replay: ${r.error || "no recorded init"}`)
    } catch (err) {
      window.alert(`Replay failed: ${err?.message || err}`)
    }
  }, [actions, closeMenu])

  // Continue an unfinished initialization: opens the story and restores the
  // init-chat (auto-continuing an interrupted run; cancelled/failed runs come
  // back with the conversation + intent prefilled, one send to relaunch).
  const onPickResumeInit = useCallback(async (item) => {
    closeMenu()
    try {
      const r = await actions.resumeStoryInit(item.id)
      if (r && r.ok === false) {
        window.alert(`${t("stories.menu.resumeInitFailed", { defaultValue: "Could not continue initialization" })}: ${r.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`${t("stories.menu.resumeInitFailed", { defaultValue: "Could not continue initialization" })}: ${err?.message || err}`)
    }
  }, [actions, closeMenu, t])

  // Restart → bank the current playthrough as a version, then restore the
  // post-init opening. The VM re-enters the story showing the fresh opening.
  const onPickRestart = useCallback(async (item) => {
    closeMenu()
    try {
      const r = await actions.restartStory(item.id)
      if (r && r.ok === false) window.alert(`${t("stories.menu.restartFailed", { defaultValue: "Could not restart" })}: ${r.error || "unknown error"}`)
    } catch (err) {
      window.alert(`${t("stories.menu.restartFailed", { defaultValue: "Could not restart" })}: ${err?.message || err}`)
    }
  }, [actions, closeMenu, t])

  // Lazy-load a story's banked versions when the user opens the history submenu.
  const onLoadVersions = useCallback((item) => actions.listStoryVersions(item.id), [actions])

  // Restore → bank current, then switch the story to the chosen version.
  const onPickRestoreVersion = useCallback(async (item, versionId) => {
    closeMenu()
    try {
      const r = await actions.restoreStoryVersion(item.id, versionId)
      if (r && r.ok === false) window.alert(`${t("stories.menu.restoreFailed", { defaultValue: "Could not restore version" })}: ${r.error || "unknown error"}`)
    } catch (err) {
      window.alert(`${t("stories.menu.restoreFailed", { defaultValue: "Could not restore version" })}: ${err?.message || err}`)
    }
  }, [actions, closeMenu, t])

  const onPickRename = useCallback((item) => {
    closeMenu()
    setRenamingFor(item.id)
  }, [closeMenu])

  // Story modes (experimental comic / fast): flip the story's mode toward
  // `target`, or back to prose when it's already there. The VM refuses to turn
  // comic on without a configured image provider — surface that as the
  // localized "set up Settings → Image first" hint, not a raw error.
  const onPickToggleMode = useCallback(async (item, target) => {
    closeMenu()
    try {
      const next = item.mode === target ? "" : target
      const r = await actions.setStoryMode(item.id, next)
      if (r && r.ok === false) {
        window.alert(r.error === "needs-image-provider"
          ? t("settings.behavior.toggles.comicMode.needsImageProvider", { defaultValue: "Comic mode generates pictures every turn. Configure image generation under Settings → Image first." })
          : `Could not switch mode: ${r.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`Could not switch mode: ${err?.message || err}`)
    }
  }, [actions, closeMenu, t])

  const onCommitRename = useCallback(async (item, value) => {
    setRenamingFor(null)
    const next = String(value || "").trim()
    // No-op on empty or unchanged — don't churn meta.json or flash an alert.
    if (!next || next === (item.displayName || item.id)) return
    try {
      const r = await actions.renameStory(item.id, next)
      if (r && r.ok === false) window.alert(`Could not rename: ${r.error || "unknown error"}`)
    } catch (err) {
      window.alert(`Rename failed: ${err?.message || err}`)
    }
  }, [actions])

  const onCancelRename = useCallback(() => setRenamingFor(null), [])

  const onPickDelete = useCallback(async (item) => {
    // First click: arm the confirm state. Second click on the (now red)
    // button actually deletes. VM auto-refreshes the selector list.
    if (deleteArmed !== item.id) {
      setDeleteArmed(item.id)
      return
    }
    closeMenu()
    try {
      const r = await actions.deleteStory(item.id)
      if (!r?.ok) {
        // We don't have a toast surface here; surface via window.alert as
        // the simplest fallback — the failure cases are rare (active story
        // or filesystem error) and the user benefits from an explicit
        // explanation rather than silent failure.
        window.alert(`Could not delete: ${r?.error || "unknown error"}`)
      }
    } catch (err) {
      window.alert(`Delete failed: ${err?.message || err}`)
    }
  }, [actions, deleteArmed, closeMenu])

  useEffect(() => {
    const onKey = (e) => {
      // Arrow keys / Enter shouldn't navigate the grid while a popover is
      // open — that would feel like the keyboard is fighting the mouse.
      if (menuFor) return
      // Don't hijack typing in the search box / sort select.
      if (e.target?.closest?.("input, textarea, select")) return
      // ← / → step one cell. ↑ / ↓ step one row, which = current column
      // count in the grid. The column count is read at keypress time so
      // window resizes (which change auto-fill column count) Just Work.
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        actions.moveStorySelector(-1)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        actions.moveStorySelector(1)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        actions.moveStorySelector(-gridColumnCount(gridRef.current))
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        actions.moveStorySelector(gridColumnCount(gridRef.current))
      } else if (e.key === "Enter") {
        e.preventDefault()
        const item = sel.items[sel.cursor]
        if (item?.isImport) onPickImport()
        else if (item?.isNew) onPickNew()
        else actions.confirmStorySelection()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [actions, menuFor, onPickImport, sel])

  const openStoryItem = useCallback((item, idx) => {
    actions.moveStorySelector(idx - sel.cursor)
    if (item.isImport) onPickImport()
    else if (item.isNew) onPickNew()
    else actions.confirmStorySelection()
  }, [actions, onPickImport, onPickNew, sel.cursor])

  return (
    <div className="story-selector">
      <div className="story-selector-bar">
        <h2 className="story-selector-title">{t("stories.title")}</h2>
        <div className="story-selector-tools">
          <LibrarySearch
            defaultValue={sel.query || ""}
            placeholder={t("stories.searchPlaceholder", { defaultValue: "Search stories…" })}
            onSearch={(q) => actions.setStorySearch(q)}
          />
          <select
            className="story-sort-select"
            value={sel.sortBy || "recent"}
            onChange={(e) => actions.setStorySort(e.target.value)}
            aria-label={t("stories.sort.label", { defaultValue: "Sort by" })}
          >
            <option value="recent">{t("stories.sort.recent", { defaultValue: "Recent" })}</option>
            <option value="name">{t("stories.sort.name", { defaultValue: "Name" })}</option>
            <option value="size">{t("stories.sort.size", { defaultValue: "Size" })}</option>
          </select>
        </div>
      </div>
      <ul className="story-grid" ref={gridRef}>
        {sel.items.map((item, idx) => (
          <StoryCard
            key={item.id}
            item={item}
            selected={idx === sel.cursor}
            menuOpen={menuFor === item.id}
            deleteArmed={deleteArmed === item.id}
            renaming={renamingFor === item.id}
            onClick={() => openStoryItem(item, idx)}
            onToggleMenu={(e) => {
              e.stopPropagation()
              setDeleteArmed(null)
              setMenuFor(menuFor === item.id ? null : item.id)
            }}
            onDelete={() => onPickDelete(item)}
            onExport={(kind) => onPickExport(item, kind)}
            onExportNovel={(format) => onPickExportNovel(item, format)}
            onReplayInit={() => onPickReplayInit(item)}
            onResumeInit={() => onPickResumeInit(item)}
            onRestart={() => onPickRestart(item)}
            onLoadVersions={() => onLoadVersions(item)}
            onRestoreVersion={(versionId) => onPickRestoreVersion(item, versionId)}
            onStartRename={() => onPickRename(item)}
            onRenameCommit={(v) => onCommitRename(item, v)}
            onRenameCancel={onCancelRename}
            comicModeAvailable={sel.comicModeAvailable === true}
            fastModeAvailable={sel.fastModeAvailable === true}
            onToggleComicMode={() => onPickToggleMode(item, "comic")}
            onToggleFastMode={() => onPickToggleMode(item, "fast")}
          />
        ))}
      </ul>
      <p className="story-selector-hint">
        {t("stories.hint")}
      </p>
    </div>
  )
}

// Estimated menu dimensions for edge-aware positioning. Real measurement
// (after first render) is also done below — these are the FIRST-paint
// fallback so the menu doesn't flash in the wrong place. Match them to the
// CSS in theme.css so the math agrees.
const MENU_WIDTH = 200
const MENU_GAP = 4         // vertical gap between button and menu
const VIEWPORT_MARGIN = 8  // never let the menu hug a viewport edge

function computeMenuPosition(buttonRect) {
  // Default: align menu right edge to button right edge, opening leftward.
  // Then flip / clamp so the menu always stays inside the viewport.
  let left = buttonRect.right - MENU_WIDTH
  if (left < VIEWPORT_MARGIN) {
    // Card is near the left edge — flip to align menu's LEFT to button's LEFT
    left = buttonRect.left
  }
  if (left + MENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
    left = window.innerWidth - VIEWPORT_MARGIN - MENU_WIDTH
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
  const top = buttonRect.bottom + MENU_GAP
  return { top, left }
}

// Library search box. Uncontrolled (defaultValue) + composition-aware so CJK
// IME composition isn't interrupted — we only push to the VM on a committed
// change or compositionend, never mid-composition.
function LibrarySearch({ defaultValue, placeholder, onSearch }) {
  const composingRef = useRef(false)
  return (
    <input
      className="story-search-input"
      type="search"
      defaultValue={defaultValue}
      placeholder={placeholder}
      spellCheck={false}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={(e) => { composingRef.current = false; onSearch(e.target.value) }}
      onChange={(e) => { if (!composingRef.current) onSearch(e.target.value) }}
    />
  )
}

// Inline editor for a card's display name. Self-contained so Enter/Esc/blur
// resolve exactly once (a `done` guard stops Esc-then-blur or Enter-then-blur
// from committing twice). Click/keys stop propagating so editing doesn't also
// select or open the card.
function RenameInput({ initial, onCommit, onCancel }) {
  const ref = useRef(null)
  const doneRef = useRef(false)
  const finish = useCallback((commit) => {
    if (doneRef.current) return
    doneRef.current = true
    const val = (ref.current?.value || "").trim()
    if (commit && val) onCommit(val)
    else onCancel()
  }, [onCommit, onCancel])
  return (
    <input
      ref={ref}
      className="story-card-rename-input"
      defaultValue={initial}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") { e.preventDefault(); finish(true) }
        else if (e.key === "Escape") { e.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true)}
    />
  )
}

// Cover art cache: storyId@version → dataUrl (null = known miss). Module-level
// so re-renders and grid re-mounts don't refetch; version (file mtime) busts
// the entry when the cover is regenerated.
const coverCache = new Map()

function useStoryCover(item) {
  const key = item?.coverFile ? `${item.id}@${item.coverVersion || 0}` : ""
  const [src, setSrc] = useState(() => (key && coverCache.get(key)) || null)
  useEffect(() => {
    if (!key) { setSrc(null); return undefined }
    const cached = coverCache.get(key)
    if (cached !== undefined) { setSrc(cached); return undefined }
    if (typeof window.openovel?.getStoryCover !== "function") return undefined
    let alive = true
    window.openovel.getStoryCover(item.id).then((res) => {
      const value = res?.ok && res.dataUrl ? res.dataUrl : null
      coverCache.set(key, value)
      if (alive) setSrc(value)
    }).catch(() => { coverCache.set(key, null) })
    return () => { alive = false }
  }, [key, item?.id])
  return src
}

// Cover tone: per-band luminance of the art decides whether the title/foot
// band keeps the default paper veil + ink type or flips to an ink scrim with
// paper type knocked out (.cover-head-dark / .cover-foot-dark in theme.css).
// Measured on a thumbnail canvas; results cached by dataUrl so a grid
// re-mount never re-decodes. Light is the safe default while (or if) the
// measurement is pending/failed — it matches the art-less card treatment.
const LIGHT_TONES = Object.freeze({ head: "light", foot: "light" })
const coverToneCache = new Map()

function analyzeCoverTones(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const w = 24
        const h = 36
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, w, h)
        const bandLuma = (y0, y1) => {
          const top = Math.round(h * y0)
          const rows = Math.max(1, Math.round(h * (y1 - y0)))
          const data = ctx.getImageData(0, top, w, rows).data
          let sum = 0
          for (let i = 0; i < data.length; i += 4) {
            sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          }
          return sum / (data.length / 4) / 255
        }
        // Head band matches the title zone (28% top padding + up to 5 lines);
        // foot band the metadata strip. Below the threshold the paper veil
        // would land on mid-grey, so the band flips to scrim + paper type.
        resolve({
          head: bandLuma(0.04, 0.48) < 0.45 ? "dark" : "light",
          foot: bandLuma(0.78, 0.98) < 0.45 ? "dark" : "light",
        })
      } catch {
        resolve(LIGHT_TONES)
      }
    }
    img.onerror = () => resolve(LIGHT_TONES)
    img.src = src
  })
}

function useCoverTones(src) {
  const [tones, setTones] = useState(() => (src && coverToneCache.get(src)) || LIGHT_TONES)
  useEffect(() => {
    if (!src) { setTones(LIGHT_TONES); return undefined }
    const cached = coverToneCache.get(src)
    if (cached) { setTones(cached); return undefined }
    let alive = true
    analyzeCoverTones(src).then((t) => {
      coverToneCache.set(src, t)
      if (alive) setTones(t)
    })
    return () => { alive = false }
  }, [src])
  return tones
}

function StoryCard({
  item,
  selected,
  menuOpen,
  deleteArmed,
  renaming,
  comicModeAvailable,
  fastModeAvailable,
  onClick,
  onToggleMenu,
  onDelete,
  onExport,
  onExportNovel,
  onReplayInit,
  onResumeInit,
  onRestart,
  onLoadVersions,
  onRestoreVersion,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onToggleComicMode,
  onToggleFastMode,
}) {
  const { t } = useTranslation()
  const buttonRef = useRef(null)
  const [menuPos, setMenuPos] = useState(null)
  const coverSrc = useStoryCover(item)
  const coverTones = useCoverTones(coverSrc)
  // Restart confirm-on-second-click + lazy-loaded version history. All reset
  // when the menu closes so a re-open starts clean.
  const [restartArmed, setRestartArmed] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  useEffect(() => {
    if (menuOpen) return
    setRestartArmed(false)
    setVersionsOpen(false)
    setVersions(null)
    setVersionsLoading(false)
  }, [menuOpen])

  const toggleVersions = useCallback(async () => {
    setRestartArmed(false)
    if (versionsOpen) { setVersionsOpen(false); return }
    setVersionsOpen(true)
    if (versions === null) {
      setVersionsLoading(true)
      try {
        const r = await onLoadVersions?.()
        setVersions(Array.isArray(r?.versions) ? r.versions : [])
      } catch {
        setVersions([])
      } finally {
        setVersionsLoading(false)
      }
    }
  }, [versionsOpen, versions, onLoadVersions])

  // Measure once the menu opens, then again on resize / scroll while it's
  // open. The grid scrolls vertically, so a long fade-out animation isn't
  // worth the complexity — we just recompute on demand.
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuPos(null); return }
    const update = () => {
      if (!buttonRef.current) return
      setMenuPos(computeMenuPosition(buttonRef.current.getBoundingClientRect()))
    }
    update()
    window.addEventListener("resize", update)
    // Capture-phase scroll listener catches scrolling inside ANY ancestor
    // (the .story-grid in our case) without needing to know which one.
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [menuOpen])

  if (item.isNew) {
    return (
      <li
        className={`story-card story-card-new${selected ? " is-selected" : ""}`}
        onClick={onClick}
      >
        <div className="story-card-cover">
          <span className="story-card-plus" aria-hidden="true">+</span>
          <span className="story-card-new-label">{t("stories.newStory")}</span>
        </div>
      </li>
    )
  }
  if (item.isImport) {
    return (
      <li
        className={`story-card story-card-new${selected ? " is-selected" : ""}`}
        onClick={onClick}
      >
        <div className="story-card-cover">
          <span className="story-card-plus" aria-hidden="true">↥</span>
          <span className="story-card-new-label">{t("stories.import")}</span>
        </div>
      </li>
    )
  }
  const name = item.isProjectLocal ? "./story" : (item.displayName || item.id)
  const size = item.chapterBytes ? formatBytes(item.chapterBytes) : ""
  const touched = formatTouched(item.lastTouched)
  // The project-local sentinel is the workspace root itself — deleting it
  // would wipe ./story without warning, which is almost never what the
  // user wants. Hide the menu entirely for that card.
  const canMenu = !item.isProjectLocal
  return (
    <li
      className={`story-card${selected ? " is-selected" : ""}${menuOpen ? " has-menu-open" : ""}`}
      onClick={onClick}
    >
      <div
        className={`story-card-cover${coverTones.head === "dark" ? " cover-head-dark" : ""}${coverTones.foot === "dark" ? " cover-foot-dark" : ""}`}
      >
        {/* Halftone dot-art is the COVERLESS look (and the loading state);
            once prepared cover art exists it replaces the pattern outright —
            real art + dots peeking through the veil reads as visual noise. */}
        {!coverSrc && <HalftoneCover seed={item.id} />}
        {coverSrc && (
          <>
            {/* Prepared cover art (story/includes/cover.*); the veil keeps the
                host-overlaid title/footer legible. */}
            <img className="story-card-cover-img" src={coverSrc} alt="" aria-hidden="true" />
            <span className="story-card-cover-veil" aria-hidden="true" />
          </>
        )}
        <div className="story-card-cover-head">
          {renaming ? (
            <RenameInput
              initial={item.displayName || item.id}
              onCommit={onRenameCommit}
              onCancel={onRenameCancel}
            />
          ) : (
            <span className="story-card-cover-name">{name}</span>
          )}
          <span className="story-card-cover-rule" aria-hidden="true" />
          {item.isProjectLocal && (
            <span className="story-card-cover-tag">project</span>
          )}
        </div>
        <div className="story-card-cover-foot">
          {size && <span>{size}</span>}
          {size && touched && <span className="story-card-cover-foot-dot">·</span>}
          {touched && <span>{touched}</span>}
          {!size && !touched && <span className="story-card-cover-foot-fade">openovel</span>}
        </div>
      </div>
      {canMenu && (
        <div className="story-card-menu-wrap">
          <button
            ref={buttonRef}
            type="button"
            className="story-card-menu-btn"
            aria-label="Story actions"
            onClick={onToggleMenu}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⋯
          </button>
          {menuOpen && menuPos && createPortal(
            <ul
              className="story-card-menu"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }}
            >
              {/* Unfinished init: the story's primary pending action, so it
                  leads the menu. Restores the init-chat (resumeStoryInit). */}
              {item.initUnfinished && (
                <>
                  <li>
                    <button
                      type="button"
                      className="story-card-menu-item"
                      onClick={(e) => { e.stopPropagation(); onResumeInit?.() }}
                    >
                      {t("stories.menu.resumeInit", { defaultValue: "Continue initialization" })}
                    </button>
                  </li>
                  <li className="story-card-menu-divider" aria-hidden="true" />
                </>
              )}
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onStartRename?.() }}
                >
                  {t("stories.menu.rename", { defaultValue: "Rename story" })}
                </button>
              </li>
              <li className="story-card-menu-divider" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className={`story-card-menu-item${restartArmed ? " is-armed" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (item.hasInitialSnapshot === false) return
                    if (!restartArmed) { setRestartArmed(true); return }
                    onRestart?.()
                  }}
                  disabled={item.hasInitialSnapshot === false}
                  title={
                    item.hasInitialSnapshot === false
                      ? t("stories.menu.restartMissing", { defaultValue: "No saved opening to restart from" })
                      : t("stories.menu.restartHint", { defaultValue: "Current progress is saved as a version" })
                  }
                >
                  {restartArmed
                    ? t("stories.menu.restartConfirm", { defaultValue: "Confirm restart" })
                    : t("stories.menu.restart", { defaultValue: "Restart from opening" })}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); toggleVersions() }}
                >
                  {versionsOpen ? "▾ " : "▸ "}{t("stories.menu.versions", { defaultValue: "Saved versions" })}
                  {item.versionCount > 0 && (
                    <span className="story-card-menu-hint"> · {item.versionCount}</span>
                  )}
                </button>
              </li>
              {versionsOpen && versionsLoading && (
                <li>
                  <button type="button" className="story-card-menu-item" disabled>
                    {t("stories.menu.versionsLoading", { defaultValue: "loading…" })}
                  </button>
                </li>
              )}
              {versionsOpen && !versionsLoading && versions && versions.length === 0 && (
                <li>
                  <button type="button" className="story-card-menu-item" disabled>
                    {t("stories.menu.versionsEmpty", { defaultValue: "no saved versions yet" })}
                  </button>
                </li>
              )}
              {versionsOpen && !versionsLoading && versions && versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className="story-card-menu-item"
                    onClick={(e) => { e.stopPropagation(); onRestoreVersion?.(v.id) }}
                    title={t("stories.menu.restoreVersion", { defaultValue: "Switch back to this version" })}
                  >
                    {t("stories.menu.versionLabel", { defaultValue: "turn {{n}}", n: v.turnCount })}
                    <span className="story-card-menu-hint"> · {formatTouched(v.at)}</span>
                  </button>
                </li>
              ))}
              {item.hasInitReplay && (
                <li>
                  <button
                    type="button"
                    className="story-card-menu-item"
                    onClick={(e) => { e.stopPropagation(); onReplayInit?.() }}
                  >
                    {t("stories.menu.replayInit", { defaultValue: "Replay init" })}
                  </button>
                </li>
              )}
              {/* Comic mode (experimental): per-story presentation switch, only
                  rendered when the global Settings → Behavior gate is on. */}
              {comicModeAvailable && (
                <li>
                  <button
                    type="button"
                    className="story-card-menu-item"
                    onClick={(e) => { e.stopPropagation(); onToggleComicMode?.() }}
                  >
                    {item.mode === "comic"
                      ? t("settings.behavior.toggles.comicMode.menuOff", { defaultValue: "Back to prose mode" })
                      : t("settings.behavior.toggles.comicMode.menuOn", { defaultValue: "Switch to comic mode" })}
                  </button>
                </li>
              )}
              {/* Fast mode (experimental): per-story pacing switch, same
                  two-level gating as comic mode. Picking it from a comic story
                  replaces the mode (one meta.json field). */}
              {fastModeAvailable && (
                <li>
                  <button
                    type="button"
                    className="story-card-menu-item"
                    onClick={(e) => { e.stopPropagation(); onToggleFastMode?.() }}
                  >
                    {item.mode === "fast"
                      ? t("settings.behavior.toggles.fastMode.menuOff", { defaultValue: "Back to normal pacing" })
                      : t("settings.behavior.toggles.fastMode.menuOn", { defaultValue: "Switch to fast mode" })}
                  </button>
                </li>
              )}
              <li className="story-card-menu-divider" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onExportNovel?.("epub") }}
                >
                  {t("stories.menu.exportEpub")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onExportNovel?.("txt") }}
                >
                  {t("stories.menu.exportTxt")}
                </button>
              </li>
              <li className="story-card-menu-divider" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onExport?.("current") }}
                >
                  {t("stories.menu.exportCurrent")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onExport?.("initial") }}
                  disabled={item.hasInitialSnapshot === false}
                  title={item.hasInitialSnapshot === false ? t("stories.menu.exportInitialMissing") : ""}
                >
                  {t("stories.menu.exportInitial")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="story-card-menu-item"
                  onClick={(e) => { e.stopPropagation(); onExport?.("starter") }}
                  title={t("stories.menu.exportStarterHint", { defaultValue: "Clean snapshot for bundling as a starter (strips logs, agent threads, caches)." })}
                >
                  {t("stories.menu.exportStarter", { defaultValue: "Export as sample (clean)…" })}
                </button>
              </li>
              <li className="story-card-menu-divider" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className={`story-card-menu-delete${deleteArmed ? " is-armed" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onDelete() }}
                  disabled={item.active}
                  title={item.active ? "Switch to another story before deleting this one" : ""}
                >
                  {deleteArmed
                    ? t("stories.menu.confirmDelete")
                    : item.active
                      ? t("stories.menu.deleteActive")
                      : t("stories.menu.delete")}
                </button>
              </li>
            </ul>,
            document.body,
          )}
        </div>
      )}
    </li>
  )
}
