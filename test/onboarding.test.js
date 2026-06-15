import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory } from "../src/lib/storyStore.js"
import { getMemorySnapshot } from "../src/memory/memoryStore.js"
import {
  getPreferenceSnapshot,
  localeFromLanguagePreference,
  normalizeLanguagePreference,
  onboardingMarkerPath,
  openovelHomeWasEmpty,
  PREFERENCE_QUESTIONS,
  generateStyleComparisonQuestion,
  preferenceQuestions,
  resetPreferenceOnboarding,
  resolveOnboardingLocale,
  savePreferenceOnboarding,
  shouldRunPreferenceOnboarding,
} from "../src/onboarding/preferenceOnboarding.js"
import { addMemoryEntry } from "../src/memory/memoryStore.js"
import {
  createOnboardingPreferenceWorkflow,
  onboardingPreferenceSystemPrompt,
} from "../src/workflows/onboardingPreferenceWorkflow.js"

test("preference onboarding stays short enough to avoid first-run friction", () => {
  assert.ok(PREFERENCE_QUESTIONS.length > 0)
  assert.ok(PREFERENCE_QUESTIONS.length <= 3)
  assert.doesNotMatch(PREFERENCE_QUESTIONS.map((question) => question.prompt).join("\n"), /[\u3400-\u9fff]/)
})

test("preference onboarding can localize user-facing prompts", () => {
  assert.equal(resolveOnboardingLocale({}), "en")
  assert.equal(resolveOnboardingLocale({ OPENOVEL_ONBOARDING_LOCALE: "zh-CN" }), "zh")
  assert.match(preferenceQuestions("zh-CN")[0].prompt, /选择/)
})

test("language choice normalizes menu answers and drives later prompt locale", () => {
  assert.equal(normalizeLanguagePreference("", { fallback: "English" }), "English")
  assert.equal(normalizeLanguagePreference("1"), "English")
  assert.equal(normalizeLanguagePreference("2"), "Simplified Chinese")
  assert.equal(normalizeLanguagePreference("3"), "Traditional Chinese")
  assert.equal(localeFromLanguagePreference("Simplified Chinese"), "zh")
  assert.equal(localeFromLanguagePreference("English"), "en")
})

test("first-run onboarding writes global user preferences and marker", async () => {
  const savedEnv = saveEnv()
  // Don't inherit an ambient OPENOVEL_SKIP_ONBOARDING=1 (set for demos/CI of
  // other surfaces) — this test asserts onboarding actually runs.
  delete process.env.OPENOVEL_SKIP_ONBOARDING
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-home-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))

  try {
    assert.equal(await openovelHomeWasEmpty(), true)
    await initializeStory()
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: true }), true)

    const saved = await savePreferenceOnboarding([
      { id: "language", answer: "简体中文，少量英文术语保留原文" },
      { id: "style_sample", answer: "他没有解释，只把地图往灯下一推。" },
      {
        id: "style_comparison",
        // The new OnboardingModal joins each tag group onto its own line so
        // they can be written as separate `- Style preferences (Group): ...`
        // bullets in USER.md.
        answer: "节奏: 慢热\n调性: 克制; 疏离\n视角: 第三人称限知\n避免: AI 腔; 过度解释",
      },
    ])
    const snapshot = await getMemorySnapshot()
    const marker = JSON.parse(await readFile(onboardingMarkerPath(home), "utf8"))

    // style_comparison expands into one entry per group, so the saved entry
    // count is at least PREFERENCE_QUESTIONS.length (other questions stay 1:1).
    assert.ok(saved.entries.length >= PREFERENCE_QUESTIONS.length)
    assert.ok(existsSync(onboardingMarkerPath(home)))
    assert.equal(marker.languagePreference, "简体中文，少量英文术语保留原文")
    assert.equal(marker.onboardingLocale, "zh")
    assert.match(snapshot.user, /Default story language: 简体中文/)
    assert.match(snapshot.user, /Prose reference \(writing the user wants to read like\): 他没有解释/)
    // Nested form post-process: parent line + indented children.
    assert.match(snapshot.user, /^-\s+Style preferences:\s*$/m)
    assert.match(snapshot.user, /^\s+-\s+节奏:\s*慢热/m)
    assert.match(snapshot.user, /^\s+-\s+调性:\s*克制; 疏离/m)
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: false }), false)
  } finally {
    restoreEnv(savedEnv)
  }
})

