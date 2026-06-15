// Replace the dev Electron.app's bundle icon (the atom logo) with ours, so
// macOS surfaces that read the BUNDLE icon — Stage Manager window-thumbnail
// badges, Mission Control, the app switcher — show the openovel icon during
// `npm run electron`. app.dock.setIcon() only changes the Dock tile; the
// bundle icns is the only way to reach the other surfaces in dev. Packaged
// builds are untouched (electron-builder bakes build/icon.png properly).
//
// macOS-only by nature (icns + iconutil); a no-op everywhere else and on any
// failure — a wrong dev icon must never block the build. Idempotent: a marker
// file remembers the source icon's mtime and skips when already patched.

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, utimesSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const SRC_ICON = path.join(root, "build", "icon.png")
const APP_DIR = path.join(root, "node_modules", "electron", "dist", "Electron.app")
const TARGET_ICNS = path.join(APP_DIR, "Contents", "Resources", "electron.icns")
const MARKER = path.join(root, "node_modules", "electron", ".openovel-dev-icon")

function main() {
  if (process.platform !== "darwin") return
  if (!existsSync(SRC_ICON) || !existsSync(TARGET_ICNS)) return

  const stamp = String(statSync(SRC_ICON).mtimeMs)
  try {
    if (readFileSync(MARKER, "utf8") === stamp) return // already patched from this source
  } catch { /* no marker yet */ }

  const iconset = path.join(tmpdir(), `openovel-iconset-${process.pid}.iconset`)
  try {
    rmSync(iconset, { recursive: true, force: true })
    mkdirSync(iconset, { recursive: true })
    // Standard icns ladder. sips resizes from the 1024 master; the @2x slots
    // reuse the next size up. Bundle icons get the squircle from macOS only in
    // packaged apps, so feed the pre-masked dev art (rounded corners baked in)
    // to match Dock neighbors — same reasoning as ICON_DOCK in main.js.
    const devMasked = path.join(root, "build", "icon-dev.png")
    const master = existsSync(devMasked) ? devMasked : SRC_ICON
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const out = path.join(iconset, `icon_${size}x${size}.png`)
      execFileSync("sips", ["-z", String(size), String(size), master, "--out", out], { stdio: "ignore" })
      if (size >= 32) {
        copyFileSync(out, path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`))
      }
    }
    const icns = path.join(tmpdir(), `openovel-dev-${process.pid}.icns`)
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "ignore" })
    copyFileSync(icns, TARGET_ICNS)
    rmSync(icns, { force: true })
    // Touch the bundle so LaunchServices notices the icon changed.
    const now = new Date()
    utimesSync(APP_DIR, now, now)
    writeFileSync(MARKER, stamp)
    process.stderr.write("[dev-icon] patched Electron.app bundle icon (Stage Manager / app switcher)\n")
  } catch {
    // Never block the build over a cosmetic dev icon.
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

main()
