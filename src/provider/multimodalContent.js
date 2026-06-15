// Internal, provider-neutral message content parts, so an image can travel
// through the chat path without each call site knowing OpenAI vs Anthropic wire
// shapes. A message `content` is either a plain string (the common case) or an
// array of these parts. Adapters convert at the boundary; non-vision models get
// images stripped to a placeholder so the request still runs.
//
// Part shapes:
//   { type: "text",  text }
//   { type: "image", mediaType, dataBase64 }

export function textPart(text) {
  return { type: "text", text: String(text ?? "") }
}

export function imagePart({ dataBase64, mediaType } = {}) {
  return { type: "image", mediaType: mediaType || "image/png", dataBase64: String(dataBase64 || "") }
}

// Any content → an array of parts (string → one text part).
export function normalizeParts(content) {
  if (typeof content === "string") return [textPart(content)]
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? textPart(p) : p)).filter(Boolean)
  if (content == null) return []
  return [textPart(String(content))]
}

export function hasImageParts(content) {
  return Array.isArray(content) && content.some((p) => p && p.type === "image")
}

// Replace image parts with a short text placeholder — for a model whose input
// modalities don't include image (so the request still runs, just text-only).
export function stripImagesToText(content) {
  return normalizeParts(content).map((p) =>
    p && p.type === "image" ? textPart("[image omitted: this model has no vision input]") : p,
  )
}

// Parts → OpenAI multimodal content array.
export function toOpenAIContent(content) {
  return normalizeParts(content).map((p) =>
    p && p.type === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } }
      : { type: "text", text: p.text || "" },
  )
}

// Parts → Anthropic content blocks.
export function toAnthropicBlocks(content) {
  return normalizeParts(content).map((p) =>
    p && p.type === "image"
      ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } }
      : { type: "text", text: p.text || "" },
  )
}
