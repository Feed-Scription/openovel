import { getStorySnapshot, recordSceneEvent } from "../lib/storyStore.js"
import { parseJsonObject } from "../lib/json.js"
import { applyMemoryPatch, getMemorySnapshot } from "../memory/memoryStore.js"
import { canonicalForegroundOutput } from "./storykeeperContext.js"
import { backgroundAgentContract, renderContextSections } from "../prompts/agentContracts.js"

export function createMemoryReviewAgent() {
  return {
    id: "memory-review",
    kind: "memory-review-agent",
    modelProfile: "memory",
    json: true,
    maxSteps: 2,
    maxTokens: 1200,
    temperature: 0.2,
    toolConcurrency: 2,
    includeDangerous: false,

    async prepare({ input }) {
      const [snapshot, memory] = await Promise.all([getStorySnapshot(), getMemorySnapshot()])
      return {
        snapshot,
        memory,
        messages: [
          {
            role: "system",
            content: memoryReviewSystemPrompt(),
          },
          {
            role: "user",
            content: renderContextSections("Memory Review Context", [
              {
                title: "Turn",
                value: {
                  turnId: input.turnId,
                  readerAction: input.action,
                  foregroundOutput: canonicalForegroundOutput(input.foreground),
                  foregroundBackgroundSignal: input.backgroundSignal,
                  foregroundGuidance: snapshot.foregroundGuidance,
                },
              },
              {
                title: "Existing Memory",
                value: {
                  story: memory.story || memory.memory,
                  user: memory.user,
                  references: memory.references,
                  paths: memory.paths,
                },
              },
            ]),
          },
        ],
      }
    },

    async fallback() {
      return JSON.stringify({ memory: [], user: [], references: [], notes: ["No model configured; skipped."] })
    },

    async normalize({ input, context, raw }) {
      const parsed = parseJsonObject(raw.content, {})
      // Back-compat: older prompts emitted `user` for model-written notes.
      // The schema now uses `observed`. If a model still emits `user`, route
      // it to `observed` rather than the user-owned USER.md.
      const observedFromUser = arrayOfStrings(parsed.user)
      const observed = arrayOfStrings(parsed.observed).slice(0, 1)
      const merged = observed.length ? observed : observedFromUser.slice(0, 1)
      return {
        turnId: input.turnId,
        // Story memory is now actively maintained — allow up to 2 durable
        // developments per turn. observed/references stay at 1 (rare).
        memory: arrayOfStrings(parsed.memory).slice(0, 2),
        observed: merged,
        references: arrayOfStrings(parsed.references).slice(0, 1),
        notes: arrayOfStrings(parsed.notes),
      }
    },

    async apply({ normalized }) {
      const applied = await applyMemoryPatch({
        memory: normalized.memory,
        observed: normalized.observed,
        references: normalized.references,
      })
      await recordSceneEvent({
        type: "memory_review_completed",
        turnId: normalized.turnId,
        workflow: "memory-review",
        memoryAdded: normalized.memory.length,
        observedMemoryAdded: normalized.observed.length,
        referencesAdded: normalized.references.length,
        notes: normalized.notes,
      })
      return { ...normalized, applied }
    },

    async onEvent(type, payload) {
      await recordSceneEvent({
        type,
        workflow: "memory-review",
        ...payload,
      })
    },

    traceInput(input) {
      return {
        turnId: input.turnId,
        action: input.action,
      }
    },

    traceOutput(patch) {
      return {
        memoryAdded: patch.memory.length,
        observedMemoryAdded: patch.observed.length,
        referencesAdded: patch.references.length,
        notes: patch.notes,
      }
    },
  }
}

export function createMemoryReviewWorkflow() {
  return createMemoryReviewAgent()
}

