import { appendChapterText, appendChoiceFeedback, enqueueBackgroundInbox, getStorySnapshot, paths, recordSceneEvent, initializeStory } from "../lib/storyStore.js"
import { finalizeForegroundTurn, generateForegroundNarration } from "../lib/narrator.js"
import { runStorykeeper } from "../lib/storykeeper.js"
import { runMemoryReview } from "../lib/memoryReview.js"
import { fastActivateContextCards } from "../context/foregroundInserts.js"
import { loadForegroundGuidance } from "../lib/foregroundCompose.js"
import { createUsageProfile, recordProfileEvent, runWithUsageProfile } from "../telemetry/usageProfile.js"
import { performance } from "node:perf_hooks"
import { BackgroundAgentRuntime } from "./backgroundAgentRuntime.js"
import { backgroundJobs } from "./backgroundJob.js"
import { bus } from "./bus.js"
import { toolRegistry } from "./toolRegistry.js"
import { createInitializerAgent } from "../workflows/initializerWorkflow.js"
import { registerDefaultForegroundParallel } from "./foregroundParallelRegistrations.js"
import { registerDefaultPostNarrationParallel } from "./postNarrationRegistrations.js"
import { evaluateStoryWatchers } from "./storyWatchers.js"
import { acquireStorykeeperLease } from "./storykeeperLease.js"
import { enqueueStorykeeperMessage } from "./agentMessageQueue.js"
import { listAgentMessages } from "./agentChannel.js"
import { isResidentTeamEnabled, broadcastTurn } from "./residentTeam.js"
import { optionLabel } from "../lib/optionLabel.js"
import { resolveActiveStoryMode } from "../lib/storyDirectory.js"
import { injectPanelImagePaths, deriveProseFromScript, parsePanelScript } from "../lib/comicScript.js"
import { createComicPanelRun } from "./comicPanels.js"
import { expectedImageKind } from "../provider/imageGeneration.js"

// foreground-side parallel auxiliary tasks go through the
// registry. Context-card selection is launched from the narrator's
// narration-complete hook so it can see streamed prose while running alongside
// the options call.
const foregroundParallel = registerDefaultForegroundParallel()
const postNarrationParallel = registerDefaultPostNarrationParallel()

// per-instance state, not module-globals. Multi-story
// or parallel eval can each instantiate a SessionProcessor without
// sharing the singleton flag or latestTurnContext across stories.
const STORYKEEPER_EMPTY_RECHECK_MS = 500
// hard upper bound on "batch ran, resolved zero items" runs before
// the loop bails. Catches a model that keeps returning empty inboxResolved.
const STORYKEEPER_MAX_CONSECUTIVE_UNRESOLVED = 3
const RESIDENT_DIRECTOR_HANDOFF_WAIT_MS = 20_000
// Debounce for the sub-agent → Showrunner wake signal (resident.handoffs.pending):
// several sub-agents can finish close together; one wake pass drains them all.
const SHOWRUNNER_HANDOFF_WAKE_DEBOUNCE_MS = 3_000

export class SessionProcessor {
  #storykeeperLoopActive = false
  #latestTurnContext = null
  #handoffWakeTimer = null

  async processReaderAction({ action, boundOption = null, onForegroundChunk, optionsEnabled = true, submittedAtMs = null, hidden = false } = {}) {
    const turnId = `turn_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const profile = createUsageProfile({ action, turnId })
    return runWithUsageProfile(profile, async () =>
      this.#processReaderAction({ action, boundOption, turnId, profile, onForegroundChunk, optionsEnabled, submittedAtMs, hidden }),
    )
  }

  // optional initialization phase. Player gives a plain-text worldbook
  // (setting + opening prose + maybe character notes). The background model
  // parses it and seeds the workspace (chapters.md, FOREGROUND.md, character
  // cards, optionally state files), then declares ready via the envelope.
  // Returns { job, ready, durationMs } once the initializer's envelope arrives
  // — i.e., the foreground may now start accepting reader turns.
  //
  // Architecture choices:
  //   - input: plain text worldbook; model is responsible for all extraction
  //   - ready signal: model self-determines via envelope.status === "ready"
  //     (no runtime checklist enforcement)
  //   - emergent state files: model MAY write story/state/*.json or .md but
  //     runtime does not require it
  //   - duration tracked via backgroundJobs ledger
  async initializeFromWorldbook({ worldbook, sourceHint = "" } = {}) {
    if (!worldbook || !String(worldbook).trim()) {
      throw new Error("initializeFromWorldbook needs a non-empty worldbook string")
    }
    await initializeStory()
    await backgroundJobs.bindLedger({ path: paths.jobsLedger })

    const initTurnId = `init_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const startedAt = Date.now()
    await recordSceneEvent({
      type: "session_initialization_started",
      turnId: initTurnId,
      workflow: "initializer",
      worldbookChars: String(worldbook).length,
      sourceHint,
      startedAt: new Date(startedAt).toISOString(),
    })
    bus.publish("session.initialization_started", { turnId: initTurnId, worldbookChars: String(worldbook).length })

    const job = backgroundJobs.start({
      type: "initializer",
      title: `Init from worldbook (${String(worldbook).length} chars)`,
      metadata: { initTurnId, worldbookChars: String(worldbook).length, sourceHint },
      bus,
      run: async () => {
        const runtime = new BackgroundAgentRuntime({ registry: toolRegistry, bus, role: "background" })
        const result = await runtime.run({
          agent: createInitializerAgent(),
          input: { worldbook: String(worldbook), sourceHint, turnId: initTurnId },
        })
        return result
      },
    })

    // Promise that resolves when the orchestrator job completes (success or
    // failure). For callers that need to "wait until foreground may start" —
    // see the bus event session.initialization_complete as the alternative.
    const ready = waitForBackgroundJob(job).then((info) => {
      const durationMs = Date.now() - startedAt
      const isReady = info?.output?.ready === true || info?.output?.status === "ready"
      const payload = {
        turnId: initTurnId,
        ready: isReady,
        status: info?.output?.status || (info?.error ? "error" : "skipped"),
        summary: info?.output?.summary || "",
        filesChanged: info?.output?.filesChanged || [],
        durationMs,
        error: info?.error || null,
      }
      bus.publish("session.initialization_complete", payload)
      recordSceneEvent({
        type: "session_initialization_complete",
        turnId: initTurnId,
        workflow: "initializer",
        ...payload,
      }).catch(() => {})
      return payload
    })

    return { job, ready }
  }

