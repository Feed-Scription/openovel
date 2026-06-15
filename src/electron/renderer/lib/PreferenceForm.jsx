import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

// Form-mode editor for user-memory preferences. Shared between the
// first-run OnboardingModal flow and the Settings → Preferences tab so
// the UX stays consistent and the same "tag → memory line" packing
// happens in both places.
//
// Three sub-blocks, each editable in isolation:
//   - Default story language (text input, free-form so user can write
//     non-canonical answers like "Simplified Chinese with English terms")
//   - Prose reference (textarea — a passage / book / author / genre)
//   - Style preferences (multi-select tag pills across the canonical groups)
//
// On change, this component calls `onChange({ language, proseReference,
// styleNestedLines, tags })`. The container persists each piece via its
// own memory entry (replaceMemoryEntry by prefix) so editing in the form
// doesn't blow away unrelated USER.md content.
export function PreferenceForm({
  initial = {},
  groups,
  onChange,
}) {
  const { t } = useTranslation()
  const [language, setLanguage] = useState(initial.language || "")
  const [proseReference, setProseReference] = useState(initial.proseReference || "")
  // selections: { [groupId]: Set<value> }
  const [selections, setSelections] = useState(() => {
    const init = {}
    for (const g of groups) {
      init[g.id] = new Set(initial.tags?.[g.id] || [])
    }
    return init
  })

  // Build a nested style-preferences block on every change. Format:
  //   - Style preferences:
  //     - <Group>: <item> — <desc>; <item2> — <desc2>
  //     - <Group2>: ...
  // The two-space indent on children renders as a markdown sub-list while
  // keeping each child a valid bullet that the memory parser can still
  // surface to the narrator.
  useEffect(() => {
    const structured = {}
    const childLines = []
    for (const g of groups) {
      const picks = [...(selections[g.id] || [])]
      if (!picks.length) continue
      structured[g.id] = picks
      const items = picks.map((v) => {
        const opt = g.options.find((o) => o.value === v)
        const label = opt?.label || v
        const desc = opt?.description ? ` — ${opt.description}` : ""
        return `${label}${desc}`
      })
      childLines.push(`  - ${g.label}: ${items.join("; ")}`)
    }
    const styleNestedLines = childLines.length
      ? ["- Style preferences:", ...childLines]
      : []
    onChange?.({
      language: language.trim(),
      proseReference: proseReference.trim(),
      styleNestedLines,
      tags: structured,
    })
  }, [selections, language, proseReference, groups, onChange])

  const toggle = (groupId, value) => {
    const group = groups.find((g) => g.id === groupId)
    const option = group?.options.find((o) => o.value === value)
    setSelections((prev) => {
      const next = { ...prev }
      const set = new Set(next[groupId] || [])
      if (option?.isDefault) {
        // "Default" = let the model decide → store NOTHING for this group.
        // An empty selection IS that state (it serializes to nothing), so
        // clicking Default just clears whatever was picked.
        set.clear()
      } else if (set.has(value)) {
        set.delete(value)
      } else if (group?.singleSelect) {
        // Radio behavior: a single-select group holds at most one value.
        set.clear()
        set.add(value)
      } else if (option?.exclusive) {
        // Exclusive option: clears the rest.
        set.clear()
        set.add(value)
      } else {
        // Selecting a normal option drops any exclusive sentinel.
        for (const o of group?.options || []) {
          if (o.exclusive) set.delete(o.value)
        }
        set.add(value)
      }
      next[groupId] = set
      return next
    })
  }

  return (
    <div className="pref-form">
      <div className="pref-form-row">
        <div className="pref-form-label">
          {t("preferenceForm.language", { defaultValue: "Default story language" })}
        </div>
        <LanguagePillRow value={language} onChange={setLanguage} t={t} />
      </div>
      <div className="pref-form-row">
        <label className="pref-form-label">
          {t("preferenceForm.proseReference", { defaultValue: "Prose reference (optional)" })}
        </label>
        <textarea
          className="pref-form-textarea"
          value={proseReference}
          onChange={(e) => setProseReference(e.target.value)}
          placeholder={t("preferenceForm.proseReferencePlaceholder", {
            defaultValue: "A passage you like, a book, an author, or a genre whose voice the narrator should echo.",
          })}
          rows={4}
        />
      </div>
      <div className="pref-form-row">
        <div className="pref-form-label">
          {t("preferenceForm.styleTags", { defaultValue: "Style preferences" })}
        </div>
        <div className="tag-picker">
          {groups.map((g) => (
            <div key={g.id} className="tag-picker-group">
              <div className="tag-picker-group-label">{g.label}</div>
              <div className="tag-picker-options">
                {g.options.map((opt) => {
                  // The Default sentinel lights up whenever the group has no
                  // real selection (it is never stored) — so it reads as the
                  // resting state. Real options light only when actually picked.
                  const active = opt.isDefault
                    ? !(selections[g.id]?.size)
                    : selections[g.id]?.has(opt.value)
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`tag-pill${active ? " is-active" : ""}${opt.isDefault ? " tag-pill-default" : ""}`}
                      onClick={() => toggle(g.id, opt.value)}
                      data-description={opt.description || undefined}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Pill row + free-text fallback for the default-story-language picker.
// Three pills (English / 简体中文 / Other) match the onboarding step's
// shape; picking "Other" reveals a text input for non-canonical answers.
function LanguagePillRow({ value, onChange, t }) {
  const canonical = ["English", "Simplified Chinese"]
  // Decide which pill is currently active. Anything that isn't a known
  // canonical value (including empty) routes through the "Other" pill +
  // free-text input — preserves whatever the user wrote previously.
  const isOther = value && !canonical.includes(value)
  const [selected, setSelected] = useState(
    canonical.includes(value) ? value : value ? "__OTHER__" : "",
  )
  const [otherText, setOtherText] = useState(isOther ? value : "")

  const pick = (val) => {
    setSelected(val)
    if (val === "__OTHER__") onChange(otherText.trim())
    else if (val) onChange(val)
    else onChange("")
  }
  const updateOther = (text) => {
    setOtherText(text)
    if (selected === "__OTHER__") onChange(text.trim())
  }

  const options = [
    { value: "English",            label: "English",       hint: t("onboarding.languageOptions.englishHint", { defaultValue: "default" }) },
    { value: "Simplified Chinese", label: "简体中文",       hint: t("onboarding.languageOptions.simplifiedChineseHint", { defaultValue: "Simplified Chinese" }) },
    { value: "__OTHER__",          label: t("onboarding.languageOptions.other", { defaultValue: "Other / mixed…" }), hint: t("onboarding.languageOptions.otherHint", { defaultValue: "type your own" }) },
  ]
  return (
    <>
      <div className="pref-form-pill-row">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`pref-form-pill${selected === opt.value ? " is-selected" : ""}`}
            onClick={() => pick(opt.value)}
          >
            <span className="pref-form-pill-label">{opt.label}</span>
            <span className="pref-form-pill-hint">{opt.hint}</span>
          </button>
        ))}
      </div>
      {selected === "__OTHER__" && (
        <input
          type="text"
          className="pref-form-input"
          value={otherText}
          onChange={(e) => updateOther(e.target.value)}
          placeholder={t("onboarding.languageOptions.otherPlaceholder", {
            defaultValue: "e.g. 日本語 / Español / Mostly English with occasional Japanese",
          })}
          spellCheck={false}
        />
      )}
    </>
  )
}

// Parse the current USER.md content back into the form state so the
// Settings tab can pre-populate fields. Heuristic — looks for the
// canonical memoryPrefix labels at the start of each index line.
// Returns { language, proseReference, tags: { groupId: Set<value> } }.
//
// Note: tag parsing tries to re-match labels against the supplied group
// definitions. Free-form text the user wrote outside the canonical
// vocabulary won't round-trip — that's a known limitation; the user can
// always switch to markdown mode for full control.
export function parseUserMemoryIntoForm(userMemoryText, groups) {
  const result = { language: "", proseReference: "", tags: {} }
  for (const g of groups) result.tags[g.id] = new Set()
  if (!userMemoryText) return result

  // Pass 1: nested style block. Detect a parent line `- Style preferences:`
  // followed by indented `  - <Group>: items` children. We do this BEFORE
  // the flat bullet pass so nested children don't double-match.
  const lines = userMemoryText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!/^[\t ]*-\s+Style preferences\s*:\s*$/.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j]
      if (!child.trim()) continue
      const nested = child.match(/^\s+-\s+([^:]+):\s*(.+)$/)
      if (!nested) break
      const groupLabel = nested[1].trim()
      const itemsPart = nested[2].trim()
      const group = groups.find((g) => g.label === groupLabel)
      if (!group) continue
      for (const item of itemsPart.split(/;\s*/)) {
        const label = item.split(/\s+—\s+/)[0].trim()
        const opt = group.options.find((o) => o.label === label)
        if (opt) result.tags[group.id].add(opt.value)
      }
    }
  }

  // Pass 2: flat bullets (language, prose-reference, legacy style forms).
  // Index lines look like:
  //   - [Title](topics/x.md) — Default story language: zh
  // The body after ` — ` is the live entry text we want.
  const bullet = /^[\t ]*-\s+(?:\[[^\]]*\]\([^)]*\)\s+—\s+)?(.+)$/gm
  let match
  while ((match = bullet.exec(userMemoryText))) {
    const body = match[1].trim()
    if (!body) continue
    if (body.startsWith("Default story language:")) {
      result.language = body.slice("Default story language:".length).trim()
    } else if (body.startsWith("Prose reference")) {
      // Two variants: "Prose reference: …" or "Prose reference (writing …): …"
      const colon = body.indexOf(":")
      if (colon >= 0) result.proseReference = body.slice(colon + 1).trim()
    } else if (body.startsWith("Style preferences")) {
      // Two accepted shapes:
      //   New (per-group bullet):
      //     "Style preferences (Pacing): Brisk — desc; Cinematic — desc"
      //   Legacy (one-line, multi-group):
      //     "Style preferences: Pacing: Brisk — desc; …. Tone: Ironic — …."
      // Each call sees only ONE bullet, so the new shape gives one group;
      // legacy gives many.
      const parenMatch = body.match(/^Style preferences\s*\(([^)]+)\)\s*:\s*(.*)$/)
      const chunksWithLabels = []
      if (parenMatch) {
        chunksWithLabels.push({ groupLabel: parenMatch[1].trim(), itemsPart: parenMatch[2].trim() })
      } else {
        const after = body.replace(/^Style preferences[.:]\s*/, "")
        for (const chunk of after.split(/\.\s+/)) {
          const colon = chunk.indexOf(":")
          if (colon < 0) continue
          chunksWithLabels.push({
            groupLabel: chunk.slice(0, colon).trim(),
            itemsPart: chunk.slice(colon + 1).trim().replace(/\.+$/, ""),
          })
        }
      }
      for (const { groupLabel, itemsPart } of chunksWithLabels) {
        const group = groups.find((g) => g.label === groupLabel)
        if (!group) continue
        for (const item of itemsPart.split(/;\s*/)) {
          const label = item.split(/\s+—\s+/)[0].trim()
          const opt = group.options.find((o) => o.label === label)
          if (opt) result.tags[group.id].add(opt.value)
        }
      }
    }
  }
  return result
}

