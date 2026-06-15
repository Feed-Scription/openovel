// Sentence buffering for streaming TTS.
//
// The narrator streams prose token-by-token, but a TTS engine can only
// synthesize whole clauses — you can't start speaking mid-word. This buffer
// accumulates deltas and emits a sentence the instant a boundary completes, so
// the first (usually short) sentence can start synthesizing while the rest of
// the paragraph is still being generated. That early flush is what makes
// "start reading aloud quickly" possible.
//
// Boundaries cover both CJK and Latin terminators, plus any trailing closing
// quotes/brackets so "他说。" and `"Run!"` flush as one unit. Very short
// fragments are merged forward (a lone "啊！" won't become its own clip).

// First sentence-terminating run at/after `from`; returns the exclusive end
// index, or -1. A terminator (CJK 。！？…, or ASCII ! ? newline, or a run of
// ASCII periods NOT followed by a digit so "3.14" stays intact) plus any
// trailing closing quote/bracket is treated as the boundary.
const BOUNDARY = /(?:[。！？!?…\n]+|\.+(?!\d))["'”’」』）)】]*/g

function findBoundaryEnd(str, from) {
  BOUNDARY.lastIndex = from
  const m = BOUNDARY.exec(str)
  return m ? m.index + m[0].length : -1
}

export function createSentenceBuffer({ minLength = 6 } = {}) {
  let buffer = ""

  return {
    // Append a streamed delta; return any newly-completed sentences (often []).
    push(delta) {
      buffer += String(delta ?? "")
      const out = []
      let searchFrom = 0
      while (true) {
        const end = findBoundaryEnd(buffer, searchFrom)
        if (end === -1) break
        const candidate = buffer.slice(0, end)
        if (candidate.trim().length >= minLength) {
          out.push(candidate)
          buffer = buffer.slice(end)
          searchFrom = 0
        } else {
          // Too short to stand alone — keep scanning so it merges with the next
          // clause rather than becoming its own tiny audio clip.
          searchFrom = end
        }
      }
      return out
    },

    // Emit whatever remains (end of narration), even if shorter than minLength.
    flush() {
      const rest = buffer
      buffer = ""
      return rest.trim() ? [rest] : []
    },

    pending() {
      return buffer
    },

    reset() {
      buffer = ""
    },
  }
}
