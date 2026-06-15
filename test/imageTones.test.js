import test from "node:test"
import assert from "node:assert/strict"

import { computeBackdropTreatment, effectiveHeaderLuma } from "../src/electron/renderer/lib/imageTones.js"

const VAR_KEYS = [
  "--backdrop-img-filter",
  "--backdrop-center-blur",
  "--backdrop-veil-edge",
  "--backdrop-veil-shoulder",
  "--backdrop-veil-center",
]

const num = (s) => Number.parseFloat(s)

test("computeBackdropTreatment: empty profile yields a complete, finite fallback treatment", () => {
  const t = computeBackdropTreatment({})
  for (const key of VAR_KEYS) {
    assert.equal(typeof t[key], "string", key)
  }
  assert.match(t["--backdrop-center-blur"], /px$/)
  assert.match(t["--backdrop-veil-center"], /%$/)
  for (const key of VAR_KEYS.slice(1)) {
    assert.ok(Number.isFinite(num(t[key])), `${key} is finite`)
  }
})

test("computeBackdropTreatment: dark worst-case centers get a heavier veil and defocus than pale ones", () => {
  const dark = computeBackdropTreatment({
    overallLuma: 0.45, centerLuma: 0.34, edgeLuma: 0.5, centerLumaP10: 0.18, centerBusyness: 0.05,
  })
  const pale = computeBackdropTreatment({
    overallLuma: 0.74, centerLuma: 0.7, edgeLuma: 0.82, centerLumaP10: 0.6, centerBusyness: 0.05,
  })
  // The texture floor often dominates the veil for both; the dark worst case
  // must never get LESS, and always gets more defocus (dark-region boost).
  assert.ok(num(dark["--backdrop-veil-center"]) >= num(pale["--backdrop-veil-center"]))
  assert.ok(num(dark["--backdrop-center-blur"]) > num(pale["--backdrop-center-blur"]))
})

test("computeBackdropTreatment: busier centers get more defocus and at least as much veil", () => {
  const flat = computeBackdropTreatment({
    overallLuma: 0.6, centerLuma: 0.58, edgeLuma: 0.62, centerLumaP10: 0.45, centerBusyness: 0.02,
  })
  const busy = computeBackdropTreatment({
    overallLuma: 0.6, centerLuma: 0.58, edgeLuma: 0.62, centerLumaP10: 0.45, centerBusyness: 0.12,
  })
  assert.ok(num(busy["--backdrop-center-blur"]) > num(flat["--backdrop-center-blur"]))
  assert.ok(num(busy["--backdrop-veil-center"]) >= num(flat["--backdrop-veil-center"]))
})

test("computeBackdropTreatment: pale margins keep a light edge wash, dark margins a heavy one", () => {
  const pale = computeBackdropTreatment({ overallLuma: 0.74, centerLuma: 0.7, edgeLuma: 0.86, centerLumaP10: 0.6, centerBusyness: 0.03 })
  const dark = computeBackdropTreatment({ overallLuma: 0.5, centerLuma: 0.5, edgeLuma: 0.45, centerLumaP10: 0.3, centerBusyness: 0.06 })
  assert.ok(num(pale["--backdrop-veil-edge"]) <= 6)
  assert.ok(num(dark["--backdrop-veil-edge"]) >= 20)
  // shoulder always sits between edge and center
  for (const t of [pale, dark]) {
    const edge = num(t["--backdrop-veil-edge"])
    const shoulder = num(t["--backdrop-veil-shoulder"])
    const center = num(t["--backdrop-veil-center"])
    assert.ok(shoulder > edge && shoulder < center)
  }
})

test("computeBackdropTreatment: outputs stay clamped at the extremes", () => {
  const extremeDark = computeBackdropTreatment({
    overallLuma: 0.05, centerLuma: 0.05, edgeLuma: 0.05, centerLumaP10: 0, centerBusyness: 1,
  })
  const extremeBright = computeBackdropTreatment({
    overallLuma: 0.98, centerLuma: 0.98, edgeLuma: 0.98, centerLumaP10: 0.95, centerBusyness: 0,
  })
  for (const t of [extremeDark, extremeBright]) {
    const blur = num(t["--backdrop-center-blur"])
    const center = num(t["--backdrop-veil-center"])
    assert.ok(blur >= 5 && blur <= 10, `blur ${blur} in range`)
    assert.ok(center >= 84 && center <= 96, `center veil ${center} in range`)
  }
})

test("effectiveHeaderLuma: a dark image top still reads as a light header surface", () => {
  // Regression: the HUD flipped to white text over a dark RAW top, but the
  // host's top mask + veil render that strip near-paper — white on white.
  // The effective surface stays light even for a black image top.
  assert.ok(effectiveHeaderLuma(0) > 0.5)
  assert.ok(effectiveHeaderLuma(0.95) > effectiveHeaderLuma(0))
  assert.ok(Number.isFinite(effectiveHeaderLuma(undefined)))
})

test("computeBackdropTreatment: the veiled center keeps the target contrast against body ink", () => {
  // Mirrors the solve: color-mix(in srgb) blends gamma-encoded values, contrast
  // is checked in (approximately) linear light. Light theme constants.
  const PAPER = 0.957
  const INK = 0.1
  const TARGET = 13
  const toLinear = (l) => Math.pow(l, 2.2)
  for (const p10 of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    const t = computeBackdropTreatment({
      overallLuma: 0.55, centerLuma: Math.max(0.4, p10 + 0.1), edgeLuma: 0.6,
      centerLumaP10: p10, centerBusyness: 0.04,
    })
    const veil = num(t["--backdrop-veil-center"]) / 100
    const effective = PAPER * veil + p10 * (1 - veil)
    const ratio = (toLinear(effective) + 0.05) / (toLinear(INK) + 0.05)
    assert.ok(ratio >= TARGET - 0.35, `p10=${p10}: contrast ${ratio.toFixed(2)} >= ~${TARGET}`)
  }
})
