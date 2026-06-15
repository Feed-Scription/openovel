import React, { useEffect, useMemo, useState } from "react"
import { useVmState } from "./hooks/useVmState.js"
import { useVmActions } from "./hooks/useVmActions.js"
import { usePrefs } from "./hooks/usePrefs.js"
import { colorThemeVars } from "./lib/colorThemes.js"
import { Header } from "./components/Header.jsx"
import { Transcript } from "./components/Transcript.jsx"
import { Hud } from "./components/Hud.jsx"
import { NowPlaying } from "./components/NowPlaying.jsx"
import { mergedHudPairsFromEntries, latestMusicCueFromEntries, latestBackgroundFromEntries } from "./lib/richBlockModel.js"
import { useBackdropToneProfile } from "./lib/imageTones.js"
import { Footer } from "./components/Footer.jsx"
import { SidePane } from "./components/SidePane.jsx"
import { StorySelector } from "./components/StorySelector.jsx"
import { StoryNaming } from "./components/StoryNaming.jsx"
import { OnboardingModal } from "./components/OnboardingModal.jsx"
import { ComposePane } from "./components/ComposePane.jsx"
import { InitChatPane } from "./components/InitChatPane.jsx"
import { SettingsModal } from "./components/SettingsModal.jsx"
import { PermissionsModal } from "./components/PermissionsModal.jsx"
import { TransactionsModal } from "./components/TransactionsModal.jsx"
import { ErrorLogModal } from "./components/ErrorLogModal.jsx"
import { BackgroundArt } from "./components/BackgroundArt.jsx"
import { SceneBackdrop } from "./components/SceneBackdrop.jsx"
import { HalftoneBand } from "./components/HalftoneCover.jsx"
import { FilePreview } from "./components/FilePreview.jsx"
import { useParagraphShare } from "./lib/useParagraphShare.jsx"
import { useTtsKaraoke } from "./lib/useTtsKaraoke.js"
import { useTranslation } from "react-i18next"

const FONT_FAMILIES = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
}

// Map an active LLM provider id to the key slot that must be filled. Returns
// null when no specific slot is required (e.g. nothing pinned → any LLM key
// works via the default fallback chain).
function requiredKeyForProvider(provider) {
  if (provider === "custom-openai") return "openai"
  if (provider === "kimi-code") return "kimi"
  if (provider === "anthropic" || provider === "custom-anthropic") return "anthropic"
  if (provider && provider.startsWith("mimo-token-plan")) return "mimo"
  return null
}

function computeConfigStatus(snap) {
  const llm = snap?.llm || {}
  const required = requiredKeyForProvider(llm.provider || "")
  if (required) {
    const key = (snap.keys || []).find((k) => k.id === required)
    if (!key?.set) return { ok: false, providerLabel: providerLabelFor(llm.provider), neededKeyId: required }
    return { ok: true }
  }
  // No provider pinned — require at least one LLM key set so the default chain has something to call.
  const anySet = (snap.keys || []).some((k) => k.category === "llm" && k.set)
  if (!anySet) return { ok: false, providerLabel: "", neededKeyId: null }
  return { ok: true }
}

function providerLabelFor(provider) {
  if (provider === "custom-openai") return "OpenAI-compatible"
  if (provider === "kimi-code") return "Kimi Code"
  if (provider === "anthropic") return "Anthropic (Claude)"
  if (provider === "custom-anthropic") return "Custom Anthropic"
  if (provider && provider.startsWith("mimo-token-plan")) return "MiMo Token Plan"
  return ""
}

// Friendly label that disambiguates custom-openai sub-presets by base URL.
// Used by the sidebar's "current models" line — the user wants to see
// "DeepSeek" not "OpenAI-compatible (custom-openai)".
function friendlyProviderLabel(provider, baseUrl) {
  if (provider === "kimi-code") return "Kimi Code"
  if (provider === "anthropic") return "Anthropic (Claude)"
  if (provider === "custom-anthropic") return "Custom Anthropic"
  if (provider && provider.startsWith("mimo-token-plan")) {
    const region = provider.split("-").pop()
    return `MiMo Token Plan (${region})`
  }
  if (provider === "mimo-api") return "MiMo Pay-as-you-go"
  if (provider === "custom-openai" || !provider) {
    const url = String(baseUrl || "").toLowerCase()
    if (url.includes("deepseek"))    return "DeepSeek"
    if (url.includes("moonshot"))    return "Kimi (Moonshot)"
    if (url.includes("xiaomimimo"))  return "MiMo"
    if (url.includes("openrouter"))  return "OpenRouter"
    if (url) return "Custom"
    return provider ? "OpenAI-compatible" : "Default chain"
  }
  return provider
}

