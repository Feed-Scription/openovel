// Behavior toggles for the Settings → Behavior tab. Each toggle maps to:
//   1. A field inside settings.local.json (same layered config as API keys)
//   2. An env var that the runtime reads (so a write here takes effect on
//      the next read; in-flight VM init is unaffected, see notes below)
//
// Ablation env vars (OPENOVEL_ABLATION_DISABLE_*) are read at VM init time
// in sessionViewModel.js — toggling them affects the next session start,
// not the currently-running session. The UI surfaces this caveat.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

const TOGGLES = [
  {
    id: "optionsEnabled",
    label: "Suggest choices each turn",
    description: "After each turn, offer a few numbered choices you can pick instead of typing.",
    envKey: "OPENOVEL_OPTIONS_ENABLED",
    settingsPath: ["tui", "optionsEnabled"],
    defaultValue: true,
    affects: "next-turn",
  },
  {
    id: "displayPacing",
    label: "Reveal text at a reading pace",
    description: "Show the words at a calm, steady pace. Turn off to show them the moment they arrive.",
    envKey: "OPENOVEL_DISPLAY_PACING",
    settingsPath: ["tui", "displayPacing"],
    defaultValue: true,
    affects: "next-turn",
  },
  {
    id: "residentTeam",
    label: "Story team",
    description: "Behind the scenes, a small team keeps track of your world, pacing, characters, and memory. On by default — turn off to use a single, lighter-weight helper.",
    envKey: "OPENOVEL_RESIDENT_TEAM",
    settingsPath: ["agents", "residentTeam"],
    defaultValue: true,
    affects: "next-turn",
  },
  {
    id: "crossStoryMemory",
    label: "Cross-story memory",
    description: "Let openovel carry model-observed reader notes and reusable references across stories. Turn off to keep model memory story-local; existing cross-story notes remain until you reset them.",
    envKey: "OPENOVEL_CROSS_STORY_MEMORY",
    settingsPath: ["memory", "crossStoryMemory"],
    defaultValue: true,
    affects: "next-turn",
  },
  {
    id: "formatContract",
    label: "Rich rendering",
    description: "Let your story show more than plain text — status bars, stat panels, and terminal-style blocks — when it fits the scene.",
    envKey: "OPENOVEL_ENABLE_FORMAT_CONTRACT",
    settingsPath: ["tools", "formatContract"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "storyIncludes",
    label: "Media in stories",
    description: "Let stories show images, video, audio, or text you place in their media folder. Needs Rich rendering on.",
    envKey: "OPENOVEL_ENABLE_STORY_INCLUDES",
    settingsPath: ["tools", "storyIncludes"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "imageGen",
    label: "Story illustrations",
    description: "Let your story show pictures it finds or creates as the plot moves forward. Turns on Rich rendering and media too — set it up under Settings → Image.",
    envKey: "OPENOVEL_ENABLE_IMAGE_GEN",
    settingsPath: ["tools", "imageGen"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "imageBackground",
    label: "Scene backgrounds",
    description: "Let prepared scene images appear as a soft, dimmed backdrop behind the story text for extra atmosphere. The app keeps the text fully readable with a built-in veil. Turns on Rich rendering and media too; pairs best with Story illustrations.",
    envKey: "OPENOVEL_ENABLE_IMAGE_BACKGROUND",
    settingsPath: ["tools", "imageBackground"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "characterSheets",
    label: "Character sheets (experimental)",
    description: "Have the image helper keep a visual reference for each major character from the character cards — a written look spec plus a generated reference sheet — and hold every later illustration to it. Needs Story illustrations on.",
    envKey: "OPENOVEL_ENABLE_CHARACTER_SHEETS",
    settingsPath: ["tools", "characterSheets"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "comicMode",
    label: "Comic mode (experimental)",
    description: "Adds a per-story switch to the library card menu: a story in comic mode plays as a picture-story strip (generated panels with captions) instead of prose. Set up image generation under Settings → Image first.",
    envKey: "OPENOVEL_ENABLE_COMIC_MODE",
    settingsPath: ["tools", "comicMode"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "fastMode",
    label: "Fast mode (experimental)",
    description: "Adds a per-story switch to the library card menu: a story in fast mode plays in short bursts that move the plot quickly and stop at the next meaningful decision, with the choices carrying the weight. No image setup needed.",
    envKey: "OPENOVEL_ENABLE_FAST_MODE",
    settingsPath: ["tools", "fastMode"],
    defaultValue: false,
    affects: "next-turn",
  },
  {
    id: "musicGen",
    label: "Background music (experimental)",
    description: "Plays mood music that fits your story. A small bar at the top of the window lets you pause and set the volume. Connect your music account under Settings → Music first.",
    envKey: "OPENOVEL_ENABLE_MUSIC_GEN",
    settingsPath: ["tools", "musicGen"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "initNarratorPreview",
    label: "Preview the voice at setup",
    description: "When starting a new story, hear the narrator's voice on a draft and fine-tune it over a round or two before you begin. Adds a little time up front.",
    envKey: "OPENOVEL_ENABLE_INIT_NARRATOR_PREVIEW",
    settingsPath: ["tools", "initNarratorPreview"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "bashTool",
    label: "Shell tool for the story team (advanced)",
    description: "Let the behind-the-scenes team run shell commands (such as jq) to read and update your world's data. Runs in an OS sandbox: no internet access, and it can only write inside this story's files. Off by default.",
    envKey: "OPENOVEL_ENABLE_BASH_TOOL",
    settingsPath: ["tools", "bash"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "disableBackground",
    label: "Pause all background work (testing)",
    description: "Stop everything that happens behind the scenes between turns. For testing and comparisons.",
    envKey: "OPENOVEL_ABLATION_DISABLE_BACKGROUND",
    settingsPath: ["ablation", "disableBackground"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "disableStorykeeper",
    label: "Pause story-keeping (testing)",
    description: "Stop the behind-the-scenes helper that keeps track of canon and characters.",
    envKey: "OPENOVEL_ABLATION_DISABLE_STORYKEEPER",
    settingsPath: ["ablation", "disableStorykeeper"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "disableMemoryReview",
    label: "Pause memory updates (testing)",
    description: "Stop the behind-the-scenes helper that builds up long-term memory.",
    envKey: "OPENOVEL_ABLATION_DISABLE_MEMORY_REVIEW",
    settingsPath: ["ablation", "disableMemoryReview"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "disableContextInserts",
    label: "Pause auto context cards (testing)",
    description: "Stop automatically bringing in the most relevant character and world notes each turn.",
    envKey: "OPENOVEL_ABLATION_DISABLE_CONTEXT_INSERTS",
    settingsPath: ["ablation", "disableContextInserts"],
    defaultValue: false,
    affects: "next-session",
  },
  {
    id: "recordCalls",
    label: "Record raw model calls (developer)",
    description: "Save every model call — the exact prompt sent and the full reply — to story/packets/calls.jsonl, for building training data. Off by default; produces large files.",
    envKey: "OPENOVEL_RECORD_CALLS",
    settingsPath: ["debug", "recordCalls"],
    defaultValue: false,
    affects: "next-turn",
  },
]

// Hidden/paused features stay wired internally for now, but are not surfaced in
// Settings and are not re-enabled from stale saved UI state.
const HIDDEN_TOGGLE_IDS = new Set(["musicGen"])

function settingsFilePath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "settings.local.json")
}

async function readSettingsFile() {
  try {
    const text = await readFile(settingsFilePath(), "utf8")
    return JSON.parse(text)
  } catch { return {} }
}

async function writeSettingsFile(obj) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8")
}

// "1"/"true"/"yes"/"on" → true. The same lenient parser the runtime uses.
function envIsOn(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function readNested(obj, pathArr) {
  let cur = obj
  for (const key of pathArr) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

function writeNested(obj, pathArr, value) {
  let cur = obj
  for (let i = 0; i < pathArr.length - 1; i++) {
    cur[pathArr[i]] = cur[pathArr[i]] || {}
    cur = cur[pathArr[i]]
  }
  cur[pathArr[pathArr.length - 1]] = value
}

// Re-seed process.env from the saved toggles on boot. settings.local.json (under
// $OPENOVEL_HOME) is NOT one of the config layers loadSettings()/settingsEnv()
// read, and the runtime reads these toggles off process.env (the VM is
// constructed with `env: process.env`). Without this, every Behavior toggle
// silently reverted to its default on restart even though the file recorded the
// user's choice — exactly the "改了都没起作用" report. Call once at startup,
// next to apiKeysStore.hydrateProcessEnvFromSettings(). Idempotent.
export async function hydrateBehaviorEnvFromSettings() {
  const settings = await readSettingsFile()
  for (const spec of TOGGLES) {
    if (HIDDEN_TOGGLE_IDS.has(spec.id)) {
      process.env[spec.envKey] = "0"
      continue
    }
    const fileValue = readNested(settings, spec.settingsPath)
    // Only seed toggles the user actually set; leave the rest to their defaults
    // (and don't clobber a value the user pinned via shell env / settings.jsonc).
    if (typeof fileValue !== "boolean") continue
    process.env[spec.envKey] = fileValue ? "1" : "0"
  }
}

export async function getBehaviorSnapshot() {
  const settings = await readSettingsFile()
  const out = []
  for (const spec of TOGGLES) {
    if (HIDDEN_TOGGLE_IDS.has(spec.id)) continue
    const envValue = process.env[spec.envKey]
    const fileValue = readNested(settings, spec.settingsPath)
    // Resolve to the user-facing "on" boolean. For ablation toggles (invert),
    // env=true means feature DISABLED, so user-facing "on" = !env.
    const envOn = envIsOn(envValue, undefined)
    const fileOn = typeof fileValue === "boolean" ? fileValue : undefined
    let value
    if (envOn !== undefined) value = envOn
    else if (fileOn !== undefined) value = fileOn
    else value = spec.defaultValue
    out.push({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      affects: spec.affects,
      value,
      sourcedFrom: envValue !== undefined ? "env" : (fileOn !== undefined ? "file" : "default"),
    })
  }
  return { toggles: out, filePath: settingsFilePath() }
}

export async function setBehavior(patch = {}) {
  const settings = await readSettingsFile()
  const changes = []
  for (const [id, raw] of Object.entries(patch || {})) {
    const spec = TOGGLES.find((t) => t.id === id)
    if (spec && HIDDEN_TOGGLE_IDS.has(spec.id)) {
      process.env[spec.envKey] = "0"
      continue
    }
    if (!spec) continue
    const userOn = Boolean(raw)
    // User-facing toggle "on" matches the env var semantically. For ablation
    // toggles the label is phrased as "Disable X" so user-on means feature
    // disabled; the env var is OPENOVEL_ABLATION_DISABLE_X = "1".
    writeNested(settings, spec.settingsPath, userOn)
    process.env[spec.envKey] = userOn ? "1" : "0"
    changes.push({ id, value: userOn })
  }
  await writeSettingsFile(settings)
  return { changes, filePath: settingsFilePath() }
}
