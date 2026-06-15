// Prepare an image's bytes for a vision model to READ (the `read` tool's image
// path). Pure: takes a Buffer, returns base64 + media type or a refusal reason.
//
// v1 has no image-decode/resize dependency (the core runtime keeps deps
// minimal), so we enforce a hard byte budget and refuse anything over it rather
// than downsampling. Generated images (bounded by the gen size) and ordinary
// references fit; a genuinely huge file is refused with a clear note telling the
// agent to resize it. A resize step can replace the hard refusal later.

import { sniffImageKind } from "./imageWrite.js"

// Smaller than the write cap: a read image rides into the model context, so keep
// it bounded. ~4 MiB of base64 is already a large prompt cost.
export const READ_IMAGE_BYTE_BUDGET = 4 * 1024 * 1024

const MIME_BY_KIND = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }

// Buffer -> { ok, kind, mediaType, dataBase64, bytes } | { ok:false, reason }.
export function prepareImageForRead(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, reason: "empty file" }
  const kind = sniffImageKind(buffer)
  if (!kind) return { ok: false, reason: "not a recognized image (png/jpeg/gif/webp)" }
  if (buffer.length > READ_IMAGE_BYTE_BUDGET) {
    return { ok: false, reason: `image too large to read into context (${buffer.length} bytes > ${READ_IMAGE_BYTE_BUDGET} budget); resize it under the budget first` }
  }
  return { ok: true, kind, mediaType: MIME_BY_KIND[kind], dataBase64: buffer.toString("base64"), bytes: buffer.length }
}

// Extensions the read tool treats as images (the sniff-backed image set).
const IMAGE_READ_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"])
export function isReadableImageExt(ext) {
  return IMAGE_READ_EXTS.has(String(ext || "").toLowerCase().replace(/^\./, ""))
}