  // singleton Storykeeper. Per-turn spawn caused parallel Storykeeper
  // invocations to race on FOREGROUND.md and grow an unbounded queue under
  // long-session evals. Instead, every turn always enqueues its work to
  // INBOX.md; at most one Storykeeper loop is running per SessionProcessor
  // instance and processes pending inbox items in batches until truly drained.
  // Uses a single long-lived loop model instead of spawning a new worker for
  // every turn.
  #tryAcquireStorykeeperLoop() {
    if (this.#storykeeperLoopActive) return false
    this.#storykeeperLoopActive = true
    return true
  }

  #releaseStorykeeperLoop() {
    this.#storykeeperLoopActive = false
  }

  // F2: heal a stuck loop flag. backgroundJobs.start adds jobs to the in-memory
  // list synchronously BEFORE its run callback fires, so a legitimate concurrent
  // dispatcher would always show up in findRunningStorykeeperId(). If the flag
  // says "loop active" but no live storykeeper job exists, the previous owner
  // died without releasing (process killed mid-batch — by design, since the app
  // exits without awaiting the in-flight storykeeper batch) and the in-memory
  // flag survived into the next session somehow, or a model call wedged past
  // wallclock with try/finally bypassed. Reset and acquire once.
  #acquireStorykeeperLoopWithHeal() {
    if (this.#tryAcquireStorykeeperLoop()) return true
    if (findRunningStorykeeperId()) return false
    this.#releaseStorykeeperLoop()
    return this.#tryAcquireStorykeeperLoop()
  }

  // F2b: drain accumulated inbox on demand. Typical caller is the VM right
  // after a story is opened (bindLedger + recoverAbandoned just ran). If the
  // previous session's storykeeper was killed mid-batch, INBOX.md still holds
  // unresolved items — this method spawns a single drain pass so the user
  // doesn't have to fire a dummy reader action to recover. No-op when the
  // inbox is empty or a live loop is already chewing through items.
  async kickstartStorykeeperIfPending({ getSnapshot = getStorySnapshot, jobs = backgroundJobs } = {}) {
    const snapshot = await getSnapshot()
    if (!snapshot.backgroundInboxItems?.length) {
      return { kickstarted: false, reason: "inbox-empty" }
    }
    if (!this.#acquireStorykeeperLoopWithHeal()) {
      return {
        kickstarted: false,
        reason: "loop-already-active",
        delegatedTo: findRunningStorykeeperId(),
      }
    }
    const pendingCount = snapshot.backgroundInboxItems.length
    const initialTurnId = `kickstart_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const job = jobs.start({
      type: "storykeeper",
      title: `Storykeeper drain (kickstart, ${pendingCount} pending)`,
      metadata: { kickstart: true, pendingCount, initialTurnId, agent: isResidentTeamEnabled() ? "showrunner" : "storykeeper" },
      bus,
      run: async () => {
        let lease = null
        try {
          lease = await acquireStorykeeperLease({
            owner: `storykeeper:kickstart:${initialTurnId}`,
            audit: (event) => backgroundJobs.recordAudit(event),
          })
          if (!lease.acquired) {
            return { initialTurnId, delegatedTo: lease.lock?.lockId || "", reason: `storykeeper lease ${lease.reason}` }
          }
          return await this.storykeeperLoop({ initialTurnId, lease })
        } finally {
          await lease?.release?.().catch(() => {})
          this.#releaseStorykeeperLoop()
        }
      },
    })
    return { kickstarted: true, jobId: job.id, pendingCount }
  }

  // Sub-agent → Showrunner wake (the residentTeam race fix). The Showrunner
  // often composes and exits in seconds while sub-agents run for minutes, so
  // their forShowrunner handoffs (e.g. the Image agent's "embed this generated
  // illustration" permission) used to sit queued until the NEXT reader turn —
  // or forever, if the session closed first. residentTeam's last-finishing
  // sub-agent publishes resident.handoffs.pending; we debounce it and run ONE
  // forced composition pass when no storykeeper/Showrunner job is live.
  scheduleShowrunnerHandoffWake({ delayMs = SHOWRUNNER_HANDOFF_WAKE_DEBOUNCE_MS } = {}) {
    if (this.#handoffWakeTimer) return false
    this.#handoffWakeTimer = setTimeout(() => {
      this.#handoffWakeTimer = null
      this.wakeShowrunnerForHandoffs().catch(() => {})
    }, delayMs)
    this.#handoffWakeTimer.unref?.()
    return true
  }

  async wakeShowrunnerForHandoffs({ jobs = backgroundJobs, hasPending = hasPendingShowrunnerExternalWork } = {}) {
    if (!isResidentTeamEnabled()) return { woken: false, reason: "team-off" }
    // A live composition pass drains pending messages itself via mid-run
    // injection — waking would just be refused by the loop flag anyway.
    if (findRunningStorykeeperId()) return { woken: false, reason: "composition-already-running" }
    const pending = await Promise.resolve(hasPending()).catch(() => false)
    if (!pending) return { woken: false, reason: "no-pending-handoffs" }
    if (!this.#acquireStorykeeperLoopWithHeal()) {
      return { woken: false, reason: "loop-already-active", delegatedTo: findRunningStorykeeperId() }
    }
    const initialTurnId = `handoff_${Date.now().toString(36)}`
    const job = jobs.start({
      type: "storykeeper",
      title: "Showrunner wake (sub-agent handoffs)",
      metadata: { wake: "subagent-handoffs", initialTurnId, agent: "showrunner" },
      bus,
      run: async () => {
        let lease = null
        try {
          lease = await acquireStorykeeperLease({
            owner: `storykeeper:handoff:${initialTurnId}`,
            audit: (event) => backgroundJobs.recordAudit(event),
          })
          if (!lease.acquired) {
            return { initialTurnId, delegatedTo: lease.lock?.lockId || "", reason: `storykeeper lease ${lease.reason}` }
          }
          // forceOnce: the legacy INBOX.md may be empty — the work is the
          // pending agent-channel handoffs, which the runner drains itself.
          return await this.storykeeperLoop({ initialTurnId, lease, forceOnce: true })
        } finally {
          await lease?.release?.().catch(() => {})
          this.#releaseStorykeeperLoop()
        }
      },
    })
    return { woken: true, jobId: job.id }
  }

  async storykeeperLoop({
    initialTurnId,
    getSnapshot = getStorySnapshot,
    runner = runStorykeeper,
    publish = (event, payload) => bus.publish(event, payload),
    recheckMs = STORYKEEPER_EMPTY_RECHECK_MS,
    maxConsecutiveUnresolved = STORYKEEPER_MAX_CONSECUTIVE_UNRESOLVED,
    forceOnce = false,
    lease = null,
  } = {}) {
    // defense-in-depth guards. Even with the orchestrator's pre-check,
    // a malformed model output could leave items un-resolved batch after batch;
    // we bail after maxConsecutiveUnresolved to prevent silent infinite loops.
    const batches = []
    let consecutiveUnresolved = 0
    let forcedExternalWork = Boolean(forceOnce)
    while (true) {
      await lease?.heartbeat?.()
      const snap = await getSnapshot()
      if (!snap.backgroundInboxItems?.length) {
        if (forcedExternalWork) {
          forcedExternalWork = false
          const ctx = this.#latestTurnContext || synthesizeContextFromInbox(snap, initialTurnId)
          const batchResult = await runner(ctx)
          batches.push({
            batchTurnId: ctx.turnId,
            pendingIds: [],
            resolved: batchResult?.inboxResolved || [],
            rejected: batchResult?.inboxRejected || [],
            externalWork: true,
          })
          publish("story.foreground_guidance_updated", {
            turnId: ctx.turnId,
            batchNumber: batches.length,
            foregroundGuidance: batchResult?.foregroundGuidance,
          })
          continue
        }
        await sleep(recheckMs)
        const recheck = await getSnapshot()
        if (!recheck.backgroundInboxItems?.length) break
        continue
      }
      const ctx = this.#latestTurnContext || synthesizeContextFromInbox(snap, initialTurnId)
      const pendingIds = snap.backgroundInboxItems.map((item) => item.id)
      const batchResult = await runner(ctx)
      forcedExternalWork = false
      await lease?.heartbeat?.()
      const resolved = batchResult?.inboxResolved || []
      const rejected = batchResult?.inboxRejected || []
      batches.push({ batchTurnId: ctx.turnId, pendingIds, resolved, rejected })
      consecutiveUnresolved = resolved.length === 0 && rejected.length === 0 ? consecutiveUnresolved + 1 : 0
      publish("story.foreground_guidance_updated", {
        turnId: ctx.turnId,
        batchNumber: batches.length,
        foregroundGuidance: batchResult?.foregroundGuidance,
      })
      if (consecutiveUnresolved >= maxConsecutiveUnresolved) {
        return {
          initialTurnId,
          processedBatches: batches.length,
          batches,
          aborted: "max-consecutive-unresolved-batches",
          consecutiveUnresolved,
        }
      }
    }
    return { initialTurnId, processedBatches: batches.length, batches }
  }

  // Drop in-memory turn context and storykeeper loop ownership. Used when
  // switching active story so the new story doesn't inherit the
  // previous one's latest reader-turn snapshot.
  reset() {
    this.#storykeeperLoopActive = false
    this.#latestTurnContext = null
  }

  // Test hooks defined inside the class so they can touch private fields. Use
  // _internalForTests below for back-compat or `new SessionProcessor()` for
  // multi-instance isolation tests.
  _resetForTests() {
    this.reset()
  }
  _isStorykeeperLoopActiveForTests() {
    return this.#storykeeperLoopActive
  }
  _tryAcquireStorykeeperLoopForTests() {
    return this.#tryAcquireStorykeeperLoop()
  }
  _releaseStorykeeperLoopForTests() {
    this.#releaseStorykeeperLoop()
  }
  _acquireStorykeeperLoopWithHealForTests() {
    return this.#acquireStorykeeperLoopWithHeal()
  }
  _setLatestTurnContextForTests(ctx) {
    this.#latestTurnContext = ctx
  }
  _getLatestTurnContextForTests() {
    return this.#latestTurnContext
  }

  async #processReaderAction({ action, boundOption, turnId, profile, onForegroundChunk, optionsEnabled, submittedAtMs, hidden = false }) {
    markPreFirstChunk("processor_start", {
      boundOption: Boolean(boundOption),
      optionsEnabled,
      sinceSubmitMs: elapsedSince(submittedAtMs),
    })
    const snapshot = await profilePreFirstChunkStep("get_story_snapshot", () => getStorySnapshot(), (value) => ({
      foregroundChars: String(value?.foregroundGuidance || "").length,
      canonTailChars: String(value?.chapters || "").length,
      previousOptions: Array.isArray(value?.previousOptions) ? value.previousOptions.length : 0,
      inboxItems: Array.isArray(value?.backgroundInboxItems) ? value.backgroundInboxItems.length : 0,
    }))
    const ablations = runtimeAblations()
    markPreFirstChunk("runtime_ablations", { any: ablations.any })
    // lazily bind the per-story backgroundJobs JSONL ledger. The
    // bind is idempotent — first call also runs recoverAbandoned() to mark any
    // jobs that were running when the previous process exited. Pending INBOX
    // items get picked up naturally by this turn's Storykeeper orchestrator.
    await profilePreFirstChunkStep("bind_jobs_ledger", () => backgroundJobs.bindLedger({ path: paths.jobsLedger }))
    // Anti-hack selection binding: an effect is honored only when this action
    // arrived as a bound option whose id+label match a runtime-recorded option of
    // the IMMEDIATELY-prior turn. Typed-by-hand actions (no boundOption) or a
    // forged/edited id|label resolve to free-text with no baked effect. The effect
    // is resolved server-side here from scene_log and never crosses to the client.
    const selection = profilePreFirstChunkSync("resolve_bound_selection", () => resolveBoundSelection(boundOption, snapshot.previousOptions, action), (value) => ({
      source: value?.source || "",
      selected: Boolean(value?.selected),
      selectedHasEffect: Boolean(value?.selected?.effect),
    }))
    await profilePreFirstChunkStep("record_reader_action", () => recordSceneEvent({
      type: "reader_action",
      turnId,
      action,
      source: selection.source,
      // Internal, non-reader-facing actions (the opening kickoff) are flagged so
      // the transcript replay drops the action line while keeping its narration.
      ...(hidden ? { hidden: true } : {}),
      ...(selection.selected ? { selected: selection.selected } : {}),
    }))
    if (!hidden) {
      await profilePreFirstChunkStep("append_choice_feedback", () => appendChoiceFeedback({
        turnId,
        action,
        source: selection.source,
        selected: selection.selected,
        previousOptions: snapshot.previousOptions,
        includeUnchosen: optionsEnabled && !ablations.disableOptions,
        optionsEnabled: optionsEnabled && !ablations.disableOptions,
      }))
    }
    if (ablations.any) {
      await profilePreFirstChunkStep("record_runtime_ablation", () => recordSceneEvent({
        type: "runtime_ablation",
        turnId,
        action,
        ablations,
      }))
    }
    profilePreFirstChunkSync("publish_reader_action", () => bus.publish("session.reader_action", { turnId, action }))

    // Resident-team mode (OPENOVEL_RESIDENT_TEAM): broadcast a summary + a pointer
    // to every background agent's inbox on the reader action (and again after
    // narration below). Default off — the single-Storykeeper path is unchanged.
    const residentTeam = isResidentTeamEnabled()
    markPreFirstChunk("resident_team_check", { residentTeam })
    if (residentTeam) {
      await profilePreFirstChunkStep("broadcast_reader_action", () =>
        broadcastTurn({ event: "reader_action", turnId, action }).catch(() => null),
      )
    }

    if (!ablations.disableContextInserts) {
      await profilePreFirstChunkStep("fast_activate_context_cards", () =>
        fastActivateContextCards({ action, snapshot }).catch(() => null),
        (value) => ({
          activated: Array.isArray(value?.activated) ? value.activated.length : 0,
          source: value?.source || "",
        }),
      )
      // fastActivate recomposed FOREGROUND.md with the freshly-triggered cards
      // (now @included). The snapshot was captured before that, so refresh its
      // foregroundGuidance — otherwise the narrator wouldn't see this turn's
      // cards.
      snapshot.foregroundGuidance = await profilePreFirstChunkStep("refresh_foreground_guidance", () =>
        loadForegroundGuidance().catch(() => snapshot.foregroundGuidance),
        (value) => ({ foregroundChars: String(value || "").length }),
      )
    }

    // Story mode (experimental comic / fast): global gate AND the story's own
    // meta flag, resolved once per turn and carried on the snapshot — the
    // narrator swaps its output contract to the panel script on comic, and
    // tightens to the short-burst register on fast. Placed AFTER the
    // foreground-guidance refresh above so the visual-reference append below
    // is not clobbered by it.
    const storyMode = await profilePreFirstChunkStep("resolve_story_mode", () =>
      resolveActiveStoryMode().catch(() => ""),
    )
    const comicMode = storyMode === "comic"
    if (storyMode === "fast") snapshot.fastMode = true
    if (comicMode) {
      snapshot.comicMode = true
      // Panel prompts must restate the story's rendering register + character
      // looks (the image model has no memory). Surface the Image agent's
      // durable visual notes to THIS call only — they are never composed into
      // FOREGROUND.md, so prose-mode narration is unaffected.
      const visual = await profilePreFirstChunkStep("load_comic_visual_reference", () =>
        loadComicVisualReference().catch(() => ""),
        (value) => ({ chars: String(value || "").length }),
      )
      if (visual) snapshot.foregroundGuidance = `${snapshot.foregroundGuidance || ""}\n\n${visual}`
    }

    // fire foreground-parallel tasks that do not need the
    // streamed narration. Post-narration products (options, context cards)
    // live in the postNarrationParallel registry.
    const parallelResults = profilePreFirstChunkSync("foreground_parallel_fire", () =>
      foregroundParallel.fireAll({ action, snapshot, ablations }),
      (value) => ({ handlers: value instanceof Map ? value.size : 0 }),
    )
    const backgroundSignalPromise = parallelResults.get("backgroundSignal") || Promise.resolve(null)

    const effectiveOptionsEnabled = optionsEnabled && !ablations.disableOptions
    let firstForegroundChunkSeen = false
    // Comic mode: panels start generating DURING the stream, the moment each
    // fence closes (its prompt is complete by then) — the renderer reveals the
    // strip sequentially (panel K+1 waits on panel K's image), so the first
    // image's latency is the reader's wait; starting at turn completion would
    // stack the whole generation time on top of it. The accumulated text only
    // sees gate-accepted chunks (a suppressed repeat attempt feeds nothing).
    let comicRun = null
    let comicStreamText = ""
    // Panel files are NAMED before their bytes exist (paths are injected into
    // the script), so the extension must match what the provider will actually
    // emit (volcengine seedream returns jpeg; naming .png failed every panel
    // at the byte-sniff gate).
    const comicPanelExt = comicMode ? expectedImageKind() : "png"
    const narrated = await generateForegroundNarration({
      action,
      snapshot,
      onNarrationChunk: (chunk) => {
        const text = String(chunk || "")
        if (!firstForegroundChunkSeen && text) {
          firstForegroundChunkSeen = true
          markPreFirstChunk("first_foreground_chunk", {
            chunkChars: text.length,
            sinceSubmitMs: elapsedSince(submittedAtMs),
          })
        }
        if (comicMode && text) {
          comicStreamText += text
          // Re-parse only when a fence could have just closed (cheap guard).
          if (text.includes("`")) {
            comicRun ??= createComicPanelRun({ turnId, bus, backgroundJobs, panelExt: comicPanelExt })
            for (const panel of parsePanelScript(comicStreamText).panels) comicRun.addPanel(panel)
          }
        }
        onForegroundChunk?.(chunk)
      },
    })
    // Comic mode: the model wrote the panel script without file paths; assign
    // each panel its deterministic image path now that the script is complete
    // (scene_log + the transcript then carry the full text→image mapping), and
    // derive the turn's TEXT (captions + synopsis) for every prose consumer:
    // the options generator below, chapters.md, and through it the slow loop.
    if (comicMode) narrated.narration = injectPanelImagePaths(narrated.narration, turnId, { ext: comicPanelExt })
    const comicProse = comicMode ? deriveProseFromScript(narrated.narration) : ""
    const proseForConsumers = comicMode && comicProse ? comicProse : narrated.narration

    const postResults = postNarrationParallel.fireAll({
      action,
      snapshot,
      narration: proseForConsumers,
      compiledContext: narrated.compiledContext,
      ablations,
      optionsEnabled: effectiveOptionsEnabled,
    })

    const signalJob = ablations.disableSignal
      ? null
      : backgroundJobs.start({
          type: "background-signal",
          title: `Background signal: ${action.slice(0, 30)}`,
          metadata: { turnId, action },
          bus,
          run: async () => {
            const signal = await backgroundSignalPromise
            await recordSceneEvent({
              type: "background_signal",
              turnId,
              action,
              signal,
            })
            bus.publish("background.signal", { turnId, action, signal })
            return signal
          },
        })

    const optionResult = await (postResults.get("options") || Promise.resolve({ options: [], tension: "reader-directed", storyComplete: false }))
    // The options call failed (timeout / provider error). Route it to the Error
    // Log instead of the reader silently losing their choices for the turn.
    if (effectiveOptionsEnabled && optionResult?.error) {
      bus.publish("foreground.options.error", { turnId, action, error: String(optionResult.error) })
    }
    const foreground = finalizeForegroundTurn({
      action,
      snapshot,
      narration: narrated.narration,
      optionResult,
      optionsEnabled: effectiveOptionsEnabled,
      turnId,
    })

    // Context cards are activated deterministically BEFORE the narrator
    // (fastActivateContextCards → cards.auto.md, recomposed into the
    // foreground); there is no post-narration card pass to apply here.
    // Comic mode: chapters.md records the DERIVED prose (captions + synopsis),
    // never the raw fences/prompts — the slow loop, n-gram/tic analysis, and
    // exports read text canon; the full script lives in scene_log + transcript.
    await appendChapterText(`**读者选择**：${action}\n\n${comicMode && comicProse ? comicProse : foreground.narration}`)
    await recordSceneEvent({
      type: "foreground_turn",
      turnId,
      action,
      foreground,
    })
    bus.publish("session.foreground_turn", { turnId, action, foreground })
    // Comic mode completion pass: validate the final script, queue any panel
    // the stream feed missed, report rejected ones, and account the whole run
    // in the jobs ledger. Never blocks the turn; the renderer lights panels up
    // as their comic.panel.ready events land.
    if (comicMode) {
      comicRun ??= createComicPanelRun({ turnId, bus, backgroundJobs, panelExt: comicPanelExt })
      comicRun.finish(narrated.narration)
    }
    // The chosen option's hidden effect (resolved + validated above). Rides into
    // the sub-agents (team-on) or the storykeeper queue (team-off) so the
    // consequence reaches the NEXT narrator. null for free-typed actions.
    const selectedEffect = selection.selected?.effect || null
    let subAgentJobsPromise = Promise.resolve([])
    if (residentTeam) {
      // Broadcast the narration summary + pointer to every agent, then run each
      // sub-agent once for this turn (each writes only its own domain). The
      // Showrunner composes via the storykeeper loop below (now the Showrunner).
      // The World Keeper persists the effect and the Director sizes a 困难节点 from
      // its risk/difficulty; the Showrunner folds the consequence into next-turn
      // guidance (story/frontend/pending-consequence.md).
      if (!ablations.disableStorykeeper) {
        subAgentJobsPromise = broadcastTurn({
          event: "narration_generated",
          turnId,
          action,
          foreground,
          selectedEffect,
          wakeSubAgents: true,
        })
          .then((result) => result.jobs || [])
          .catch(() => [])
      } else {
        await broadcastTurn({ event: "narration_generated", turnId, action, foreground, selectedEffect }).catch(() => {})
      }
    } else if (!ablations.disableStorykeeper) {
      await enqueueStorykeeperMessage({
        priority: "next",
        source: "foreground",
        type: "foreground_turn",
        turnId,
        payload: {
          action,
          narration: compactForQueue(foreground.narration, 1800),
          tension: foreground.tension || "",
          source: foreground.source || "",
          // Team-off fallback: the single Storykeeper authors the consequence into
          // story/frontend/pending-consequence.md so the next narrator honors it.
          ...(selectedEffect ? { selectedConsequence: compactForQueue(selectedEffect.consequence || selectedEffect.intent || "", 600) } : {}),
        },
      }, { bus })
    }

    let watcherResult = null
    if (!ablations.disableBackground) {
      watcherResult = await evaluateStoryWatchers({
        turnId,
        action,
        foreground,
      })
      if (watcherResult.monitors.triggered.length || watcherResult.loops.triggered.length) {
        await recordSceneEvent({
          type: "watchers_triggered",
          turnId,
          action,
          watchers: watcherResult,
        })
        bus.publish("watchers.triggered", watcherResult)
      }
    }

    // Singleton Storykeeper protocol: turn N always enqueues its work + updates
    // the shared latestTurnContext. If no loop is currently active, this turn's
    // orchestrator becomes the loop and processes pending items in batches. If a
    // loop is already running, the orchestrator just enqueues and exits — the
    // active loop will pick up these items on its next batch poll.
    const job = ablations.disableStorykeeper
      ? null
      : backgroundJobs.start({
          type: "storykeeper",
          title: `Storykeeper turn ${shortId(turnId)}`,
          // Tag the agent so the side-pane agent tree labels it correctly + groups
          // its tool calls (the Showrunner in team mode, else the Storykeeper).
          metadata: { turnId, action, agent: residentTeam ? "showrunner" : "storykeeper" },
          bus,
          run: async () => {
            const backgroundSignal = await backgroundSignalPromise
            const inbox = await enqueueBackgroundInbox({ turnId, action, foreground, signal: backgroundSignal })
            if (inbox.added.length || inbox.skipped.length) {
              await recordSceneEvent({
                type: "background_inbox_enqueued",
                turnId,
                action,
                added: inbox.added,
                skipped: inbox.skipped,
              })
              bus.publish("background.inbox.enqueued", { turnId, action, inbox })
              // In team mode the Showrunner is woken by the turn broadcast (not the
              // legacy storykeeper queue), so skip this enqueue to avoid a dead pile.
              if (!residentTeam) {
                await enqueueStorykeeperMessage({
                  priority: "next",
                  source: "foreground",
                  type: "inbox_enqueued",
                  turnId,
                  payload: {
                    added: inbox.added,
                    skipped: inbox.skipped,
                    backgroundSignal,
                  },
                }, { bus })
              }
            }
            // Publish the latest turn context for the active loop (if any) to
            // pick up. The "latest" context is what the Storykeeper uses as the
            // primary signal; per-turn details are preserved inside the inbox
            // items themselves.
            this.#latestTurnContext = { turnId, action, foreground, backgroundSignal }
            let showrunnerExternalWork = false
            if (residentTeam) {
              await waitForResidentAgentJobs(subAgentJobsPromise, {
                agents: ["director"],
                timeoutMs: RESIDENT_DIRECTOR_HANDOFF_WAIT_MS,
              })
              showrunnerExternalWork = await hasPendingShowrunnerExternalWork().catch(() => false)
            }

            // dead-loop guard. When the signal says no background
            // work is needed AND no items are pending in inbox (including from
            // this turn's enqueue), there's literally nothing for Storykeeper to
            // do. Returning early avoids spinning the singleton loop through 2
            // empty polls just to confirm. Pending inbox items from prior turns
            // are still drained because we re-read the snapshot here (post-enqueue).
            const postEnqueueSnapshot = await getStorySnapshot()
            if (!showrunnerExternalWork && !storykeeperShouldRun(backgroundSignal, postEnqueueSnapshot.backgroundInboxItems)) {
              return {
                turnId,
                skipped: true,
                reason: "storykeeper-no-work: signal=needsBackground:false AND inbox/showrunner-inbox empty",
              }
            }

            // Synchronous critical section: decide whether we run the loop or
            // delegate to an already-running one. No awaits between the flag
            // check and assignment, so two concurrent turns can't both become
            // the loop owner. acquireWithHeal also clears the flag if it's
            // stuck from a prior owner that died without releasing.
            if (!this.#acquireStorykeeperLoopWithHeal()) {
              return {
                turnId,
                delegatedTo: findRunningStorykeeperId(),
                reason: "another storykeeper loop is active; items will be picked up there",
              }
            }
            let lease = null
            try {
              lease = await acquireStorykeeperLease({
                owner: `storykeeper:${turnId}`,
                audit: (event) => backgroundJobs.recordAudit(event),
              })
              if (!lease.acquired) {
                return {
                  turnId,
                  delegatedTo: lease.lock?.lockId || "",
                  reason: `storykeeper lease ${lease.reason}; items will be picked up by the active owner or stale takeover`,
                }
              }
              return await this.storykeeperLoop({ initialTurnId: turnId, lease, forceOnce: showrunnerExternalWork })
            } finally {
              await lease?.release?.().catch(() => {})
              this.#releaseStorykeeperLoop()
            }
          },
        })

    // In team mode the resident Memory agent owns story/memory/, so the legacy
    // memory-review loop is skipped — running both would race on MEMORY.md and
    // show a duplicate "Memory" agent.
    const memoryJob = (ablations.disableMemoryReview || residentTeam)
      ? null
      : backgroundJobs.start({
          type: "memory-review",
          title: `Memory review: ${action.slice(0, 30)}`,
          metadata: { turnId, action },
          bus,
          run: async () => runMemoryReview({ turnId, action, foreground, backgroundSignal: await backgroundSignalPromise }),
        })

    return {
      turnId,
      foreground,
      signalJob,
      job,
      memoryJob,
      watcherResult,
      foregroundGuidance: snapshot.foregroundGuidance,
      profile,
    }
  }
}

