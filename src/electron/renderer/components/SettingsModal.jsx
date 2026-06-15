import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import i18n, { SUPPORTED_LOCALES, normalizeUiLocale } from "../lib/i18n.js"
import sliderPreviewZh from "../lib/sliderPreview.zh.txt"
import sliderPreviewEn from "../lib/sliderPreview.en.txt"
import { nextRevealUnit, revealUnitDelayMs, punctuationDelayMs } from "../../../lib/revealPacing.js"
import { CodeView } from "../lib/CodeView.jsx"
import { PreferenceForm, parseUserMemoryIntoForm, rebuildMarkdownFromForm } from "../lib/PreferenceForm.jsx"
import { parseTicPatterns } from "../../../lib/ticPatterns.js"
import { HalftoneBand } from "./HalftoneCover.jsx"
import { colorThemeVars } from "../lib/colorThemes.js"
import { useDraggable } from "../lib/useDraggable.js"

// Top-level settings follow user intent, not implementation modules.
// AI owns providers + routing + agents; Story owns narration behavior + memory;
// Presentation owns visible/audible output; System owns diagnostics + env.
const TABS = [
  { id: "ai",           labelKey: "settings.tabs.ai" },
  { id: "story",        labelKey: "settings.tabs.story" },
  { id: "presentation", labelKey: "settings.tabs.presentation" },
  { id: "system",       labelKey: "settings.tabs.system" },
]

const SIMPLE_TABS = TABS.filter((tab) => ["ai", "story", "presentation"].includes(tab.id))
const SETTINGS_MODES = ["simple", "advanced"]

function normalizeSettingsMode(mode) {
  return SETTINGS_MODES.includes(mode) ? mode : "simple"
}

function tabsForSettingsMode(mode) {
  return normalizeSettingsMode(mode) === "advanced" ? TABS : SIMPLE_TABS
}

function musicTestMessage(t, r) {
  if (!r?.authorized) return t("settings.music.signInToPlay", { defaultValue: "Connected. Sign in to play music." })
  if (r.playable === false) return t("settings.music.needMembership", { defaultValue: "Connected, but this song wouldn't play — your account may need a membership." })
  if (r.playable === true) return t("settings.music.ready", { defaultValue: "Connected — music is ready to play." })
  return t("settings.music.connected", { defaultValue: "Connected." })
}

export function SettingsModal({ prefs, onChange, onPreviewColorTheme, onClose }) {
  const { t } = useTranslation()
  const drag = useDraggable()
  const [activeTab, setActiveTab] = useState("ai")
  const contentRef = useRef(null)
  const settingsMode = normalizeSettingsMode(prefs?.settingsMode)
  const visibleTabs = tabsForSettingsMode(settingsMode)
  const currentTab = visibleTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id || "ai"
  const setSettingsMode = useCallback((mode) => {
    onChange({ ...prefs, settingsMode: normalizeSettingsMode(mode) })
  }, [prefs, onChange])

  // Esc to close (modal pattern parity with FilePreview)
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0 })
  }, [currentTab])

  useEffect(() => {
    if (currentTab !== activeTab) setActiveTab(currentTab)
  }, [activeTab, currentTab])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" style={drag.style} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" onPointerDown={drag.onHandleDown}>
          <span>{t("settings.title")}</span>
          <SettingsModeControl value={settingsMode} onChange={setSettingsMode} compact />
          <button className="modal-close" onClick={onClose} aria-label={t("common.cancel")}>×</button>
        </div>
        <div className="settings-shell">
          <nav className="settings-tabs" aria-label="Settings sections">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab${currentTab === tab.id ? " is-active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
            {/* Halftone foot in the nav's empty lower area — the dot-art motif,
                here fading along the up-right 45° diagonal (corner-weighted)
                rather than the page foot's vertical fade. */}
            <HalftoneBand seed="settings::foot" className="halftone-foot halftone-foot-corner" tilt={22} freqBoost={4} />
          </nav>
          <div className="settings-tab-content" ref={contentRef}>
            {currentTab === "ai"           && <AiSettingsTab mode={settingsMode} />}
            {currentTab === "story"        && <StorySettingsTab mode={settingsMode} />}
            {currentTab === "presentation" && <PresentationSettingsTab mode={settingsMode} prefs={prefs} onChange={onChange} onPreviewColorTheme={onPreviewColorTheme} />}
            {currentTab === "system"       && <SystemSettingsTab mode={settingsMode} onModeChange={setSettingsMode} />}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-button" onClick={onClose}>{t("settings.done")}</button>
        </div>
      </div>
    </div>
  )
}

function SettingsModeControl({ value, onChange, compact = false }) {
  const { t } = useTranslation()
  return (
    <div className={`settings-mode-control${compact ? " is-compact" : ""}`} role="group" aria-label={t("settings.mode.label")}>
      {SETTINGS_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`settings-mode-option${value === mode ? " is-active" : ""}`}
          onClick={() => onChange(mode)}
        >
          {t(`settings.mode.${mode}`)}
        </button>
      ))}
    </div>
  )
}

function SettingsModePreference({ mode, onModeChange }) {
  const { t } = useTranslation()
  return (
    <div className="settings-mode-preference">
      <div>
        <div className="setting-label">{t("settings.mode.preferenceTitle")}</div>
        <div className="settings-section-intro">{t("settings.mode.preferenceDescription")}</div>
      </div>
      <SettingsModeControl value={mode} onChange={onModeChange} />
    </div>
  )
}

function SettingsCompositePage({ kicker, title, description, subtabs = [], activeSubtab, onSubtabChange, children }) {
  return (
    <div className="settings-composite-page">
      <div className="settings-page-head">
        <div>
          <div className="settings-page-kicker">{kicker}</div>
          <h2 className="settings-page-title">{title}</h2>
          <p className="settings-page-copy">{description}</p>
        </div>
      </div>
      {subtabs.length > 1 && (() => {
        // When subtabs carry a `group`, cluster them: the group name sits as a
        // small caption ABOVE its own tabs and clusters are separated by a
        // hairline, so different KINDS of setting (services / routing / agents)
        // don't read as one flat row. Pages without groups render the flat row.
        const clusters = []
        for (const subtab of subtabs) {
          const last = clusters[clusters.length - 1]
          if (last && last.group === (subtab.group || null)) last.items.push(subtab)
          else clusters.push({ group: subtab.group || null, items: [subtab] })
        }
        const grouped = clusters.some((c) => c.group)
        const renderTab = (subtab) => (
          <button
            key={subtab.id}
            type="button"
            className={`settings-subtab${activeSubtab === subtab.id ? " is-active" : ""}`}
            onClick={() => onSubtabChange(subtab.id)}
          >
            <span>{subtab.label}</span>
            {subtab.description && <small>{subtab.description}</small>}
          </button>
        )
        return (
          <nav className={`settings-subtabs${grouped ? " is-grouped" : ""}`} aria-label={title}>
            {grouped
              ? clusters.map((cluster, i) => (
                  <div key={cluster.group || i} className="settings-subtab-cluster">
                    <span className="settings-subtab-group" aria-hidden="true">{cluster.group || " "}</span>
                    <div className="settings-subtab-cluster-row">{cluster.items.map(renderTab)}</div>
                  </div>
                ))
              : subtabs.map(renderTab)}
          </nav>
        )
      })()}
      <div className="settings-pane-region">{children}</div>
    </div>
  )
}

