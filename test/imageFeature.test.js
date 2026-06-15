import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { writeBinary } from "../src/lib/files.js"
import {
  validateImageTarget,
  targetImageKind,
  sniffImageKind,
  acceptImageBytes,
  IMAGE_SIZE_CAP,
  IMAGE_WRITE_EXTS,
} from "../src/lib/imageWrite.js"
import { prepareImageForRead, isReadableImageExt, READ_IMAGE_BYTE_BUDGET } from "../src/lib/imageRead.js"
import { extractImageResult, hasImageGenerationConfig, hasImageKey, generateImageBytes, resolveImageConfig } from "../src/provider/imageGeneration.js"
import {
  textPart,
  imagePart,
  normalizeParts,
  hasImageParts,
  stripImagesToText,
  toOpenAIContent,
  toAnthropicBlocks,
} from "../src/provider/multimodalContent.js"
import { prepareOpenAIMessages } from "../src/provider/openaiCompatible.js"
import { toAnthropicRequest } from "../src/provider/anthropic.js"
import { isImageGenEnabled, isFormatContractEnabled, isStoryIncludesEnabled } from "../src/lib/formatContract.js"
import { loadAgentConfigs } from "../src/agents/loadAgentConfigs.js"
import { loadSettings } from "../src/config/settings.js"
import { imageAgentContract, formatContractAuthoringContract } from "../src/prompts/agentContracts.js"

// ── magic-byte fixtures (each >= 12 bytes so sniffImageKind engages) ──────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0, 0]) // "GIF89a"
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]) // RIFF....WEBP
const HTML = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>", "utf8")

// ── writeBinary ───────────────────────────────────────────────────────────────
test("writeBinary round-trips bytes exactly and asserts a Buffer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openovel-img-wb-"))
  const file = path.join(dir, "nested", "x.png")
  await writeBinary(file, PNG)
  const back = await readFile(file)
  assert.ok(Buffer.isBuffer(back))
  assert.ok(back.equals(PNG), "bytes survive the temp+rename round-trip")
  // no leftover temp sibling
  const info = await stat(file)
  assert.equal(info.size, PNG.length)
  await assert.rejects(() => writeBinary(file, "not a buffer"), /expects a Buffer/)
  await assert.rejects(() => writeBinary(file, PNG.toString("base64")), TypeError)
})

// ── imageWrite: target validation ─────────────────────────────────────────────
test("validateImageTarget accepts the write allowlist under story/includes/", () => {
  for (const ext of IMAGE_WRITE_EXTS) {
    const r = validateImageTarget(`story/includes/beats/hero.${ext}`)
    assert.equal(r.ok, true, `${ext} should be accepted`)
  }
  assert.equal(validateImageTarget("story/includes/a.png").ok, true)
})

test("validateImageTarget refuses traversal, non-includes, svg, and non-image", () => {
  assert.equal(validateImageTarget("").ok, false)
  assert.equal(validateImageTarget("   ").ok, false)
  assert.equal(validateImageTarget("../etc/x.png").ok, false)
  assert.equal(validateImageTarget("story/includes/../../etc/x.png").ok, false)
  assert.equal(validateImageTarget("/abs/x.png").ok, false)
  assert.equal(validateImageTarget("~/x.png").ok, false)
  // outside the dedicated includes dir
  assert.equal(validateImageTarget("story/canon/x.png").ok, false)
  // svg is refused outright (active content / XSS), even though served-side allowlisted
  const svg = validateImageTarget("story/includes/x.svg")
  assert.equal(svg.ok, false)
  assert.match(svg.reason, /svg/i)
  // an extension we cannot byte-verify is refused, not silently allowed
  assert.equal(validateImageTarget("story/includes/x.avif").ok, false)
  assert.equal(validateImageTarget("story/includes/x.txt").ok, false)
})

test("targetImageKind maps extensions to canonical sniff kinds", () => {
  assert.equal(targetImageKind("story/includes/a.png"), "png")
  assert.equal(targetImageKind("story/includes/a.jpg"), "jpeg")
  assert.equal(targetImageKind("story/includes/a.jpeg"), "jpeg")
  assert.equal(targetImageKind("story/includes/a.gif"), "gif")
  assert.equal(targetImageKind("story/includes/a.webp"), "webp")
  assert.equal(targetImageKind("story/includes/a.svg"), null)
  assert.equal(targetImageKind("story/includes/a.txt"), null)
})