export const sessionProcessor = new SessionProcessor()

// residentTeam's last-finishing sub-agent signals here when the coordinator
// inbox still holds unconsumed handoffs. Wiring lives at module scope (not in
// residentTeam) so the team orchestrator never imports the session layer.
bus.subscribe("resident.handoffs.pending", () => {
  sessionProcessor.scheduleShowrunnerHandoffWake()
})

async function profilePreFirstChunkStep(name, fn, metadata = undefined) {
  const startedAt = performance.now()
  try {
    const value = await fn()
    markPreFirstChunk(name, metadataFor(metadata, value), performance.now() - startedAt)
    return value
  } catch (error) {
    markPreFirstChunk(name, {
      status: "error",
      error: error?.message || String(error),
    }, performance.now() - startedAt)
    throw error
  }
}

function profilePreFirstChunkSync(name, fn, metadata = undefined) {
  const startedAt = performance.now()
  try {
    const value = fn()
    markPreFirstChunk(name, metadataFor(metadata, value), performance.now() - startedAt)
    return value
  } catch (error) {
    markPreFirstChunk(name, {
      status: "error",
      error: error?.message || String(error),
    }, performance.now() - startedAt)
    throw error
  }
}

function markPreFirstChunk(name, metadata = undefined, durationMs = undefined) {
  recordProfileEvent({
    name,
    category: "pre_first_chunk",
    durationMs,
    metadata,
  })
}

