import { build, stop } from "esbuild"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const src = path.join(root, "src/electron/renderer")
const out = path.join(root, "dist-pages")
const appOut = path.join(out, "app")
const starterDir = path.join(root, "resources/starter-stories")

await rm(out, { recursive: true, force: true })
await mkdir(appOut, { recursive: true })

const t0 = Date.now()

await cp(path.join(root, "site"), out, { recursive: true })
await cp(path.join(root, "assets"), path.join(out, "assets"), { recursive: true })
await writeFile(path.join(out, ".nojekyll"), "")

// ── Demo stories ─────────────────────────────────────────────────────────────
// The browser demo runs the real foreground narrator over the two pre-initialized
// starter stories, BYOK. We don't ship the whole snapshot (the full canon, agent
// threads, etc. — megabytes the narrator never reads); we emit a TRIMMED per-story
// bundle with just what a foreground turn needs, plus the includes media so the
// scene backdrop / inline images resolve over HTTP (no Electron ovl-asset://).
await buildDemoStories(appOut)

// ── Web client bundle ────────────────────────────────────────────────────────
const toWebPath = (file) => `./${path.relative(appOut, file).split(path.sep).join("/")}`
const entryOutput = (metafile, entryPoint, extension) => {
  const wanted = path.resolve(entryPoint)
  const output = Object.entries(metafile.outputs).find(([, meta]) => (
    meta.entryPoint
    && path.resolve(root, meta.entryPoint) === wanted
    && meta.bytes > 0
  ))
  if (!output) throw new Error(`Could not find ${extension} output for ${entryPoint}`)
  return toWebPath(path.join(root, output[0]))
}

