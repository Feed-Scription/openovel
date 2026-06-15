// Registry for tasks that start after foreground narration has streamed. These
// tasks share the same inputs (action, narration, compiled foreground context)
// and can run concurrently: options, context-card selection, and future
// reader-facing affordances.

export class PostNarrationParallelRegistry {
  #handlers = new Map()

  register({ id, run, fallback, isDisabled }) {
    if (!id || typeof id !== "string") throw new Error("PostNarrationParallel registry id is required")
    if (typeof run !== "function") throw new Error(`PostNarrationParallel handler ${id} needs a run() function`)
    this.#handlers.set(id, { id, run, fallback, isDisabled })
  }

  unregister(id) {
    this.#handlers.delete(id)
  }

  list() {
    return [...this.#handlers.values()]
  }

  has(id) {
    return this.#handlers.has(id)
  }

  fireAll(input = {}) {
    const out = new Map()
    for (const handler of this.#handlers.values()) {
      const disabled = typeof handler.isDisabled === "function" ? handler.isDisabled(input) : false
      if (disabled) {
        const fb = typeof handler.fallback === "function"
          ? handler.fallback({ ...input, disabled: true })
          : null
        out.set(handler.id, Promise.resolve(fb))
        continue
      }
      const promise = Promise.resolve()
        .then(() => handler.run(input))
        .catch((error) => {
          if (typeof handler.fallback === "function") {
            return handler.fallback({ ...input, error })
          }
          return { error: error.message || String(error) }
        })
      out.set(handler.id, promise)
    }
    return out
  }
}

export const postNarrationParallel = new PostNarrationParallelRegistry()
