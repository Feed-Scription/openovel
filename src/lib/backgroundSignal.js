import { chatCompletion, hasModelKey, modelInfo } from "../provider/provider.js"
import { resolveModelProfile } from "../provider/modelProfiles.js"
import { parseJsonObject } from "./json.js"
import { signalRouterContract } from "../prompts/agentContracts.js"

export async function planBackgroundSignal({ action, snapshot }) {
  const profile = resolveModelProfile("signal")
  if (!hasModelKey({
    role: profile.role,
    modelProfile: profile.id,
    providerId: profile.providerPinned ? profile.provider?.id : "",
  })) return fallbackSignal(action)

  const content = await chatCompletion({
    role: profile.role,
    model: profile.model,
    modelProfile: profile.id,
    temperature: 0.2,
    // was 360 — too tight if reader names multiple anchors / style
    // refs in one turn (causing styleSignal field to truncate). 32000 ceiling
    // (capped by provider capability); model only emits what it needs.
    maxTokens: 32000,
    // 20s wall (was 9s). Signal extraction is a small JSON
    // classification call that normally completes in 3-6s but can stall
    // under provider load. Failure falls through to fallbackSignal, so a
    // longer wall has no UX penalty. Aligned with narrator's parallel sibling
    // (foregroundInserts) to avoid uneven abort rates within one turn.
    timeoutMs: 20000,
    json: true,
    messages: [
      {
        role: "system",
        content: [
          "<role>",
          "You are the foreground loop's Background Signal Router.",
          "</role>",
          signalRouterContract(),
          "<task>",
          "When a reader action arrives, quickly decide whether the slow background agent should receive follow-up work.",
          "Do not continue the story. Emit only a compact task signal for the background loop.",
          "</task>",
          "<what_to_capture>",
          "Prioritize explicit reader-supplied anchors: people, places, era, tactics, objects, genre promises, preferences, constraints, and facts that must not be forgotten.",
          "If the reader says the prose style feels wrong, asks for plain writing, asks for ornate/flamboyant writing, names an author/work/movement/platform genre as a target, or corrects the desired reading texture, ALSO populate the styleSignal field below in addition to creating a craft/style research task. Do not try to solve style in the foreground hot path.",
          "Style tasks should ask for compact operational guidance or a Markdown context card, not a hard-coded imitation template.",
          "Create generic, file-friendly tasks. Do not hard-code a storage schema; the background agent may choose better files or conventions.",
          "If the reader appears to pivot to a new protagonist, setting, timeline, or genre, flag it as a continuity/pivot task rather than treating it as an error.",
          "</what_to_capture>",
          "<style_signal>",
          "If the reader's text expresses a prose-style intent — an explicit request, a complaint about the current prose texture, or a named reference (any author / work / movement / platform genre / fandom shorthand) — extract a styleSignal object.",
          "requested: a short operational descriptor that captures the texture asked for. Free-form, lowercase, hyphenated if needed. Use whatever phrasing best fits the reader's intent — do not pick from a fixed enum. Leave empty if the reader did not imply a texture.",
          "namedReference: the exact name the reader used, verbatim. Empty if the reader did not name anything.",
          "complaint: a one-sentence summary of what the reader said is wrong with the current prose, if anything. Empty if the reader is making a forward request, not a complaint.",
          "Emit styleSignal even if it duplicates a craft task; the slow loop uses both surfaces.",
          "</style_signal>",
          "<output>",
          'Return strict JSON only: { "needsBackground": boolean, "priority": "now"|"soon"|"later", "tasks": Array<{ "type": string, "instruction": string, "anchors"?: string[] }>, "preserve"?: string[], "notes"?: string[], "styleSignal"?: { "requested"?: string, "namedReference"?: string, "complaint"?: string } }.',
          "</output>",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            readerAction: action,
            foregroundGuidance: snapshot.foregroundGuidance,
            recentCanonExcerpt: String(snapshot.chapters || "").slice(-1600),
          },
          null,
          2,
        ),
      },
    ],
  })

  return normalizeSignal(parseJsonObject(content, {}), action, profile)
}

export function normalizeSignal(parsed, action = "", profile = null) {
  const tasks = Array.isArray(parsed.tasks)
    ? parsed.tasks
        .map((task) => ({
          type: stringOr(task?.type, "continuity"),
          instruction: stringOr(task?.instruction, ""),
          anchors: arrayOfStrings(task?.anchors),
        }))
        .filter((task) => task.instruction)
        .slice(0, 6)
    : []

  const preserve = arrayOfStrings(parsed.preserve)
  if (!tasks.length && preserve.length) {
    tasks.push({
      type: "continuity",
      instruction: "Fold the explicit preserve anchors into foreground guidance or durable story files.",
      anchors: preserve,
    })
  }

  return {
    needsBackground: parsed.needsBackground !== false && (tasks.length > 0 || preserve.length > 0),
    priority: ["now", "soon", "later"].includes(parsed.priority) ? parsed.priority : "soon",
    tasks,
    preserve,
    notes: arrayOfStrings(parsed.notes),
    styleSignal: normalizeStyleSignal(parsed.styleSignal),
    source: profile?.provider?.id || (hasModelKey() ? modelInfo().provider : "fallback"),
    modelProfile: profile?.id || "signal",
  }
}

function normalizeStyleSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const requested = stringOr(value.requested, "")
  const namedReference = stringOr(value.namedReference, "")
  const complaint = stringOr(value.complaint, "")
  if (!requested && !namedReference && !complaint) return null
  return {
    requested: requested.slice(0, 60),
    namedReference: namedReference.slice(0, 120),
    complaint: complaint.slice(0, 280),
  }
}

function fallbackSignal(action) {
  return normalizeSignal(
    {
      needsBackground: true,
      priority: "soon",
      tasks: [
        {
          type: "continuity",
          instruction:
            "Record the latest reader action and decide whether to update foreground guidance, character notes, open threads, or research notes.",
          anchors: extractAnchors(action),
        },
      ],
      preserve: extractAnchors(action),
    },
    action,
  )
}

function extractAnchors(text) {
  return String(text || "")
    .split(/[，。；、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 8)
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : []
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}
