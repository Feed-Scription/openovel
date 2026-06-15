// Initialization-depth preference. One of:
//   "zero"     — skip the init agent entirely; the user's brief becomes
//                the Prelude verbatim and the live narrator picks it up.
//   "standard" — current behavior; init agent scaffolds FG_template /
//                section files / context cards using file tools only.
//   "deep"     — init agent + websearch / webfetch; agent is told to
//                research the premise (fan-fiction canon, real-world era
//                facts, etc.) before writing the scaffold.
//
// Stored under `initialization.depth` in settings.local.json. Mirrored to
// process.env.OPENOVEL_INIT_DEPTH so the runtime VM (which can run
// headless without Electron) can read the same value via env.
//
// The default is null — meaning "ask the user the first time they hit
// new-story". The VM uses null to trigger the first-run Modal in the
// Electron renderer.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"

export const VALID_DEPTHS = ["zero", "standard", "deep"]
const SETTINGS_PATH = ["initialization", "depth"]
const ENV_KEY = "OPENOVEL_INIT_DEPTH"

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

export async function getInitDepth() {
  // env wins (so users can override via env without touching the file).
  const env = process.env[ENV_KEY]
  if (env && VALID_DEPTHS.includes(env)) {
    return { value: env, sourcedFrom: "env", filePath: settingsFilePath() }
  }
  const settings = await readSettingsFile()
  const raw = readNested(settings, SETTINGS_PATH)
  const value = VALID_DEPTHS.includes(raw) ? raw : null
  return { value, sourcedFrom: value ? "file" : "unset", filePath: settingsFilePath() }
}

export async function setInitDepth(value) {
  if (value !== null && !VALID_DEPTHS.includes(value)) {
    throw new Error(`init depth must be one of ${VALID_DEPTHS.join(", ")} or null`)
  }
  const settings = await readSettingsFile()
  writeNested(settings, SETTINGS_PATH, value)
  await writeSettingsFile(settings)
  if (value) process.env[ENV_KEY] = value
  else delete process.env[ENV_KEY]
  return { value, filePath: settingsFilePath() }
}
