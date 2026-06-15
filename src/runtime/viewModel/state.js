export function cloneVmState(s) {
  return {
    ...s,
    entries: s.entries.map((e) => ({ ...e })),
    options: [...s.options],
    compose: s.compose ? { ...s.compose } : null,
    onboarding: s.onboarding ? { ...s.onboarding } : null,
    storySelector: s.storySelector
      ? { ...s.storySelector, items: s.storySelector.items.map((i) => ({ ...i })) }
      : null,
    storyNaming: s.storyNaming ? { ...s.storyNaming } : null,
    initChat: s.initChat
      ? {
          ...s.initChat,
          messages: (s.initChat.messages || []).map((m) => ({
            ...m,
            meta: m.meta ? { ...m.meta, options: cloneOptions(m.meta.options) } : undefined,
          })),
          pendingAskUser: s.initChat.pendingAskUser
            ? { ...s.initChat.pendingAskUser, options: cloneOptions(s.initChat.pendingAskUser.options) }
            : null,
        }
      : null,
    jobs: s.jobs.map((j) => ({ ...j })),
    pacing: { ...s.pacing },
    currentStory: s.currentStory ? { ...s.currentStory } : null,
    // Loaded frozen + treated read-only by the renderer; shallow copy mirrors
    // the other nested-object fields (nested blocks/css are immutable).
    formatContract: s.formatContract ? { ...s.formatContract } : null,
    activeTools: s.activeTools.map((t) => ({ ...t })),
    storyTree: s.storyTree.map((e) => ({ ...e })),
    activity: s.activity.map((a) => ({ ...a, meta: a.meta ? { ...a.meta } : null })),
    aggregate: { ...s.aggregate },
    liveStream: s.liveStream ? { ...s.liveStream } : null,
  }
}

function cloneOptions(options) {
  return Array.isArray(options) ? options.map((opt) => ({ ...opt })) : options
}
