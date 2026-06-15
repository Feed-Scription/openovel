import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import { createStorykeeperAgent } from "../src/workflows/storykeeperWorkflow.js"
import {
  appendStorykeeperThreadMessages,
  loadStorykeeperThread,
  maybeCompactStorykeeperThread,
  readStorykeeperThreadEvents,
} from "../src/runtime/storykeeperThread.js"

async function isolatedEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-storykeeper-thread-"))
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
    OPENOVEL_DISABLE_STORYKEEPER_THREAD_MODEL_SUMMARY: process.env.OPENOVEL_DISABLE_STORYKEEPER_THREAD_MODEL_SUMMARY,
  }
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  process.env.OPENOVEL_DISABLE_STORYKEEPER_THREAD_MODEL_SUMMARY = "1"
  await initializeStory()
  return {
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test("Storykeeper initial messages include persisted thread before current environment context", async () => {
  const env = await isolatedEnv()
  try {
    await appendStorykeeperThreadMessages([
      { role: "user", content: "previous environment" },
      { role: "assistant", content: "{\"summary\":\"previous decision\"}" },
    ])
    const prepared = await createStorykeeperAgent().buildInitialMessages({
      input: { turnId: "turn_now", action: "look", foreground: { narration: "n" }, backgroundSignal: {} },
      registry: { manifest: () => [] },
    })
    assert.equal(prepared.messages[0].role, "system")
    assert.equal(prepared.messages[1].content, "previous environment")
    assert.match(prepared.messages.at(-1).content, /Storykeeper Turn Context/)
    assert.equal(prepared.context.residentThreadMessages, 2)
    assert.equal(prepared.context.residentThreadAppendStart, 3)
  } finally {
    env.restore()
  }
})

test("Storykeeper thread compaction writes a boundary, summary, rehydration, and preserved recent messages", async () => {
  const env = await isolatedEnv()
  try {
    await mkdir(path.join(paths.root, "state"), { recursive: true })
    await writeFile(path.join(paths.root, "state", "stats.json"), "{\"trust\":1}\n", "utf8")
    for (let i = 0; i < 12; i++) {
      await appendStorykeeperThreadMessages([
        { role: "user", content: `context ${i} ${"x".repeat(300)}` },
        { role: "assistant", content: `decision ${i}` },
      ])
    }
    const result = await maybeCompactStorykeeperThread({
      maxChars: 1200,
      keepMessages: 4,
      turnId: "turn_compact",
    })
    assert.equal(result.compacted, true)
    const events = await readStorykeeperThreadEvents()
    assert.ok(events.some((event) => event.event === "storykeeper_compact_boundary"))

    const thread = await loadStorykeeperThread()
    assert.match(thread.messages[0].content, /storykeeper_thread_summary/)
    assert.match(thread.messages[1].content, /storykeeper_post_compact_rehydration/)
    assert.match(thread.messages[1].content, /story\/state\/stats\.json/)
    assert.equal(thread.messages.length, 6)
    assert.match(thread.messages.at(-1).content, /decision 11/)
    assert.equal(result.rehydrated, true)
  } finally {
    env.restore()
  }
})

test("Storykeeper handleResult appends current context and assistant result to thread", async () => {
  const env = await isolatedEnv()
  try {
    const agent = createStorykeeperAgent()
    const raw = {
      content: JSON.stringify({
        status: "skipped",
        summary: "no changes",
        filesChanged: [],
        inboxResolved: [],
        inboxNotes: [],
      }),
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "current environment" },
        { role: "assistant", content: "{\"summary\":\"no changes\"}" },
      ],
      steps: 1,
    }
    await agent.handleResult({
      input: { turnId: "turn_append", action: "wait", foreground: {} },
      context: {
        snapshot: { foregroundGuidance: "", backgroundInboxItems: [] },
        context: { storykeeperThreadAppendStart: 1 },
      },
      raw,
    })
    const thread = await loadStorykeeperThread()
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"])
    assert.equal(thread.messages[0].content, "current environment")
  } finally {
    env.restore()
  }
})

test("loadStorykeeperThread drops orphan tool prefix when tail-trim severs tool_calls linkage", async () => {
  // Reproducer for the DeepSeek 400 "Messages with role 'tool' must be a
  // response to a preceding message with 'tool_calls'" failure mode: tail
  // trim keeps `tool` messages whose corresponding assistant.tool_calls
  // assistant has been dropped to fit the maxChars budget.
  const env = await isolatedEnv()
  try {
    // Write a thread where the head of the kept slice (under tight maxChars)
    // would otherwise be an orphan tool result. Each message must be small
    // enough that the trim cap can cut between them.
    await appendStorykeeperThreadMessages(
      [
        { role: "user", content: "early u" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_A", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_A", content: "tool A result" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_B", type: "function", function: { name: "write", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_B", content: "tool B result" },
        { role: "assistant", content: "done" },
      ],
      { turnId: "turn_orphan_test", source: "test" },
    )
    // maxChars small enough to evict the head (early-u + first assistant +
    // first tool) so the tail starts at the SECOND tool. The exact value is
    // computed from the appended message JSON sizes — sample a few each
    // ~120 bytes; cap at 350 chars to force the trim boundary mid-stream.
    const thread = await loadStorykeeperThread({ maxMessages: 120, maxChars: 350 })
    const roles = thread.messages.map((m) => m.role)
    assert.ok(!roles.includes("tool") || roles[0] !== "tool",
      `kept slice must not start with a tool message; got ${JSON.stringify(roles)}`)
    // Any retained tool should have its call_id resolved to an earlier
    // assistant.tool_calls entry IN THE SAME slice.
    const calledIds = new Set()
    for (const msg of thread.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const c of msg.tool_calls) if (c?.id) calledIds.add(c.id)
      }
      if (msg.role === "tool" && msg.tool_call_id) {
        assert.ok(calledIds.has(msg.tool_call_id),
          `tool ${msg.tool_call_id} has no preceding assistant.tool_calls in slice ${JSON.stringify(roles)}`)
      }
    }
  } finally {
    env.restore()
  }
})

