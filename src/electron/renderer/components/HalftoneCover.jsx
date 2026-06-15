import React, { useEffect, useMemo, useRef, useState } from "react"

// Deterministic 32-bit hash (djb2). Same input → same cover forever.
function hash32(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0
  }
  return h >>> 0
}

// B&W print-aesthetic halftone background. ALL variants are dot-based halftone
// — what changes between them is the gradient function that drives the dot
// size at each cell. This keeps the visual family unified (it always reads
// as "halftone print") while giving each seed its own pattern.
//
// 7 variants in rotation, picked deterministically by seed:
//   0  radial   — dots radiate from a focal point
//   1  linear   — dots gradient along an angle
//   2  wave     — dots modulated by sin() along an axis (parallel bands)
//   3  rings    — dots modulated by sin(distance) (concentric bands)
//   4  moire    — two ring systems beating against each other (interference)
//   5  fmwave   — wave whose frequency itself wobbles (FM modulation)
//   6  voronoi  — distance to nearest of N seeded anchors (cluster blots)
//
// `Halftone` is the generic renderer; `HalftoneCover` (portrait card) and
// `HalftoneBand` (wide foot strip) are presets over the SAME generation +
// gradient core, differing only in grid/viewBox framing — no second dot system.
// Stable empty default so the useMemo dep array doesn't churn each render.
const EMPTY_VARIANTS = []

function Halftone({
  seed,
  cols,
  rows,
  vbW,
  vbH,
  rotate = false,
  tilt = 35,
  extPadX = 0,
  extPadY = 0,
  disableVariants = EMPTY_VARIANTS,
  freqBoost = 1,
  className,
  preserveAspectRatio = "none",
}) {
  const { dots, rotation } = useMemo(
    () => buildDots(seed || "", { cols, rows, vbW, vbH, rotate, tilt, extPadX, extPadY, disableVariants, freqBoost }),
    [seed, cols, rows, vbW, vbH, rotate, tilt, extPadX, extPadY, disableVariants, freqBoost],
  )
  const inner = dots.map((d, i) => (
    <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="currentColor" />
  ))
  return (
    <svg
      className={className}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio={preserveAspectRatio}
      aria-hidden="true"
    >
      {rotation ? <g transform={`rotate(${rotation} ${vbW / 2} ${vbH / 2})`}>{inner}</g> : inner}
    </svg>
  )
}

// Portrait story-card cover (aspect 2:3). Random ±35° rotation, so the grid is
// extended past the visible box (extPad) to keep the rotated corners filled.
export function HalftoneCover({ seed }) {
  return (
    <Halftone
      seed={seed}
      className="halftone-cover-svg"
      vbW={200}
      vbH={300}
      cols={11}
      rows={17}
      rotate
      extPadX={80}
      extPadY={30}
    />
  )
}

// Wide, short foot strip. The viewBox is sized to the strip's ACTUAL pixel
// dimensions (measured) so the SVG renders at scale 1:1 — that keeps each dot a
// fixed `cell`-px size regardless of window width (a stretched/`slice` viewBox
// would balloon the dots in proportion to the viewport, which is wrong for a
// thin strip). Columns/rows are derived from the measured size so the cells stay
// ~square (round dots), the gradient frequency scales up (cols/REF_COLS) so the
// wide strip carries the cover's density of bands rather than a stretched ramp,
// and a small rotation breaks the rigid grid (extPad below fills the swing).
const FOOT_DOT_CELL = 11   // target dot pitch in px (dot Ø ≈ cell * 0.93)
const FOOT_TILT = 7        // max rotation in degrees — small, the strip is thin
const FOOT_DISABLED = [2]  // drop `wave` on the reading foot (too stripey there)
export function HalftoneBand({ seed, className, height = 184, cell = FOOT_DOT_CELL, tilt = FOOT_TILT, freqBoost = 1 }) {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Snap to a coarse step so resize drags don't regenerate the (large) dot
    // field on every sub-pixel change — only when the width crosses a step.
    const measure = () => setWidth(Math.round(el.clientWidth / 24) * 24)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cols = Math.max(2, Math.round(width / cell))
  const rows = Math.max(2, Math.round(height / cell))
  // Rotating the full-width field by ±FOOT_TILT swings the far ends up/down by
  // ~(width/2)·sin(tilt); pad the grid vertically by that much (plus the small
  // horizontal swing) so the rotated corners stay filled instead of baring
  // empty wedges. Padding is in viewBox px (== screen px here, scale 1:1).
  const rad = (tilt * Math.PI) / 180
  const extPadY = Math.ceil((width / 2) * Math.sin(rad) + cell)
  const extPadX = Math.ceil((height / 2) * Math.sin(rad) + cell)
  return (
    <div ref={ref} className={className}>
      {width > 0 && (
        <Halftone
          seed={seed}
          vbW={width}
          vbH={height}
          cols={cols}
          rows={rows}
          rotate
          tilt={tilt}
          extPadX={extPadX}
          extPadY={extPadY}
          disableVariants={FOOT_DISABLED}
          freqBoost={freqBoost}
          preserveAspectRatio="none"
        />
      )}
    </div>
  )
}

