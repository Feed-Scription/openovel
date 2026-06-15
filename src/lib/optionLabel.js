// Pure, dependency-free helpers for reader-facing option choices. Imported by the
// node runtime (narrator, view model, story store) AND the sandboxed UI renderers
// (Electron/Ink/raw), so this file must stay string-logic only — no node builtins,
// no imports.
//
// An option is either a legacy plain string OR an object
// `{ id, label, key?, effect? }`. Only `label` is ever shown to the reader; the
// hidden `effect` lives on the recorded turn (scene_log), never in render state.

export function optionLabel(option) {
  if (typeof option === "string") return option
  if (option && typeof option === "object" && typeof option.label === "string") return option.label
  return ""
}

// Display-only projection: strip the hidden effect so nothing a renderer touches
// can ever leak it. Keeps id (for selection binding) + key (decision flag).
export function toDisplayOption(option, index = 0) {
  if (typeof option === "string") return { id: `opt_${index + 1}`, label: option }
  if (option && typeof option === "object") {
    const out = { id: typeof option.id === "string" ? option.id : `opt_${index + 1}`, label: optionLabel(option) }
    if (option.key === true) out.key = true
    return out
  }
  return { id: `opt_${index + 1}`, label: "" }
}

// Normalized form for repeat/dedup comparison: collapse whitespace, strip a
// leading/trailing punctuation halo, lowercase latin. CJK characters are kept.
export function normalizeChoiceText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .toLowerCase()
}
