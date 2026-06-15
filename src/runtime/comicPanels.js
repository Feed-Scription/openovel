// Comic mode (experimental): the panel-image generation pipeline.
//
// A turn's panels are generated through ONE ComicPanelRun. The session
// processor feeds it EARLY — each panel starts generating the moment its
// fence closes in the narration stream (the model has written the full prompt
// by then), not when the whole turn completes — because the renderer reveals
// the strip sequentially (panel K+1 waits for panel K's image), so the first
// image's latency is the reader's wait. finish(script) runs at completion as
// the safety net: it validates every panel of the final (path-injected)
// script, queues any not seen during streaming, reports the rejected ones,
// and wraps the whole run in a backgroundJobs entry for the ledger.
//
// Division of trust mirrors the generate_image tool: paths are runtime-derived
// (comicPanelRelPath), but each target is still re-validated at write
// (comic prefix + include rules + byte sniff) so a drifted script can never
// write outside story/includes/comic/. A failed panel degrades to caption-only
// (comic.panel.failed + a notice); the story never blocks on an image.

import { existsSync } from "node:fs"
import { parsePanelScript, comicPanelRelPath, panelImagePathIssue, parseCharacterSheetIndex, matchCharacterSheets } from "../lib/comicScript.js"
import { acceptImageBytes, correctImagePath, IMAGE_SIZE_CAP } from "../lib/imageWrite.js"
import { writeBinary } from "../lib/files.js"
import { resolveWorkspacePath } from "../lib/workspacePaths.js"
import { reportNotices } from "../lib/notices.js"
import { withStoryTransaction } from "./storyTransaction.js"

// Generation concurrency per turn. Image providers rate-limit aggressively and
// a turn carries at most a handful of panels; two in flight is the sweet spot.
const PANEL_CONCURRENCY = 2

// Optional panel size override (e.g. "1K"): comic panels are reading-column
// width, so the provider default (often 2K+) wastes time and cost.
function panelSize(env = process.env) {
  return String(env.OPENOVEL_COMIC_PANEL_SIZE || "").trim() || undefined
}