// ── imageWrite: magic-byte sniff ──────────────────────────────────────────────
test("sniffImageKind identifies real headers and rejects HTML/short buffers", () => {
  assert.equal(sniffImageKind(PNG), "png")
  assert.equal(sniffImageKind(JPEG), "jpeg")
  assert.equal(sniffImageKind(GIF), "gif")
  assert.equal(sniffImageKind(WEBP), "webp")
  // a server lying about Content-Type can't fake the bytes
  assert.equal(sniffImageKind(HTML), null)
  assert.equal(sniffImageKind(Buffer.from([0x89, 0x50])), null) // too short
  assert.equal(sniffImageKind("not a buffer"), null)
  // RIFF without WEBP tag is not webp
  assert.equal(sniffImageKind(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])), null)
})

// ── imageWrite: full acceptance (size cap + real image) ───────────────────────
test("acceptImageBytes enforces size cap and that the bytes are a real image", () => {
  assert.equal(acceptImageBytes("story/includes/a.png", PNG).ok, true)
  assert.equal(acceptImageBytes("story/includes/a.jpg", JPEG).ok, true)
  // empty
  assert.equal(acceptImageBytes("story/includes/a.png", Buffer.alloc(0)).ok, false)
  // not an image at all (HTML named .png) — still rejected by the sniff
  assert.equal(acceptImageBytes("story/includes/a.png", HTML).ok, false)
  // content/extension mismatch is now ACCEPTED — the caller saves with the
  // corrected extension (providers often return JPEG for a .png request).
  const mismatch = acceptImageBytes("story/includes/a.png", JPEG)
  assert.equal(mismatch.ok, true)
  assert.equal(mismatch.kind, "jpeg")
  assert.equal(mismatch.ext, "jpg")
  // bad target path is refused before sniff
  assert.equal(acceptImageBytes("story/includes/a.svg", PNG).ok, false)
  // over the cap
  const huge = Buffer.concat([PNG, Buffer.alloc(IMAGE_SIZE_CAP + 1)])
  const over = acceptImageBytes("story/includes/a.png", huge)
  assert.equal(over.ok, false)
  assert.match(over.reason, /too large/i)
})

test("correctImagePath swaps the extension to match the real image kind", async () => {
  const { correctImagePath } = await import("../src/lib/imageWrite.js")
  // JPEG bytes requested at a .png path → save as .jpg
  assert.equal(correctImagePath("story/includes/beats/x.png", "jpeg"), "story/includes/beats/x.jpg")
  // already matching → unchanged
  assert.equal(correctImagePath("story/includes/beats/x.png", "png"), "story/includes/beats/x.png")
  assert.equal(correctImagePath("story/includes/beats/x.jpeg", "jpeg"), "story/includes/beats/x.jpeg")
  assert.equal(correctImagePath("story/includes/beats/x.jpg", "webp"), "story/includes/beats/x.webp")
})

// ── imageRead ─────────────────────────────────────────────────────────────────
test("prepareImageForRead returns base64 + media type for a recognized image", () => {
  const r = prepareImageForRead(PNG)
  assert.equal(r.ok, true)
  assert.equal(r.kind, "png")
  assert.equal(r.mediaType, "image/png")
  assert.equal(r.bytes, PNG.length)
  assert.equal(Buffer.from(r.dataBase64, "base64").equals(PNG), true)
})

test("prepareImageForRead refuses empty, non-image, and over-budget bytes", () => {
  assert.equal(prepareImageForRead(Buffer.alloc(0)).ok, false)
  assert.equal(prepareImageForRead(HTML).ok, false)
  assert.equal(prepareImageForRead("not a buffer").ok, false)
  const over = prepareImageForRead(Buffer.concat([PNG, Buffer.alloc(READ_IMAGE_BYTE_BUDGET + 1)]))
  assert.equal(over.ok, false)
  assert.match(over.reason, /too large|budget/i)
})

test("isReadableImageExt covers the sniff-backed set only", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", ".PNG", "JPG"]) {
    assert.equal(isReadableImageExt(ext), true, ext)
  }
  for (const ext of ["svg", "avif", "txt", "md", ""]) {
    assert.equal(isReadableImageExt(ext), false, ext)
  }
})

