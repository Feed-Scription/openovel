// Sample a scene-backdrop image into a small tone profile:
//   - topTone flips HUD/chrome over the EFFECTIVE header surface (raw top luma
//     attenuated by the host's top mask toward paper — see effectiveHeaderLuma).
//   - the band lumas + center-band stats feed computeBackdropTreatment, which
//     turns them into the continuous veil/blur CSS variables for the host scrim.
// Sibling of the story-card cover sampler in StorySelector.jsx (same luma
// approach, different bands/serving): this one fetches through blob: first
// because backdrop bytes arrive via the privileged ovl-asset:// scheme, whose
// non-standard origin would taint a canvas and make getImageData throw — a blob:
// URL keeps the canvas readable.

import { useEffect, useState } from "react"

const FALLBACK_PROFILE = Object.freeze({
  topTone: "light",
  overallLuma: 0.62,
  centerLuma: 0.62,
  edgeLuma: 0.62,
  centerLumaP10: 0.5,
  centerBusyness: 0.05,
})

const profileCache = new Map() // src → tone profile
const pendingProfiles = new Map() // src → Promise<tone profile>

async function loadReadableUrl(src) {
  if (/^data:/i.test(src)) return { url: src, revoke: null }
  const res = await fetch(src)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}

function toneFromLuma(luma, threshold = 0.5) {
  return Number(luma) < threshold ? "dark" : "light"
}

// HUD tone decision: the HUD does NOT sit on the raw image. The host mask
// dissolves the backdrop under the header strip (transparent at 0 → opaque at
// 220px, theme.css .scene-backdrop), and the paper veil sits on what remains,
// so the surface behind the HUD stays mostly paper even when the image's top
// is black. Judging the RAW top luma flipped the HUD to near-white text over
// that near-white surface (invisible). Tone for the EFFECTIVE surface instead:
// blend the raw top luma toward paper by the mask's mean image alpha over the
// header strip (~0.13). Light themes only, like TREATMENT_DEFAULTS.
const HEADER_IMAGE_ALPHA = 0.13
export function effectiveHeaderLuma(topLuma) {
  const top = Number.isFinite(Number(topLuma)) ? Number(topLuma) : TREATMENT_DEFAULTS.paperLuma
  return TREATMENT_DEFAULTS.paperLuma * (1 - HEADER_IMAGE_ALPHA) + top * HEADER_IMAGE_ALPHA
}

// Theme lumas the contrast solve assumes (light themes only for now: --paper
// #f4f4f4 / --ink #1c1917). When dark themes land, the caller must read the
// computed theme colors and pass real lumas — the solve direction inverts.
const TREATMENT_DEFAULTS = Object.freeze({
  paperLuma: 0.957,
  inkLuma: 0.1,
  targetContrast: 13, // calibrated so the veiled center matches the old hand-tuned scrims
})

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const lerp = (a, b, t) => a + (b - a) * t
const finiteOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100
// Approximate sRGB transfer: band lumas are gamma-encoded means; WCAG-style
// contrast wants (roughly) linear light.
const toLinear = (l) => Math.pow(l, 2.2)
const toEncoded = (l) => Math.pow(l, 1 / 2.2)