export function createComicPanelRun({ turnId, bus, backgroundJobs, panelExt = "png" }) {
  const seen = new Set() // panel indexes queued (streaming + finish dedupe)
  const tasks = []
  // Reference selection is PER PANEL: the script's `characters:` field names
  // who is in frame, and only those characters' sheets ride that panel's
  // generation (a scenery panel carries none — passing every sheet to every
  // panel invited cameo leakage). Name→sheet mapping comes from
  // story/image/characters.md (parseCharacterSheetIndex); names that match no
  // sheet are collected and surfaced once at finish. Stories whose
  // characters.md predates the sheet-path convention degrade to the
  // all-sheets behavior so they keep their anchoring until the Image agent
  // catches the file up.
  let sheetContextPromise = null
  const sheetContext = () => {
    sheetContextPromise ??= loadSheetContext()
    return sheetContextPromise
  }
  const preparedByRel = new Map() // sheet rel → prepared ref | null (across panels)
  const unmatchedNames = new Set()

  async function panelReferences(panel) {
    const names = Array.isArray(panel.characters) ? panel.characters : []
    if (!names.length) return []
    const ctx = await sheetContext()
    if (!ctx.supported) return []
    let rels = []
    const indexHasSheets = ctx.entries.some((e) => e.sheet)
    if (indexHasSheets) {
      const { sheets, unmatched } = matchCharacterSheets(names, ctx.entries, { cap: ctx.cap })
      rels = sheets
      for (const name of unmatched) unmatchedNames.add(name)
    } else if (ctx.allSheets.length) {
      // Legacy fallback: characters are in frame but the spec file carries no
      // mappable paths yet — anchor with everything available rather than
      // nothing.
      rels = ctx.allSheets.slice(0, ctx.cap)
    }
    const refs = []
    for (const rel of rels) {
      if (!preparedByRel.has(rel)) preparedByRel.set(rel, await prepareSheet(rel))
      const prepared = preparedByRel.get(rel)
      if (prepared) refs.push(prepared)
    }
    return refs
  }
  // Tiny semaphore — panels queue as they close, at most N generate at once.
  let active = 0
  const waiters = []
  const acquire = () => {
    if (active < PANEL_CONCURRENCY) { active += 1; return Promise.resolve() }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }

  function spawn(panel) {
    const rel = comicPanelRelPath(turnId, panel.index, panelExt)
    // Pending up front: the renderer holds the "drawing" slate from the first
    // moment instead of racing the <img> against a not-yet-written file.
    bus?.publish?.("comic.panel.pending", { turnId, rel, index: panel.index })
    tasks.push((async () => {
      await acquire()
      try {
        const referenceImages = await panelReferences(panel)
        return await generateOnePanel({ turnId, panel: { ...panel, image: rel }, referenceImages, bus })
      } finally {
        release()
      }
    })())
  }

  return {
    // Streaming feed: queue a CLOSED panel the moment its fence completes.
    // Field-incomplete panels (no prompt yet… or ever) are left for finish()
    // to judge — a closed fence without a prompt is a defect to report, but
    // only the final script can say so authoritatively.
    addPanel(panel) {
      if (!panel || panel.open || seen.has(panel.index)) return
      if (!panel.prompt || !String(panel.prompt).trim()) return
      seen.add(panel.index)
      spawn(panel)
    },

    // Completion pass over the final, path-injected script: queue stragglers,
    // surface rejected panels, and account the whole run in the jobs ledger.
    finish(script) {
      const { panels } = parsePanelScript(script)
      const rejected = []
      for (const panel of panels) {
        const issue = panel.image ? panelImagePathIssue(panel.image) : panelImagePathIssue(comicPanelRelPath(turnId, panel.index, panelExt))
        if (issue || !panel.prompt) {
          if (!seen.has(panel.index)) {
            rejected.push({ panel, reason: issue || "panel has no prompt" })
            bus?.publish?.("comic.panel.failed", { turnId, rel: panel.image || "", index: panel.index, error: issue || "panel has no prompt" })
          }
          continue
        }
        this.addPanel(panel)
      }
      if (rejected.length) {
        reportNotices(
          [`comic turn ${turnId}: ${rejected.length} panel(s) skipped (${rejected.map((r) => r.reason).join("; ")})`],
          { event: "comic.panels", prefix: "comic" },
        )
      }
      if (!tasks.length) return null
      return backgroundJobs?.start?.({
        type: "comic-panels",
        title: `Comic panels: ${tasks.length} image(s)`,
        metadata: { turnId, panels: tasks.length },
        bus,
        run: async () => {
          const settled = await Promise.all(tasks)
          const failed = settled.filter((r) => !r.ok)
          if (failed.length) {
            reportNotices(
              failed.map((r) => `comic turn ${turnId}: panel ${r.index + 1} failed (${r.error}); it shows caption-only`),
              { event: "comic.panels", prefix: "comic" },
            )
          }
          // A name that anchors no sheet is invisible breakage (the panel just
          // renders less consistently), so say it once: either the script
          // misspelled the character or characters.md lacks its sheet path.
          if (unmatchedNames.size) {
            reportNotices(
              [`comic turn ${turnId}: no reference sheet matched for ${[...unmatchedNames].join(", ")} (check the name spelling in the script and the sheet path line in story/image/characters.md)`],
              { event: "comic.panels", prefix: "comic" },
            )
          }
          return { generated: settled.length - failed.length, failed: failed.length }
        },
      }) ?? null
    },
  }
}