// ── imageGeneration: response extraction ──────────────────────────────────────
test("extractImageResult walks the b64/url/images fallback chain", () => {
  // preferred: b64_json → Buffer
  const b64 = PNG.toString("base64")
  assert.ok(extractImageResult({ data: [{ b64_json: b64 }] }).equals(PNG))
  // url → { url }
  assert.deepEqual(extractImageResult({ data: [{ url: "https://x/y.png" }] }), { url: "https://x/y.png" })
  // images[] shape
  assert.ok(extractImageResult({ images: [{ b64_json: b64 }] }).equals(PNG))
  // bare-string b64 element
  assert.ok(extractImageResult({ data: [b64] }).equals(PNG))
  // bare-string url element
  assert.deepEqual(extractImageResult({ data: ["http://x/y.png"] }), { url: "http://x/y.png" })
  // OpenRouter chat image output: data URL inside choices[0].message.images
  assert.ok(extractImageResult({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }] }).equals(PNG))
  // top-level b64_json
  assert.ok(extractImageResult({ b64_json: b64 }).equals(PNG))
  // nothing usable
  assert.equal(extractImageResult({ data: [] }), null)
  assert.equal(extractImageResult({}), null)
})

test("hasImageKey requires both base url and api key", () => {
  assert.equal(hasImageKey({ OPENOVEL_IMAGE_BASE_URL: "https://x", OPENOVEL_IMAGE_API_KEY: "k" }), true)
  assert.equal(hasImageKey({ OPENOVEL_IMAGE_PROVIDER: "volcengine", ARK_API_KEY: "k" }), true)
  assert.equal(hasImageKey({ OPENOVEL_IMAGE_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }), true)
  assert.equal(hasImageKey({ OPENOVEL_IMAGE_BASE_URL: "https://x" }), false)
  assert.equal(hasImageKey({ OPENOVEL_IMAGE_API_KEY: "k" }), false)
  assert.equal(hasImageKey({}), false)
})

test("hasImageGenerationConfig also requires an image model", () => {
  assert.equal(hasImageGenerationConfig({ OPENOVEL_IMAGE_BASE_URL: "https://x", OPENOVEL_IMAGE_API_KEY: "k", OPENOVEL_IMAGE_MODEL: "img" }), true)
  assert.equal(hasImageGenerationConfig({ OPENOVEL_IMAGE_PROVIDER: "volcengine", OPENOVEL_IMAGE_API_KEY: "k" }), true)
  assert.equal(hasImageGenerationConfig({ OPENOVEL_IMAGE_PROVIDER: "openrouter", OPENOVEL_IMAGE_API_KEY: "k" }), false)
  assert.equal(hasImageGenerationConfig({ OPENOVEL_IMAGE_BASE_URL: "https://x", OPENOVEL_IMAGE_API_KEY: "k" }), false)
})

test("resolveImageConfig applies provider defaults and aliases customer to custom", () => {
  const volc = resolveImageConfig({ OPENOVEL_IMAGE_PROVIDER: "volcengine", ARK_API_KEY: "ark" })
  assert.equal(volc.baseUrl, "https://ark.cn-beijing.volces.com/api/v3")
  assert.equal(volc.model, "doubao-seedream-5-0-260128")
  assert.equal(volc.path, "/images/generations")
  assert.equal(volc.size, "2K")
  assert.equal(volc.apiKey, "ark")
  assert.equal(resolveImageConfig({ OPENOVEL_IMAGE_PROVIDER: "customer" }).provider, "custom")
})

test("generateImageBytes throws when unconfigured", async () => {
  await assert.rejects(() => generateImageBytes({ prompt: "x", env: {} }), /not configured/i)
  await assert.rejects(
    () => generateImageBytes({ prompt: "x", env: { OPENOVEL_IMAGE_BASE_URL: "https://img.example/v1", OPENOVEL_IMAGE_API_KEY: "secret" } }),
    /OPENOVEL_IMAGE_MODEL/,
  )
})

