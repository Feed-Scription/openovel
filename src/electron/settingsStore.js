// Persistent client-side preferences for the Electron UI. Lives at
// ~/.openovel/electron-prefs.json (or OPENOVEL_HOME/electron-prefs.json).
// Pure JSON, no schema-versioning yet — additive fields only.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

const DEFAULTS = {
  fontFamily: "serif", // "serif" | "sans" | "mono"
  fontSize: 16,        // px, applied to transcript narration
  backgroundArt: true, // whether to render BackgroundArt component (static cover art)
  sceneBackdrop: true, // whether to render the narrator's `ovl:bg` full-page scene backdrop
  customRichBlocks: true, // false = render contract blocks via the host's plain style (HUD/bg/includes stay on)
  theme: "dark",       // legacy, unread — kept so old prefs files round-trip
  colorTheme: "default", // preset id from renderer/lib/colorThemes.js ("default" | "bianca" | "sepia" | "sage" | "mist")
  narrationCpm: 720,   // narrator reveal speed (chars/min); 0 = unlimited (pacing off). Pushed to the VM revealer
  autoScroll: true,    // sticky-bottom auto-scroll while narration streams; false = reader scrolls manually
  highlightDialogue: true, // tint quoted speech (.dq spans) in narration
  highlightNames: true,    // tint character names (from CHARACTER context cards) in narration
  layoutScale: 1,      // 1..1.5 — proportionally widens the reading column + library covers (large displays)
  settingsMode: "simple", // "simple" | "advanced"; keeps first-run settings low-friction
}

function prefsPath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "electron-prefs.json")
}

// Mirror prompt-relevant reader prefs into the process env so the embedded
// VM's model prompts can react (settings layering already treats env as the
// final override). customRichBlocks: with the reader displaying contract
// blocks in plain host style, the narrator hint and the render/showrunner
// contracts stop steering toward custom `ovl:<kind>` blocks — emitting them
// would only produce plain cards where prose reads better. Runs on every
// load AND save, so a Settings toggle reaches the very next model call.
function syncPrefEnv(prefs) {
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = prefs.customRichBlocks === false ? "0" : "1"
}

export async function loadElectronPrefs() {
  let prefs
  try {
    const text = await readFile(prefsPath(), "utf8")
    prefs = { ...DEFAULTS, ...JSON.parse(text) }
  } catch {
    prefs = { ...DEFAULTS }
  }
  syncPrefEnv(prefs)
  return prefs
}

export async function saveElectronPrefs(prefs) {
  const merged = { ...DEFAULTS, ...prefs }
  const file = prefsPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2), "utf8")
  syncPrefEnv(merged)
  return merged
}
