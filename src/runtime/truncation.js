import path from "node:path"
import { writeText } from "../lib/files.js"
import { paths } from "../lib/storyStore.js"

const DEFAULT_MAX_LINES = 2000
const DEFAULT_MAX_BYTES = 50 * 1024
export async function truncateOutput(text, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const direction = options.direction ?? "head"
  const value = String(text ?? "")
  const lines = value.split("\n")
  const bytes = Buffer.byteLength(value, "utf8")
  if (lines.length <= maxLines && bytes <= maxBytes) {
    return { content: value, truncated: false }
  }

  const file = path.join(paths.root, "tool-output", `tool_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`)
  await writeText(file, value)

  const selected = direction === "tail" ? lines.slice(-maxLines) : lines.slice(0, maxLines)
  let preview = selected.join("\n")
  while (Buffer.byteLength(preview, "utf8") > maxBytes && preview.length > 0) {
    preview = direction === "tail" ? preview.slice(1000) : preview.slice(0, -1000)
  }

  const omitted = direction === "tail" ? lines.length - selected.length : lines.length - selected.length
  const hint = `\n\n...output truncated (${omitted} lines omitted). Full output saved to: ${file}`
  return {
    content: direction === "tail" ? `${hint}\n\n${preview}` : `${preview}${hint}`,
    truncated: true,
    outputPath: file,
  }
}
