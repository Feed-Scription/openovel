import { performance } from "node:perf_hooks"
import { chatCompletion, hasModelKey, modelInfo } from "../provider/provider.js"
import { resolveModelProfile } from "../provider/modelProfiles.js"
import { compileForegroundContext, contextBudgetDefaults } from "../context/contextCompiler.js"
import { buildForegroundUserContext } from "../context/contextCapsule.js"
import { parseJsonObject } from "./json.js"
import { foregroundNarratorContract, comicScriptOutputContract } from "../prompts/agentContracts.js"
import { isFormatContractEnabled, isCustomRichBlocksEnabled, isImageBackgroundEnabled, isMusicGenEnabled, isStoryIncludesEnabled, loadFormatContract } from "./formatContract.js"
import { normalizeOvlFences, listOvlFenceKinds, RESERVED_OVL_KINDS } from "./ovlFences.js"
import { reportNotices } from "./notices.js"
import { optionLabel, normalizeChoiceText } from "./optionLabel.js"
import { recordProfileEvent } from "../telemetry/usageProfile.js"

// The narrator owns only prose generation. Post-narration
// products (options, context-card selection, future affordances) are registry
// producers in runtime/postNarrationRegistrations.js. generateForegroundTurn is
// kept as a compatibility wrapper for direct callers/tests.

export async function generateForegroundTurn({
  action,
  snapshot,
  onNarrationChunk,
  onNarrationComplete,
  optionsEnabled = true,
} = {}) {
  return generateForegroundTurnWithStream({ action, snapshot, onNarrationChunk, onNarrationComplete, optionsEnabled })
}

export async function generateForegroundTurnWithStream({
  action,
  snapshot,
  onNarrationChunk,
  onNarrationComplete,
  optionsEnabled = true,
} = {}) {
  const narrated = await generateForegroundNarration({ action, snapshot, onNarrationChunk })
  notifyNarrationComplete(onNarrationComplete, { action, ...narrated, snapshot })
  const optionResult = optionsEnabled
    ? await generateForegroundOptions({ action, narration: narrated.narration, compiledContext: narrated.compiledContext, snapshot })
    : { options: [], tension: "reader-directed", storyComplete: false }
  return finalizeForegroundTurn({
    action,
    snapshot,
    narration: narrated.narration,
    optionResult,
    optionsEnabled,
  })
}

// First N characters used to detect a repeated opening (the narrator getting
// stuck re-opening with the same sentence as the previous turn).
const NARRATION_OPENING_CHARS = 50

function plainModeControlFenceList() {
  const fences = [
    "```ovl:hud``` (status values)",
    ...(isStoryIncludesEnabled() ? ["```ovl:include``` (embedding prepared story/includes/ files)"] : []),
    ...(isImageBackgroundEnabled() ? ["```ovl:bg``` (scene backdrop)"] : []),
    ...(isMusicGenEnabled() ? ["```ovl:music``` (music cues)"] : []),
  ]
  return fences.join(", ")
}

function systemReservedFormatContract() {
  const lines = [
    "<system_reserved_formats>",
    "These are host-owned control channels, not custom story-card blocks. Use them only when Foreground Guidance / the story config gives a real slot, path, or cue. Emit the STANDARD syntax below; old saves may parse looser variants, but you must not create new loose variants.",
    "All reserved fences: the opening line is ONLY the fence language, body data is on its own lines, and the closing ``` is alone on its own line. Never put payload on the opening line.",
    "```ovl:hud``` persistent compact header status. Body: one `<slot-id-or-label>: <short-value>` line per value you are updating. HARD HUD BREVITY: a HUD value is a glance token, not prose. Keep each value to 1 short phrase, ideally <=12 CJK chars or <=3 English words. Never write a sentence, a comma-list, a long location chain, a full explanation, or multiple clauses in HUD. If a detail needs more words, put it in the narration, not the HUD. Prefer 3-4 meaningful slots; omit the HUD when nothing compact changed. Values persist per key until you change them; a slot you have never filled stays hidden, and emitting a key with an empty value clears and hides that slot.",
  ]
  if (isStoryIncludesEnabled()) {
    lines.push(
      "```ovl:include``` embeds prepared files from `story/includes/`. Body uses `@include story/includes/<path>` on its own line, followed by optional `alt: ...` and `caption: ...` lines. Use only paths explicitly prepared/allowed by Foreground Guidance; never invent paths, never embed character reference sheets unless explicitly permitted.",
    )
  }
  if (isImageBackgroundEnabled()) {
    lines.push(
      "```ovl:bg``` controls the scene backdrop. Body is EXACTLY ONE directive line: `set: story/includes/bg/<file>` to switch, or `clear` to remove. The `set:` verb prefix is required: a bare file path on its own is not a directive. It persists across turns; use at most once in a turn, only on real scene/place/time changes, and only for prepared background images.",
    )
  }
  if (isMusicGenEnabled()) {
    lines.push(
      "```ovl:music``` controls the now-playing bar. Body is `bgm: <short-id>`, `play: <short-id>`, or `stop`. Use only catalog short ids named in Foreground Guidance; descriptive cue text is not a playable id.",
    )
  }
  lines.push("</system_reserved_formats>")
  return lines.join("\n")
}

// Normalized opening key: leading/trailing whitespace trimmed, first N chars.
export function narrationOpeningKey(text, n = NARRATION_OPENING_CHARS) {
  return String(text || "").trim().slice(0, n)
}

// The instruction that opens a story: the reader's (auto-submitted) first action
// when they enter interactive mode. The narrator treats it as the first input
// and composes the real opening from the Prelude + setup. Shared so the live
// open (sessionViewModel #autoTriggerOpening) and the init narration preview use
// the SAME instruction and can never drift. CJK anywhere in `localeHint` (the
// worldbook or freshly-written FOREGROUND.md) picks the Chinese form.
export function openingTriggerAction(localeHint = "") {
  const isCjk = /[㐀-鿿]/.test(String(localeHint || ""))
  return isCjk
    ? "（开始故事。请根据 FOREGROUND.md 中的 Prelude 与世界设定，写出真正的开场场景。）"
    : "(Begin the story. Use the Prelude and setup in FOREGROUND.md to compose the actual opening scene.)"
}

