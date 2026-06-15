import React from "react"
import { useTranslation } from "react-i18next"

// The header is the strap at the top of a Kindle page: chapter title
// left-aligned in 10pt grey caps, two small icon buttons right-aligned.
// During reading the chrome should all but disappear.
export function Header({ state, sidebarOpen, sidebarAvailable, onToggleSidebar, onOpenSettings, errorCount, onOpenErrors, onGoHome, hud = null, nowPlaying = null }) {
  const { t } = useTranslation()
  // On the library / splash page there's no current story — goToLibrary()
  // sets currentStory=null. Suppress the label entirely instead of falling
  // back to a "—" dash that reads like a real (badly named) story.
  const label = !state.currentStory
    ? ""
    : state.currentStory.isProjectLocal
      ? "project ./story"
      : (state.currentStory.displayName || state.currentStory.id || "")
  return (
    <header className="header">
      <span className="header-left">
        {label && <span className="header-story">{label}</span>}
      </span>
      {/* Compact status strip: now-playing music + the HUD live here, in the
          header's center, so they don't push the reading column down. Kept terse
          by the HUD-authoring prompt (it has limited width). */}
      <span className="header-center">
        {nowPlaying}
        {hud}
      </span>
      <span className="header-right">
        {errorCount > 0 && (
          <button
            className="header-error-badge"
            onClick={onOpenErrors}
            title={t("header.errorsBadge", { count: errorCount })}
            aria-label={t("header.errorsBadge", { count: errorCount })}
          >
            <span className="header-error-badge-mark" aria-hidden="true">!</span>
            {errorCount > 1 && <span className="header-error-badge-count">{errorCount}</span>}
          </button>
        )}
        {onGoHome && (
          <button
            className="header-icon"
            onClick={onGoHome}
            title={t("header.home")}
            aria-label={t("header.home")}
          >
            {/* Lucide-style "home" outline. */}
            <svg
              width="17" height="17" viewBox="0 0 24 24"
              fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
        )}
        {sidebarAvailable && (
          <button
            className={`header-icon${sidebarOpen ? " is-active" : ""}`}
            onClick={onToggleSidebar}
            title={t("header.sidebar")}
            aria-label={t("header.sidebar")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {onOpenSettings && (
          <button
            className="header-icon"
            onClick={onOpenSettings}
            title={t("header.settings")}
            aria-label={t("header.settings")}
          >
            {/* Lucide's "settings" gear — proper lobed gear with 8 teeth.
                The previous icon was a circle + radial lines, which reads
                as a sun, not a settings affordance. */}
            <svg
              width="17" height="17" viewBox="0 0 24 24"
              fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
      </span>
    </header>
  )
}
