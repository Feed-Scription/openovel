import React, { useMemo, useState } from "react"
import { List } from "react-window"

function formatBytes(n) {
  if (!n || n < 1) return ""
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / (1024 * 1024)).toFixed(1)}M`
}

function formatNumber(n) {
  const v = Number(n) || 0
  return v.toLocaleString("en-US")
}

function formatCost(n) {
  const v = Number(n) || 0
  if (v === 0) return "$0.00"
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

function formatDuration(ms) {
  const v = Number(ms) || 0
  if (v < 1000) return `${v}ms`
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`
  return `${(v / 60000).toFixed(1)}m`
}

export function SidePane({ state, llmInfo, onOpenFile, onOpenSettings, onExpandDir, onCollapseDir }) {
  const hasAgentJobs = (state.jobs || []).length > 0
  return (
    <aside className={`side-pane${hasAgentJobs ? " side-pane-has-agents" : " side-pane-no-agents"}`}>
      <AggregateCard state={state} llmInfo={llmInfo} onOpenSettings={onOpenSettings} />
      <AgentsPanel state={state} />
      <StoryTreeSection
        tree={state.storyTree}
        expanded={state.storyTreeExpanded}
        onOpenFile={onOpenFile}
        onExpandDir={onExpandDir}
        onCollapseDir={onCollapseDir}
      />
    </aside>
  )
}

function AggregateCard({ state, llmInfo, onOpenSettings }) {
  const agg = state.aggregate || {}
  const live = state.liveStream
  const totalTokens = (agg.inputTokens || 0) + (agg.outputTokens || 0)
  const isStreaming = Boolean(live && live.chars > 0)
  const headlineValue = totalTokens > 0
    ? formatNumber(totalTokens)
    : isStreaming ? "Live" : "Ready"
  const headlineLabel = totalTokens > 0
    ? "tokens"
    : isStreaming ? `${live.source || "Narrator"} streaming` : "runtime idle"
  return (
    <section className="agg-card">
      <header className="agg-card-kicker">
        <span>
          <span className="agg-card-title">Story Engine</span>
          <span className="agg-card-subtitle">runtime console</span>
        </span>
        {/* Silent when idle: the normal state doesn't announce itself. */}
        {isStreaming && <span className="agg-card-status is-live">live</span>}
      </header>
      {llmInfo && (
        <button
          type="button"
          className="agg-card-models"
          onClick={onOpenSettings}
          title="Open Settings → API Keys"
        >
          <span className="agg-card-models-provider">{llmInfo.providerLabel}</span>
          <span className="agg-card-models-divider">·</span>
          <span className="agg-card-models-pair">
            <span className="agg-card-models-tier">small</span>
            <span className="agg-card-models-name">{llmInfo.smallModel || "(provider default)"}</span>
          </span>
          <span className="agg-card-models-divider">·</span>
          <span className="agg-card-models-pair">
            <span className="agg-card-models-tier">large</span>
            <span className="agg-card-models-name">{llmInfo.largeModel || "(provider default)"}</span>
          </span>
          {llmInfo.image && (
            <>
              <span className="agg-card-models-divider">·</span>
              <span className="agg-card-models-pair">
                <span className="agg-card-models-tier">image</span>
                <span className="agg-card-models-name">{llmInfo.image.model || "(provider default)"}</span>
              </span>
            </>
          )}
        </button>
      )}
      <div className="agg-card-row agg-card-headline">
        <span className={`agg-card-big${totalTokens > 0 ? "" : " agg-card-big-word"}`}>
          {headlineValue}
        </span>
        <span className="agg-card-big-label">{headlineLabel}</span>
      </div>
      {isStreaming && (
        <div className="agg-card-row agg-card-live">
          <span className="agg-card-live-dot" />
          <span className="agg-card-live-source">{live.source}</span>
          <span className="agg-card-dot">·</span>
          <span>
            <span className="agg-card-num">{formatNumber(live.chars)}</span>
            {" chars streamed"}
          </span>
        </div>
      )}
      <div className="agg-card-row agg-card-secondary">
        <span className="agg-card-cost">{formatCost(agg.costUsd)}</span>
        <span className="agg-card-dot">·</span>
        <span><span className="agg-card-num">{formatNumber(agg.jobs || 0)}</span> jobs</span>
        <span className="agg-card-dot">·</span>
        <span><span className="agg-card-num">{formatNumber(agg.toolCalls || 0)}</span> tool calls</span>
      </div>
      <div className="agg-card-row agg-card-tertiary">
        <span>
          <span className="agg-card-num">{formatNumber(agg.inputTokens || 0)}</span>
          {" in"}
        </span>
        <span className="agg-card-dot">·</span>
        <span>
          <span className="agg-card-num">{formatNumber(agg.outputTokens || 0)}</span>
          {" out"}
        </span>
        <span className="agg-card-dot">·</span>
        <span>
          <span className="agg-card-num">{formatNumber(agg.modelCalls || 0)}</span>
          {" calls"}
        </span>
        <span className="agg-card-dot">·</span>
        <span>
          <span className="agg-card-num">{formatNumber(agg.filesWritten || 0)}</span>
          {" writes"}
        </span>
      </div>
    </section>
  )
}

// Live agent tree: L1 = the agents currently running (active background jobs),
// L2 = the tools each is calling right now. Only the first 2 tools per agent
// show by default; the rest expand on click. Hidden entirely when nothing is
// active (the narrator's own progress shows in the aggregate card's live line).
function AgentsPanel({ state }) {
  const jobs = state.jobs || []
  const tools = state.activeTools || []
  if (!jobs.length) return null
  const running = jobs.filter((j) => j.state === "running")
  // Active agents first (oldest→newest), then finished history (most recent first).
  const finished = jobs.filter((j) => j.state !== "running").slice().reverse()
  const ordered = [...running, ...finished]
  return (
    <section className="agents-section">
      <header className="agents-title">
        Agents
        <span className="agents-count">{running.length} active</span>
      </header>
      <div className="agents-list">
        {ordered.map((job) => (
          <AgentRow
            key={job.id}
            job={job}
            tools={job.state === "running" ? tools.filter((t) => t.agent && t.agent === job.agent) : []}
          />
        ))}
      </div>
    </section>
  )
}

