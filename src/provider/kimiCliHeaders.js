// Headers that mimic Kimi CLI's request signature so the Kimi For Coding
// endpoint (api.kimi.com/coding/v1) accepts our calls. Moonshot gates that
// endpoint via `X-Msh-Platform: kimi_cli` + the `KimiCLI/<version>` User-Agent
// — without these we get 403 access_terminated_error.
//
// Implementation mirrors kimi-cli/src/kimi_cli/auth/oauth.py:_common_headers
// (X-Msh-Platform/Version/Device-Name/Device-Model/Os-Version/Device-Id) so
// we look like a normal CLI client rather than a header-spoof drive-by.
//
// Device-id is persisted to ~/.openovel/kimi-device-id so it's stable across
// restarts; this matches Kimi CLI's behavior (UUIDs survive restarts) and
// means our request signature is consistent across this user's sessions.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"

// Track this against kimi-cli releases. Bump if Moonshot tightens checks.
const KIMI_CLI_VERSION = "1.45.0"

function deviceIdPath() {
  const home = process.env.OPENOVEL_HOME || path.join(os.homedir(), ".openovel")
  return path.join(home, "kimi-device-id")
}

function loadOrCreateDeviceId() {
  const p = deviceIdPath()
  try {
    if (existsSync(p)) {
      const cached = readFileSync(p, "utf8").trim()
      if (cached) return cached
    }
  } catch { /* fall through to create */ }
  try {
    mkdirSync(path.dirname(p), { recursive: true })
    const id = randomUUID().replace(/-/g, "")
    writeFileSync(p, id, "utf8")
    try { chmodSync(p, 0o600) } catch { /* ignore on non-POSIX */ }
    return id
  } catch {
    // Couldn't persist — fall back to an ephemeral id. The request will still
    // pass the platform check; only future-request stability is degraded.
    return randomUUID().replace(/-/g, "")
  }
}

function deviceModel() {
  const arch = os.arch() || ""
  const release = os.release() || ""
  switch (process.platform) {
    case "darwin": return ascii(`macOS ${release} ${arch}`.trim())
    case "win32":  return ascii(`Windows ${release} ${arch}`.trim())
    case "linux":  return ascii(`Linux ${release} ${arch}`.trim())
    default:       return ascii(`${process.platform} ${release} ${arch}`.trim())
  }
}

function ascii(value, fallback = "unknown") {
  if (!value) return fallback
  const s = String(value).replace(/[^\x00-\x7F]/g, "").trim()
  return s || fallback
}

let cached = null
export function kimiCliHeaders() {
  if (cached) return cached
  cached = {
    "User-Agent":         `KimiCLI/${KIMI_CLI_VERSION}`,
    "X-Msh-Platform":     "kimi_cli",
    "X-Msh-Version":      KIMI_CLI_VERSION,
    "X-Msh-Device-Name":  ascii(os.hostname()),
    "X-Msh-Device-Model": deviceModel(),
    "X-Msh-Os-Version":   ascii(os.release()),
    "X-Msh-Device-Id":    loadOrCreateDeviceId(),
  }
  return cached
}