// Turn a sampled tone profile into the host scrim's CSS variables — continuous,
// replacing the old dark/balanced/light presets (the .scene-backdrop base values
// in theme.css remain only as the pre-sample fallback).
//   - veil-center is SOLVED, not tuned: color-mix(in srgb) blends gamma-encoded
//     values, so the veiled luma is paper*v + image*(1-v) in encoded space; we
//     require the darkest center region (p10, not the mean — dark patches under
//     dark type are what fail) to keep targetContrast against body ink, with a
//     busyness-driven texture floor on top (a compliant mean still needs wash +
//     defocus to flatten detail under type).
//   - center blur scales with busyness (high-frequency detail is what fights
//     glyph edges) plus a boost for dark worst-case regions.
//   - edge wash eases off for pale margins so quiet scenery stays visible as art.
export function computeBackdropTreatment(profile = {}, opts = {}) {
  const { paperLuma, inkLuma, targetContrast } = { ...TREATMENT_DEFAULTS, ...opts }
  const overall = finiteOr(profile.overallLuma, FALLBACK_PROFILE.overallLuma)
  const center = finiteOr(profile.centerLuma, overall)
  const edge = finiteOr(profile.edgeLuma, overall)
  const centerP10 = finiteOr(profile.centerLumaP10, Math.max(0, center - 0.12))
  const busyness = finiteOr(profile.centerBusyness, FALLBACK_PROFILE.centerBusyness)

  // Normalize 48×48 neighbour gradients: ~0.015 is a flat wash, ~0.12 dense foliage.
  const busy = clamp01((busyness - 0.015) / 0.105)

  const minLinear = Math.max(0, targetContrast * (toLinear(inkLuma) + 0.05) - 0.05)
  const minEncoded = toEncoded(minLinear)
  const contrastVeil = centerP10 >= minEncoded || paperLuma <= centerP10
    ? 0
    : (minEncoded - centerP10) / (paperLuma - centerP10)
  // Texture floor sits HIGH (86-94%): the contrast solve alone under-veils
  // bright scenes whose structure still reads through type (mean contrast passes
  // while desks/monitors stay recognizable under the prose). The solve is a
  // worst-case guarantee for dark imagery, not the typical operating point.
  const textureVeil = 0.86 + 0.08 * busy
  const centerVeil = Math.min(0.96, Math.max(contrastVeil, textureVeil))

  const edgeVeil = lerp(0.26, 0.04, clamp01((edge - 0.5) / 0.35))
  const shoulderVeil = edgeVeil + (centerVeil - edgeVeil) * 0.62

  const darkBoost = 2 * clamp01((0.35 - centerP10) / 0.25)
  const centerBlur = Math.min(10, 5 + 4 * busy + darkBoost)

  // Whole-image base filter: interpolate the old light/dark preset endpoints by
  // overall luma (dark imagery gets brightened + desaturated harder).
  const t = clamp01((0.74 - overall) / 0.32)
  const imgFilter = [
    `saturate(${round2(lerp(0.84, 0.58, t))})`,
    `contrast(${round2(lerp(1.02, 0.84, t))})`,
    `sepia(${round2(lerp(0.04, 0.08, t))})`,
    `brightness(${round2(lerp(0.98, 1.12, t))})`,
    `blur(${round2(lerp(0.35, 0.8, t))}px)`,
  ].join(" ")

  return {
    "--backdrop-img-filter": imgFilter,
    "--backdrop-center-blur": `${round1(centerBlur)}px`,
    "--backdrop-veil-edge": `${round1(edgeVeil * 100)}%`,
    "--backdrop-veil-shoulder": `${round1(shoulderVeil * 100)}%`,
    "--backdrop-veil-center": `${round1(centerVeil * 100)}%`,
  }
}

function meanLuma(data, width, height, { x0 = 0, x1 = 1, y0 = 0, y1 = 1 } = {}) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(width * x0)))
  const right = Math.max(left + 1, Math.min(width, Math.ceil(width * x1)))
  const top = Math.max(0, Math.min(height - 1, Math.floor(height * y0)))
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(height * y1)))
  let sum = 0
  let count = 0
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * width + x) * 4
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      count += 1
    }
  }
  return count ? sum / count / 255 : FALLBACK_PROFILE.overallLuma
}

