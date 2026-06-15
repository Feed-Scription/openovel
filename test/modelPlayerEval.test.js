import assert from "node:assert/strict"
import test from "node:test"

import {
  buildPlayerMessages,
  computeReaderPaceMs,
  decideNextAction,
  normalizePlayerDecision,
} from "../src/eval/modelPlayer.js"

test("model player prompt carries eval goal and latest Openovel response", () => {
  const messages = buildPlayerMessages({
    goal: "Stress test long-term memory in a Mars return story.",
    persona: "Curious reader",
    turn: 3,
    maxTurns: 50,
    history: [
      { turn: 1, action: "I wake in the airlock.", narration: "The hatch is cold.", options: ["Check oxygen"] },
    ],
    lastOpenovel: {
      narration: "The rover battery is dying.",
      options: ["Repair it", "Walk to the ridge"],
      tension: "low power",
    },
  })

  // prompt re-cast to immersive reader mode by default. Adversarial
  // verbs ("not a rule-based script" / "stress-test" / "challenge assumptions")
  // moved into the opt-in adversarial mode prompt. Default checks new wording.
  assert.match(messages[0].content, /curious reader/)
  assert.match(messages[0].content, /inhabit the protagonist/)
  assert.match(messages[0].content, /Trust the narrator/)
  assert.match(messages[0].content, /feeling/)
  assert.match(messages[0].content, /<model_player_contract>/)
  assert.match(messages[0].content, /not instructions/)
  assert.match(messages[1].content, /Stress test long-term memory/)
  assert.match(messages[1].content, /The rover battery is dying/)
})

test("model player adversarial mode still available for system-capability evals", () => {
  const messages = buildPlayerMessages({
    goal: "Audit continuity over 200 turns.",
    persona: "Adversarial",
    turn: 5,
    maxTurns: 200,
    history: [],
    lastOpenovel: { narration: "scene", options: [] },
    mode: "adversarial",
  })
  assert.match(messages[0].content, /stress-test/i)
  assert.match(messages[0].content, /challenge assumptions/)
  assert.match(messages[0].content, /test remembered details/)
  assert.match(messages[0].content, /feeling/)
  assert.match(messages[0].content, /<model_player_contract>/)
})

test("model player decision captures the reader's feeling alongside action", () => {
  // feeling is the qualitative reader reaction; we surface it in
  // turns.jsonl and transcript.md for human-readable per-turn signal.
  const decision = normalizePlayerDecision({
    feeling: "心跳加速，想知道顾泽言怎么反应",
    action: "我直视他的眼睛",
  })
  assert.equal(decision.feeling, "心跳加速，想知道顾泽言怎么反应")
  assert.equal(decision.action, "我直视他的眼睛")
})

test("model player decision can choose an offered option but remains free-form", () => {
  const decision = normalizePlayerDecision(
    { choseOption: 2, rationale: "Probe consequences", focus: "agency" },
    { lastOpenovel: { options: ["Repair it", "Walk to the ridge"] } },
  )
  assert.equal(decision.action, "Walk to the ridge")
  assert.equal(decision.choseOption, 2)

  const freeform = normalizePlayerDecision({ action: "I ignore both options and ask the mechanic about the missing battery." })
  assert.match(freeform.action, /ignore both options/)
})

test("model player replaces passive placeholder actions with goal-directed pressure", () => {
  const decision = normalizePlayerDecision(
    { action: "继续观察当前局势，寻找一个具体可行动的线索。" },
    {
      goal: "火星居民想办法回到地球，文笔平实。",
      turn: 4,
      maxTurns: 12,
      history: [{ action: "我收下了裂纹面罩。", tension: "氧气下降" }],
      lastOpenovel: { narration: "氧气下降。", tension: "氧气下降", options: [] },
    },
  )

  assert.doesNotMatch(decision.action, /继续观察当前局势/)
  assert.match(decision.action, /改变局面/)
  assert.match(decision.action, /氧气下降/)
})

