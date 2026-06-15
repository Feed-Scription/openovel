// In-memory registry of pending ask_user tool calls. The ask_user tool
// awaits a Promise; that Promise's resolve/reject lives here, indexed by
// the tool-call id. The VM resolves it when the user submits an answer
// (or rejects when the init flow is cancelled).
class AskUserRegistry {
  #pending = new Map()

  register(id, resolver) {
    this.#pending.set(id, resolver)
  }

  resolve(id, answer) {
    const r = this.#pending.get(id)
    if (!r) return false
    this.#pending.delete(id)
    try { r.resolve(answer) } catch { /* swallow */ }
    return true
  }

  reject(id, err) {
    const r = this.#pending.get(id)
    if (!r) return false
    this.#pending.delete(id)
    try { r.reject(err instanceof Error ? err : new Error(String(err))) } catch { /* swallow */ }
    return true
  }

  // Reject every outstanding question. Called when the init flow is
  // cancelled or the session shuts down, so awaiting Promises don't leak.
  rejectAll(reason = "cancelled") {
    const ids = [...this.#pending.keys()]
    for (const id of ids) this.reject(id, new Error(reason))
  }

  has(id) { return this.#pending.has(id) }
  size() { return this.#pending.size }
}

export const askUserRegistry = new AskUserRegistry()
