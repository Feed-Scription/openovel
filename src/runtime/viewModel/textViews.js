// Pure-text rendering of diagnostic / system commands. Used by the
// SessionViewModel to populate "system" entries that any UI surface can render
// verbatim. No ANSI codes here.

import { diagnoseProviders } from "../../provider/provider.js"
import { diagnoseSettings } from "../../config/settings.js"
import { workspaceLayout } from "../../lib/workspacePaths.js"
import { getMemorySnapshot } from "../../memory/memoryStore.js"
import { currentStoryDescriptor, listStories } from "../../lib/storyDirectory.js"

export function providerDoctorText() {
  const diagnosis = diagnoseProviders()
  return [
    `default: ${diagnosis.defaultProvider}`,
    `order: ${diagnosis.providerOrder.join(", ")}`,
    `paid fallback: ${diagnosis.allowPaidFallback ? "enabled" : "disabled"}`,
    "",
    "foreground route:",
    ...diagnosis.foreground.map(formatDoctorProvider),
    "",
    "background route:",
    ...diagnosis.background.map(formatDoctorProvider),
    "",
    "model profiles:",
    ...diagnosis.modelProfiles.map(formatDoctorProfile),
  ].join("\n")
}

export function configDoctorText() {
  const diagnosis = diagnoseSettings()
  return [
    "Config",
    "",
    "sources:",
    ...(diagnosis.sources.length
      ? diagnosis.sources.map((s) => `- ${s.kind} ${s.path || s.source}`)
      : ["- defaults only"]),
    "",
    "errors:",
    ...(diagnosis.errors.length
      ? diagnosis.errors.map((e) => `- ${e.path || e.source}: ${e.message}`)
      : ["- none"]),
    "",
    "workspace:",
    ...workspaceLines(),
    "",
    "effective:",
    JSON.stringify(diagnosis.settings, null, 2),
  ].join("\n")
}

export async function memoryText() {
  const snap = await getMemorySnapshot()
  const crossStoryEnabled = snap.crossStoryMemoryEnabled !== false
  return [
    "Memory",
    "",
    "story:",
    snap.story?.trim() || snap.memory?.trim() || "# Story Memory",
    "",
    "user (global):",
    snap.user?.trim() || "# User Memory",
    "",
    `cross-story memory: ${crossStoryEnabled ? "enabled" : "disabled"}`,
    "",
    "model-observed notes:",
    crossStoryEnabled ? (snap.observed?.trim() || "# Observed Memory") : "(disabled; not injected into model context)",
    "",
    "shared references:",
    crossStoryEnabled ? (snap.references?.trim() || "# Shared References") : "(disabled; not injected into model context)",
  ].join("\n")
}

export async function storiesText() {
  const stories = await listStories()
  const current = currentStoryDescriptor()
  const lines = [
    `active: ${current.id}${current.isProjectLocal ? " (project-local ./story)" : ""}`,
    `        root: ${current.root}`,
    "",
    `${stories.length} story location(s):`,
  ]
  for (const s of stories) {
    const marker = s.active ? "* " : "  "
    const tag = s.isProjectLocal ? " [project]" : ""
    const size = s.chapterBytes ? `${(s.chapterBytes / 1024).toFixed(1)}K canon` : "(empty)"
    const touched = s.lastTouched ? s.lastTouched.replace("T", " ").slice(0, 16) : ""
    lines.push(`${marker}${s.id}${tag}  ${size}  ${touched}`)
  }
  return lines.join("\n")
}

function workspaceLines() {
  const ws = workspaceLayout()
  return [
    `- home: ${ws.home}`,
    `- storyRoot: ${ws.storyRoot}`,
    `- userMemory: ${ws.userMemory}`,
    `- sharedReferences: ${ws.sharedReferences}`,
  ]
}

function formatDoctorProvider(p) {
  const key = p.keyConfigured ? "key=yes" : `key=missing(${p.keyEnv || "-"})`
  return `- ${p.id} ${p.billingMode} model=${p.model || "-"} ${key} base=${p.baseUrl || "-"}`
}

function formatDoctorProfile(p) {
  return `- ${p.id} role=${p.role} model=${p.model || "-"} provider=${p.provider?.id || "-"} tier=${p.costTier} source=${p.modelSource}`
}
