import assert from "node:assert/strict"
import test from "node:test"

import {
  bashWritableRoots,
  seatbeltProfile,
  bwrapArgs,
  bashSandboxStatus,
  runBashSandboxed,
} from "../src/lib/bashSandbox.js"

test("seatbelt profile denies network + out-of-workspace writes, allows the workspace roots", () => {
  const profile = seatbeltProfile(["/tmp/ws", "/tmp/story"])
  assert.match(profile, /\(deny network-outbound\)/)
  assert.match(profile, /\(deny file-write\*\)/)
  assert.match(profile, /subpath "\/tmp\/ws"/)
  assert.match(profile, /subpath "\/tmp\/story"/)
})

test("bwrap args unshare the network, tmpfs /tmp, and bind an existing workspace root", () => {
  const dir = process.cwd()
  const args = bwrapArgs([dir], { cwd: dir })
  assert.ok(args.includes("--unshare-net"))
  assert.ok(args.includes("--tmpfs"))
  const bindIdx = args.indexOf("--bind")
  assert.ok(bindIdx >= 0)
  assert.equal(args[bindIdx + 1], dir)
})

test("bashWritableRoots includes cwd", () => {
  const roots = bashWritableRoots({ cwd: process.cwd(), env: {} })
  assert.ok(roots.includes(process.cwd()))
})

test("status reports unsandboxed only when the operator opts out", () => {
  assert.equal(bashSandboxStatus({ env: { OPENOVEL_BASH_ALLOW_UNSANDBOXED: "true" } }).mode, "unsandboxed")
})

// Live containment check. macOS only (Seatbelt); skipped elsewhere so the suite
// stays portable. Confirms ordinary commands run but the two threats are blocked.
test("seatbelt sandbox runs normal commands but blocks network and out-of-workspace writes", {
  skip: process.platform !== "darwin" ? "Seatbelt sandbox is macOS-only" : false,
}, async () => {
  const cwd = process.cwd()
  const { stdout } = await runBashSandboxed("echo sbx-ok", { cwd, timeout: 6000 })
  assert.match(stdout, /sbx-ok/)

  // Out-of-workspace write: blocked, and the failure says WHY (workspace-only
  // writes) without leaking the sandbox-exec wrapper.
  await assert.rejects(
    () => runBashSandboxed("echo x > \"$HOME/.openovel_sbx_should_fail\"", { cwd, timeout: 6000 }),
    (error) => {
      assert.doesNotMatch(error.message, /sandbox-exec/)
      assert.match(error.message, /only WRITE inside the workspace/)
      return true
    },
  )

  // Network: blocked, and the failure names the no-network cause + the alternative.
  await assert.rejects(
    () => runBashSandboxed("curl -s -m 4 https://example.com -o /dev/null", { cwd, timeout: 8000 }),
    (error) => {
      assert.match(error.message, /NO network access/)
      assert.match(error.message, /websearch|webfetch/)
      return true
    },
  )

  // A plain command error surfaces its own stderr (no misleading sandbox hint).
  await assert.rejects(
    () => runBashSandboxed("ls /nonexistent_path_xyz", { cwd, timeout: 6000 }),
    (error) => {
      assert.match(error.message, /No such file or directory/)
      assert.doesNotMatch(error.message, /NO network access/)
      return true
    },
  )
})
