import {
  arrayOfStrings,
  compactPatch,
  compactText,
  DEFAULT_SCENE,
  dropStaleFacts,
  emptyIfDefaultScene,
  firstMarkdownValue,
  inboxDispositionIds,
  markdownList,
  objectOr,
  stringOr,
  unclassifiedInboxWarnings,
  unique,
} from "./storykeeperEnvelopeHelpers.js"

const LEGACY_PATCH_KEYS = [
  "currentScene",
  "tone",
  "newFacts",
  "characters",
  "locations",
  "objects",
  "openThreads",
  "forbidden",
  "activeCharacters",
  "characterBriefs",
  "groundingNotes",
  "counterfactualWarnings",
  "continuityWarnings",
  "narrativePatch",
  "replaceWorld",
]

export function hasLegacyStorykeeperPatchFields(parsed = {}) {
  return LEGACY_PATCH_KEYS.some((key) => key in parsed)
}

export function normalizeLegacyStorykeeperPatch(parsed, ctx, transportPatch) {
  const guidance = String(ctx.snapshot?.foregroundGuidance || "")
  const replaceWorld = parsed.replaceWorld === true
  const legacyStatus = transportPatch.status === "skipped" && hasLegacyStorykeeperPatchFields(parsed)
    ? "applied"
    : transportPatch.status
  const patch = {
    ...transportPatch,
    transportOnly: false,
    legacyPatchConverted: true,
    status: legacyStatus,
    turnId: ctx.turnId,
    replaceWorld,
    foregroundGuidanceMarkdown: stringOr(parsed.foregroundGuidanceMarkdown, ""),
    currentScene: emptyIfDefaultScene(stringOr(parsed.currentScene, replaceWorld ? "" : firstMarkdownValue(guidance, "Scene"))),
    tone: stringOr(parsed.tone, replaceWorld ? "" : firstMarkdownValue(guidance, "Tone")),
    newFacts: arrayOfStrings(parsed.newFacts, replaceWorld ? [] : constantsList(guidance)),
    characters: objectOr(parsed.characters, {}),
    locations: objectOr(parsed.locations, {}),
    objects: objectOr(parsed.objects, {}),
    openThreads: arrayOfStrings(parsed.openThreads, replaceWorld ? [] : markdownList(guidance, "Open Threads")),
    forbidden: arrayOfStrings(parsed.forbidden, replaceWorld ? [] : markdownList(guidance, "Forbidden / Avoid")),
    activeCharacters: arrayOfStrings(parsed.activeCharacters, replaceWorld ? [] : markdownList(guidance, "Active Characters")),
    characterBriefs: objectOr(parsed.characterBriefs, {}),
    groundingNotes: arrayOfStrings(parsed.groundingNotes, replaceWorld ? [] : markdownList(guidance, "Grounding Notes")),
    counterfactualWarnings: arrayOfStrings(
      parsed.counterfactualWarnings,
      replaceWorld ? [] : markdownList(guidance, "Counterfactual Warnings"),
    ),
    continuityWarnings: arrayOfStrings(parsed.continuityWarnings),
    narrativePatch: stringOr(parsed.narrativePatch, ""),
    inboxResolved: Object.prototype.hasOwnProperty.call(parsed, "inboxResolved")
      ? arrayOfStrings(parsed.inboxResolved, [])
      : [],
    inboxDeferred: inboxDispositionIds(parsed.inboxDeferred),
    inboxRejected: inboxDispositionIds(parsed.inboxRejected),
    inboxNotes: arrayOfStrings(parsed.inboxNotes),
    warnings: unique([...(transportPatch.warnings || []), ...unclassifiedInboxWarnings(parsed, ctx)]),
  }
  const repaired = compactPatch(repairForegroundContinuity(patch, ctx))
  const foregroundGuidanceMarkdown = shouldUseForegroundGuidanceMarkdown(repaired.foregroundGuidanceMarkdown, repaired, ctx)
    ? repaired.foregroundGuidanceMarkdown
    : ""
  return {
    ...repaired,
    foregroundGuidanceMarkdown,
  }
}

function constantsList(guidance) {
  const constants = markdownList(guidance, "Constants")
  return constants.length ? constants : markdownList(guidance, "Must Keep")
}

function repairForegroundContinuity(patch, ctx) {
  const existingFacts = dropStaleFacts(patch.newFacts)
  const turnFacts = existingFacts.length ? [] : inferForegroundFacts(ctx)
  const openThreads = patch.openThreads.length ? [] : inferOpenThreads(ctx)
  return {
    ...patch,
    currentScene: patch.currentScene || inferCurrentScene(ctx),
    newFacts: unique([...existingFacts, ...turnFacts]),
    openThreads: unique([...patch.openThreads, ...openThreads]),
  }
}

function shouldUseForegroundGuidanceMarkdown(markdown, patch, ctx) {
  const text = String(markdown || "")
  if (!text.trim()) return false
  // Escape hatch only: reserved for genuine narrative pivots. The current
  // Storykeeper contract is transport-envelope-first; freeform Markdown should
  // not become a covert compaction path for a growing foreground working set.
  if (!patch.replaceWorld) return false
  if (text.length > 2000) return false
  if (text.includes(DEFAULT_SCENE) && String(ctx.foreground?.narration || "").trim()) return false
  const scene = emptyIfDefaultScene(patch.currentScene)
  if (!scene) return true
  if (text.includes(DEFAULT_SCENE) && !text.includes(scene)) return false
  return true
}

function inferForegroundFacts(_ctx) {
  return []
}

function inferCurrentScene(_ctx) {
  return ""
}

function inferOpenThreads(ctx) {
  const tension = String(ctx.foreground?.tension || "").trim()
  return tension && tension !== "unknown" ? [`Unresolved pressure: ${compactText(tension, 180)}`] : []
}