test("generateImageBytes POSTs the OpenAI-images body and decodes b64_json", async () => {
  const env = { OPENOVEL_IMAGE_PROVIDER: "custom", OPENOVEL_IMAGE_BASE_URL: "https://img.example/v1/", OPENOVEL_IMAGE_API_KEY: "secret", OPENOVEL_IMAGE_MODEL: "img-1" }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }) }
  }
  try {
    const buf = await generateImageBytes({ prompt: "a lighthouse", size: "512x512", env })
    assert.ok(Buffer.isBuffer(buf) && buf.equals(PNG))
    assert.equal(calls.length, 1)
    // trailing slash on base url is normalized
    assert.equal(calls[0].url, "https://img.example/v1/images/generations")
    assert.equal(calls[0].opts.method, "POST")
    assert.match(calls[0].opts.headers.Authorization, /Bearer secret/)
    const body = JSON.parse(calls[0].opts.body)
    assert.equal(body.model, "img-1")
    assert.equal(body.prompt, "a lighthouse")
    assert.equal(body.n, 1)
    assert.equal(body.size, "512x512")
    assert.equal(body.response_format, "b64_json")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("generateImageBytes POSTs the Volcengine Ark images body and returns URL", async () => {
  const env = { OPENOVEL_IMAGE_PROVIDER: "volcengine", ARK_API_KEY: "ark-secret" }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: "https://cdn.example/out.png" }] }) }
  }
  try {
    const result = await generateImageBytes({ prompt: "星际穿越", env })
    assert.deepEqual(result, { url: "https://cdn.example/out.png" })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/images/generations")
    assert.match(calls[0].opts.headers.Authorization, /Bearer ark-secret/)
    const body = JSON.parse(calls[0].opts.body)
    assert.equal(body.model, "doubao-seedream-5-0-260128")
    assert.equal(body.prompt, "星际穿越")
    assert.equal(body.sequential_image_generation, "disabled")
    assert.equal(body.response_format, "url")
    assert.equal(body.size, "2K")
    assert.equal(body.stream, false)
    // Provider-stamped badge defaults OFF; OPENOVEL_IMAGE_WATERMARK=1 opts in.
    assert.equal(body.watermark, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("OPENOVEL_IMAGE_WATERMARK=1 turns the Volcengine watermark back on", async () => {
  const env = { OPENOVEL_IMAGE_PROVIDER: "volcengine", ARK_API_KEY: "ark-secret", OPENOVEL_IMAGE_WATERMARK: "1" }
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: "https://cdn.example/out.png" }] }) }
  }
  try {
    await generateImageBytes({ prompt: "星际穿越", env })
    const body = JSON.parse(calls[0].opts.body)
    assert.equal(body.watermark, true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("generateImageBytes POSTs OpenRouter chat image requests and decodes image data URLs", async () => {
  const env = { OPENOVEL_IMAGE_PROVIDER: "openrouter", OPENOVEL_IMAGE_API_KEY: "or-secret", OPENOVEL_IMAGE_MODEL: "google/gemini-2.5-flash-image" }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] } }],
      }),
    }
  }
  try {
    const result = await generateImageBytes({ prompt: "a lighthouse", size: "4K", env })
    assert.ok(Buffer.isBuffer(result) && result.equals(PNG))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions")
    const body = JSON.parse(calls[0].opts.body)
    assert.equal(body.model, "google/gemini-2.5-flash-image")
    assert.deepEqual(body.messages, [{ role: "user", content: "a lighthouse" }])
    assert.deepEqual(body.modalities, ["image", "text"])
    assert.deepEqual(body.image_config, { image_size: "4K" })
    assert.equal(body.stream, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── multimodalContent (pure parts) ────────────────────────────────────────────
test("multimodal part builders and normalization", () => {
  assert.deepEqual(textPart("hi"), { type: "text", text: "hi" })
  assert.deepEqual(imagePart({ dataBase64: "AAA", mediaType: "image/jpeg" }), { type: "image", mediaType: "image/jpeg", dataBase64: "AAA" })
  assert.equal(imagePart({ dataBase64: "AAA" }).mediaType, "image/png") // default
  assert.deepEqual(normalizeParts("hello"), [{ type: "text", text: "hello" }])
  assert.deepEqual(normalizeParts(null), [])
  assert.equal(normalizeParts(["a", { type: "image", mediaType: "image/png", dataBase64: "x" }]).length, 2)
  assert.equal(hasImageParts([textPart("a")]), false)
  assert.equal(hasImageParts([imagePart({ dataBase64: "x" })]), true)
  assert.equal(hasImageParts("a string"), false)
})

test("stripImagesToText replaces images with a placeholder, keeps text", () => {
  const parts = [textPart("look:"), imagePart({ dataBase64: "x", mediaType: "image/png" })]
  const stripped = stripImagesToText(parts)
  assert.equal(stripped.length, 2)
  assert.equal(stripped[0].text, "look:")
  assert.equal(stripped[1].type, "text")
  assert.match(stripped[1].text, /image omitted/i)
  assert.equal(hasImageParts(stripped), false)
})

test("toOpenAIContent emits image_url data URLs; toAnthropicBlocks emits base64 source", () => {
  const parts = [textPart("see"), imagePart({ dataBase64: "QUJD", mediaType: "image/png" })]
  const oai = toOpenAIContent(parts)
  assert.deepEqual(oai[0], { type: "text", text: "see" })
  assert.deepEqual(oai[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } })
  const ant = toAnthropicBlocks(parts)
  assert.deepEqual(ant[0], { type: "text", text: "see" })
  assert.deepEqual(ant[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })
})

// ── adapter mapping (capability-gated) ────────────────────────────────────────
test("prepareOpenAIMessages sends image_url to vision models, strips for non-vision", () => {
  const msgs = [{ role: "user", content: [textPart("look"), imagePart({ dataBase64: "AAA", mediaType: "image/png" })] }]
  const vision = prepareOpenAIMessages(msgs, true)
  assert.equal(vision[0].content[1].type, "image_url")
  assert.equal(vision[0].content[1].image_url.url, "data:image/png;base64,AAA")
  const text = prepareOpenAIMessages(msgs, false)
  assert.equal(text[0].content[1].type, "text")
  assert.match(text[0].content[1].text, /image omitted/i)
  assert.ok(!text[0].content.some((p) => p.type === "image_url"))
  // string content passes through untouched (back-compat)
  const passthrough = prepareOpenAIMessages([{ role: "user", content: "hi" }], true)
  assert.equal(passthrough[0].content, "hi")
})

test("toAnthropicRequest carries an image block inside tool_result, preserving tool_call_id", () => {
  const messages = [{
    role: "tool",
    tool_call_id: "call_42",
    content: [textPart("here is the image"), imagePart({ dataBase64: "AAA", mediaType: "image/png" })],
  }]
  const vision = toAnthropicRequest({ model: "m", messages, imageInput: true })
  const tr = vision.messages[0].content[0]
  assert.equal(tr.type, "tool_result")
  assert.equal(tr.tool_use_id, "call_42")
  assert.ok(tr.content.some((b) => b.type === "image" && b.source?.data === "AAA"), "image block survives")
  // non-vision model: image stripped to text, tool linkage intact
  const text = toAnthropicRequest({ model: "m", messages, imageInput: false })
  const tr2 = text.messages[0].content[0]
  assert.equal(tr2.tool_use_id, "call_42")
  assert.ok(!tr2.content.some((b) => b.type === "image"), "no image block for non-vision model")
  assert.ok(tr2.content.some((b) => b.type === "text" && /image omitted/i.test(b.text)))
})

// ── flag gating + implies-both ────────────────────────────────────────────────
test("isImageGenEnabled gates on OPENOVEL_ENABLE_IMAGE_GEN and implies format+includes", () => {
  const on = { OPENOVEL_ENABLE_IMAGE_GEN: "true" }
  assert.equal(isImageGenEnabled(on), true)
  // image-gen forces BOTH format-contract and story-includes on (so images render)
  assert.equal(isFormatContractEnabled(on), true)
  assert.equal(isStoryIncludesEnabled(on), true)
  // off → all off (with no other flags)
  assert.equal(isImageGenEnabled({}), false)
  assert.equal(isFormatContractEnabled({}), false)
  assert.equal(isStoryIncludesEnabled({}), false)
})

test("loadAgentConfigs includes the image agent only when image-gen is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-img-agents-"))
  const on = await loadAgentConfigs({ root, imageEnabled: true, formatEnabled: false })
  assert.ok(on.some((c) => c.id === "image"), "image agent present when enabled")
  const off = await loadAgentConfigs({ root, imageEnabled: false, formatEnabled: false })
  assert.ok(!off.some((c) => c.id === "image"), "image agent absent when disabled")
})

