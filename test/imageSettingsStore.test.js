import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getImageSettingsSnapshot,
  hydrateImageEnvFromSettings,
  setImageSettings,
  testImageGeneration,
} from "../src/electron/imageSettingsStore.js"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0])

const ENV_KEYS = [
  "OPENOVEL_HOME",
  "OPENOVEL_CONFIG_DIR",
  "AI_STORY_CONFIG_DIR",
  "OPENOVEL_IGNORE_PROJECT_CONFIG",
  "OPENOVEL_IMAGE_BASE_URL",
  "OPENOVEL_IMAGE_API_KEY",
  "OPENOVEL_IMAGE_MODEL",
  "OPENOVEL_IMAGE_PATH",
  "OPENOVEL_IMAGE_PROVIDER",
  "OPENOVEL_IMAGE_SIZE",
  "ARK_API_KEY",
  "VOLCENGINE_API_KEY",
  "OPENROUTER_API_KEY",
]

async function withIsolatedImageEnv(run) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-image-settings-"))
  const configDir = await mkdtemp(path.join(os.tmpdir(), "openovel-image-config-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_CONFIG_DIR = configDir
  process.env.AI_STORY_CONFIG_DIR = configDir
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  try {
    return await run({ home })
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("image settings save redacted snapshot and hydrate OPENOVEL_IMAGE env", async () => {
  await withIsolatedImageEnv(async ({ home }) => {
    await setImageSettings({
      provider: "custom",
      baseUrl: "https://img.example/v1/",
      apiKey: "secret-image-key",
      model: "img-test",
      path: "/images/generations",
      size: "512x512",
    })

    const snap = await getImageSettingsSnapshot()
    assert.equal(snap.config.provider, "custom")
    assert.equal(snap.config.baseUrl, "https://img.example/v1/")
    assert.equal(snap.config.apiKey.set, true)
    assert.equal(snap.config.apiKey.masked, "secr…-key")
    assert.equal(snap.configured, true)

    for (const key of ["OPENOVEL_IMAGE_BASE_URL", "OPENOVEL_IMAGE_API_KEY", "OPENOVEL_IMAGE_MODEL", "OPENOVEL_IMAGE_PATH", "OPENOVEL_IMAGE_PROVIDER", "OPENOVEL_IMAGE_SIZE"]) {
      delete process.env[key]
    }
    await hydrateImageEnvFromSettings()
    assert.equal(process.env.OPENOVEL_IMAGE_PROVIDER, "custom")
    assert.equal(process.env.OPENOVEL_IMAGE_BASE_URL, "https://img.example/v1/")
    assert.equal(process.env.OPENOVEL_IMAGE_API_KEY, "secret-image-key")
    assert.equal(process.env.OPENOVEL_IMAGE_MODEL, "img-test")
    assert.equal(process.env.OPENOVEL_IMAGE_SIZE, "512x512")

    const saved = JSON.parse(await readFile(path.join(home, "settings.local.json"), "utf8"))
    assert.equal(saved.image.generation.apiKey, "secret-image-key")
  })
})

test("image generation test returns image metadata without writing a story file", async () => {
  await withIsolatedImageEnv(async () => {
    await setImageSettings({
      provider: "custom",
      baseUrl: "https://img.example/v1",
      apiKey: "secret",
      model: "img-test",
      size: "512x512",
    })
    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts })
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }) }
    }
    try {
      const res = await testImageGeneration()
      assert.equal(res.ok, true)
      assert.equal(res.kind, "png")
      assert.equal(res.mime, "image/png")
      assert.equal(res.bytes, PNG.length)
      assert.equal(res.dataUrl, `data:image/png;base64,${PNG.toString("base64")}`)
      assert.equal(res.model, "img-test")
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, "https://img.example/v1/images/generations")
      const body = JSON.parse(calls[0].opts.body)
      assert.match(body.prompt, /photo/i)
      assert.match(body.prompt, /photorealistic/i)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

test("volcengine preset supplies Ark defaults for settings and image test", async () => {
  await withIsolatedImageEnv(async () => {
    await setImageSettings({
      provider: "volcengine",
      apiKey: "ark-secret",
    })
    const snap = await getImageSettingsSnapshot()
    assert.equal(snap.config.provider, "volcengine")
    assert.equal(snap.config.baseUrl, "https://ark.cn-beijing.volces.com/api/v3")
    assert.equal(snap.config.model, "doubao-seedream-5-0-260128")
    assert.equal(snap.config.path, "/images/generations")
    assert.equal(snap.config.size, "2K")
    assert.equal(snap.configured, true)

    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts })
      if (url === "https://cdn.example/test.png") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
        }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: "https://cdn.example/test.png" }] }) }
    }
    try {
      const res = await testImageGeneration()
      assert.equal(res.ok, true)
      assert.equal(res.provider, "volcengine")
      assert.equal(res.model, "doubao-seedream-5-0-260128")
      assert.equal(res.size, "2K")
      assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/images/generations")
      const body = JSON.parse(calls[0].opts.body)
      assert.equal(body.response_format, "url")
      // Provider-stamped badge defaults OFF (OPENOVEL_IMAGE_WATERMARK opts in).
      assert.equal(body.watermark, false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

test("provider switch preserves each provider's saved config (no wipe)", async () => {
  await withIsolatedImageEnv(async () => {
    await setImageSettings({ provider: "volcengine", apiKey: "ark-key-12345678", model: "seedream-x" })
    await setImageSettings({ upsertCustomProvider: { name: "My Images", baseUrl: "https://img.example/v1", model: "gpt-image-2", apiKey: "sk-img-12345678" } })
    await setImageSettings({ provider: "custom:my-images" })

    let snap = await getImageSettingsSnapshot()
    assert.equal(snap.provider, "custom:my-images")
    assert.equal(snap.config.model, "gpt-image-2")
    assert.equal(snap.config.apiKey.set, true)
    assert.equal(process.env.OPENOVEL_IMAGE_BASE_URL, "https://img.example/v1")

    // Round-trip back: volcengine's key + model must be restored intact.
    await setImageSettings({ provider: "volcengine" })
    snap = await getImageSettingsSnapshot()
    assert.equal(snap.config.model, "seedream-x")
    assert.equal(snap.config.apiKey.set, true)

    // And forward again: the custom entry is intact too.
    await setImageSettings({ provider: "custom:my-images" })
    snap = await getImageSettingsSnapshot()
    assert.equal(snap.config.model, "gpt-image-2")
    assert.equal(snap.config.baseUrl, "https://img.example/v1")
    assert.equal(snap.config.apiKey.set, true)
  })
})

test("custom image entries: edit keeps saved key; delete falls back to custom preset", async () => {
  await withIsolatedImageEnv(async () => {
    await setImageSettings({ upsertCustomProvider: { name: "Edited", baseUrl: "https://a.example/v1", model: "m1", apiKey: "sk-keep-12345678" } })
    await setImageSettings({ provider: "custom:edited" })
    // Edit without apiKey → key persists.
    await setImageSettings({ upsertCustomProvider: { id: "custom:edited", name: "Edited", baseUrl: "https://b.example/v1", model: "m2" } })
    let snap = await getImageSettingsSnapshot()
    assert.equal(snap.customProviders[0].keySet, true)
    assert.equal(snap.config.baseUrl, "https://b.example/v1")
    assert.equal(snap.config.model, "m2")
    // Delete the active entry → falls back to the plain custom preset.
    await setImageSettings({ deleteCustomProvider: "custom:edited" })
    snap = await getImageSettingsSnapshot()
    assert.equal(snap.provider, "custom")
    assert.equal(snap.customProviders.length, 0)
  })
})
