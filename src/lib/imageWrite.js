// Pure, Electron-free guards for the WRITE side of image acquisition (the
// fetch_image / generate_image tools). The SERVE side (includeAsset.js,
// ovl-asset://) is a separate boundary; this is defense-in-depth on the way IN.
//
// Hard rule: the write allowlist EQUALS the sniff list. We only accept image
// kinds we can verify by magic bytes — an extension we can't byte-verify is
// refused, not "allowed-but-always-rejected". So: png/jpg/jpeg/gif/webp only.
// svg is refused outright (active content / XSS even though it's served-side
// allowlisted for user-supplied files); avif is deferred until we sniff its
// `ftyp avif` box.

import { isUnsafeIncludePath, isUnderIncludes, includeExtension } from "./includePaths.js"

// 8 MiB. Generated images (bounded by the gen size param) and ordinary web
// images fit well under this; genuinely huge downloads are refused.
export const IMAGE_SIZE_CAP = 8 * 1024 * 1024

// ext -> canonical sniff kind. Both the write allowlist and the sniff agree on
// this set. jpg/jpeg both map to "jpeg".
const WRITE_EXT_KIND = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" }

// kind -> the canonical file extension to save it with (jpeg -> jpg).
const EXT_BY_KIND = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" }

export const IMAGE_WRITE_EXTS = Object.keys(WRITE_EXT_KIND)

// The canonical sniff kind for a target path's extension, or null if the
// extension is not in the write allowlist (svg/avif/non-image -> null).
export function targetImageKind(rel) {
  return WRITE_EXT_KIND[includeExtension(rel)] || null
}

// Given a requested path and the ACTUAL sniffed kind of the bytes, return the
// path with an extension matching the content. Providers often return JPEG for
// a `.png` request; rather than reject, we save with the correct extension so
// the file is well-formed. No change when the extension already matches.
export function correctImagePath(rel, kind) {
  if (targetImageKind(rel) === kind) return String(rel)
  const want = EXT_BY_KIND[kind]
  if (!want) return String(rel)
  return String(rel).replace(/\.[a-z0-9]+$/i, `.${want}`)
}

// Validate the destination path for an acquired image. Returns { ok, reason }.
export function validateImageTarget(rel) {
  const value = String(rel || "").trim()
  if (!value) return { ok: false, reason: "empty path" }
  if (isUnsafeIncludePath(value)) return { ok: false, reason: "unsafe path (must be a relative path inside story/)" }
  if (!isUnderIncludes(value)) return { ok: false, reason: "must live under story/includes/" }
  const ext = includeExtension(value)
  if (ext === "svg") return { ok: false, reason: "svg is refused (active content / XSS risk)" }
  const kind = WRITE_EXT_KIND[ext]
  if (!kind) return { ok: false, reason: `extension .${ext || "?"} not in the image write allowlist (${IMAGE_WRITE_EXTS.join(", ")})` }
  return { ok: true, ext, kind }
}

// Identify image bytes by magic number. Returns "png" | "jpeg" | "gif" | "webp"
// | null. This is the control that defeats a server lying about Content-Type
// (an HTML/JS payload named .png), since bytes can't be faked.
export function sniffImageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png"
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg"
  // GIF: "GIF8"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "gif"
  // WEBP: "RIFF"...."WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "webp"
  }
  return null
}

// Full byte-level acceptance: size under cap AND the sniffed kind matches the
// target extension's kind. Returns { ok, reason }.
export function acceptImageBytes(rel, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, reason: "empty body" }
  if (buffer.length > IMAGE_SIZE_CAP) {
    return { ok: false, reason: `image too large (${buffer.length} bytes > ${IMAGE_SIZE_CAP} cap)` }
  }
  const target = validateImageTarget(rel)
  if (!target.ok) return target
  const sniffed = sniffImageKind(buffer)
  if (!sniffed) return { ok: false, reason: "bytes are not a recognized image (png/jpeg/gif/webp)" }
  // The bytes are a real image. If the kind doesn't match the requested
  // extension (e.g. JPEG bytes at a .png path), the caller saves with the
  // corrected extension (correctImagePath) rather than failing.
  return { ok: true, kind: sniffed, ext: EXT_BY_KIND[sniffed] }
}