async function generateOnePanel({ turnId, panel, referenceImages = [], bus }) {
  const rel = panel.image
  try {
    const targetAbs = resolveWorkspacePath(rel).path
    // Restart/replay of a recovered turn: the file already exists — done.
    if (existsSync(targetAbs)) {
      bus?.publish?.("comic.panel.ready", { turnId, rel, index: panel.index })
      return { ok: true, index: panel.index, rel }
    }
    const { generateImageBytes } = await import("../provider/imageGeneration.js")
    let bytes = await generateImageBytes({ prompt: panel.prompt, size: panelSize(), referenceImages })
    if (bytes && typeof bytes === "object" && !Buffer.isBuffer(bytes) && bytes.url) {
      bytes = await fetchImageUrl(bytes.url)
    }
    const accepted = acceptImageBytes(rel, bytes)
    if (!accepted.ok) throw new Error(accepted.reason)
    // Keep the script's .png path even when the provider returned another
    // format ONLY if the bytes match; otherwise save under the corrected
    // extension and report — the renderer resolves the script path, so a
    // corrected extension means this panel shows caption-only rather than a
    // broken image (rare; providers honor the requested format in practice).
    const corrected = correctImagePath(rel, accepted.kind)
    const finalAbs = resolveWorkspacePath(corrected).path
    await withStoryTransaction(
      { source: "runtime:comic-panels", turnId, files: [finalAbs] },
      async () => { await writeBinary(finalAbs, bytes) },
    )
    if (corrected !== rel) {
      bus?.publish?.("comic.panel.failed", { turnId, rel, index: panel.index, error: `provider returned ${accepted.kind}; saved as ${corrected}` })
      return { ok: false, index: panel.index, rel, error: `extension mismatch (${accepted.kind})` }
    }
    bus?.publish?.("comic.panel.ready", { turnId, rel, index: panel.index })
    return { ok: true, index: panel.index, rel }
  } catch (error) {
    const message = error?.message || String(error)
    bus?.publish?.("comic.panel.failed", { turnId, rel, index: panel.index, error: message })
    return { ok: false, index: panel.index, rel, error: message }
  }
}

// Build the run's sheet-selection context: whether the provider can take
// references at all, the name→sheet index parsed from story/image/characters.md,
// and the sheets present on disk (the legacy fallback when the index carries
// no paths yet). Failures here must never block panel generation: any error
// degrades to "no references".
async function loadSheetContext() {
  try {
    const { supportsReferenceImages, REFERENCE_IMAGE_CAP } = await import("../provider/imageGeneration.js")
    if (!supportsReferenceImages()) return { supported: false, entries: [], allSheets: [], cap: 0 }
    const { readdir, readFile } = await import("node:fs/promises")
    const dirAbs = resolveWorkspacePath("story/includes/characters").path
    const allSheets = (await readdir(dirAbs).catch(() => []))
      .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name))
      .sort()
      .map((name) => `story/includes/characters/${name}`)
    const specMarkdown = await readFile(resolveWorkspacePath("story/image/characters.md").path, "utf8").catch(() => "")
    // Only entries whose recorded sheet actually exists on disk can anchor.
    const entries = parseCharacterSheetIndex(specMarkdown).map((entry) => ({
      ...entry,
      sheet: entry.sheet && allSheets.includes(entry.sheet) ? entry.sheet : "",
    }))
    return { supported: true, entries, allSheets, cap: REFERENCE_IMAGE_CAP }
  } catch {
    return { supported: false, entries: [], allSheets: [], cap: 0 }
  }
}

// Read + sniff one sheet into the provider-ready shape ({ mediaType, base64 }),
// or null when unreadable/over budget.
async function prepareSheet(rel) {
  try {
    const { readFile } = await import("node:fs/promises")
    const { prepareImageForRead } = await import("../lib/imageRead.js")
    const buffer = await readFile(resolveWorkspacePath(rel).path).catch(() => null)
    const prepared = buffer ? prepareImageForRead(buffer) : null
    return prepared?.ok ? { mediaType: prepared.mediaType, base64: prepared.dataBase64 } : null
  } catch {
    return null
  }
}

async function fetchImageUrl(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30 * 1000)
  try {
    const response = await fetch(url, { headers: { Accept: "image/*" }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching generated image`)
    const declared = Number(response.headers.get("content-length") || 0)
    if (declared && declared > IMAGE_SIZE_CAP) throw new Error(`generated image too large (${declared} bytes)`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
