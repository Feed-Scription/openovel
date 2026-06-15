import test from "node:test"
import assert from "node:assert/strict"

import {
  buildDefaultForegroundTemplate,
  parseForegroundGuidance,
  sectionSchema,
} from "../src/lib/foregroundCompose.js"

// The rich-rendering usage guidance (which ovl:<kind> blocks to emit, and when)
// must live in its own positively-framed section — NOT in Forbidden / Avoid,
// where the narrator reads it as a ban and falls back to plain ``` fences.

test("rich-rendering is a recognized section, distinct from forbidden", () => {
  const schema = sectionSchema()
  const rr = schema.find((s) => s.id === "rich-rendering")
  assert.ok(rr, "rich-rendering section is registered")
  assert.equal(rr.filename, "rich-rendering.md")
  assert.equal(rr.heading, "Rich Rendering")
  // It is NOT the forbidden section.
  assert.notEqual(rr.heading, "Forbidden / Avoid")
})

test("default template OMITS the optional rich-rendering @include (plain stories stay clean)", () => {
  const tpl = buildDefaultForegroundTemplate()
  assert.doesNotMatch(tpl, /@include story\/frontend\/rich-rendering\.md/)
  // but the schema header still advertises it as an available heading
  assert.match(tpl, /## Rich Rendering/)
  // sanity: the normal sections ARE included (unprefixed filenames)
  assert.match(tpl, /@include story\/frontend\/tone\.md/)
  assert.match(tpl, /@include story\/frontend\/forbidden\.md/)
  // and the card manifests are appended
  assert.match(tpl, /@include story\/guidance\/cards\.md/)
  assert.match(tpl, /@include story\/guidance\/cards\.auto\.md/)
})

test("parser buckets '## Rich Rendering' content into rich-rendering, not the preceding section", () => {
  const md = [
    "# Foreground Guidance",
    "",
    "## Tone",
    "Spare, fast.",
    "",
    "## Rich Rendering",
    "Emit the contract's rich block where the scene calls for it.",
    "",
    "## Forbidden / Avoid",
    "No purple prose.",
  ].join("\n")
  const out = parseForegroundGuidance(md)
  assert.equal(out.tone, "Spare, fast.")
  assert.equal(out["rich-rendering"], "Emit the contract's rich block where the scene calls for it.")
  assert.equal(out.forbidden, "No purple prose.")
  // The heading is recognized → not flagged as an unknown/invented section.
  assert.ok(!out.__unknownHeadings.includes("Rich Rendering"))
})