function computeLlmInfo(snap) {
  const llm = snap?.llm || {}
  // Custom providers are exempt from the global AI_SMALL_MODEL/AI_LARGE_MODEL
  // pins (those only ever name a built-in provider's model), so llm.smallModel/
  // largeModel come back empty for them — which is why the side pane was showing
  // "(provider default)". Their models live on the custom entry itself; read
  // those, and use the entry's name as the label instead of the raw custom: id.
  const customEntry = (llm.provider || "").startsWith("custom:")
    ? (snap?.customProviders || []).find((c) => c.id === llm.provider)
    : null
  return {
    providerLabel: customEntry?.name || friendlyProviderLabel(llm.provider, llm.baseUrl),
    smallModel: (customEntry ? customEntry.defaultModel : llm.smallModel) || "",
    largeModel: (customEntry ? customEntry.defaultBackgroundModel : llm.largeModel) || "",
    // Present only when image generation is configured (see getApiKeysSnapshot).
    image: snap?.image || null,
  }
}

function ConfigBanner({ status, onClick }) {
  const detail = status.providerLabel
    ? `${status.providerLabel} API key not set.`
    : "No LLM API key configured."
  return (
    <button type="button" className="config-banner" onClick={onClick}>
      <span className="config-banner-text">
        {detail} <span className="config-banner-link">Open Settings →</span>
      </span>
    </button>
  )
}

const CONNECTION_ERROR_LABEL = {
  "missing-key": "no API key configured",
  "auth":        "API key rejected",
  "model":       "model not found at this endpoint",
  "rate":        "provider rate-limited or quota exhausted",
  "timeout":     "request timed out",
  "network":     "network unreachable",
  "unknown":     "unknown error",
}

function ConnectionErrorBanner({ lastError, onClick }) {
  const label = CONNECTION_ERROR_LABEL[lastError.kind] || CONNECTION_ERROR_LABEL.unknown
  return (
    <button type="button" className="config-banner config-banner-error" onClick={onClick}>
      <span className="config-banner-text">
        Connection failed — {label}. <span className="config-banner-link">Open Settings to check network / API key →</span>
      </span>
    </button>
  )
}

