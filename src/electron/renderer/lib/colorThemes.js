// Preset color schemes (Settings → Display → Color scheme). Each preset is a
// set of CSS-variable overrides applied at the document root, so it replaces
// the :root baseline from theme.css without touching the stylesheet.
// Presets retint SURFACE tokens (paper/rule/frame/frost) plus ONE narrative
// accent: --voice-dialogue (quoted speech in prose, and the ovl progress-bar
// fill), hue-matched to the paper's temperature at the same lightness as the
// default blue so contrast stays constant. Ink and the other voice tokens
// inherit :root, which keeps body-contrast guarantees intact. A per-story
// format-contract theme still applies on top of the chosen preset, the same
// way it applies on top of the default baseline.
//
// Tuning rules learned from reader feedback:
// - Page tint stays BARELY-there: channel spread (max-min across R/G/B) of
//   ~4-10 points on the page, not 12-25. A stronger tint reads pleasant at
//   first glance but accumulates into fatigue over a long session.
// - Lifted sheets (cards/covers/modals) stay in the SAME family as the page,
//   one small step lighter (like the default #f4f4f4→#ffffff), never jumping
//   to pure white.
export const COLOR_THEMES = {
  // The neutral-grey baseline — no overrides, theme.css :root as-is.
  default: { vars: {} },
  // Bianca: warm cream/off-white. Dialogue in warm umber, like aged-book ink.
  bianca: {
    vars: {
      "--paper": "#f6f4ee",
      "--paper-soft": "#efece4",
      "--paper-lift": "#fbf9f2",
      "--pane-frost": "rgba(251, 249, 242, 0.52)",
      "--pane-frost-active": "rgba(251, 249, 242, 0.86)",
      "--rule": "#c6c2b6",
      "--rule-soft": "#dad6cb",
      "--frame": "#2f2d26",
      "--voice-dialogue": "#61462f",
    },
  },
  // Sepia: tan parchment, the classic e-reader warm mode. Dialogue in rust.
  sepia: {
    vars: {
      "--paper": "#f3efe6",
      "--paper-soft": "#ece7db",
      "--paper-lift": "#f8f5ec",
      "--pane-frost": "rgba(248, 245, 236, 0.52)",
      "--pane-frost-active": "rgba(248, 245, 236, 0.86)",
      "--rule": "#c7c2b4",
      "--rule-soft": "#dbd6c9",
      "--frame": "#2f2c25",
      "--voice-dialogue": "#6e472e",
    },
  },
  // Sage: a whisper of eye-rest green. Dialogue in moss.
  sage: {
    vars: {
      "--paper": "#eceee8",
      "--paper-soft": "#e4e7e0",
      "--paper-lift": "#f5f6f1",
      "--pane-frost": "rgba(245, 246, 241, 0.52)",
      "--pane-frost-active": "rgba(245, 246, 241, 0.86)",
      "--rule": "#bfc3b9",
      "--rule-soft": "#d4d8cf",
      "--frame": "#2b2e29",
      "--voice-dialogue": "#3e5641",
    },
  },
  // Mist: cool quiet grey-blue. Dialogue in steel blue (a hair deeper than
  // the default so it still reads as a deliberate accent on cool paper).
  mist: {
    vars: {
      "--paper": "#eef0f2",
      "--paper-soft": "#e5e8eb",
      "--paper-lift": "#f8f9fa",
      "--pane-frost": "rgba(248, 249, 250, 0.52)",
      "--pane-frost-active": "rgba(248, 249, 250, 0.86)",
      "--rule": "#bcc1c6",
      "--rule-soft": "#d2d6da",
      "--frame": "#282b2d",
      "--voice-dialogue": "#38506e",
    },
  },
}

export function colorThemeVars(id) {
  return (COLOR_THEMES[id] || COLOR_THEMES.default).vars
}