// ── settings round-trip ───────────────────────────────────────────────────────
test("settings round-trips tools.imageGen <-> OPENOVEL_ENABLE_IMAGE_GEN", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-img-settings-"))
  const baseEnv = { OPENOVEL_HOME: home, OPENOVEL_IGNORE_PROJECT_CONFIG: "1" }
  const on = loadSettings({ cwd: home, env: { ...baseEnv, OPENOVEL_ENABLE_IMAGE_GEN: "true" } })
  assert.equal(on.settings.tools.imageGen, true)
  assert.equal(on.env.OPENOVEL_ENABLE_IMAGE_GEN, "true")
  const off = loadSettings({ cwd: home, env: baseEnv })
  assert.equal(off.settings.tools.imageGen, false)
  assert.equal(off.env.OPENOVEL_ENABLE_IMAGE_GEN, "false")
})

// ── prompts ───────────────────────────────────────────────────────────────────
test("imageAgentContract states the load-bearing directives", () => {
  const c = imageAgentContract()
  assert.equal(typeof c, "string")
  // illustrate the FUTURE, never the past
  assert.match(c, /FUTURE/)
  assert.match(c, /never the past/i)
  // dedupe by deterministic slug via glob
  assert.match(c, /DEDUPE/)
  assert.match(c, /glob/)
  assert.match(c, /NEVER regenerate/i)
  // at most one per run
  assert.match(c, /AT MOST ONE/i)
  // routes frontend + contract through the Showrunner, never writes them itself
  assert.match(c, /forShowrunner/)
  // refuses svg
  assert.match(c, /SVG is refused/i)
})

