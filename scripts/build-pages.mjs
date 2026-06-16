import { build, stop } from "esbuild"
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const src = path.join(root, "src/electron/renderer")
const out = path.join(root, "dist-pages")
const appOut = path.join(out, "app")

await rm(out, { recursive: true, force: true })
await mkdir(appOut, { recursive: true })

const t0 = Date.now()

await cp(path.join(root, "site"), out, { recursive: true })
await cp(path.join(root, "assets"), path.join(out, "assets"), { recursive: true })
await writeFile(path.join(out, ".nojekyll"), "")

await build({
  entryPoints: [path.join(src, "main.web.jsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: appOut,
  entryNames: "bundle",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  jsx: "automatic",
  loader: { ".js": "jsx", ".jsx": "jsx", ".png": "dataurl", ".txt": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: false,
  logLevel: "warning",
})

await build({
  entryPoints: [path.join(src, "styles/theme.css")],
  bundle: true,
  outfile: path.join(appOut, "bundle.css"),
  loader: { ".css": "css" },
  logLevel: "warning",
})

await copyFile(path.join(src, "index.web.html"), path.join(appOut, "index.html"))

console.log(`pages site built in ${Date.now() - t0}ms -> ${path.relative(root, out)}`)

await stop()
process.exit(0)
