// The reader-facing 序 (preface). The init scaffold writes it as a `## Prelude`
// section at the top of story/frontend/header.md, where it doubles as the
// narrator's lead-in context AND the preface shown to readers (Live web + the
// Electron app). This extractor is the single source of truth for "what counts
// as the Prelude," shared by the Live server (reads header.md) and the renderer
// (reads it out of the composed foregroundGuidance). Pure + dependency-free, so
// it is safe to import from a bundled renderer.

// Return the Prelude body (the `## Prelude` heading stripped), up to the next
// `##` heading; "" when there is no Prelude. CRLF-tolerant, case-insensitive.
export function extractPrelude(markdown) {
  const lines = String(markdown || "").split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Prelude\b/i.test(l.trim()))
  if (start < 0) return ""
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break // next section heading ends the Prelude
    body.push(lines[i])
  }
  return body.join("\n").trim()
}
