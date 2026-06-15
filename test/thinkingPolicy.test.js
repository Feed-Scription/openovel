import test from "node:test"
import assert from "node:assert/strict"

import { profileThinkingHint } from "../src/provider/modelProfiles.js"
import { kimiCodeProvider } from "../src/provider/plugins/kimiCode.js"
import { deepseekProvider } from "../src/provider/plugins/deepseek.js"

test("thinking policy: agents ON, fast single-shot calls OFF", () => {
  // agents → enabled
  for (const p of ["storykeeper", "subagent", "subagent-research", "subagent-continuity", "subagent-planner", "large", "background"]) {
    assert.equal(profileThinkingHint(p), "enabled", `${p} should think`)
  }
  // fast / single-shot → disabled
  for (const p of ["narrator", "foreground", "small", "signal", "memory", "summary", "compaction", "webfetch", "foreground-options", "unknown-profile"]) {
    assert.equal(profileThinkingHint(p), "disabled", `${p} should NOT think`)
  }
})

test("kimi bodyTransform: per-call hint overrides the KIMI_THINKING env default", () => {
  const saved = process.env.KIMI_THINKING
  try {
    // env says off, but an agent call hints enabled → thinking on
    process.env.KIMI_THINKING = "off"
    let body = kimiCodeProvider.bodyTransform({ model: "kimi-for-coding" }, { thinking: "enabled" })
    assert.equal(body.thinking.type, "enabled")
    assert.ok(body.reasoning_effort)
    // env says high, but a narrator call hints disabled → thinking off
    process.env.KIMI_THINKING = "high"
    body = kimiCodeProvider.bodyTransform({ model: "kimi-for-coding" }, { thinking: "disabled" })
    assert.equal(body.thinking.type, "disabled")
    assert.equal(body.reasoning_effort, undefined)
    // no hint → fall back to env (high → enabled)
    body = kimiCodeProvider.bodyTransform({ model: "kimi-for-coding" }, {})
    assert.equal(body.thinking.type, "enabled")
  } finally {
    if (saved === undefined) delete process.env.KIMI_THINKING
    else process.env.KIMI_THINKING = saved
  }
})

test("deepseek bodyTransform: hint honored on capable models, vetoed on flash", () => {
  // flash can't think — stays disabled even when hinted enabled
  const flash = deepseekProvider.bodyTransform({ model: "deepseek-v4-flash", temperature: 0.8 }, { thinking: "enabled" })
  assert.equal(flash.thinking.type, "disabled")
  // pro honors enabled hint (and drops temperature per deepseek's protocol)
  const proOn = deepseekProvider.bodyTransform({ model: "deepseek-v4-pro", temperature: 0.8 }, { thinking: "enabled" })
  assert.equal(proOn.thinking.type, "enabled")
  assert.equal(proOn.temperature, undefined)
  assert.ok(proOn.reasoning_effort)
  // pro honors disabled hint (narrator on a pro model stays non-thinking)
  const proOff = deepseekProvider.bodyTransform({ model: "deepseek-v4-pro", temperature: 0.8 }, { thinking: "disabled" })
  assert.equal(proOff.thinking.type, "disabled")
})