// Opening key of the PREVIOUS turn's narration, pulled from the canon tail.
// chapters.md blocks are "**读者选择**：<action>\n\n<narration>"; we take the
// last block and strip its action header line. Empty when there's no prior
// narration (first turn) — the harness then does no gating.
export function previousNarrationOpeningKey(snapshot, n = NARRATION_OPENING_CHARS) {
  const text = String(snapshot?.chapters || "")
  if (!text.trim()) return ""
  const idx = text.lastIndexOf("**读者选择**")
  const tail = idx >= 0 ? text.slice(idx).replace(/^[^\n]*\n+/, "") : text
  return narrationOpeningKey(tail, n)
}

// Fast register (per-story fast mode) length accounting. The register's
// numbers live in the narrator contract (aim 300 to 500, hard ceiling 600);
// these helpers measure what the model actually produced so the next turn's
// capsule can carry the correction and the overrun is never silent. Control
// fences (hud/bg/music/...) are render channels, not prose, so they are
// excluded; a trailing unclosed fence (stream cut) is stripped to the end.
export const FAST_PROSE_CEILING = 600

export function proseCharCount(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/```[\s\S]*$/, "")
    .replace(/\s+/g, "").length
}

// Prose length of the most recent narration in the snapshot's chapters (the
// tail after the last reader-action header), for the fast-mode measured-
// feedback line. Returns 0 when there is no previous turn.
export function previousNarrationProseChars(snapshot) {
  const text = String(snapshot?.chapters || "")
  const idx = text.lastIndexOf("**读者选择**")
  if (idx < 0) return 0
  return proseCharCount(text.slice(idx).replace(/^[^\n]*\n+/, ""))
}

function narratorRepeatAttempts() {
  const v = Number(process.env.OPENOVEL_NARRATOR_REPEAT_RETRIES)
  const retries = Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 4) : 1
  return retries + 1
}

// Streaming gate that decides char-by-char. It holds back only the leading
// run that still matches the previous turn's opening; the moment an incoming
// character DIFFERS from the previous opening it flushes everything buffered
// and switches to passthrough — so a non-repeat turn starts displaying after
// the very first divergent character (usually the first char), with no 50-char
// stall. It suppresses (→ caller discards + regenerates) only when the new
// prose re-matches the ENTIRE previous opening window. On the final attempt
// `guard` is false: pure passthrough.
export function createRepetitionGate({ prevOpening, guard, forward }) {
  const prevChars = [...String(prevOpening || "")]
  let decided = !guard || prevChars.length === 0
  let suppress = false
  let matchPos = 0      // leading chars confirmed identical to prevChars
  let buffer = ""       // held-back run still possibly part of a repeat
  const emit = (s) => { if (s && forward) forward(s) }
  const accept = () => { decided = true; suppress = false; if (buffer) { emit(buffer); buffer = "" } }
  return {
    onDelta(delta) {
      const text = delta?.content
      if (!text) return
      if (decided) { if (!suppress) emit(text); return }
      buffer += text
      const chars = [...buffer]
      // advance over the confirmed-matching prefix
      while (matchPos < chars.length && matchPos < prevChars.length && chars[matchPos] === prevChars[matchPos]) {
        matchPos += 1
      }
      if (matchPos >= prevChars.length) {
        // re-matched the entire previous opening window → repeat
        decided = true
        suppress = true
        buffer = ""
        return
      }
      if (matchPos < chars.length) {
        // hit a character that differs from the previous opening → not a
        // repeat; release everything held so far and stream the rest live
        accept()
      }
      // else: ran out of buffer while still matching the prefix — keep holding
    },
    // Stream ended. If still undecided the new prose was a strict (shorter)
    // prefix of the previous opening, never re-matching it fully → accept.
    finalize() {
      if (!decided) accept()
      return suppress
    },
  }
}

export async function generateForegroundNarration({ action, snapshot, onNarrationChunk } = {}) {
  if (!hasModelKey()) {
    const turn = fallbackTurn(action, snapshot, { optionsEnabled: false })
    onNarrationChunk?.(turn.narration)
    return { narration: turn.narration, compiledContext: null, source: "fallback" }
  }
  markPreFirstChunk("narration_start", { actionChars: String(action || "").length })
  const compiledContext = await profilePreFirstChunkStep(
    "compile_foreground_context",
    () => compileForegroundContext({ snapshot, action }),
    (value) => ({
      foregroundChars: String(value?.foregroundGuidance || "").length,
      storyMemoryChars: String(value?.storyMemory || "").length,
      recentCanonChars: String(value?.recentCanonExcerpt || "").length,
    }),
  )
  const fastMode = snapshot?.fastMode === true
  // Measured feedback for the fast register: when the PREVIOUS turn overran
  // the ceiling, tell the model by how much (in the capsule) instead of only
  // repeating the static budget.
  const prevProseChars = fastMode ? previousNarrationProseChars(snapshot) : 0
  const fastOverrunChars = prevProseChars > FAST_PROSE_CEILING ? prevProseChars : 0
  const baseMessages = profilePreFirstChunkSync(
    "build_narrator_messages",
    // Comic / fast mode ride the snapshot (sessionProcessor resolves the
    // per-story meta + global gate once per turn) so this stays a pure function.
    () => buildNarratorMessages({ action, compiledContext, comicMode: snapshot?.comicMode === true, fastMode, fastOverrunChars }),
    (value) => ({
      messageCount: Array.isArray(value) ? value.length : 0,
      inputChars: JSON.stringify(value || []).length,
    }),
  )

  // Repetition harness: if the narration opens with the same 50 chars as the
  // previous turn (a known degradation — most often when the same option is
  // offered/chosen twice, so the reader action equals the last action sitting
  // in Recent Canon), discard it and regenerate. The gate suppresses the
  // rejected attempt's stream so the reader never sees it.
  const prevOpening = profilePreFirstChunkSync(
    "previous_narration_opening",
    () => previousNarrationOpeningKey(snapshot),
    (value) => ({ chars: String(value || "").length }),
  )
  const attempts = prevOpening ? narratorRepeatAttempts() : 1
  markPreFirstChunk("narration_repeat_guard", { attempts, prevOpeningChars: prevOpening.length })
  let narration = ""
  // Start from the base prompt; after a detected repeat, retry with an added
  // corrective note — regenerating with the IDENTICAL prompt tends to repeat
  // again, so the note is what actually makes the next attempt diverge.
  let attemptMessages = baseMessages
  let firstRawDeltaSeen = false
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const guard = attempt < attempts
    const gate = createRepetitionGate({ prevOpening, guard, forward: onNarrationChunk })
    const onDelta = (delta) => {
      const content = String(delta?.content || "")
      if (!firstRawDeltaSeen && content) {
        firstRawDeltaSeen = true
        markPreFirstChunk("narrator_first_raw_delta", { attempt, chunkChars: content.length })
      }
      gate.onDelta(delta)
    }
    markPreFirstChunk("narrator_attempt_start", { attempt, guard })
    const attemptStartedAt = performance.now()
    narration = await callNarrator({ messages: attemptMessages, onDelta, attempt, fastMode })
    const repeated = gate.finalize(narration)
    recordProfileEvent({
      name: "narrator_attempt_complete",
      category: "narration",
      durationMs: performance.now() - attemptStartedAt,
      metadata: { attempt, repeated, outputChars: narration.length },
    })
    if (!guard || !repeated) break
    attemptMessages = [...baseMessages, repetitionRetryNote()]
  }
  narration = await repairOvlFences(narration)
  // Fast-register overrun is observable, never silent: the next turn's
  // capsule auto-carries the measured correction, and the operator/bus sees
  // the drift (a run of these means the register is being ignored, not that
  // one turn ran long).
  if (fastMode) {
    const chars = proseCharCount(narration)
    if (chars > FAST_PROSE_CEILING) {
      reportNotices(
        [`fast-mode narration ran ${chars} characters of prose, over the ${FAST_PROSE_CEILING}-char fast-register ceiling (target 300 to 500); the next turn's capsule will carry the measured correction.`],
        { event: "narrator.fast_register_overrun", prefix: "narrator" },
      )
    }
  }
  return { narration, compiledContext, source: modelInfo().provider }
}