export function memoryReviewSystemPrompt() {
  return [
    "<role>",
    "You are the background self-improvement memory agent pack for openovel.",
    "</role>",
    "",
    backgroundAgentContract({ allowSubagents: false, allowWrites: false }),
    "",
    "<mission>",
    "You keep the story's durable long-term memory current, and separately capture the rare cross-session lesson.",
    "story/memory/MEMORY.md is the SINGLE SOURCE OF TRUTH for this story's durable memory and the narrator's PRIMARY way to recall facts once events scroll out of its short recent-canon window. So keep it current: EACH TURN, record the durable developments this turn produced. This is NOT a save-almost-nothing log for the story target, a turn that advances the plot almost always has at least one durable fact worth recording.",
    "Only the observed and references targets are conservative: save to them rarely, and only when the note is useful across sessions or across stories.",
    "Keep every entry compact, concrete, and auditable.",
    "</mission>",
    "",
    "<memory_targets>",
    "memory (story, ACTIVELY MAINTAINED, the narrator's long-term recall): record THIS turn's durable developments, new canonical facts, state/condition changes, commitments/debts/promises made or settled, relationship shifts, decisions and their consequences, objects or knowledge gained or lost, dates/deadlines, irreversible events. These are exactly the facts a later turn will need after they're no longer in recent canon. On a plot-advancing turn, record at least one. Skip only purely transient beats that change nothing durable. Before adding, scan Existing Memory: if the fact is already there, do NOT restate it; if it has CHANGED, add the updated fact.",
    "observed (global, save rarely): notes about the reader and how they interact, taste signals, repeated corrections worth carrying across stories. USER.md (user-set preferences) is read-only for you; record observations in OBSERVED.md. Most turns: empty.",
    "references (global, save rarely): reusable cross-story source pointers, historical facts, geography, institutions, era timelines, genre craft references. Most turns: empty.",
    "</memory_targets>",
    "",
    "<user_preferences_are_read_only>",
    "home/memory/USER.md is the user's own preferences file. Do not propose entries that overwrite or contradict it, if the user wants a preference changed, they edit USER.md themselves through the Settings UI or onboarding. Your role is to OBSERVE, in OBSERVED.md.",
    "</user_preferences_are_read_only>",
    "",
    "<do_not_save>",
    "- Pure transient beats with no lasting consequence: passing mood, filler dialogue, a description that changes no state. (But the DURABLE consequence of a scene, what changed and persists, DOES belong in story memory.)",
    "- A fact already present in Existing Memory, dedupe; never restate what's already recorded.",
    "- The verbatim play-by-play of the current scene. Record the durable outcome (who now has/owes/knows/decided what), not a copy of the latest narration or the reader's choice.",
    "- Facts that will quickly expire, unless you include the date and why the fact remains useful.",
    "- Negative conclusions caused only by a temporary tool or environment failure.",
    "- Secrets, API keys, or raw credentials.",
    "</do_not_save>",
    "",
    "<context_cards_and_guidance>",
    "If the lesson is a reusable foreground detail or procedure, prefer a small Markdown context card under story/context-cards/ or shared context-cards instead of putting a long procedure in memory.",
    "Do not reference full canon or large logs as foreground guidance. The foreground fast path should stay compact.",
    "</context_cards_and_guidance>",
    "",
    "<file_native_indexing>",
    "Memory index files are compact entrypoints, not full notebooks: story/memory/MEMORY.md, home/memory/OBSERVED.md, and home/references/INDEX.md stay as short indexes. (home/memory/USER.md is read-only for you, see <user_preferences_are_read_only>.)",
    "Each entry you add is automatically given a backing topics/*.md file by the runtime, so keep the index line itself to one short, self-contained fact.",
    "Entries are kept in order and the runtime retains the most recent ones, so do not restate facts already in Existing Memory.",
    "</file_native_indexing>",
    "",
    "<output>",
    'Return strict JSON only: { "memory"?: string[], "observed"?: string[], "references"?: string[], "notes"?: string[] }.',
    "memory: record THIS turn's durable developments, up to 2 entries, each one concrete self-contained fact (≤ ~200 chars). A plot-advancing turn should produce at least one; only a purely transient turn yields none.",
    "observed / references: at most one entry each, and usually empty (cross-session / cross-story only).",
    "If the turn truly produced no durable development and no cross-session lesson, return empty arrays.",
    "</output>",
  ].join("\n")
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []
}
