import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  PermissionDeniedError,
  assertToolPermission,
  resolveToolPermission,
} from "../src/runtime/permissionPolicy.js"
import { backgroundJobs } from "../src/runtime/backgroundJob.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"

test("permission policy allows built-in story-scoped read/write tools by default", () => {
  const read = resolveToolPermission({
    tool: { id: "read", readOnly: true },
    input: { filePath: "canon/notes.md" },
    env: {},
  })
  assert.equal(read.action, "allow")
  assert.ok(read.patterns.includes("story/canon/notes.md"))

  const write = resolveToolPermission({
    tool: { id: "write", destructive: true },
    input: { filePath: "canon/notes.md" },
    env: {},
  })
  assert.equal(write.action, "allow")
})

test("permission policy allows bash by default, denies only when explicitly disabled", () => {
  // Default ON: bash is a standard (OS-sandboxed) background tool.
  const byDefault = resolveToolPermission({
    tool: { id: "bash", dangerous: true },
    input: { command: "date" },
    env: {},
  })
  assert.equal(byDefault.action, "allow")

  // Explicit opt-out still disables it.
  const disabled = resolveToolPermission({
    tool: { id: "bash", dangerous: true },
    input: { command: "date" },
    env: { OPENOVEL_ENABLE_BASH_TOOL: "false" },
  })
  assert.equal(disabled.action, "deny")
  assert.match(disabled.reason, /disabled by configuration/)
})

test("permission rules override defaults with allow ask deny semantics", async () => {
  const env = {
    OPENOVEL_TOOL_PERMISSION_RULES: JSON.stringify([
      { permission: "webfetch", pattern: "blocked.example", action: "deny", reason: "blocked host" },
    ]),
  }
  const decision = resolveToolPermission({
    tool: { id: "webfetch", readOnly: true },
    input: { url: "https://blocked.example/page" },
    env,
  })
  assert.equal(decision.action, "deny")
  assert.equal(decision.matchedPattern, "blocked.example")

  await assert.rejects(
    () =>
      assertToolPermission({
        tool: { id: "webfetch", readOnly: true },
        input: { url: "https://blocked.example/page" },
        env,
      }),
    PermissionDeniedError,
  )
})

test("ask decisions can be approved by a generic handler", async () => {
  const decision = await assertToolPermission({
    tool: { id: "custom_mutator", destructive: true },
    input: { path: "x" },
    env: {},
    context: {
      async askPermission(request) {
        assert.equal(request.action, "ask")
        assert.equal(request.permission, "custom_mutator")
        return { action: "allow" }
      },
    },
  })
  assert.equal(decision.action, "allow")
  assert.equal(decision.approvedByHandler, true)
})

test("tool registry records permission decisions to the job ledger when bound", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openovel-permissions-"))
  const ledger = path.join(dir, "jobs.jsonl")
  await backgroundJobs.bindLedger({ path: ledger })

  const registry = new ToolRegistry()
  registry.register({
    id: "sample_read",
    readOnly: true,
    async execute() {
      return "ok"
    },
  })

  const result = await registry.execute("sample_read", { path: "story/INDEX.md" }, { workflow: "unit", turnId: "t-1" })
  assert.equal(result.output, "ok")

  const events = await backgroundJobs.readLedger()
  const audit = events.find((event) => event.event === "tool_permission" && event.tool === "sample_read")
  assert.equal(audit.action, "allow")
  assert.equal(audit.workflow, "unit")

  const jobs = await backgroundJobs.listFromLedger({ limit: 10 })
  assert.equal(jobs.some((job) => job.id === audit.id), false, "audit events should not appear as jobs")
})