function metadataFor(metadata, value) {
  return typeof metadata === "function" ? metadata(value) : metadata
}

function elapsedSince(startedAtMs) {
  const start = Number(startedAtMs)
  return Number.isFinite(start) ? Date.now() - start : undefined
}

export function runtimeAblations(env = process.env) {
  const disableBackground = envFlag(env.OPENOVEL_ABLATION_DISABLE_BACKGROUND) || envFlag(env.OPENOVEL_DISABLE_BACKGROUND)
  const disableStorykeeper = disableBackground || envFlag(env.OPENOVEL_ABLATION_DISABLE_STORYKEEPER)
  const disableMemoryReview = disableBackground || envFlag(env.OPENOVEL_ABLATION_DISABLE_MEMORY_REVIEW)
  const disableSignal = disableBackground || envFlag(env.OPENOVEL_ABLATION_DISABLE_BACKGROUND_SIGNAL)
  // Foreground-side ablation: options is a separate LLM call that
  // runs in parallel with context-card selection after the narrator returns.
  // Disabling it tests whether suggested choices add measurable value vs the
  // narrator's narration alone (eval player rarely picks options anyway).
  const disableOptions = envFlag(env.OPENOVEL_ABLATION_DISABLE_OPTIONS)
  // context-insert mechanism is now both a deterministic file
  // write step AND a model-driven manifest selector. Both honor this flag.
  const disableContextInserts = envFlag(env.OPENOVEL_ABLATION_DISABLE_CONTEXT_INSERTS) || envFlag(env.OPENOVEL_DISABLE_CONTEXT_INSERTS)
  return {
    any: disableBackground || disableSignal || disableStorykeeper || disableMemoryReview || disableOptions || disableContextInserts,
    disableBackground,
    disableSignal,
    disableStorykeeper,
    disableMemoryReview,
    disableOptions,
    disableContextInserts,
  }
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}

