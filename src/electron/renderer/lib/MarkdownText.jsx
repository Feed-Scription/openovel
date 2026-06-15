import React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// Shared markdown renderer for agent-emitted prose: init-chat summaries,
// ask_user prompts, file previews, etc. react-markdown produces React nodes
// (no innerHTML), so it is safe against script injection from model output.
// remarkGfm enables GFM extensions (tables, task lists, strikethrough, raw
// URLs). Links open in a new tab; relative paths render as code spans since
// the renderer has no file system to resolve them against.

const COMPONENTS = {
  a: ({ href = "", children, ...rest }) => {
    const external = /^https?:\/\//i.test(href)
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      )
    }
    // Relative file paths from agent prose ("story/canon/chapters.md") don't
    // make sense as <a> in the chat — render as inline code so the path
    // still reads as a path but doesn't beg to be clicked.
    return <code>{children}</code>
  },
  // The chat panel wraps each message in its own block element already,
  // so collapsing react-markdown's top-level <p> margins keeps spacing
  // visually consistent with the surrounding chat bubbles. CSS handles the
  // actual spacing (.md-body p).
}

export function MarkdownText({ text, className = "" }) {
  const value = String(text || "")
  if (!value.trim()) return null
  return (
    <div className={`md-body${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {value}
      </ReactMarkdown>
    </div>
  )
}