// Post-narration fence hygiene, applied to the PERSISTED text (the renderer
// runs the same normalization on display, so streams and old saves match).
// Two failure modes, both otherwise silent:
// a fence opener carrying its key/value payload inline with an empty body
// (the parsers read only the body, so the data vanished), and a fence kind
// that is neither a reserved channel nor a contract block (it renders as a
// plain code box). The first is repaired; both are reported via notices so
// the slow loop can tighten the rich-rendering guidance.
async function repairOvlFences(narration) {
  if (!isFormatContractEnabled()) return narration
  const normalized = normalizeOvlFences(narration)
  if (normalized.fixes.length) {
    reportNotices(
      normalized.fixes.map((kind) => `narrator put data on the \`\`\`ovl:${kind} fence opening line; moved it into the fence body so it renders. Tighten story/frontend/rich-rendering.md: the opening line carries only the fence language, every value line goes inside the body.`),
      { event: "narrator.ovl_fence_normalized", prefix: "narrator" },
    )
  }
  const kinds = listOvlFenceKinds(normalized.text)
  if (kinds.length) {
    const known = new Set(RESERVED_OVL_KINDS)
    try {
      const contract = await loadFormatContract()
      for (const block of contract?.blocks || []) known.add(block.kind)
    } catch { /* unreadable contract: reserved kinds still validate */ }
    const unknown = kinds.filter((kind) => !known.has(kind))
    if (unknown.length) {
      reportNotices(
        unknown.map((kind) => `narration emitted \`\`\`ovl:${kind}\`\`\` but "${kind}" is neither a reserved channel (${RESERVED_OVL_KINDS.join("/")}) nor a story/format/blocks/ kind; it renders as a plain code box. Fix the guidance that taught it (story/frontend/rich-rendering.md) or author blocks/${kind}.html.`),
        { event: "narrator.ovl_fence_unknown_kind", prefix: "narrator" },
      )
    }
  }
  return normalized.text
}

// Corrective appended to the prompt after the gate caught a repeat. The first
// attempt reused the previous beat's opening; this tells the model exactly what
// went wrong so the regeneration moves forward instead of replaying.
function repetitionRetryNote() {
  return {
    role: "user",
    content: [
      "<retry_note>",
      "Your previous attempt re-opened with the SAME text as the most recent narration already in Recent Canon, you replayed a beat that has already happened. Discard that opening entirely. The reader's action is a NEW forward turn: continue from the exact end of Recent Canon and advance to the next moment. Do not reproduce or paraphrase any beat already in Recent Canon; open with a different, forward-moving sentence.",
      "</retry_note>",
    ].join("\n"),
  }
}

async function callNarrator({ messages, onDelta, attempt = 1, fastMode = false }) {
  // Narration prose on the LARGE model (AI_LARGE_MODEL), but on the foreground
  // provider so thinking stays off by default — see the "narrator" profile.
  const profile = resolveModelProfile("narrator")
  const startedAt = performance.now()
  markPreFirstChunk("narrator_provider_request_start", {
    attempt,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    inputChars: JSON.stringify(messages || []).length,
  })
  const content = await chatCompletion({
    role: profile.role,
    model: profile.model,
    modelProfile: profile.id,
    // Narration stays NON-thinking even on a thinking-capable large model
    // (e.g. deepseek-v4-pro): force thinking off per-call rather than relying
    // on provider/model defaults, since the user picks the model.
    disableThinking: true,
    temperature: 0.86,
    // 520 was clipping rich Po-style scenes (氛围 + KC 旁白 + 对峙细节
    // typically wants 800-1500 chars = 1000-1900 tokens). Set to 32000 to
    // effectively remove the ceiling — provider capabilities clamp to the
    // model's actual API limit (v4-flash: 8192). Model only generates what
    // it needs (maxTokens is an upper bound), so cost stays naturally
    // bounded by prose length. Display pacing (OPENOVEL_DISPLAY_CPM=720)
    // caps user-visible read time independently.
    //
    // Fast mode: the contract asks for a 300-500 char burst with a hard 600
    // ceiling, but the LENGTH enforcement is prompt-side (the capsule's fast
    // register reminder + measured-overrun feedback + the overrun notice),
    // NEVER this token cap: a cap tight enough to enforce the register
    // truncates mid-sentence and mid-fence on the dense tokenizers
    // (tokens-per-CJK-char varies ~0.65 deepseek to ~1.3 others, so 800
    // tokens could bite at ~600 chars: exactly a normal overshoot). 2000
    // tokens (~1500-3000 chars) never engages on an overshooting-but-sane
    // turn; it only stops a runaway model from streaming a full-length scene
    // forever.
    maxTokens: fastMode ? 2000 : 32000,
    // Per-call overall timeout. The chunk-stall timer (30s by default in
    // openaiCompatible) still catches truly hung connections; this is just
    // the upper wall for "this single turn shouldn't take more than X".
    //
    // Default 180s — generous enough for slower providers (Kimi For Coding,
    // long ornate prose) without making genuine hangs feel infinite. DeepSeek
    // v4-flash typically returns in 8-15s so the bump is invisible to it.
    // Override with OPENOVEL_NARRATOR_TIMEOUT_MS.
    timeoutMs: Number(process.env.OPENOVEL_NARRATOR_TIMEOUT_MS) || 180000,
    json: false,
    stream: true,
    onDelta,
    messages,
  })
  recordProfileEvent({
    name: "narrator_provider_request_complete",
    category: "narration",
    durationMs: performance.now() - startedAt,
    metadata: { attempt, outputChars: content.length },
  })
  return content
}