// pure predicate used by the Storykeeper orchestrator to decide
// whether to enter the singleton loop at all. Returns false (no work) when the
// signal explicitly says no background work AND the inbox snapshot has no
// pending items. Exported for unit tests; the same predicate is used inline.
export function storykeeperShouldRun(signal, inboxItems) {
  const hasPending = Array.isArray(inboxItems) && inboxItems.length > 0
  const needsWork = signal?.needsBackground !== false
  return hasPending || needsWork
}

function synthesizeContextFromInbox(_snapshot, fallbackTurnId) {
  // Should never fire in practice (a turn that enqueued items also set
  // latestTurnContext before becoming the loop). Defensive fallback for restarts
  // or test scenarios where the inbox is non-empty but no turn has fired yet —
  // Storykeeper will fall back to reading the inbox blocks directly via its
  // own context capsule, so a minimal stub is sufficient.
  return {
    turnId: fallbackTurnId,
    action: "",
    foreground: { narration: "", tension: "", source: "synthesized-from-inbox" },
    backgroundSignal: { needsBackground: true, priority: "soon", tasks: [], preserve: [] },
  }
}

function findRunningStorykeeperId() {
  return (
    backgroundJobs.list().find((job) => job.type === "storykeeper" && job.status === "running")?.id || ""
  )
}

