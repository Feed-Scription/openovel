import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { appendText, readTailText, readText } from "../src/lib/files.js"

async function newTempFile(name = "tail.txt") {
  const dir = await mkdtemp(path.join(tmpdir(), "openovel-files-"))
  return path.join(dir, name)
}

test("readTailText returns full file when size <= maxBytes", async () => {
  const file = await newTempFile()
  await writeFile(file, "hello world", "utf8")
  const tail = await readTailText(file, 64, "fallback")
  assert.equal(tail, "hello world")
})

test("readTailText returns only the trailing N bytes for large files", async () => {
  const file = await newTempFile()
  const body = "0123456789".repeat(1000) // 10000 bytes
  await writeFile(file, body, "utf8")
  const tail = await readTailText(file, 50, "fallback")
  assert.equal(tail.length, 50)
  assert.equal(tail, "0123456789".repeat(5))
})

test("readTailText handles utf-8 continuation bytes at boundary", async () => {
  // CJK characters are 3 bytes in utf-8. If the slice cuts mid-character,
  // the bytes 0x80-0xBF (continuation) at the start must be trimmed so the
  // returned string is valid utf-8.
  const file = await newTempFile()
  const body = "abc" + "中".repeat(1000) // each 中 = 3 bytes
  await writeFile(file, body, "utf8")
  const tail = await readTailText(file, 100, "")
  // Verify we didn't return a malformed string (no replacement chars from
  // the boundary slice — the trim trims them all)
  assert.ok(!tail.includes("�"), "no replacement chars from torn utf-8")
  // And the tail content matches a valid suffix of the original
  assert.ok(body.endsWith(tail), "tail is a valid suffix")
})

test("readTailText returns fallback for missing file", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "openovel-files-")), "missing.txt")
  const tail = await readTailText(file, 32, "fallback")
  assert.equal(tail, "fallback")
})

test("appendText creates the file and writes value", async () => {
  const file = await newTempFile()
  await appendText(file, "first\n")
  assert.equal(await readText(file), "first\n")
})

test("appendText is O(1) (does not read existing content)", async () => {
  const file = await newTempFile()
  await writeFile(file, "X".repeat(1000000), "utf8")
  // appendText should not need to read this 1MB; just verify it appends
  // without errors and the result is correct length.
  await appendText(file, "Y")
  const result = await readText(file)
  assert.equal(result.length, 1000001)
  assert.equal(result[1000000], "Y")
})
