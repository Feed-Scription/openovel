// Back-compat wrapper over the generic agentLease.js, binding the Showrunner
// (formerly Storykeeper) lock path. sessionProcessor + test/storykeeperLease.test.js
// use these. New code should import agentLease.js with an explicit lockPath.
import { paths } from "../lib/storyStore.js"
import { acquireAgentLease, peekAgentLease, AgentLeaseLostError } from "./agentLease.js"

export class StorykeeperLeaseLostError extends AgentLeaseLostError {
  constructor(message) {
    super(message)
    this.name = "StorykeeperLeaseLostError"
    this.code = "OPENOVEL_STORYKEEPER_LEASE_LOST"
  }
}

export function acquireStorykeeperLease(opts = {}) {
  return acquireAgentLease({ lockPath: paths.storykeeperLock, ...opts })
}

export function peekStorykeeperLease(opts = {}) {
  return peekAgentLease({ lockPath: paths.storykeeperLock, ...opts })
}