// Merge the form values into an existing USER.md-style markdown document.
// Single-bullet replacements (language, proseReference) replace in-place. The
// style-preferences group is multi-bullet: ALL existing matches are removed and
// the new per-group bullets are inserted where the first match used to be (or
// appended at the end if none existed). Shared by the global Preferences tab
// (merges into USER.md) and the per-story naming screen (builds a fresh file).
export function rebuildMarkdownFromForm(currentMarkdown, formValue, groups) {
  const lines = String(currentMarkdown || "").split(/\r?\n/)
  const singleReplacements = []
  if (formValue.language) {
    singleReplacements.push({
      match: /^[\t ]*-\s+\[?Default story language/,
      line: `- Default story language: ${formValue.language}`,
    })
  }
  if (formValue.proseReference) {
    singleReplacements.push({
      match: /^[\t ]*-\s+\[?Prose reference/,
      line: `- Prose reference (writing the user wants to read like): ${formValue.proseReference}`,
    })
  }

  // Pass 1: in-place rewrite of the single-bullet replacements.
  const consumedSingle = new Set()
  let out = lines.map((line) => {
    for (let i = 0; i < singleReplacements.length; i++) {
      if (consumedSingle.has(i)) continue
      if (singleReplacements[i].match.test(line)) {
        consumedSingle.add(i)
        return singleReplacements[i].line
      }
    }
    return line
  })

  // Pass 2: replace the style-preferences block. Two forms exist:
  //   nested: `- Style preferences:` parent + indented `  - Group: items` children
  //   legacy: top-level `- Style preferences (Group): items` (one or many)
  // We strip ALL of both forms, then splice the new nested block at the
  // first removed anchor.
  const styleNestedLines = Array.isArray(formValue.styleNestedLines)
    ? formValue.styleNestedLines
    : []
  const parentPattern = /^[\t ]*-\s+\[?Style preferences\s*:?\s*$/
  const legacyTopLevel = /^[\t ]*-\s+\[?Style preferences/
  const indentedChild = /^\s+-\s+/
  let styleAnchor = -1
  const afterStyle = []
  let inNestedBlock = false
  for (let i = 0; i < out.length; i++) {
    const line = out[i]
    if (parentPattern.test(line)) {
      if (styleAnchor === -1) styleAnchor = afterStyle.length
      inNestedBlock = true
      continue
    }
    if (inNestedBlock) {
      if (!line.trim()) continue
      if (indentedChild.test(line)) continue
      inNestedBlock = false
    }
    if (legacyTopLevel.test(line)) {
      if (styleAnchor === -1) styleAnchor = afterStyle.length
      continue
    }
    afterStyle.push(line)
  }
  out = afterStyle
  if (styleNestedLines.length) {
    if (styleAnchor === -1) {
      if (!out.some((l) => l.trim())) out.push("# User Memory", "", "## Entries", "")
      if (out.length && out[out.length - 1].trim()) out.push("")
      out.push(...styleNestedLines)
    } else {
      out.splice(styleAnchor, 0, ...styleNestedLines)
    }
  }

  // Any single-bullet replacement not consumed → append.
  for (let i = 0; i < singleReplacements.length; i++) {
    if (consumedSingle.has(i)) continue
    if (!out.some((l) => l.trim())) {
      out.push("# User Memory", "", "## Entries", "")
    }
    if (out.length && out[out.length - 1].trim()) out.push("")
    out.push(singleReplacements[i].line)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
}

// Build a fresh preference markdown document from form values (no prior file to
// merge into). Used to seed the per-story story/memory/PREFERENCES.md. Returns
// "" when the form is empty so the caller can skip writing (→ global default).
export function buildPreferenceMarkdown(formValue, groups) {
  const hasContent =
    (formValue?.language || "").trim() ||
    (formValue?.proseReference || "").trim() ||
    (Array.isArray(formValue?.styleNestedLines) && formValue.styleNestedLines.length)
  if (!hasContent) return ""
  return rebuildMarkdownFromForm("# User Memory\n\n## Entries\n", formValue, groups)
}