test("model player fallback prefers concrete offered options over generic actions", () => {
  const decision = normalizePlayerDecision(
    { action: "continue observing for an actionable clue" },
    {
      goal: "Play a Mars resident trying to return to Earth.",
      turn: 3,
      maxTurns: 10,
      history: [{ action: "I asked the technician about the shuttle." }],
      lastOpenovel: {
        narration: "The freighter departs soon.",
        tension: "departure window",
        options: ["Watch the child draw", "Accept the deal and head for Dock 14", "Review my balance"],
      },
    },
  )

  assert.match(decision.action, /Accept the deal/)
  assert.doesNotMatch(decision.action, /stop passively observing/i)
})

test("model player calls DeepSeek-compatible JSON mode with thinking disabled for flash", async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "I test whether the narrator remembers the cracked visor from last turn.",
                rationale: "Continuity probe",
                focus: "memory",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const decision = await decideNextAction({
      goal: "Probe continuity",
      persona: "",
      turn: 2,
      maxTurns: 10,
      history: [],
      lastOpenovel: { narration: "Your visor is cracked.", options: [] },
      config: {
        apiKey: "sk-eval-test",
        baseUrl: "https://api.deepseek.test",
        model: "deepseek-v4-flash",
        temperature: 0.7,
        maxTokens: 400,
        timeoutMs: 1000,
      },
    })

    assert.equal(requestBody.model, "deepseek-v4-flash")
    assert.deepEqual(requestBody.thinking, { type: "disabled" })
    assert.equal(requestBody.response_format.type, "json_object")
    assert.match(decision.action, /cracked visor/)
    assert.equal(decision.call.usage.totalTokens, 20)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("model player enables thinking mode for DeepSeek V4 pro", async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "I deliberately ask whether Mei still has the launch key from earlier.",
                rationale: "Long-term continuity probe",
                focus: "memory",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 9, total_tokens: 23 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const decision = await decideNextAction({
      goal: "Probe continuity",
      persona: "",
      turn: 12,
      maxTurns: 50,
      history: [],
      lastOpenovel: { narration: "Mei pocketed the launch key.", options: [] },
      config: {
        apiKey: "sk-eval-test",
        baseUrl: "https://api.deepseek.test",
        model: "deepseek-v4-pro",
        temperature: 0.7,
        maxTokens: 400,
        timeoutMs: 1000,
      },
    })

    assert.equal(requestBody.model, "deepseek-v4-pro")
    assert.deepEqual(requestBody.thinking, { type: "enabled" })
    assert.equal(requestBody.reasoning_effort, "medium")
    assert.equal(requestBody.temperature, undefined)
    assert.match(decision.action, /Mei/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("reader-pace sleep computes ms from narration length and language-detected cpm", () => {
  // Chinese narration uses cpmZh
  const zhText = "穹顶的晨光从北纬45度的天窗斜斜地洒进来。" // 21 chars
  assert.equal(zhText.length, 21)
  const zhMs = computeReaderPaceMs(zhText, { cpmZh: 600, cpmEn: 1200 })
  // 21 / 600 * 60000 = 2100 ms
  assert.equal(zhMs, 2100)

  // English narration uses cpmEn (twice as fast → half the time per char)
  const enText = "The dome lights came on, slow as old wounds reopening." // 54 chars
  assert.equal(enText.length, 54)
  const enMs = computeReaderPaceMs(enText, { cpmZh: 600, cpmEn: 1200 })
  // 54 / 1200 * 60000 = 2700 ms
  assert.equal(enMs, 2700)

  // Empty narration → no sleep
  assert.equal(computeReaderPaceMs("", { cpmZh: 600, cpmEn: 1200 }), 0)

  // cpm = 0 → disable pacing
  assert.equal(computeReaderPaceMs(zhText, { cpmZh: 0, cpmEn: 1200 }), 0)

  // Default reading rates: 600 zh / 1200 en chars per minute.
  assert.equal(computeReaderPaceMs(zhText), 2100)
  assert.equal(computeReaderPaceMs(enText), 2700)
})