function AgentRow({ job, tools }) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = job.state === "running"
  const isError = job.state === "error"
  const running = tools.filter((t) => t.state === "running")
  // Running tools first, then recently-finished ones (they linger ~5s).
  const ordered = [...running, ...tools.filter((t) => t.state !== "running")]
  const shown = expanded ? ordered : ordered.slice(0, 2)
  const hidden = ordered.length - shown.length
  const dotClass = isRunning ? "agent-dot" : isError ? "agent-dot agent-dot-error" : "agent-dot agent-dot-done"
  const stateText = isRunning
    ? running.length ? `${running.length} tool${running.length === 1 ? "" : "s"}` : "thinking…"
    : isError ? "failed" : job.durationMs ? `done · ${formatDuration(job.durationMs)}` : "done"
  return (
    <div className={`agent-block agent-${job.state || "running"}`}>
      <div className="agent-head">
        <span className={dotClass} />
        <span className="agent-name">{job.label}</span>
        <span className="agent-state" title={isError ? job.error || "" : undefined}>{stateText}</span>
        {job.explain && (
          <span className="agent-explain" title={job.explain}>{job.explain}</span>
        )}
      </div>
      {isRunning && shown.map((t) => (
        <div key={t.id} className={`agent-tool agent-tool-${t.state}`} title={t.argsSummary || t.name}>
          <span className={`agent-tool-glyph${t.state === "running" ? " act-glyph-spin" : ""}`}>
            {/* running: the breathing dot comes from .act-glyph-spin::before */}
            {t.state === "running" ? "" : "✓"}
          </span>
          <span className="agent-tool-name">{t.name}</span>
          {t.argsSummary && <span className="agent-tool-arg">{t.argsSummary}</span>}
        </div>
      ))}
      {isRunning && hidden > 0 && (
        <button type="button" className="agent-tool-more" onClick={() => setExpanded(true)}>
          +{hidden} more tool{hidden === 1 ? "" : "s"}
        </button>
      )}
      {isRunning && expanded && ordered.length > 2 && (
        <button type="button" className="agent-tool-more" onClick={() => setExpanded(false)}>
          show less
        </button>
      )}
    </div>
  )
}


// Row height for the virtualized list. Tied to .tree-row's effective height
// (font 11.5px × line-height ≈ 16px + padding 2px×2). Bumped to 20 so the
// hover background doesn't visually clip against the next row.
const TREE_ROW_HEIGHT = 20

function TreeRow({ index, style, items, expandedSet, onOpenFile, onExpandDir, onCollapseDir }) {
  const entry = items[index]
  if (!entry) return null
  const isExpanded = entry.isDir && expandedSet.has(entry.rel)
  const clickable = !entry.isDir && typeof onOpenFile === "function"
  const onClick = entry.isDir
    ? () => {
        if (isExpanded) onCollapseDir?.(entry.rel)
        else onExpandDir?.(entry.rel)
      }
    : clickable
      ? () => onOpenFile(entry.rel)
      : undefined
  const rowClass = [
    "tree-row",
    entry.depth > 0 ? "tree-row-nested" : "",
    entry.isDir ? "tree-row-dir" : "tree-row-file",
    clickable ? "tree-row-clickable" : "",
    entry.isDir ? "tree-row-toggleable" : "",
  ].filter(Boolean).join(" ")
  const icon = entry.isDir ? (isExpanded ? "▾" : "▸") : "·"
  return (
    <div
      className={rowClass}
      style={{ ...style, paddingLeft: `${4 + entry.depth * 12}px` }}
      onClick={onClick}
      title={entry.isDir
        ? (isExpanded ? `collapse ${entry.name}/` : `expand ${entry.name}/`)
        : `open ${entry.name}`}
    >
      <span className="tree-icon">{icon}</span>
      <span className="tree-name">{entry.isDir ? `${entry.name}/` : entry.name}</span>
      {!entry.isDir && entry.size > 0 && (
        <span className="tree-size">{formatBytes(entry.size)}</span>
      )}
    </div>
  )
}

function StoryTreeSection({ tree, expanded, onOpenFile, onExpandDir, onCollapseDir }) {
  const items = useMemo(
    () => (tree || []).filter((e) => !e.rel.startsWith("evals")),
    [tree],
  )
  const expandedSet = useMemo(() => new Set(expanded || []), [expanded])
  const fileCount = useMemo(() => items.filter((e) => !e.isDir).length, [items])

  if (!items.length) {
    return (
      <section className="tree-section">
        <header className="tree-section-title">
          <span>Story workspace</span>
          <span className="tree-section-meta">empty</span>
        </header>
        <div className="dim tree-empty">(empty)</div>
      </section>
    )
  }

  return (
    <section className="tree-section">
      <header className="tree-section-title">
        <span>Story workspace</span>
        <span className="tree-section-meta">{formatNumber(fileCount)} files</span>
      </header>
      <div className="story-tree">
        <List
          rowCount={items.length}
          rowHeight={TREE_ROW_HEIGHT}
          rowComponent={TreeRow}
          rowProps={{ items, expandedSet, onOpenFile, onExpandDir, onCollapseDir }}
          overscanCount={6}
          style={{ height: "100%" }}
        />
      </div>
    </section>
  )
}
