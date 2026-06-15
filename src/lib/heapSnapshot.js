// Auto-heap-snapshot helper. Mirrors OpenCode's OPENCODE_AUTO_HEAP_SNAPSHOT
// pattern (see opencode/anomalyco issue #20695): when RSS exceeds a
// threshold, write a v8 heap snapshot to disk so retainer analysis can
// happen offline in Chrome DevTools (DevTools → Memory → Load).
//
// Why we need this: OOM and RSS-spike bugs in long agent sessions cannot be
// diagnosed by reading code or guessing; capturing the retainer tree at peak
// heap gives maintainers evidence before they change allocation hot paths. This
// helper makes empirical capture the easy path.
//
// Activation:
//   OPENOVEL_AUTO_HEAP_SNAPSHOT=1          - enable (off by default)
//   OPENOVEL_HEAP_SNAPSHOT_RSS_MB=2048     - trigger threshold (default 2GB)
//   OPENOVEL_HEAP_SNAPSHOT_DIR=/tmp/heap   - output dir (default cwd)
//   OPENOVEL_HEAP_SNAPSHOT_INTERVAL_MS=2000- sampling interval
//
// Behavior:
//   - On each interval tick, read process.memoryUsage().rss
//   - When RSS first crosses the threshold, write one snapshot
//   - Optionally write a second snapshot if RSS later doubles
//   - Each snapshot file is named heap-<rss-mb>MB-<iso>.heapsnapshot
//   - Snapshots are also written on SIGUSR2 for manual trigger
//
// Trade-off note: writeHeapSnapshot pauses the event loop while it
// serializes (typically 50-500ms for a few-hundred-MB heap; multiple
// seconds for multi-GB). That's acceptable for diagnosis — we want the
// snapshot more than we want continued execution.

import { writeHeapSnapshot } from "node:v8"
import { mkdirSync } from "node:fs"
import path from "node:path"

let armed = false
let interval = null

export function installHeapSnapshotWatcher() {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(process.env.OPENOVEL_AUTO_HEAP_SNAPSHOT || "").toLowerCase(),
  )
  if (!enabled) return null

  const thresholdMB = Math.max(64, Number(process.env.OPENOVEL_HEAP_SNAPSHOT_RSS_MB) || 2048)
  const dir = path.resolve(process.env.OPENOVEL_HEAP_SNAPSHOT_DIR || process.cwd())
  const intervalMs = Math.max(200, Number(process.env.OPENOVEL_HEAP_SNAPSHOT_INTERVAL_MS) || 2000)

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // best effort
  }

  let lastTriggerMB = 0

  const tick = () => {
    const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024))
    // First trigger: cross the configured threshold.
    if (!armed && rssMB >= thresholdMB) {
      armed = true
      lastTriggerMB = rssMB
      capture(dir, rssMB, "threshold-crossed")
      return
    }
    // Second trigger: doubled since last capture (or grew by 1GB+, whichever
    // is smaller). Lets us see growth shape rather than just first overflow.
    if (armed && (rssMB >= lastTriggerMB * 2 || rssMB >= lastTriggerMB + 1024)) {
      lastTriggerMB = rssMB
      capture(dir, rssMB, "growth-step")
    }
  }

  interval = setInterval(tick, intervalMs)
  // Keep the process exit clean — don't keep event loop alive solely for
  // monitoring. unref() means the watcher dies with the rest of the process.
  if (typeof interval.unref === "function") interval.unref()

  process.on("SIGUSR2", () => {
    const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024))
    capture(dir, rssMB, "sigusr2")
  })

  process.stderr.write(
    `[heap-snapshot] watcher armed: threshold=${thresholdMB}MB dir=${dir} interval=${intervalMs}ms (SIGUSR2 for manual capture)\n`,
  )
  return { thresholdMB, dir, intervalMs }
}

function capture(dir, rssMB, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const file = path.join(dir, `heap-${rssMB}MB-${reason}-${stamp}.heapsnapshot`)
  const t0 = Date.now()
  try {
    writeHeapSnapshot(file)
    process.stderr.write(
      `[heap-snapshot] wrote ${file} (rss=${rssMB}MB, took ${Date.now() - t0}ms, reason=${reason})\n`,
    )
  } catch (error) {
    process.stderr.write(
      `[heap-snapshot] FAILED rss=${rssMB}MB reason=${reason}: ${error.message || error}\n`,
    )
  }
}

export function uninstallHeapSnapshotWatcher() {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  armed = false
}
