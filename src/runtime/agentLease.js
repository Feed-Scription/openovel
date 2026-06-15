import { existsSync } from "node:fs"
import { open, readFile, stat, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { writeAtomic } from "../lib/files.js"
import { paths } from "../lib/storyStore.js"

// Generic single-owner lease for a resident agent loop. One lock FILE per agent
// (`story/<domain>/agent.lock`) means N agents never contend on the same lock —
// each acquires/heartbeats its own. Generalized from the Storykeeper-only lease:
// the only change is `lockPath` is a parameter instead of a fixed path.

const DEFAULT_TTL_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_GRACE_MS = 15_000

export class AgentLeaseLostError extends Error {
  constructor(message) {
    super(message)
    this.name = "AgentLeaseLostError"
    this.code = "OPENOVEL_AGENT_LEASE_LOST"
  }
}

export async function acquireAgentLease({
  lockPath,
  owner = `pid:${process.pid}`,
  ttlMs = DEFAULT_TTL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  graceMs = DEFAULT_GRACE_MS,
  storyRoot = paths.root,
  now = () => Date.now(),
  audit,
} = {}) {
  if (!lockPath) throw new Error("acquireAgentLease requires a lockPath")
  const lockId = randomUUID()
  const startedAt = new Date(now()).toISOString()
  const record = {
    lockId,
    owner,
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    storyRoot,
    status: "active",
  }

  const created = await createLock(lockPath, record)
  if (created) {
    await audit?.({ event: "agent_lock_acquired", type: "agent-lock", lockId, owner })
    return leaseHandle({ lockPath, lockId, owner, heartbeatMs, now, audit })
  }

  const existing = await readLock(lockPath)
  const stale = await isStaleLock(existing, { lockPath, ttlMs, graceMs, now })
  if (!stale.stale) {
    return { acquired: false, reason: "locked", lock: publicLock(existing), stale }
  }

  await audit?.({
    event: "agent_lock_takeover",
    type: "agent-lock",
    lockId,
    owner,
    previousLockId: existing?.lockId || "",
    reason: stale.reason,
  })
  await unlink(lockPath).catch(() => {})
  const takeover = await createLock(lockPath, record)
  if (!takeover) {
    const current = await readLock(lockPath)
    return { acquired: false, reason: "takeover-raced", lock: publicLock(current), stale }
  }
  return leaseHandle({ lockPath, lockId, owner, heartbeatMs, now, audit })
}

// Read-only view of an agent lock — NEVER acquires, writes, or takes it over.
// For observability/admin tooling. Returns null when no lock is present, else the
// public fields plus a staleness verdict.
export async function peekAgentLease({
  lockPath,
  ttlMs = DEFAULT_TTL_MS,
  graceMs = DEFAULT_GRACE_MS,
  now = () => Date.now(),
} = {}) {
  if (!lockPath) throw new Error("peekAgentLease requires a lockPath")
  const lock = await readLock(lockPath)
  if (!lock) return null
  const stale = await isStaleLock(lock, { lockPath, ttlMs, graceMs, now })
  return { ...publicLock(lock), stale: Boolean(stale.stale), staleReason: stale.reason, ageMs: stale.ageMs ?? null }
}

async function createLock(lockPath, record) {
  let fh
  try {
    fh = await open(lockPath, "wx")
    await fh.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8")
    return true
  } catch (error) {
    if (error?.code === "EEXIST") return false
    throw error
  } finally {
    await fh?.close().catch(() => {})
  }
}

function leaseHandle({ lockPath, lockId, owner, heartbeatMs, now, audit }) {
  let timer = null
  let lost = null
  let released = false
  const onSignal = () => {
    handle.release().catch(() => {})
  }
  const handle = {
    acquired: true,
    lockId,
    owner,
    lockPath,
    startHeartbeat() {
      if (timer) return
      timer = setInterval(() => {
        handle.heartbeat().catch((error) => {
          lost = error
        })
      }, Math.max(100, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS))
      timer.unref?.()
    },
    async heartbeat() {
      const current = await readLock(lockPath)
      if (!current || current.lockId !== lockId) {
        lost = new AgentLeaseLostError("Agent lease was removed or replaced.")
        throw lost
      }
      const next = { ...current, heartbeatAt: new Date(now()).toISOString(), status: "active" }
      await writeAtomic(lockPath, `${JSON.stringify(next, null, 2)}\n`)
      return next
    },
    assertHeld() {
      if (lost) throw lost
      return true
    },
    async release() {
      if (released) return { released: false, reason: "already-released" }
      released = true
      if (timer) clearInterval(timer)
      timer = null
      process.off?.("SIGINT", onSignal)
      process.off?.("SIGTERM", onSignal)
      const current = await readLock(lockPath)
      if (current?.lockId !== lockId) return { released: false, reason: "not-owner" }
      await unlink(lockPath).catch(() => {})
      await audit?.({ event: "agent_lock_released", type: "agent-lock", lockId, owner })
      return { released: true }
    },
  }
  process.once?.("SIGINT", onSignal)
  process.once?.("SIGTERM", onSignal)
  handle.startHeartbeat()
  return handle
}

async function readLock(lockPath) {
  if (!existsSync(lockPath)) return null
  try {
    return JSON.parse(await readFile(lockPath, "utf8"))
  } catch {
    return { corrupt: true, lockPath }
  }
}

async function isStaleLock(lock, { lockPath, ttlMs, graceMs, now }) {
  if (!lock) return { stale: true, reason: "missing" }
  const info = await stat(lockPath).catch(() => null)
  if (lock.corrupt) {
    const age = info ? now() - info.mtimeMs : ttlMs + 1
    return age > ttlMs ? { stale: true, reason: "corrupt-ttl" } : { stale: false, reason: "corrupt-fresh" }
  }
  const heartbeatMs = Date.parse(lock.heartbeatAt || lock.startedAt || "")
  const age = Number.isFinite(heartbeatMs) ? now() - heartbeatMs : ttlMs + 1
  if (age > ttlMs) return { stale: true, reason: "ttl-expired", ageMs: age }
  if (lock.pid && !pidIsAlive(lock.pid) && age > graceMs) {
    return { stale: true, reason: "pid-dead", ageMs: age }
  }
  return { stale: false, reason: "active", ageMs: age }
}

function pidIsAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function publicLock(lock) {
  if (!lock) return null
  return {
    lockId: lock.lockId || "",
    owner: lock.owner || "",
    pid: lock.pid || null,
    startedAt: lock.startedAt || "",
    heartbeatAt: lock.heartbeatAt || "",
    corrupt: Boolean(lock.corrupt),
  }
}
