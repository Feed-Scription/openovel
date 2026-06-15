import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadFormatContract, validateFormatConfig, validateBlockTemplate, _internals } from "../src/lib/formatContract.js"

function withEnv(enabled) {
  return { OPENOVEL_ENABLE_FORMAT_CONTRACT: enabled ? "true" : "false" }
}

async function makeStory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-fmt-story-"))
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-fmt-home-"))
  process.env.OPENOVEL_STORY_ROOT = root
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  await mkdir(path.join(root, "format", "blocks"), { recursive: true })
  return root
}

const GOOD_CONFIG = JSON.stringify({
  version: 1,
  theme: { "--paper": "#0a0a0a", "--ink": "#e0e0e0", "--evil": "boom" },
  css: ["story/format/blocks.css"],
})

test("validateBlockTemplate: kind from filename stem, sanitized HAST, parse inferred", () => {
  const r = validateBlockTemplate("terminal.html", '<div class="screen"><pre style="font-family:monospace">{{body}}</pre></div>')
  assert.equal(r.kind, "terminal")
  assert.deepEqual(r.issues, [])
  assert.equal(r.parse, "raw") // only {{body}} → raw
  assert.equal(r.tree.type, "root")
  const div = r.tree.children.find((n) => n.type === "element")
  assert.equal(div.tagName, "div")
  assert.deepEqual(div.properties.className, ["screen"])
  const pre = div.children.find((n) => n.type === "element")
  // the {{body}} placeholder survives as plain text for the renderer to fill
  assert.ok(pre.children.some((n) => n.type === "text" && n.value.includes("{{body}}")))
  // a named slot → keyvalue
  assert.equal(validateBlockTemplate("panel.html", "<div><span>{{hp}}</span></div>").parse, "keyvalue")
})

test("validateBlockTemplate: bad/cased/reserved kinds and non-html extensions are flagged", () => {
  assert.ok(validateBlockTemplate("MyBlock.html", "<div>x</div>").issues.some((i) => /lowercase-kebab/.test(i)))
  assert.ok(validateBlockTemplate("bg.html", "<div>x</div>").issues.some((i) => /RESERVED/.test(i)))
  assert.ok(validateBlockTemplate("notes.md", "x").issues.some((i) => /\.html extension/.test(i)))
})

test("validateBlockTemplate: illegal HTML produces specific issues; all-illegal is empty", () => {
  const r = validateBlockTemplate("danger.html", '<div onclick="e()"><iframe src="http://x"></iframe><span style="position:fixed">{{body}}</span></div>')
  assert.ok(r.issues.some((i) => /onclick/.test(i)))
  assert.ok(r.issues.some((i) => /<iframe>/.test(i)))
  assert.ok(r.issues.some((i) => /position/.test(i)))
  const empty = validateBlockTemplate("empty.html", "<script>boom()</script>")
  assert.equal(empty.empty, true)
  assert.ok(empty.issues.some((i) => /no renderable HTML/.test(i)))
})

test("validateFormatConfig: object parses; blocks/template fields flagged as ignored; theme intersected", () => {
  const r = validateFormatConfig(JSON.stringify({ version: 2, blocks: [], theme: { "--ink": "#111", "--evil": "x" }, css: ["../../etc/passwd", "story/format/ok.css"] }))
  assert.equal(r.ok, true)
  assert.equal(r.config.version, 2)
  assert.equal(r.config.theme["--ink"], "#111")
  assert.equal(r.config.theme["--evil"], undefined)
  assert.ok(r.issues.some((i) => /`blocks` field, it is IGNORED/.test(i)))
  assert.ok(r.issues.some((i) => /unsafe css path/.test(i)))
  // empty text is a valid (absent) config; garbage is not
  assert.equal(validateFormatConfig("").ok, true)
  assert.equal(validateFormatConfig("# not json").ok, false)
})

