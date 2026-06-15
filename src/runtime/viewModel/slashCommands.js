// Canonical slash-command catalog. The ink UI uses this to render the
// /-prefix suggestion popup, the help command renders the same list as text.
// Keep `label` ≤ 22 chars and `description` ≤ 60 chars so they fit on one
// row inside the suggestion popup without wrapping into the input box.

export const SLASH_COMMANDS = [
  { match: "/help", label: "/help", description: "Show command reference." },
  { match: "/providers", label: "/providers", description: "Provider routing + key status." },
  { match: "/config", label: "/config", description: "Settings layers + effective config." },
  { match: "/context", label: "/context", description: "Compile foreground context for inspection." },
  { match: "/memory", label: "/memory", description: "Story + user memory snapshot." },
  { match: "/recompile-context", label: "/recompile-context", description: "Re-compile + diff foreground context." },
  { match: "/options", label: "/options [on|off]", description: "Toggle post-narration options call." },
  { match: "/preferences", label: "/preferences", description: "Show or reset onboarding preferences." },
  { match: "/stories", label: "/stories", description: "List all stories; mark active." },
  { match: "/permissions", label: "/permissions", description: "List pending permission requests." },
  { match: "/approve", label: "/approve <id>", description: "Approve a permission request." },
  { match: "/deny", label: "/deny <id>", description: "Deny a permission request." },
  { match: "/transactions", label: "/transactions [limit]", description: "List recent file write transactions." },
  { match: "/rollback", label: "/rollback <txId>", description: "Restore files from a transaction snapshot." },
  { match: "/new-story", label: "/new-story <name>", description: "Create + switch; opens worldbook editor." },
  { match: "/switch-story", label: "/switch-story <name>", description: "Hot-switch to an existing story." },
]

// Filter to commands whose token prefix matches the input (e.g., "/n" → all
// commands starting with "/n"). Returns the catalog as-is when input is just
// "/".
export function suggestSlashCommands(input) {
  const value = String(input || "")
  if (!value.startsWith("/")) return []
  const token = value.split(/\s+/)[0].toLowerCase()
  if (token === "/") return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => c.match.startsWith(token))
}
