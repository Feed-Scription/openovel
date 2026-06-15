import {
  arrayOfStrings,
  compactRecentList,
  compactText,
  enumOr,
  inboxDispositionIds,
  normalizeEnvelopeGuidanceMarkdown,
  normalizeFilesChanged,
  unclassifiedInboxWarnings,
  unique,
} from "./storykeeperEnvelopeHelpers.js"
import {
  hasLegacyStorykeeperPatchFields,
  normalizeLegacyStorykeeperPatch,
} from "./storykeeperLegacyEnvelope.js"
import { createNotices } from "../lib/notices.js"

export function normalizeStorykeeperEnvelope(parsed, ctx) {
  parsed = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  const transportPatch = normalizeTransportEnvelope(parsed, ctx)
  if (!hasLegacyStorykeeperPatchFields(parsed)) return transportPatch
  return normalizeLegacyStorykeeperPatch(parsed, ctx, transportPatch)
}

export const normalizePatch = normalizeStorykeeperEnvelope

function normalizeTransportEnvelope(parsed, ctx) {
  // Anything dropped/truncated during normalization is recorded here and merged
  // into `warnings` below, so the model (which reads PROVENANCE) and the trace
  // learn what didn't make it through — never a silent drop.
  const notices = createNotices("storykeeper-envelope")
  const filesChanged = normalizeFilesChanged(parsed.filesChanged)
  const foregroundGuidanceMarkdown = normalizeEnvelopeGuidanceMarkdown(parsed.foregroundGuidanceMarkdown, notices)
  // Compute the notice-generating compactions BEFORE building `warnings` so
  // their truncation notices are included in it.
  const inboxNotes = compactRecentList(arrayOfStrings(parsed.inboxNotes), { maxItems: 8, maxChars: 220 }, notices, "inboxNotes")
  const needsFollowup = compactRecentList(arrayOfStrings(parsed.needsFollowup), { maxItems: 8, maxChars: 240 }, notices, "needsFollowup")
  const patch = {
    transportOnly: true,
    turnId: ctx.turnId,
    status: enumOr(parsed.status, ["applied", "partial", "skipped"], filesChanged.length || foregroundGuidanceMarkdown ? "applied" : "skipped"),
    summary: compactText(parsed.summary, 600),
    foregroundGuidanceMarkdown,
    filesChanged,
    inboxResolved: Object.prototype.hasOwnProperty.call(parsed, "inboxResolved")
      ? arrayOfStrings(parsed.inboxResolved, [])
      : [],
    inboxDeferred: inboxDispositionIds(parsed.inboxDeferred),
    inboxRejected: inboxDispositionIds(parsed.inboxRejected),
    inboxNotes,
    needsFollowup,
    // warnings absorbs the envelope-normalization notices too.
    warnings: compactRecentList(
      [...arrayOfStrings(parsed.warnings), ...unclassifiedInboxWarnings(parsed, ctx), ...notices.messages()],
      { maxItems: 12, maxChars: 240 },
    ),
    sourceEvents: unique([ctx.turnId, ...arrayOfStrings(parsed.sourceEvents)]),
  }
  if (patch.foregroundGuidanceMarkdown && !patch.filesChanged.some((file) => file.path === "story/guidance/FOREGROUND.md")) {
    patch.filesChanged.unshift({
      path: "story/guidance/FOREGROUND.md",
      purpose: "foreground working-set update returned in transport envelope",
      provenance: [ctx.turnId, "foregroundGuidanceMarkdown"].filter(Boolean),
    })
  }
  return patch
}