test("imageAgentContract mentions generate_image only when generation is configured", () => {
  const off = imageAgentContract({ generateImageEnabled: false })
  assert.match(off, /fetch_image/)
  assert.doesNotMatch(off, /generate_image/)
  assert.doesNotMatch(off, /generation fails/)

  const on = imageAgentContract({ generateImageEnabled: true })
  assert.match(on, /fetch_image/)
  assert.match(on, /generate_image/)
  assert.match(on, /generation fails/)
})

test("imageAgentContract enforces sheet-first character image generation when enabled", () => {
  const off = imageAgentContract({ generateImageEnabled: true, characterSheetsEnabled: false })
  assert.doesNotMatch(off, /SHEET-FIRST GATE/)
  assert.doesNotMatch(off, /SHEET COMPOSITION/)

  const on = imageAgentContract({ generateImageEnabled: true, characterSheetsEnabled: true })
  assert.match(on, /SHEET-FIRST GATE/)
  assert.match(on, /before preparing any beat illustration, comic panel, or other character-visible image/)
  assert.match(on, /the missing\/stale sheet is the FIRST deliverable/)
  assert.match(on, /Do NOT batch a sheet generation together with an image that needs that sheet as referencePaths/)
  assert.match(on, /cast consistency outranks a fresh picture/i)
  // The gate is referenced from the PICK ONE decision point itself: the beat
  // pick is where the model commits to its first generation, so the pointer
  // must ride there, not only further down the contract.
  assert.match(on, /Picking a beat does NOT mean its illustration is the first thing you generate/)
  assert.doesNotMatch(off, /Picking a beat does NOT mean/)
  // The composition spec pins the sheet's structure (turnaround views, neutral
  // pose, flat light, no lettering) while leaving the rendering register to
  // style.md.
  assert.match(on, /SHEET COMPOSITION/)
  assert.match(on, /front, side profile, and back views/)
  assert.match(on, /relaxed neutral pose/)
  assert.match(on, /NO text, labels, or lettering/)
  assert.match(on, /rendering register stays story\/image\/style\.md's choice/)
})

test("formatContractAuthoringContract flips the binary-media line when image-gen is active", () => {
  const off = formatContractAuthoringContract({ includeEnabled: true, imageGenEnabled: false })
  assert.match(off, /BINARY MEDIA IS USER-SUPPLIED/)
  const on = formatContractAuthoringContract({ includeEnabled: true, imageGenEnabled: true })
  assert.ok(!/BINARY MEDIA IS USER-SUPPLIED/.test(on), "must not tell the Showrunner images are unavailable")
  assert.match(on, /Image agent prepares image files/)
})
