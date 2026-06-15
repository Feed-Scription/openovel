// Read all the bits a novel export needs out of a story directory.
//
// Returns a plain object — `NovelExportData` — that downstream formatters
// (EPUB / TXT / etc.) can stringify without further filesystem access. Keeps
// the formatters pure and easy to test.
//
// Shape:
//   {
//     storyId, title, brief, locale,
//     chapters: [{ turn, action, paragraphs }],
//     stats: { turnCount, paragraphCount, characterCount },
//     exportedAt,
//   }

import { readFile } from "node:fs/promises"
import path from "node:path"

import { parseChaptersMd } from "./parseChaptersMd.js"

const MAX_TITLE_LEN = 60
const MAX_BRIEF_LEN = 2000

export async function collectNovelData({ storyRoot, locale = "zh" }) {
  if (!storyRoot) throw new Error("collectNovelData: storyRoot is required")
  const [chaptersText, brief, meta] = await Promise.all([
    safeRead(path.join(storyRoot, "canon", "chapters.md")),
    safeRead(path.join(storyRoot, "BRIEF.md")),
    safeReadJson(path.join(storyRoot, "meta.json")),
  ])
  const chapters = demoteAutoSeed(parseChaptersMd(chaptersText))
  const title = pickTitle({ meta, brief, storyRoot })
  const stats = {
    turnCount: chapters.filter((c) => c.turn > 0).length,
    paragraphCount: chapters.reduce((n, c) => n + c.paragraphs.length, 0),
    characterCount: chapters.reduce(
      (n, c) => n + c.paragraphs.reduce((m, p) => m + p.length, 0),
      0,
    ),
  }
  return {
    storyId: meta?.storyId || path.basename(storyRoot),
    title,
    brief: trimText(extractBriefBody(brief), MAX_BRIEF_LEN),
    locale: normalizeLocale(locale),
    chapters,
    stats,
    exportedAt: new Date().toISOString(),
  }
}

// BRIEF.md (see workflows/storyInitWorkflow.persistBriefIfMissing) wraps the
// user's actual brief with a scaffolding header — title, role explanation,
// timestamp, then a `---` divider, then the verbatim intent. For exports we
// only want the intent, not the runtime's framing.
function extractBriefBody(text) {
  const raw = String(text || "").trim()
  if (!raw) return ""
  // First `---` (on its own line) marks the end of the scaffolding header.
  const match = raw.match(/^---\s*$/m)
  if (!match) return raw
  return raw.slice(match.index + match[0].length).trim()
}

async function safeRead(filePath) {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return ""
  }
}

async function safeReadJson(filePath) {
  try {
    const text = await readFile(filePath, "utf8")
    return JSON.parse(text)
  } catch {
    return null
  }
}

function pickTitle({ meta, brief, storyRoot }) {
  const fromMeta = String(meta?.displayName || "").trim()
  if (fromMeta) return trimText(fromMeta, MAX_TITLE_LEN)
  // Fall back: first non-empty line of BRIEF.md, then the directory name.
  const firstBriefLine = String(brief || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  if (firstBriefLine) return trimText(firstBriefLine, MAX_TITLE_LEN)
  return path.basename(storyRoot)
}

function trimText(value, max) {
  const s = String(value || "").trim()
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

function normalizeLocale(locale) {
  const s = String(locale || "").toLowerCase()
  if (s.startsWith("zh")) return "zh"
  return "en"
}

// The runtime's #autoTriggerOpening writes the FIRST `**读者选择**：` block
// as a system seed — the action text is wrapped in full-width `（…）` or
// half-width `(…)` parens, e.g.
//   （开始故事。请根据 FOREGROUND.md 中的 Prelude 与世界设定，写出真正的开场场景。）
//   (Begin the story. Use the Prelude and setup in FOREGROUND.md to compose the actual opening scene.)
// This is non-plot scaffolding text. The narration that follows IS the real
// opening prose, so we keep the narration but rewrite the chapter as turn-0
// "prologue" with no action label, then renumber the rest from 1.
const AUTO_SEED_RE = /^\s*[（(].+[）)]\s*$/

function demoteAutoSeed(chapters) {
  if (!chapters.length) return chapters
  const first = chapters[0]
  if (first.turn !== 1 || !AUTO_SEED_RE.test(first.action || "")) return chapters
  const out = chapters.map((ch, i) => {
    if (i === 0) {
      return { ...ch, turn: 0, action: "", isAutoSeed: true }
    }
    return { ...ch, turn: i }
  })
  return out
}
