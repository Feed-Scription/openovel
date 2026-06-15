import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { formatContractAuthoringContract } from "../src/prompts/agentContracts.js"
import { loadFormatContract, isStoryIncludesEnabled } from "../src/lib/formatContract.js"
import { buildFormatContractInitAddendum } from "../src/workflows/storyInitWorkflow.js"
import { getBehaviorSnapshot } from "../src/electron/behaviorStore.js"

// ── authoring contract: include section is gated on includeEnabled ──
test("formatContractAuthoringContract hides the include section by default", () => {
  const c = formatContractAuthoringContract()
  assert.doesNotMatch(c, /ovl:include/)
  assert.doesNotMatch(c, /story\/includes\//)
  // base capability is always documented
  assert.match(c, /block KINDS stay open/)
})

test("formatContractAuthoringContract shows the include section when enabled", () => {
  const c = formatContractAuthoringContract({ includeEnabled: true })
  assert.match(c, /ovl:include/)
  assert.match(c, /story\/includes\//)
  assert.match(c, /USER-SUPPLIED/)
})

test("format contract prompt hides music protocol unless musicEnabled is true", () => {
  const off = formatContractAuthoringContract({ imageBackgroundEnabled: true })
  assert.doesNotMatch(off, /ovl:music|music cues|now-playing/)
  assert.doesNotMatch(off, /`music`/)

  const on = formatContractAuthoringContract({ imageBackgroundEnabled: true, musicEnabled: true })
  assert.match(on, /now-playing music/)
  assert.match(on, /`music`/)
})

// ── deep-init pre-generation addendum ──
test("init pre-generation addendum reflects the includes toggle", () => {
  const off = buildFormatContractInitAddendum({ includeEnabled: false })
  assert.match(off, /PROTOCOL PRE-GENERATION/)
  assert.match(off, /story\/format\//)
  assert.match(off, /blocks\/<kind>\.html/)
  assert.match(off, /Media includes are OFF/)
  assert.doesNotMatch(off, /ovl:music|music cues|now-playing/)

  const on = buildFormatContractInitAddendum({ includeEnabled: true })
  assert.match(on, /Media includes are ALSO enabled/)
  assert.match(on, /story\/includes\//)
  assert.doesNotMatch(on, /ovl:music|music cues|now-playing/)
})

test("init pre-generation addendum passes through musicEnabled explicitly", () => {
  const c = buildFormatContractInitAddendum({ musicEnabled: true })
  assert.match(c, /now-playing music/)
  assert.match(c, /`music`/)
})

test("init pre-generation addendum respects plain-blocks mode", () => {
  const c = buildFormatContractInitAddendum({
    includeEnabled: true,
    imageGenEnabled: true,
    imageBackgroundEnabled: true,
    customBlocksDisplayed: false,
  })

  assert.match(c, /PLAIN BLOCKS/)
  assert.match(c, /reserved render channels/)
  assert.match(c, /story\/format\/config\.json/)
  assert.match(c, /ovl:bg/)
  assert.doesNotMatch(c, /ovl:music|music cues|now-playing/)
  assert.doesNotMatch(c, /<format_contract>/)
  assert.doesNotMatch(c, /blocks\/<kind>\.html/)
  assert.doesNotMatch(c, /ovl:<kind>/)
  assert.doesNotMatch(c, /DELIVER A COMPLETE, STYLED CONTRACT/)
})

// ── loadFormatContract: include needs BOTH the env toggle and the contract field ──
const CONFIG_WITH_INCLUDE = JSON.stringify({ version: 1, include: { enabled: true } })

async function withContract(fn) {
  const saved = { ...process.env }
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-incl-"))
  process.env.OPENOVEL_STORY_ROOT = root
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  await mkdir(path.join(root, "format"), { recursive: true })
  await writeFile(path.join(root, "format", "config.json"), CONFIG_WITH_INCLUDE)
  try {
    await fn()
  } finally {
    for (const k of ["OPENOVEL_STORY_ROOT", "OPENOVEL_IGNORE_PROJECT_CONFIG", "OPENOVEL_ENABLE_FORMAT_CONTRACT", "OPENOVEL_ENABLE_STORY_INCLUDES"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test("include stays disabled when the Media-includes toggle is off, even if the contract opts in", async () => {
  await withContract(async () => {
    delete process.env.OPENOVEL_ENABLE_STORY_INCLUDES
    assert.equal(isStoryIncludesEnabled(process.env), false)
    const fc = await loadFormatContract({ env: process.env })
    assert.equal(fc.include?.enabled, false)
  })
})

test("include activates when BOTH the toggle and the contract opt in", async () => {
  await withContract(async () => {
    process.env.OPENOVEL_ENABLE_STORY_INCLUDES = "true"
    assert.equal(isStoryIncludesEnabled(process.env), true)
    const fc = await loadFormatContract({ env: process.env })
    assert.equal(fc.include?.enabled, true)
  })
})

// ── settings: the toggle is surfaced in the Behavior tab ──
test("behavior snapshot exposes the Media-includes toggle", async () => {
  const saved = process.env.OPENOVEL_HOME
  process.env.OPENOVEL_HOME = await mkdtemp(path.join(os.tmpdir(), "openovel-beh-"))
  try {
    const snap = await getBehaviorSnapshot()
    const ids = snap.toggles.map((t) => t.id)
    assert.ok(ids.includes("formatContract"), "rich rendering toggle present")
    assert.ok(ids.includes("storyIncludes"), "media includes toggle present")
    const inc = snap.toggles.find((t) => t.id === "storyIncludes")
    assert.equal(inc.value, false) // experimental → off by default
    assert.equal(inc.affects, "next-session")
  } finally {
    if (saved === undefined) delete process.env.OPENOVEL_HOME
    else process.env.OPENOVEL_HOME = saved
  }
})

// ── scene-backdrop channel: gated on the image-background toggle ──
test("ovl:bg documentation is gated on imageBackgroundEnabled", async () => {
  const { imageAgentContract } = await import("../src/prompts/agentContracts.js")
  // authoring contract
  assert.doesNotMatch(formatContractAuthoringContract(), /ovl:bg/)
  const authoring = formatContractAuthoringContract({ imageBackgroundEnabled: true })
  assert.match(authoring, /ovl:bg/)
  assert.match(authoring, /RESERVED/)
  // image agent: background prepare + aesthetics + handoff only when enabled
  assert.doesNotMatch(imageAgentContract({ generateImageEnabled: true }), /ovl:bg/)
  const agent = imageAgentContract({ generateImageEnabled: true, imageBackgroundEnabled: true })
  assert.match(agent, /story\/includes\/bg\//)
  assert.match(agent, /BACKGROUND AESTHETICS/)
  assert.match(agent, /ovl:bg/)
})

test("authoring contract steers ASCII slot keys + straight punctuation and forbids a choice block", () => {
  const c = formatContractAuthoringContract()
  assert.match(c, /ASCII SLOT NAMES/)
  assert.match(c, /STRAIGHT ASCII/)
  assert.match(c, /DO NOT author a choice/)
  assert.match(c, /separate post-narration/i)
})
