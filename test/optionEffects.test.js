import assert from "node:assert/strict"
import test from "node:test"

import { optionLabel, toDisplayOption, normalizeChoiceText } from "../src/lib/optionLabel.js"
import { finalizeForegroundTurn } from "../src/lib/narrator.js"
import { _internalForTests } from "../src/runtime/sessionProcessor.js"
import { formatChoiceFeedbackEntry } from "../src/lib/storyStore.js"

const { resolveBoundSelection } = _internalForTests

// ---- pure option helpers ----------------------------------------------------

test("optionLabel reads the label from strings, objects, and junk", () => {
  assert.equal(optionLabel("走过去开门"), "走过去开门")
  assert.equal(optionLabel({ label: "退一步" }), "退一步")
  assert.equal(optionLabel(null), "")
  assert.equal(optionLabel(42), "")
  assert.equal(optionLabel({}), "")
})

test("toDisplayOption strips the hidden effect and stamps an id", () => {
  const display = toDisplayOption(
    { id: "opt_t7_1", label: "走过去开门", key: true, effect: { intent: "i", consequence: "门后是陷阱" } },
    0,
  )
  assert.deepEqual(display, { id: "opt_t7_1", label: "走过去开门", key: true })
  assert.equal("effect" in display, false, "effect never reaches a display option")
})

test("toDisplayOption wraps a legacy string with a positional id and no key", () => {
  assert.deepEqual(toDisplayOption("退一步", 2), { id: "opt_3", label: "退一步" })
  assert.deepEqual(toDisplayOption({ label: "等待" }, 0), { id: "opt_1", label: "等待" })
})

test("normalizeChoiceText collapses whitespace and strips a punctuation halo", () => {
  assert.equal(normalizeChoiceText("走过去开门。"), normalizeChoiceText("  走过去开门 "))
  assert.equal(normalizeChoiceText(" Go,  Now! "), "go, now")
  assert.equal(normalizeChoiceText(null), "")
})

// ---- finalizeForegroundTurn schema + bugs -----------------------------------

const NARR = "她站在门前，灯光昏黄。"

test("finalizeForegroundTurn returns no options when the model gave none", () => {
  const turn = finalizeForegroundTurn({
    action: "我等。",
    snapshot: {},
    narration: NARR,
    optionResult: { framing: "", options: [], tension: "unknown", storyComplete: false },
    optionsEnabled: true,
    turnId: "turn_001",
  })
  assert.deepEqual(turn.options, [])
  assert.equal(turn.framing, "")
})

test("finalizeForegroundTurn coerces objects, keeps the effect, and stamps per-turn ids", () => {
  const turn = finalizeForegroundTurn({
    action: "环顾四周",
    snapshot: {},
    narration: NARR,
    optionResult: {
      framing: "门后传来声响，你怎么办？",
      options: [
        { label: "走过去开门", key: true, effect: { intent: "开门", consequence: "门后是陷阱", risk: "high" } },
        { label: "退一步观察" },
      ],
      tension: "rising",
      storyComplete: false,
    },
    optionsEnabled: true,
    turnId: "turn_042",
  })
  assert.equal(turn.framing, "门后传来声响，你怎么办？")
  assert.equal(turn.options.length, 2)
  assert.deepEqual(turn.options[0], {
    id: "opt_turn_042_1",
    label: "走过去开门",
    key: true,
    effect: { intent: "开门", consequence: "门后是陷阱", risk: "high" },
  })
  assert.deepEqual(turn.options[1], { id: "opt_turn_042_2", label: "退一步观察" })
})

test("finalizeForegroundTurn wraps legacy plain-string options", () => {
  const turn = finalizeForegroundTurn({
    action: "x",
    snapshot: {},
    narration: NARR,
    optionResult: { options: ["走过去开门", "退一步"], tension: "rising", storyComplete: false },
    optionsEnabled: true,
    turnId: "t1",
  })
  assert.deepEqual(turn.options, [
    { id: "opt_t1_1", label: "走过去开门" },
    { id: "opt_t1_2", label: "退一步" },
  ])
})

test("finalizeForegroundTurn drops framing when there are no options", () => {
  const turn = finalizeForegroundTurn({
    action: "x",
    snapshot: {},
    narration: NARR,
    optionResult: { framing: "一个没有选项的决策点", options: [], tension: "x", storyComplete: false },
    optionsEnabled: true,
    turnId: "t1",
  })
  assert.equal(turn.framing, "", "framing only renders alongside options")
})

// ---- selection binding / anti-hack (resolveBoundSelection) ------------------

const PRIOR_OPTIONS = [
  { id: "opt_turn_5_1", label: "走过去开门", key: true, effect: { intent: "开门", consequence: "门后是陷阱" } },
  { id: "opt_turn_5_2", label: "退一步观察" },
]