async function profilePreFirstChunkStep(name, fn, metadata = undefined) {
  const startedAt = performance.now()
  try {
    const value = await fn()
    markPreFirstChunk(name, metadataFor(metadata, value), performance.now() - startedAt)
    return value
  } catch (error) {
    markPreFirstChunk(name, {
      status: "error",
      error: error?.message || String(error),
    }, performance.now() - startedAt)
    throw error
  }
}

function profilePreFirstChunkSync(name, fn, metadata = undefined) {
  const startedAt = performance.now()
  try {
    const value = fn()
    markPreFirstChunk(name, metadataFor(metadata, value), performance.now() - startedAt)
    return value
  } catch (error) {
    markPreFirstChunk(name, {
      status: "error",
      error: error?.message || String(error),
    }, performance.now() - startedAt)
    throw error
  }
}

function markPreFirstChunk(name, metadata = undefined, durationMs = undefined) {
  recordProfileEvent({
    name,
    category: "pre_first_chunk",
    durationMs,
    metadata,
  })
}

function metadataFor(metadata, value) {
  return typeof metadata === "function" ? metadata(value) : metadata
}

export function buildNarratorMessages({ action, compiledContext, comicMode = false, fastMode = false, fastOverrunChars = 0 }) {
  return [
      {
        role: "system",
        // Keep the system prompt focused on role and output contract. Narrative
        // behavior should come from foreground guidance, memory, recent canon,
        // and the reader action rather than a large pile of generic craft rules.
        content: [
          "<role>",
          comicMode
            ? "You are the foreground narrator for an interactive picture-story (连环画). The user message contains the reader's latest action plus the working context (Foreground Guidance, Context Inserts, Durable Memory, Recent Canon). Advance the story by one beat, delivered as the panel script defined in the output contract."
            : "You are the foreground narrator for an interactive novel. The user message contains the reader's latest action plus the working context (Foreground Guidance, Context Inserts, Durable Memory, Recent Canon). Advance the story by one beat.",
          "</role>",
          foregroundNarratorContract({ comic: comicMode, fast: !comicMode && fastMode }),
          "<observed_failure_modes>",
          // Scoped prompt-contract markers for concrete failure modes. Avoid
          // generic IF craft advice here; the story files carry the style rules.
          "Don't introduce named characters in this turn's narration who do not appear in Foreground Guidance, Context Inserts, or Recent Canon. Anonymous people are fine; new named entities need an existing card or canon precedent.",
          "Don't reveal information the protagonist couldn't yet know from in-scene observation. Hidden motives, off-screen events, and other characters' internal states surface only when an in-scene event or a Context Insert makes them visible.",
          "IMPORTANT: Recent Canon is the authoritative record of what has actually happened, the most recent turns included. Foreground Guidance and Context Inserts are maintained asynchronously by a background process and can LAG one or more turns behind the latest events, their scene, the protagonist's position, and 'just happened' details may be stale. When continuing the story, anchor on where Recent Canon actually left off; if Foreground Guidance disagrees with Recent Canon about the CURRENT situation (where the protagonist is, what just occurred, who is present), trust Recent Canon and continue from the prose. Keep using Foreground Guidance / Durable Memory for durable facts, character protocols (names, promises, what each party knows), tone, and forward intent, those stay in force even when the scene description has lagged.",
          fastMode && !comicMode
            // Fast mode flips the progression default: the per-story register
            // (an explicit reader choice) governs turn length and default time
            // compression; preference tags still steer tone/POV/diction and
            // may slow a specific scene, but they don't restore the
            // beat-by-beat default.
            ? "IMPORTANT: Begin SEAMLESSLY from the exact moment Recent Canon ended, same scene, the protagonist's final position, any action still in progress, with no gap or contradiction at the seam and no opening recap of elapsed events. The first sentence reads as the direct next beat after Recent Canon's last sentence. HOW FAR this turn then advances in time follows the FAST REGISTER above: montage-style compression toward the next meaningful decision is the default. A progression-speed preference in Durable Memory may hold a specific high-stakes scene closer to real time, but the per-story fast register governs turn length and the default amount of time compression. When the turn does advance time, narrate the transition as it passes; never a jarring cut, and never contradict or silently drop anything Recent Canon established. The reader's action drives WHAT happens; the fast register drives how far time moves."
            : "IMPORTANT: Begin SEAMLESSLY from the exact moment Recent Canon ended, same scene, the protagonist's final position, any action still in progress, with no gap or contradiction at the seam and no opening recap of elapsed events. The first sentence reads as the direct next beat after Recent Canon's last sentence. HOW FAR this turn then advances in time is governed by the reader's progression-speed preference in Durable Memory (the 'Time per turn' / 推进速度 style tag), NOT chosen freely: by default, and when no such preference is set, stay within the continuous present moment and advance beat by beat. A fine-grain preference (hour by hour, scene by scene) holds close to real time. A faster preference (skip the lulls, across years) lets the prose compress uneventful stretches and carry the story to the next meaningful beat, even across days, months, or longer. When the turn does advance time, narrate the transition as it passes; never a jarring cut, and never contradict or silently drop anything Recent Canon established. The reader's action drives WHAT happens; the progression preference alone drives how far time moves.",
          "IMPORTANT: The reader's action may closely resemble, or be word-for-word IDENTICAL to, an action and beat already shown at the END of Recent Canon. This happens routinely when the same option is offered and chosen again, or the reader retypes a similar instruction. It is STILL a new, forward turn. Never reproduce, re-open with, or paraphrase a beat that already appears in Recent Canon, writing the previous turn's narration again is the single worst failure here. Treat a repeated action as \"continue / do more of this,\" not \"replay the last beat\": carry the action a step further, narrate its consequence, or move to the next moment. The first sentence must be new text that moves the story strictly forward from where Recent Canon ends, if your opening would echo Recent Canon's last beat, choose a different one.",
          "IMPORTANT: If the reader's action conflicts with the established situation, it asks for something the current state makes impossible, assumes a place/time/companion the protagonist has already left behind, contradicts what just happened, or breaks a durable fact, do NOT refuse it, break character, or silently ignore it, but ALSO do NOT rewind, reset, or jump the scene backward to a moment where the action would have fit. Reconcile it (圆回去) FROM the current end-state: read the intent charitably and re-express it as what the protagonist does NOW given where they actually are (e.g. they reconsider and act on the impulse from their current position, the attempt lands partially or is redirected by the present circumstances, or they decide to pursue it and the prose narrates the transition step by step). The action bends to the established now, the now never silently resets to fit the action. Preserve the reader's agency while keeping one continuous, contradiction-free timeline.",
          // Guard against name blending under lexical interference: when a
          // character has multiple valid identifiers, the model can invent a
          // third by recombining nearby strings. Force verbatim names from
          // Foreground Guidance instead.
          "When a character is listed in Foreground Guidance with multiple names or identifiers (real name vs alias, formal vs casual, role-name vs given-name), pick one of the listed names verbatim, never coin a new name by combining characters from two of them, even if the alternate name was used in the immediately preceding sentence (e.g. in dialogue). Which name to use is determined by the listener's relationship to the character as declared in the guidance, not by surface proximity in the prompt. Spell character names exactly as they appear in Foreground Guidance; do not substitute homophones or visually similar characters.",
          "IMPORTANT: Durable Memory > User Preferences encodes the reader's stable taste across pacing, tone, POV, sentence rhythm, focus, imagery, interaction style, and explicit dislikes. Each tag is followed by a parenthetical description of what it means, USE THAT DESCRIPTION as your direction. These are BINDING constraints, not suggestions. Conform every turn's prose to them; prefer the user's preference over Foreground Guidance unless that would break in-scene logic. Tags users added without a description (free-form labels like `rococo`, `noir-modernist`) should be interpreted semantically by their natural meaning. If `User Preferences` is empty, behave as you would by default, no fallback to opposite poles.",
          "IMPORTANT: If User Preferences contains a `Prose reference` entry (paste of a passage, a book/author name, or a genre label), treat it as a BINDING aesthetic anchor for sentence rhythm, diction, and imagery density. Echo its texture without copying its content; never paste lines from it; never name its characters. Combine with the structural tags above, the reference sets HOW prose feels; tags set WHICH craft choices.",
          // Avoid adding a generic "surface Active Pressures" style rule here.
          // The section's data and urgency tags should do that work without
          // pushing every quiet beat toward explicit tension.
          "</observed_failure_modes>",
          "<output>",
          // The consumer of this output is the streaming renderer. By default it
          // accepts prose only. When the opt-in format-contract feature is on,
          // the renderer also handles `ovl:<kind>` fenced blocks — and the
          // available kinds + when to use them are described in Foreground
          // Guidance (authored by the slow loop), NOT hardcoded here. Comic mode
          // (experimental) replaces the prose contract wholesale: the turn IS a
          // panel script (lib/comicScript.js parses it; the runtime injects the
          // image paths and generates the panel bytes afterwards).
          !comicMode && isFormatContractEnabled() ? systemReservedFormatContract() : "",
          comicMode
            ? comicScriptOutputContract()
            : isFormatContractEnabled()
              ? (isCustomRichBlocksEnabled()
                  // Full rich rendering: contract blocks + reserved channels.
                  ? "Return narration as prose. Where it fits the scene you MAY emit the fenced `ovl:<kind>` blocks described in Foreground Guidance (only those kinds), using them sparingly for content they are meant for. The system-reserved `ovl:hud` / `ovl:include` / `ovl:bg` / `ovl:music` channels, when enabled, follow the contract above. Emit no other fenced blocks, JSON, XML tags, headings, bullet lists, or option menus. FENCE SHAPE IS STRICT: the opening line carries ONLY the fence language (```ovl:<kind>) and nothing after it; every key/value or directive line sits on its OWN line inside the body, and the closing ``` sits alone on its own line. The renderer parses only the body, so data placed on the opening line is lost."
                  // The reader displays custom blocks in the host's plain
                  // style: keep the reserved control channels, fold custom
                  // block content into the prose itself.
                  : `Return narration as prose. The reader is currently displaying custom story blocks in a plain style, so do NOT emit custom content-block fences even if old Foreground Guidance describes them; carry that content inside the prose instead. The reserved CONTROL fences stay fully active and follow the system contract above; enabled controls are: ${plainModeControlFenceList()}. Emit no other fenced blocks, JSON, XML tags, headings, bullet lists, or option menus. FENCE SHAPE IS STRICT: the opening line carries ONLY the fence language and nothing after it; every key/value or directive line sits on its OWN line inside the body, and the closing \`\`\` sits alone on its own line.`)
              : "Return the narration text only, no JSON, no XML tags, no Markdown fences, no headings, no bullet lists, no option menus.",
          "</output>",
        ].join("\n"),
      },
      {
        role: "user",
        // The fast-register echo rides the user message (comic mode has its
        // own pacing register, so it never gets the reminder).
        content: buildForegroundUserContext({ action, compiledContext, fastMode: fastMode && !comicMode, fastOverrunChars }),
      },
  ]
}