function SettingsPane({ title, description, children }) {
  return (
    <section className="settings-pane">
      {(title || description) && (
        <header className="settings-pane-head">
          {title && <h3>{title}</h3>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="settings-pane-body">{children}</div>
    </section>
  )
}

function AiSettingsTab({ mode }) {
  const { t } = useTranslation()
  const isAdvanced = mode === "advanced"
  // Which agent runtime is active decides which agent tabs are relevant:
  // team mode (Story team ON, the default) configures agents via the single
  // "Resident Agents" tab, and the per-call Maintenance routing + Subagent
  // classes are single-Storykeeper concepts; team OFF is the reverse. So show
  // only the set that applies and hide the other to cut dead controls.
  // residentTeam defaults ON, so assume ON until the behavior snapshot loads.
  const [residentTeamOn, setResidentTeamOn] = useState(true)
  useEffect(() => {
    let cancelled = false
    window.openovel.getBehavior()
      .then((snap) => {
        if (cancelled) return
        const tgl = (snap?.toggles || []).find((x) => x.id === "residentTeam")
        if (tgl && typeof tgl.value === "boolean") setResidentTeamOn(tgl.value)
      })
      .catch(() => { /* keep the ON default */ })
    return () => { cancelled = true }
  }, [])
  // Three distinct kinds of setting share this row: per-capability service
  // config, model-call routing, and agent config. Group labels keep them from
  // reading as one undifferentiated list.
  const gServices = t("settings.subtabs.ai.groups.services")
  const gRouting = t("settings.subtabs.ai.groups.routing")
  const gAgents = t("settings.subtabs.ai.groups.agents")
  const subtabs = isAdvanced
    ? [
        { id: "models",         label: t("settings.subtabs.ai.models"),         group: gServices },
        { id: "search",         label: t("settings.subtabs.ai.search"),         group: gServices },
        { id: "image",          label: t("settings.subtabs.ai.image"),          group: gServices },
        { id: "speech",         label: t("settings.subtabs.ai.speech"),         group: gServices },
        // The model catalog + default tiers are routing concerns (they render
        // RoutingTab), not API/provider config — they live in the Routing group.
        { id: "catalog",        label: t("settings.subtabs.ai.catalog"),        group: gRouting },
        { id: "narrative",      label: t("settings.subtabs.ai.narrative"),      group: gRouting },
        // Maintenance routing + Subagent classes only when the single-Storykeeper
        // runs (team OFF); Resident Agents only when the team runs (team ON).
        ...(residentTeamOn ? [] : [{ id: "maintenance", label: t("settings.subtabs.ai.maintenance"), group: gRouting }]),
        ...(residentTeamOn ? [] : [{ id: "subagents", label: t("settings.subtabs.ai.subagents"), group: gAgents }]),
        ...(residentTeamOn ? [{ id: "residentAgents", label: t("settings.subtabs.ai.residentAgents"), group: gAgents }] : []),
      ]
    : []
  const [subtab, setSubtab] = useState("models")
  useEffect(() => {
    if (!isAdvanced) setSubtab("models")
    else if (!subtabs.some((item) => item.id === subtab)) setSubtab("models")
  }, [isAdvanced, subtab, subtabs])

  return (
    <SettingsCompositePage
      kicker={t("settings.pages.ai.kicker")}
      title={t("settings.pages.ai.title")}
      description={t("settings.pages.ai.description")}
      subtabs={subtabs}
      activeSubtab={subtab}
      onSubtabChange={setSubtab}
    >
      {subtab === "models" && (
        <SettingsPane
          title={t("settings.chapters.llm.title")}
          description={t("settings.chapters.llm.description")}
        >
          <ApiKeysTab section="llm" mode={mode} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "catalog" && (
        <SettingsPane
          title={t("settings.chapters.modelCatalog.title")}
          description={t("settings.chapters.modelCatalog.description")}
        >
          <RoutingTab embedded groupKeys={["base"]} showOverview={false} showCatalog />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "search" && (
        <SettingsPane
          title={t("settings.chapters.search.title")}
          description={t("settings.chapters.search.description")}
        >
          <ApiKeysTab section="search" mode={mode} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "image" && (
        <SettingsPane
          title={t("settings.chapters.image.title")}
          description={t("settings.chapters.image.description")}
        >
          <ImageTab />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "speech" && (
        <SettingsPane
          title={t("settings.chapters.tts.title")}
          description={t("settings.chapters.tts.description")}
        >
          <TtsTab />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "narrative" && (
        <SettingsPane
          title={t("settings.chapters.narrativeCalls.title")}
          description={t("settings.chapters.narrativeCalls.description")}
        >
          <RoutingTab embedded groupKeys={["narrative"]} showOverview={false} showCatalog={false} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "maintenance" && (
        <SettingsPane
          title={t("settings.chapters.maintenanceCalls.title")}
          description={t("settings.chapters.maintenanceCalls.description")}
        >
          <RoutingTab embedded groupKeys={["maintenance"]} showOverview={false} showCatalog={false} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "subagents" && (
        <SettingsPane
          title={t("settings.chapters.subagentClasses.title")}
          description={t("settings.chapters.subagentClasses.description")}
        >
          <RoutingTab embedded groupKeys={["subagents"]} showOverview={false} showCatalog={false} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "residentAgents" && (
        <SettingsPane
          title={t("settings.chapters.residentAgents.title")}
          description={t("settings.chapters.residentAgents.description")}
        >
          <AgentsTab embedded />
        </SettingsPane>
      )}
    </SettingsCompositePage>
  )
}

function StorySettingsTab({ mode }) {
  const { t } = useTranslation()
  const isAdvanced = mode === "advanced"
  const subtabs = isAdvanced
    ? [
        { id: "memory",   label: t("settings.subtabs.story.memory") },
        { id: "behavior", label: t("settings.subtabs.story.behavior") },
      ]
    : []
  const [subtab, setSubtab] = useState("memory")
  useEffect(() => {
    if (!isAdvanced) setSubtab("memory")
    else if (!subtabs.some((item) => item.id === subtab)) setSubtab("memory")
  }, [isAdvanced, subtab, subtabs])

  return (
    <SettingsCompositePage
      kicker={t("settings.pages.story.kicker")}
      title={t("settings.pages.story.title")}
      description={t("settings.pages.story.description")}
      subtabs={subtabs}
      activeSubtab={subtab}
      onSubtabChange={setSubtab}
    >
      {subtab === "memory" && (
        <SettingsPane
          title={t("settings.chapters.memory.title")}
          description={t("settings.chapters.memory.description")}
        >
          <MemoryTab advanced={isAdvanced} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "behavior" && (
        <SettingsPane
          title={t("settings.chapters.behavior.title")}
          description={t("settings.chapters.behavior.description")}
        >
          <BehaviorTab />
        </SettingsPane>
      )}
    </SettingsCompositePage>
  )
}

function PresentationSettingsTab({ mode, prefs, onChange, onPreviewColorTheme }) {
  const { t } = useTranslation()
  const isAdvanced = mode === "advanced"
  const subtabs = isAdvanced
    ? [
        { id: "display",    label: t("settings.subtabs.presentation.display") },
        { id: "storyMedia", label: t("settings.subtabs.presentation.storyMedia") },
      ]
    : []
  const [subtab, setSubtab] = useState("display")
  useEffect(() => {
    if (!isAdvanced) setSubtab("display")
    else if (!subtabs.some((item) => item.id === subtab)) setSubtab("display")
  }, [isAdvanced, subtab, subtabs])

  return (
    <SettingsCompositePage
      kicker={t("settings.pages.presentation.kicker")}
      title={t("settings.pages.presentation.title")}
      description={t("settings.pages.presentation.description")}
      subtabs={subtabs}
      activeSubtab={subtab}
      onSubtabChange={setSubtab}
    >
      {subtab === "display" && (
        <SettingsPane
          title={t("settings.chapters.display.title")}
          description={t("settings.chapters.display.description")}
        >
          <DisplayTab prefs={prefs} onChange={onChange} onPreviewColorTheme={onPreviewColorTheme} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "storyMedia" && (
        <SettingsPane
          title={t("settings.chapters.storyMedia.title")}
          description={t("settings.chapters.storyMedia.description")}
        >
          <BehaviorTogglesPanel groups={PRESENTATION_BEHAVIOR_GROUPS} />
        </SettingsPane>
      )}
    </SettingsCompositePage>
  )
}

function SystemSettingsTab({ mode, onModeChange }) {
  const { t } = useTranslation()
  const isAdvanced = mode === "advanced"
  const subtabs = isAdvanced
    ? [
        { id: "preferences", label: t("settings.subtabs.system.preferences") },
        { id: "status",      label: t("settings.subtabs.system.status") },
        { id: "environment", label: t("settings.subtabs.system.environment") },
      ]
    : []
  const [subtab, setSubtab] = useState("preferences")
  useEffect(() => {
    if (!isAdvanced) setSubtab("preferences")
    else if (!subtabs.some((item) => item.id === subtab)) setSubtab("preferences")
  }, [isAdvanced, subtab, subtabs])

  return (
    <SettingsCompositePage
      kicker={t("settings.pages.system.kicker")}
      title={t(isAdvanced ? "settings.pages.system.title" : "settings.pages.system.simpleTitle")}
      description={t(isAdvanced ? "settings.pages.system.description" : "settings.pages.system.simpleDescription")}
      subtabs={subtabs}
      activeSubtab={subtab}
      onSubtabChange={setSubtab}
    >
      {subtab === "preferences" && (
        <SettingsPane
          title={t("settings.chapters.preferences.title")}
          description={t("settings.chapters.preferences.description")}
        >
          <SettingsModePreference mode={mode} onModeChange={onModeChange} />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "status" && (
        <SettingsPane
          title={t("settings.chapters.status.title")}
          description={t("settings.chapters.status.description")}
        >
          <StatusTab />
        </SettingsPane>
      )}
      {isAdvanced && subtab === "environment" && (
        <SettingsPane
          title={t("settings.chapters.environment.title")}
          description={t("settings.chapters.environment.description")}
        >
          <EnvironmentTab />
        </SettingsPane>
      )}
    </SettingsCompositePage>
  )
}

// ── Display tab (existing prefs) ─────────────────────────────────────────
const FONT_OPTIONS = [
  // `font` renders each label in the typeface it selects, so the picker doubles
  // as a live specimen (the var()s are the same families the reading column uses).
  { id: "serif", label: "Serif (Songti / 衬线)",      description: "best for long-form CJK prose", font: "var(--font-serif)" },
  { id: "sans",  label: "Sans-serif (PingFang / 无衬线)", description: "modern UI feel",             font: "var(--font-sans)" },
  { id: "mono",  label: "Monospace (JetBrains Mono)", description: "developer / coding feel",      font: "var(--font-mono)" },
]
// Ids must exist in renderer/lib/colorThemes.js; paper/dialogue colors are
// derived from the preset itself so this list can't drift out of sync.
const COLOR_THEME_OPTIONS = [
  { id: "default", label: "Neutral (中性灰)", description: "the original grey paper" },
  { id: "bianca",  label: "Bianca (米白)",   description: "warm cream paper" },
  { id: "sepia",   label: "Sepia (羊皮纸)",  description: "tan parchment, e-reader classic" },
  { id: "sage",    label: "Sage (豆沙绿)",   description: "a whisper of eye-rest green" },
  { id: "mist",    label: "Mist (雾蓝灰)",   description: "cool quiet grey" },
]
// Tiny "page of text" chip: the preset's paper color with ink text-lines, the
// middle line in the preset's dialogue-highlight color. A plain color square
// reads as an unchecked checkbox (and a paper-colored square is invisible
// when the active theme matches it) — the text lines make it legible as a
// page preview instead.
function SwatchPage({ themeId }) {
  const vars = colorThemeVars(themeId)
  const paper = vars["--paper"] || "#f4f4f4"
  const dialogue = vars["--voice-dialogue"] || "#3a516b"
  return (
    <svg className="setting-swatch" width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill={paper} stroke="var(--ink-ghost)" />
      <path d="M3.5 5h8M3.5 10h5" stroke="var(--ink-faint)" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M3.5 7.5h8" stroke={dialogue} strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
// Sample passages for the slider hover-preview, authored in two sibling text
// files (operator-editable; inlined by esbuild's .txt loader at bundle time,
// so edits show up on the next launch). zh file plays for a Chinese UI locale,
// the en file for everything else.
const SLIDER_PREVIEW_TEXT = {
  zh: sliderPreviewZh.trim(),
  en: sliderPreviewEn.trim(),
}

// Hover preview shared by the font-size and reveal-speed sliders: a rounded
// panel the slider's full width, floating above it, showing the sample passage
// at the LIVE font size. Two modes:
//   mode="static"     — font-size slider: render the whole passage at once,
//                       scrolled to the top, so it's a calm size sample (no
//                       motion to distract from judging glyph size).
//   mode="typewriter" — reveal-speed slider: replay the passage using the SAME
//                       pacing primitives as the real transcript revealer
//                       (../../../lib/revealPacing.js): per-unit cpm cadence
//                       plus the clause/sentence punctuation pauses, so the
//                       preview matches reading exactly. Kept scrolled to the
//                       newest line, looping after a short hold. cpm <= 0 (the
//                       "unlimited" stop) reveals at machine-fast frame speed.
function SliderPreview({ visible, mode, fontSize, cpm, locale }) {
  const text = String(locale || "").startsWith("zh") ? SLIDER_PREVIEW_TEXT.zh : SLIDER_PREVIEW_TEXT.en
  const typewriter = mode === "typewriter"
  const [count, setCount] = useState(0)
  const boxRef = useRef(null)
  useEffect(() => {
    if (!visible) { setCount(0); return undefined }
    if (!typewriter) { setCount(text.length); return undefined } // static: show all at once
    // Mirror the VM revealer's tick: advance one reveal unit at a time, delay =
    // unit delay (+ punctuation pause). cpm <= 0 → fast frame cadence, no pauses.
    const unlimited = cpm <= 0
    const pacing = { cpm: unlimited ? 2400 : cpm, frameMs: 33, punctuation: !unlimited }
    let i = 0
    let timer = null
    const tick = () => {
      if (i >= text.length) {
        // Hold the finished passage briefly, then loop from the start.
        timer = setTimeout(() => { i = 0; setCount(0); tick() }, 1200)
        return
      }
      const unit = nextRevealUnit(text, i)
      const next = Math.min(text.length, unit.end)
      i = next
      setCount(next)
      const lastChar = text[next - 1] || ""
      const base = unlimited ? pacing.frameMs : revealUnitDelayMs(unit.kind, text.slice(0, 0), pacing)
      const punct = pacing.punctuation ? punctuationDelayMs(lastChar) : 0
      timer = setTimeout(tick, base + punct)
    }
    timer = setTimeout(tick, pacing.frameMs)
    return () => clearTimeout(timer)
  }, [visible, text, cpm, typewriter])
  // Typewriter follows the newest text (like the transcript); static rests at
  // the top so the passage reads from its beginning.
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = typewriter ? el.scrollHeight : 0
  }, [count, typewriter])
  if (!visible || !text) return null
  return (
    <div className="setting-slider-preview" ref={boxRef} style={{ fontSize: `${fontSize}px` }} aria-hidden="true">
      {typewriter ? text.slice(0, count) : text}
    </div>
  )
}

// Sample passage for the highlight-toggle hover previews: a generic cast (the
// settings modal has no story context), one name in plain prose, one inside a
// quoted line, so both tints and their interaction are visible at a glance.
const HIGHLIGHT_SAMPLE = {
  zh: [
    { t: "沈砚", n: true }, { t: "把伞递过去，低声道：" },
    { t: "“雨要停了，", d: true }, { t: "林晚", d: true, n: true }, { t: "。”", d: true },
    { t: "林晚", n: true }, { t: "没有接，只是听着檐外的水声。" },
  ],
  en: [
    { t: "Elara", n: true }, { t: " pushed the door open. " },
    { t: "“We leave at dawn, ", d: true }, { t: "Bram", d: true, n: true }, { t: ".”", d: true },
    { t: " The fire had burned low." },
  ],
}

// Hover preview for the two highlight toggles: renders the sample AS IT WOULD
// LOOK AFTER flipping the hovered toggle (the other highlight keeps its current
// setting), so the reader sees the effect of the click before clicking.
function HighlightPreview({ visible, dialogueOn, namesOn, fontSize, locale }) {
  if (!visible) return null
  const parts = String(locale || "").startsWith("zh") ? HIGHLIGHT_SAMPLE.zh : HIGHLIGHT_SAMPLE.en
  return (
    <div className="setting-slider-preview setting-highlight-preview" style={{ fontSize: `${fontSize}px` }} aria-hidden="true">
      {parts.map((part, i) => {
        // Mirrors the reading view: one shared accent hue for names + dialogue;
        // names add bold (the weight is what distinguishes them).
        const named = part.n && namesOn
        const tinted = named || (part.d && dialogueOn)
        const style = tinted
          ? { color: "var(--voice-dialogue)", ...(named ? { fontWeight: 600 } : {}) }
          : undefined
        return <span key={i} style={style}>{part.t}</span>
      })}
    </div>
  )
}

function DisplayTab({ prefs, onChange, onPreviewColorTheme }) {
  const { t } = useTranslation()
  const [sliderPreview, setSliderPreview] = useState(null) // 'size' | 'speed' | 'dq' | 'np' | null
  const setColorTheme = useCallback((id) => onChange({ ...prefs, colorTheme: id }), [prefs, onChange])
  const setFont = useCallback((id) => onChange({ ...prefs, fontFamily: id }), [prefs, onChange])
  const setSize = useCallback((size) => onChange({ ...prefs, fontSize: size }), [prefs, onChange])
  const setSpeed = useCallback((cpm) => onChange({ ...prefs, narrationCpm: cpm }), [prefs, onChange])
  const setBg   = useCallback((on) => onChange({ ...prefs, backgroundArt: on }), [prefs, onChange])
  const setSceneBackdrop = useCallback((on) => onChange({ ...prefs, sceneBackdrop: on }), [prefs, onChange])
  const setCustomRichBlocks = useCallback((on) => onChange({ ...prefs, customRichBlocks: on }), [prefs, onChange])
  const setAutoScroll = useCallback((on) => onChange({ ...prefs, autoScroll: on }), [prefs, onChange])
  const setHighlightDialogue = useCallback((on) => onChange({ ...prefs, highlightDialogue: on }), [prefs, onChange])
  const setHighlightNames = useCallback((on) => onChange({ ...prefs, highlightNames: on }), [prefs, onChange])
  const setLayoutScale = useCallback((scale) => onChange({ ...prefs, layoutScale: scale }), [prefs, onChange])
  const setLocale = useCallback((code) => {
    onChange({ ...prefs, locale: code })
    if (i18n.language !== code) i18n.changeLanguage(code)
  }, [prefs, onChange])
  return (
    <div className="settings-section-group">
      <div className="settings-display-group">
        <div className="settings-section-label">{t("settings.display.groups.interface")}</div>
        <div className="setting-group">
          <div className="setting-label">{t("settings.display.language")}</div>
          {SUPPORTED_LOCALES.map((code) => (
            <label key={code} className="setting-radio">
              <input
                type="radio" name="uiLocale"
                checked={(prefs.locale || i18n.language || "en").startsWith(code)}
                onChange={() => setLocale(code)}
              />
              <span className="setting-radio-label">
                {code === "en" ? t("settings.display.langEn") : t("settings.display.langZh")}
              </span>
            </label>
          ))}
        </div>
        <div className="setting-group">
          <div className="setting-label">{t("settings.display.colorTheme", { defaultValue: "Color scheme" })}</div>
          {COLOR_THEME_OPTIONS.map((opt) => (
            <label
              key={opt.id}
              className="setting-radio"
              // Live whole-app preview while hovering; leave reverts to the saved
              // theme, selecting commits it (and clears the preview so the saved
              // value rules again).
              onMouseEnter={() => onPreviewColorTheme?.(opt.id)}
              onMouseLeave={() => onPreviewColorTheme?.(null)}
            >
              <input
                type="radio" name="colorTheme"
                checked={(prefs.colorTheme || "default") === opt.id}
                onChange={() => { setColorTheme(opt.id); onPreviewColorTheme?.(null) }}
              />
              <span className="setting-radio-label">
                <SwatchPage themeId={opt.id} />
                {opt.label}
                <span className="dim"> · {opt.description}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="setting-group">
          <div className="setting-label">{t("settings.display.fontFamily")}</div>
          {FONT_OPTIONS.map((opt) => (
            <label key={opt.id} className="setting-radio">
              <input
                type="radio" name="fontFamily"
                checked={prefs.fontFamily === opt.id}
                onChange={() => setFont(opt.id)}
              />
              <span className="setting-radio-label">
                <span style={{ fontFamily: opt.font }}>{opt.label}</span>
                <span className="dim"> · {opt.description}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="setting-group">
          <div
            className="setting-slider-wrap"
            onMouseEnter={() => setSliderPreview("size")}
            onMouseLeave={() => setSliderPreview((p) => (p === "size" ? null : p))}
          >
            <SliderPreview
              visible={sliderPreview === "size"}
              mode="static"
              fontSize={prefs.fontSize}
              cpm={prefs.narrationCpm ?? 720}
              locale={prefs.locale || i18n.language || "en"}
            />
            <div className="setting-label">{t("settings.display.fontSize", { size: prefs.fontSize })}</div>
            <input
              type="range" min="12" max="22" step="1"
              value={prefs.fontSize}
              onChange={(e) => setSize(Number(e.target.value))}
              className="setting-slider"
            />
          </div>
        </div>
        <div className="setting-group">
          {(() => {
            // Stored as a 1..1.5 factor; the slider works in percent. Takes
            // effect live (App pushes --layout-scale into the root style vars).
            const pct = Math.round((Number(prefs.layoutScale) || 1) * 100)
            return (
              <>
                <div className="setting-label">{t("settings.display.layoutScale", { pct, defaultValue: "Layout width: {{pct}}%" })}</div>
                <input
                  type="range" min="100" max="150" step="5"
                  value={pct}
                  onChange={(e) => setLayoutScale(Number(e.target.value) / 100)}
                  className="setting-slider"
                />
                <p className="setting-hint">{t("settings.display.layoutScaleHint", { defaultValue: "Proportionally widens the reading column and library covers — for large displays." })}</p>
              </>
            )
          })()}
        </div>
      </div>

      <div className="settings-display-group">
        <div className="settings-section-label">{t("settings.display.groups.readingFlow")}</div>
        <div className="setting-group">
          {(() => {
            // One step past max (1860) is the "unlimited" stop, stored as cpm 0.
            const cpm = prefs.narrationCpm ?? 720
            const unlimited = cpm <= 0
            return (
              <>
                <div
                  className="setting-slider-wrap"
                  onMouseEnter={() => setSliderPreview("speed")}
                  onMouseLeave={() => setSliderPreview((p) => (p === "speed" ? null : p))}
                >
                  <SliderPreview
                    visible={sliderPreview === "speed"}
                    mode="typewriter"
                    fontSize={prefs.fontSize}
                    cpm={cpm}
                    locale={prefs.locale || i18n.language || "en"}
                  />
                  <div className="setting-label">
                    {unlimited
                      ? t("settings.display.narrationSpeedUnlimited", { defaultValue: "Reveal speed: unlimited" })
                      : t("settings.display.narrationSpeed", { cpm })}
                  </div>
                  <input
                    type="range" min="240" max="1860" step="60"
                    value={unlimited ? 1860 : cpm}
                    onChange={(e) => { const v = Number(e.target.value); setSpeed(v > 1800 ? 0 : v) }}
                    className="setting-slider"
                  />
                </div>
                <p className="setting-hint">{t("settings.display.narrationSpeedHint", { defaultValue: "How fast the words appear as you read. Takes effect right away." })}</p>
              </>
            )
          })()}
        </div>
        <div className="setting-group">
          <label className="setting-checkbox">
            <input type="checkbox" checked={prefs.autoScroll === false} onChange={(e) => setAutoScroll(!e.target.checked)} />
            <span>{t("settings.display.autoScrollOff", { defaultValue: "Don't auto-scroll while the story streams" })}</span>
          </label>
        </div>
      </div>

      <div className="settings-display-group">
        <div className="settings-section-label">{t("settings.display.groups.textMarks")}</div>
        <div className="setting-group">
          <div
            className="setting-slider-wrap"
            onMouseEnter={() => setSliderPreview("dq")}
            onMouseLeave={() => setSliderPreview((p) => (p === "dq" ? null : p))}
          >
            <HighlightPreview
              visible={sliderPreview === "dq"}
              dialogueOn={prefs.highlightDialogue === false}
              namesOn={prefs.highlightNames !== false}
              fontSize={prefs.fontSize}
              locale={prefs.locale || i18n.language || "en"}
            />
            <label className="setting-checkbox">
              <input type="checkbox" checked={prefs.highlightDialogue !== false} onChange={(e) => setHighlightDialogue(e.target.checked)} />
              <span>{t("settings.display.highlightDialogue", { defaultValue: "Tint quoted dialogue" })}</span>
            </label>
          </div>
          <div
            className="setting-slider-wrap"
            onMouseEnter={() => setSliderPreview("np")}
            onMouseLeave={() => setSliderPreview((p) => (p === "np" ? null : p))}
          >
            <HighlightPreview
              visible={sliderPreview === "np"}
              dialogueOn={prefs.highlightDialogue !== false}
              namesOn={prefs.highlightNames === false}
              fontSize={prefs.fontSize}
              locale={prefs.locale || i18n.language || "en"}
            />
            <label className="setting-checkbox">
              <input type="checkbox" checked={prefs.highlightNames !== false} onChange={(e) => setHighlightNames(e.target.checked)} />
              <span>{t("settings.display.highlightNames", { defaultValue: "Highlight character names" })}</span>
            </label>
          </div>
        </div>
        <div className="setting-group">
          <label className="setting-checkbox">
            <input type="checkbox" checked={prefs.customRichBlocks !== false} onChange={(e) => setCustomRichBlocks(e.target.checked)} />
            <span>{t("settings.display.customRichBlocks")}</span>
          </label>
        </div>
      </div>

      <div className="settings-display-group">
        <div className="settings-section-label">{t("settings.display.groups.visualLayers")}</div>
        <div className="setting-group">
          <label className="setting-checkbox">
            <input type="checkbox" checked={prefs.backgroundArt} onChange={(e) => setBg(e.target.checked)} />
            <span>{t("settings.display.backgroundArt")}</span>
          </label>
        </div>
        <div className="setting-group">
          <label className="setting-checkbox">
            <input type="checkbox" checked={prefs.sceneBackdrop !== false} onChange={(e) => setSceneBackdrop(e.target.checked)} />
            <span>{t("settings.display.sceneBackdrop")}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

// ── Status tab (read-only diagnostic) ────────────────────────────────────
function StatusTab() {
  const [data, setData] = useState(null)
  const [err, setErr]   = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const reload = useCallback(() => {
    setErr(null)
    window.openovel.getServiceStatus()
      .then(setData)
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  if (err)    return <div className="settings-error">Failed to load status: {err}</div>
  if (!data)  return <div className="settings-loading">loading status…</div>

  const llm = summarizeLlm(data)
  const search = summarizeSearch(data)
  const network = summarizeNetwork(data)
  const session = summarizeSession(data)

  return (
    <div className="settings-section-group">
      <StatusLine tone={llm.tone}      title="LLM"        detail={llm.detail} />
      <StatusLine tone={search.tone}   title="Web search" detail={search.detail} />
      <StatusLine tone={network.tone}  title="Network"    detail={network.detail} />
      {session && <StatusLine tone="dim" title="Session" detail={session.detail} />}

      <button
        type="button"
        className="key-disclosure"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? "▾" : "▸"} Advanced (raw routing, runtime, proxy env)
      </button>
      {showAdvanced && <AdvancedStatus data={data} />}

      <div className="settings-action-row">
        <button className="settings-button" type="button" onClick={reload}>Refresh</button>
        <span className="dim settings-hint">captured at {new Date(data.capturedAt).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

// Uses the same .setting-group + .setting-label idiom as Display / Behavior
// tabs so Status visually slots into the existing language. The state tone
// just shifts the value text color — no badges, no accent bars.
function StatusLine({ tone, title, detail }) {
  return (
    <div className="setting-group">
      <div className="setting-label">{title}</div>
      <div className={`status-row-value tone-${tone || "dim"}`}>{detail}</div>
    </div>
  )
}

function summarizeLlm(data) {
  // Status reflects what the user picked in API Keys, not what we'd
  // recommend. The runtime's foreground route IS the picked preset (after
  // setLlmConfig writes AI_PROVIDER), so we just report its key state.
  const fg = data.providers?.foreground || []
  const primary = fg[0]
  if (!primary) return { tone: "error", detail: "No model connected yet — set one up in API Keys" }
  if (primary.keyConfigured) {
    return { tone: "ok", detail: `${friendlyName(primary)} · ${primary.model || "(model default)"}` }
  }
  const env = Array.isArray(primary.keyEnv) ? primary.keyEnv.join("/") : (primary.keyEnv || "key")
  return { tone: "error", detail: `${friendlyName(primary)} — ${env} not set` }
}

function summarizeSearch(data) {
  const providers = data.search?.providers || []
  const explicit = providers.find((p) => p.id === data.search?.defaultProvider) || providers[0]
  if (!explicit) return { tone: "dim", detail: "DuckDuckGo (free fallback)" }
  // DuckDuckGo + anthropic-server-websearch don't require keys
  if (!explicit.keyEnv || explicit.configured) {
    return { tone: explicit.billingMode === "free" ? "dim" : "ok", detail: explicit.name || explicit.id }
  }
  return { tone: "warn", detail: `${explicit.name || explicit.id} — key missing, fallback to DuckDuckGo` }
}

function summarizeNetwork(data) {
  if (!data.proxy?.enabled) return { tone: "ok", detail: "Direct connection" }
  const https = data.proxy.bindings.find((b) => b.key === "HTTPS_PROXY")
  return { tone: "dim", detail: `Via proxy · ${https?.value || "configured"}` }
}

function summarizeSession(data) {
  const a = data.session?.aggregate
  if (!a) return null
  const cost = Number(a.costUsd || 0)
  const tokens = (a.inputTokens || 0) + (a.outputTokens || 0)
  return {
    detail: `$${cost.toFixed(4)} · ${a.modelCalls || 0} calls · ${tokens.toLocaleString()} tokens · ${a.toolCalls || 0} tool calls`,
  }
}

function friendlyName(provider) {
  const id = provider?.id || ""
  if (id === "kimi-code") return "Kimi Code"
  if (id.startsWith("mimo-token-plan")) {
    const region = id.split("-").pop()
    return `MiMo Token Plan (${region})`
  }
  if (id === "mimo-api") return "MiMo Pay-as-you-go"
  if (id === "custom-openai") {
    const url = String(provider.baseUrl || "").toLowerCase()
    if (url.includes("deepseek"))    return "DeepSeek"
    if (url.includes("moonshot"))    return "Kimi (Moonshot)"
    if (url.includes("xiaomimimo"))  return "MiMo"
    if (url.includes("openrouter"))  return "OpenRouter"
    return "Custom OpenAI"
  }
  return provider.name || id
}

function AdvancedStatus({ data }) {
  return (
    <div className="settings-section-group">
      <StatusBlock title="Runtime">
        <KVRow k="Node"      v={data.runtime.node} />
        <KVRow k="Platform"  v={`${data.runtime.platform}/${data.runtime.arch}`} />
        <KVRow k="Home"      v={data.runtime.home || "(default)"} mono />
      </StatusBlock>

      <StatusBlock title="Network proxy">
        {data.proxy.enabled ? (
          <>
            <KVRow k="State" v="active" tone="ok" />
            {data.proxy.bindings.map((b) => (
              <KVRow key={b.key} k={b.key} v={b.value} mono />
            ))}
          </>
        ) : (
          <KVRow k="State" v="not set (direct connection)" tone="dim" />
        )}
      </StatusBlock>

      <StatusBlock title="LLM provider routing">
        <KVRow k="Default" v={data.providers.defaultProvider} mono />
        <KVRow k="Paid fallback" v={data.providers.allowPaidFallback ? "enabled" : "disabled"} tone={data.providers.allowPaidFallback ? "ok" : "dim"} />
        <div className="status-sublabel">Foreground route</div>
        {data.providers.foreground.map((p) => <ProviderRow key={p.id} p={p} />)}
        <div className="status-sublabel">Background route</div>
        {data.providers.background.map((p) => <ProviderRow key={p.id} p={p} />)}
      </StatusBlock>

      <StatusBlock title="Web search providers">
        <KVRow k="Default" v={data.search.defaultProvider} mono />
        {data.search.providers.map((p) => (
          <KVRow
            key={p.id}
            k={p.id}
            v={p.configured ? "configured" : (p.keyEnv ? `key missing (${Array.isArray(p.keyEnv) ? p.keyEnv.join("/") : p.keyEnv})` : "—")}
            tone={p.configured ? "ok" : (p.keyEnv ? "warn" : "dim")}
          />
        ))}
      </StatusBlock>
    </div>
  )
}

function ProviderRow({ p }) {
  return (
    <KVRow
      k={p.id}
      v={
        <>
          <span className="mono">model={p.model || "—"}</span>{" "}
          <span className={`tone-${p.keyConfigured ? "ok" : "warn"}`}>
            key={p.keyConfigured ? "yes" : `missing (${p.keyEnv || "-"})`}
          </span>
        </>
      }
    />
  )
}

function StatusBlock({ title, children }) {
  return (
    <section className="status-block">
      <header className="status-block-title">{title}</header>
      <div className="status-block-body">{children}</div>
    </section>
  )
}

function KVRow({ k, v, tone, mono }) {
  return (
    <div className="status-row">
      <span className="status-row-k">{k}</span>
      <span className={`status-row-v${tone ? ` tone-${tone}` : ""}${mono ? " mono" : ""}`}>{v}</span>
    </div>
  )
}

// ── API Keys tab ─────────────────────────────────────────────────────────
// One flat list of LLM presets — picking one writes the matching env in one
// atomic patch (provider + paidFallback + baseUrl + suggested small/large
// models). The runtime actually changes its routing on click. "Advanced" is
// the only escape hatch that leaves env alone.
//
// Pay-as-you-go presets route through the `custom-openai` provider plugin
// (a generic OpenAI-compatible adapter) — we just pre-fill base URL and
// suggested model names. The actual key is always `AI_API_KEY` for these.
//
// Free presets route through their native provider plugin (`kimi-code`,
// `mimo-token-plan-sgp`) and use the provider's own key env.

// Each preset pins its OWN provider id + own keyId so the key slots stay
// isolated. Switching presets never overwrites the previous one's key —
// the user can keep DeepSeek, OpenRouter, and Custom URL keys all saved at
// the same time, and just flip between them in one click.
const LLM_PRESETS = [
  {
    id: "deepseek", label: "DeepSeek",
    keyId: "deepseek",
    config: { provider: "deepseek", paidFallback: true, baseUrl: "" },
    defaults: { small: "deepseek-v4-flash", large: "deepseek-v4-pro" },
  },
  {
    id: "kimi-code", label: "Kimi Code",
    keyId: "kimi",
    config: { provider: "kimi-code", paidFallback: false, baseUrl: "" },
    defaults: { small: "kimi-for-coding", large: "kimi-for-coding" },
  },
  {
    id: "mimo-token", label: "MiMo Token Plan",
    keyId: "mimo",
    // Token Plan keys are region-locked but use the same env var. Pin to cn
    // (most common) and chain all 3 regions in providerOrder — registry walks
    // the chain on auth failure so a key bound to sgp / ams still wins on a
    // later iteration without the user having to pick the right region.
    config: {
      provider: "mimo-token-plan-cn",
      providerOrder: ["mimo-token-plan-cn", "mimo-token-plan-sgp", "mimo-token-plan-ams"],
      paidFallback: false,
      baseUrl: "",
    },
    defaults: { small: "mimo-v2.5", large: "mimo-v2.5-pro" },
  },
  {
    id: "openrouter", label: "OpenRouter",
    keyId: "openrouter",
    config: { provider: "openrouter", paidFallback: true, baseUrl: "" },
    defaults: { small: "", large: "" },
  },
  {
    id: "anthropic", label: "Anthropic (Claude)",
    keyId: "anthropic",
    config: { provider: "anthropic", paidFallback: true, baseUrl: "" },
    defaults: { small: "claude-haiku-4-5", large: "claude-sonnet-4-6" },
  },
  {
    id: "custom-anthropic", label: "Custom Anthropic",
    keyId: "anthropic",
    // Any endpoint speaking the Anthropic Messages format — base URL is editable.
    config: { provider: "custom-anthropic", paidFallback: true, baseUrl: "" },
    defaults: { small: "", large: "" },
  },
  {
    id: "custom", label: "Custom URL",
    keyId: "openai",
    config: { provider: "custom-openai", paidFallback: true, baseUrl: "" },
    defaults: { small: "", large: "" },
  },
]

const SEARCH_PRESETS = [
  { id: "default", label: "DuckDuckGo", providerEnv: "",                    keyId: null },
  { id: "kimi",    label: "Kimi",       providerEnv: "kimi-search-service", keyId: "kimi-search" },
  { id: "exa",     label: "Exa",        providerEnv: "exa-mcp",             keyId: "exa" },
]

function inferLlmPreset(snap) {
  const cfg = snap.llm || {}
  // If a provider is pinned, the highlighted preset = actual pin. The user
  // is in charge of which preset is active; we never silently move the
  // highlight elsewhere based on which keys happen to be filled.
  if (cfg.provider) {
    // User-defined custom providers: the preset id IS the provider id, so the
    // matching dynamic pill highlights. Unknown custom: ids (entry deleted
    // elsewhere) fall through to the "no pill highlighted" state.
    if (cfg.provider.startsWith("custom:")) {
      return (snap.customProviders || []).some((cp) => cp.id === cfg.provider) ? cfg.provider : null
    }
    if (cfg.provider === "kimi-code") return "kimi-code"
    if (cfg.provider === "deepseek") return "deepseek"
    if (cfg.provider === "openrouter") return "openrouter"
    if (cfg.provider === "anthropic") return "anthropic"
    if (cfg.provider === "custom-anthropic") return "custom-anthropic"
    if (cfg.provider.startsWith("mimo-token-plan")) return "mimo-token"
    if (cfg.provider === "custom-openai") {
      // Legacy: older settings might still have deepseek/openrouter pinned
      // as custom-openai with a baseUrl. Map back by baseUrl match so
      // those users see the right preset highlighted.
      const match = LLM_PRESETS.find((p) => p.config?.baseUrl && p.config.baseUrl === cfg.baseUrl)
      return match ? match.id : "custom"
    }
    // Pinned to a provider we don't have a UI preset for (legacy native
    // plugins, externally set AI_PROVIDER, etc.). Return null → no pill
    // is highlighted, prompting the user to pick one explicitly.
    return null
  }
  // No pin → no preset highlighted. The user must click a pill to make a
  // selection real. We deliberately don't infer from which keys happen to
  // be configured — that produced a misleading "pre-selected" state where
  // the pill lit up but AI_PROVIDER stayed empty, so Test connection ran
  // against the runtime's fallback (kimi-code) and failed with the wrong
  // error.
  return null
}
function inferSearchPreset(snap) {
  const provider = snap.search?.provider || ""
  if (!provider) return "default"
  const known = SEARCH_PRESETS.find((m) => m.providerEnv === provider)
  return known ? known.id : "default"
}

// compact: trims everything that isn't strictly necessary for "get the
// runtime working" — used inside OnboardingModal where Web search is
// already free-by-default and model-tuning shouldn't crowd the first run.
export function ApiKeysTab({ compact = false, section = "all", mode = "advanced" } = {}) {
  const { t } = useTranslation()
  const [snap, setSnap]               = useState(null)
  const [drafts, setDrafts]           = useState({})           // id → typed key value
  const [showing, setShowing]         = useState({})
  const [status, setStatus]           = useState("")
  const [err, setErr]                 = useState(null)
  const [llmPreset, setLlmPreset]     = useState(null)
  const [searchPreset, setSearchPreset] = useState(null)
  const [modelDrafts, setModelDrafts] = useState({ small: null, large: null, baseUrl: null, ticPatterns: null, alias: null })
  const [showAdvanced, setShowAdvanced] = useState(false)      // collapse model + base URL details
  // True while the "+" pill's inline "new custom provider" editor is open.
  const [creatingCustom, setCreatingCustom] = useState(false)
  // Test connection: null = never run, "testing" = in flight, { ok, ... } = result.
  const [testResult, setTestResult] = useState(null)

  // Refresh the saved-from-disk snapshot WITHOUT touching in-progress drafts.
  // Saving one field used to call the draft-clearing reload(), which wiped
  // every OTHER field the user had typed but not yet saved — so each save ate
  // the rest of the form. Snapshot-refresh and draft-clearing are now separate
  // concerns: saves refresh + clear only the field they touched.
  const refreshSnapshot = useCallback(() => {
    setErr(null)
    return window.openovel.getApiKeys()
      .then((s) => {
        setSnap(s)
        setLlmPreset((current) => current || inferLlmPreset(s))
        setSearchPreset((current) => current || inferSearchPreset(s))
        return s
      })
      .catch((e) => { setErr(e?.message || String(e)); return null })
  }, [])

  // Full reset: drop ALL drafts and refresh. Used on mount and on an explicit
  // provider switch, where the prior provider's typed key / base URL no longer
  // apply. Per-field saves use refreshSnapshot instead so they don't clobber
  // unsaved input elsewhere on the form.
  const reload = useCallback(() => {
    setDrafts({})
    setShowing({})
    setModelDrafts({ small: null, large: null, baseUrl: null, ticPatterns: null, alias: null })
    return refreshSnapshot()
  }, [refreshSnapshot])
  useEffect(() => { reload() }, [reload])

  // Run the LLM connection test and surface it in the banner. Shared by
  // key-save (auto-test) and base-URL-save (re-test when a key already exists).
  const runLlmTest = useCallback(async () => {
    setTestResult("testing")
    try {
      setTestResult(await window.openovel.testLlmConnection())
    } catch (e) {
      setTestResult({ ok: false, error: e?.message || String(e) })
    }
  }, [])

  const saveKey = useCallback(async (id) => {
    const value = drafts[id] ?? ""
    setStatus("saving…")
    try {
      await window.openovel.setApiKeys({ [id]: value })
      await refreshSnapshot()
      // Clear ONLY the key we just saved; every other in-progress draft (base
      // URL, the sibling key, model fields) stays exactly as the user left it.
      setDrafts((d) => { const next = { ...d }; delete next[id]; return next })
      setShowing((s) => { const next = { ...s }; delete next[id]; return next })
      // Auto-test the LLM key right after saving — keeps the simple path to a
      // single paste-and-go action. In ADVANCED mode save and test are
      // decoupled: saving just saves, and the user runs the manual "Test
      // connection" button when they're ready (so re-saving an endpoint or
      // model mid-edit doesn't fire a test against a half-configured provider).
      // Clearing the slot is just a save; testing an empty key would mislabel
      // the result. Search keys also skip the test (no webSearch ping).
      const spec = (snap?.keys || []).find((k) => k.id === id)
      if (value && spec?.category === "llm" && mode !== "advanced") {
        // The banner below carries the verbose result; here just say
        // "saved" briefly and clear, so the action row isn't duplicating
        // the banner's "Connected"/"Connection failed".
        setStatus("saved")
        await runLlmTest()
        setTimeout(() => setStatus(""), 1500)
      } else {
        setStatus(value ? "saved · key updated" : "saved · key cleared")
        setTimeout(() => setStatus(""), 1800)
      }
    } catch (e) {
      setStatus(`save failed: ${e?.message || e}`)
    }
  }, [drafts, refreshSnapshot, runLlmTest, snap, mode])

  const applyLlmConfig = useCallback(async (patch) => {
    setStatus("applying…")
    try {
      await window.openovel.setLlmConfig(patch)
      setStatus("applied")
      await refreshSnapshot()
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`)
    }
  }, [refreshSnapshot])

  const applySearchConfig = useCallback(async (patch) => {
    setStatus("applying…")
    try {
      await window.openovel.setSearchConfig(patch)
      setStatus("applied")
      await refreshSnapshot()
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`)
    }
  }, [refreshSnapshot])

  const saveModelField = useCallback(async (field, value, { retest = false } = {}) => {
    const patch = {}
    if (field === "small") patch.smallModel = value
    if (field === "large") patch.largeModel = value
    if (field === "baseUrl") patch.baseUrl = value
    await applyLlmConfig(patch)
    setModelDrafts((d) => ({ ...d, [field]: null }))
    // Changing the base URL after a key is already set invalidates the prior
    // test — re-run it so the banner reflects the new endpoint instead of a
    // stale pass/fail from before the URL existed. Advanced mode decouples
    // save from test, so leave the re-test to the manual button there.
    if (retest && mode !== "advanced") await runLlmTest()
  }, [applyLlmConfig, runLlmTest, mode])

  // Save the active provider's custom verbal-tic regexes (one per line). Stored
  // per-provider; the runtime scans recent prose against them and surfaces
  // matches to the Storykeeper. Clears only this draft so other fields survive.
  const saveTicPatterns = useCallback(async (providerId, value) => {
    if (!providerId) return
    setStatus("applying…")
    try {
      await window.openovel.setTicPatterns(providerId, value)
      setStatus("applied")
      await refreshSnapshot()
      setModelDrafts((d) => ({ ...d, ticPatterns: null }))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`)
    }
  }, [refreshSnapshot])

  // Save the active provider's display alias. Stored per-provider; shows up
  // wherever the provider is listed (pills here, Routing/Agents dropdowns).
  const saveAlias = useCallback(async (providerId, value) => {
    if (!providerId) return
    setStatus("applying…")
    try {
      await window.openovel.setProviderAlias(providerId, value)
      setStatus("applied")
      await refreshSnapshot()
      setModelDrafts((d) => ({ ...d, alias: null }))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`)
    }
  }, [refreshSnapshot])

  // Custom-provider manager callbacks. Saving a key for the ACTIVE custom
  // provider re-runs the connection test, mirroring saveKey's auto-test —
  // except in advanced mode, where save and test are decoupled (the manager
  // is advanced-only, so this effectively makes custom-provider testing a
  // deliberate click on the "Test connection" button).
  const handleCustomProviderSaved = useCallback(async ({ keyChanged = false, providerId = "", created = false } = {}) => {
    const s = await refreshSnapshot()
    // A freshly created provider becomes the active one and closes the "new"
    // editor — the user just set it up, so pin it (its own pill stays selected
    // and its editor stays open). Pin inline via the stable applyLlmConfig
    // rather than a render-scope helper: this callback is memoized before the
    // component's early returns, so closing over a const declared after them
    // would capture an uninitialized binding (TDZ on save).
    if (created && providerId) {
      setCreatingCustom(false)
      setLlmPreset(providerId)
      await applyLlmConfig({ provider: providerId, paidFallback: true, baseUrl: "", providerOrder: [], smallModel: "", largeModel: "" })
    }
    setStatus("saved")
    if (keyChanged && providerId && s?.llm?.provider === providerId && mode !== "advanced") await runLlmTest()
    setTimeout(() => setStatus(""), 1500)
  }, [refreshSnapshot, applyLlmConfig, runLlmTest, mode])

  const handleCustomProviderDeleted = useCallback(async (providerId) => {
    // Deleting the active provider clears its pin server-side; un-highlight
    // the pill so the UI doesn't keep pointing at a provider that's gone.
    setLlmPreset((current) => (current === providerId ? null : current))
    await refreshSnapshot()
    setStatus("deleted")
    setTimeout(() => setStatus(""), 1500)
  }, [refreshSnapshot])

  // Test connection fires automatically when an LLM key is saved (see saveKey
  // above), so the common paste-a-key path needs no click. A manual "Test
  // connection" button (rendered below the banner) covers what auto-save can't:
  // env-supplied keys and custom providers, which never pass through saveKey.
  // Clear stale test result whenever the user changes the LLM preset.
  useEffect(() => { setTestResult(null) }, [llmPreset])

  if (err)   return <div className="settings-error">Failed to load keys: {err}</div>
  if (!snap) return <div className="settings-loading">loading keys…</div>

  // User-defined custom providers become dynamic preset pills: picking one
  // pins its provider id. They carry no shared keyId — key + endpoint are
  // edited in the Custom providers manager below — and clear AI_BASE_URL /
  // model pins so the entry's own baseUrl + default models rule.
  // Each custom provider is its OWN pill. Picking it pins it as the active
  // provider AND opens its inline editor below (name / protocol / base URL /
  // models / key) — there's no separate manager section. The generic built-in
  // "Custom URL" / "Custom Anthropic" presets are replaced by a single "+".
  const customEntries = snap.customProviders || []
  const customPresets = customEntries.map((cp) => ({
    id: cp.id,
    label: cp.name,
    keyId: null,
    customEntry: cp,
    config: { provider: cp.id, paidFallback: true, baseUrl: "" },
    defaults: { small: "", large: "" },
  }))
  const allLlmPresets = [...LLM_PRESETS, ...customPresets]

  // activeLlm can be undefined when the runtime is pinned to a provider we
  // don't have a UI preset for (legacy native plugin, external env). Render
  // pills with no highlight in that case and show a tiny hint above.
  const activeLlm    = allLlmPresets.find((p) => p.id === llmPreset)     || null
  const activeSearch = SEARCH_PRESETS.find((p) => p.id === searchPreset) || SEARCH_PRESETS[0]
  const pinnedUnknown = !activeLlm && Boolean(snap.llm.provider)

  const onPickLlm = (preset) => {
    setLlmPreset(preset.id)
    setCreatingCustom(false)
    // Switching provider: the previous provider's typed-but-unsaved key / base
    // URL / model drafts no longer apply, so clear them here. (Per-field saves
    // deliberately preserve other drafts via refreshSnapshot; only an explicit
    // provider switch resets the whole form.)
    setDrafts({})
    setShowing({})
    setModelDrafts({ small: null, large: null, baseUrl: null, ticPatterns: null, alias: null })
    // Normalize: every pick writes ALL config fields, including ones we want
    // explicitly cleared (e.g. switching away from MiMo must drop its
    // providerOrder chain so DeepSeek doesn't inherit it).
    applyLlmConfig({
      provider:      preset.config.provider || "",
      paidFallback:  Boolean(preset.config.paidFallback),
      baseUrl:       preset.config.baseUrl || "",
      providerOrder: preset.config.providerOrder || [],
      smallModel:    preset.defaults.small,
      largeModel:    preset.defaults.large,
    })
  }
  const onPickSearch = (preset) => {
    setSearchPreset(preset.id)
    applySearchConfig({ provider: preset.providerEnv })
  }

  const visibleLlmKey = activeLlm ? snap.keys.find((k) => k.id === activeLlm.keyId) : null
  const visibleSearchKey = activeSearch.keyId
    ? snap.keys.find((k) => k.id === activeSearch.keyId)
    : null
  const simpleMode = mode !== "advanced"
  // Presets that need a user-supplied base URL (any custom-endpoint preset).
  const isCustomUrl = !simpleMode && (activeLlm?.id === "custom" || activeLlm?.id === "custom-anthropic")
  // Set of key-ids that have a filled key — used to mark "configured" pills
  // so the user can see at a glance which presets are usable, and to switch
  // between several at any time.
  const configuredKeyIds = new Set(snap.keys.filter((k) => k.set).map((k) => k.id))
  const showLlm = section === "all" || section === "llm"
  const showSearch = !compact && (section === "all" || section === "search")
  const showInnerLabels = section === "all"
  // Built-in named presets + one pill per custom provider. The generic
  // "Custom URL" / "Custom Anthropic" presets are dropped from the row (the
  // "+" pill creates a named custom provider instead). Simple mode shows only
  // the built-ins.
  const builtinPills = LLM_PRESETS.filter((preset) => preset.id !== "custom" && preset.id !== "custom-anthropic")
  const visibleLlmPresets = simpleMode ? builtinPills : [...builtinPills, ...customPresets]

  return (
    <div className="settings-section-group">
      {showLlm && (
        <>
          {showInnerLabels && <div className="settings-section-label">{t("settings.apikeys.llm")}</div>}
          {/* A lower settings layer (project .openovel/settings.jsonc etc.)
              overrides what this page writes — without this warning, switching
              the pill LOOKS like it worked, then the shadowed provider/models
              silently resurface on restart (or as soon as a cleared env mirror
              falls through to the file layers). */}
          {snap.layerShadowing && (
            <div className="llm-shadow-warning">
              <div className="llm-shadow-warning-head">
                {t("settings.apikeys.shadowTitle", { defaultValue: "Overridden by another settings file" })}
              </div>
              <div className="llm-shadow-warning-body">
                {snap.layerShadowing.conflicts.map((c) => (
                  <span key={c.key} className="llm-shadow-pin">
                    {c.key} → <span className="mono">{c.effective}</span>
                  </span>
                ))}
              </div>
              <div className="llm-shadow-warning-files">
                {t("settings.apikeys.shadowHint", { defaultValue: "These values come from a lower settings layer and win over this page. Edit or remove:" })}
                {" "}
                {snap.layerShadowing.files.map((f) => (
                  <span key={f} className="mono">{f}</span>
                ))}
              </div>
            </div>
          )}
          {pinnedUnknown && (
            <div className="settings-section-intro">
              Currently pinned to <span className="mono">{snap.llm.provider}</span> — pick a preset below to switch.
            </div>
          )}
          <div className="key-mode-row image-provider-modes">
            {visibleLlmPresets.map((p) => {
              // Each preset now owns its own keyId — dot truly means "this
              // preset has a key saved", not "any sibling sharing the slot
              // does". So saving a DeepSeek key lights only DeepSeek. Dynamic
              // custom-provider pills read their own key slot instead.
              const isConfigured = p.customEntry ? p.customEntry.set : (p.keyId && configuredKeyIds.has(p.keyId))
              const isActive = activeLlm?.id === p.id
              // Operator alias wins over the built-in label so several
              // similar endpoints stay tellable-apart at a glance. Custom
              // providers already carry an editable name instead.
              const pillLabel = (!p.customEntry && snap.aliases?.[p.config.provider]) || p.label
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`key-mode${isActive ? " is-active" : ""}${isConfigured ? " is-configured" : ""}`}
                  onClick={() => onPickLlm(p)}
                  title={isConfigured ? "key configured" : "key not set"}
                >
                  <span className="key-mode-label">
                    {pillLabel}
                    {p.recommended && <span className="key-mode-badge">★</span>}
                    {isConfigured && <span className="key-mode-dot" aria-label="key configured" />}
                  </span>
                </button>
              )
            })}
            {/* "+" opens an inline "new custom provider" editor below the row;
                on save it becomes its own pill. */}
            {!compact && !simpleMode && (
              <button
                type="button"
                className={`key-mode key-mode-add${creatingCustom ? " is-active" : ""}`}
                onClick={() => { setCreatingCustom(true); setLlmPreset(null) }}
                title={t("settings.apikeys.custom.add")}
                aria-label={t("settings.apikeys.custom.add")}
              >
                <span className="key-mode-label">+</span>
              </button>
            )}
          </div>

          {!activeLlm && !creatingCustom && (
            <div className="settings-section-intro llm-pick-hint">
              Pick a provider above to set the API key and test the connection.
            </div>
          )}

          {/* Inline custom-provider editor: the "+" pill opens a blank one; a
              custom pill opens its own. Built-in presets fall through to the
              base-URL / key / model-details UI below. */}
          {creatingCustom ? (
            <CustomProviderRow
              entry={null}
              onSaved={(info) => handleCustomProviderSaved({ ...info, created: true })}
              onCancel={() => setCreatingCustom(false)}
              setStatus={setStatus}
            />
          ) : activeLlm?.customEntry ? (
            <CustomProviderRow
              key={activeLlm.customEntry.id}
              entry={activeLlm.customEntry}
              onSaved={handleCustomProviderSaved}
              onDeleted={handleCustomProviderDeleted}
              setStatus={setStatus}
            />
          ) : null}

          {/* Custom presets need their endpoint set BEFORE the key: saving a key
              auto-runs the connection test, which inevitably fails if no base URL
              exists yet. So for custom providers the base URL row comes first. */}
          {isCustomUrl && (
            <div className="key-row">
              <div className="key-row-head">
                <span className="key-row-label">Base URL</span>
                <span className="key-row-state tone-dim">{snap.llm.baseUrl ? "set" : "not set"}</span>
              </div>
              <div className="key-row-input">
                <input
                  type="text"
                  className="key-input"
                  placeholder="https://your-openai-compatible.example.com/v1"
                  value={modelDrafts.baseUrl !== null ? modelDrafts.baseUrl : (snap.llm.baseUrl || "")}
                  onChange={(e) => setModelDrafts((d) => ({ ...d, baseUrl: e.target.value }))}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span />
                <button
                  type="button"
                  className="key-save"
                  onClick={() => saveModelField("baseUrl", modelDrafts.baseUrl ?? "", { retest: Boolean(visibleLlmKey?.set) })}
                  disabled={modelDrafts.baseUrl === null}
                >save</button>
              </div>
              <div className="key-row-meta">
                <span className="mono">AI_BASE_URL</span>
                <span className="tone-dim"> · set this first, then add the key below</span>
              </div>
            </div>
          )}

          {visibleLlmKey && (
            <KeyRow k={visibleLlmKey} drafts={drafts} setDrafts={setDrafts} showing={showing} setShowing={setShowing} onSave={saveKey} />
          )}

          {activeLlm && testResult && (
            <div className={`llm-test-banner${
              testResult === "testing" ? " is-testing"
              : testResult.ok ? " is-ok"
              : " is-error"
            }`}>
              {testResult === "testing" ? (
                <span className="llm-test-banner-head">
                  <span className="llm-test-spinner" aria-hidden="true" />
                  <span>testing connection…</span>
                </span>
              ) : testResult.ok ? (
                <>
                  <span className="llm-test-banner-head">
                    <span className="llm-test-mark" aria-hidden="true">✓</span>
                    <span className="llm-test-label">Connected</span>
                    <span className="llm-test-latency">{testResult.latencyMs}ms</span>
                  </span>
                  <span className="llm-test-meta">
                    <span className="mono">{testResult.provider}/{testResult.model}</span>
                  </span>
                  {testResult.sample && (
                    <span className="llm-test-sample">"{testResult.sample}"</span>
                  )}
                </>
              ) : (
                <>
                  <span className="llm-test-banner-head">
                    <span className="llm-test-mark" aria-hidden="true">✗</span>
                    <span className="llm-test-label">Connection failed</span>
                  </span>
                  <span className="llm-test-meta">{testResult.error}</span>
                </>
              )}
            </div>
          )}

          {/* Manual connection test for the active provider. Auto-test still
              fires on key-save (see saveKey / handleCustomProviderSaved); this
              button covers the cases auto-test misses — keys supplied via env
              (never saved through the UI) and custom providers, plus an
              explicit re-test after a provider outage. */}
          {activeLlm && !compact && (
            <button
              type="button"
              className="settings-button llm-test-button"
              onClick={runLlmTest}
              disabled={testResult === "testing"}
            >
              {testResult === "testing"
                ? t("settings.apikeys.testing", { defaultValue: "testing connection…" })
                : t("settings.apikeys.testConnection", { defaultValue: "Test connection" })}
            </button>
          )}

          {/* Model details edit GLOBAL model pins (AI_SMALL_MODEL etc.), which
              custom providers deliberately leave empty so the entry's own
              default/background models rule — so this expander is hidden for
              them; they edit their models in the Custom providers manager below. */}
          {!compact && !simpleMode && activeLlm && !activeLlm.customEntry && (
            <>
              <button
                type="button"
                className="key-disclosure"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "▾" : "▸"} Model details
              </button>
              {showAdvanced && (
                <>
                  <div className="model-fields-row">
                    <ModelField
                      label="Small"
                      envKey="AI_SMALL_MODEL"
                      value={modelDrafts.small !== null ? modelDrafts.small : (snap.llm.smallModel || "")}
                      onChange={(v) => setModelDrafts((d) => ({ ...d, small: v }))}
                      onSave={(v) => saveModelField("small", v)}
                      dirty={modelDrafts.small !== null}
                    />
                    <ModelField
                      label="Large"
                      envKey="AI_LARGE_MODEL"
                      value={modelDrafts.large !== null ? modelDrafts.large : (snap.llm.largeModel || "")}
                      onChange={(v) => setModelDrafts((d) => ({ ...d, large: v }))}
                      onSave={(v) => saveModelField("large", v)}
                      dirty={modelDrafts.large !== null}
                    />
                  </div>
                  {/* Display alias for the active provider. Custom providers
                      skip this — their name (edited below) IS the label. */}
                  {activeLlm && !activeLlm.customEntry && activeLlm.config.provider && (
                    <ModelField
                      label={t("settings.apikeys.alias")}
                      envKey={activeLlm.config.provider}
                      placeholder={activeLlm.label}
                      value={modelDrafts.alias !== null ? modelDrafts.alias : (snap.aliases?.[activeLlm.config.provider] || "")}
                      onChange={(v) => setModelDrafts((d) => ({ ...d, alias: v }))}
                      onSave={(v) => saveAlias(activeLlm.config.provider, v)}
                      dirty={modelDrafts.alias !== null}
                    />
                  )}
                  {visibleLlmKey && (
                    <TicPatternsField
                      key={visibleLlmKey.providerId}
                      providerId={visibleLlmKey.providerId}
                      initial={visibleLlmKey.ticPatterns || ""}
                      onSave={saveTicPatterns}
                    />
                  )}
                </>
              )}
            </>
          )}

        </>
      )}

      {showSearch && (
        <>
          {showInnerLabels && <div className="settings-section-label">{t("settings.apikeys.webSearch")}</div>}
          <div className="key-mode-row key-mode-row-flat">
            {SEARCH_PRESETS.map((p) => {
              // "DuckDuckGo" preset has no keyId — it's free and always available;
              // mark it as configured too so the dot is visually consistent.
              const isConfigured = !p.keyId || configuredKeyIds.has(p.keyId)
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`key-mode${activeSearch.id === p.id ? " is-active" : ""}${isConfigured ? " is-configured" : ""}`}
                  onClick={() => onPickSearch(p)}
                  title={isConfigured ? "available" : "key not set"}
                >
                  <span className="key-mode-label">
                    {p.label}
                    {isConfigured && <span className="key-mode-dot" aria-label="available" />}
                  </span>
                </button>
              )
            })}
          </div>
          {visibleSearchKey && (
            <KeyRow k={visibleSearchKey} drafts={drafts} setDrafts={setDrafts} showing={showing} setShowing={setShowing} onSave={saveKey} />
          )}
        </>
      )}

      <div className="settings-action-row">
        {status && <span className="settings-hint">{status}</span>}
      </div>
    </div>
  )
}

function ModelField({ label, envKey, value, onChange, onSave, dirty, placeholder = "(provider default)" }) {
  return (
    <div className="model-field">
      <div className="model-field-head">
        <span className="model-field-label">{label}</span>
      </div>
      <div className="model-field-input">
        <input
          type="text"
          className="key-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="key-save"
          onClick={() => onSave(value)}
          disabled={!dirty}
        >save</button>
      </div>
      <div className="key-row-meta"><span className="mono">{envKey}</span></div>
    </div>
  )
}

// Per-provider custom verbal-tic ("口癖") regexes. One regex per line (bare or
// /pattern/flags; lines starting with # are comments). The Storykeeper scans
// recent narrator prose against these and surfaces matches so it can suppress
// the model's known tics via foreground guidance. Self-contained: remounts per
// provider (keyed by providerId) so it always shows that provider's saved set.
function TicPatternsField({ providerId, initial, onSave }) {
  const [draft, setDraft] = useState(initial || "")
  const dirty = draft !== (initial || "")
  const { errors } = parseTicPatterns(draft)
  return (
    <div className="tic-patterns-field">
      <div className="model-field-head">
        <span className="model-field-label">Verbal-tic patterns (口癖, regex — one per line)</span>
      </div>
      <textarea
        className="key-input tic-patterns-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={"不由得\n/仿佛.{0,6}(?:看|听|觉)/\n# lines starting with # are comments"}
        spellCheck={false}
        autoComplete="off"
        rows={4}
      />
      <div className="tic-patterns-foot">
        <span className="key-row-meta">
          <span className="mono">OPENOVEL_NARRATOR_TIC_PATTERNS</span>
          {errors.length > 0 && (
            <span className="tic-patterns-error"> · invalid regex on line {errors.map((e) => e.line).join(", ")}</span>
          )}
        </span>
        <button
          type="button"
          className="key-save"
          onClick={() => onSave(providerId, draft)}
          disabled={!dirty}
        >save</button>
      </div>
    </div>
  )
}

function KeyRow({ k, drafts, setDrafts, showing, setShowing, onSave }) {
  const draft = drafts[k.id] ?? ""
  const reveal = !!showing[k.id]
  const onChange = (e) => setDrafts((d) => ({ ...d, [k.id]: e.target.value }))
  const toggleReveal = () => setShowing((s) => ({ ...s, [k.id]: !s[k.id] }))
  const placeholder = k.set
    ? `currently ${k.masked}${k.sourcedFrom === "env" ? " (from env)" : ""}`
    : "API key"
  return (
    <div className="key-row key-row-compact">
      <div className="key-row-input">
        <input
          type={reveal ? "text" : "password"}
          className="key-input"
          placeholder={placeholder}
          value={draft}
          onChange={onChange}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="key-eye" onClick={toggleReveal} title={reveal ? "hide" : "show"}>
          {reveal ? "hide" : "show"}
        </button>
        <button type="button" className="key-save" onClick={() => onSave(k.id)} disabled={draft === "" && !k.set}>
          {draft === "" && k.set ? "clear" : "save"}
        </button>
      </div>
    </div>
  )
}

// ── Custom provider editor (user-defined endpoints) ─────────────────────
// Inline editor shown below the pill row when a custom provider is selected,
// or when the "+" pill opens a blank one. entry === null is the "add new"
// form. Drafts are local; nothing persists until save, which writes the
// definition (and the key when it was touched) through the custom-provider IPC
// in one call. Saved entries appear as their own pill + a provider choice in
// Routing/Agents — that per-call assignment is the whole point.
function CustomProviderRow({ entry, onSaved, onDeleted, onCancel, setStatus }) {
  const { t } = useTranslation()
  const isNew = !entry
  const currentAlias = entry ? entry.id.slice("custom:".length) : ""
  const [draft, setDraft] = useState(() => ({
    name: entry?.name || "",
    alias: currentAlias,
    kind: entry?.kind || "openai-compatible",
    baseUrl: entry?.baseUrl || "",
    defaultModel: entry?.defaultModel || "",
    defaultBackgroundModel: entry?.defaultBackgroundModel || "",
    thinking: entry?.thinking || "hint",
    reasoningEffort: entry?.reasoningEffort || "",
  }))
  const [keyDraft, setKeyDraft] = useState(null)   // null = untouched, "" = clear
  const [revealKey, setRevealKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const aliasChanged = draft.alias.trim() !== currentAlias
  const dirty = isNew
    || keyDraft !== null
    || aliasChanged
    || draft.name !== (entry?.name || "")
    || draft.kind !== (entry?.kind || "openai-compatible")
    || draft.baseUrl !== (entry?.baseUrl || "")
    || draft.defaultModel !== (entry?.defaultModel || "")
    || draft.defaultBackgroundModel !== (entry?.defaultBackgroundModel || "")
    || draft.thinking !== (entry?.thinking || "hint")
    || draft.reasoningEffort !== (entry?.reasoningEffort || "")

  // Live preview of the id the alias produces (mirrors the store's slugify).
  const aliasSlug = draft.alias.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  const previewId = aliasSlug ? `custom:${aliasSlug}` : (entry?.id || "")

  const save = async () => {
    setBusy(true)
    try {
      const patch = { ...draft }
      delete patch.alias
      if (entry) patch.id = entry.id
      // Only send the alias when it's new or actually changed — sending the
      // unchanged alias on every save would be a no-op rename request.
      if (draft.alias.trim() && (isNew || aliasChanged)) patch.alias = draft.alias.trim()
      if (keyDraft !== null) patch.apiKey = keyDraft
      const res = await window.openovel.saveCustomProvider(patch)
      if (res?.ok === false) {
        setStatus(res.message || "save failed")
        return
      }
      setKeyDraft(null)
      await onSaved({ keyChanged: keyDraft !== null, providerId: res?.id || entry?.id || "", renamedFrom: res?.renamedFrom })
    } catch (e) {
      setStatus(`save failed: ${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!entry) return
    if (!confirmingDelete) { setConfirmingDelete(true); return }
    setBusy(true)
    try {
      await window.openovel.deleteCustomProvider(entry.id)
      await onDeleted(entry.id)
    } catch (e) {
      setStatus(`delete failed: ${e?.message || e}`)
    } finally {
      setBusy(false)
      setConfirmingDelete(false)
    }
  }

  const keyPlaceholder = entry?.set
    ? `currently ${entry.masked}${entry.sourcedFrom === "env" ? " (from env)" : ""}`
    : t("settings.apikeys.custom.apiKey")

  return (
    <div className="key-row custom-provider-row">
      <div className="key-row-head">
        <span className="key-row-label">
          {isNew ? t("settings.apikeys.custom.newTitle") : entry.name}
          {!isNew && <span className="key-row-state tone-dim"> · <span className="mono">{entry.id}</span></span>}
        </span>
        <span className="key-row-state tone-dim">
          {isNew ? "" : entry.set ? t("settings.apikeys.custom.keySet") : t("settings.apikeys.custom.keyNotSet")}
        </span>
      </div>
      <div className="model-fields-row">
        <div className="model-field">
          <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.name")}</span></div>
          <div className="model-field-input">
            <input
              type="text"
              className="key-input"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="my-proxy"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="model-field">
          <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.kind")}</span></div>
          <div className="model-field-input">
            <select
              className="key-input"
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
              disabled={busy}
            >
              <option value="openai-compatible">{t("settings.apikeys.custom.kindOpenai")}</option>
              <option value="anthropic">{t("settings.apikeys.custom.kindAnthropic")}</option>
            </select>
          </div>
        </div>
      </div>
      <div className="model-fields-row">
        <div className="model-field">
          <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.alias")}</span></div>
          <div className="model-field-input">
            <input
              type="text"
              className="key-input"
              value={draft.alias}
              onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value }))}
              placeholder={t("settings.apikeys.custom.aliasPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="key-row-meta">
            {previewId
              ? <span>{aliasChanged && !isNew ? t("settings.apikeys.custom.aliasRenameHint") + " " : ""}<span className="mono">{previewId}</span></span>
              : <span className="tone-dim">{t("settings.apikeys.custom.aliasHint")}</span>}
          </div>
        </div>
      </div>
      <div className="key-row-input">
        <input
          type="text"
          className="key-input"
          value={draft.baseUrl}
          onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
          placeholder={draft.kind === "anthropic" ? "https://your-anthropic-gateway.example.com" : "https://your-openai-compatible.example.com/v1"}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="model-fields-row">
        <div className="model-field">
          <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.smallModel")}</span></div>
          <div className="model-field-input">
            <input
              type="text"
              className="key-input"
              value={draft.defaultModel}
              onChange={(e) => setDraft((d) => ({ ...d, defaultModel: e.target.value }))}
              placeholder="(model id)"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="model-field">
          <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.largeModel")}</span></div>
          <div className="model-field-input">
            <input
              type="text"
              className="key-input"
              value={draft.defaultBackgroundModel}
              onChange={(e) => setDraft((d) => ({ ...d, defaultBackgroundModel: e.target.value }))}
              placeholder="(defaults to small)"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      </div>
      {/* Thinking switch — OpenAI-compatible only (Anthropic-format thinking is
          handled by that adapter). Emits { thinking: { type } } (+ effort). */}
      {draft.kind !== "anthropic" && (
        <div className="model-fields-row">
          <div className="model-field">
            <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.thinking")}</span></div>
            <div className="model-field-input">
              <select
                className="key-input"
                value={draft.thinking}
                onChange={(e) => setDraft((d) => ({ ...d, thinking: e.target.value }))}
                disabled={busy}
              >
                <option value="hint">{t("settings.apikeys.custom.thinkingHint")}</option>
                <option value="disabled">{t("settings.apikeys.custom.thinkingOff")}</option>
                <option value="enabled">{t("settings.apikeys.custom.thinkingOn")}</option>
                <option value="auto">{t("settings.apikeys.custom.thinkingAuto")}</option>
              </select>
            </div>
            <div className="key-row-meta tone-dim">{t("settings.apikeys.custom.thinkingHelp")}</div>
          </div>
          {(draft.thinking === "enabled" || draft.thinking === "hint") && (
            <div className="model-field">
              <div className="model-field-head"><span className="model-field-label">{t("settings.apikeys.custom.reasoningEffort")}</span></div>
              <div className="model-field-input">
                <select
                  className="key-input"
                  value={draft.reasoningEffort}
                  onChange={(e) => setDraft((d) => ({ ...d, reasoningEffort: e.target.value }))}
                  disabled={busy}
                >
                  <option value="">{t("settings.apikeys.custom.reasoningDefault")}</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="key-row-input">
        <input
          type={revealKey ? "text" : "password"}
          className="key-input"
          placeholder={keyPlaceholder}
          value={keyDraft ?? ""}
          onChange={(e) => setKeyDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="key-eye" onClick={() => setRevealKey((v) => !v)}>
          {revealKey ? t("settings.apikeys.hide") : t("settings.apikeys.show")}
        </button>
        <button type="button" className="key-save" onClick={save} disabled={busy || !dirty}>
          {busy ? "…" : t("settings.apikeys.custom.save")}
        </button>
      </div>
      <div className="key-row-meta">
        {!isNew && <span className="mono">{entry.keyEnv}</span>}
        <span className="settings-action-row">
          {isNew && onCancel && (
            <button type="button" className="settings-compact-button" onClick={onCancel} disabled={busy}>
              {t("settings.apikeys.custom.cancel")}
            </button>
          )}
          {!isNew && (
            <button type="button" className="settings-compact-button" onClick={remove} disabled={busy} onBlur={() => setConfirmingDelete(false)}>
              {confirmingDelete ? t("settings.apikeys.custom.confirmDelete") : t("settings.apikeys.custom.delete")}
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

// ── Model routing tab ───────────────────────────────────────────────────
const PROFILE_GROUPS = [
  {
    key: "base",
    label: "Base profiles",
    ids: ["small", "large", "foreground", "background"],
  },
  {
    key: "narrative",
    label: "Narrative calls",
    ids: ["narrator", "foreground-options", "signal"],
  },
  {
    key: "maintenance",
    label: "Maintenance calls",
    ids: ["storykeeper", "memory", "summary", "compaction", "webfetch"],
  },
  {
    key: "subagents",
    label: "Subagent classes",
    ids: ["subagent", "subagent-continuity", "subagent-research", "subagent-planner"],
  },
]

function useAdvancedConfig() {
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(null)
  const reload = useCallback(() => {
    setErr(null)
    return window.openovel.getAdvancedConfig()
      .then(setSnap)
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])
  return { snap, err, reload }
}

function RoutingTab({ embedded = false, groupKeys = null, showOverview = true, showCatalog = true } = {}) {
  const { t } = useTranslation()
  const { snap, err, reload } = useAdvancedConfig()
  const [catalogDraft, setCatalogDraft] = useState({ provider: "", model: "", label: "" })
  const [status, setStatus] = useState("")
  const [query, setQuery] = useState("")
  const [pendingRoute, setPendingRoute] = useState("")

  const saveRoute = async (profileId, route) => {
    setPendingRoute(profileId)
    setStatus(t("settings.routing.savingRoute"))
    try {
      await window.openovel.setModelProfileRoute(profileId, route)
      await reload()
      setStatus(t("settings.routing.savedRoute"))
      setTimeout(() => setStatus(""), 1800)
    } catch (e) {
      setStatus(t("settings.routing.saveFailed", { error: e?.message || e }))
    } finally {
      setPendingRoute("")
    }
  }

  const addCatalogModel = async () => {
    const provider = catalogDraft.provider || snap.providers?.[0]?.id || ""
    if (!provider || !catalogDraft.model.trim()) return
    setStatus(t("settings.routing.savingModel"))
    try {
      await window.openovel.setModelCatalogItem({ ...catalogDraft, provider })
      setCatalogDraft({ provider, model: "", label: "" })
      await reload()
      setStatus(t("settings.routing.savedModel"))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(t("settings.routing.saveFailed", { error: e?.message || e }))
    }
  }

  const removeCatalogModel = async (id) => {
    setStatus(t("settings.routing.removingModel"))
    try {
      await window.openovel.removeModelCatalogItem(id)
      await reload()
      setStatus(t("settings.routing.removedModel"))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(t("settings.routing.removeFailed", { error: e?.message || e }))
    }
  }

  if (err) return <div className="settings-error">{t("settings.routing.loadError", { error: err })}</div>
  if (!snap) return <div className="settings-loading">{t("settings.routing.loading")}</div>

  const providers = snap.providers || []
  const models = snap.modelCatalog || []
  const profiles = snap.modelProfiles || []
  const profilesById = new Map((snap.modelProfiles || []).map((profile) => [profile.id, profile]))
  const selectedGroups = Array.isArray(groupKeys) && groupKeys.length
    ? PROFILE_GROUPS.filter((group) => groupKeys.includes(group.key))
    : PROFILE_GROUPS
  const groupedIds = new Set(selectedGroups.flatMap((group) => group.ids))
  const remaining = profiles.filter((profile) => !PROFILE_GROUPS.some((group) => group.ids.includes(profile.id)))
  const customRouteCount = profiles.filter((profile) => profile.overridden).length
  const customModelCount = models.filter((model) => !model.builtin).length
  const normalizedQuery = query.trim().toLowerCase()

  return (
    <div className={`settings-control-page${embedded ? " is-embedded" : ""}`}>
      {!embedded && (
        <div className="settings-page-head">
          <div>
            <div className="settings-page-kicker">{t("settings.routing.kicker")}</div>
            <h2 className="settings-page-title">{t("settings.routing.title")}</h2>
            <p className="settings-page-copy">{t("settings.routing.description")}</p>
          </div>
          <div className="settings-state-pill">{t("settings.routing.applies")}</div>
        </div>
      )}

      {showOverview && (
        <div className="settings-overview-grid" aria-label={t("settings.routing.overview")}>
          <OverviewStat value={providers.length} label={t("settings.routing.providerCount")} />
          <OverviewStat value={customRouteCount} label={t("settings.routing.customRoutes")} />
          <OverviewStat value={customModelCount} label={t("settings.routing.customModels")} />
        </div>
      )}

      <div className="settings-toolbar">
        <input
          className="settings-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.routing.search")}
          spellCheck={false}
        />
        {status && <span className="settings-status-line">{status}</span>}
      </div>

      {showCatalog && (
        <ModelCatalogEditor
          providers={providers}
          models={models}
          draft={catalogDraft}
          setDraft={setCatalogDraft}
          onAdd={addCatalogModel}
          onRemove={removeCatalogModel}
        />
      )}

      {selectedGroups.map((group) => {
        const profiles = group.ids.map((id) => profilesById.get(id)).filter(Boolean)
          .filter((profile) => routeMatches(profile, normalizedQuery))
        if (!profiles.length) return null
        return (
          <section key={group.label} className="routing-section">
            <div className="settings-section-label">{t(`settings.routing.groups.${group.key}`)}</div>
            <div className="settings-row-list">
              {profiles.map((profile) => (
                <RouteRow
                  key={profile.id}
                  profile={profile}
                  providers={providers}
                  models={models}
                  pending={pendingRoute === profile.id}
                  onSave={saveRoute}
                  onReset={() => saveRoute(profile.id, null)}
                />
              ))}
            </div>
          </section>
        )
      })}

      {!groupKeys && remaining.filter((profile) => routeMatches(profile, normalizedQuery)).length > 0 && (
        <section className="routing-section">
          <div className="settings-section-label">{t("settings.routing.groups.other")}</div>
          <div className="settings-row-list">
            {remaining.filter((profile) => routeMatches(profile, normalizedQuery)).map((profile) => (
              <RouteRow
                key={profile.id}
                profile={profile}
                providers={providers}
                models={models}
                pending={pendingRoute === profile.id}
                onSave={saveRoute}
                onReset={() => saveRoute(profile.id, null)}
              />
            ))}
          </div>
        </section>
      )}
      {groupKeys && profiles.filter((profile) => groupedIds.has(profile.id)).filter((profile) => routeMatches(profile, normalizedQuery)).length === 0 && (
        <div className="settings-hint">{t("settings.routing.noMatches")}</div>
      )}
    </div>
  )
}

function OverviewStat({ value, label }) {
  return (
    <div className="settings-overview-stat">
      <div className="settings-overview-value">{value}</div>
      <div className="settings-overview-label">{label}</div>
    </div>
  )
}

function ModelCatalogEditor({ providers, models, draft, setDraft, onAdd, onRemove }) {
  const { t } = useTranslation()
  const userModels = models.filter((model) => !model.builtin)
  return (
    <details className="settings-expander">
      <summary>
        <span className="settings-summary-main">
          <span className="settings-summary-title">{t("settings.routing.catalogTitle")}</span>
          <span className="settings-summary-sub">{t("settings.routing.catalogDescription", { builtin: models.length - userModels.length })}</span>
        </span>
        <span className="settings-summary-count">{t("settings.routing.catalogCount", { count: userModels.length })}</span>
      </summary>
      <div className="model-catalog-add">
        <label>
          <span>{t("settings.routing.provider")}</span>
          <select
            className="key-input"
            value={draft.provider || providers[0]?.id || ""}
            onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}
          >
            <option value="">{t("settings.routing.chooseProvider")}</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
          </select>
        </label>
        <label>
          <span>{t("settings.routing.model")}</span>
          <input
            className="key-input"
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            placeholder={t("settings.routing.modelPlaceholder")}
            spellCheck={false}
          />
        </label>
        <label>
          <span>{t("settings.routing.label")}</span>
          <input
            className="key-input"
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            placeholder={t("settings.routing.labelPlaceholder")}
            spellCheck={false}
          />
        </label>
        <button className="settings-compact-button is-primary" type="button" onClick={onAdd} disabled={!draft.model.trim()}>
          {t("settings.routing.addModel")}
        </button>
      </div>
      <div className="model-catalog-list">
        {userModels.map((model) => (
          <span key={model.id} className="model-chip">
            <span className="model-chip-provider">{model.provider}</span>
            <span className="model-chip-name">{model.label || model.model}</span>
            <button type="button" onClick={() => onRemove(model.id)} aria-label={t("settings.routing.removeModel", { model: model.model })}>×</button>
          </span>
        ))}
        {userModels.length === 0 && <span className="settings-hint">{t("settings.routing.noCustomModels")}</span>}
      </div>
    </details>
  )
}

function RouteRow({ profile, providers, models, pending, onSave, onReset }) {
  const { t } = useTranslation()
  const value = routeControlValue(profile)
  const effective = routeValue(profile)
  const activeProvider = value.provider || effective.provider || providers[0]?.id || ""
  const providerModels = models.filter((model) => model.provider === activeProvider)
  const hasCurrentModelOption = !value.model || providerModels.some((model) => model.model === value.model)
  const providerLabel = providerName(providers, effective.provider) || t("settings.routing.providerDefault")
  const modelLabel = effective.model || t("settings.routing.providerDefault")
  const channel = value.role || profile.role || "foreground"
  const paramChips = routeParamChips(effective)

  const commit = (patch) => {
    const next = { ...value, ...patch }
    const baseRole = profile.role || "foreground"
    if (patch.provider !== undefined && next.model) {
      const available = models.some((model) => model.provider === (next.provider || activeProvider) && model.model === next.model)
      if (!available) next.model = ""
    }
    const route = routeHasCustomValue(next, baseRole) ? next : null
    onSave(profile.id, route)
  }

  return (
    <details className={`agent-profile route-profile${profile.overridden ? " is-custom" : ""}`}>
      <summary>
        <div className="agent-summary-main">
          <div className="agent-config-title">
            <span>{profile.id}</span>
            {profile.overridden && <span className="routing-badge">{t("settings.routing.custom")}</span>}
          </div>
          <div className="routing-row-purpose">{profile.purpose || profile.costTier}</div>
        </div>
        <div className="agent-summary-meta route-summary-meta">
          <span>{providerLabel}</span>
          <span>{modelLabel}</span>
          {paramChips.length > 0
            ? paramChips.map((chip) => <span key={chip}>{chip}</span>)
            : <span>{t("settings.routing.defaultParameters")}</span>}
        </div>
        <button
          type="button"
          className="settings-compact-button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReset() }}
          disabled={!profile.overridden || pending}
        >
          {pending ? t("settings.routing.saving") : t("settings.routing.reset")}
        </button>
      </summary>

      <div className="agent-profile-body route-profile-body">
        <div className="agent-model-grid route-model-grid">
          <label>
            <span>{t("settings.routing.provider")}</span>
            <select
              className="key-input"
              value={value.provider || ""}
              onChange={(e) => commit({ provider: e.target.value })}
              disabled={pending}
            >
              <option value="">{t("settings.routing.useDefaultProvider", { provider: providerName(providers, profile.provider?.id || "") })}</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("settings.routing.model")}</span>
            <select
              className="key-input"
              value={value.model || ""}
              onChange={(e) => commit({ model: e.target.value })}
              disabled={pending}
            >
              <option value="">{t("settings.routing.useProviderDefault", { model: profile.model || t("settings.routing.providerDefault") })}</option>
              {!hasCurrentModelOption && <option value={value.model}>{value.model}</option>}
              {providerModels.map((model) => <option key={model.id} value={model.model}>{model.label || model.model}</option>)}
            </select>
          </label>
        </div>

        <details className="settings-nested-expander route-advanced-panel">
          <summary>
            <span className="settings-summary-main">
              <span className="settings-summary-title">{t("settings.routing.advancedParameters")}</span>
              <span className="settings-summary-sub">{t("settings.routing.advancedParametersHint")}</span>
            </span>
            <span className="settings-summary-count">{routeChannelLabel(t, channel)}</span>
          </summary>
          <div className="routing-advanced-grid">
            <label>
              <span>{t("settings.routing.role")}</span>
              <select
                className="key-input"
                value={value.role || profile.role || "foreground"}
                onChange={(e) => commit({ role: e.target.value })}
                disabled={pending}
              >
                <option value="foreground">{t("settings.routing.foreground")}</option>
                <option value="background">{t("settings.routing.background")}</option>
              </select>
            </label>
            <label>
              <span>{t("settings.routing.temperature")}</span>
              <input
                className="key-input"
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={value.temperature ?? ""}
                onChange={(e) => commit({ temperature: numericOrEmpty(e.target.value) })}
                placeholder={routeDefaultLabel(profile.temperature, t("settings.routing.defaultValue"))}
                disabled={pending}
              />
            </label>
            <label>
              <span>{t("settings.routing.maxTokens")}</span>
              <input
                className="key-input"
                type="number"
                min="1"
                value={value.maxTokens ?? ""}
                onChange={(e) => commit({ maxTokens: numericOrEmpty(e.target.value) })}
                placeholder={routeDefaultLabel(profile.maxTokens, t("settings.routing.defaultValue"))}
                disabled={pending}
              />
            </label>
            <label>
              <span>{t("settings.routing.timeoutMs")}</span>
              <input
                className="key-input"
                type="number"
                min="1"
                value={value.timeoutMs ?? ""}
                onChange={(e) => commit({ timeoutMs: numericOrEmpty(e.target.value) })}
                placeholder={routeDefaultLabel(profile.timeoutMs, t("settings.routing.defaultValue"))}
                disabled={pending}
              />
            </label>
            <label>
              <span>{t("settings.routing.chunkTimeoutMs")}</span>
              <input
                className="key-input"
                type="number"
                min="1"
                value={value.chunkTimeoutMs ?? ""}
                onChange={(e) => commit({ chunkTimeoutMs: numericOrEmpty(e.target.value) })}
                placeholder={routeDefaultLabel(profile.chunkTimeoutMs, t("settings.routing.defaultValue"))}
                disabled={pending}
              />
            </label>
          </div>
        </details>
      </div>
    </details>
  )
}

function routeValue(profile) {
  const route = profile.route || {}
  return {
    provider: route.provider || profile.provider?.id || "",
    model: route.model || profile.model || "",
    role: route.role || profile.role || "foreground",
    temperature: route.temperature ?? profile.temperature,
    maxTokens: route.maxTokens ?? profile.maxTokens,
    timeoutMs: route.timeoutMs ?? profile.timeoutMs,
    chunkTimeoutMs: route.chunkTimeoutMs ?? profile.chunkTimeoutMs,
  }
}

function routeControlValue(profile) {
  const route = profile.route || {}
  return {
    provider: route.provider || "",
    model: route.model || "",
    role: route.role || profile.role || "foreground",
    temperature: route.temperature ?? "",
    maxTokens: route.maxTokens ?? "",
    timeoutMs: route.timeoutMs ?? "",
    chunkTimeoutMs: route.chunkTimeoutMs ?? "",
  }
}

function routeMatches(profile, query) {
  if (!query) return true
  const route = routeValue(profile)
  return [
    profile.id,
    profile.purpose,
    profile.costTier,
    profile.role,
    route.provider,
    route.model,
    route.temperature,
    route.maxTokens,
    route.timeoutMs,
    route.chunkTimeoutMs,
  ].filter(Boolean).some((text) => String(text).toLowerCase().includes(query))
}

function providerName(providers, id) {
  if (!id) return ""
  return providers.find((provider) => provider.id === id)?.name || id
}

function numericOrEmpty(value) {
  if (value === "") return ""
  const n = Number(value)
  return Number.isFinite(n) ? n : ""
}

function routeDefaultLabel(value, fallback = "default") {
  return value === undefined || value === null || value === "" ? fallback : String(value)
}

function routeHasCustomValue(route, baseRole) {
  return Boolean(route.provider)
    || Boolean(route.model)
    || (route.role || baseRole) !== baseRole
    || ["temperature", "maxTokens", "timeoutMs", "chunkTimeoutMs"].some((key) => route[key] !== undefined && route[key] !== "")
}

function routeParamChips(route) {
  const chips = []
  if (route.temperature !== undefined && route.temperature !== "") chips.push(`temp ${route.temperature}`)
  if (route.maxTokens !== undefined && route.maxTokens !== "") chips.push(`${route.maxTokens} tokens`)
  if (route.timeoutMs !== undefined && route.timeoutMs !== "") chips.push(`${route.timeoutMs}ms timeout`)
  if (route.chunkTimeoutMs !== undefined && route.chunkTimeoutMs !== "") chips.push(`${route.chunkTimeoutMs}ms chunk`)
  return chips
}

function routeChannelLabel(t, role) {
  return role === "background" ? t("settings.routing.background") : t("settings.routing.foreground")
}

// ── Agents tab ──────────────────────────────────────────────────────────
function AgentsTab({ embedded = false } = {}) {
  const { t } = useTranslation()
  const { snap, err, reload } = useAdvancedConfig()
  const [drafts, setDrafts] = useState({})
  const [status, setStatus] = useState("")
  const [busyAgent, setBusyAgent] = useState("")

  const commitAgent = async (agent, value) => {
    setDrafts((d) => ({ ...d, [agent.id]: value }))
    setBusyAgent(agent.id)
    setStatus(t("settings.agents.saving", { agent: agent.id }))
    try {
      await window.openovel.setAgentOverride(agent.id, value)
      setDrafts((d) => { const next = { ...d }; delete next[agent.id]; return next })
      await reload()
      setStatus(t("settings.agents.saved"))
      setTimeout(() => setStatus(""), 2000)
    } catch (e) {
      setStatus(t("settings.agents.saveFailed", { error: e?.message || e }))
    } finally {
      setBusyAgent("")
    }
  }

  const resetAgent = async (agent) => {
    setBusyAgent(agent.id)
    setStatus(t("settings.agents.resetting", { agent: agent.id }))
    try {
      await window.openovel.setAgentOverride(agent.id, null)
      setDrafts((d) => { const next = { ...d }; delete next[agent.id]; return next })
      await reload()
      setStatus(t("settings.agents.reset"))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(t("settings.agents.resetFailed", { error: e?.message || e }))
    } finally {
      setBusyAgent("")
    }
  }

  if (err) return <div className="settings-error">{t("settings.agents.loadError", { error: err })}</div>
  if (!snap) return <div className="settings-loading">{t("settings.agents.loading")}</div>

  const agents = snap.agents || []
  const customAgents = agents.filter((agent) => agent.override).length

  return (
    <div className={`settings-control-page${embedded ? " is-embedded" : ""}`}>
      {!embedded && (
        <div className="settings-page-head">
          <div>
            <div className="settings-page-kicker">{t("settings.agents.kicker")}</div>
            <h2 className="settings-page-title">{t("settings.agents.title")}</h2>
            <p className="settings-page-copy">{t("settings.agents.description")}</p>
          </div>
          <div className="settings-state-pill">{t("settings.agents.applies")}</div>
        </div>
      )}

      <div className="settings-overview-grid" aria-label={t("settings.agents.overview")}>
        <OverviewStat value={agents.length} label={t("settings.agents.agentCount")} />
        <OverviewStat value={customAgents} label={t("settings.agents.customAgents")} />
        <OverviewStat value={(snap.tools || []).length} label={t("settings.agents.toolCount")} />
      </div>

      {status && <div className="settings-status-line settings-status-block">{status}</div>}

      <div className="agent-config-list">
        {agents.map((agent) => (
          <AgentConfigRow
            key={agent.id}
            agent={agent}
            value={drafts[agent.id] || agentValue(agent)}
            busy={busyAgent === agent.id}
            providers={snap.providers || []}
            models={snap.modelCatalog || []}
            tools={snap.tools || []}
            onCommit={(value) => commitAgent(agent, value)}
            onReset={() => resetAgent(agent)}
          />
        ))}
      </div>
    </div>
  )
}

function AgentConfigRow({ agent, value, busy, providers, models, tools, onCommit, onReset }) {
  const { t } = useTranslation()
  const activeProvider = value.model.provider || agent.model?.provider || providers[0]?.id || ""
  const providerModels = models.filter((model) => model.provider === activeProvider)
  const hasCurrentModelOption = !value.model.model || providerModels.some((model) => model.model === value.model.model)
  const selectedTools = new Set(value.tools || [])
  const modelSummary = [providerName(providers, value.model.provider), value.model.model].filter(Boolean).join(" · ")
  const budgetSummary = t("settings.agents.budgetSummary", {
    steps: value.maxSteps,
    tokens: value.maxTokens,
  })
  const commitPatch = (patch) => onCommit({ ...value, ...patch })
  const commitModelPatch = (patch) => {
    const nextModel = { ...value.model, ...patch }
    if (patch.provider !== undefined && nextModel.model) {
      const available = models.some((model) => model.provider === nextModel.provider && model.model === nextModel.model)
      if (!available) nextModel.model = ""
    }
    commitPatch({ model: nextModel })
  }
  const toggleTool = (toolId) => {
    const next = new Set(selectedTools)
    if (next.has(toolId)) next.delete(toolId)
    else next.add(toolId)
    commitPatch({ tools: [...next] })
  }

  return (
    <details className={`agent-profile${agent.override ? " is-custom" : ""}`}>
      <summary>
        <div className="agent-summary-main">
          <div className="agent-config-title">
            <span>{agent.id}</span>
            {agent.override && <span className="routing-badge">{t("settings.agents.custom")}</span>}
          </div>
          <div className="routing-row-purpose">{agent.kind} · {agent.domain} · {agent.enabledWhen}</div>
        </div>
        <div className="agent-summary-meta">
          <span>{modelSummary || t("settings.agents.defaultModel")}</span>
          <span>{t("settings.agents.toolsSelected", { selected: selectedTools.size, total: tools.length })}</span>
          <span>{budgetSummary}</span>
        </div>
        <button
          type="button"
          className="settings-compact-button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReset() }}
          disabled={!agent.override || busy}
        >
          {busy ? t("settings.agents.savingShort") : t("settings.agents.resetAction")}
        </button>
      </summary>

      <div className="agent-profile-body">
        <div className="agent-model-grid">
          <label>
            <span>{t("settings.routing.provider")}</span>
            <select
              className="key-input"
              value={value.model.provider || ""}
              onChange={(e) => commitModelPatch({ provider: e.target.value })}
              disabled={busy}
            >
              <option value="">{t("settings.agents.defaultProvider")}</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>)}
            </select>
          </label>
          <label>
            <span>{t("settings.routing.model")}</span>
            <select
              className="key-input"
              value={value.model.model || ""}
              onChange={(e) => commitModelPatch({ model: e.target.value })}
              disabled={busy}
            >
              <option value="">{t("settings.routing.providerDefault")}</option>
              {!hasCurrentModelOption && <option value={value.model.model}>{value.model.model}</option>}
              {providerModels.map((model) => <option key={model.id} value={model.model}>{model.label || model.model}</option>)}
            </select>
          </label>
        </div>
        <details className="settings-nested-expander agent-advanced-panel">
          <summary>
            <span className="settings-summary-main">
              <span className="settings-summary-title">{t("settings.agents.advancedModel")}</span>
              <span className="settings-summary-sub">{t("settings.agents.advancedModelHint")}</span>
            </span>
            <span className="settings-summary-count">{routeChannelLabel(t, value.model.role || "background")}</span>
          </summary>
          <div className="agent-advanced-grid">
            <label>
              <span>{t("settings.routing.role")}</span>
              <select
                className="key-input"
                value={value.model.role || "background"}
                onChange={(e) => commitModelPatch({ role: e.target.value })}
                disabled={busy}
              >
                <option value="background">{t("settings.routing.background")}</option>
                <option value="foreground">{t("settings.routing.foreground")}</option>
              </select>
            </label>
          </div>
        </details>
        <div className="agent-budget-grid">
          <label>
            <span>{t("settings.agents.maxSteps")}</span>
            <input className="key-input" type="number" min="1" value={value.maxSteps} onChange={(e) => commitPatch({ maxSteps: Number(e.target.value) })} disabled={busy} />
          </label>
          <label>
            <span>{t("settings.agents.maxTokens")}</span>
            <input className="key-input" type="number" min="256" value={value.maxTokens} onChange={(e) => commitPatch({ maxTokens: Number(e.target.value) })} disabled={busy} />
          </label>
          <label>
            <span>{t("settings.agents.temperature")}</span>
            <input className="key-input" type="number" min="0" max="2" step="0.05" value={value.temperature} onChange={(e) => commitPatch({ temperature: Number(e.target.value) })} disabled={busy} />
          </label>
          <label>
            <span>{t("settings.agents.toolConcurrency")}</span>
            <input className="key-input" type="number" min="1" value={value.toolConcurrency} onChange={(e) => commitPatch({ toolConcurrency: Number(e.target.value) })} disabled={busy} />
          </label>
        </div>
        <div className="agent-tool-head">
          <span>{t("settings.agents.toolAccess")}</span>
          <span>{t("settings.agents.toolsSelected", { selected: selectedTools.size, total: tools.length })}</span>
        </div>
        <div className="agent-tool-grid">
          {tools.map((tool) => (
            <label key={tool.id} className="agent-tool-toggle" title={tool.description}>
              <input type="checkbox" checked={selectedTools.has(tool.id)} onChange={() => toggleTool(tool.id)} disabled={busy} />
              <span>{tool.id}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  )
}

function agentValue(agent) {
  const override = agent.override || {}
  return {
    model: {
      provider: override.model?.provider ?? agent.model?.provider ?? "",
      model: override.model?.model ?? agent.model?.model ?? "",
      role: override.model?.role ?? agent.model?.role ?? "background",
    },
    tools: override.tools || agent.tools || [],
    maxSteps: override.maxSteps ?? agent.maxSteps ?? 30,
    maxTokens: override.maxTokens ?? agent.maxTokens ?? 10000,
    temperature: override.temperature ?? agent.temperature ?? 0.35,
    toolConcurrency: override.toolConcurrency ?? agent.toolConcurrency ?? 4,
  }
}

const IMAGE_PROVIDER_UI = [
  { id: "volcengine", label: "Volcengine", sub: "Ark · Seedream" },
  { id: "openrouter", label: "OpenRouter", sub: "chat completions" },
  { id: "custom", label: "Custom", sub: "OpenAI Images" },
]

// "+ add" pill that expands into a one-field name form. Shared by the Image
// and TTS provider rows: creating an entry is just naming it — its endpoint
// fields are edited in place once it's the active pill.
function AddCustomEndpointPill({ onCreate }) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onCreate(trimmed)
      setAdding(false)
      setName("")
    } finally {
      setBusy(false)
    }
  }
  if (!adding) {
    // Bare "+" pill, matching the Text (models) tab's add affordance so the
    // three provider rows read the same way.
    const addLabel = t("settings.customEndpoint.add", { defaultValue: "+ Custom endpoint" })
    return (
      <button
        type="button"
        className="key-mode key-mode-add"
        onClick={() => setAdding(true)}
        title={addLabel}
        aria-label={addLabel}
      >
        <span className="key-mode-label">+</span>
      </button>
    )
  }
  return (
    <span className="key-mode key-mode-add-form">
      <input
        type="text"
        className="key-input"
        placeholder={t("settings.customEndpoint.namePlaceholder", { defaultValue: "endpoint name" })}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create()
          if (e.key === "Escape") { setAdding(false); setName("") }
        }}
        spellCheck={false}
      />
      <button type="button" className="key-save" onClick={create} disabled={!name.trim() || busy}>
        {t("settings.customEndpoint.create", { defaultValue: "add" })}
      </button>
    </span>
  )
}

// ── Image tab (provider-backed generation endpoint) ──────────────────────
function ImageTab() {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState("")
  const [testResult, setTestResult] = useState(null)
  const [err, setErr] = useState(null)

  const reload = useCallback(() => {
    setErr(null)
    return window.openovel.getImageSettings()
      .then((s) => { setSnap(s); setDrafts({}) })
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  const saveField = useCallback(async (key, value) => {
    setStatus(t("common.saving", { defaultValue: "saving…" }))
    setTestResult(null)
    try {
      await window.openovel.setImageSettings({ [key]: value })
      await reload()
      setStatus(t("common.saved", { defaultValue: "saved" }))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(`save failed: ${e?.message || e}`)
    }
  }, [reload, t])

  const runTest = useCallback(async () => {
    if (snap?.configured) {
      const confirmed = window.confirm(t("settings.image.costConfirm", {
        defaultValue: "Run a real image generation test now? Your provider may charge for this request.",
      }))
      if (!confirmed) return
    }
    setTestResult("testing")
    try {
      setTestResult(await window.openovel.testImageGeneration())
      await reload()
    } catch (e) {
      setTestResult({ ok: false, error: e?.message || String(e) })
    }
  }, [reload, snap?.configured, t])

  if (err) return <div className="settings-error">{err}</div>
  if (!snap) return <div className="settings-loading">{t("common.loading", { defaultValue: "loading…" })}</div>

  const cfg = snap.config
  const providerId = cfg.provider || "custom"
  const providerInfo = (snap.providers || []).find((p) => p.id === providerId) || {}
  const apiKeyEnv = providerId === "volcengine"
    ? "OPENOVEL_IMAGE_API_KEY / ARK_API_KEY"
    : providerId === "openrouter"
      ? "OPENOVEL_IMAGE_API_KEY / OPENROUTER_API_KEY"
      : "OPENOVEL_IMAGE_API_KEY"
  const draft = (key, fallback = "") => (drafts[key] !== undefined ? drafts[key] : fallback)
  const setDraft = (key, value) => setDrafts((d) => ({ ...d, [key]: value }))
  const row = ({ key, label, envKey, placeholder = "", secret = false }) => {
    const saved = secret ? "" : (cfg[key] || "")
    const dirty = drafts[key] !== undefined
    const hasSecret = Boolean(secret && cfg[key]?.set)
    const inputValue = draft(key, saved)
    return (
      <div className="key-row">
        <div className="key-row-head">
          <span className="key-row-label">{label}</span>
          {secret && <span className="key-row-state tone-dim">{hasSecret ? "set" : "not set"}</span>}
        </div>
        <div className="key-row-input">
          <input
            type={secret && !showKey ? "password" : "text"}
            className="key-input"
            placeholder={secret && hasSecret ? cfg[key].masked : placeholder}
            value={inputValue}
            onChange={(e) => setDraft(key, e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {secret
            ? <button type="button" className="key-eye" onClick={() => setShowKey((v) => !v)}>{showKey ? "hide" : "show"}</button>
            : <span />}
          <button
            type="button"
            className="key-save"
            onClick={() => saveField(key, inputValue)}
            disabled={!dirty && !hasSecret}
          >
            {!dirty && hasSecret ? "clear" : "save"}
          </button>
        </div>
        <div className="key-row-meta"><span className="mono">{envKey}</span></div>
      </div>
    )
  }

  return (
    <div className="settings-section-group">
      <div className="settings-section-intro">
        {t("settings.image.intro", { defaultValue: "Choose an image generation provider for the Image agent. The agent can still fetch web images without this; generation is enabled only when provider, API key, and model are ready." })}
      </div>

      <div className="key-mode-row image-provider-modes">
        {IMAGE_PROVIDER_UI.map((provider) => {
          const active = provider.id === providerId
          // Built-in presets share one image-config slot, so "configured" means
          // the active preset has base URL + key + model. Custom entries below
          // carry their own keySet flag. Either way the dot marks "ready".
          const isConfigured = active && snap.configured
          return (
            <button
              key={provider.id}
              type="button"
              className={`key-mode${active ? " is-active" : ""}${isConfigured ? " is-configured" : ""}`}
              onClick={() => saveField("provider", provider.id)}
              title={isConfigured ? "configured" : undefined}
            >
              <span className="key-mode-label">
                {provider.label}
                {isConfigured && <span className="key-mode-dot" aria-label="configured" />}
              </span>
              <span className="key-mode-sub">{provider.sub}</span>
            </button>
          )
        })}
        {/* User-defined endpoints: one pill each, same field rows below edit
            the active entry (the store keeps its bag in lockstep), so no
            separate editor form is needed — only add/delete management. */}
        {(snap.customProviders || []).map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`key-mode${entry.id === providerId ? " is-active" : ""}${entry.keySet ? " is-configured" : ""}`}
            onClick={() => saveField("provider", entry.id)}
            title={entry.id}
          >
            <span className="key-mode-label">
              {entry.name}
              {entry.keySet && <span className="key-mode-dot" aria-label="key configured" />}
            </span>
            <span className="key-mode-sub">OpenAI Images</span>
          </button>
        ))}
        <AddCustomEndpointPill
          onCreate={async (name) => {
            const result = await window.openovel.setImageSettings({ upsertCustomProvider: { name } })
            const created = (result?.snapshot?.customProviders || []).find((e) => e.name === name)
              || (result?.snapshot?.customProviders || []).slice(-1)[0]
            if (created) await saveField("provider", created.id)
            else await reload()
          }}
        />
      </div>
      {String(providerId).startsWith("custom:") && (
        <div className="settings-action-row">
          <span className="settings-hint tone-dim mono">{providerId}</span>
          <button
            type="button"
            className="settings-button settings-button-danger"
            onClick={async () => {
              if (!window.confirm(t("settings.customEndpoint.deleteConfirm", { defaultValue: "Delete this endpoint and its saved key?" }))) return
              await window.openovel.setImageSettings({ deleteCustomProvider: providerId })
              await reload()
            }}
          >
            {t("settings.customEndpoint.delete", { defaultValue: "Delete endpoint" })}
          </button>
        </div>
      )}

      {row({
        key: "baseUrl",
        label: t("settings.image.baseUrl", { defaultValue: "Base URL" }),
        envKey: "OPENOVEL_IMAGE_BASE_URL",
        placeholder: providerInfo.defaultBaseUrl || "https://image-provider.example.com/v1",
      })}
      {row({
        key: "apiKey",
        label: t("settings.image.apiKey", { defaultValue: "API key" }),
        envKey: apiKeyEnv,
        placeholder: "API key",
        secret: true,
      })}
      {row({
        key: "model",
        label: t("settings.image.model", { defaultValue: "Model" }),
        envKey: "OPENOVEL_IMAGE_MODEL",
        placeholder: providerInfo.defaultModel || "image-model-name",
      })}
      <div className="image-settings-mini-grid">
        {row({
          key: "path",
          label: t("settings.image.path", { defaultValue: "Generation path" }),
          envKey: "OPENOVEL_IMAGE_PATH",
          placeholder: providerInfo.defaultPath || "/images/generations",
        })}
        {row({
          key: "size",
          label: t("settings.image.size", { defaultValue: "Default size" }),
          envKey: "OPENOVEL_IMAGE_SIZE",
          placeholder: providerInfo.defaultSize || "1024x1024",
        })}
      </div>

      <div className="settings-action-row">
        <button
          type="button"
          className="settings-button"
          onClick={runTest}
          disabled={testResult === "testing"}
        >
          {testResult === "testing"
            ? t("settings.image.testing", { defaultValue: "testing…" })
            : t("settings.image.test", { defaultValue: "Test generation" })}
        </button>
        <span className={`settings-hint ${snap.configured ? "tone-ok" : "tone-dim"}`}>
          {snap.configured
            ? t("settings.image.configured", { defaultValue: "generation configured" })
            : t("settings.image.notConfigured", { defaultValue: "base URL + API key + model required" })}
        </span>
        {status && <span className="settings-hint">{status}</span>}
      </div>
      <div className="settings-warning">
        {t("settings.image.costWarning", {
          defaultValue: "Testing sends a real image generation request and may consume paid provider credits.",
        })}
      </div>

      {testResult && (
        <div className={`llm-test-banner${
          testResult === "testing" ? " is-testing"
          : testResult.ok ? " is-ok"
          : " is-error"
        }`}>
          {testResult === "testing" ? (
            <span className="llm-test-banner-head">
              <span className="llm-test-spinner" aria-hidden="true" />
              <span>{t("settings.image.testing", { defaultValue: "testing…" })}</span>
            </span>
          ) : testResult.ok ? (
            <>
              <span className="llm-test-banner-head">
                <span className="llm-test-mark" aria-hidden="true">✓</span>
                <span className="llm-test-label">{t("settings.image.testOk", { defaultValue: "Image generation works" })}</span>
                <span className="llm-test-latency">{testResult.latencyMs}ms</span>
              </span>
              <span className="llm-test-meta">
                <span className="mono">{testResult.provider}/{testResult.model}</span> · {testResult.kind} · {testResult.bytes} bytes · {testResult.size}
              </span>
              {testResult.dataUrl && (
                <figure className="image-test-preview">
                  <img src={testResult.dataUrl} alt={t("settings.image.previewAlt", { defaultValue: "Generated image test preview" })} />
                </figure>
              )}
            </>
          ) : (
            <>
              <span className="llm-test-banner-head">
                <span className="llm-test-mark" aria-hidden="true">✗</span>
                <span className="llm-test-label">{t("settings.image.testFailed", { defaultValue: "Image generation failed" })}</span>
              </span>
              <span className="llm-test-meta">{testResult.error}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Behavior tab ─────────────────────────────────────────────────────────
// ── Music tab (NetEase 个人接入 + 扫码登录 + the demo paste-token fast path) ──
// Credentials + token live in main (musicAuthStore); the renderer only ever
// sees a redacted snapshot and drives the QR poll. Enable the Music agent under
// Behavior; this tab just signs the provider in.
function MusicTab() {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState("")
  const [clientId, setClientId] = useState("")
  const [secret, setSecret] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [device, setDevice] = useState("")
  const [token, setToken] = useState("")
  const [qr, setQr] = useState(null)
  const [qrStatus, setQrStatus] = useState("")
  const [testResult, setTestResult] = useState(null) // null | "testing" | { ok, ... }
  const pollRef = useRef(null)

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  const reload = useCallback(() => {
    setErr(null)
    return window.openovel.getMusicAuth()
      .then((s) => { setSnap(s); setClientId(s.clientId || ""); setBaseUrl(s.baseUrl || ""); setDevice(s.device || "") })
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload(); return stopPoll }, [reload])

  const runTest = async () => {
    setTestResult("testing")
    try { setTestResult(await window.openovel.testMusicConnection()) }
    catch (e) { setTestResult({ ok: false, error: e?.message || String(e) }) }
  }

  const flash = (msg) => { setStatus(msg); setTimeout(() => setStatus(""), 1600) }

  const saveConfig = async () => {
    setStatus(t("common.saving", { defaultValue: "Saving…" }))
    try { await window.openovel.setMusicConfig({ clientId, clientSecret: secret, baseUrl, device }); setSecret(""); await reload(); flash(t("common.saved", { defaultValue: "Saved" })) }
    catch (e) { setStatus(`${t("settings.music.saveFailed", { defaultValue: "Couldn't save" })}: ${e?.message || e}`) }
  }
  const saveToken = async () => {
    if (!token.trim()) return
    setStatus(t("common.saving", { defaultValue: "Saving…" }))
    try { await window.openovel.setMusicToken(token.trim()); setToken(""); await reload(); flash(t("settings.music.signedIn", { defaultValue: "Signed in" })) }
    catch (e) { setStatus(`${t("settings.music.saveFailed", { defaultValue: "Couldn't save" })}: ${e?.message || e}`) }
  }
  const logout = async () => { stopPoll(); setQr(null); setQrStatus(""); await window.openovel.musicLogout(); await reload() }

  const startQr = async () => {
    stopPoll()
    setQr(null)
    setQrStatus(t("settings.music.qr.loading", { defaultValue: "Loading…" }))
    try {
      const res = await window.openovel.musicQrStart()
      if (!res.ok) { setQrStatus(res.message || t("settings.music.qr.failed", { defaultValue: "Couldn't start" })); return }
      setQr(res); setQrStatus(t("settings.music.qr.scan", { defaultValue: "Scan this with the NetEase Cloud Music app" }))
      pollRef.current = setInterval(async () => {
        let p
        try { p = await window.openovel.musicQrPoll(res.key) } catch { return }
        if (p.status === "authorized") { stopPoll(); setQr(null); setQrStatus(t("settings.music.signedIn", { defaultValue: "Signed in" })); await reload() }
        else if (p.status === "scanned") setQrStatus(t("settings.music.qr.confirm", { defaultValue: "Confirm on your phone" }))
        else if (p.status === "expired") { stopPoll(); setQr(null); setQrStatus(t("settings.music.qr.expired", { defaultValue: "The code expired — try again" })) }
        else if (p.status === "error") { stopPoll(); setQr(null); setQrStatus(p.message || t("settings.music.qr.failed", { defaultValue: "Couldn't start" })) }
      }, 2500)
    } catch (e) { setQrStatus(e?.message || String(e)) }
  }

  if (err) return <div className="settings-error">{err}</div>
  if (!snap) return <div className="settings-loading">{t("common.loading", { defaultValue: "loading…" })}</div>

  return (
    <div className="settings-section-group">
      <div className="settings-hint">
        {t("settings.music.intro", { defaultValue: "Connect NetEase Cloud Music so your story can play music that fits each scene. You'll need a developer app from NetEase — enter its details below and sign in, then turn on background music under Behavior." })}
      </div>

      <label className="settings-field-label">{t("settings.music.appId", { defaultValue: "App ID" })}</label>
      <input className="key-input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t("settings.music.appIdPlaceholder", { defaultValue: "From your NetEase app" })} />
      <label className="settings-field-label">
        {t("settings.music.appSecret", { defaultValue: "App secret" })}
        {snap.clientSecretSet ? ` · ${t("settings.music.saved", { defaultValue: "saved" })}` : ""}
      </label>
      <input className="key-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={snap.clientSecretSet ? t("settings.music.leaveBlank", { defaultValue: "Leave blank to keep the saved one" }) : ""} />
      <label className="settings-field-label">{t("settings.music.server", { defaultValue: "Server address (optional)" })}</label>
      <input className="key-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openapi.music.163.com" />
      <label className="settings-field-label">{t("settings.music.device", { defaultValue: "Device info (advanced)" })}</label>
      <textarea className="key-input" rows={3} value={device} onChange={(e) => setDevice(e.target.value)} placeholder="" />
      <div className="settings-hint">
        {t("settings.music.deviceHint", { defaultValue: "Most setups can leave this empty — fill it only if your NetEase app needs specific device details." })}
      </div>
      <div className="settings-action-row">
        <button className="settings-button" onClick={saveConfig}>{t("settings.music.save", { defaultValue: "Save" })}</button>
        {status && <span className="settings-hint">{status}</span>}
      </div>

      <div className="settings-field-label">
        {snap.authorized
          ? t("settings.music.signedIn", { defaultValue: "Signed in" })
          : t("settings.music.notSignedIn", { defaultValue: "Not signed in yet" })}
      </div>
      <div className="settings-action-row">
        <button className="settings-button" onClick={startQr} disabled={!snap.clientId}>{t("settings.music.scanToSignIn", { defaultValue: "扫码登录" })}</button>
        {snap.authorized && <button className="settings-button" onClick={logout}>{t("settings.music.signOut", { defaultValue: "Sign out" })}</button>}
        {qrStatus && <span className="settings-hint">{qrStatus}</span>}
      </div>
      {qr && (qr.qrImg
        ? <img className="music-qr" src={qr.qrImg} alt="" />
        : qr.qrUrl ? <a className="settings-hint" href={qr.qrUrl} target="_blank" rel="noreferrer">{qr.qrUrl}</a> : null)}

      <label className="settings-field-label">{t("settings.music.accessToken", { defaultValue: "Access token" })}</label>
      <input className="key-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("settings.music.accessTokenPlaceholder", { defaultValue: "Paste your access token to sign in" })} />
      <div className="settings-action-row">
        <button className="settings-button" onClick={saveToken} disabled={!token.trim()}>{t("settings.music.signIn", { defaultValue: "Sign in" })}</button>
      </div>

      <div className="settings-action-row">
        <button className="settings-button" onClick={runTest} disabled={testResult === "testing" || !snap.clientId}>
          {testResult === "testing"
            ? t("settings.music.testing", { defaultValue: "Testing…" })
            : t("settings.music.test", { defaultValue: "Test connection" })}
        </button>
      </div>
      {testResult && testResult !== "testing" && (
        <div className={`llm-test-banner ${testResult.ok ? "is-ok" : "is-error"}`}>
          <span className="llm-test-banner-head">
            <span className="llm-test-mark" aria-hidden="true">{testResult.ok ? "✓" : "✗"}</span>
            <span className="llm-test-label">
              {testResult.ok ? musicTestMessage(t, testResult) : t("settings.music.notConnected", { defaultValue: "Couldn't connect" })}
            </span>
          </span>
          {!testResult.ok && testResult.error && <span className="llm-test-meta">{testResult.error}</span>}
        </div>
      )}
    </div>
  )
}

const STORY_BEHAVIOR_GROUPS = [
  {
    id: "engine",
    titleKey: "settings.behavior.groups.engine.title",
    descriptionKey: "settings.behavior.groups.engine.description",
    toggleIds: ["residentTeam"],
  },
  {
    id: "storyStart",
    titleKey: "settings.behavior.groups.storyStart.title",
    descriptionKey: "settings.behavior.groups.storyStart.description",
    extra: "initDepth",
    toggleIds: ["initNarratorPreview"],
  },
  {
    id: "interaction",
    titleKey: "settings.behavior.groups.interaction.title",
    descriptionKey: "settings.behavior.groups.interaction.description",
    toggleIds: ["optionsEnabled", "fastMode"],
  },
  {
    id: "diagnostics",
    titleKey: "settings.behavior.groups.diagnostics.title",
    descriptionKey: "settings.behavior.groups.diagnostics.description",
    toggleIds: ["disableBackground", "disableStorykeeper", "disableMemoryReview", "disableContextInserts", "recordCalls"],
  },
]

const PRESENTATION_BEHAVIOR_GROUPS = [
  {
    id: "richStory",
    titleKey: "settings.behavior.groups.richStory.title",
    descriptionKey: "settings.behavior.groups.richStory.description",
    toggleIds: ["formatContract", "storyIncludes"],
  },
  {
    id: "storyMedia",
    titleKey: "settings.behavior.groups.storyMedia.title",
    descriptionKey: "settings.behavior.groups.storyMedia.description",
    toggleIds: ["imageGen", "imageBackground", "characterSheets", "comicMode"],
  },
]

function BehaviorTab() {
  return <BehaviorTogglesPanel groups={STORY_BEHAVIOR_GROUPS} />
}

function BehaviorTogglesPanel({ groups }) {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [err, setErr]   = useState(null)
  const [status, setStatus] = useState("")
  const reload = useCallback(() => {
    setErr(null)
    window.openovel.getBehavior()
      .then(setSnap)
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  const toggle = async (id, current) => {
    setStatus(t("common.saving", { defaultValue: "saving…" }))
    try {
      await window.openovel.setBehavior({ [id]: !current })
      setStatus(t("common.saved", { defaultValue: "saved" }))
      await reload()
      setTimeout(() => setStatus(""), 1500)
    } catch (e) { setStatus(`save failed: ${e?.message || e}`) }
  }

  if (err)   return <div className="settings-error">{t("settings.behavior.loadError", { error: err })}</div>
  if (!snap) return <div className="settings-loading">{t("settings.behavior.loading", { defaultValue: "loading…" })}</div>

  const togglesById = new Map((snap.toggles || []).map((toggleSpec) => [toggleSpec.id, toggleSpec]))
  const renderToggle = (toggleSpec) => {
    const labelKey = `settings.behavior.toggles.${toggleSpec.id}.label`
    const descKey = `settings.behavior.toggles.${toggleSpec.id}.description`
    const appliesKey = toggleSpec.affects === "next-session"
      ? "settings.behavior.applies.nextSession"
      : "settings.behavior.applies.nextTurn"
    return (
      <label key={toggleSpec.id} className="behavior-row">
        <input
          type="checkbox"
          className="behavior-check"
          checked={toggleSpec.value}
          onChange={() => toggle(toggleSpec.id, toggleSpec.value)}
        />
        <span className="behavior-body">
          <span className="behavior-label">{t(labelKey, { defaultValue: toggleSpec.label })}</span>
          <span className="behavior-desc">{t(descKey, { defaultValue: toggleSpec.description })}</span>
          <span className="behavior-meta">
            <span className={`tone-${toggleSpec.affects === "next-session" ? "warn" : "dim"}`}>
              {t(appliesKey)}
            </span>
            {toggleSpec.sourcedFrom !== "default" && (
              <span className="dim"> · {t("settings.behavior.sourcedFrom", { source: toggleSpec.sourcedFrom })}</span>
            )}
          </span>
        </span>
      </label>
    )
  }

  return (
    <div className="settings-section-group behavior-settings-groups">
      {groups.map((group) => {
        const toggleItems = (group.toggleIds || [])
          .map((id) => togglesById.get(id))
          .filter(Boolean)
        const hasExtra = group.extra === "initDepth"
        if (!hasExtra && toggleItems.length === 0) return null
        return (
          <section key={group.id} className="behavior-setting-group">
            <div className="settings-section-label">{t(group.titleKey)}</div>
            {group.descriptionKey && <p className="settings-section-intro">{t(group.descriptionKey)}</p>}
            <div className="settings-section-group behavior-list">
              {hasExtra && <InitDepthControl />}
              {toggleItems.map(renderToggle)}
            </div>
          </section>
        )
      })}
      {status && <div className="settings-action-row"><span className="settings-hint">{status}</span></div>}
    </div>
  )
}

// ── TTS tab (豆包 / Volcano streaming text-to-speech) ────────────────────
// Enable streaming narration audio, the Volcano credential (App ID + Access
// Token + Cluster), the voice_type, and playback speed. Credentials/config are
// stored by ttsStore.js and mirrored to env; audio plays via useTtsKaraoke.
function TtsTab() {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [status, setStatus] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [err, setErr] = useState(null)

  const reload = useCallback(() => {
    setErr(null)
    window.openovel.getTts()
      .then((s) => { setSnap(s); setDrafts({}) })
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  const save = useCallback(async (patch) => {
    setStatus(t("common.saving", { defaultValue: "saving…" }))
    try {
      await window.openovel.setTts(patch)
      await reload()
      setStatus(t("common.saved", { defaultValue: "saved" }))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) { setStatus(`save failed: ${e?.message || e}`) }
  }, [reload, t])

  if (err)   return <div className="settings-error">{err}</div>
  if (!snap) return <div className="settings-loading">{t("settings.tts.loading", { defaultValue: "loading…" })}</div>

  const cfg = snap.config
  const draft = (k, fallback) => (drafts[k] !== undefined ? drafts[k] : fallback)
  const setDraft = (k, v) => setDrafts((d) => ({ ...d, [k]: v }))
  const credRow = (key, label, envKey, { secret = false, placeholder = "" } = {}) => {
    const fileVal = secret ? "" : (cfg[key] || "")
    const dirty = drafts[key] !== undefined
    return (
      <div className="key-row">
        <div className="key-row-head">
          <span className="key-row-label">{label}</span>
          {secret && <span className="key-row-state tone-dim">{cfg[key]?.set ? "set" : "not set"}</span>}
        </div>
        <div className="key-row-input">
          <input
            type={secret && !showToken ? "password" : "text"}
            className="key-input"
            placeholder={secret && cfg[key]?.set ? cfg[key].masked : placeholder}
            value={draft(key, fileVal)}
            onChange={(e) => setDraft(key, e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {secret
            ? <button type="button" className="key-save" onClick={() => setShowToken((v) => !v)}>{showToken ? "hide" : "show"}</button>
            : <span />}
          <button
            type="button"
            className="key-save"
            onClick={() => save({ [key]: drafts[key] ?? "" })}
            disabled={!dirty}
          >save</button>
        </div>
        <div className="key-row-meta"><span className="mono">{envKey}</span></div>
      </div>
    )
  }

  return (
    <div className="settings-section-group">
      <label className="behavior-row">
        <input type="checkbox" className="behavior-check" checked={cfg.enabled} onChange={() => save({ enabled: !cfg.enabled })} />
        <span className="behavior-body">
          <span className="behavior-label">{t("settings.tts.enable.label", { defaultValue: "朗读叙事（豆包 / 火山引擎）" })}</span>
          <span className="behavior-desc">{t("settings.tts.enable.description", { defaultValue: "开启后，生成剧情时按句子合成语音，边生成边朗读；文字随朗读逐句同步显示。" })}</span>
          <span className="behavior-meta"><span className="tone-dim">{t("settings.behavior.applies.nextTurn", { defaultValue: "applies next turn" })}</span></span>
        </span>
      </label>

      {/* Provider pills: the built-in Volcano protocol plus any user-defined
          OpenAI-compatible /audio/speech endpoints. Per-provider config
          persists across switches (ttsStore keeps each entry's own fields). */}
      <div className="key-mode-row image-provider-modes">
        <button
          type="button"
          className={`key-mode${cfg.provider === "volcano" ? " is-active" : ""}${cfg.accessToken?.set ? " is-configured" : ""}`}
          onClick={() => save({ provider: "volcano" })}
        >
          <span className="key-mode-label">
            {t("settings.tts.providerVolcano", { defaultValue: "Volcano (Doubao)" })}
            {cfg.accessToken?.set && <span className="key-mode-dot" aria-label="configured" />}
          </span>
          <span className="key-mode-sub">ws_binary</span>
        </button>
        {(snap.customProviders || []).map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`key-mode${cfg.provider === entry.id ? " is-active" : ""}${entry.keySet ? " is-configured" : ""}`}
            onClick={() => save({ provider: entry.id })}
            title={entry.id}
          >
            <span className="key-mode-label">
              {entry.name}
              {entry.keySet && <span className="key-mode-dot" aria-label="key configured" />}
            </span>
            <span className="key-mode-sub">OpenAI speech</span>
          </button>
        ))}
        <AddCustomEndpointPill
          onCreate={async (name) => {
            const result = await window.openovel.setTts({ upsertCustomProvider: { name } })
            const created = (result?.snapshot?.customProviders || []).find((e) => e.name === name)
              || (result?.snapshot?.customProviders || []).slice(-1)[0]
            if (created) await save({ provider: created.id })
            else await reload()
          }}
        />
      </div>

      {cfg.provider === "volcano" ? (
        <>
          <div className="setting-group">
            <div className="setting-label">{t("settings.tts.credentials", { defaultValue: "火山引擎凭据" })}</div>
            {credRow("appId", "App ID", "VOLCANO_APP_ID", { placeholder: "App ID" })}
            {credRow("accessToken", "Access Token", "VOLCANO_ACCESS_TOKEN", { secret: true, placeholder: "Access Token" })}
            {credRow("cluster", "Cluster", "VOLCANO_CLUSTER", { placeholder: "volcano_tts" })}
          </div>

          <div className="setting-group">
            <div className="setting-label">{t("settings.tts.voice", { defaultValue: "音色 voice_type" })}</div>
            <div className="key-row-input">
              <input
                type="text"
                className="key-input"
                list="tts-voice-list"
                placeholder="zh_female_cancan_mars_bigtts"
                value={draft("voiceType", cfg.voiceType || "")}
                onChange={(e) => setDraft("voiceType", e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <span />
              <button type="button" className="key-save" onClick={() => save({ voiceType: drafts.voiceType ?? "" })} disabled={drafts.voiceType === undefined}>save</button>
              <datalist id="tts-voice-list">
                {(snap.voices || []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </datalist>
            </div>
            <div className="behavior-desc">{t("settings.tts.voiceHint", { defaultValue: "填写你火山控制台开通的 voice_type（大模型音色通常以 _bigtts 结尾）。" })}</div>
          </div>
        </>
      ) : (
        <TtsCustomEntryEditor
          entry={(snap.customProviders || []).find((e) => e.id === cfg.provider)}
          save={save}
          onDelete={async (id) => {
            if (!window.confirm(t("settings.customEndpoint.deleteConfirm", { defaultValue: "Delete this endpoint and its saved key?" }))) return
            await save({ deleteCustomProvider: id })
          }}
        />
      )}

      <div className="setting-group">
        <div className="setting-label">{t("settings.tts.speed", { defaultValue: "语速" })} · {Number(draft("speed", cfg.speed)).toFixed(2)}×</div>
        <input
          type="range" min="0.5" max="2" step="0.05"
          value={draft("speed", cfg.speed)}
          onChange={(e) => setDraft("speed", Number(e.target.value))}
          onMouseUp={(e) => save({ speed: Number(e.target.value) })}
          onKeyUp={(e) => save({ speed: Number(e.target.value) })}
        />
      </div>

      {status && <div className="settings-action-row"><span className="settings-hint">{status}</span></div>}
    </div>
  )
}

// Field editor for one OpenAI-compatible TTS endpoint. Each save sends a full
// upsertCustomProvider patch built from the snapshot entry + the edited field
// (the store keeps a saved key when apiKey comes back empty, so the redacted
// form can't lose it).
function TtsCustomEntryEditor({ entry, save, onDelete }) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState({})
  const [showKey, setShowKey] = useState(false)
  useEffect(() => { setDrafts({}) }, [entry?.id])
  if (!entry) return null
  const draft = (k, fallback) => (drafts[k] !== undefined ? drafts[k] : fallback)
  const setDraft = (k, v) => setDrafts((d) => ({ ...d, [k]: v }))
  const saveField = async (key) => {
    const base = { id: entry.id, name: entry.name, baseUrl: entry.baseUrl, model: entry.model, voice: entry.voice, sampleRate: entry.sampleRate }
    await save({ upsertCustomProvider: { ...base, [key]: drafts[key] ?? "" } })
    setDrafts((d) => { const next = { ...d }; delete next[key]; return next })
  }
  const row = (key, label, envKey, { secret = false, placeholder = "" } = {}) => {
    const saved = secret ? "" : String(entry[key] ?? "")
    const dirty = drafts[key] !== undefined
    return (
      <div className="key-row">
        <div className="key-row-head">
          <span className="key-row-label">{label}</span>
          {secret && <span className="key-row-state tone-dim">{entry.keySet ? "set" : "not set"}</span>}
        </div>
        <div className="key-row-input">
          <input
            type={secret && !showKey ? "password" : "text"}
            className="key-input"
            placeholder={secret && entry.keySet ? entry.maskedKey : placeholder}
            value={draft(key, saved)}
            onChange={(e) => setDraft(key, e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {secret
            ? <button type="button" className="key-save" onClick={() => setShowKey((v) => !v)}>{showKey ? "hide" : "show"}</button>
            : <span />}
          <button type="button" className="key-save" onClick={() => saveField(key)} disabled={!dirty}>save</button>
        </div>
        <div className="key-row-meta"><span className="mono">{envKey}</span></div>
      </div>
    )
  }
  return (
    <div className="setting-group">
      <div className="setting-label">
        {t("settings.tts.customEndpoint", { defaultValue: "OpenAI-compatible speech endpoint" })}
        <span className="dim mono"> · {entry.id}</span>
      </div>
      {row("baseUrl", t("settings.tts.customBaseUrl", { defaultValue: "Base URL" }), "OPENOVEL_TTS_BASE_URL", { placeholder: "https://tts.example.com/v1" })}
      {row("apiKey", "API key", "OPENOVEL_TTS_API_KEY", { secret: true, placeholder: "API key (optional for local servers)" })}
      {row("model", t("settings.tts.customModel", { defaultValue: "Model" }), "OPENOVEL_TTS_MODEL", { placeholder: "tts-1" })}
      {row("voice", t("settings.tts.customVoice", { defaultValue: "Voice" }), "OPENOVEL_TTS_VOICE_TYPE", { placeholder: "alloy (leave empty for single-voice servers)" })}
      {row("sampleRate", t("settings.tts.customSampleRate", { defaultValue: "PCM sample rate" }), "OPENOVEL_TTS_SAMPLE_RATE", { placeholder: "24000" })}
      <div className="behavior-desc">
        {t("settings.tts.customHint", { defaultValue: "POST {baseUrl}/audio/speech with response_format=pcm, one sentence per request. Sentence-synced reading keeps working." })}
      </div>
      <div className="settings-action-row">
        <button type="button" className="settings-button settings-button-danger" onClick={() => onDelete(entry.id)}>
          {t("settings.customEndpoint.delete", { defaultValue: "Delete endpoint" })}
        </button>
      </div>
    </div>
  )
}

// Initialization depth selector — read-write radio group at the top of
// the Behavior tab. "Unset" is a legitimate fourth state that re-arms
// the per-new-story Modal.
function InitDepthControl() {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [pending, setPending] = useState(null)
  const reload = useCallback(() => {
    window.openovel.getInitDepth().then(setSnap).catch(() => setSnap({ value: null, sourcedFrom: "unset" }))
  }, [])
  useEffect(() => { reload() }, [reload])

  const choose = async (value) => {
    setPending(value)
    try {
      await window.openovel.setInitDepth(value)
      await reload()
    } finally {
      setTimeout(() => setPending(null), 600)
    }
  }

  if (!snap) return null
  const choices = [
    { id: null, labelKey: "initDepth.unsetLabel" },
    { id: "zero", labelKey: "initDepth.zero.title" },
    { id: "standard", labelKey: "initDepth.standard.title" },
    { id: "deep", labelKey: "initDepth.deep.title" },
  ]
  return (
    <div className="behavior-row init-depth-row">
      <span className="behavior-body">
        <span className="behavior-label">{t("initDepth.settingLabel")}</span>
        <span className="behavior-desc">{t("initDepth.settingHint")}</span>
        <div className="init-depth-radio-row">
          {choices.map((c) => {
            const active = snap.value === c.id
            return (
              <button
                key={c.id ?? "__unset"}
                type="button"
                className={`init-depth-radio${active ? " is-active" : ""}${pending === c.id ? " is-pending" : ""}`}
                onClick={() => choose(c.id)}
              >
                {t(c.labelKey)}
              </button>
            )
          })}
        </div>
        {snap.sourcedFrom && snap.sourcedFrom !== "unset" && (
          <span className="behavior-meta">
            <span className="dim">{t("settings.behavior.sourcedFrom", { source: snap.sourcedFrom })}</span>
          </span>
        )}
      </span>
    </div>
  )
}

// ── Environment tab ──────────────────────────────────────────────────────
function EnvironmentTab() {
  const [snap, setSnap]     = useState(null)
  const [drafts, setDrafts] = useState({})
  const [status, setStatus] = useState("")
  const [err, setErr]       = useState(null)

  const reload = useCallback(() => {
    setErr(null)
    window.openovel.getEnvironment()
      .then((s) => { setSnap(s); setDrafts({ home: s.home, proxyUrl: s.proxyUrl, noProxy: s.noProxy }) })
      .catch((e) => setErr(e?.message || String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  const setField = (key, value) => setDrafts((d) => ({ ...d, [key]: value }))

  const saveAll = async () => {
    setStatus("saving…")
    try {
      const patch = {}
      // Only send fields the user actually edited (preserve sourcedFrom info).
      if (drafts.home     !== snap.home)     patch.home     = drafts.home
      if (drafts.proxyUrl !== snap.proxyUrl) patch.proxyUrl = drafts.proxyUrl
      if (drafts.noProxy  !== snap.noProxy)  patch.noProxy  = drafts.noProxy
      if (Object.keys(patch).length === 0) {
        setStatus("nothing changed")
        setTimeout(() => setStatus(""), 1500)
        return
      }
      const result = await window.openovel.setEnvironment(patch)
      const needsRestart = (result.changes || []).some((c) => c.appliesNextRestart)
      setStatus(needsRestart
        ? "saved · restart Electron for the home change to take effect"
        : "saved · applied immediately")
      await reload()
      setTimeout(() => setStatus(""), 3000)
    } catch (e) {
      setStatus(`save failed: ${e?.message || e}`)
    }
  }

  if (err)   return <div className="settings-error">Failed to load environment: {err}</div>
  if (!snap) return <div className="settings-loading">loading…</div>

  return (
    <div className="settings-section-group">
      <div className="settings-section-intro">
        Workspace directory and outbound HTTP proxy. Values persist to{" "}
        <span className="mono">{snap.filePath}</span>.
      </div>

      <EnvField
        label="Home directory"
        hint={`Default: ${snap.homeDefault} · applies on next restart (currently using ${snap.sourcedFrom.home === "env" ? "env override" : snap.sourcedFrom.home})`}
        envKey="OPENOVEL_HOME"
        value={drafts.home || ""}
        placeholder={snap.homeDefault}
        onChange={(v) => setField("home", v)}
        mono
      />

      <EnvField
        label="Proxy URL"
        hint={`Maps to HTTPS_PROXY / HTTP_PROXY / ALL_PROXY · applies immediately (${snap.sourcedFrom.proxyUrl})`}
        envKey="HTTPS_PROXY"
        value={drafts.proxyUrl || ""}
        placeholder="http://127.0.0.1:7890"
        onChange={(v) => setField("proxyUrl", v)}
        mono
      />

      <EnvField
        label="Proxy bypass list"
        hint={`Hosts that should NOT go through the proxy, comma-separated · ${snap.sourcedFrom.noProxy}`}
        envKey="NO_PROXY"
        value={drafts.noProxy || ""}
        placeholder="localhost,127.0.0.1,*.local"
        onChange={(v) => setField("noProxy", v)}
        mono
      />

      <div className="settings-action-row">
        <button className="settings-button" type="button" onClick={saveAll}>Save changes</button>
        <button className="settings-button" type="button" onClick={reload}>Revert</button>
        {status && <span className="settings-hint">{status}</span>}
      </div>
    </div>
  )
}

function EnvField({ label, hint, envKey, value, placeholder, onChange, mono }) {
  return (
    <div className="env-field">
      <div className="env-field-head">
        <span className="env-field-label">{label}</span>
        <span className="env-field-envkey mono">{envKey}</span>
      </div>
      <input
        type="text"
        className={`key-input${mono ? " mono" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="env-field-hint">{hint}</div>
    </div>
  )
}

// ── Memory tab ────────────────────────────────────────────────────────────
function MemoryTab({ advanced = false }) {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState("")

  const reloadMemory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.openovel.getMemorySnapshot()
      if (!result?.ok) throw new Error(result?.error || "load failed")
      setSnap(result)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { reloadMemory() }, [reloadMemory])

  const resetTarget = useCallback(async (target) => {
    const label = t(`settings.memory.targets.${target}.label`, {
      defaultValue: target === "crossStory" ? "cross-story memory" : target,
    })
    const message = t("settings.memory.confirmReset", {
      target: label,
      defaultValue: `Reset ${label}? This cannot be undone.`,
    })
    if (!window.confirm(message)) return
    setStatus(t("settings.memory.resetting", { defaultValue: "resetting…" }))
    try {
      const result = await window.openovel.clearMemoryTarget(target)
      if (!result?.ok) throw new Error(result?.error || "reset failed")
      await reloadMemory()
      setStatus(t("settings.memory.resetDone", { defaultValue: "reset" }))
      setTimeout(() => setStatus(""), 1600)
    } catch (e) {
      setStatus(t("settings.memory.resetFailed", { error: e?.message || e, defaultValue: `reset failed: ${e?.message || e}` }))
    }
  }, [reloadMemory, t])

  return (
    <div className="settings-section-group">
      <CrossStoryMemoryControl onChanged={reloadMemory} />
      <PreferencesTab onResetMemory={reloadMemory} />
      <MemoryInspector
        advanced={advanced}
        snap={snap}
        loading={loading}
        error={error}
        status={status}
        onReset={resetTarget}
      />
    </div>
  )
}

function CrossStoryMemoryControl({ onChanged }) {
  const { t } = useTranslation()
  const [snap, setSnap] = useState(null)
  const [status, setStatus] = useState("")
  const reload = useCallback(() => {
    return window.openovel.getBehavior().then(setSnap).catch(() => setSnap(null))
  }, [])
  useEffect(() => { reload() }, [reload])

  const spec = snap?.toggles?.find((item) => item.id === "crossStoryMemory")
  const enabled = spec?.value !== false
  const toggle = async () => {
    if (!spec) return
    setStatus(t("common.saving", { defaultValue: "saving…" }))
    try {
      await window.openovel.setBehavior({ crossStoryMemory: !enabled })
      await reload()
      await onChanged?.()
      setStatus(t("common.saved", { defaultValue: "saved" }))
      setTimeout(() => setStatus(""), 1400)
    } catch (e) {
      setStatus(t("settings.memory.saveFailed", { error: e?.message || e, defaultValue: `save failed: ${e?.message || e}` }))
    }
  }

  return (
    <div className="memory-control-row">
      <label className="memory-toggle-main">
        <input type="checkbox" checked={enabled} onChange={toggle} disabled={!spec} />
        <span>
          <span className="setting-label">{t("settings.memory.crossStory.label", { defaultValue: "Cross-story memory" })}</span>
          <span className="memory-toggle-state">
            {enabled
              ? t("settings.memory.crossStory.on", { defaultValue: "on" })
              : t("settings.memory.crossStory.off", { defaultValue: "off" })}
          </span>
        </span>
      </label>
      <p className="setting-hint">
        {t("settings.memory.crossStory.description", {
          defaultValue: "When on, model-observed reader notes and shared references can carry across novels. Turn it off to keep model memory story-local.",
        })}
      </p>
      <div className="behavior-meta">
        <span className="tone-dim">{t("settings.behavior.applies.nextTurn")}</span>
        {status && <span className="dim"> · {status}</span>}
      </div>
    </div>
  )
}

function MemoryInspector({ advanced, snap, loading, error, status, onReset }) {
  const { t } = useTranslation()
  const targets = advanced
    ? ["story", "observed", "references"]
    : ["story", "observed"]
  const [active, setActive] = useState("story")
  useEffect(() => {
    if (!targets.includes(active)) setActive(targets[0])
  }, [active, targets])

  if (loading) return <div className="settings-loading">{t("settings.memory.loading", { defaultValue: "loading memory…" })}</div>
  if (error) return <div className="settings-error">{t("settings.memory.loadError", { error, defaultValue: `Failed to load memory: ${error}` })}</div>
  if (!snap?.targets) return null

  const item = snap.targets[active] || {}
  const crossStoryTarget = active === "observed" || active === "references"
  const crossStoryOff = crossStoryTarget && snap.crossStoryMemoryEnabled === false
  const resetTarget = crossStoryTarget && !advanced ? "crossStory" : active
  const content = String(item.content || "").trim()
  const empty = t(`settings.memory.targets.${active}.empty`, { defaultValue: "(empty)" })

  return (
    <div className="setting-group memory-inspector">
      <div className="pref-mode-row">
        <div>
          <div className="setting-label">{t("settings.memory.viewerTitle", { defaultValue: "Model memory" })}</div>
          <p className="setting-hint">
            {advanced
              ? t("settings.memory.viewerHintAdvanced", { defaultValue: "Inspect the memory files the model reads or maintains." })
              : t("settings.memory.viewerHintSimple", { defaultValue: "Current story memory is story-local; cross-story memory can be switched off above." })}
          </p>
        </div>
        <button
          type="button"
          className="settings-button settings-button-danger"
          onClick={() => onReset(resetTarget)}
        >
          {resetTarget === "crossStory"
            ? t("settings.memory.resetCrossStory", { defaultValue: "Reset cross-story" })
            : t("settings.memory.reset", { defaultValue: "Reset" })}
        </button>
      </div>

      <div className="memory-target-strip">
        {targets.map((id) => (
          <button
            type="button"
            key={id}
            className={`memory-target-btn${active === id ? " is-active" : ""}`}
            onClick={() => setActive(id)}
          >
            {t(`settings.memory.targets.${id}.label`, { defaultValue: id })}
          </button>
        ))}
      </div>

      {crossStoryOff && (
        <div className="memory-disabled-note">
          {t("settings.memory.crossStoryDisabled", {
            defaultValue: "Cross-story memory is off. Existing notes are visible here but are not injected into model context and will not be updated.",
          })}
        </div>
      )}

      <CodeView
        className="memory-viewer"
        value={content || empty}
        language="markdown"
        minHeight="180px"
        maxHeight={advanced ? "38vh" : "28vh"}
      />
      <div className="preferences-actions">
        <span className="preferences-path" title={item.path}>{item.path}</span>
        <span className={`preferences-status${status ? " is-visible" : ""}`}>{status}</span>
      </div>
    </div>
  )
}

// ── Preferences tab (~/.openovel/memory/USER.md) ──────────────────────────
// Surfaces the user-memory markdown that onboarding wrote (and that the
// runtime reads when shaping narrator behavior). Editing here is the
// "advanced" path — no validation, just an editor + Save. Markdown-rendered
// preview at the bottom shows what the narrator effectively sees.
function PreferencesTab({ onResetMemory } = {}) {
  const { t } = useTranslation()
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [original, setOriginal]   = useState("")
  const [draft, setDraft]         = useState("")
  const [filePath, setFilePath]   = useState("")
  const [exists, setExists]       = useState(false)
  const [status, setStatus]       = useState("")
  const [mode, setMode]           = useState("form")          // "form" | "markdown"
  const [tagGroups, setTagGroups] = useState([])
  const [formValue, setFormValue] = useState(null)
  // PreferenceForm holds its own selections in local useState; we remount
  // it ONLY when reload() refreshes from disk (e.g. the modal just opened
  // or the user clicked Refresh). Earlier we keyed on `original`, but
  // auto-save now bumps `original` on every keystroke — that caused the
  // form to remount mid-interaction and tag pills to visibly flicker off.
  const [mountKey, setMountKey] = useState(0)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [memRes, tagRes] = await Promise.all([
        window.openovel.getUserMemory(),
        window.openovel.getPreferenceTagGroups(i18n.language || "en"),
      ])
      if (!memRes.ok) throw new Error(memRes.error || "load failed")
      const groups = tagRes?.groups || []
      setTagGroups(groups)
      setOriginal(memRes.content || "")
      setDraft(memRes.content || "")
      setFilePath(memRes.path || "")
      setExists(Boolean(memRes.exists))
      setFormValue(parseUserMemoryIntoForm(memRes.content || "", groups))
      setMountKey((k) => k + 1)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { reload() }, [reload])

  const resetPreferences = useCallback(async () => {
    const message = t("settings.preferences.confirmReset", {
      defaultValue: "Reset reader preferences? This clears the global USER.md preferences and cannot be undone.",
    })
    if (!window.confirm(message)) return
    setStatus(t("settings.memory.resetting", { defaultValue: "resetting…" }))
    try {
      const r = await window.openovel.clearMemoryTarget("user")
      if (!r?.ok) throw new Error(r?.error || "reset failed")
      await reload()
      await onResetMemory?.()
      setStatus(t("settings.memory.resetDone", { defaultValue: "reset" }))
      setTimeout(() => setStatus(""), 1500)
    } catch (e) {
      setStatus(t("settings.memory.resetFailed", { error: e?.message || e, defaultValue: `reset failed: ${e?.message || e}` }))
    }
  }, [onResetMemory, reload, t])

  // Auto-save: debounce 500ms after the last draft change. Each pill
  // click / textarea keystroke runs ONE write at most. Replaces the
  // dangerous "Save / Revert / Done" combo where the user could close
  // the modal with unsaved changes. Status indicator at the bottom keeps
  // the save state visible.
  const dirty = draft !== original
  useEffect(() => {
    if (loading || !dirty) return
    let cancelled = false
    setStatus(t("settings.preferences.saving", { defaultValue: "saving…" }))
    const timer = setTimeout(async () => {
      try {
        const r = await window.openovel.setUserMemory(draft)
        if (cancelled) return
        if (!r.ok) throw new Error(r.error || "save failed")
        setOriginal(draft)
        setExists(true)
        setStatus(t("settings.preferences.saved", { defaultValue: "saved" }))
        setTimeout(() => { if (!cancelled) setStatus("") }, 1500)
      } catch (e) {
        if (!cancelled) setStatus(`save failed: ${e?.message || e}`)
      }
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [draft, dirty, loading, t])

  // Form-mode changes assemble the markdown body from structured input.
  // Existing markdown content NOT recognized by parseUserMemoryIntoForm
  // (e.g. user's hand-edited extra notes) gets preserved by merging on
  // save: we only rewrite the 3 canonical bullets and leave the rest.
  const onFormChange = useCallback((value) => {
    if (!value) return
    setFormValue(value)
    setDraft((current) => rebuildMarkdownFromForm(current, value, tagGroups))
    // Picking a Default story language also switches the UI locale —
    // same heuristic as OnboardingModal so the two surfaces agree. If
    // the user wants them diverged (rare), Display tab overrides.
    const uiLocale = normalizeUiLocale(value.language)
    if (uiLocale && i18n.language !== uiLocale) {
      i18n.changeLanguage(uiLocale)
      window.openovel.setPrefs({ locale: uiLocale }).catch(() => {})
    }
  }, [tagGroups])

  if (loading) return <div className="settings-loading">{t("settings.loading", { defaultValue: "loading preferences…" })}</div>
  if (error)   return <div className="settings-error">Failed to load: {error}</div>

  return (
    <div className="settings-section-group">
      <div className="setting-group">
        <div className="pref-mode-row">
          <div className="setting-label">{t("settings.preferences.label", { defaultValue: "User memory" })}</div>
          <div className="pref-mode-actions">
            <div className="pref-mode-toggle">
              <button
                type="button"
                className={`pref-mode-btn${mode === "form" ? " is-active" : ""}`}
                onClick={() => setMode("form")}
              >{t("settings.preferences.form", { defaultValue: "Form" })}</button>
              <button
                type="button"
                className={`pref-mode-btn${mode === "markdown" ? " is-active" : ""}`}
                onClick={() => setMode("markdown")}
              >{t("settings.preferences.markdown", { defaultValue: "Markdown" })}</button>
            </div>
            <button type="button" className="settings-button settings-button-danger" onClick={resetPreferences}>
              {t("settings.preferences.reset", { defaultValue: "Reset" })}
            </button>
          </div>
        </div>
        <p className="setting-hint">
          {mode === "form"
            ? "Your changes auto-save. Anything in the markdown outside the canonical fields is preserved."
            : "Direct markdown. Edits auto-save after ~half a second."}
          {!exists && " (Empty — the file will be created on the first edit.)"}
        </p>

        {mode === "form" ? (
          tagGroups.length ? (
            <PreferenceForm
              key={mountKey}
              initial={formValue || {}}
              groups={tagGroups}
              onChange={onFormChange}
            />
          ) : (
            <div className="settings-loading">loading tag groups…</div>
          )
        ) : (
          <CodeView
            className="preferences-editor"
            value={draft}
            onChange={setDraft}
            language="markdown"
            minHeight="320px"
            maxHeight="55vh"
          />
        )}

        <div className="preferences-actions">
          <span className="preferences-path" title={filePath}>{filePath}</span>
          <span className={`preferences-status${status ? " is-visible" : ""}`}>{status}</span>
        </div>
      </div>
    </div>
  )
}

// Rewrite the canonical bullet lines (language / prose-reference /
// style-preferences-per-group) from the form's structured value, while
// preserving any other bullets the user might have hand-written. Matches
// lines starting with `- Default story language` / `- Prose reference` /
// `- Style preferences` (with or without a `(GroupLabel)` suffix); also
// accepts legacy lines with the link-prefix form
// `- [Title](topics/x.md) — body`.
//
// rebuildMarkdownFromForm now lives in ../lib/PreferenceForm.jsx (shared with
// the per-story naming screen). Imported at the top of this file.