const jsBuild = await build({
  entryPoints: [path.join(src, "main.web.jsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: appOut,
  entryNames: "[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  jsx: "automatic",
  loader: { ".js": "jsx", ".jsx": "jsx", ".png": "dataurl", ".txt": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  sourcemap: false,
  logLevel: "warning",
})

const cssBuild = await build({
  entryPoints: [path.join(src, "styles/theme.css")],
  bundle: true,
  outdir: appOut,
  entryNames: "[name]-[hash]",
  loader: { ".css": "css" },
  metafile: true,
  logLevel: "warning",
})

const jsAsset = entryOutput(jsBuild.metafile, path.join(src, "main.web.jsx"), ".js")
const cssAsset = entryOutput(cssBuild.metafile, path.join(src, "styles/theme.css"), ".css")
const appHtml = (await readFile(path.join(src, "index.web.html"), "utf8"))
  .replace("./bundle.css", cssAsset)
  .replace("./bundle.js", jsAsset)

await writeFile(path.join(appOut, "index.html"), appHtml)

console.log(`pages site built in ${Date.now() - t0}ms -> ${path.relative(root, out)}`)

await stop()
process.exit(0)

// ── helpers ──────────────────────────────────────────────────────────────────

async function buildDemoStories(appRoot) {
  let index
  try {
    index = JSON.parse(await readFile(path.join(starterDir, "index.json"), "utf8"))
  } catch {
    console.warn("no starter-stories/index.json — web demo will have no stories")
    return
  }
  const storiesOut = path.join(appRoot, "stories")
  await mkdir(storiesOut, { recursive: true })

  const manifest = []
  for (const starter of index.starters || []) {
    const id = starter.id || path.basename(starter.file, ".json")
    let snapshot
    try {
      snapshot = JSON.parse(await readFile(path.join(starterDir, starter.file), "utf8"))
    } catch {
      console.warn(`skip starter ${id}: cannot read ${starter.file}`)
      continue
    }
    const files = new Map((snapshot.files || []).map((f) => [f.path, f]))
    const text = (p) => (files.get(p)?.content ?? "")

    const dir = path.join(storiesOut, id)
    await mkdir(path.join(dir, "includes"), { recursive: true })

    // Decode and emit every includes/** asset so assetUrl() resolves over HTTP.
    let cover = ""
    for (const [p, f] of files) {
      if (!p.startsWith("includes/")) continue
      const target = path.join(dir, p)
      await mkdir(path.dirname(target), { recursive: true })
      if (f.encoding === "base64") await writeFile(target, Buffer.from(f.content || "", "base64"))
      else await writeFile(target, String(f.content ?? ""), "utf8")
      if (p === "includes/cover.jpg") cover = `${id}/includes/cover.jpg`
    }

    const meta = safeJson(text("meta.json")) || {}
    const config = safeJson(text("format/config.json")) || {}
    const foreground = text("guidance/FOREGROUND.md")

    const story = {
      id,
      displayName: meta.displayName || starter.title || id,
      lang: starter.lang || "",
      foreground,
      memory: text("memory/MEMORY.md"),
      prelude: extractSection(foreground, "Prelude"),
      includesIndex: text("includes/INDEX.md"),
      openingBackdrop: openingBackdropFrom(text("includes/INDEX.md"), files),
      hudInitial: hudInitialFrom(config),
      formatContract: formatContractFrom(config),
    }
    await writeFile(path.join(dir, "story.json"), JSON.stringify(story), "utf8")
    manifest.push({ id, title: story.displayName, lang: story.lang, cover })
  }

  await writeFile(path.join(storiesOut, "index.json"), JSON.stringify({ stories: manifest }, null, 2), "utf8")
  console.log(`demo stories: ${manifest.map((s) => s.id).join(", ") || "(none)"}`)
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

// Pull a `## <title>` section body out of a composed markdown doc.
function extractSection(md, title) {
  const re = new RegExp(`(^|\\n)##\\s+${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  const m = String(md || "").match(re)
  return m ? m[2].trim() : ""
}

// Reserved HUD channel lives under `hud` or the older `reservedChannels.hud`.
function hudChannel(config) {
  return config?.hud || config?.reservedChannels?.hud || null
}

// Initial slot values: config slots can be the current array shape
// ([{id,label}]) or the older object map ({status:{label,initial}}).
function hudInitialFrom(config) {
  const hud = hudChannel(config)
  const slots = hud?.slots
  const out = {}
  if (Array.isArray(slots)) {
    for (const s of slots) if (s?.id && s.initial) out[s.id] = String(s.initial)
  } else if (slots && typeof slots === "object") {
    for (const [id, s] of Object.entries(slots)) if (s?.initial) out[id] = String(s.initial)
  }
  return out
}

// Build the renderer-shaped formatContract from the story config.json: HUD slots
// as an array of {id,label,kind}, include enabled, backdrop on.
function formatContractFrom(config) {
  const hud = hudChannel(config)
  const include = config?.include || config?.reservedChannels?.include || null
  let slots = []
  if (Array.isArray(hud?.slots)) {
    slots = hud.slots
      .filter((s) => s?.id)
      .map((s) => ({ id: String(s.id), label: String(s.label ?? s.id).slice(0, 60), kind: "text" }))
  } else if (hud?.slots && typeof hud.slots === "object") {
    slots = Object.entries(hud.slots).map(([id, s]) => ({
      id,
      label: String(s?.label ?? id).slice(0, 60),
      kind: "text",
    }))
  }
  return {
    enabled: true,
    theme: config?.theme || {},
    css: "",
    contentCss: "",
    hudCss: "",
    blocks: {},
    hud: hud?.enabled !== false && slots.length ? { slots } : null,
    include: include ? { enabled: include.enabled !== false, allow: include.allow || ["image"] } : { enabled: true, allow: ["image"] },
    imageBackground: true,
  }
}

// Opening backdrop: first bullet under "Page backgrounds" in INDEX.md, else the
// first includes/bg/* asset present. Returned as the `story/includes/...` rel the
// ovl:bg fence uses.
function openingBackdropFrom(indexMd, files) {
  const section = extractSection(indexMd, "Page backgrounds")
  const m = section.match(/`story\/includes\/bg\/[^`]+`/) || (indexMd || "").match(/`story\/includes\/bg\/[^`]+`/)
  if (m) return m[0].replace(/`/g, "")
  for (const p of files.keys()) if (p.startsWith("includes/bg/")) return `story/${p}`
  return ""
}
