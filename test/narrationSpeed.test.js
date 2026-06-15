import test from "node:test"
import assert from "node:assert/strict"

import { SessionViewModel } from "../src/runtime/sessionViewModel.js"

// The Settings → Display speed slider persists in electron prefs and is pushed
// into the VM via dispatch("setNarrationCpm", …). The revealer reads
// state.pacing.cpm every tick, so the patch must update that live.
test("setNarrationCpm updates pacing.cpm live and mirrors to env", () => {
  const env = {}
  const vm = new SessionViewModel({ env })
  assert.equal(vm.getState().pacing.cpm, 720) // default

  vm.setNarrationCpm(1200)
  assert.equal(vm.getState().pacing.cpm, 1200)
  assert.equal(env.OPENOVEL_DISPLAY_CPM, "1200")
})

test("setNarrationCpm clamps to the revealer's safe range [120, 2400]", () => {
  const vm = new SessionViewModel({ env: {} })
  vm.setNarrationCpm(999999)
  assert.equal(vm.getState().pacing.cpm, 2400)
  vm.setNarrationCpm(1)
  assert.equal(vm.getState().pacing.cpm, 120)
})

test("setNarrationCpm ignores non-finite input (keeps current speed)", () => {
  const vm = new SessionViewModel({ env: {} })
  const before = vm.getState().pacing.cpm
  for (const bad of ["abc", null, undefined, NaN]) vm.setNarrationCpm(bad)
  assert.equal(vm.getState().pacing.cpm, before)
})

test("setNarrationCpm with cpm <= 0 disables pacing (unlimited) and preserves cpm", () => {
  const vm = new SessionViewModel({ env: {} })
  vm.setNarrationCpm(960)
  const cpm = vm.getState().pacing.cpm
  for (const sentinel of [0, -5]) {
    vm.setNarrationCpm(sentinel)
    assert.equal(vm.getState().pacing.enabled, false)
    assert.equal(vm.getState().pacing.cpm, cpm) // last finite speed is retained
  }
  // A positive value re-enables pacing at the new speed.
  vm.setNarrationCpm(1200)
  assert.equal(vm.getState().pacing.enabled, true)
  assert.equal(vm.getState().pacing.cpm, 1200)
})

test("setNarrationCpm preserves the rest of the pacing object", () => {
  const vm = new SessionViewModel({ env: {} })
  const before = vm.getState().pacing
  vm.setNarrationCpm(960)
  const after = vm.getState().pacing
  assert.equal(after.enabled, before.enabled)
  assert.equal(after.frameMs, before.frameMs)
  assert.equal(after.wpm, before.wpm)
  assert.equal(after.cpm, 960)
})
