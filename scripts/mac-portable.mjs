// Build a portable macOS .app and zip it ourselves, sidestepping the
// hairball of electron-builder's default codesign ceremony (timestamp
// server, hardened runtime, com.apple.provenance recovery loop, ...).
//
// Steps:
//   1. esbuild the renderer (npm run build:electron)
//   2. electron-builder --mac dir          → unsigned .app in dist/mac-<arch>/
//   3. codesign --force --deep --sign -    → minimal ad-hoc sign so the
//                                            Apple Silicon kernel accepts it
//   4. ditto -c -k --sequesterRsrc         → zip the signed .app
//
// Why ditto instead of `zip`: it's the macOS-native archiver, preserves
// xattrs, symlinks, and the .app bundle structure as Finder expects. The
// resulting zip is interchangeable with what electron-builder would have
// produced.
//
// Usage:  node scripts/mac-portable.mjs <arm64|x64|universal>

import { spawn } from "node:child_process"
import { readFile, rm, access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const arch = process.argv[2]
if (!["arm64", "x64", "universal"].includes(arch)) {
  console.error(`usage: node scripts/mac-portable.mjs <arm64|x64|universal>`)
  process.exit(2)
}

const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"))
const version = pkg.version
const productName = pkg.build?.productName || pkg.name

// electron-builder names directories `mac-arm64` / `mac-x64` / `mac-universal`
const appOutDir = path.join(REPO, "dist", arch === "x64" ? "mac" : `mac-${arch}`)
const appPath = path.join(appOutDir, `${productName}.app`)
const zipPath = path.join(REPO, "dist", `${productName}-${version}-${arch}-mac.zip`)

async function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`)
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: REPO, ...opts })
    p.on("error", reject)
    p.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with ${code}`))
    })
  })
}

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

// 1. esbuild bundle
await run("npm", ["run", "build:electron"])

// 2. electron-builder dir-only (no signing, no archive)
await rm(appOutDir, { recursive: true, force: true })
await rm(zipPath, { force: true })
await run("./node_modules/.bin/electron-builder", [
  "--mac", "dir",
  `--${arch}`,
], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } })

if (!(await exists(appPath))) {
  throw new Error(`expected .app at ${appPath} — electron-builder dir step did not produce it`)
}

// 3. minimal ad-hoc sign (no --timestamp, no --options runtime, no entitlements)
//    `--deep` walks the bundle and signs nested helpers / Electron Framework.
//    This is the only ceremony Apple Silicon's kernel actually needs.
await run("codesign", ["--force", "--deep", "--sign", "-", appPath])

// Verify the signature is in place (sanity check; if this fails the .app
// won't launch on Apple Silicon).
await run("codesign", ["--verify", "--deep", "--strict", appPath])

// 4. zip with ditto so the .app bundle structure is preserved exactly.
//    `--sequesterRsrc` keeps any resource fork data tucked into the zip
//    rather than as visible AppleDouble files. `--keepParent` keeps the
//    .app as the top-level entry in the archive instead of the loose
//    contents of the bundle.
await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath])

console.log(`\nportable build complete:`)
console.log(`  app:  ${path.relative(REPO, appPath)}`)
console.log(`  zip:  ${path.relative(REPO, zipPath)}`)