test("validateFormatConfig: reservedChannels hud/include load for plain-blocks archives", () => {
  const r = validateFormatConfig(JSON.stringify({
    version: 1,
    mode: "plain-blocks",
    reservedChannels: {
      hud: {
        slots: [
          { id: "time_place", label: "时间/地点" },
          { id: "pressure", label: "当前压力", kind: "badge" },
        ],
      },
      include: { enabled: true, allow: ["image"] },
    },
  }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.hud.slots, [
    { id: "time_place", label: "时间/地点", kind: "text" },
    { id: "pressure", label: "当前压力", kind: "badge" },
  ])
  assert.deepEqual(r.config.include, { enabled: true, allow: ["image"] })
})

test("loadFormatContract: flag OFF → {enabled:false} even with files present", async () => {
  await makeStory()
  const r = await loadFormatContract({ env: withEnv(false) })
  assert.equal(r.enabled, false)
})

test("loadFormatContract: flag ON but no files → {enabled:false}", async () => {
  await makeStory()
  const r = await loadFormatContract({ env: withEnv(true) })
  assert.equal(r.enabled, false)
})

test("loadFormatContract: full file-based load — blocks from blocks/*.html, theme + sanitized css from config.json", async () => {
  const root = await makeStory()
  await writeFile(path.join(root, "format", "config.json"), GOOD_CONFIG)
  await writeFile(path.join(root, "format", "blocks", "terminal.html"), '<div class="screen"><pre>{{body}}</pre></div>')
  await writeFile(path.join(root, "format", "blocks", "status.html"), "<div><span>{{hp}}</span></div>")
  await writeFile(path.join(root, "format", "blocks", "bg.html"), "<div>reserved, dropped</div>")
  await writeFile(path.join(root, "format", "blocks.css"), ".screen { color: #0f0; position: fixed; background: url('http://evil') }")
  const r = await loadFormatContract({ env: withEnv(true) })
  assert.equal(r.enabled, true)
  assert.deepEqual(r.blocks.map((b) => b.kind).sort(), ["status", "terminal"])
  const terminal = r.blocks.find((b) => b.kind === "terminal")
  assert.equal(terminal.class, "ovl-terminal")
  assert.equal(terminal.parse, "raw")
  assert.equal(r.blocks.find((b) => b.kind === "status").parse, "keyvalue")
  // reserved bg.html dropped with a notice
  assert.ok(r.issues.some((i) => /RESERVED/.test(i)))
  // theme allowlist intersect drops --evil
  assert.equal(r.theme["--paper"], "#0a0a0a")
  assert.equal(r.theme["--evil"], undefined)
  // css scoped + dangerous props stripped
  assert.match(r.css, /\.ovl-rich \.screen/)
  assert.match(r.css, /color: #0f0/)
  assert.doesNotMatch(r.css, /position|url\(/)
  assert.ok(Object.isFrozen(r))
})

test("loadFormatContract: legacy CONTRACT.md is NOT read (hard cutover)", async () => {
  const root = await makeStory()
  await writeFile(path.join(root, "format", "CONTRACT.md"), '```json\n{ "version": 1 }\n```\n```ovl:old\n<div>{{body}}</div>\n```\n')
  const r = await loadFormatContract({ env: withEnv(true) })
  assert.equal(r.enabled, false) // markdown contract contributes nothing
})

test("loadFormatContract: blocks-only contract (no config.json) is valid", async () => {
  const root = await makeStory()
  await writeFile(path.join(root, "format", "blocks", "note.html"), '<p style="color:#333">{{body}}</p>')
  const r = await loadFormatContract({ env: withEnv(true) })
  assert.equal(r.enabled, true)
  assert.equal(r.blocks.length, 1)
})

test("image-background toggle forces format-contract + includes; flag broadcast without contract files", async () => {
  await makeStory()
  const { isImageBackgroundEnabled, isFormatContractEnabled, isStoryIncludesEnabled } = await import("../src/lib/formatContract.js")
  const env = { OPENOVEL_ENABLE_IMAGE_BACKGROUND: "true" }
  assert.equal(isImageBackgroundEnabled(env), true)
  assert.equal(isFormatContractEnabled(env), true)
  assert.equal(isStoryIncludesEnabled(env), true)
  assert.equal(isImageBackgroundEnabled({}), false)
  // no contract files on disk: the channel still activates
  const r = await loadFormatContract({ env })
  assert.equal(r.enabled, true)
  assert.equal(r.imageBackground, true)
  // plain format-contract-only env: flag false
  const r2 = await loadFormatContract({ env: withEnv(true) })
  assert.equal(r2.imageBackground ?? false, false)
})

test("_internals expose the reserved-kind set and parse inference", () => {
  assert.ok(_internals.RESERVED_KINDS.has("bg"))
  assert.ok(_internals.RESERVED_KINDS.has("hud"))
  assert.equal(_internals.inferParseMode("<p>{{body}}</p>"), "raw")
  assert.equal(_internals.inferParseMode("<p>{{hp}}</p>"), "keyvalue")
})