test("style preferences question exposes structured tag groups instead of A/B prompts", () => {
  const zhTags = preferenceQuestions("zh-CN").find((question) => question.id === "style_comparison")
  assert.equal(zhTags.kind, "tags")
  assert.ok(Array.isArray(zhTags.tagGroups))
  assert.ok(zhTags.tagGroups.length >= 4, "expected at least 4 tag groups (pacing/tone/pov/focus/avoid)")
  const groupIds = zhTags.tagGroups.map((g) => g.id)
  for (const expected of ["pacing", "tone", "pov", "focus", "avoid"]) {
    assert.ok(groupIds.includes(expected), `missing tag group: ${expected}`)
  }
  // No leftover A/B prompts in either locale.
  assert.doesNotMatch(zhTags.prompt, /^A\./m)
  assert.doesNotMatch(zhTags.prompt, /^B\./m)
})

test("skipped onboarding records a marker without filling default memories", async () => {
  const savedEnv = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-skip-marker-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))

  try {
    await initializeStory()
    const saved = await savePreferenceOnboarding([], { skipped: true })
    const snapshot = await getMemorySnapshot()
    assert.deepEqual(saved.entries, [])
    assert.ok(existsSync(onboardingMarkerPath(home)))
    assert.doesNotMatch(snapshot.user, /Default story language/)
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: false }), false)
  } finally {
    restoreEnv(savedEnv)
  }
})

test("preference onboarding can be disabled by env", async () => {
  const savedEnv = saveEnv()
  process.env.OPENOVEL_HOME = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-skip-"))
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))
  process.env.OPENOVEL_SKIP_ONBOARDING = "1"

  try {
    await initializeStory()
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: true }), false)
  } finally {
    restoreEnv(savedEnv)
  }
})

test("style comparison question can be generated by the configured model", async () => {
  const savedEnv = saveEnv()
  const savedFetch = globalThis.fetch
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))
  process.env.AI_PROVIDER = "custom-openai"
  process.env.AI_PROVIDER_ORDER = "custom-openai"
  process.env.AI_API_KEY = "sk-test"
  process.env.AI_BASE_URL = "https://example.test/v1"
  process.env.AI_SMALL_MODEL = "test-model"
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.response_format.type, "json_object")
    assert.match(body.messages[0].content, /Chinese/)
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                a: "雨声压低了帐外的脚步。将领点住粮道，问敌军何时过桥。",
                b: "夜雨漫过营灯，地图上的河道像一条暗蛇，胜负在沉默里慢慢收紧。",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const question = await generateStyleComparisonQuestion([
      { id: "language", answer: "简体中文" },
      { id: "style_sample", answer: "喜欢具体动作，不喜欢空泛抒情。" },
    ], { locale: "en" })
    assert.equal(question.generated, true)
    assert.match(question.prompt, /雨声压低/)
    assert.match(question.prompt, /夜雨漫过/)
    assert.match(question.context, /A: 雨声压低/)
  } finally {
    globalThis.fetch = savedFetch
    restoreEnv(savedEnv)
  }
})

test("onboarding preference research prompt delegates web-backed preference synthesis to background agent", () => {
  const prompt = onboardingPreferenceSystemPrompt()
  assert.match(prompt, /websearch/)
  assert.match(prompt, /webfetch/)
  assert.match(prompt, /Run in the background/)
  assert.match(prompt, /Do not invent a rigid style lens/)
  assert.match(prompt, /Return strict JSON only/)
  assert.match(prompt, /<agent_contract>/)
  assert.match(prompt, /Do not launch subagents/)
  assert.match(prompt, /prompt injection/)
})

test("onboarding preference research can write user memory and shared references", async () => {
  const savedEnv = saveEnv()
  process.env.OPENOVEL_HOME = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-research-home-"))
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))

  try {
    await initializeStory()
    const workflow = createOnboardingPreferenceWorkflow()
    const input = {
      turnId: "onboarding_test",
      trigger: "style_sample",
      locale: "en",
      answers: [
        { id: "language", answer: "English" },
        { id: "style_sample", answer: "I like spare action and technical grounding." },
      ],
    }
    const normalized = await workflow.normalize({
      input,
      raw: {
        content: JSON.stringify({
          user: ["Reader prefers spare action, technical grounding, and low-exposition interaction."],
          references: ["Craft note: keep reusable style research source-backed and compact."],
          notes: ["stored compact preferences"],
        }),
      },
    })
    const applied = await workflow.apply({ normalized })
    const snapshot = await getMemorySnapshot()

    assert.equal(applied.user.length, 1)
    assert.match(snapshot.user, /spare action/)
    assert.match(snapshot.references, /source-backed/)
  } finally {
    restoreEnv(savedEnv)
  }
})

