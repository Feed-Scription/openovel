import { parseJsonObject } from "../lib/json.js"
import { applyMemoryPatch, getMemorySnapshot } from "../memory/memoryStore.js"
import { backgroundAgentContract, renderContextSections } from "../prompts/agentContracts.js"

export function createOnboardingPreferenceAgent() {
  return {
    id: "onboarding-preference-research",
    kind: "preference-research-agent",
    modelProfile: "subagent-research",
    json: true,
    maxSteps: 4,
    maxTokens: 1200,
    temperature: 0.2,
    toolConcurrency: 3,
    includeDangerous: false,

    async prepare({ input }) {
      const memory = await getMemorySnapshot()
      return {
        memory,
        messages: [
          {
            role: "system",
            content: onboardingPreferenceSystemPrompt(),
          },
          {
            role: "user",
            content: renderContextSections("Onboarding Preference Context", [
              {
                title: "Trigger",
                value: {
                  turnId: input.turnId,
                  trigger: input.trigger,
                  locale: input.locale,
                  answers: compactAnswers(input.answers),
                },
              },
              {
                title: "Existing Memory",
                value: {
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
      return JSON.stringify({ user: [], references: [], notes: ["No research model configured; skipped."] })
    },

    async normalize({ input, raw }) {
      const parsed = parseJsonObject(raw.content, {})
      return {
        turnId: input.turnId,
        trigger: input.trigger,
        user: arrayOfStrings(parsed.user),
        references: arrayOfStrings(parsed.references),
        notes: arrayOfStrings(parsed.notes),
      }
    },

    async apply({ normalized }) {
      const applied = await applyMemoryPatch({
        user: normalized.user,
        references: normalized.references,
      })
      return { ...normalized, applied }
    },

    traceInput(input) {
      return {
        turnId: input.turnId,
        trigger: input.trigger,
        answers: (input.answers || []).map((answer) => answer.id),
      }
    },

    traceOutput(patch) {
      return {
        userMemoryAdded: patch.user.length,
        referencesAdded: patch.references.length,
        notes: patch.notes,
      }
    },
  }
}

export function createOnboardingPreferenceWorkflow() {
  return createOnboardingPreferenceAgent()
}

export function onboardingPreferenceSystemPrompt() {
  return [
    "<role>",
    "You are the onboarding preference research agent pack for openovel.",
    "</role>",
    "",
    backgroundAgentContract({ allowSubagents: false, allowWrites: false }),
    "",
    "<mission>",
    "Run in the background while the user is still configuring the app.",
    "Infer durable reader and collaborator preferences from the answers so the foreground narrator can improve without slowing first-run setup.",
    "Never ask the user questions and never block the foreground path.",
    "</mission>",
    "",
    "<research_policy>",
    "Use websearch for discovery when an answer mentions an author, book, movement, genre label, web-novel subculture, historical period, technical domain, or recurring craft complaint that external evidence can clarify.",
    "Use webfetch for retrieval only after websearch identifies pages that look sourceful enough to justify a durable note. webfetch REQUIRES a `prompt` parameter, one sentence stating what to pull from the page, framed around the preference signal you're trying to ground. The raw page is never returned; the prompt drives a small extractor model that returns a focused synthesis.",
    "Do not search for private facts, secrets, API keys, or purely local story state.",
    "If the answers are too vague for research, summarize only the stable preference signal and return empty references.",
    "</research_policy>",
    "",
    "<memory_policy>",
    "Write compact user memory for stable preferences: language, pacing, prose texture, interaction style, tolerance for explanation, agency boundaries, and repeated anti-patterns.",
    "Write shared references for reusable source-backed craft or factual notes, including source names or URLs when web tools were used.",
    "Avoid duplicating existing memory. Prefer incremental, auditable notes.",
    "Do not store raw copyrighted passages, long quotes, or an imitation recipe for any living author.",
    "Do not invent a rigid style lens. Keep notes general enough for future user correction and better implementations.",
    "</memory_policy>",
    "",
    "<output>",
    'Return strict JSON only: { "user"?: string[], "references"?: string[], "notes"?: string[] }.',
    "If nothing new is durable, return empty arrays.",
    "</output>",
  ].join("\n")
}

function compactAnswers(answers = []) {
  return answers.map((answer) => ({
    id: answer.id,
    answer: compact(answer.answer),
    context: compact(answer.context, 520),
  }))
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []
}

function compact(value, maxChars = 420) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}