// Max radius cap: 0.58 × cellSize. Two adjacent max-radius dots have
// diameter 1.16 × cellSize while their centers are 1 × cellSize apart,
// so disks overlap by ~14% of one diameter — just enough that dense
// regions read as a connected weave, but the individual circles remain
// visible (no solid blob). Tuned to feel like ink-on-paper print where
// the dots kiss rather than smear.
const R_MIN_FRAC = 0.20
const R_MAX_FRAC = 1.0
const SKIP_THRESHOLD = 0.10

// Gradient frequencies (wave/rings/moiré/fmwave) are authored against the
// cover's column density. On a much wider grid the SAME cycle count would smear
// into a near-flat ramp, so we scale frequency up with the column count to keep
// visible density variation. The scaling is SUB-linear (exponent < 1): a fully
// linear cols/REF_COLS makes a very wide strip read as busy, so we damp it.
// Cover (cols == REF_COLS) → ratio 1 → exponent is a no-op → frequencies
// unchanged; only wider grids (the foot strip) get the damped boost.
const REF_COLS = 11
const FREQ_DENSITY_EXP = 0.8

const ALL_VARIANTS = [0, 1, 2, 3, 4, 5, 6]

function buildDots(seed, opts) {
  const { cols, rows, vbW, vbH, rotate, tilt = 35, extPadX, extPadY, disableVariants = EMPTY_VARIANTS, freqBoost = 1 } = opts
  const cellW = vbW / cols
  const cellH = vbH / rows
  const rBase = Math.min(cellW, cellH) * 0.58 * 0.8
  // Multiplier that converts a cy-delta (normalized over vbH) into cx-units
  // (normalized over vbW), so the gradient distance math stays isotropic
  // regardless of the viewBox aspect.
  const ay = vbH / vbW
  const freqScale = ((cols / REF_COLS) ** FREQ_DENSITY_EXP) * freqBoost

  const h = hash32(String(seed) || "openovel")
  // Pick only among allowed variants (caller may disable some, e.g. the reading
  // foot drops `wave`); cover disables none, so this stays `h % 7` unchanged.
  const allowed = disableVariants.length
    ? ALL_VARIANTS.filter((v) => !disableVariants.includes(v))
    : ALL_VARIANTS
  const variant = allowed[h % allowed.length]
  // Random rotation (±tilt°) breaks the always-axis-aligned grid look. The
  // cover swings the full ±35°; a wide thin strip uses a small tilt (its
  // caller sizes extPad to the resulting vertical swing so corners stay full).
  const rotation = rotate ? (((h >>> 24) & 0xff) / 255 - 0.5) * (tilt * 2) : 0
  const t = chooseGradient(variant, h, ay, freqScale)

  // Grid extended past the visible viewBox so that after a random rotation the
  // corners stay filled with dots instead of revealing an empty triangle.
  const extCols = cols + 2 * Math.ceil(extPadX / cellW)
  const extRows = rows + 2 * Math.ceil(extPadY / cellH)

  const out = []
  for (let r = 0; r < extRows; r++) {
    for (let c = 0; c < extCols; c++) {
      const local_x = -extPadX + (c + 0.5) * cellW
      const local_y = -extPadY + (r + 0.5) * cellH
      // Gradient input is normalized to the CANVAS frame (not the extended
      // grid), so the focal/wave/ring math stays anchored to the visible
      // area. Cells outside the canvas just extrapolate the gradient —
      // radial clamps via Math.min, sin-based variants tile naturally.
      const cx01 = local_x / vbW
      const cy01 = local_y / vbH
      let v = t(cx01, cy01)
      if (v < 0) v = 0
      else if (v > 1) v = 1
      if (v < SKIP_THRESHOLD) continue
      const compressed = R_MIN_FRAC + ((v - SKIP_THRESHOLD) / (1 - SKIP_THRESHOLD)) * (R_MAX_FRAC - R_MIN_FRAC)
      out.push({
        x: local_x,
        y: local_y,
        r: compressed * rBase,
      })
    }
  }
  return { dots: out, rotation }
}

