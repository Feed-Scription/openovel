// Parse a slash-style command line into positional args, --flags, and --opt value.
// Extracted from tui.js so both the raw renderer and ink can share the same parser.
//
// Examples:
//   "/new-story foo --worldbook x.md"  →
//     { positional: ["/new-story", "foo"], flags: Set{worldbook}, options: { worldbook: "x.md" } }
//   "/preferences reset --keep-research" →
//     { positional: ["/preferences", "reset"], flags: Set{keep-research}, options: {} }
export function parseSlashArgs(action) {
  const tokens = String(action || "").trim().split(/\s+/).filter(Boolean)
  const positional = []
  const flags = new Set()
  const options = {}
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith("--")) {
      const name = tok.slice(2)
      const next = tokens[i + 1]
      if (next && !next.startsWith("--")) {
        options[name] = next
        flags.add(name)
        i++
      } else {
        flags.add(name)
      }
    } else {
      positional.push(tok)
    }
  }
  return { positional, flags, options }
}
