import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { MarkdownText } from "../lib/MarkdownText.jsx"
import { InitDepthModal } from "./InitDepthModal.jsx"

// Conversational story initialization. The user names a story first (existing
// story-naming flow), then drops in here. M1 skeleton: greeting + intent
// textarea + send. M2 will spawn the background agent and stream agent text,
// tool calls, and ask_user prompts into the message list. Agent finishes →
// "Enter interactive mode?" button transitions to reading.

// A just-completed mechanical tool call stays visible this long before it folds
// into the count summary — so the reader catches each result instead of it
// vanishing the instant it finishes.
const FOLD_GRACE_MS = 2500

export function InitChatPane({ state, actions }) {
  const { t } = useTranslation()
  const ic = state.initChat
  const inputRef = useRef(null)
  const composingRef = useRef(false)
  const scrollerRef = useRef(null)
  // Local input mirror for the textarea (uncontrolled, IME-safe).
  const [draft, setDraft] = useState(ic?.input || "")

  // Drives the fold grace window: a clock that ticks only while at least one
  // completed-but-not-yet-folded tool call is still inside FOLD_GRACE_MS, so
  // those calls fold on their own a couple seconds after finishing.
  const [now, setNow] = useState(() => Date.now())
  const hasPendingFold = (ic?.messages || []).some(
    (m) =>
      m.role === "tool-call"
      && m.meta?.tool !== "explain"
      && (m.meta?.status === "done" || m.meta?.status === "error")
      && m.meta?.completedAt
      && now - m.meta.completedAt < FOLD_GRACE_MS,
  )
  useEffect(() => {
    if (!hasPendingFold) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [hasPendingFold])

  // Sticky-bottom auto-scroll: as new messages stream in, keep the user
  // pinned to the latest content UNLESS they've scrolled up to read. The
  // moment they scroll back near the bottom, auto-scroll resumes. The
  // threshold is generous (40px) so a couple of pixels of "almost at the
  // bottom" still counts — otherwise streaming chunks that shift layout
  // can knock the user out of sticky mode by accident.
  const stickyBottomRef = useRef(true)
  const onScrollerScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyBottomRef.current = distance < 40
  }, [])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (stickyBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [ic?.messages?.length, ic?.pendingAskUser?.id, ic?.streamChars, ic?.usageTokens])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const syncDraft = useCallback(() => {
    if (!inputRef.current) return
    const text = inputRef.current.value
    setDraft(text)
    actions.setInitInput(text)
  }, [actions])

  const onInput = useCallback(() => {
    if (composingRef.current) return
    syncDraft()
  }, [syncDraft])

  const onSubmit = useCallback(() => {
    syncDraft()
    const text = inputRef.current?.value || ""
    // While the agent is running, the box stays writable: the message is
    // enqueued to the init agent's inbox and delivered mid-run at a safe point
    // (like the FG/BG channel). Otherwise it's the normal intent/revision path.
    if (ic?.running) actions.submitInitFeedback(text)
    else actions.submitInitIntent()
    if (inputRef.current) inputRef.current.value = ""
    setDraft("")
    // Sending implies "I want to track the agent again" — re-pin to
    // bottom so the streaming response auto-tracks even if the user had
    // scrolled up before clicking Send.
    stickyBottomRef.current = true
  }, [actions, syncDraft, ic?.running])

  const onKeyDown = useCallback(
    (e) => {
      if (composingRef.current) return
      if (e.key === "Escape") {
        e.preventDefault()
        actions.cancelInitChat()
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault()
        onSubmit()
      }
    },
    [actions, onSubmit],
  )

  if (!ic) return null

  const sendLabel = ic.running
    ? t("initChat.sendFeedback", { defaultValue: "Send" })
    : ic.completed
      ? t("initChat.sendRevision")
      : t("initChat.send")

  return (
    <div className="initchat-pane">
      <InitDepthModal pending={ic.pendingInitDepth} actions={actions} />
      <div className="initchat-header">
        <span className="initchat-header-label">{t("initChat.initializing")}</span>
        <span className="initchat-header-name">"{ic.storyName}"</span>
        {ic.replay && (
          <span className="initchat-replay-controls">
            <span className="initchat-replay-badge">{t("initChat.replayBadge", { defaultValue: "DEMO · 回放" })}</span>
            <span className="initchat-replay-speeds" role="group" aria-label="Replay speed">
              {[1, 5, 10, 50].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`initchat-replay-speed${(ic.replaySpeed || 1) === s ? " is-active" : ""}`}
                  onClick={() => actions.setReplaySpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </span>
          </span>
        )}
      </div>
      <div className="initchat-scroller" ref={scrollerRef} onScroll={onScrollerScroll}>
        <ul className="initchat-messages">
          {(() => {
            // Compute which ask-user question ids have already been
            // answered. A subsequent user-answer message carries the
            // matching questionId in its meta. Once answered, the
            // historical ask-user message should NOT re-render its
            // option list — the choice is already shown below as the
            // user-answer bubble, repeating the options is just noise.
            const answeredAskIds = new Set(
              ic.messages
                .filter((m) => m.role === "user-answer" && m.meta?.questionId)
                .map((m) => m.meta.questionId),
            )
            // Render init work like the side-pane Agents tree: L1 agent rows,
            // L2 tools under each agent. This keeps parallel init-team agents
            // readable instead of interleaving every explain/read/search in one
            // long chronological stream.
            const items = []
            let agentGroups = null
            let agentGroupSegment = 0
            const flushAgentGroups = () => {
              if (agentGroups?.order?.length) {
                items.push(
                  <InitAgentTree
                    key={`agents-${agentGroupSegment++}-${agentGroups.order.map((g) => g.key).join("-")}`}
                    groups={agentGroups.order}
                    now={now}
                    t={t}
                    agentRuns={ic.agentRuns || {}}
                    icRunning={ic.running}
                  />,
                )
              }
              agentGroups = null
            }
            const pushAgentWork = (m) => {
              if (!agentGroups) agentGroups = { byKey: new Map(), order: [] }
              const key = initAgentGroupKey(m)
              let group = agentGroups.byKey.get(key)
              if (!group) {
                group = { key, agent: initAgentId(m), label: initAgentLabel(m), messages: [] }
                agentGroups.byKey.set(key, group)
                agentGroups.order.push(group)
              }
              group.messages.push(m)
            }
            for (const m of ic.messages) {
              if (m.role === "tool-call") {
                pushAgentWork(m)
                continue
              }
              flushAgentGroups()
              // Skip the transcript ask-user echo while the AskUserBox at the
              // bottom is showing the SAME question — otherwise it appears twice.
              if (
                m.role === "ask-user"
                && ic.pendingAskUser
                && m.meta?.questionId === ic.pendingAskUser.id
              ) continue
              const answered = m.role === "ask-user" && answeredAskIds.has(m.meta?.questionId)
              items.push(<InitChatMessage key={m.id} msg={m} t={t} answered={answered} />)
            }
            flushAgentGroups()
            return items
          })()}
          {ic.running && (
            <li className="initchat-msg initchat-msg-status">
              <span className="initchat-status-dot" />
              {ic.isRevision
                ? ` ${t("initChat.status.revising")}`
                : ` ${t("initChat.status.drafting")}`}
              {(() => {
                // streamChars updates per chunk (smooth); usageTokens holds
                // real total tokens from completed model calls. The 4-chars/token
                // heuristic is a temporary live estimate until usage lands.
                const live = (ic.usageTokens || 0) + Math.ceil((ic.streamChars || 0) / 4)
                return live > 0 ? (
                  <span className="initchat-status-tokens"> · {live.toLocaleString()} tokens</span>
                ) : null
              })()}
            </li>
          )}
        </ul>
      </div>
      {ic.replay ? (
        // Demo playback: the question boxes are READ-ONLY (the recording
        // auto-answers them); the only controls are Replay again / Done.
        <div className="initchat-composer initchat-composer-replay">
          {ic.pendingAskUser && (
            <div className="initchat-askuser initchat-askuser-readonly">
              {ic.pendingAskUser.header && <div className="initchat-askuser-header">{ic.pendingAskUser.header}</div>}
              <div className="initchat-askuser-question">{ic.pendingAskUser.question}</div>
              {ic.pendingAskUser.options?.length > 0 && (
                <ul className="initchat-askuser-readonly-options">
                  {ic.pendingAskUser.options.map((o, i) => (
                    <li key={i}>{o.label}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {ic.completed && (
            <div className="initchat-replay-actions">
              <button
                type="button"
                className="initchat-replay-action"
                onClick={() => actions.replayStoryInit(ic.replayStoryId)}
              >
                {t("initChat.replayAgain", { defaultValue: "Replay again" })}
              </button>
              <button
                type="button"
                className="initchat-replay-action is-primary"
                onClick={() => actions.cancelInitChat()}
              >
                {t("initChat.replayDone", { defaultValue: "Done" })}
              </button>
            </div>
          )}
        </div>
      ) : ic.pendingAskUser ? (
        <AskUserBox
          question={ic.pendingAskUser.question}
          header={ic.pendingAskUser.header}
          options={ic.pendingAskUser.options}
          multiSelect={ic.pendingAskUser.multiSelect}
          onAnswer={(text) => actions.submitInitAskUserAnswer(text)}
          t={t}
        />
      ) : (
        // Single composer surface that serves three lifecycle states:
        //   - first turn    (running=false, completed=false): textarea +
        //     floating Send affordance bottom-right; no commit button
        //     because the agent hasn't drafted anything yet.
        //   - working       (running=true): textarea disabled, status above.
        //   - revision turn (running=false, completed=true): textarea +
        //     floating Send revision; commit "Enter interactive mode →"
        //     sits alone in the bottom action row as the primary path.
        //
        // The header home icon handles "back to library" in all states, so
        // there's no Cancel/Back button down here. Cmd-Enter still submits.
        <div className={`initchat-composer${ic.completed ? " initchat-composer-followup" : ""}`}>
          <div className="initchat-textarea-wrap">
            <textarea
              ref={inputRef}
              className="initchat-textarea"
              defaultValue={draft}
              placeholder={
                ic.running
                  ? t("initChat.placeholder.running")
                  : ic.completed
                    ? t("initChat.placeholder.revision")
                    : t("initChat.placeholder.initial")
              }
              onInput={onInput}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false; syncDraft() }}
              autoFocus
            />
            <button
              type="button"
              className="initchat-send-floating"
              onClick={onSubmit}
              disabled={!draft.trim()}
              title={sendLabel}
              aria-label={sendLabel}
            >
              {sendLabel}
            </button>
          </div>
          {ic.completed && (
            <div className="initchat-commit-row">
              <button
                type="button"
                className="initchat-confirm-button"
                onClick={() => actions.confirmInitDone()}
                disabled={ic.running}
                title={t("initChat.enterInteractiveHint")}
              >
                {t("initChat.enterInteractive")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const INIT_AGENT_LABELS = {
  "story-init": "Story Init",
  initializer: "Initializer",
  showrunner: "Showrunner",
  worldkeeper: "World Keeper",
  director: "Director",
  cards: "Card Manager",
  memory: "Memory",
  render: "Render Manager",
  image: "Image",
}

function initAgentId(msg) {
  const explicitAgent = String(msg.meta?.agent || "").trim()
  if (explicitAgent) return explicitAgent
  if (msg.meta?.depth > 0 && msg.meta?.agentType) return String(msg.meta.agentType)
  return "story-init"
}

function initAgentGroupKey(msg) {
  const id = initAgentId(msg)
  if (msg.meta?.agent && msg.meta?.depth > 0 && msg.meta?.agentType) return `${id}:${msg.meta.agentType}`
  return id
}

function initAgentLabel(msg) {
  const id = initAgentId(msg)
  if (msg.meta?.agent && msg.meta?.depth > 0 && msg.meta?.agentType) {
    return `${INIT_AGENT_LABELS[id] || titleCase(id)} · ${titleCase(msg.meta.agentType)}`
  }
  return INIT_AGENT_LABELS[id] || titleCase(id)
}

function titleCase(value) {
  const text = String(value || "Agent").replace(/[-_]+/g, " ").trim()
  return text ? text.replace(/\b\w/g, (m) => m.toUpperCase()) : "Agent"
}

function InitChatMessage({ msg, t, answered = false }) {
  // VM may attach an i18nKey on the message meta (e.g. the new-story
  // greeting). Resolve it here so the renderer can localize without the
  // VM needing access to i18next.
  const localized = msg.meta?.i18nKey
    ? t(msg.meta.i18nKey, { ...(msg.meta.i18nParams || {}), defaultValue: msg.text })
    : msg.text
  switch (msg.role) {
    case "system":
      return (
        <li className="initchat-msg initchat-msg-system">
          <MarkdownText text={localized} />
        </li>
      )
    case "user":
    case "user-answer":
      // User-typed text — render verbatim (preserve linebreaks, no markdown
      // interpretation; the user didn't ask for markdown formatting).
      return (
        <li className="initchat-msg initchat-msg-user">
          <p className="initchat-plain">{localized}</p>
        </li>
      )
    case "agent":
      return (
        <li className="initchat-msg initchat-msg-agent">
          <MarkdownText text={localized} />
        </li>
      )
    case "tool-call": {
      const status = msg.meta?.status || "running"
      // running: empty — the breathing dot comes from .act-glyph-spin::before
      const glyph = status === "running" ? "" : status === "error" ? "✗" : "✓"
      // Nested subagent calls (depth>0) are indented and carry a type chip so
      // they read as "this belongs to the research subagent", not as another
      // top-level call from the main init agent.
      const depth = msg.meta?.depth || 0
      const agentType = msg.meta?.agentType || null
      const isSub = depth > 0
      return (
        <li
          className={`initchat-msg initchat-msg-tool initchat-tool-${status}${isSub ? " initchat-tool-sub" : ""}${agentType ? " has-agent-type" : ""}`}
          style={isSub ? { paddingLeft: `${12 + depth * 16}px` } : undefined}
          title={msg.meta?.error || msg.text || msg.meta?.tool || "tool"}
        >
          <span className={`initchat-tool-glyph${status === "running" ? " act-glyph-spin" : ""}`}>{glyph}</span>
          {agentType && <span className="initchat-tool-agent">{agentType}</span>}
          <span className="initchat-tool-name">{msg.meta?.tool || "tool"}</span>
          <span className="initchat-tool-arg">{msg.text}</span>
          {msg.meta?.error && <span className="initchat-tool-error">{msg.meta.error}</span>}
        </li>
      )
    }
    case "ask-user":
      return (
        <li className="initchat-msg initchat-msg-ask">
          <span className="initchat-ask-label">{msg.meta?.header || t("initChat.agentAsks")}</span>
          <MarkdownText text={localized} />
          {!answered
            && Array.isArray(msg.meta?.options)
            && msg.meta.options.length > 0 && (
            <ul className="initchat-ask-options initchat-ask-options-readonly">
              {msg.meta.options.map((opt) => (
                <li key={opt.label}>
                  <span>{opt.label}</span>
                  {opt.description && <small>{opt.description}</small>}
                </li>
              ))}
            </ul>
          )}
        </li>
      )
    case "summary":
      return (
        <li className="initchat-msg initchat-msg-summary">
          <span className="initchat-summary-label">{t("initChat.draftReady")}</span>
          <MarkdownText text={localized} />
        </li>
      )
    default:
      return (
        <li className="initchat-msg initchat-msg-system">
          <MarkdownText text={localized} />
        </li>
      )
  }
}

// Folded summary of completed mechanical tool calls. Leads with the counts the
// reader cares about (read / search / webfetch), then any others, on one line.
const FOLD_ORDER = ["read", "websearch", "webfetch", "write", "edit", "glob", "grep", "task"]
const FOLD_LABEL = { websearch: "search" } // others render with their tool name

function InitAgentTree({ groups, now, t, agentRuns = {}, icRunning = true }) {
  return (
    <li className="initchat-msg initchat-agent-tree">
      <div className="initchat-agent-tree-list">
        {groups.map((group) => (
          <InitAgentBlock
            key={group.key}
            group={group}
            now={now}
            t={t}
            runState={agentRuns[group.agent]}
            icRunning={icRunning}
          />
        ))}
      </div>
    </li>
  )
}

function InitAgentBlock({ group, now, t, runState, icRunning = true }) {
  const explain = [...group.messages].reverse().find((m) => m.meta?.tool === "explain" && m.text)
  const tools = group.messages.filter((m) => m.meta?.tool !== "explain")
  const visibleTools = []
  const counts = {}
  let foldedTotal = 0
  let visibleErrors = 0
  let foldedErrors = 0
  for (const m of tools) {
    const status = m.meta?.status || "running"
    const recentlyDone = m.meta?.completedAt && now - m.meta.completedAt < FOLD_GRACE_MS
    if (status === "running" || recentlyDone) {
      visibleTools.push(m)
      if (status === "error") visibleErrors += 1
      continue
    }
    if (status === "error") foldedErrors += 1
    const name = m.meta?.tool || "tool"
    counts[name] = (counts[name] || 0) + 1
    foldedTotal += 1
  }
  const running = visibleTools.filter((m) => (m.meta?.status || "running") === "running").length
  const explainRunning = explain && (explain.meta?.status || "running") === "running"
  // Authoritative "is this agent finished" comes from its run lifecycle
  // (background.agent.* → runState), NOT from whether a tool is in flight this
  // instant. An agent between tool calls (thinking, or composing its result)
  // has runState "running" and must not read "done". When there is no lifecycle
  // signal (older path / the top init agent), fall back to the tool inference.
  // Once the whole init finishes, nothing is in flight regardless.
  const agentLive = icRunning && (
    runState === "running"
    || (runState === undefined && (running > 0 || explainRunning))
  )
  const hasError = visibleErrors > 0 || runState === "error"
  const doneText = t("initChat.agentTree.done", { defaultValue: "done" })
  const stateText = running
    ? t(`initChat.agentTree.${running === 1 ? "runningTool" : "runningTools"}`, {
      count: running,
      defaultValue: `${running} ${running === 1 ? "tool" : "tools"}`,
    })
    : agentLive
      ? t("initChat.agentTree.thinking", { defaultValue: "thinking..." })
      : hasError
        ? t("initChat.agentTree.needsAttention", { defaultValue: "needs attention" })
        : doneText
  const isActive = running > 0 || agentLive
  const dotClass = isActive ? "agent-dot" : hasError ? "agent-dot agent-dot-error" : "agent-dot agent-dot-done"
  return (
    <div className={`initchat-agent-block${isActive ? " is-running" : ""}${visibleErrors ? " has-error" : ""}`}>
      <div className="initchat-agent-head">
        <span className={dotClass} />
        <span className="initchat-agent-name">{group.label}</span>
        <span className="initchat-agent-state">{stateText}</span>
        {explain && <span className="initchat-agent-explain" title={explain.text}>{explain.text}</span>}
      </div>
      <div className="initchat-agent-tools">
        {visibleTools.map((m) => (
          <InitAgentTool key={m.id} msg={m} />
        ))}
        {foldedTotal > 0 && <FoldedTools counts={counts} errors={foldedErrors} t={t} compact />}
      </div>
    </div>
  )
}

function InitAgentTool({ msg }) {
  const status = msg.meta?.status || "running"
  // running: empty — the breathing dot comes from .act-glyph-spin::before
  const glyph = status === "running" ? "" : status === "error" ? "✗" : "✓"
  return (
    <div
      className={`agent-tool agent-tool-${status} initchat-agent-tool${msg.meta?.agentType ? " has-agent-type" : ""}`}
      title={msg.meta?.error || msg.text || msg.meta?.tool || "tool"}
    >
      <span className={`agent-tool-glyph${status === "running" ? " act-glyph-spin" : ""}`}>
        {glyph}
      </span>
      {msg.meta?.agentType && <span className="initchat-tool-agent">{msg.meta.agentType}</span>}
      <span className="agent-tool-name">{msg.meta?.tool || "tool"}</span>
      {msg.text && <span className="agent-tool-arg">{msg.text}</span>}
      {msg.meta?.error && <span className="initchat-tool-error">{msg.meta.error}</span>}
    </div>
  )
}

function FoldedTools({ counts, errors = 0, t, compact = false }) {
  const names = [
    ...FOLD_ORDER.filter((n) => counts[n]),
    ...Object.keys(counts).filter((n) => !FOLD_ORDER.includes(n)),
  ]
  const parts = names.map((n) => `${counts[n]} ${FOLD_LABEL[n] || n}`)
  if (errors) parts.unshift(t("initChat.errorsFolded", { count: errors, defaultValue: `${errors} error${errors === 1 ? "" : "s"}` }))
  if (!parts.length) return null
  const body = (
    <>
      <span className="initchat-tool-glyph">✓</span>
      <span className="initchat-fold-text">
        {t("initChat.completed", { defaultValue: "completed" })} {parts.join(" · ")}
      </span>
    </>
  )
  if (compact) return <div className="initchat-agent-fold">{body}</div>
  return (
    <li className="initchat-msg initchat-msg-fold">
      {body}
    </li>
  )
}

function AskUserBox({ question, header, options, multiSelect = false, onAnswer, t }) {
  const inputRef = useRef(null)
  const composingRef = useRef(false)
  const [draft, setDraft] = useState("")
  // Multi-select: labels the user has ticked. Single-select ignores this
  // (a click answers immediately, as before).
  const [picked, setPicked] = useState(() => new Set())
  const choices = Array.isArray(options) ? options.filter((opt) => opt?.label) : []

  const sync = useCallback(() => {
    if (inputRef.current) setDraft(inputRef.current.value)
  }, [])

  const togglePick = useCallback((label) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const send = useCallback(() => {
    sync()
    const typed = (inputRef.current?.value || "").trim()
    let val
    if (multiSelect) {
      // Combine ticked options (in display order) with any free-form text into
      // one string — the tool returns a single string the agent reads.
      const labels = choices.map((o) => o.label).filter((l) => picked.has(l))
      val = [...labels, ...(typed ? [typed] : [])].join(", ")
    } else {
      val = typed
    }
    if (!val.trim()) return
    onAnswer(val)
    if (inputRef.current) inputRef.current.value = ""
    setDraft("")
    setPicked(new Set())
  }, [onAnswer, sync, multiSelect, choices, picked])

  const canSend = multiSelect ? (picked.size > 0 || Boolean(draft.trim())) : Boolean(draft.trim())

  return (
    <div className="initchat-askuser">
      <div className="initchat-askuser-header">{header || t("initChat.agentAsks")}</div>
      <div className="initchat-askuser-question">{question}</div>
      {choices.length > 0 && (
        <>
          {multiSelect && (
            <div className="initchat-askuser-hint">
              {t("initChat.askMultiHint", { defaultValue: "Select one or more, then confirm." })}
            </div>
          )}
          <div className="initchat-askuser-options">
            {choices.map((opt, i) => {
              const isPicked = multiSelect && picked.has(opt.label)
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`initchat-askuser-option${multiSelect ? " is-multi" : ""}${isPicked ? " is-selected" : ""}`}
                  aria-pressed={multiSelect ? isPicked : undefined}
                  onClick={() => (multiSelect ? togglePick(opt.label) : onAnswer(opt.label))}
                >
                  {multiSelect && (
                    <span className="initchat-askuser-check" aria-hidden="true">{isPicked ? "☑" : "☐"}</span>
                  )}
                  <span className="initchat-askuser-index" aria-hidden="true">{i + 1}</span>
                  <span className="initchat-askuser-body">
                    <span className="initchat-askuser-label">{opt.label}</span>
                    {opt.description && <small className="initchat-askuser-description">{opt.description}</small>}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
      <textarea
        ref={inputRef}
        className="initchat-textarea"
        defaultValue=""
        placeholder={multiSelect
          ? t("initChat.askMultiPlaceholder", { defaultValue: "Add anything else (optional), then confirm" })
          : t("initChat.askPlaceholder")}
        onInput={() => composingRef.current || sync()}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false; sync() }}
        onKeyDown={(e) => {
          if (composingRef.current) return
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault()
            send()
          }
        }}
        autoFocus
      />
      <div className="initchat-composer-row">
        <span />
        <button type="button" className="initchat-send-button" onClick={send} disabled={!canSend}>
          {t("initChat.answer")}
        </button>
      </div>
    </div>
  )
}
