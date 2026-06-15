import React from "react"

// Renders a low-opacity background image keyed off the story's current scene.
// The image source lives in the story or context-card folder. The main
// process can serve local files via the `file://` protocol (Electron's
// CSP in index.html already allows `img-src 'self' file: data:`).
//
// For now we look at state.storyTree for a `cover.*` file under the current
// story root. Later phases will read context-card frontmatter for richer
// scene-specific art.
export function BackgroundArt({ state, enabled }) {
  if (!enabled) return null
  const tree = state.storyTree || []
  const cover = tree.find(
    (e) =>
      !e.isDir &&
      /(^|\/)cover\.(jpg|jpeg|png|webp|gif)$/i.test(e.rel),
  )
  if (!cover) return null
  // We don't have the absolute path in the tree — only `rel`. Resolve via
  // currentStory.root + rel. currentStory.root is the absolute path.
  if (!state.currentStory?.root) return null
  const src = `file://${state.currentStory.root}/${cover.rel}`
  return (
    <div className="background-art" aria-hidden="true">
      <img src={src} alt="" />
    </div>
  )
}
