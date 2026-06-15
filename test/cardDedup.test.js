import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Regression for duplicate cards: one entity got two slug variants with
// overlapping triggers.
// findConflictingCards (wired into the card write-validation) must catch a new
// slug that duplicates an existing entity.
async function seedCard(dir, slug, frontmatter, body = "x") {
  await mkdir(path.join(dir, slug), { recursive: true })
  await writeFile(path.join(dir, slug, "CARD.md"), `---\n${frontmatter}\n---\n\n${body}\n`)
}

test("findConflictingCards flags a second slug for the same entity (overlapping triggers)", async () => {
  const root = path.join(os.tmpdir(), `carddedup-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  const cardsDir = path.join(root, "context-cards")
  const { findConflictingCards } = await import("../src/context/foregroundInserts.js")

  await seedCard(cardsDir, "chen-zhen-hua", "name: 陈振华\nkind: character\ndescription: 朱仝的导师\ntriggers:\n  - 陈振华\n  - 老陈\n  - 陈老师\n  - 导师")
  await seedCard(cardsDir, "yi-fei", "name: 一飞\nkind: character\ndescription: 同行者\ntriggers:\n  - 一飞\n  - 伊菲")

  // A new slug for the SAME entity (different transliteration), overlapping triggers.
  const dup = "---\nname: 陈振华（老陈）\nkind: character\ndescription: 博导\ntriggers:\n  - 老陈\n  - 陈振华\n  - 福建人\n---\n\n老陈。\n"
  const conflicts = await findConflictingCards({ slug: "chen-zhenhua", content: dup })
  assert.equal(conflicts.length, 1, "one conflicting card")
  assert.equal(conflicts[0].slug, "chen-zhen-hua")
  assert.ok(conflicts[0].sharedTriggers.includes("老陈"))
  assert.ok(conflicts[0].sharedTriggers.includes("陈振华"))

  // Editing the SAME slug is never a conflict.
  assert.deepEqual(await findConflictingCards({ slug: "chen-zhen-hua", content: dup }), [])

  // A genuinely distinct entity (no name/trigger overlap) → no conflict.
  const distinct = "---\nname: 洁依\ntriggers:\n  - 洁依\n  - 小依\n---\n\n洁依。\n"
  assert.deepEqual(await findConflictingCards({ slug: "jie-yi", content: distinct }), [])
})

test("findConflictingCards flags an exact name match even without shared triggers", async () => {
  const root = path.join(os.tmpdir(), `carddedup-name-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  const cardsDir = path.join(root, "context-cards")
  const { findConflictingCards } = await import("../src/context/foregroundInserts.js")
  await seedCard(cardsDir, "the-inn", "name: 山间客栈\nkind: location\ntriggers:\n  - 客栈\n  - 山间客栈")
  const dup = "---\nname: 山间客栈\nkind: location\ntriggers:\n  - 旅舍\n---\n\nx\n"
  const conflicts = await findConflictingCards({ slug: "mountain-inn", content: dup })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].nameMatch, true)
})
