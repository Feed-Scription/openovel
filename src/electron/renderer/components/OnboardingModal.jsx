import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import i18n, { normalizeUiLocale } from "../lib/i18n.js"
import { ApiKeysTab } from "./SettingsModal.jsx"
import { useDraggable } from "../lib/useDraggable.js"

// First-run setup modal. Multi-step overlay shown on top of an otherwise-
// empty splash. Step 1 is always "configure your LLM" — the runtime is
// useless without it, so the modal opens RIGHT THERE instead of making
// users hunt for the gear icon and find Settings. Subsequent steps are
// preference questions; the underlying VM state still drives them, but
// the GUI renders per-question custom widgets (button pills, textarea)
// instead of plain numbered-list-and-/skip text prompts.
export function OnboardingModal({ state, actions }) {
  const ob = state.onboarding
  const { t } = useTranslation()
  const drag = useDraggable()

  // Sync the UI locale to whatever the user picked for "default story
  // language". When they choose 简体中文 in step 2, every label in this
  // modal (and downstream UI) switches to zh immediately. Persists into
  // electron-prefs via the parent so the choice survives across runs.
  useEffect(() => {
    if (!ob?.locale) return
    const code = normalizeUiLocale(ob.locale) || normalizeUiLocale(ob.answers?.find((a) => a.id === "language")?.answer)
    if (code && i18n.language !== code) {
      i18n.changeLanguage(code)
      window.openovel.setPrefs({ locale: code }).catch(() => {})
    }
  }, [ob?.locale, ob?.answers])

  if (!ob) return null

  // Total displayed steps = the question list + 1 inserted api-key step.
  // Onboarding now asks only language, so the flow is two steps:
  //   Layout: [language] [api-key]
  //           step 1      step 2 (final)
  const totalSteps = 1 + (ob.questions?.length || 0)
  const currentStep =
    ob.phase === "language" ? 1
    : ob.phase === "api-key" ? 2
    : 2 + (ob.step || 0)              // (no extra question steps in the current flow)
  const isLastQuestion = ob.phase === "questions" && (ob.step || 0) === (ob.questions?.length || 0) - 1
  // The api-key step is the last step whenever there are no question steps
  // beyond language (questions = [language] → length 1).
  const apiKeyIsFinal = (ob.questions?.length || 0) <= 1

  return (
    <div className="modal-backdrop onboarding-modal-backdrop">
      <div className="modal onboarding-modal" style={drag.style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header onboarding-modal-header" onPointerDown={drag.onHandleDown}>
          <div>
            <div className="onboarding-modal-title">{t("onboarding.title")}</div>
            <div className="onboarding-modal-subtitle">{phaseSubtitle(ob, t)}</div>
          </div>
          <div className="onboarding-modal-progress">
            {t("onboarding.step", { current: currentStep, total: totalSteps })}
          </div>
        </div>
        <div className="onboarding-modal-body">
          {ob.phase === "api-key"
            ? <ApiKeyStep />
            : ob.phase === "language"
              ? <LanguagePicker ob={ob} state={state} actions={actions} />
              : <QuestionStep ob={ob} state={state} actions={actions} />}
        </div>
        <div className="onboarding-modal-footer">
          <button
            type="button"
            className="onboarding-skip-button"
            onClick={() => actions.skipOnboarding()}
          >
            {t("onboarding.skip")}
          </button>
          <div className="onboarding-modal-footer-right">
            {ob.phase !== "language" && (
              <button
                type="button"
                className="onboarding-back-button"
                onClick={() => actions.goBackInOnboarding()}
              >
                {t("onboarding.back")}
              </button>
            )}
            {ob.phase === "api-key" ? (
              <button
                type="button"
                className="onboarding-next-button"
                onClick={() => actions.advanceOnboardingFromApiKey()}
              >
                {apiKeyIsFinal ? t("onboarding.finish") : t("onboarding.continue")}
              </button>
            ) : (
              <NextQuestionButton ob={ob} state={state} actions={actions} isLast={isLastQuestion} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function phaseSubtitle(ob, t) {
  if (ob.phase === "language") return t("onboarding.subtitle.language")
  if (ob.phase === "api-key")  return t("onboarding.subtitle.apiKey")
  const q = ob.currentQuestion
  switch (q?.id) {
    case "language":          return t("onboarding.subtitle.language")
    case "style_sample":      return t("onboarding.subtitle.styleSample")
    case "style_comparison":  return t("onboarding.subtitle.styleTags")
    default:                  return ""
  }
}

// ── Step 1: API key ────────────────────────────────────────────────────
function ApiKeyStep() {
  const { t } = useTranslation()
  return (
    <div className="onboarding-step">
      <p className="onboarding-step-lead">{t("onboarding.apiKeyLead")}</p>
      <div className="onboarding-apikey-shell">
        <ApiKeysTab compact />
      </div>
    </div>
  )
}

// ── Steps 2..N: questions ──────────────────────────────────────────────
function QuestionStep({ ob, state, actions }) {
  const q = ob.currentQuestion
  if (!q) return null
  if (q.kind === "tags") return <TagPickerStep ob={ob} state={state} actions={actions} />
  switch (q.id) {
    case "language":          return <LanguagePicker ob={ob} state={state} actions={actions} />
    case "style_sample":      return <StyleSampleEntry ob={ob} state={state} actions={actions} />
    default:                  return <FreeformAnswer ob={ob} state={state} actions={actions} />
  }
}

function LanguagePicker({ ob, state, actions }) {
  const { t } = useTranslation()
  const fallback = ob.currentQuestion?.fallback || "English"
  const [selected, setSelected] = useState(() => fallback === "English" ? "English" : fallback)
  const [other, setOther] = useState("")

  useEffect(() => {
    const value = selected === "__OTHER__" ? other.trim() : selected
    actions.setInput(value)
  }, [selected, other, actions])

  const options = [
    { value: "English",            label: t("onboarding.languageOptions.english"),          hint: t("onboarding.languageOptions.englishHint") },
    { value: "Simplified Chinese", label: t("onboarding.languageOptions.simplifiedChinese"), hint: t("onboarding.languageOptions.simplifiedChineseHint") },
    { value: "__OTHER__",          label: t("onboarding.languageOptions.other"),            hint: t("onboarding.languageOptions.otherHint") },
  ]

  return (
    <div className="onboarding-step">
      <div className="onboarding-options">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`onboarding-option-pill${selected === opt.value ? " is-selected" : ""}`}
            onClick={() => setSelected(opt.value)}
          >
            <span className="onboarding-option-label">{opt.label}</span>
            <span className="onboarding-option-hint">{opt.hint}</span>
          </button>
        ))}
      </div>
      {selected === "__OTHER__" && (
        <ImeSafeInput
          value={other}
          onChange={setOther}
          placeholder={t("onboarding.languageOptions.otherPlaceholder")}
        />
      )}
    </div>
  )
}

function StyleSampleEntry({ ob, state, actions }) {
  const { t } = useTranslation()
  const [text, setText] = useState("")
  useEffect(() => { actions.setInput(text) }, [text, actions])

  return (
    <div className="onboarding-step">
      <textarea
        className="onboarding-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("onboarding.stylePlaceholder")}
        rows={5}
      />
    </div>
  )
}

// Multi-select tag picker — replaces the deprecated A/B style comparison.
// Stable per-user preferences only (pacing/tone/POV/focus/avoid); per-story
// genre choices belong with the per-story setup, not here. Selections from
// each group join into a single memory line that the narrator reads from
// USER.md.
function TagPickerStep({ ob, state, actions }) {
  const groups = ob.currentQuestion?.tagGroups || []
  const [selections, setSelections] = useState(() => {
    const init = {}
    for (const g of groups) init[g.id] = new Set()
    return init
  })

  // Single-line, structured output. memoryStore's index line is one
  // bullet (newlines get collapsed) so we keep it on one line and use
  // Encode one group per line so the downstream memory writer can split
  // them into per-group bullets in USER.md (one giant comma-joined line
  // was not valid-looking markdown). Each line:
  //
  //   Pacing: Brisk — Quick beats; Cinematic — Scene-cut feel
  //   Tone: Ironic — Surface meaning diverges from intent
  //
  // `preferenceAnswersToMemoryEntries` splits on `\n` for style_comparison.
  useEffect(() => {
    const groupParts = []
    for (const g of groups) {
      const picks = [...(selections[g.id] || [])]
      if (!picks.length) continue
      const items = picks.map((v) => {
        const opt = g.options.find((o) => o.value === v)
        const label = opt?.label || v
        const desc = opt?.description ? ` — ${opt.description}` : ""
        return `${label}${desc}`
      })
      groupParts.push(`${g.label}: ${items.join("; ")}`)
    }
    actions.setInput(groupParts.join("\n"))
  }, [selections, groups, actions])

  const toggle = (groupId, value) => {
    const group = groups.find((g) => g.id === groupId)
    const option = group?.options.find((o) => o.value === value)
    setSelections((prev) => {
      const next = { ...prev }
      const set = new Set(next[groupId] || [])
      if (option?.isDefault) {
        // "Default" = let the model decide → store NOTHING for this group.
        // An empty selection IS that state, so clicking Default just clears it.
        set.clear()
      } else if (set.has(value)) {
        set.delete(value)
      } else if (group?.singleSelect || option?.exclusive) {
        // Radio group, or an exclusive sentinel: clears the rest.
        set.clear()
        set.add(value)
      } else {
        // A normal pick drops any exclusive sentinel in the group.
        for (const o of group?.options || []) {
          if (o.exclusive) set.delete(o.value)
        }
        set.add(value)
      }
      next[groupId] = set
      return next
    })
  }

  return (
    <div className="onboarding-step">
      <div className="tag-picker">
        {groups.map((g) => (
          <div key={g.id} className="tag-picker-group">
            <div className="tag-picker-group-label">{g.label}</div>
            <div className="tag-picker-options">
              {g.options.map((opt) => {
                // Default sentinel lights when the group has no real selection
                // (it is never stored); real options light when picked.
                const active = opt.isDefault
                  ? !(selections[g.id]?.size)
                  : selections[g.id]?.has(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`tag-pill${active ? " is-active" : ""}${opt.isDefault ? " tag-pill-default" : ""}`}
                    onClick={() => toggle(g.id, opt.value)}
                    data-description={opt.description || undefined}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FreeformAnswer({ ob, state, actions }) {
  const [text, setText] = useState("")
  useEffect(() => { actions.setInput(text) }, [text, actions])
  return (
    <div className="onboarding-step">
      <p className="onboarding-step-lead">{ob.currentQuestion?.prompt}</p>
      <ImeSafeInput value={text} onChange={setText} placeholder="" />
      {ob.currentQuestion?.fallback && (
        <div className="onboarding-default-hint">
          <em>{ob.currentQuestion.fallback}</em>
        </div>
      )}
    </div>
  )
}

// IME-safe controlled input.
function ImeSafeInput({ value, onChange, placeholder }) {
  const inputRef = useRef(null)
  const composingRef = useRef(false)
  return (
    <input
      ref={inputRef}
      type="text"
      className="onboarding-text-input"
      defaultValue={value}
      placeholder={placeholder}
      onInput={(e) => { if (!composingRef.current) onChange(e.target.value) }}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={(e) => { composingRef.current = false; onChange(e.target.value) }}
    />
  )
}

function NextQuestionButton({ ob, state, actions, isLast }) {
  const { t } = useTranslation()
  const onClick = useCallback(() => actions.submit(), [actions])
  return (
    <button
      type="button"
      className="onboarding-next-button"
      onClick={onClick}
    >
      {isLast ? t("onboarding.finish") : t("onboarding.continue")}
    </button>
  )
}