// Returns a function (cx01, cy01) → 0..1 that drives dot size. `ay` is the
// aspect multiplier (vbH/vbW) used to keep the gradient distances isotropic.
function chooseGradient(variant, h, ay, freqScale) {
  // Bytes 1..3 used per-variant; byte 0 was already consumed by `h % 7`.
  const b1 = ((h >>>  5) & 0xff) / 255    // shift past the variant selector
  const b2 = ((h >>> 13) & 0xff) / 255
  const b3 = ((h >>> 21) & 0xff) / 255
  const inv = b3 >= 0.5

  switch (variant) {
    case 0: return radial(b1, b2, b3, inv, ay)
    case 1: return linear(b1, b2, inv, ay)
    case 2: return wave(b1, b2, inv, ay, freqScale)
    case 3: return rings(b1, b2, inv, ay, freqScale)
    case 4: return moire(b1, b2, b3, inv, ay, freqScale)
    case 5: return fmwave(b1, b2, b3, inv, ay, freqScale)
    default: return voronoi(h, inv, ay)
  }
}

// ── 1. Radial halftone — dots radiate from a focal point ───────────────
function radial(b1, b2, b3, inv, ay) {
  const fx = 0.2 + b1 * 0.6
  const fy = 0.2 + b2 * 0.6
  const pow = 0.8 + b3 * 1.4
  return (cx, cy) => {
    const dx = cx - fx
    const dy = (cy - fy) * ay
    const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.9)
    const t = Math.pow(1 - d, pow)
    return inv ? 1 - t : t
  }
}

// ── 2. Linear halftone — dots increase along a directional axis ────────
function linear(b1, b2, inv, ay) {
  const angle = b1 * Math.PI * 2
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const pow = 0.6 + b2 * 1.0
  return (cx, cy) => {
    const dx = cx - 0.5
    const dy = (cy - 0.5) * ay
    const proj = dx * cos + dy * sin            // ~-0.7..0.7
    const norm = Math.min(1, Math.max(0, proj + 0.5))
    const t = Math.pow(inv ? norm : 1 - norm, pow)
    return t
  }
}

// Sin wave returns 0..1; we lift the floor so troughs render as small but
// visible dots rather than empty cells. Used by wave + rings + spiral so
// every variant fills the full canvas with halftone, never collapsing to
// blank white in any cell.
const SIN_FLOOR = 0.32
const SIN_RANGE = 1 - SIN_FLOOR    // = 0.68

// ── 3. Wave halftone — sin() along an axis (parallel halftone bands) ──
function wave(b1, b2, inv, ay, freqScale = 1) {
  const angle = b1 * Math.PI * 2
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const freq = (1 + b2) * freqScale             // 1..2 cycles across (× density scale)
  return (cx, cy) => {
    const dx = cx - 0.5
    const dy = (cy - 0.5) * ay
    const proj = dx * cos + dy * sin
    const raw = 0.5 + 0.5 * Math.sin(proj * freq * Math.PI * 2)   // 0..1
    const t = SIN_FLOOR + raw * SIN_RANGE                          // 0.18..1.0
    return inv ? (SIN_FLOOR + (1 - raw) * SIN_RANGE) : t
  }
}

// ── 4. Ring halftone — sin(distance) (concentric halftone bands) ──────
function rings(b1, b2, inv, ay, freqScale = 1) {
  const fx = 0.25 + b1 * 0.5
  const fy = 0.25 + b2 * 0.5
  const freq = (0.7 + b1 * 0.8) * freqScale      // 0.7..1.5 rings (× density scale)
  return (cx, cy) => {
    const dx = cx - fx
    const dy = (cy - fy) * ay
    const d = Math.sqrt(dx * dx + dy * dy)
    const raw = 0.5 + 0.5 * Math.sin(d * freq * Math.PI * 2)
    const t = SIN_FLOOR + raw * SIN_RANGE
    return inv ? (SIN_FLOOR + (1 - raw) * SIN_RANGE) : t
  }
}

