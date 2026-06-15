// Back-compat shim over the unified agentChannel.js. The Storykeeper-era callers
// (sessionProcessor, storykeeperWorkflow) and test/agentMessageQueue.test.js use
// these Storykeeper-named wrappers; they bind to the Showrunner's inbox
// (`paths.storykeeperQueue`) with from:"foreground". New code should import
// agentChannel.js directly.
import { paths } from "../lib/storyStore.js"
import {
  enqueueAgentMessage,
  listAgentMessages,
  drainAgentMessages,
  markAgentMessagesInjected,
  markAgentMessagesForTurnInjected,
  renderAgentInbox,
  readAgentInboxEvents,
  compactAgentInbox,
} from "./agentChannel.js"

export function enqueueStorykeeperMessage(message = {}, { queuePath = paths.storykeeperQueue, bus = null } = {}) {
  return enqueueAgentMessage(
    { ...message, to: "showrunner", from: message.from || message.source || "foreground" },
    { queuePath, bus },
  )
}

export function listStorykeeperMessages({ queuePath = paths.storykeeperQueue, status = "pending", limit = 100 } = {}) {
  return listAgentMessages({ queuePath, status, limit })
}

export function drainStorykeeperMessages({
  queuePath = paths.storykeeperQueue,
  maxPriority = "later",
  limit = 12,
  excludeTurnIds = [],
  bus = null,
} = {}) {
  return drainAgentMessages({ queuePath, maxPriority, limit, excludeTurnIds, bus })
}

export function markStorykeeperMessagesInjected(ids = [], { queuePath = paths.storykeeperQueue, reason = "injected", bus = null } = {}) {
  return markAgentMessagesInjected(ids, { queuePath, reason, bus })
}

export function markStorykeeperMessagesForTurnInjected(turnId, {
  queuePath = paths.storykeeperQueue,
  reason = "included-in-current-turn-context",
  bus = null,
} = {}) {
  return markAgentMessagesForTurnInjected(turnId, { queuePath, reason, bus })
}

export const renderStorykeeperQueuedMessages = renderAgentInbox

export function readStorykeeperQueueEvents({ queuePath = paths.storykeeperQueue } = {}) {
  return readAgentInboxEvents({ queuePath })
}

export function compactStorykeeperMessageQueue({ queuePath = paths.storykeeperQueue, retainTerminalMessages = 200 } = {}) {
  return compactAgentInbox({ queuePath, retainTerminalMessages })
}
