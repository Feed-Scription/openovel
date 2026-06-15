import React, { useEffect, useRef } from "react"

// Pure presentational typeahead popup. Keyboard handling (Up/Down/Tab/Enter/Esc)
// lives in Footer.jsx because that's where the input owns focus.
export function SuggestionPopup({ suggestions, totalCount, activeIndex, onHover, onPick }) {
  const activeRef = useRef(null)

  // Keep the highlighted row visible inside the popup's own scroll viewport
  // as the user arrows up/down past the edges. "nearest" avoids unnecessary
  // jumps when the row is already on screen.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (!suggestions?.length) return null
  return (
    <div className="suggestion-popup" role="listbox">
      <div className="suggestion-header">
        {totalCount} command{totalCount === 1 ? "" : "s"} · ↑/↓ to select · Enter to run · Tab to fill
      </div>
      {suggestions.map((cmd, i) => (
        <div
          key={cmd.match}
          ref={i === activeIndex ? activeRef : null}
          role="option"
          aria-selected={i === activeIndex}
          className={`suggestion-row${i === activeIndex ? " suggestion-row-active" : ""}`}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onPick?.(i)}
        >
          <span className="suggestion-label">{cmd.label || cmd.match}</span>
          <span className="suggestion-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  )
}
