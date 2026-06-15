import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PreferenceForm, parseUserMemoryIntoForm, buildPreferenceMarkdown } from "../lib/PreferenceForm.jsx"

// New-story screen: name the story, then optionally customize this story's
// reading preferences (which override the global defaults for THIS story only).
// The global player preferences are the DEFAULT; "为本故事定制" pre-fills the
// editor with those defaults so a tweak captures the whole set. "沿用默认偏好"
// writes no per-story file → the story tracks the global prefs.
export function StoryNaming({ state, actions }) {
  const { t, i18n } = useTranslation()
  const inputRef = useRef(null)
  // IME state: a CJK input method composes a candidate string ("preedit")
  // inside the input element before committing. Track composition with a ref
  // so renders never fight the IME, and guard both handlers.
  const composingRef = useRef(false)

  // Preference editor state.
  const [mode, setMode] = useState("default") // "default" | "custom"
  const [groups, setGroups] = useState([])
  const [initialForm, setInitialForm] = useState(null) // parsed global defaults
  const [formValue, setFormValue] = useState(null)
  const [prefsReady, setPrefsReady] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Load the global defaults once so the customize editor can pre-fill from them.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.openovel.getUserMemory().catch(() => ({ content: "" })),
      window.openovel.getPreferenceTagGroups(i18n.language || "en").catch(() => ({ groups: [] })),
    ]).then(([mem, tg]) => {
      if (cancelled) return
      const gs = tg?.groups || []
      setGroups(gs)
      setInitialForm(parseUserMemoryIntoForm(mem?.content || "", gs))
      setPrefsReady(true)
    })
    return () => { cancelled = true }
  }, [i18n.language])

  const sync = useCallback(() => {
    if (!inputRef.current) return
    actions.setInput(inputRef.current.value)
  }, [actions])

  const onInput = useCallback(() => {
    if (composingRef.current) return
    sync()
  }, [sync])

  const create = useCallback(() => {
    sync()
    let preferences = null
    if (mode === "custom" && groups.length && formValue) {
      preferences = buildPreferenceMarkdown(formValue, groups) || null
    }
    actions.confirmStoryName({ preferences })
  }, [mode, groups, formValue, actions, sync])

  const onKeyDown = useCallback(
    (e) => {
      if (composingRef.current || e.isComposing || e.keyCode === 229) return
      if (e.key === "Enter") {
        e.preventDefault()
        create()
      } else if (e.key === "Escape") {
        e.preventDefault()
        actions.cancelStoryNaming()
      }
    },
    [actions, create],
  )

  return (
    <div className="story-naming">
      <div className="pane-header">
        {t("storyNaming.title", { defaultValue: "Name your new story" })}
      </div>
      <div className="story-naming-hint">
        {t("storyNaming.hint", {
          defaultValue: "Anything goes — letters, digits, spaces, emoji.",
        })}
      </div>
      <input
        ref={inputRef}
        className="story-naming-input"
        type="text"
        defaultValue={state.input || ""}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false; sync() }}
        placeholder={t("storyNaming.placeholder", { defaultValue: "my-story" })}
        autoFocus
      />
      {state.storyNaming?.error && (
        <div className="story-naming-error">{state.storyNaming.error}</div>
      )}

      <div className="story-naming-prefs">
        <div className="story-naming-prefs-label">
          {t("storyNaming.prefsLabel", { defaultValue: "Story preferences" })}
        </div>
        <div className="story-naming-mode">
          <button
            type="button"
            className={`pref-form-pill${mode === "default" ? " is-selected" : ""}`}
            onClick={() => setMode("default")}
          >
            <span className="pref-form-pill-label">
              {t("storyNaming.useDefaults", { defaultValue: "Use my defaults" })}
            </span>
            <span className="pref-form-pill-hint">
              {t("storyNaming.useDefaultsHint", { defaultValue: "track global preferences" })}
            </span>
          </button>
          <button
            type="button"
            className={`pref-form-pill${mode === "custom" ? " is-selected" : ""}`}
            onClick={() => setMode("custom")}
          >
            <span className="pref-form-pill-label">
              {t("storyNaming.customize", { defaultValue: "Customize for this story" })}
            </span>
            <span className="pref-form-pill-hint">
              {t("storyNaming.customizeHint", { defaultValue: "override just for this book" })}
            </span>
          </button>
        </div>

        {mode === "custom" && (
          <div className="story-naming-prefs-form">
            {prefsReady && groups.length ? (
              <PreferenceForm initial={initialForm || {}} groups={groups} onChange={setFormValue} />
            ) : (
              <div className="settings-loading">
                {t("settings.behavior.loading", { defaultValue: "loading…" })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="story-naming-actions">
        <button type="button" className="story-naming-create" onClick={create}>
          {t("storyNaming.create", { defaultValue: "Create story" })}
        </button>
      </div>
    </div>
  )
}
