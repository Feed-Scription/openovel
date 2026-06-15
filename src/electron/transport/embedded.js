// Embedded transport: instantiates SessionViewModel in the main process,
// subscribes to its state emissions + bus events, and forwards both to the
// renderer via the callbacks provided by main.js (which thunk them onto
// `webContents.send`).
//
// The allowlist below is the contract for what the renderer can invoke. New
// VM actions must be added here explicitly — preventing the renderer from
// reaching for private helpers.

import { SessionViewModel } from "../../runtime/sessionViewModel.js"
import { registerDefaultTools } from "../../tools/registerTools.js"
import { toolRegistry } from "../../runtime/toolRegistry.js"
import { bus } from "../../runtime/bus.js"

const ALLOWED_METHODS = new Set([
  "setInput",
  "appendInput",
  "backspaceInput",
  "clearInput",
  "setNarrationCpm",
  "pickOption",
  "submitOption",
  "submit",
  "submitReaderText",
  "moveStorySelector",
  "setStorySearch",
  "setStorySort",
  "confirmStorySelection",
  "confirmStoryName",
  "cancelStoryNaming",
  "answerOnboarding",
  "skipOnboarding",
  "advanceOnboardingFromApiKey",
  "goBackInOnboarding",
  "appendCompose",
  "backspaceCompose",
  "newlineCompose",
  "setComposeBuffer",
  "beginPaste",
  "endPaste",
  "cancelCompose",
  "submitCompose",
  "requestExit",
  "readStoryFile",
  "expandStoryTreeNode",
  "collapseStoryTreeNode",
  "switchToStory",
  "goToLibrary",
  "setInitInput",
  "submitInitIntent",
  "submitInitFeedback",
  "continueInitWithDepth",
  "submitInitAskUserAnswer",
  "confirmInitDone",
  "cancelInitChat",
  "replayStoryInit",
  "resumeStoryInit",
  "setReplaySpeed",
  "exportStorySnapshot",
  "exportStoryNovel",
  "importStorySnapshot",
  "restartStory",
  "restoreStoryVersion",
  "listStoryVersions",
  "deleteStoryVersion",
  "deleteStory",
  "renameStory",
  "setStoryMode",
  "listPermissions",
  "approvePermission",
  "denyPermission",
  "listTransactions",
  "rollbackTransaction",
])

const BUS_FORWARD = new Set([
  "background.job.started",
  "background.job.completed",
  "background.job.error",
  "background.signal",
  "background.inbox.enqueued",
  "session.foreground_turn",
  "tool.call.started",
  "tool.call.completed",
  "tool.batch.started",
  "tool.batch.completed",
  "tool.permission",
  "session.initialization_started",
  "session.initialization_complete",
  "story.files_changed",
  "storykeeper.queue.enqueued",
  "storykeeper.queue.injected",
])

export async function createEmbeddedTransport({ onState, onBusEvent }) {
  registerDefaultTools(toolRegistry)
  const vm = new SessionViewModel({ env: process.env })

  const unsubState = vm.subscribe((snapshot) => {
    try { onState?.(snapshot) } catch { /* ignore renderer disconnects */ }
  })

  const unsubBus = []
  for (const name of BUS_FORWARD) {
    unsubBus.push(
      bus.subscribe(name, (event) => {
        try { onBusEvent?.(name, event?.properties || {}) } catch { /* ignore */ }
      }),
    )
  }

  vm.start().catch((error) => {
    process.stderr.write(`vm.start failed: ${error.stack || error.message}\n`)
  })

  return {
    async getState() {
      return vm.getState()
    },
    async dispatch(method, args = []) {
      if (!ALLOWED_METHODS.has(method)) {
        throw new Error(`Method "${method}" is not exposed to the renderer.`)
      }
      const fn = vm[method]
      if (typeof fn !== "function") {
        throw new Error(`SessionViewModel has no method "${method}".`)
      }
      return fn.apply(vm, args)
    },
    async shutdown() {
      try { unsubState() } catch { /* ignore */ }
      for (const off of unsubBus) {
        try { off() } catch { /* ignore */ }
      }
      try { await vm.shutdown() } catch { /* ignore */ }
    },
  }
}