function shortId(turnId) {
  const value = String(turnId || "")
  return value.length > 8 ? value.slice(-8) : value
}

// Resolve a clicked option to its server-side effect, or fall back to free-text.
// The binding is honored ONLY when boundOption.id names a real option of the
// immediately-prior recorded turn AND its recorded label equals the submitted
// action (and the client-claimed label, when present, matches too). This is the
// deterministic anti-hack gate: a typed action, a forged id, or an edited label
// all collapse to { source: "free-text", selected: null } and earn no effect.
function resolveBoundSelection(boundOption, previousOptions, action) {
  if (!boundOption || typeof boundOption !== "object" || !boundOption.id) {
    return { source: "free-text", selected: null }
  }
  const match = (previousOptions || []).find(
    (o) => o && typeof o === "object" && o.id === boundOption.id,
  )
  if (!match) return { source: "free-text", selected: null }
  const label = optionLabel(match)
  const claimed = typeof boundOption.label === "string" ? boundOption.label : label
  if (!label || label !== action || claimed !== label) {
    return { source: "free-text", selected: null }
  }
  return {
    source: "option",
    selected: {
      id: match.id,
      key: match.key === true,
      effect: match.effect && typeof match.effect === "object" ? match.effect : null,
    },
  }
}

function compactForQueue(value, maxChars) {
  const text = String(value || "").trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[queue-truncated ${text.length - maxChars}]`
}

// Comic mode: the Image agent's durable visual notes (rendering register +
// per-character visual specs), appended to the narrator's guidance for the
// panel-script call so prompts can restate them. Missing files simply skip;
// the section headers tell the model where each note comes from.
async function loadComicVisualReference() {
  const { readFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const sections = []
  for (const [title, rel] of [
    ["Comic Visual Style (story/image/style.md)", "image/style.md"],
    ["Character Visual Specs (story/image/characters.md)", "image/characters.md"],
  ]) {
    const text = await readFile(join(paths.root, rel), "utf8").catch(() => "")
    if (text.trim()) sections.push(`## ${title}\n\n${text.trim()}`)
  }
  return sections.join("\n\n")
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForResidentAgentJobs(jobsPromise, { agents = [], timeoutMs = 0, intervalMs = 100 } = {}) {
  const wantedAgents = new Set(agents.map(String))
  const jobs = await Promise.resolve(jobsPromise).catch(() => [])
  const selected = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => !wantedAgents.size || wantedAgents.has(String(job?.metadata?.agent || "")))
  if (!selected.length || timeoutMs <= 0) return { waited: selected.length, timedOut: [] }
  const started = Date.now()
  while (selected.some((job) => job.status === "running") && Date.now() - started < timeoutMs) {
    await sleep(intervalMs)
  }
  return {
    waited: selected.length,
    timedOut: selected
      .filter((job) => job.status === "running")
      .map((job) => job.metadata?.agent || job.id)
      .filter(Boolean),
  }
}

