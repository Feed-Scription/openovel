// Per-job story-root pin.
//
// Story-path resolution (resolveStoryRoot in workspacePaths.js) reads the active
// story from process.env, which switchActiveStory() MUTATES when the reader
// switches stories. A background job (Storykeeper, memory-review, init) launched
// for story A keeps making file-write tool calls for seconds-to-minutes; if the
// reader switches to story B mid-run, those writes would resolve against B and
// clobber it. Draining-before-switch narrows the window but can't close it (the
// drain has a timeout, and a job's intermediate write/edit tool calls bypass the
// envelope-apply guard).
//
// This binds a job to the story root it started on via AsyncLocalStorage: the
// store propagates across every await in the run, so all path resolution inside
// the job stays on its OWN story regardless of later env flips. Result: the
// job's work lands in the right (original) story — preserved, not skipped — and
// the newly-active story is never polluted.

import { AsyncLocalStorage } from "node:async_hooks"

const store = new AsyncLocalStorage()

// Run `fn` with all story-scoped path resolution pinned to `storyRoot`. A falsy
// root is a no-op (resolution falls back to the live env), so callers can pass
// through unconditionally.
export function runPinnedToStoryRoot(storyRoot, fn) {
  if (!storyRoot) return fn()
  return store.run({ storyRoot: String(storyRoot) }, fn)
}

// The pinned story root for the current async context, or "" when unpinned.
// resolveStoryRoot() consults this BEFORE the env so the pin wins over a flip.
export function pinnedStoryRoot() {
  return store.getStore()?.storyRoot || ""
}