const OPTIONS_MEMORY_LABEL = {
  user: "User Preferences",
  observed: "Observed Notes",
  references: "Shared References",
}

function renderDurableMemoryForOptions(compiledContext) {
  const blocks = Array.isArray(compiledContext?.foregroundMemory) ? compiledContext.foregroundMemory : []
  const out = []
  for (const block of blocks) {
    const entries = (block?.entries || []).map((e) => String(e || "").trim()).filter(Boolean)
    if (!entries.length) continue
    out.push(`${OPTIONS_MEMORY_LABEL[block.target] || "Memory"}:`)
    for (const entry of entries) out.push(`- ${entry}`)
  }
  return out.join("\n")
}

// Build the options model's user message. Mirrors the narrator's composition
// and (already-truncated) budgets. Prior canon + this turn's beat are merged
// into a single narrative_so_far timeline that ENDS with the current beat, so
// the model treats this turn — not the previous one — as "now".
export function optionsContextBlocks({ action, narration, compiledContext, previousOptions = [] }) {
  const fg = String(compiledContext?.foregroundGuidance || "").trim()
  const inserts = String(compiledContext?.foregroundContextInserts || "").trim()
  const storyMem = String(compiledContext?.storyMemory || "").trim()
  const durable = renderDurableMemoryForOptions(compiledContext)
  // Director's options-only guidance (story/director/OPTIONS.md): reaches THIS
  // call only, never the narrator (it is never composed into FOREGROUND.md).
  const optionsGuide = String(compiledContext?.optionsGuidance || "").trim()
  // ONE narrative timeline = prior canon + this turn's beat, ending NOW.
  // Sharing the Recent Canon budget, tail-anchored: the current beat (at the
  // end) is always kept; the oldest prior canon is trimmed if over budget. The
  // block's END is the protagonist's current state, so the model can't mistake
  // a prior turn for "now".
  const priorCanon = String(compiledContext?.recentCanonExcerpt || "").trim()
  const currentBeat = `**读者选择**：${action}\n\n${String(narration || "").trim()}`
  let narrativeNow = priorCanon ? `${priorCanon}\n\n${currentBeat}` : currentBeat
  const budget = contextBudgetDefaults().recentCanonChars
  if (narrativeNow.length > budget) {
    narrativeNow = "…\n" + narrativeNow.slice(-budget).replace(/^[^\n]*\n/, "")
  }
  // What the reader was offered LAST turn: the one they CHOSE (now the latest beat
  // at the end of narrative_so_far) and the ones they REJECTED. Prose form —
  // deliberately NOT the JSON shape this call outputs — so the model reads it as
  // context, not as a template to echo.
  // Only emit when there are REJECTED options to avoid — the chosen action is
  // already the latest beat in narrative_so_far, so a "chose X" line alone is noise.
  const chosen = String(action || "").trim()
  const rejected = (previousOptions || []).map((o) => optionLabel(o).trim()).filter((o) => o && o !== chosen)
  const lastTurn = rejected.length
    ? [
        chosen ? `读者上一轮选择了：${chosen}` : "",
        `读者上一轮看到并拒绝了下面这些方向（不要再次提供它们，也不要换个说法重提同一个方向）：\n${rejected.map((o) => `- ${o}`).join("\n")}`,
      ].filter(Boolean).join("\n")
    : ""
  return [
    optionsGuide ? tagged("options_guidance", optionsGuide) : "",
    fg ? tagged("foreground_guidance", fg) : "",
    inserts ? tagged("context_inserts", inserts) : "",
    storyMem ? tagged("story_memory", storyMem) : "",
    durable ? tagged("durable_memory", durable) : "",
    tagged("narrative_so_far", narrativeNow),
    lastTurn ? tagged("last_turn_choices", lastTurn) : "",
  ].filter(Boolean).join("\n\n")
}