test("maybeCompactStorykeeperThread keeps slice headed by a valid prefix boundary", async () => {
  // Same defect class as trimMessages but in compaction: messages.slice(-N)
  // can land between an assistant.tool_calls and its tool result, leaving
  // the kept tail headed by orphan tools. DeepSeek 400s on that shape, and
  // the compacted thread is what every subsequent storykeeper turn loads.
  const env = await isolatedEnv()
  try {
    // Build a thread with the orphan-tool boundary baked in. We need
    // enough total chars to trip the compact threshold AND a keepMessages
    // small enough that the slice boundary cuts between assistant and
    // tool. The structure here has 30+ messages; with keepMessages=4 the
    // last 4 land on [tool, tool, assistant, assistant_final] — the head
    // tool's preceding assistant.tool_calls is in the summarized section.
    const padding = []
    for (let i = 0; i < 20; i++) {
      padding.push({ role: "user", content: `padding ${i} ${"x".repeat(2000)}` })
    }
    await appendStorykeeperThreadMessages(
      [
        ...padding,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_X", type: "function", function: { name: "edit", arguments: "{}" } },
            { id: "call_Y", type: "function", function: { name: "edit", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_X", content: "tool X result" },
        { role: "tool", tool_call_id: "call_Y", content: "tool Y result" },
        { role: "assistant", content: "final" },
      ],
      { turnId: "turn_compact_test", source: "test" },
    )
    // Force the compact: maxChars below the padded total so it triggers,
    // keepMessages small enough to land the boundary mid-pair.
    await maybeCompactStorykeeperThread({
      turnId: "turn_compact_test",
      maxChars: 1000,
      keepMessages: 3,
    })
    // After compact, the thread should reload to: [summary, rehydration,
    // ...keep] — the keep slice must NOT start with an orphan tool.
    const thread = await loadStorykeeperThread({ maxMessages: 999, maxChars: 9_999_999 })
    const roles = thread.messages.map((m) => m.role)
    // The first messages are the compaction header (summary + rehydration),
    // both `user`. Find the first non-user/non-system after them and
    // verify it isn't an orphan tool.
    for (let i = 0; i < thread.messages.length; i++) {
      const m = thread.messages[i]
      if (m.role === "user" || m.role === "system") continue
      // Any tool encountered must have its tool_call_id introduced by an
      // assistant.tool_calls earlier in the thread.
      const calledIds = new Set()
      for (let j = 0; j < i; j++) {
        const prev = thread.messages[j]
        if (prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
          for (const c of prev.tool_calls) if (c?.id) calledIds.add(c.id)
        }
      }
      if (m.role === "tool") {
        assert.ok(calledIds.has(m.tool_call_id),
          `compacted thread has orphan tool at index ${i} (id=${m.tool_call_id}); roles=${JSON.stringify(roles)}`)
      }
    }
  } finally {
    env.restore()
  }
})

test("loadStorykeeperThread drops leading assistant with unresolved tool_calls", async () => {
  // The mirror case: trim keeps an assistant whose tool_calls reference a
  // call_id that has no matching tool message in the kept slice (the tool
  // result was beyond the budget). The chat API would also reject that
  // shape on the next turn.
  const env = await isolatedEnv()
  try {
    await appendStorykeeperThreadMessages(
      [
        { role: "user", content: "u early padding text to inflate" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_lost", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        // Note: NO tool message for call_lost — simulating the case where
        // the assistant lands in the kept slice but the matching tool got
        // trimmed away on the far side. (Or, equivalently, was never
        // emitted because the run aborted.)
        { role: "assistant", content: "fallback" },
        { role: "user", content: "newer u" },
      ],
      { turnId: "turn_unresolved", source: "test" },
    )
    const thread = await loadStorykeeperThread({ maxMessages: 120, maxChars: 600 })
    const head = thread.messages[0]
    if (head?.role === "assistant" && Array.isArray(head.tool_calls) && head.tool_calls.length) {
      const calledIds = head.tool_calls.map((c) => c?.id).filter(Boolean)
      const resolved = new Set()
      for (let i = 1; i < thread.messages.length; i++) {
        const next = thread.messages[i]
        if (next?.role === "tool" && next.tool_call_id) resolved.add(next.tool_call_id)
      }
      assert.ok(calledIds.every((id) => resolved.has(id)),
        `leading assistant has unresolved tool_calls in slice; roles=${JSON.stringify(thread.messages.map((m) => m.role))}`)
    }
  } finally {
    env.restore()
  }
})