// ── 5. Moiré — two ring systems with close-but-different frequencies. ──
// The product of two sine fields produces a low-frequency *beat* pattern:
// where the high-freq rings happen to align you get a fat dot region,
// where they cancel you get a quiet trough. Visually: shimmering bands of
// density crossing the card, very "print-press has misaligned plates" —
// straight out of risograph aesthetic.
function moire(b1, b2, b3, inv, ay, freqScale = 1) {
  // Two focal points: same neighborhood, but offset just enough that
  // their ring systems aren't concentric — that's what produces the beat.
  const fx1 = 0.3 + b1 * 0.4
  const fy1 = 0.3 + b2 * 0.4
  const offsetAngle = b3 * Math.PI * 2
  const offsetMag = 0.06 + b1 * 0.10                 // 6..16% of width
  const fx2 = fx1 + Math.cos(offsetAngle) * offsetMag
  const fy2 = fy1 + Math.sin(offsetAngle) * offsetMag
  // freq2 slightly higher than freq1 so the beat is visible across the
  // card (too-close → no beat, too-different → looks like noise).
  const freq1 = (0.9 + b2 * 0.4) * freqScale         // 0.9..1.3 (× density scale)
  const freq2 = freq1 * (1.07 + b3 * 0.10)           // 7..18% higher
  return (cx, cy) => {
    const d1 = Math.sqrt((cx - fx1) ** 2 + ((cy - fy1) * ay) ** 2)
    const d2 = Math.sqrt((cx - fx2) ** 2 + ((cy - fy2) * ay) ** 2)
    // Multiply two sin fields → low-freq beat envelope is the dominant signal.
    const s1 = Math.sin(d1 * freq1 * Math.PI * 2)
    const s2 = Math.sin(d2 * freq2 * Math.PI * 2)
    const raw = 0.5 + 0.5 * s1 * s2                  // 0..1
    const t = SIN_FLOOR + raw * SIN_RANGE
    return inv ? (SIN_FLOOR + (1 - raw) * SIN_RANGE) : t
  }
}

// ── 6. FM Wave — wave whose phase wobbles along the perpendicular axis. ─
// Plain wave is `sin(u)`. FM wave is `sin(u + amp * sin(w))` — as you move
// perpendicular to the carrier, the carrier's phase shifts, so the bands
// become ribbons that breathe. Reads as wind through tall grass.
function fmwave(b1, b2, b3, inv, ay, freqScale = 1) {
  const angle = b1 * Math.PI * 2
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const carrierFreq = (1.4 + b2 * 1.2) * freqScale   // 1.4..2.6 cycles (× density scale)
  const modFreq = (0.5 + b3 * 1.5) * freqScale       // 0.5..2.0 wobbles (× density scale)
  const modAmp = 0.9 + b2 * 1.4                      // 0.9..2.3 radians swing
  return (cx, cy) => {
    const dx = cx - 0.5
    const dy = (cy - 0.5) * ay
    const u = dx * cos + dy * sin                    // along carrier
    const w = -dx * sin + dy * cos                   // perpendicular (modulator)
    const phase = u * carrierFreq * Math.PI * 2 + modAmp * Math.sin(w * modFreq * Math.PI * 2)
    const raw = 0.5 + 0.5 * Math.sin(phase)
    const t = SIN_FLOOR + raw * SIN_RANGE
    return inv ? (SIN_FLOOR + (1 - raw) * SIN_RANGE) : t
  }
}

// ── 7. Voronoi — distance to nearest of N seeded anchors. ──────────────
// Each seed has 6..9 anchor points (positions hashed from the seed). At
// each grid cell, dot size is driven by how close that cell is to its
// nearest anchor. Result: ink-blot clusters (each anchor blooms a dense
// pool of dots, equidistant cells form sparse boundaries). Every seed
// gets a unique anchor layout, so this variant is the most "fingerprint"
// of the set — no two patterns look alike.
function voronoi(h, inv, ay) {
  // Anchor count: 6..9. Use the same hash but mix differently per anchor
  // so positions don't collapse onto a line.
  const N = 6 + (h & 0x3)
  const anchors = []
  for (let i = 0; i < N; i++) {
    const hx = mix32(h, 0xa5 + i * 17)
    const hy = mix32(h, 0x5a + i * 31)
    anchors.push({
      x: 0.1 + ((hx & 0xffff) / 0xffff) * 0.8,
      y: 0.1 + ((hy & 0xffff) / 0xffff) * 0.8,
    })
  }
  // Falloff steepness: lower = soft blobs that overlap, higher = tight
  // wells with empty boundaries. We pick a moderate value so the canvas
  // still reads as halftone (continuous), not as isolated islands.
  const falloff = 5.5
  return (cx, cy) => {
    let d2min = Infinity
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]
      const dx = cx - a.x
      const dy = (cy - a.y) * ay
      const d2 = dx * dx + dy * dy
      if (d2 < d2min) d2min = d2
    }
    const d = Math.sqrt(d2min)
    // Exponential well at each anchor → 1 at center, decaying outward.
    const raw = Math.exp(-d * falloff)
    return inv ? 1 - raw : raw
  }
}

// Cheap secondary hash for per-anchor offsets in voronoi(). Splitmix-ish
// 32-bit mix — combines the base hash with a per-index salt so we don't
// have to call hash32() in a loop.
function mix32(h, salt) {
  let x = (h ^ (salt + 0x9e3779b9)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}
