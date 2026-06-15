const DEFAULT_CANON_CHARS = 4000

export function buildForegroundUserContext({ action, compiledContext, fastMode = false, fastOverrunChars = 0 }) {
  return [
    "# Foreground Context",
    "",
    "Stable working-set sections come first for prompt-cache reuse. The latest reader action at the end is the immediate instruction for this turn.",
    "",
    // Frame foreground guidance as the protagonist's live working memory, not
    // external author notes. This makes pressures, open threads, and scene facts
    // act as present-tense constraints without forcing the narrator to list them.
    "The Foreground Guidance sections below ARE the protagonist's current cognitive state at this turn — not external scene description. Read each section as present-tense interiority:",
    "- Constants: durable invariants the protagonist HOLDS (canonical knowledge, possessions, commitments, irreversible decisions, fixed world rules). This is not a turn log. The protagonist already KNOWS these — they constrain what is consistent and shape what the protagonist would notice or assume, but they do NOT need to be re-stated, inventoried, or have their locations recited each turn. Surface a fact only when the current beat actually touches it; otherwise let it sit silently in the background.",
    "- Active Pressures (urgency-tagged): present-tense weights on the protagonist's attention. [URGENT] / [HIGH] items are actively shaping their inner state right now; [SHADOW] items are off-screen but still felt. The protagonist IS carrying these — they don't need to be enumerated for the reader, but they shape what the protagonist notices, hesitates over, or chooses to ignore.",
    "- Open Threads: unresolved decisions the protagonist KNOWS are pending. These are the protagonist's open questions, not the narrator's plot outline.",
    "- Active Characters: relationships the protagonist navigates, with current state and the rules of each interaction (who knows what name, what was promised, etc.).",
    "- Scene: the spatial / situational frame the protagonist is currently inside.",
    "- This Turn (present only on rare turns): the ONE section that is NOT mind-state — an external event the WORLD is bringing into the scene that the protagonist does not see coming. Find the natural opening to weave it into THIS turn alongside the reader's action: the world makes its move while the protagonist does theirs, and the protagonist's response (words, choices, feelings) stays the reader's. Weave it in — never force it over the reader's action, jam it in as a non-sequitur, or narrate the protagonist's decision for them. If the reader's action genuinely leaves no opening this turn, let it land at the next. Stage it once; if Recent Canon shows it already occurred, it is spent.",
    "- Tone / Forbidden: the prose register the protagonist's inner voice operates in.",
    "Narrate FROM inside this mind-state (except This Turn, which the world brings in from outside, woven with the reader's action). The protagonist's perception, tempo, and inner reference flow from these sections; the reader's action is what THEY are doing within that state.",
    markdownSection("Foreground Guidance", compiledContext.foregroundGuidance || ""),
    renderForegroundMemory(compiledContext.foregroundMemory),
    markdownSection("Story Memory", compiledContext.storyMemory || ""),
    markdownSection("Recent Canon Excerpt", compiledContext.recentCanonExcerpt || ""),
    // Turn Metadata (real-world `Current date`) temporarily disabled — to be
    // reconsidered and re-added later (may grow into real per-turn metadata:
    // turn number, in-world date, etc.). Re-enable by uncommenting:
    // markdownSection("Turn Metadata", `Current date: ${localISODate()}`),
    markdownSection("Reader Action", action),
    // Fast register echo, deliberately last: nearby numeric constraints are
    // easier for models to follow, and the measured-overrun line gives concrete
    // feedback without relying on truncation that could cut fences or sentences.
    fastMode ? markdownSection("Fast Register Reminder", fastRegisterReminder(fastOverrunChars)) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

// Model-facing fast-mode strings: keep em-dash-free (LLM tell the narrator
// imitates; see test/fastMode.test.js).
function fastRegisterReminder(overrunChars = 0) {
  const lines = [
    "Fast register, this turn: 300 to 500 characters of prose in the story's language, hard ceiling 600 (control fences excluded). Advance quickly, end at the reader's next decision point, then stop.",
  ]
  if (overrunChars > 0) {
    lines.push(
      `Measured feedback: your previous turn ran about ${overrunChars} characters of prose, over the ceiling. Come in shorter this turn; compress description and interiority first, keep the decision hook.`,
    )
  }
  return lines.join("\n")
}

export function buildStoryContextCapsule(snapshot, { canonChars = DEFAULT_CANON_CHARS } = {}) {
  return {
    runtimeContext: {
      currentDate: localISODate(),
      contextModel: "file-native context, native tool schemas, compact working sets",
    },
    importantPaths: {
      brief: "story/BRIEF.md",
      eventLog: "story/canon/scene_log.jsonl",
      canonText: "story/canon/chapters.md",
      provenance: "story/canon/PROVENANCE.md",
      contextReport: "story/packets/foreground_context.report.latest.json",
      storyMemory: "story/memory/MEMORY.md",
      storyMemoryTopics: "story/memory/topics/",
      userMemory: "home/memory/USER.md",
      userObservedMemory: "home/memory/OBSERVED.md",
      userMemoryTopics: "home/memory/topics/",
      sharedReferences: "home/references/INDEX.md or shared/",
      sharedReferenceTopics: "home/references/topics/",
      foregroundGuidance: "story/guidance/FOREGROUND.md",
      cardsManifest: "story/guidance/cards.md",
      backgroundInbox: "story/inbox/INBOX.md",
      backgroundInboxArchive: "story/inbox/MERGED.md",
      searchLog: "story/research/search-log.md",
      researchNotes: "story/research/ResearchNotes.md",
      toolOutput: "story/tool-output/",
    },
    foregroundGuidance: snapshot.foregroundGuidance || "",
    backgroundInbox: snapshot.backgroundInbox || "",
    backgroundInboxItems: (snapshot.backgroundInboxItems || []).map((item) => ({
      id: item.id,
      preview: String(item.block || "").split(/\r?\n/).slice(0, 8).join("\n"),
    })),
    recentCanonExcerpt: String(snapshot.chapters || "").slice(-canonChars),
  }
}

function localISODate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function tagged(name, value) {
  return [`<${name}>`, String(value ?? ""), `</${name}>`].join("\n")
}

export function taggedJson(name, value) {
  return tagged(name, JSON.stringify(value ?? null, null, 2))
}

function markdownSection(title, value) {
  const body = String(value ?? "").trim()
  if (!body) return ""
  const firstLine = body.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim().toLowerCase()
  if (firstLine === title.toLowerCase()) return body
  return [`## ${title}`, "", body].join("\n")
}

function renderForegroundMemory(blocks = []) {
  const sections = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const entries = Array.isArray(block.entries) ? block.entries.filter(Boolean) : []
    if (!entries.length) continue
    sections.push([`### ${memoryLabel(block.target)}`, "", ...entries.map((entry) => `- ${entry}`)].join("\n"))
  }
  return sections.length ? markdownSection("Durable Memory", sections.join("\n\n")) : ""
}

function memoryLabel(target) {
  return (
    {
      user: "User Preferences",
      observed: "Observed Notes",
      story: "Story Memory",
      references: "Shared References",
    }[target] || "Memory"
  )
}
