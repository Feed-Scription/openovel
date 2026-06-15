// default registrations for foreground-side parallel tasks.
// New parallel tasks should add their .register() call here, NOT inline in
// sessionProcessor. See memory: feedback-registry-pattern.

import { foregroundParallel } from "./foregroundParallel.js"
import { planBackgroundSignal } from "../lib/backgroundSignal.js"

let registered = false

export function registerDefaultForegroundParallel() {
  if (registered) return foregroundParallel
  registered = true

  foregroundParallel.register({
    id: "backgroundSignal",
    isDisabled: (ablations) => !!ablations.disableSignal,
    run: ({ action, snapshot }) => planBackgroundSignal({ action, snapshot }),
    fallback: ({ error, disabled }) => {
      if (disabled) {
        return {
          needsBackground: false,
          priority: "skip",
          tasks: [],
          preserve: [],
          notes: ["Background signal disabled by evaluation ablation."],
          source: "ablation-disabled",
        }
      }
      return {
        needsBackground: true,
        priority: "soon",
        tasks: [
          {
            type: "continuity",
            instruction:
              "Background signal generation failed; still update continuity from reader_action and foreground_turn.",
            anchors: [],
          },
        ],
        preserve: [],
        notes: [error?.message || String(error)],
        source: "error",
      }
    },
  })

  return foregroundParallel
}