export function App() {
  const { t } = useTranslation()
  const state = useVmState()
  const actions = useVmActions()
  const [prefs, setPrefs] = usePrefs()
  // Narrator reveal speed (Settings → Display) lives in electron prefs but the
  // revealer is VM-side, so push it into the VM on initial load and on change.
  useEffect(() => {
    // `!= null` (not truthiness) so the unlimited sentinel (0) still dispatches.
    if (prefs?.narrationCpm != null) window.openovel.dispatch("setNarrationCpm", prefs.narrationCpm)
  }, [prefs?.narrationCpm])
  // Color-scheme preset (Settings → Display). Applied at the document root —
  // NOT via the .app inline styleVars — because html/body/#root paint
  // var(--paper) themselves and portaled popovers escape the .app subtree;
  // both must retint with the preset. A per-story format-contract theme still
  // overrides inside .app (inline vars beat inherited ones there).
  // Transient color-scheme PREVIEW: while the reader hovers a swatch in
  // Settings → Display, the whole app retints to that preset without saving.
  // null = no preview → the saved prefs.colorTheme rules. Cleared on leave /
  // select / settings close. Declared here (before the apply effect) so the
  // effect's effectiveColorTheme can read it without a TDZ.
  const [previewColorTheme, setPreviewColorTheme] = useState(null)
  // Hover preview wins over the saved theme while active.
  const effectiveColorTheme = previewColorTheme ?? prefs?.colorTheme
  useEffect(() => {
    const entries = Object.entries(colorThemeVars(effectiveColorTheme))
    const root = document.documentElement
    for (const [key, value] of entries) root.style.setProperty(key, value)
    return () => { for (const [key] of entries) root.style.removeProperty(key) }
  }, [effectiveColorTheme])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Default collapsed — keep the reading surface unobstructed; the activity
  // feed is one header-icon click away.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Currently-previewed file (relative path under story root), or null.
  const [previewFile, setPreviewFile] = useState(null)
  // Which command modal is open ("permissions" / "transactions", opened from
  // the Story menu), or null.
  const [commandModal, setCommandModal] = useState(null)
  // Error log modal toggle.
  const [errorLogOpen, setErrorLogOpen] = useState(false)
  // null = unknown / not yet checked; otherwise { ok: bool, reason?: ... }
  const [configStatus, setConfigStatus] = useState(null)
  // Currently-active LLM config: { providerLabel, smallModel, largeModel }
  // Surfaced in the side pane so the user can see what's actually running.
  const [llmInfo, setLlmInfo] = useState(null)

  // Re-evaluate the API key snapshot whenever the Settings modal closes (the
  // user may have just changed something) and on initial mount. We do NOT
  // auto-modify the pinned provider here — the user is the source of truth
  // for which provider they want active. Status / banners reflect that pin
  // honestly, even when it's empty or inconvenient.
  useEffect(() => {
    if (settingsOpen) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await window.openovel.getApiKeys()
        if (cancelled) return
        setConfigStatus(computeConfigStatus(snap))
        setLlmInfo(computeLlmInfo(snap))
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
    // Re-fetch the key snapshot whenever:
    //   - Settings panel closes (user may have changed keys)
    //   - The VM mode transitions (onboarding → idle, story-selector → idle,
    //     etc.) — onboarding finishing is the key case here: without a
    //     re-fetch, the "No LLM API key configured" banner stays stale
    //     even though the user just saved a key in the first-run modal.
  }, [settingsOpen, state?.mode])

  // Slash commands are disabled in the Electron reader input — those functions
  // are reached through the GUI (Story / View menus, modals) instead. So when
  // the reader is idle and types a "/"-prefixed line, send it to the narrator as
  // plain text (submitReaderText) rather than letting the VM dispatch it as a
  // command. Every other mode/path falls through to actions.submit() unchanged.
  const wrappedActions = useMemo(() => ({
    ...actions,
    submit: async () => {
      const text = String(state?.input || "").trim()
      if (state?.mode === "idle" && text.startsWith("/")) {
        return actions.submitReaderText()
      }
      return actions.submit()
    },
  }), [actions, state?.input, state?.mode])

  // Native menu commands routed in from the main process.
  useEffect(() => {
    const off = window.openovel.onMenuCommand((cmd) => {
      switch (cmd) {
        case "new-story":
        case "switch-story":
          // Both land in the story library (selector), where "+ New story"
          // names a new one and a card switches to an existing one. This is the
          // GUI entry that replaces the typed /new-story // /switch-story path.
          actions.goToLibrary()
          break
        case "permissions":
          setCommandModal("permissions")
          break
        case "transactions":
          setCommandModal("transactions")
          break
        case "open-settings":
          setSettingsOpen(true)
          break
        default:
          break
      }
    })
    return off
  }, [actions])

  // Inject the active format contract's sanitized CSS into a single managed
  // <style>. The CSS is already scoped (.ovl-rich / #ovl-content) and
  // property-filtered by the main-process sanitizer (see lib/cssSanitizer.js);
  // structural isolation on #ovl-content is the second line of defense. Cleared
  // when no contract is active.
  useEffect(() => {
    const id = "ovl-format-contract"
    let el = document.getElementById(id)
    const fc = state?.formatContract
    // With custom rich blocks off (Display preference) the model-authored
    // block CSS is not injected — those kinds render via the host-styled
    // PlainRichBlock. hudCss stays: the HUD is a host channel that remains
    // visible; contentCss stays: it is reader-owned (hand-authored only).
    const showCustom = prefs?.customRichBlocks !== false
    const css = fc && fc.enabled ? [showCustom ? fc.css : "", fc.contentCss, fc.hudCss].filter(Boolean).join("\n") : ""
    if (!css) {
      if (el) el.remove()
      return
    }
    if (!el) {
      el = document.createElement("style")
      el.id = id
      document.head.appendChild(el)
    }
    el.textContent = css
  }, [state?.formatContract, prefs?.customRichBlocks])

  // HUD values: the narrator emits a reserved `ovl:hud` fence; we fold the
  // transcript's fences per key (a fence carries only the keys it updates), so
  // a slot keeps its value across turns that omit it and replay after restart /
  // story re-entry recovers the same merged state.
  const [hudPairs, setHudPairs] = useState(null)
  // The HUD belongs to a story's reading view. Gate it on actually being in one
  // (idle/busy) — returning to the library (story-selector) leaves the previous
  // story's formatContract in state, so without this the HUD lingers in the
  // header over the library page.
  const inReadingView = state?.mode === "idle" || state?.mode === "busy"
  const hudActive = Boolean(
    inReadingView && state?.formatContract?.enabled && state?.formatContract?.hud?.slots?.length,
  )
  useEffect(() => {
    if (!hudActive) { setHudPairs(null); return }
    setHudPairs(mergedHudPairsFromEntries(state.entries))
  }, [state?.entries, hudActive])

  // Now-playing music cue: the narrator emits a reserved `ovl:music` fence; we
  // route the latest cue to the persistent now-playing bar (which streams it via
  // ovl-music://). A null cue (the common case) renders nothing. Independent of
  // the format contract — music is its own control channel.
  const musicCue = useMemo(() => latestMusicCueFromEntries(state?.entries), [state?.entries])

  // Scene backdrop: the narrator emits a reserved `ovl:bg` fence selecting a
  // prepared story/includes/bg/ image; latest valid directive wins and persists
  // across turns/replays (like music). Gated on the experimental toggle, which
  // reaches the renderer via formatContract.imageBackground.
  const backdropDirective = useMemo(() => latestBackgroundFromEntries(state?.entries), [state?.entries])
  // prefs.sceneBackdrop is the reader's instant kill switch (Settings → Display):
  // flipping it off re-renders here with backdropSrc=null, so SceneBackdrop
  // unmounts immediately without touching the saved `ovl:bg` directive. `!== false`
  // so older prefs files (no field) default to enabled.
  const backdropSrc =
    prefs?.sceneBackdrop !== false && state?.formatContract?.imageBackground && backdropDirective?.verb === "set"
      ? backdropDirective.src
      : null
  // Backdrop tone profile: sample the image once and use it for both HUD
  // light/dark mode and the scene-backdrop veil/blur treatment (SceneBackdrop
  // computes continuous CSS variables from it). "light" top tone without a
  // backdrop — plain paper; the fallback profile until sampled.
  const backdropToneProfile = useBackdropToneProfile(backdropSrc)
  const hudTone = backdropToneProfile.topTone

  // Gather every error surface (narrator's lastError + any activity-feed
  // row that ended with status: "error") into a single log. Newest first.
  // MUST live above the boot guard — hooks have to run in the same order
  // on every render, so we can't put it after an early return.
  const errors = useMemo(() => {
    if (!state) return []
    const list = []
    if (state.lastError) {
      list.push({
        at: Date.parse(state.lastError.at) || Date.now(),
        source: "Narrator",
        message: state.lastError.message || "",
      })
    }
    for (const a of state.activity || []) {
      if (a.status === "error") {
        list.push({
          at: a.at || 0,
          source: a.source || "Background",
          message: a.meta?.error || a.label || "",
        })
      }
    }
    list.sort((x, y) => (y.at || 0) - (x.at || 0))
    return list
  }, [state?.lastError, state?.activity])

  // Per-paragraph share: rasterize a narration paragraph into a branded PNG and
  // copy/save it. Hook is above the boot guard (must run every render).
  const storyName = state?.currentStory?.displayName || state?.currentStory?.id || ""
  const paragraphShare = useParagraphShare(storyName)

  // Streaming TTS: audio-driven karaoke playback of narration. No-op unless TTS
  // is enabled + credentialed (the main process simply never emits audio events).
  const tts = useTtsKaraoke()

  // Hold on the boot splash until the VM has resolved the first real screen.
  // state.booting is true between getState() (which returns the default `idle`
  // snapshot) and start() landing on onboarding/selector/reading — without this
  // gate the renderer briefly flashes the empty `idle` reading view on launch.
  if (!state || !prefs || state.booting) {
    return (
      <div className="boot">
        <div className="boot-message">starting openovel…</div>
      </div>
    )
  }

  const showFooter =
    state.mode === "idle" || state.mode === "busy" || state.mode === "error"
  // The runtime console (agents + the live story file tree) is useful during a
  // live init too, so you can watch the scaffold files appear. Excluded for the
  // replay demo, where a real-time file tree would be anachronistic.
  const sidePaneAvailable =
    state.mode === "idle" || state.mode === "busy"
    || (state.mode === "init-chat" && !state.initChat?.replay)
  const showSidePane = sidePaneAvailable && sidebarOpen

  const body = (() => {
    switch (state.mode) {
      case "story-selector":
        return <StorySelector state={state} actions={actions} />
      case "story-naming":
        return <StoryNaming state={state} actions={actions} />
      case "onboarding":
        // Body is intentionally blank — OnboardingModal renders as an
        // overlay below. We don't fall back to StorySelector here because
        // the VM hasn't populated storySelector state yet during the
        // first-run path.
        return <div className="onboarding-backdrop-body" />
      case "composing-worldbook":
        return <ComposePane state={state} actions={actions} />
      case "init-chat":
        return <InitChatPane state={state} actions={actions} />
      default:
        return (
          <Transcript
            entries={state.entries}
            formatContract={state.formatContract}
            customRichBlocks={prefs.customRichBlocks !== false}
            characterNames={prefs.highlightNames === false ? null : state.characterNames}
            dialogueTint={prefs.highlightDialogue !== false}
            onShareParagraph={paragraphShare.shareParagraph}
            tts={tts}
            busy={state.busy}
            autoScroll={prefs.autoScroll !== false}
            comicPanels={state.comicPanels}
            comicPanelsLive={state.comicPanelsLive}
          />
        )
    }
  })()

  // Apply prefs as CSS custom properties so theme.css can read them via
  // `--transcript-font-family` etc.
  const styleVars = {
    "--transcript-font-family": FONT_FAMILIES[prefs.fontFamily] || FONT_FAMILIES.serif,
    "--transcript-font-size": `${prefs.fontSize}px`,
    // Format-contract theme tokens: allowlisted CSS variables the slow
    // loop may set for whole-story retinting. Already intersected against the
    // safe token allowlist by the sanitizer; colour/font/spacing only — no
    // spoofing surface. User font prefs above win (spread last would override,
    // so theme goes first then user prefs are re-applied below).
    ...(state.formatContract?.enabled ? state.formatContract.theme || {} : {}),
  }
  // Re-assert user prefs so a contract can't override the reader's own font
  // choice (their setting beats the story's theme for the transcript face).
  styleVars["--transcript-font-family"] = FONT_FAMILIES[prefs.fontFamily] || FONT_FAMILIES.serif
  styleVars["--transcript-font-size"] = `${prefs.fontSize}px`
  // Layout scale (Settings → Presentation): proportionally widens the reading
  // column, the library page, and the cover grid on large displays. The CSS
  // reads it via calc(<base>px * var(--layout-scale, 1)).
  styleVars["--layout-scale"] = String(Math.min(1.5, Math.max(1, Number(prefs.layoutScale) || 1)))
  // Same rule for the color scheme: a reader on a non-default scheme keeps it
  // even when the story contract carries its own theme retint — without this,
  // the contract's inline tokens on .app would beat the preset (which lives
  // up on documentElement) and host chrome (file preview, options, sidebar)
  // would stop following the reader's choice. On the default scheme this is
  // a no-op (no vars), so contract retinting still works there.
  Object.assign(styleVars, colorThemeVars(effectiveColorTheme))

  return (
    <div className={`app${showSidePane ? " app-with-sidebar" : ""}${state.mode === "story-selector" ? " app-library" : ""}${backdropSrc ? " app-scene-backdrop" : ""}${state.busy ? " app-busy" : ""}`} style={styleVars}>
      {/* Scene backdrop wins over the static cover art when active (two stacked
          images read as mud); the host scrim in theme.css owns its treatment. */}
      {backdropSrc ? <SceneBackdrop src={backdropSrc} profile={backdropToneProfile} /> : <BackgroundArt state={state} enabled={prefs.backgroundArt} />}
      {/* Halftone foot strip — echoes the cover dot-art at the bottom edge,
          fading up. Seed is salted off the active story (or a stable fallback on
          chrome-only screens) so the foot draws a different variant/pattern than
          that story's own card. Suppressed while a scene backdrop is active: the
          dot field paints AFTER the backdrop in the same z-plane, so it would
          sit ON the image as texture noise (the app-scene-backdrop class also
          drops the ultra-wide margin wash for the same reason). */}
      {!backdropSrc && (
        <HalftoneBand seed={`${state?.currentStory?.id || "openovel"}::foot`} className="halftone-foot" />
      )}
      {/* Off-screen card snapdom rasterizes for paragraph share, + result toast. */}
      {paragraphShare.card}
      {paragraphShare.status && (
        <div className="share-toast" role="status">
          {t(`share.${paragraphShare.status}`, {
            defaultValue: paragraphShare.status === "copied" ? "Copied to clipboard"
              : paragraphShare.status === "saved" ? "Image saved"
                : "Couldn't make the image",
          })}
        </div>
      )}
      {tts.speaking && (
        <button
          type="button"
          className="tts-speaking-chip"
          onClick={tts.stop}
          title={t("tts.stop", { defaultValue: "Stop reading" })}
        >
          <span className="tts-speaking-wave" aria-hidden="true">▮▮▮</span>
          {t("tts.speaking", { defaultValue: "朗读中 · 点击停止" })}
        </button>
      )}
      <Header
        state={state}
        sidebarOpen={sidebarOpen}
        sidebarAvailable={sidePaneAvailable}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        errorCount={errors.length}
        onOpenErrors={() => setErrorLogOpen(true)}
        nowPlaying={<NowPlaying cue={musicCue} />}
        hud={hudActive ? <Hud slots={state.formatContract.hud.slots} pairs={hudPairs} tone={hudTone} /> : null}
        // Home (library) shortcut — visible while inside a story. Transitions
        // the VM back into story-selector mode so the renderer shows the
        // book-cover library page (NOT just a modal overlay on top of the
        // story). Reading state is dropped from the active surface; the user
        // can re-pick the same story to resume.
        onGoHome={(() => {
          const leave =
            state.mode === "idle" || state.mode === "busy"
              ? () => actions.goToLibrary()
              : state.mode === "init-chat"
                ? () => actions.cancelInitChat()
                : state.mode === "story-naming"
                  ? () => actions.cancelStoryNaming()
                  : undefined
          if (!leave) return undefined
          // Going home leaves the active story (or abandons an in-progress
          // init/naming draft), so guard it behind a confirm to avoid a
          // single mis-click discarding the current surface.
          return () => {
            if (window.confirm(t("header.homeConfirm"))) leave()
          }
        })()}
      />
      <main className="main">
        <div className="body-column">
          {/* HUD + now-playing live in the header strip (see <Header/>). */}
          {state.lastError && (
            <ConnectionErrorBanner lastError={state.lastError} onClick={() => setSettingsOpen(true)} />
          )}
          {!state.lastError && configStatus && !configStatus.ok && (
            <ConfigBanner status={configStatus} onClick={() => setSettingsOpen(true)} />
          )}
          {body}
        </div>
      </main>
      {/* SidePane lives outside the flex flow so the reading column stays
          centered and the panel can run full-height down the right edge. */}
      {showSidePane && (
        <SidePane
          state={state}
          llmInfo={llmInfo}
          onOpenFile={(rel) => setPreviewFile(rel)}
          onOpenSettings={() => setSettingsOpen(true)}
          onExpandDir={actions.expandStoryTreeNode}
          onCollapseDir={actions.collapseStoryTreeNode}
        />
      )}
      {showFooter && <Footer state={state} actions={wrappedActions} />}
      {settingsOpen && (
        <SettingsModal
          prefs={prefs}
          onChange={setPrefs}
          onPreviewColorTheme={setPreviewColorTheme}
          onClose={() => { setPreviewColorTheme(null); setSettingsOpen(false) }}
        />
      )}
      {state.mode === "onboarding" && (
        <OnboardingModal state={state} actions={actions} />
      )}
      {commandModal === "permissions" && (
        <PermissionsModal
          actions={actions}
          onClose={() => setCommandModal(null)}
        />
      )}
      {commandModal === "transactions" && (
        <TransactionsModal
          actions={actions}
          onClose={() => setCommandModal(null)}
        />
      )}
      {errorLogOpen && (
        <ErrorLogModal errors={errors} onClose={() => setErrorLogOpen(false)} />
      )}
      {previewFile && (
        <FilePreview
          rel={previewFile}
          dispatch={(method, ...args) => window.openovel.dispatch(method, ...args)}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
