import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

import { buildNarratorMessages } from "../src/lib/narrator.js"
import { formatContractAuthoringContract, renderManagerContract } from "../src/prompts/agentContracts.js"
import { storykeeperSystemPrompt } from "../src/workflows/storykeeperContext.js"

// Isolate from the developer's real config. settingsEnv() walks projectConfigDirs
// UP from cwd, which reaches ~/.openovel when the repo lives under $HOME — so a
// real settings.local.json with formatContract enabled would otherwise leak in
// and break the feature-OFF assertion. Pin a temp home + ignore project config
// so the flag is driven solely by process.env below.
process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-fcp-${Date.now()}`)
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"

const SAVED = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
function setFlag(on) {
  if (on) process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  else delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
}
function restore() {
  if (SAVED === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = SAVED
}

const ctx = {
  foregroundGuidance: "scene: a room",
  foregroundContextInserts: "",
  foregroundMemory: {},
  storyMemory: "",
  recentCanonExcerpt: "...",
}

test("narrator <output> forbids fences when feature OFF", () => {
  setFlag(false)
  try {
    const msgs = buildNarratorMessages({ action: "look", compiledContext: ctx })
    const sys = msgs.find((m) => m.role === "system").content
    assert.match(sys, /no JSON, no XML tags, no Markdown fences/)
    assert.doesNotMatch(sys, /ovl:<kind>/)
  } finally { restore() }
})

test("narrator <output> allows ovl:<kind> fences when feature ON", () => {
  setFlag(true)
  try {
    const msgs = buildNarratorMessages({ action: "look", compiledContext: ctx })
    const sys = msgs.find((m) => m.role === "system").content
    assert.match(sys, /ovl:<kind>/)
    assert.match(sys, /described in Foreground Guidance/)
  } finally { restore() }
})

test("narrator plain-blocks output omits custom-kind placeholder fences", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  const savedIncludes = process.env.OPENOVEL_ENABLE_STORY_INCLUDES
  const savedMusic = process.env.OPENOVEL_ENABLE_MUSIC_GEN
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  process.env.OPENOVEL_ENABLE_STORY_INCLUDES = "true"
  delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
  try {
    const msgs = buildNarratorMessages({ action: "look", compiledContext: ctx })
    const sys = msgs.find((m) => m.role === "system").content
    assert.doesNotMatch(sys, /ovl:<kind>/)
    assert.match(sys, /```ovl:hud```/)
    assert.match(sys, /```ovl:include```/)
    assert.doesNotMatch(sys, /ovl:music|music cues|now-playing/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
    if (savedIncludes === undefined) delete process.env.OPENOVEL_ENABLE_STORY_INCLUDES
    else process.env.OPENOVEL_ENABLE_STORY_INCLUDES = savedIncludes
    if (savedMusic === undefined) delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
    else process.env.OPENOVEL_ENABLE_MUSIC_GEN = savedMusic
  }
})

test("narrator plain-blocks output includes music fence only when music-gen is enabled", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  const savedMusic = process.env.OPENOVEL_ENABLE_MUSIC_GEN
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  process.env.OPENOVEL_ENABLE_MUSIC_GEN = "true"
  try {
    const msgs = buildNarratorMessages({ action: "look", compiledContext: ctx })
    const sys = msgs.find((m) => m.role === "system").content
    assert.match(sys, /```ovl:music```/)
    assert.match(sys, /music cues/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
    if (savedMusic === undefined) delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
    else process.env.OPENOVEL_ENABLE_MUSIC_GEN = savedMusic
  }
})

test("narrator prompt documents system reserved format contracts and terse HUD values", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  const savedIncludes = process.env.OPENOVEL_ENABLE_STORY_INCLUDES
  const savedBg = process.env.OPENOVEL_ENABLE_IMAGE_BACKGROUND
  const savedMusic = process.env.OPENOVEL_ENABLE_MUSIC_GEN
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  process.env.OPENOVEL_ENABLE_STORY_INCLUDES = "true"
  process.env.OPENOVEL_ENABLE_IMAGE_BACKGROUND = "true"
  process.env.OPENOVEL_ENABLE_MUSIC_GEN = "true"
  try {
    const msgs = buildNarratorMessages({ action: "look", compiledContext: ctx })
    const sys = msgs.find((m) => m.role === "system").content
    assert.match(sys, /<system_reserved_formats>/)
    assert.match(sys, /HARD HUD BREVITY/)
    assert.match(sys, /<=12 CJK chars/)
    assert.match(sys, /Never write a sentence, a comma-list/)
    assert.match(sys, /@include story\/includes\/<path>/)
    assert.match(sys, /set: story\/includes\/bg\/<file>/)
    assert.match(sys, /bgm: <short-id>/)
    assert.doesNotMatch(sys, /cue=/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
    if (savedIncludes === undefined) delete process.env.OPENOVEL_ENABLE_STORY_INCLUDES
    else process.env.OPENOVEL_ENABLE_STORY_INCLUDES = savedIncludes
    if (savedBg === undefined) delete process.env.OPENOVEL_ENABLE_IMAGE_BACKGROUND
    else process.env.OPENOVEL_ENABLE_IMAGE_BACKGROUND = savedBg
    if (savedMusic === undefined) delete process.env.OPENOVEL_ENABLE_MUSIC_GEN
    else process.env.OPENOVEL_ENABLE_MUSIC_GEN = savedMusic
  }
})

test("authoring contract is HTML-oriented and abstract — no concrete story kind names leak", () => {
  const c = formatContractAuthoringContract()
  // file-based layout: one HTML template per blocks/<kind>.html file
  assert.match(c, /blocks\/<kind>\.html/)
  assert.match(c, /HTML template/)
  assert.match(c, /Allowed tags/)
  // slot placeholders are documented
  assert.match(c, /\{\{body\}\}/)
  // states the security envelope + the reject-on-illegal-HTML behaviour
  assert.match(c, /SECURITY ENVELOPE/)
  assert.match(c, /REJECTED/)
  // and the open-catalog principle
  assert.match(c, /block KINDS stay open/)
})

test("render manager plain-blocks prompt freezes custom block authoring", () => {
  const c = renderManagerContract({ customBlocksDisplayed: false, imageBackgroundEnabled: true })

  assert.match(c, /PLAIN BLOCKS/)
  assert.match(c, /story\/format\/config\.json/)
  assert.match(c, /story\/format\/blocks\//)
  assert.match(c, /hud, include, bg/)
  assert.doesNotMatch(c, /music cues|ovl:music|now-playing/)
  assert.match(c, /reject block-template writes/)
  assert.doesNotMatch(c, /<format_contract>/)
  assert.doesNotMatch(c, /DELIVER A COMPLETE, STYLED CONTRACT/)
  assert.doesNotMatch(c, /ARCHIVE RETIRED KINDS/)
  assert.doesNotMatch(c, /HAND THE NARRATOR THE FENCE/)
  assert.doesNotMatch(c, /ovl:<kind>/)
})

test("render manager prompt exposes music only when musicEnabled is true", () => {
  const off = renderManagerContract({ customBlocksDisplayed: false, imageBackgroundEnabled: true, musicEnabled: false })
  assert.doesNotMatch(off, /music cues|ovl:music|now-playing/)

  const on = renderManagerContract({ customBlocksDisplayed: false, imageBackgroundEnabled: true, musicEnabled: true })
  assert.match(on, /hud\/include\/bg\/music/)
  assert.match(on, /music cues/)
})

test("legacy storykeeper plain-blocks prompt omits the full block authoring contract", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  try {
    const c = storykeeperSystemPrompt()
    assert.match(c, /PLAIN BLOCKS/)
    assert.match(c, /story\/format\/blocks\//)
    assert.doesNotMatch(c, /<format_contract>/)
    assert.doesNotMatch(c, /DELIVER A COMPLETE, STYLED CONTRACT/)
    assert.doesNotMatch(c, /HAND THE NARRATOR THE FENCE/)
    assert.doesNotMatch(c, /ovl:<kind>/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
  }
})