// The options generator's system prompt as a pure builder (exported for
// tests). fastMode (the per-story fast register) shifts the choice philosophy:
// the narrator deliberately ends every turn at a decision point there, so the
// options carry the gameplay weight.
export function optionsSystemPrompt({ fastMode = false } = {}) {
  return [
    "<role>",
    "You generate compact reader-facing choices for an interactive novel after narration has already been streamed.",
    "</role>",
    "<task>",
    "Do not continue the prose. Produce only options that naturally follow the narration and preserve reader agency.",
    "CRITICAL, where NOW is: narrative_so_far is the story's single continuous timeline and it ENDS with the turn that JUST happened, the reader's latest action (the last `**读者选择**` line) and the narration that resulted from it. The END of narrative_so_far is the protagonist's CURRENT state, generate options that continue from that exact ending. Everything earlier in narrative_so_far is the past; do NOT generate options for an earlier point, which would put the choices one beat behind. Never repeat the reader's latest action as an option.",
    "EVERY option is a FORWARD next action, the immediate next thing the protagonist could do AFTER the end of narrative_so_far. Options continue from that final moment; never re-do, rewind, or re-narrate anything earlier, and never offer the action the latest beat is already in the middle of.",
    "FIRST, read to the very END of narrative_so_far and pin down the protagonist's state at that exact final moment: location, posture, level of consciousness and freedom to act, and what just concluded. EVERY option must be physically and logically possible FROM THAT END-STATE.",
    "Hard continuity rule: if the end-state has removed a capability the protagonist would need (consciousness, mobility, presence in the scene, or freedom of action), you MUST NOT offer any option that requires that capability. Offer only choices the end-state actually permits. Never contradict the final state narrative_so_far just established.",
    "foreground_guidance / story_memory / durable_memory / context_inserts are durable state and facts the choices must stay consistent with, but they do not override the end of narrative_so_far, and any of them may lag a turn behind it.",
    "options_guidance (when present) is this story's choice PHILOSOPHY: which forks matter here, the cadence of genuine key decisions, the label voice, the stakes vocabulary, what counts as a fake choice. Apply it as direction for SHAPING the options you derive from the live end-state; it is NEVER a menu. If anything in it reads like a ready-made option or sample label, extract the principle it illustrates and move on; do NOT copy or lightly reword such text into an emitted option.",
    ...(fastMode
              ? [
                  "FAST REGISTER: this story plays in a fast pacing mode where the narration deliberately ends every turn at a decision point, so the choices you emit carry the gameplay weight. Prefer strategy-level decisions with real cost, commitment, and genuine divergence over micro-actions and flavor variations; the key-decision treatment below fits MORE turns than the default cadence here, apply it whenever the staged fork is genuine. Every other rule (count, brevity, spoiler, continuity) is unchanged.",
                ]
              : []),
    "Active Pressures, Open Threads, deadlines, and other mainline/background cues (in foreground_guidance and durable_memory) are BACKGROUND CONTEXT, they are NOT a checklist to advance every turn. The options must grow from the IMMEDIATE situation at the end of narrative_so_far, not from the global pressure list. Do NOT make all the choices push the same main objective; that railroads the reader and makes every turn's options feel identical.",
    "VARY the choices: the 2-4 options must differ in KIND and direction, not be reworded versions of the same next step. Span a genuine range of intents, e.g. act on the situation vs observe / gather more; engage a present character vs disengage or wait; take a bold/risky route vs a cautious or sideways one; pursue what the scene puts in front of the protagonist vs something the protagonist personally wants. At least one option should NOT merely advance the main plot. Every option must still continue plausibly from the current end-state.",
    "If last_turn_choices is present, it lists what the reader was offered LAST turn, the option they CHOSE (now the latest beat at the end of narrative_so_far) and the ones they REJECTED. Do NOT re-offer a rejected option, or a lightly-reworded near-duplicate of one: the reader already declined that direction, so repeating it wastes a choice. Especially in a slow or static scene (e.g. a long conversation), push past the same handful of physical actions and find genuinely different angles. This is purely an anti-repetition constraint, it never forces an option that doesn't fit the current end-state.",
    "Do not offer actions already completed anywhere in narrative_so_far.",
    "Do not introduce new named characters, factions, locations, devices, or facts absent from the supplied context. If an option needs a target, use something already on stage or a generic description.",
    "Honor the reader's User Preferences (in durable_memory) when shaping the choices: pacing, tone, how bold vs cautious, how much the reader likes open-ended agency vs being guided, and any stated dislikes. Preferences shape the FLAVOR and framing of the choices; they never override the continuity or variety rules above.",
    "BREVITY (hard rule): every label is SHORT, one terse line the reader scans at a glance, because the choice row truncates long text. State the action plainly; cut throat-clearing, any restatement of the current situation, and any explanation of WHY the choice is smart. When forced to choose, a crisp short action beats a fuller, more complete sentence.",
    "Options are UI affordances, not canon. Never mention these rules to the reader.",
    "If, and only if, the end of narrative_so_far unambiguously concludes the entire story (not just this scene): the protagonist's arc has resolved, the prose has reached an explicit ending, or the narration itself carries a closing signal that whatever convention this story uses, set storyComplete: true and return options: []. Use your judgment on what the story's own ending signal looks like, do not invent an ending from a mere scene break, cliff-hanger, or temporary lull.",
    "</task>",
    "<output>",
    'Return strict JSON only: { "framing"?: string, "options": Option[], "tension": string, "storyComplete"?: boolean }. Each Option is { "label": string, "key"?: true, "effect"?: object }.',
    "label: a short FORWARD action the reader sees, kept to ONE concise line (the action itself, optionally with a brief because-clause that conveys the reader's edge); NEVER a multi-sentence pitch, justification, or explanation, which overflow the choice row. SPOILER RULE: it MUST read as an action only and MUST NOT reveal, hint at, or color the outcome / success / failure / consequence. Two options whose labels look equally safe may carry very different hidden effects. Two to four options, GENUINELY different in direction, risk, information, or commitment, not paraphrases of the same next step. EMPTY array when storyComplete is true.",
    "MOST turns are NOT key decision points: emit plain options (label only, no key, no effect) and OMIT framing. The reader can always type their own action, so you are offering suggestions, not gating.",
    "KEY DECISION POINTS ONLY (a genuine fork or hard 困难节点, NOT every turn): set `framing` to one short line naming the decision before the protagonist and what is at stake (still NO outcome spoiler), and mark the 1-3 consequential options `key: true` with an `effect`. Leave low-stakes / flavor options without key or effect. If this turn is not a real fork, omit framing and emit no key/effect.",
    "effect (HIDDEN, never shown to the reader): { intent: what this choice commits to; consequence: the forward situation it sets in motion that the NEXT turn must honor; stateHints?: [{ key, op: \"set\"|\"inc\"|\"dec\"|\"flag\", value, note }] durable-state nudges; risk?: \"low\"|\"medium\"|\"high\"; difficulty?: a short 困难节点 seed; reversible?: boolean }.",
    "tension: a compact label for the current dramatic pressure (or \"story-complete\" when the story has ended).",
    "storyComplete: omit or false in normal turns. true ONLY when the whole story has ended; the UI will use this to stop offering choices.",
    "</output>",
  ].join("\n")
}

