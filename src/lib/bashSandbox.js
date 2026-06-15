// OS-level sandbox for the `bash` tool. The background agent's shell runs
// confined so that even a command the heuristic denylist misses cannot:
//   - reach the network (the exfiltration vector), and
//   - write outside the workspace + tmp (the destruction vector).
// Reads stay broad (binaries, libs, project files) but with no network there is
// nothing to exfiltrate to. This mirrors the Codex CLI model (workspace-write +
// network-off), enforced by the OS, not by string matching.
//
// macOS: sandbox-exec (Seatbelt). Linux: bwrap (bubblewrap). Anywhere a sandbox
// is unavailable the call is REFUSED (fail-closed) unless the operator sets
// OPENOVEL_BASH_ALLOW_UNSANDBOXED=true to explicitly accept the risk.

import { execFile, exec } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { workspaceLayout } from "./workspacePaths.js"

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}

// Directories the sandboxed command may write to: the project root (cwd), the
// active story root, shared references, and the OS temp dir.
export function bashWritableRoots({ cwd = process.cwd(), env = process.env } = {}) {
  let layout = {}
  try { layout = workspaceLayout({ cwd, env }) } catch { /* fall back to cwd only */ }
  const roots = [cwd, layout.storyRoot, layout.sharedReferences, os.tmpdir()]
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))]
}

function onBinaryPath(name) {
  return ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/sbin", "/sbin"]
    .map((dir) => path.join(dir, name))
    .find((candidate) => existsSync(candidate))
}

// Which sandbox backend will be used for the current platform/config.
export function bashSandboxStatus({ env = process.env } = {}) {
  if (isTruthy(env.OPENOVEL_BASH_ALLOW_UNSANDBOXED)) return { mode: "unsandboxed", reason: "operator opted out via OPENOVEL_BASH_ALLOW_UNSANDBOXED" }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return { mode: "seatbelt" }
  if (process.platform === "linux" && onBinaryPath("bwrap")) return { mode: "bwrap", bwrap: onBinaryPath("bwrap") }
  return { mode: "none", reason: `no OS sandbox available on ${process.platform}` }
}

// macOS Seatbelt profile: permissive by default (so ordinary commands run), then
// the two threats are revoked: no outbound IP network (local unix sockets stay
// allowed for tooling), and no file writes outside the workspace roots.
export function seatbeltProfile(roots = []) {
  const writeRoots = roots.map((root) => `(subpath ${JSON.stringify(root)})`).join(" ")
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    "(allow network-outbound (remote unix-socket))",
    "(deny file-write*)",
    writeRoots ? `(allow file-write* ${writeRoots})` : "",
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '(allow file-write* (regex #"^/dev/fd/"))',
  ].filter(Boolean).join("\n")
}

// bwrap argv: read-only root, writable binds for the workspace roots, a private
// tmpfs /tmp, and no network namespace.
export function bwrapArgs(roots = [], { cwd } = {}) {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-net", "--die-with-parent"]
  for (const root of roots) {
    // /tmp is already a writable tmpfs; binding it again would shadow that.
    if (root === path.resolve(os.tmpdir())) continue
    if (!existsSync(root)) continue
    args.push("--bind", root, root)
  }
  if (cwd) args.push("--chdir", cwd)
  return args
}

// Turn a raw exec failure into targeted feedback the agent can act on: strip
// the sandbox-exec wrapper noise, name the command, and explain WHY when the
// signature points at a sandbox restriction (no-network or out-of-workspace
// write), a timeout, or oversized output.
function decorateBashError(err, { command, mode }) {
  const stderr = String(err?.stderr || "").trim()
  const stdout = String(err?.stdout || "").trim()
  const code = err?.code
  const timedOut = err?.killed === true || err?.signal === "SIGTERM" || /ETIMEDOUT/i.test(String(code || ""))
  const overflow = String(code || "") === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(String(err?.message || ""))

  const head = timedOut
    ? `bash command timed out: ${command}`
    : overflow
      ? `bash command produced too much output (pipe it to head/tail or write to a file): ${command}`
      : `bash command failed (exit ${code ?? "?"}): ${command}`

  const blocks = [head]
  if (stderr) blocks.push(stderr)

  if (mode !== "unsandboxed" && !timedOut && !overflow) {
    if (/not permitted/i.test(stderr)) {
      blocks.push(
        "Blocked by the OS sandbox: the bash tool may only WRITE inside the workspace "
        + "(the project root, the story dir, and tmp). Point your output at a path inside the workspace.",
      )
    } else if (!stderr) {
      // Sandbox-blocked network calls (curl/nc/etc.) exit non-zero with no message.
      blocks.push(
        "The bash sandbox has NO network access, so a command that needs the network fails here "
        + "with no error text. Use the websearch / webfetch tools for the network instead.",
      )
    }
  }
  if (stdout && !timedOut) blocks.push(`stdout:\n${stdout}`)

  const decorated = new Error(blocks.join("\n\n"))
  decorated.code = code
  decorated.stderr = stderr
  decorated.stdout = stdout
  return decorated
}

async function runDecorated(thunk, command, mode) {
  try {
    return await thunk()
  } catch (err) {
    throw decorateBashError(err, { command, mode })
  }
}

// Run a shell command inside the OS sandbox. Resolves { stdout, stderr } like
// promisified exec; throws if no sandbox is available (unless opted out). On
// failure the thrown error explains why (see decorateBashError).
export async function runBashSandboxed(command, { cwd = process.cwd(), timeout = 8000, maxBuffer = 1024 * 1024, env = process.env } = {}) {
  const status = bashSandboxStatus({ env })
  const opts = { cwd, timeout, maxBuffer }

  if (status.mode === "unsandboxed") {
    return runDecorated(() => execAsync(command, opts), command, status.mode)
  }
  if (status.mode === "seatbelt") {
    const profile = seatbeltProfile(bashWritableRoots({ cwd, env }))
    return runDecorated(() => execFileAsync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", command], opts), command, status.mode)
  }
  if (status.mode === "bwrap") {
    const args = bwrapArgs(bashWritableRoots({ cwd, env }), { cwd })
    return runDecorated(() => execFileAsync(status.bwrap, [...args, "/bin/sh", "-c", command], opts), command, status.mode)
  }
  throw new Error(
    `bash sandbox unavailable (${status.reason}); the shell command was refused. `
    + "Set OPENOVEL_BASH_ALLOW_UNSANDBOXED=true to run shell commands without a sandbox (NOT recommended).",
  )
}
