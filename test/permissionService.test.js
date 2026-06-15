import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory, paths } from "../src/lib/storyStore.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"
import {
  listPermissionRequests,
  resolvePermissionRequest,
  PermissionRequiredError,
} from "../src/runtime/permissionService.js"
import { PermissionDeniedError } from "../src/runtime/permissionPolicy.js"

async function isolatedEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openovel-permission-service-"))
  const saved = {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
    OPENOVEL_ENABLE_BASH_TOOL: process.env.OPENOVEL_ENABLE_BASH_TOOL,
  }
  process.env.OPENOVEL_HOME = path.join(root, "home")
  process.env.OPENOVEL_STORY_ROOT = path.join(root, "story")
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  delete process.env.OPENOVEL_ENABLE_BASH_TOOL
  await initializeStory()
  return {
    root,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test("PermissionService allows normal story-scoped writes", async () => {
  const env = await isolatedEnv()
  try {
    const registry = new ToolRegistry()
    registry.register({
      id: "write",
      destructive: true,
      async execute() {
        return "ok"
      },
    })
    const result = await registry.execute("write", { filePath: path.join(paths.root, "canon", "ok.md") })
    assert.equal(result.output, "ok")
    assert.deepEqual(await listPermissionRequests({ status: "pending" }), [])
  } finally {
    env.restore()
  }
})

test("PermissionService denies an outside-workspace mutation outright (no approval prompt)", async () => {
  const env = await isolatedEnv()
  try {
    let calls = 0
    const registry = new ToolRegistry()
    registry.register({
      id: "write",
      destructive: true,
      async execute() {
        calls++
        return "ok"
      },
    })
    const outside = path.join(os.tmpdir(), `openovel-outside-${Date.now()}.md`)
    await assert.rejects(
      () => registry.execute("write", { filePath: outside }),
      (error) => error instanceof PermissionDeniedError && /outside trusted roots is refused/.test(error.message),
    )
    assert.equal(calls, 0)
    // Dangerous ops are refused, not queued for approval.
    assert.deepEqual(await listPermissionRequests({ status: "pending" }), [])
  } finally {
    env.restore()
  }
})

test("PermissionService still supports an explicit ask rule via the permission ledger", async () => {
  const env = await isolatedEnv()
  try {
    let calls = 0
    const registry = new ToolRegistry()
    registry.register({
      id: "write",
      destructive: true,
      async execute() {
        calls++
        return "ok"
      },
    })
    // An in-workspace write is normally allowed; an explicit ask rule routes it
    // through the approval ledger (the feature stays reachable on demand).
    const target = path.join(paths.root, "canon", "ask.md")
    const context = { permissionRules: [{ permission: "write", pattern: "*", action: "ask" }] }
    await assert.rejects(
      () => registry.execute("write", { filePath: target }, context),
      (error) => error instanceof PermissionRequiredError && error.code === "OPENOVEL_PERMISSION_REQUIRED",
    )
    assert.equal(calls, 0)
    const [pending] = await listPermissionRequests({ status: "pending" })
    await resolvePermissionRequest(pending.requestId, "approved")
    const result = await registry.execute("write", { filePath: target }, context)
    assert.equal(result.output, "ok")
    assert.equal(calls, 1)
  } finally {
    env.restore()
  }
})

test("PermissionService gates bash on enablement, allows ordinary commands (sandboxed), refuses only catastrophic", async () => {
  const env = await isolatedEnv()
  try {
    const registry = new ToolRegistry()
    registry.register({
      id: "bash",
      dangerous: true,
      destructive: true,
      async execute() {
        return "ok"
      },
    })

    await assert.rejects(() => registry.execute("bash", { command: "date" }), /Bash is disabled/)
    process.env.OPENOVEL_ENABLE_BASH_TOOL = "true"
    assert.equal((await registry.execute("bash", { command: "date" })).output, "ok")
    // Ordinary mutating commands run (the OS sandbox confines them to the
    // workspace), no approval prompt.
    assert.equal((await registry.execute("bash", { command: "jq '.x += 1' story/state/world.json" })).output, "ok")
    assert.equal((await registry.execute("bash", { command: "rm story/canon/x.md" })).output, "ok")
    // Only obviously-catastrophic system commands are refused outright.
    await assert.rejects(() => registry.execute("bash", { command: "rm -rf /" }), /Catastrophic shell command/)
    await assert.rejects(() => registry.execute("bash", { command: "mkfs.ext4 /dev/sda" }), /Catastrophic shell command/)
  } finally {
    env.restore()
  }
})