export async function generateForegroundOptions({ action, narration, compiledContext, snapshot }) {
  const previousOptions = Array.isArray(snapshot?.previousOptions) ? snapshot.previousOptions : []
  try {
    const content = await chatCompletion({
      role: "foreground",
      modelProfile: "foreground-options",
      // Options run on the large model (see the "foreground-options" profile)
      // but stay NON-thinking even if the user picked a thinking-capable large
      // model — force it off per-call, the same as the narrator does for prose.
      disableThinking: true,
      temperature: 0.55,
      // Keep a high ceiling for options JSON so longer localized labels do not
      // truncate. Provider capability still caps this to the model's real limit.
      maxTokens: 32000,
      // 120s wall. The options call isn't streamed, so this overall timeout is
      // the only guard, and a slow custom/reasoning foreground model can take
      // well over 25s for a JSON-mode response. The narration is already shown
      // and options fill in when ready (free-text stays available meanwhile), so
      // a longer wall just gives a slow model room to finish instead of failing
      // to empty options. A real failure is still surfaced to the Error Log.
      timeoutMs: 120000,
      json: true,
      stream: false,
      messages: [
        {
          role: "system",
          content: optionsSystemPrompt({ fastMode: snapshot?.fastMode === true }),
        },
        {
          role: "user",
          // Same composition + budgets as the narrator. The prior canon and
          // this turn's beat are merged into ONE narrative_so_far block that
          // ENDS with the current beat, so the model can't mistake an earlier
          // turn for "now" (the one-beat-behind bug).
          content: optionsContextBlocks({ action, narration, compiledContext, previousOptions }),
        },
      ],
    })
    const parsed = parseJsonObject(content, {})
    const storyComplete = parsed.storyComplete === true
    // BUG B: deterministic anti-repeat — drop any option matching the reader's
    // latest action or a recently-offered option, regardless of prompt compliance.
    // BUG A: when nothing survives, return [] (the UI falls back to free-text);
    // never synthesize a fake single "describe your next action" unchoice.
    const options = storyComplete
      ? []
      : filterOptions(Array.isArray(parsed.options) ? parsed.options : [], { latestAction: action, previousOptions })
    const framing = !storyComplete && options.length && typeof parsed.framing === "string" && parsed.framing.trim()
      ? parsed.framing.trim()
      : ""
    return {
      framing,
      options,
      tension: typeof parsed.tension === "string" && parsed.tension.trim()
        ? parsed.tension.trim()
        : (storyComplete ? "story-complete" : "unknown"),
      storyComplete,
    }
  } catch (err) {
    // BUG C: a real failure is "unavailable", distinct from "unknown" (model ran
    // but gave no label), so the Director's tension trajectory isn't polluted.
    // The error is carried out (not swallowed) so the runtime can route it to the
    // Error Log instead of the reader silently losing their choices.
    return { framing: "", options: [], tension: "unavailable", storyComplete: false, error: String(err?.message || err || "unknown error") }
  }
}

