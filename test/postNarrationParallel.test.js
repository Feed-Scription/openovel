import assert from "node:assert/strict"
import test from "node:test"

import { PostNarrationParallelRegistry } from "../src/runtime/postNarrationParallel.js"

test("PostNarrationParallelRegistry fires narration-dependent producers concurrently", async () => {
  const reg = new PostNarrationParallelRegistry()
  const order = []
  reg.register({
    id: "options",
    run: async ({ narration }) => {
      order.push(`options:${narration}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { options: ["open"], tension: "test" }
    },
  })
  reg.register({
    id: "contextCards",
    run: async ({ narration }) => {
      order.push(`cards:${narration}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { insert: ["door-card"] }
    },
  })

  const results = reg.fireAll({ action: "x", narration: "The door opens.", ablations: {} })
  const [options, cards] = await Promise.all([results.get("options"), results.get("contextCards")])

  assert.deepEqual(options.options, ["open"])
  assert.deepEqual(cards.insert, ["door-card"])
  assert.deepEqual(order.slice(0, 2).sort(), ["cards:The door opens.", "options:The door opens."])
})

test("PostNarrationParallelRegistry supports disabled fallbacks", async () => {
  const reg = new PostNarrationParallelRegistry()
  let ran = false
  reg.register({
    id: "options",
    isDisabled: ({ optionsEnabled }) => !optionsEnabled,
    run: async () => {
      ran = true
      return { options: ["x"] }
    },
    fallback: ({ disabled }) => ({ options: [], disabled }),
  })

  const results = reg.fireAll({ optionsEnabled: false })
  assert.deepEqual(await results.get("options"), { options: [], disabled: true })
  assert.equal(ran, false)
})
