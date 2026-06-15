import { readText, writeText } from "../lib/files.js"
import { initializeStory, paths } from "../lib/storyStore.js"

// Append a websearch result block to the runtime-managed search log.
// The file (story/research/search-log.md) is append-only from the model's
// perspective — models READ it freely (for "have I already searched
// this?" checks) but should not write or edit it; the runtime does that
// for them every time `websearch` runs.
//
// Models who want to organize findings, highlight URLs to follow up on,
// or write distilled notes use story/research/ResearchNotes.md instead —
// see paths.researchNotes.
export async function appendSearchResultsToResearch({ query, provider, results = [] }) {
  await initializeStory()
  const current = await readText(paths.searchLog, "# Search Log\n\n")
  const block = [
    `## Search ${new Date().toISOString()}`,
    "",
    `- Query: ${oneLine(query)}`,
    `- Provider: ${provider?.id || provider || "unknown"}`,
    "- Scope: discovery only; use webfetch for retrieval and source reading.",
    "",
    ...(results.length
      ? results.map((item, index) =>
          [
            `${index + 1}. ${oneLine(item.title || item.url)}`,
            `   - URL: ${item.url}`,
            item.snippet ? `   - Snippet: ${oneLine(item.snippet, 500)}` : "",
            item.publishedAt ? `   - Published: ${oneLine(item.publishedAt)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : ["No results."]),
  ].join("\n")
  await writeText(paths.searchLog, `${current.trimEnd()}\n\n${block}\n`)
  return {
    filePath: "story/research/search-log.md",
    absolutePath: paths.searchLog,
  }
}

function oneLine(value, maxChars = 300) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}