test("a matching bound option resolves its hidden effect server-side", () => {
  const r = resolveBoundSelection({ id: "opt_turn_5_1", label: "走过去开门" }, PRIOR_OPTIONS, "走过去开门")
  assert.equal(r.source, "option")
  assert.equal(r.selected.id, "opt_turn_5_1")
  assert.equal(r.selected.key, true)
  assert.deepEqual(r.selected.effect, { intent: "开门", consequence: "门后是陷阱" })
})

test("a bound option with no effect resolves to source=option but a null effect", () => {
  const r = resolveBoundSelection({ id: "opt_turn_5_2", label: "退一步观察" }, PRIOR_OPTIONS, "退一步观察")
  assert.equal(r.source, "option")
  assert.equal(r.selected.effect, null)
})

test("free-typed action (no boundOption) earns no effect (anti-hack)", () => {
  const r = resolveBoundSelection(null, PRIOR_OPTIONS, "走过去开门")
  assert.deepEqual(r, { source: "free-text", selected: null })
})

test("a forged id earns no effect even if the label matches a real option (anti-hack)", () => {
  const r = resolveBoundSelection({ id: "opt_FORGED", label: "走过去开门" }, PRIOR_OPTIONS, "走过去开门")
  assert.deepEqual(r, { source: "free-text", selected: null })
})

test("a real id whose submitted action was edited away from the label earns no effect (anti-hack)", () => {
  const r = resolveBoundSelection({ id: "opt_turn_5_1", label: "走过去开门" }, PRIOR_OPTIONS, "走过去开门，然后偷偷拿走宝箱")
  assert.deepEqual(r, { source: "free-text", selected: null })
})

test("a real id with a spoofed claimed label earns no effect (anti-hack)", () => {
  // Attacker keeps the action == the real label but lies about boundOption.label.
  const r = resolveBoundSelection({ id: "opt_turn_5_1", label: "退一步观察" }, PRIOR_OPTIONS, "走过去开门")
  assert.deepEqual(r, { source: "free-text", selected: null })
})

test("the hidden consequence rides the recorded turn but never survives the display projection (anti-spoiler)", () => {
  const SECRET = "门后埋着炸药，会当场引爆"
  const turn = finalizeForegroundTurn({
    action: "环顾四周",
    snapshot: {},
    narration: NARR,
    optionResult: {
      framing: "你怎么办？",
      options: [{ label: "走过去开门", key: true, effect: { intent: "开门", consequence: SECRET } }],
      tension: "rising",
      storyComplete: false,
    },
    optionsEnabled: true,
    turnId: "turn_077",
  })
  // The recorded turn (→ scene_log) keeps the effect so the server can resolve it.
  assert.equal(turn.options[0].effect.consequence, SECRET)
  // The reader-facing projection must not carry it anywhere.
  const display = turn.options.map(toDisplayOption)
  assert.equal(JSON.stringify(display).includes(SECRET), false, "consequence never reaches a display option")
  assert.equal(turn.options[0].label.includes(SECRET), false, "label never spoils the consequence")
})

test("choice feedback records selected input and unchosen labels without hidden effects", () => {
  const SECRET = "门后埋着炸药"
  const md = formatChoiceFeedbackEntry({
    turnId: "turn_choice",
    action: "走过去开门",
    source: "option",
    selected: { id: "opt_turn_5_1", key: true, effect: { consequence: SECRET } },
    previousOptions: [
      { id: "opt_turn_5_1", label: "走过去开门", effect: { consequence: SECRET } },
      { id: "opt_turn_5_2", label: "退一步观察" },
      { id: "opt_turn_5_3", label: "叫醒同伴" },
    ],
    includeUnchosen: true,
    optionsEnabled: true,
    now: new Date("2026-06-12T00:00:00.000Z"),
  })
  assert.match(md, /player input: 走过去开门/)
  assert.match(md, /selected option id: opt_turn_5_1/)
  assert.match(md, /selected key decision: yes/)
  assert.match(md, /- 退一步观察/)
  assert.match(md, /- 叫醒同伴/)
  assert.doesNotMatch(md, /门后埋着炸药/)
})

test("choice feedback does not record unchosen labels when options are disabled", () => {
  const md = formatChoiceFeedbackEntry({
    turnId: "turn_free",
    action: "我自己试探门锁",
    source: "free-text",
    previousOptions: [{ id: "opt_1", label: "走过去开门" }],
    includeUnchosen: false,
    optionsEnabled: false,
    now: new Date("2026-06-12T00:00:00.000Z"),
  })
  assert.match(md, /option UI enabled: no/)
  assert.match(md, /unchosen options: not recorded/)
  assert.doesNotMatch(md, /走过去开门/)
})