// Center reading band (same region as the centerLuma mean): per-pixel lumas for
// the p10 worst-case (dark patches under dark type) and a busyness score (mean
// absolute neighbour gradient — at 48×48 this captures the mid-frequency
// structure that actually fights glyph edges at backdrop scale).
function centerBandStats(data, width, height) {
  const left = Math.max(0, Math.floor(width * 0.32))
  const right = Math.max(left + 1, Math.ceil(width * 0.68))
  const top = Math.max(0, Math.floor(height * 0.18))
  const cols = right - left
  const rows = height - top
  const lumas = new Float64Array(cols * rows)
  for (let y = top; y < height; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * width + x) * 4
      lumas[(y - top) * cols + (x - left)] =
        (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
    }
  }
  if (!lumas.length) {
    return { mean: FALLBACK_PROFILE.centerLuma, p10: FALLBACK_PROFILE.centerLumaP10, busyness: FALLBACK_PROFILE.centerBusyness }
  }
  let sum = 0
  for (const l of lumas) sum += l
  const mean = sum / lumas.length
  const sorted = Array.from(lumas).sort((a, b) => a - b)
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]
  let gradSum = 0
  let gradCount = 0
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = lumas[r * cols + c]
      if (c + 1 < cols) { gradSum += Math.abs(lumas[r * cols + c + 1] - v); gradCount += 1 }
      if (r + 1 < rows) { gradSum += Math.abs(lumas[(r + 1) * cols + c] - v); gradCount += 1 }
    }
  }
  const busyness = gradCount ? gradSum / gradCount : FALLBACK_PROFILE.centerBusyness
  return { mean, p10, busyness }
}

async function analyzeImageToneProfile(src) {
  let revoke = null
  try {
    const loaded = await loadReadableUrl(src)
    revoke = loaded.revoke
    const profile = await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const w = 48
          const h = 48
          const canvas = document.createElement("canvas")
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext("2d", { willReadFrequently: true })
          ctx.drawImage(img, 0, 0, w, h)
          const data = ctx.getImageData(0, 0, w, h).data
          const topLuma = meanLuma(data, w, h, { y0: 0, y1: 0.18 })
          const overallLuma = meanLuma(data, w, h)
          const centerStats = centerBandStats(data, w, h)
          const leftEdge = meanLuma(data, w, h, { x0: 0, x1: 0.24, y0: 0.18, y1: 1 })
          const rightEdge = meanLuma(data, w, h, { x0: 0.76, x1: 1, y0: 0.18, y1: 1 })
          const edgeLuma = (leftEdge + rightEdge) / 2
          resolve({
            topTone: toneFromLuma(effectiveHeaderLuma(topLuma), 0.5),
            overallLuma,
            centerLuma: centerStats.mean,
            edgeLuma,
            centerLumaP10: centerStats.p10,
            centerBusyness: centerStats.busyness,
          })
        } catch {
          resolve(FALLBACK_PROFILE)
        }
      }
      img.onerror = () => resolve(FALLBACK_PROFILE)
      img.src = loaded.url
    })
    return profile
  } catch {
    return FALLBACK_PROFILE
  } finally {
    revoke?.()
  }
}

async function getImageToneProfile(src) {
  if (!src) return FALLBACK_PROFILE
  const cached = profileCache.get(src)
  if (cached) return cached
  const pending = pendingProfiles.get(src)
  if (pending) return pending
  const promise = analyzeImageToneProfile(src).then((profile) => {
    profileCache.set(src, profile)
    pendingProfiles.delete(src)
    return profile
  }, () => {
    pendingProfiles.delete(src)
    return FALLBACK_PROFILE
  })
  pendingProfiles.set(src, promise)
  return promise
}

// Tone of the image's TOP band (where the header/HUD strip overlays it).
// "light" when src is empty/unreadable — the paper default.
export function useTopBandTone(src) {
  const [tone, setTone] = useState(() => (src && profileCache.get(src)?.topTone) || "light")
  useEffect(() => {
    if (!src) { setTone("light"); return undefined }
    const cached = profileCache.get(src)
    if (cached) { setTone(cached.topTone); return undefined }
    setTone("light")
    let alive = true
    getImageToneProfile(src).then((profile) => {
      if (alive) setTone(profile.topTone)
    })
    return () => { alive = false }
  }, [src])
  return tone
}

export function useBackdropToneProfile(src) {
  const [profile, setProfile] = useState(() => (src && profileCache.get(src)) || FALLBACK_PROFILE)
  useEffect(() => {
    if (!src) { setProfile(FALLBACK_PROFILE); return undefined }
    const cached = profileCache.get(src)
    if (cached) { setProfile(cached); return undefined }
    setProfile(FALLBACK_PROFILE)
    let alive = true
    getImageToneProfile(src).then((next) => {
      if (alive) setProfile(next)
    })
    return () => { alive = false }
  }, [src])
  return profile
}
