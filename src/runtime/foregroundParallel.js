// registry for foreground-side auxiliary parallel tasks that
// run alongside the narrator on every reader turn. Each handler emits
// structured output the downstream pipeline (Storykeeper, memory-review,
// etc.) consumes. Example already on disk: `backgroundSignal`
// (anchors/tasks/styleSignal for slow loop).
//
// Why a registry: per-turn parallel tasks were previously hardcoded in
// sessionProcessor (`backgroundSignalPromise = planBackgroundSignal(...)`).
// Adding a new parallel task meant editing sessionProcessor's await chain +
// the ablation flag mapping + the return shape. A registry lets new tasks
// plug in with a single .register() call without touching sessionProcessor.
// See memory: feedback-registry-pattern.
//
// What goes here vs not: the narrator itself does NOT belong in the registry
// — it has streaming, options, and is the user-facing main task. The registry
// is for AUXILIARY parallel tasks that produce structured data.

export class ForegroundParallelRegistry {
  #handlers = new Map()

  // Register a parallel task.
  //   id: unique identifier (also used as result key)
  //   run({action, snapshot, ablations}): returns structured output for downstream
  //   fallback({error, ablations}): synthesize a safe default (called on disabled or thrown)
  //   isDisabled(ablations): predicate that returns true when this task should be skipped
  register({ id, run, fallback, isDisabled }) {
    if (!id || typeof id !== "string") throw new Error("ForegroundParallel registry id is required")
    if (typeof run !== "function") throw new Error(`ForegroundParallel handler ${id} needs a run() function`)
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

  // Fire all registered tasks concurrently. Returns a Map<id, Promise<result>>.
  // Each promise resolves to the handler's output OR its fallback on disabled/throw.
  // Failure isolation: one handler's exception never rejects another's promise.
  fireAll({ action, snapshot, ablations = {} }) {
    const out = new Map()
    for (const handler of this.#handlers.values()) {
      const disabled = typeof handler.isDisabled === "function" ? handler.isDisabled(ablations) : false
      if (disabled) {
        const fb = typeof handler.fallback === "function"
          ? handler.fallback({ ablations, disabled: true })
          : null
        out.set(handler.id, Promise.resolve(fb))
        continue
      }
      const promise = Promise.resolve()
        .then(() => handler.run({ action, snapshot, ablations }))
        .catch((error) => {
          if (typeof handler.fallback === "function") {
            return handler.fallback({ error, ablations })
          }
          return { error: error.message || String(error) }
        })
      out.set(handler.id, promise)
    }
    return out
  }
}

export const foregroundParallel = new ForegroundParallelRegistry()