async function hasPendingShowrunnerExternalWork() {
  const messages = await listAgentMessages({ agent: "showrunner", limit: 50 })
  return messages.some((message) => message.source !== "runtime" || message.type === "subagent_recommendation")
}

// poll-based wait for a backgroundJobs job to reach a terminal state.
// Used by initializeFromWorldbook to expose the orchestrator's resolution as a
// Promise without coupling sessionProcessor to BackgroundJobRegistry internals.
// The bus also publishes background.job.completed / background.job.error so
// subscribers can avoid polling; this helper is for callers that prefer await.
async function waitForBackgroundJob(job, { intervalMs = 100, timeoutMs = 1000 * 60 * 30 } = {}) {
  const started = Date.now()
  while (job.status === "running") {
    if (Date.now() - started > timeoutMs) {
      return { id: job.id, status: "timeout", error: `wait timed out after ${timeoutMs}ms` }
    }
    await sleep(intervalMs)
  }
  return { id: job.id, status: job.status, output: job.output, error: job.error }
}

// tests target the singleton `sessionProcessor` instance for
// back-compat with existing test code. New tests can use `new SessionProcessor()`
// (or _internalForTests.createSessionProcessor()) for multi-instance isolation.
export const _internalForTests = {
  resolveBoundSelection,
  reset() {
    sessionProcessor._resetForTests()
  },
  isStorykeeperLoopActive() {
    return sessionProcessor._isStorykeeperLoopActiveForTests()
  },
  tryAcquireStorykeeperLoop() {
    return sessionProcessor._tryAcquireStorykeeperLoopForTests()
  },
  releaseStorykeeperLoop() {
    sessionProcessor._releaseStorykeeperLoopForTests()
  },
  acquireStorykeeperLoopWithHeal() {
    return sessionProcessor._acquireStorykeeperLoopWithHealForTests()
  },
  setLatestTurnContext(ctx) {
    sessionProcessor._setLatestTurnContextForTests(ctx)
  },
  getLatestTurnContext() {
    return sessionProcessor._getLatestTurnContextForTests()
  },
  storykeeperLoop(opts) {
    return sessionProcessor.storykeeperLoop(opts)
  },
  createSessionProcessor() {
    return new SessionProcessor()
  },
}
