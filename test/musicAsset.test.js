import test from "node:test"
import assert from "node:assert/strict"

import { musicAssetUrl, parseMusicUrl, resolveMusicTarget, MUSIC_SCHEME } from "../src/lib/musicAsset.js"
import { addEntry, emptyCatalog } from "../src/music/catalog.js"

test("musicAssetUrl builds the ovl-music url, with an optional cover part", () => {
  assert.equal(MUSIC_SCHEME, "ovl-music")
  assert.equal(musicAssetUrl("rainy-cafe"), "ovl-music://local/rainy-cafe")
  assert.equal(musicAssetUrl("rainy-cafe", "cover"), "ovl-music://local/rainy-cafe?part=cover")
})

test("parseMusicUrl extracts short id + part, rejecting bad input", () => {
  assert.deepEqual(parseMusicUrl("ovl-music://local/rainy-cafe"), { shortId: "rainy-cafe", part: "audio" })
  assert.deepEqual(parseMusicUrl("ovl-music://local/rainy-cafe?part=cover"), { shortId: "rainy-cafe", part: "cover" })
  assert.equal(parseMusicUrl("https://evil/x"), null) // wrong scheme
  assert.equal(parseMusicUrl("ovl-music://local/Bad%20Id"), null) // invalid short id
  assert.equal(parseMusicUrl("not a url"), null)
})

function catalogWithRainy() {
  return addEntry(emptyCatalog(), { id: "rainy-cafe", provider: "netease", trackId: "1", title: "Rain", cover: "" }).catalog
}

test("resolveMusicTarget resolves an audio stream via the provider", async () => {
  const registry = { async resolvePlayUrl({ trackId }) { return trackId === "1" ? { url: "https://stream/1.mp3" } : null } }
  const out = await resolveMusicTarget("ovl-music://local/rainy-cafe", { catalog: catalogWithRainy(), registry })
  assert.deepEqual(out, { ok: true, kind: "audio", streamUrl: "https://stream/1.mp3" })
})

test("resolveMusicTarget resolves cover art via trackDetail", async () => {
  const registry = {
    async resolvePlayUrl() { return { url: "x" } },
    async trackDetail() { return { cover: "https://cover/1.jpg" } },
  }
  const out = await resolveMusicTarget("ovl-music://local/rainy-cafe?part=cover", { catalog: catalogWithRainy(), registry })
  assert.deepEqual(out, { ok: true, kind: "cover", streamUrl: "https://cover/1.jpg" })
})

test("resolveMusicTarget refuses an unknown short id, an unauthorized provider, and a non-ovl-music url", async () => {
  const authed = { async resolvePlayUrl() { return { url: "https://stream/1.mp3" } } }
  // short id not in catalog
  const miss = await resolveMusicTarget("ovl-music://local/ghost", { catalog: catalogWithRainy(), registry: authed })
  assert.equal(miss.ok, false)
  assert.match(miss.reason, /not in catalog/)
  // provider returns no url (not authorized)
  const noauth = { async resolvePlayUrl() { return null } }
  const denied = await resolveMusicTarget("ovl-music://local/rainy-cafe", { catalog: catalogWithRainy(), registry: noauth })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /not authorized|no playable/i)
  // not an ovl-music url
  const bad = await resolveMusicTarget("https://x/y.mp3", { catalog: catalogWithRainy(), registry: authed })
  assert.equal(bad.ok, false)
})
