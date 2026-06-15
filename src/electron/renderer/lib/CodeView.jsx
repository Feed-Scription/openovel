import React, { useMemo } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorView } from "@codemirror/view"

// Single component used for BOTH the file preview (read-only) and the
// preferences editor (editable). CodeMirror 6 gives us line numbers,
// syntax highlighting, and a virtualized line renderer (so a streaming
// chapters.md doesn't repaint every line on every re-render — that
// caused the visible flicker + lost scroll position previously).
//
// Props:
//   value       — current text content
//   onChange    — callback(text) when user edits (omit → read-only)
//   language    — "markdown" (default) | "plain"
//   minHeight   — optional CSS min-height; component grows to content
//   maxHeight   — optional CSS max-height; component scrolls internally
//   className   — applied to the outer wrapper for theming hooks
export function CodeView({
  value,
  onChange,
  language = "markdown",
  minHeight = "240px",
  maxHeight = "60vh",
  className = "",
}) {
  const readOnly = typeof onChange !== "function"

  // Language extension: markdown by default. `language="plain"` skips it
  // (CodeMirror still gives line numbers + neutral styling).
  const extensions = useMemo(() => {
    const base = [
      EditorView.lineWrapping,
      EditorView.theme({
        "&": {
          fontSize: "12.5px",
          fontFamily: "var(--font-mono)",
          backgroundColor: "var(--paper-lift)",
          color: "var(--ink)",
        },
        ".cm-content": { padding: "8px 0" },
        ".cm-gutters": {
          backgroundColor: "var(--paper-soft)",
          borderRight: "1px solid var(--rule-soft)",
          color: "var(--ink-faint)",
        },
        ".cm-activeLine": { backgroundColor: "rgba(0,0,0,0.025)" },
        ".cm-activeLineGutter": { backgroundColor: "rgba(0,0,0,0.05)" },
        ".cm-selectionBackground": { background: "rgba(28,25,23,0.14) !important" },
        ".cm-cursor": { borderLeftColor: "var(--ink)" },
        "&.cm-focused": { outline: "none" },
      }),
    ]
    if (language === "markdown") {
      base.push(markdown({ base: markdownLanguage, codeLanguages: [] }))
    }
    return base
  }, [language])

  return (
    <div className={`code-view${className ? ` ${className}` : ""}${readOnly ? " is-readonly" : ""}`}>
      <CodeMirror
        value={value ?? ""}
        onChange={readOnly ? undefined : onChange}
        readOnly={readOnly}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
          searchKeymap: true,
          tabSize: 2,
        }}
        extensions={extensions}
        minHeight={minHeight}
        maxHeight={maxHeight}
        theme="light"
      />
    </div>
  )
}
