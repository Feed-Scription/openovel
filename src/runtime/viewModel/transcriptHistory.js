import { readFile } from "node:fs/promises"
import { reportNotices } from "../../lib/notices.js"

// Load recent reader-action + foreground-turn pairs from scene_log.jsonl so a
// re-entry into the app can replay the last N turns. Tolerates partial /
// corrupt last lines (skips unparseable rows) and returns oldest→newest.
//
// Returns:
//   {
//     entries: [{ id, type: "user"|"narration", text, complete: true }, ...],
//     lastOptions: string[],      // options of the latest foreground_turn, if any
//   }
export async function loadTranscriptHistory(sceneLogPath, { maxTurns = 30 } = {}) {
  if (!sceneLogPath) return { entries: [], lastOptions: [] }
  let text = ""
  try {
    text = await readFile(sceneLogPath, "utf8")
  } catch {
    return { entries: [], lastOptions: [] }
  }
  if (!text) return { entries: [], lastOptions: [] }

  // Pair reader_action + foreground_turn by turnId. A turn is "done" when both
  // events are present. We only display completed turns.
  const turns = new Map() // turnId -> { at, action, foreground }
  const lines = text.split(/\r?\n/)
  // Index of the last non-empty line: a partial JSON there is the normal
  // mid-write tail and is expected. A corrupt line BEFORE it is real mid-file
  // data loss worth surfacing (the turn it belonged to silently vanishes).
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { lastNonEmpty = i; break } }
  const corruptMidFile = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      if (i !== lastNonEmpty) corruptMidFile.push(i + 1)
      continue
    }
    const turnId = event.turnId
    if (!turnId) continue
    if (event.type === "reader_action") {
      const cur = turns.get(turnId) || {}
      // `hidden` reader actions (e.g. the internal "open the scene" kickoff) are
      // never reader-facing — keep the resulting narration, drop the action line.
      turns.set(turnId, { ...cur, at: cur.at || event.at, action: String(event.action || ""), hidden: cur.hidden || Boolean(event.hidden) })
    } else if (event.type === "foreground_turn") {
      const cur = turns.get(turnId) || {}
      turns.set(turnId, { ...cur, at: cur.at || event.at, foreground: event.foreground })
    }
  }
  if (corruptMidFile.length) {
    reportNotices(
      [`scene_log.jsonl has ${corruptMidFile.length} unparseable line(s) mid-file (lines ${corruptMidFile.slice(0, 5).join(", ")}${corruptMidFile.length > 5 ? "…" : ""}); affected turns are missing from the replayed transcript`],
      { event: "data.corruption", prefix: "transcript" },
    )
  }
  const completed = [...turns.values()].filter((t) => t.action !== undefined && t.foreground)
  completed.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const tail = completed.slice(-maxTurns)

  const entries = []
  for (const t of tail) {
    if (t.action && !t.hidden) {
      entries.push({
        id: `replay_user_${entries.length}`,
        type: "user",
        text: t.action,
        complete: true,
      })
    }
    const narration = String(t.foreground?.narration || "").trim()
    if (narration) {
      entries.push({
        id: `replay_narr_${entries.length}`,
        type: "narration",
        text: narration,
        complete: true,
      })
    }
  }

  const last = tail[tail.length - 1]
  const lastOptions = Array.isArray(last?.foreground?.options) ? [...last.foreground.options] : []
  const lastFraming = typeof last?.foreground?.framing === "string" ? last.foreground.framing : ""
  return { entries, lastOptions, lastFraming }
}