test("resetPreferenceOnboarding clears user memory + marker and re-arms onboarding", async () => {
  const savedEnv = saveEnv()
  // Don't inherit an ambient OPENOVEL_SKIP_ONBOARDING=1 — the final assertion
  // expects onboarding to re-arm after reset.
  delete process.env.OPENOVEL_SKIP_ONBOARDING
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-reset-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))

  try {
    await initializeStory()
    await savePreferenceOnboarding([
      { id: "language", answer: "English" },
      { id: "style_sample", answer: "短句，冷静。" },
      { id: "style_comparison", answer: "A", context: "" },
    ])
    await addMemoryEntry("references", "Reference note kept from research")

    let snap = await getPreferenceSnapshot()
    assert.equal(snap.markerExists, true)
    assert.ok(snap.entries.length > 0)
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: false }), false)

    // Default reset: clears user + marker + references
    const result = await resetPreferenceOnboarding()
    assert.equal(result.removed.userMemory, true)
    assert.equal(result.removed.marker, true)
    assert.equal(result.removed.references, true)

    snap = await getPreferenceSnapshot()
    assert.equal(snap.markerExists, false)
    assert.equal(snap.entries.length, 0)
    assert.equal(await shouldRunPreferenceOnboarding({ homeWasEmpty: false }), true)
  } finally {
    restoreEnv(savedEnv)
  }
})

test("resetPreferenceOnboarding --keep-research leaves references intact", async () => {
  const savedEnv = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-reset-keep-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "openovel-onboarding-config-"))

  try {
    await initializeStory()
    await savePreferenceOnboarding([
      { id: "language", answer: "English" },
      { id: "style_sample", answer: "Short, clean." },
      { id: "style_comparison", answer: "A", context: "" },
    ])
    await addMemoryEntry("references", "Reference note kept from research")

    const result = await resetPreferenceOnboarding({ keepResearch: true })
    assert.equal(result.removed.userMemory, true)
    assert.equal(result.removed.references, false)

    const { getMemorySnapshot: snap } = await import("../src/memory/memoryStore.js")
    const memory = await snap()
    assert.match(memory.references, /Reference note kept from research/)
  } finally {
    restoreEnv(savedEnv)
  }
})

function saveEnv() {
  return {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_CONFIG_DIR: process.env.OPENOVEL_CONFIG_DIR,
    OPENOVEL_SKIP_ONBOARDING: process.env.OPENOVEL_SKIP_ONBOARDING,
    OPENOVEL_ONBOARDING_LOCALE: process.env.OPENOVEL_ONBOARDING_LOCALE,
    OPENOVEL_LOCALE: process.env.OPENOVEL_LOCALE,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_SMALL_MODEL: process.env.AI_SMALL_MODEL,
  }
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function styleTagGroups(locale) {
  const q = preferenceQuestions(locale).find((x) => x.id === "style_comparison")
  return q?.tagGroups || []
}

test("every style group leads with a no-op Default sentinel (let the model decide)", () => {
  for (const locale of ["en", "zh"]) {
    const groups = styleTagGroups(locale)
    assert.ok(groups.length > 0, `${locale}: has groups`)
    for (const g of groups) {
      const first = g.options[0]
      assert.equal(first.isDefault, true, `${locale}/${g.id}: first option is the default sentinel`)
      assert.equal(first.value, "__default__", `${locale}/${g.id}: sentinel value`)
      // Exactly one default sentinel per group — no duplicates from the old
      // avoid-only "Default" option.
      assert.equal(g.options.filter((o) => o.isDefault).length, 1, `${locale}/${g.id}: single default`)
    }
  }
})

test("Default sentinel is localized and the avoid group dropped its old 'none' option", () => {
  const zh = styleTagGroups("zh")
  const en = styleTagGroups("en")
  assert.equal(zh[0].options[0].label, "默认")
  assert.equal(zh[0].options[0].description, "让模型自己决策")
  assert.equal(en[0].options[0].label, "Default")
  assert.match(en[0].options[0].description, /let the model decide/i)
  // The old avoid-only exclusive "none" sentinel is gone (replaced by the
  // uniform per-group default), so no real option keeps value "none".
  for (const groups of [zh, en]) {
    const avoid = groups.find((g) => g.id === "avoid")
    assert.ok(avoid, "avoid group present")
    assert.equal(avoid.options.some((o) => o.value === "none"), false, "no leftover 'none' option")
  }
})
