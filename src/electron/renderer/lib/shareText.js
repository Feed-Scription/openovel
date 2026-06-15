// Pure helpers for the paragraph-share feature. No DOM/React — unit-testable.

// A share card is plain prose: strip any reserved `ovl:<kind>` fenced blocks
// (rich-render / hud / include directives) so they don't show up as raw code in
// the exported image. Collapses the blank lines the removal leaves behind.
export function stripOvlFences(text) {
  return String(text || "")
    .replace(/```ovl:[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function slugify(name) {
  return String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

// Default filename for a saved paragraph image. The native save dialog lets the
// reader rename, so this just needs to be a sensible, filesystem-safe default.
export function shareImageFilename(storyName) {
  const slug = slugify(storyName)
  return `openovel-${slug || "paragraph"}.png`
}