// Coerce a model-returned option (legacy string OR object) into the internal
// shape { label, key?, effect? }. Returns null for anything without a usable label.
function coerceOption(item) {
  if (typeof item === "string") {
    const label = item.trim()
    return label ? { label } : null
  }
  if (item && typeof item === "object" && typeof item.label === "string" && item.label.trim()) {
    const opt = { label: item.label.trim() }
    if (item.key === true) opt.key = true
    const effect = normalizeOptionEffect(item.effect)
    if (effect) opt.effect = effect
    return opt
  }
  return null
}

// Keep only the recognized effect fields; an effect with nothing meaningful is
// dropped (the option becomes a plain flavor option).
function normalizeOptionEffect(effect) {
  const e = effect && typeof effect === "object" ? effect : null
  if (!e) return null
  const out = {}
  if (typeof e.intent === "string" && e.intent.trim()) out.intent = e.intent.trim()
  if (typeof e.consequence === "string" && e.consequence.trim()) out.consequence = e.consequence.trim()
  if (Array.isArray(e.stateHints)) {
    const hints = e.stateHints.filter((h) => h && typeof h === "object").slice(0, 8)
    if (hints.length) out.stateHints = hints
  }
  if (["low", "medium", "high"].includes(e.risk)) out.risk = e.risk
  if (typeof e.difficulty === "string" && e.difficulty.trim()) out.difficulty = e.difficulty.trim()
  if (typeof e.reversible === "boolean") out.reversible = e.reversible
  return Object.keys(out).length ? out : null
}

// Coerce + dedup + anti-repeat filter + cap a raw option list.
function filterOptions(rawList, { latestAction = "", previousOptions = [] } = {}) {
  const banned = new Set()
  const latest = normalizeChoiceText(latestAction)
  if (latest) banned.add(latest)
  for (const prev of previousOptions) {
    const norm = normalizeChoiceText(optionLabel(prev))
    if (norm) banned.add(norm)
  }
  const seen = new Set()
  const out = []
  for (const item of rawList) {
    const opt = coerceOption(item)
    if (!opt) continue
    const norm = normalizeChoiceText(opt.label)
    if (!norm || banned.has(norm) || seen.has(norm)) continue
    seen.add(norm)
    out.push(opt)
    if (out.length >= 4) break
  }
  return out
}

export function finalizeForegroundTurn({
  action,
  snapshot,
  narration,
  optionResult = {},
  optionsEnabled = true,
  turnId = "",
} = {}) {
  const turn = normalizeTurn(
    { narration, options: optionResult.options, tension: optionResult.tension, framing: optionResult.framing },
    action,
    snapshot,
    { optionsEnabled, storyComplete: optionResult.storyComplete, turnId },
  )
  if (optionResult.storyComplete) turn.storyComplete = true
  return turn
}

function normalizeTurn(parsed, action, snapshot, { optionsEnabled = true, storyComplete = false, turnId = "" } = {}) {
  const narration =
    typeof parsed.narration === "string" && parsed.narration.trim()
      ? parsed.narration.trim()
      : fallbackTurn(action, snapshot, { optionsEnabled }).narration
  // Coerce options to objects (idempotent for already-coerced lists) and stamp a
  // per-turn id so a later selection can be bound to its hidden effect. No
  // synthesized fallback option: an empty list means "free-text only" (BUG A).
  const coerced = (storyComplete || !optionsEnabled)
    ? []
    : (Array.isArray(parsed.options) ? parsed.options : []).map(coerceOption).filter(Boolean).slice(0, 4)
  const options = coerced.map((opt, i) => ({ id: `opt_${turnId || "t"}_${i + 1}`, ...opt }))
  const framing = options.length && typeof parsed.framing === "string" && parsed.framing.trim()
    ? parsed.framing.trim()
    : ""
  return {
    narration,
    options,
    framing,
    tension: typeof parsed.tension === "string" ? parsed.tension : "unknown",
    source: hasModelKey() ? modelInfo().provider : "fallback",
  }
}

function fallbackTurn(action, snapshot, { optionsEnabled = true } = {}) {
  // Genre-neutral fallback used only when the live narrator call fails. No
  // synthesized options — let the reader type their next action (BUG A).
  return {
    narration: action
      ? "(暂时无法生成本回合的叙述。请稍后再试，或继续输入下一步行动。)"
      : "(故事尚未开始。请输入你的第一个行动。)",
    options: [],
    framing: "",
    tension: "awaiting-opening",
    source: "fallback",
  }
}

function tagged(name, value) {
  return [`<${name}>`, String(value ?? ""), `</${name}>`].join("\n")
}

function notifyNarrationComplete(callback, payload) {
  if (typeof callback !== "function") return
  try {
    callback(payload)
  } catch {
    // Auxiliary hooks must not break the reader-facing narration path.
  }
}
