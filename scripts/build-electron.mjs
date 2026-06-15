// Bundle the Electron renderer (React + JSX + CSS) into a single
// dist-electron/renderer/bundle.{js,css} that index.html loads directly.
// Main + preload don't need bundling — Electron runs them as Node CJS/ESM
// directly.

import { build, stop } from "esbuild"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const src = path.join(root, "src/electron/renderer")
const out = path.join(root, "dist-electron/renderer")

await mkdir(out, { recursive: true })

const t0 = Date.now()
await build({
  entryPoints: [path.join(src, "main.jsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  // Code-splitting: streamdown lazy-imports shiki (syntax highlighting) and
  // mermaid (diagrams) via dynamic import(). With splitting on, those land in
  // separate chunks that load only when a code fence / mermaid block actually
  // renders — which narration prose never has — so the initial bundle stays
  // lean. entryNames keeps the entry output named `bundle.js` (index.html
  // loads it as <script type="module">).
  outdir: out,
  entryNames: "bundle",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  jsx: "automatic",
  // .png → inlined base64 data URI (used by the share-card logo). The renderer
  // is sandboxed with a strict CSP; a data: URI sidesteps file-path/CSP issues.
  // .txt → inlined string (operator-editable copy like the slider-preview
  // sample passages; edits land on the next bundle, i.e. next launch).
  loader: { ".js": "jsx", ".jsx": "jsx", ".png": "dataurl", ".txt": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: false,
  sourcemap: true,
  logLevel: "warning",
})

// Bundle CSS via separate build (esbuild supports CSS natively)
await build({
  entryPoints: [path.join(src, "styles/theme.css")],
  bundle: true,
  outfile: path.join(out, "bundle.css"),
  loader: { ".css": "css" },
  logLevel: "warning",
})

// index.html → dist-electron/renderer/
await copyFile(path.join(src, "index.html"), path.join(out, "index.html"))

console.log(`electron renderer bundled in ${Date.now() - t0}ms → ${path.relative(root, out)}`)

// Release esbuild's long-lived service so this process exits promptly. Without
// it, the held service handle can keep Node alive (esp. under load), so
// `build:electron && electron .` would print "bundled …" and then hang at the
// `&&` — the build never returns and the app never launches.
await stop()
