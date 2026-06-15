import path from "node:path"
import { fileURLToPath } from "node:url"
import { appendFile } from "node:fs/promises"
import { compileForegroundContext } from "../context/contextCompiler.js"
import { writeJson, writeText } from "../lib/files.js"
import { getStorySnapshot, initializeStory } from "../lib/storyStore.js"
import { parseJsonObject } from "../lib/json.js"
import { createChatMessage } from "../provider/openaiCompatible.js"
import { hasModelKey, modelInfo } from "../provider/provider.js"
import { backgroundJobs } from "../runtime/backgroundJob.js"
import { bus } from "../runtime/bus.js"
import { sessionProcessor, runtimeAblations } from "../runtime/sessionProcessor.js"
import { toolRegistry } from "../runtime/toolRegistry.js"
import { registerDefaultTools } from "../tools/registerTools.js"
import {
  completeUsageProfile,
  createUsageProfile,
  estimateCostUSD,
  normalizeUsage,
  persistUsageProfile,
  runWithUsageProfile,
} from "../telemetry/usageProfile.js"
import { summarizeContextGrowth } from "./contextGrowth.js"
import { modelPlayerContract } from "../prompts/agentContracts.js"

const DEFAULT_TURNS = 20
const DEFAULT_PLAYER_MODEL = "deepseek-v4-pro"
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"

export async function runModelPlayerEval(options = {}) {
  const args = normalizeOptions(options)
  configureEvalWorkspace(args)
  await initializeStory()
  registerDefaultTools(toolRegistry)
  await writeJson(path.join(args.outputDir, "config.json"), publicRunConfig(args))

  // fail fast on misconfigured providers. Without this guard the eval
  // runs entirely against the fallback narrator (a canned 1-line echo), the
  // player ragequits around turn 6-8, and the user only discovers the env
  // problem after watching the suite "complete" with empty turns.jsonl. To
  // opt back into the silent fallback path (e.g. unit-testing eval plumbing
  // without a key), set OPENOVEL_EVAL_ALLOW_FALLBACK=1.
  const allowFallback = ["1", "true", "yes", "on"].includes(
    String(process.env.OPENOVEL_EVAL_ALLOW_FALLBACK || "").toLowerCase(),
  )
  if (!allowFallback && !hasModelKey()) {
    const info = modelInfo()
    const expected = info.foregroundProvider?.keyEnv || "the provider API key env var"
    const message = [
      `No foreground model key configured for provider "${info.provider}".`,
      `Set ${expected} (and AI_PROVIDER if non-default), or run \`npm run provider:doctor\` to diagnose.`,
      `Set OPENOVEL_EVAL_ALLOW_FALLBACK=1 to run anyway against the fallback narrator.`,
    ].join("\n")
    process.stderr.write(`[modelPlayer] ${message}\n`)
    throw new Error(message)
  }

  // subscribe to background-job usage events. Each backgroundJobs.start
  // now binds its own UsageProfile and publishes a summary on completion or
  // error. We accumulate per-job-type so the run-level summary can report the
  // real cost (storykeeper + memory-review + signal + initializer + subagent).
  // Before this fix, background usage was systematically dropped — only the
  // synchronous per-turn foreground profile was captured.
  const backgroundUsage = {
    byType: {}, // { storykeeper: {calls, input, output, cacheRead, cost, jobs}, ... }
    total: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
      jobs: 0,
    },
  }
  const unsubscribeBackgroundUsage = bus.subscribe("background.usage", (event) => {
    const { type, summary } = event.properties || {}
    if (!summary) return
    const bucket = (backgroundUsage.byType[type] ||= {
      jobs: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
    })
    const fields = [
      "modelCalls",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadInputTokens",
      "cacheMissInputTokens",
      "totalTokens",
      "estimatedCostUSD",
    ]
    for (const f of fields) {
      bucket[f] += summary[f] || 0
      backgroundUsage.total[f] += summary[f] || 0
    }
    bucket.jobs++
    backgroundUsage.total.jobs++
    // Cost is a float; trim to 8 decimals to avoid float drift in long runs.
    bucket.estimatedCostUSD = Number(bucket.estimatedCostUSD.toFixed(8))
    backgroundUsage.total.estimatedCostUSD = Number(backgroundUsage.total.estimatedCostUSD.toFixed(8))
  })

  // optional init phase. If a worldbook is supplied AND backgrounds
  // are enabled (the user-stated rule: no-background variants skip init and
  // use the worldbook as turn 1 reader action instead), run the initializer
  // agent pack and wait for its ready signal before starting the player loop.
  // The init duration is recorded in summary.json for cross-variant compare.
  const ablations = runtimeAblations()
  let initResult = null
  let initUsage = null
  let effectiveOpening = args.openingAction
  if (args.worldbook) {
    if (ablations.disableBackground || ablations.disableStorykeeper) {
      // No-background path: treat the worldbook as the turn 1 reader action.
      // The narrator alone has to extract everything it needs from the text.
      effectiveOpening = effectiveOpening || args.worldbook
    } else {
      // bind a UsageProfile for the init phase so its model calls
      // land in a profile we can summarize and attribute. Previously init
      // cost was invisible in the ablation report — the reasoning generation
      // alone is ~$0.10-0.15, which matters for cross-variant cost compare.
      const initProfile = createUsageProfile({ action: "initializer", turnId: "init", kind: "initializer" })
      try {
        initResult = await runWithUsageProfile(initProfile, async () => {
          const { ready } = await sessionProcessor.initializeFromWorldbook({
            worldbook: args.worldbook,
            sourceHint: args.worldbookSourceHint,
          })
          return ready
        })
      } catch (error) {
        // graceful degradation — init failure must not kill the run.
        // Fall through to "worldbook becomes turn 1 action" so the eval still
        // produces comparable data. The error is recorded into summary.
        const message = error?.message || String(error)
        process.stderr.write(`[modelPlayer] initializer failed, falling back to inline opening: ${message}\n`)
        initResult = {
          turnId: "init_failed",
          ready: false,
          status: "error",
          summary: "",
          filesChanged: [],
          durationMs: 0,
          error: message,
        }
        effectiveOpening = effectiveOpening || args.worldbook
      }
      const completed = completeUsageProfile(initProfile)
      initUsage = completed?.summary || null
    }
  }

  const transcript = []
  const turns = []
  const playerCalls = []
  let lastOpenovel = null
  let stopReason = ""

  for (let turn = 1; turn <= args.turns; turn++) {
    const decision = await decideNextAction({
      goal: args.goal,
      persona: args.persona,
      turn,
      maxTurns: args.turns,
      history: transcript,
      lastOpenovel,
      config: args.player,
      openingAction: effectiveOpening,
      mode: args.playerMode,
    })
    playerCalls.push(decision.call)

    if (decision.stop && turn > 1) {
      stopReason = decision.stopReason || "player requested stop"
      break
    }

    const startedAt = Date.now()
    const foregroundChunks = []
    // a single narrator/runtime failure must NOT kill a 200-turn run.
    // Record the error into turns.jsonl, emit a synthetic fallback turn, and
    // continue. The bubbled exception was a quiet stability hazard — one
    // transient 429 from the foreground provider would abort the entire eval.
    let result
    let turnError = null
    try {
      result = await sessionProcessor.processReaderAction({
        action: decision.action,
        optionsEnabled: args.optionsEnabled,
        onForegroundChunk: (chunk) => foregroundChunks.push(chunk),
      })
    } catch (error) {
      turnError = error.message || String(error)
      process.stderr.write(`[modelPlayer] turn ${turn} processReaderAction failed: ${turnError}\n`)
      result = {
        turnId: `turn_${Date.now()}_error`,
        foreground: {
          narration: "",
          options: [],
          tension: "error",
          source: "error",
        },
        profile: null,
        signalJob: null,
        job: null,
        memoryJob: null,
      }
    }
    const jobs = [result.signalJob, result.job, result.memoryJob].filter(Boolean)
    if (args.waitBackground) await waitForJobs(jobs, args.timeoutMs)
    if (args.waitEvery > 0 && turn % args.waitEvery === 0) {
      await waitForAllBackgroundJobs(args.timeoutMs)
    }
    const profile = result.profile ? completeUsageProfile(result.profile) : null
    if (args.persistProfiles && result.profile) await persistUsageProfile(result.profile)

    const snapshot = await getStorySnapshot()
    const compiled = await compileForegroundContext({
      snapshot,
      action: "model-player eval",
      turnId: result.turnId,
    })
    const record = {
      turn,
      turnId: result.turnId,
      wallMs: Date.now() - startedAt,
      player: {
        feeling: decision.feeling,
        action: decision.action,
        rationale: decision.rationale,
        focus: decision.focus,
        choseOption: decision.choseOption,
        raw: decision.raw,
      },
      openovel: {
        narration: result.foreground.narration,
        options: result.foreground.options || [],
        tension: result.foreground.tension,
        source: result.foreground.source,
        streamedChars: foregroundChunks.join("").length,
      },
      backgroundJobs: jobs.map(publicJobInfo),
      usage: profile?.summary || null,
      foregroundGuidance: snapshot.foregroundGuidance,
      inboxPending: snapshot.backgroundInboxItems?.length || 0,
      contextReport: compiled.report,
      error: turnError,
    }
    turns.push(compactTurnForMemory(record))
    transcript.push({
      turn,
      action: decision.action,
      narration: result.foreground.narration,
      options: result.foreground.options || [],
      tension: result.foreground.tension,
    })
    lastOpenovel = record.openovel
    await appendTurnArtifacts(args.outputDir, record)

    // Every 10 turns, snapshot background-job health to stderr. Periodic
    // beacons make tail/log inspection enough without grepping jobs.jsonl.
    // Errored counts >0 are highlighted with ALERT prefix.
    if (turn % 10 === 0) {
      const allJobs = backgroundJobs.list()
      const erroredCount = allJobs.filter((j) => j.status === "error").length
      const completedCount = allJobs.filter((j) => j.status === "completed").length
      const runningCount = allJobs.filter((j) => j.status === "running").length
      const prefix = erroredCount > 0 ? "[modelPlayer ALERT]" : "[modelPlayer]"
      process.stderr.write(
        `${prefix} turn ${turn}/${args.turns} · bg jobs: completed=${completedCount} errors=${erroredCount} running=${runningCount}\n`,
      )
    }

    // the player "reads" the narration before
    // the next decision, at a natural reading pace. This replaces the synthetic
    // --wait-every sync points with a foreground/background interleaving that
    // matches how a real user paces an interactive-fiction session. Background
    // jobs (Storykeeper, memory-review, subagents) drain during this sleep
    // exactly the way they would in a real session. Skip on the final turn:
    // there is no next decision to delay.
    if (turn < args.turns) await readerPaceSleep(result.foreground.narration, args.reading)
  }

  // drain timeout must NOT throw out of the summary-writing path.
  // The earlier run control variant ran 200/200 turns successfully but the final
  // 3-min drain hit the wall, threw, and skipped summary.json — losing the
  // structured cost/cache/turn aggregates we'd just spent 3.5 hours producing.
  // Now: log to stderr, mark in summary, but continue to writeJson(summary).
  let finalDrainStatus = "skipped"
  if (args.finalWaitBackground) {
    try {
      await waitForAllBackgroundJobs(args.timeoutMs)
      finalDrainStatus = "drained"
    } catch (error) {
      const message = error?.message || String(error)
      process.stderr.write(`[modelPlayer] final drain incomplete: ${message}\n`)
      finalDrainStatus = `incomplete: ${message}`
    }
  }
  const finalSnapshot = await getStorySnapshot()
  // unsubscribe BEFORE summary is built — any late job completions
  // after this point are not part of the run we're reporting (and the bus
  // would otherwise hold a ref preventing GC across long sessions).
  unsubscribeBackgroundUsage()
  const summary = buildRunSummary({
    args,
    turns,
    playerCalls,
    stopReason,
    finalSnapshot,
    initResult,
    initUsage,
    finalDrainStatus,
    backgroundUsage,
  })
  await writeJson(path.join(args.outputDir, "summary.json"), summary)
  await writeText(path.join(args.outputDir, "transcript.md"), renderTranscript(summary, turns))
  return summary
}

export async function decideNextAction({ goal, persona, turn, maxTurns, history, lastOpenovel, config, openingAction = "", mode = "immersive" }) {
  // when an opening action is scripted, all
  // variants share an identical turn-1 player input so cross-variant anchor
  // comparison is meaningful. Bypass the player model on turn 1 entirely; no
  // token spend, no temperature roll, no provider latency.
  if (turn === 1 && openingAction && String(openingAction).trim()) {
    return {
      action: compact(openingAction, 900),
      rationale: "scripted opening action (--opening-action)",
      focus: "",
      choseOption: undefined,
      stop: false,
      stopReason: "",
      raw: "",
      call: {
        provider: "scripted",
        model: "scripted",
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { estimatedUSD: 0 },
      },
    }
  }
  const messages = buildPlayerMessages({ goal, persona, turn, maxTurns, history, lastOpenovel, mode })
  const message = await createChatMessage({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    json: true,
    bodyTransform: deepseekEvalBodyTransform,
  })
  const raw = message.content || ""
  const parsed = parseJsonObject(raw, {})
  return {
    ...normalizePlayerDecision(parsed, { goal, turn, maxTurns, history, lastOpenovel }),
    raw,
    call: playerCallTelemetry({ message, config }),
  }
}

export function buildPlayerMessages({ goal, persona, turn, maxTurns, history = [], lastOpenovel, mode = "immersive" }) {
  // two player modes. Default `immersive` makes the player inhabit
  // the protagonist — its actions are what the character would naturally do,
  // not "stress-tests" of the system. This is what evals actual reading
  // quality of an interactive fiction system. The legacy `adversarial` mode
  // (continuity-auditing, memory-probing) is preserved for when we want to
  // measure the system's continuity capability rather than its prose.
  //
  // Background: the default player should inhabit the protagonist rather than
  // treat the worldbook as a continuity puzzle to solve.
  const systemContent = mode === "adversarial"
    ? adversarialPlayerSystem()
    : immersivePlayerSystem()
  return [
    { role: "system", content: systemContent },
    {
      role: "user",
      content: JSON.stringify(
        {
          evalGoal: goal,
          playerPersona: persona,
          turn,
          maxTurns,
          recentHistory: compactHistory(history),
          latestOpenovelResponse: lastOpenovel || {
            narration: "",
            options: [],
            tension: "",
            note: "No Openovel response yet. Choose the opening user input that best starts the eval goal.",
          },
        },
        null,
        2,
      ),
    },
  ]
}

// immersive player — the default. Reader inhabits the protagonist;
// actions follow naturally from inside the character, not from outside as
// audits. This matches what we actually want to measure when comparing
// narrator/storykeeper quality: a real reader's experience.
export function immersivePlayerSystem() {
  return [
    "<role>",
    "You are a curious reader living inside an interactive novel. You are NOT a tester.",
    "Your job is to inhabit the protagonist and respond to each scene the way that character would naturally respond — drawn by curiosity, fear, desire, ambition, whatever the worldbook implies.",
    "</role>",
    "",
    modelPlayerContract(),
    "",
    "<mission>",
    "Stay in the protagonist's voice and skin. Read the latest narration like a chapter in a novel, then decide what you, as this character in this scene, would actually do next.",
    "Follow the emotional arc the worldbook and recent prose imply. Po-style readers don't audit memory or stress-test continuity — they sink into the situation.",
    "Trust the narrator. Take the world at face value. Only break character if the prose contradicts something you yourself did this scene (rare).",
    "</mission>",
    "",
    "<interaction_policy>",
    "Pick from the offered options, adapt one, or write your own — whichever feels most natural for the character.",
    "Your action should sound like a player typing in a session, not a reviewer dictating to a writer. Use first-person voice in-character; do not narrate ABOUT the character.",
    "Do not list your reasoning, audit prior scenes, or reference 'memory'/'continuity'/'the system'. Those are author concerns, not player concerns.",
    "Do not summarize the narration back. Move the scene forward.",
    "On turn 1, the worldbook gives you the premise; choose an opening action that's specific to the scene as a reader who just opened the book would.",
    "Make the protagonist's wants and pressures matter — risk something, want something, push for something. Avoid passive observation unless the scene literally demands it.",
    "Surface tension and consequence by what your character does, not by demanding the narrator account for past beats. The narrator handles continuity; you handle the protagonist.",
    "</interaction_policy>",
    "",
    "<output>",
    'Return strict JSON only: { "feeling": string, "action": string, "rationale"?: string, "focus"?: string, "choseOption"?: number, "stop"?: boolean, "stopReason"?: string }.',
    "feeling: one-line first-person reaction to the narration you just read. Honest reader reaction — boredom, excitement, confusion, immersion, frustration, all valid. Write in the same language as the narration. ≤ 60 chars; keep it raw, don't analyze. Do not import names, entities, or settings from outside the current story.",
    "action must be non-empty unless stop is true after the first turn. Write action in the language and register the recent narration is in.",
    "rationale, focus are optional — if you include them, keep them in-character (referencing only what exists in the current story), not in evaluator-speak.",
    "</output>",
  ].join("\n")
}

// adversarial player — opt-in via --player-mode adversarial. Use
// when explicitly measuring the system's continuity/memory ability instead
// of prose quality. This legacy behavior is preserved for targeted probes.
export function adversarialPlayerSystem() {
  return [
    "<role>",
    "You are a validation player for an interactive novel system. Your job is to stress-test how well the system handles continuity, memory, and consequences over a long session.",
    "</role>",
    "",
    modelPlayerContract(),
    "",
    "<mission>",
    "Treat the eval like an audit. Each turn, choose an action that's plausible in-character BUT also probes a system capability: does it remember prior characters / objects / promises? does it track numeric state? does it propagate consequences?",
    "If something looks dropped or contradicted, surface it — in-character if possible, out-of-character if necessary.",
    "</mission>",
    "",
    "<interaction_policy>",
    "Pick from offered options, adapt one, or write your own.",
    "Vary your behavior: inspect, ask, act, challenge assumptions, test remembered details, pursue consequences.",
    "When earlier characters, objects, promises, constraints, or style requests matter, mention them in your action so the system is forced to preserve them.",
    "If the story becomes incoherent, directly probe the inconsistency in-character or with a concise out-of-character correction.",
    "On turn 1, state the premise, objective, and any requested prose texture from evalGoal in natural reader wording.",
    "Keep pursuing the main objective. Take decisive steps that change the situation rather than looping on observation.",
    "</interaction_policy>",
    "",
    "<output>",
    'Return strict JSON only: { "feeling": string, "action": string, "rationale"?: string, "focus"?: string, "choseOption"?: number, "stop"?: boolean, "stopReason"?: string }.',
    "feeling: one-line reader reaction to the narration (≤ 60 chars). Same language as narration. Honest — may flag pacing/continuity/style issues.",
    "action must be non-empty unless stop is true after the first turn.",
    "</output>",
  ].join("\n")
}

export function normalizePlayerDecision(parsed = {}, { goal = "", turn = 1, maxTurns = 1, history = [], lastOpenovel } = {}) {
  const stop = parsed.stop === true
  const options = Array.isArray(lastOpenovel?.options) ? lastOpenovel.options : []
  const choseOption = Number.isInteger(parsed.choseOption) ? parsed.choseOption : Number(parsed.choseOption)
  let action = stringOr(parsed.action, "")
  if (!action && Number.isInteger(choseOption) && choseOption >= 1 && choseOption <= options.length) {
    action = options[choseOption - 1]
  }
  if ((!action || isLowAgencyPlaceholder(action)) && !stop) {
    action = goalDirectedFallback({ goal, turn, maxTurns, history, lastOpenovel })
  }
  return {
    // capture the player's reader-feeling so we have per-turn
    // qualitative reaction data alongside the narration. Cap at 240 chars;
    // anything longer than that is the player drifting into analysis, not
    // reaction. Empty string is fine — means the model didn't emit one.
    feeling: compact(parsed.feeling, 240),
    action: compact(action, 900),
    rationale: compact(parsed.rationale, 700),
    focus: compact(parsed.focus, 240),
    choseOption: Number.isInteger(choseOption) && choseOption > 0 ? choseOption : undefined,
    stop,
    stopReason: compact(parsed.stopReason, 300),
  }
}

function isLowAgencyPlaceholder(action = "") {
  const text = String(action || "").toLowerCase()
  if (!text.trim()) return true
  return [
    /继续观察.*寻找.*线索/,
    /观察当前局势/,
    /具体可行动的线索/,
    /continue (to )?observ(e|ing)/,
    /look for (a )?(specific |concrete )?actionable clue/,
    /wait and see/,
  ].some((pattern) => pattern.test(text))
}

function goalDirectedFallback({ goal = "", turn = 1, maxTurns = 1, history = [], lastOpenovel } = {}) {
  const cjk = /[\u3400-\u9fff]/.test(goal) || /[\u3400-\u9fff]/.test(lastOpenovel?.narration || "")
  const recent = history.at(-1)
  if (turn <= 1) {
    const opening = naturalOpeningRequest(goal, cjk)
    return cjk
      ? `${opening} 请从一个可行动的开局写起，并保持我提出的文风要求。`
      : `${opening} Begin with an actionable opening and preserve the prose style I asked for.`
  }
  const chosenOption = chooseActionableOption(lastOpenovel?.options || [])
  if (chosenOption) {
    return cjk ? `我选择：${chosenOption}` : `I choose: ${chosenOption}`
  }
  const pressure = compact(lastOpenovel?.tension || recent?.tension || "", 160)
  const anchor = compact(recent?.action || "", 180)
  const remaining = Math.max(0, maxTurns - turn + 1)
  if (cjk) {
    return [
      pressure ? `我针对当前压力“${pressure}”采取一个会改变局面的具体行动，` : "我采取一个会改变局面的具体行动，",
      anchor ? "同时利用此前已经建立的目标、资源、限制和行动后果。" : "同时利用此前已经建立的目标、资源和限制。",
      remaining <= 5 ? "如果离结局不远，请让这个行动直接推进主线目标。" : "",
    ]
      .filter(Boolean)
      .join("")
  }
  return [
    pressure ? `I take a concrete action against the current pressure, "${pressure}",` : "I take a concrete action that changes the situation,",
    anchor ? " using earlier goals, resources, constraints, and consequences." : " using the established objective, resources, and constraints.",
    remaining <= 5 ? " Since the run is near its end, this should directly advance the main objective." : "",
  ]
    .filter(Boolean)
    .join("")
}

function naturalOpeningRequest(goal = "", cjk = false) {
  const cleaned = compact(
    String(goal || "")
      .replace(/^play\s+/i, "I want to play ")
      .replace(/\bStress-test\b[\s\S]*$/i, "")
      .replace(/\bOn the first turn,\s*explicitly ask for\b/i, cjk ? "我希望使用" : "Please use"),
    360,
  )
  if (cleaned) return cleaned
  return cjk ? "我想开始一个以明确目标和可行动处境开局的互动故事。" : "I want to start an interactive story with a clear goal and an actionable opening."
}

function chooseActionableOption(options = []) {
  const normalized = options
    .map((text, index) => ({ text: compact(text, 260), index }))
    .filter((item) => item.text)
  if (!normalized.length) return ""
  const scored = normalized.map((item) => ({ ...item, score: actionScore(item.text) }))
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored[0].text
}

function actionScore(text = "") {
  const value = String(text || "").toLowerCase()
  let score = 0
  if (/\b(accept|take|head|go|board|enter|leave|send|call|activate|open|repair|cross-check|test|ask|demand|offer)\b/.test(value)) {
    score += 3
  }
  if (/(接受|拿|前往|登上|进入|离开|发送|联系|启动|打开|修理|核对|测试|询问|要求|提出)/.test(value)) score += 3
  if (/\b(watch|wait|study|review|observe|linger)\b/.test(value) || /(等待|观察|观看|停留|研究)/.test(value)) score -= 2
  if (/\bearth|launch|departure|dock|phobos|shuttle|freighter|slot|route|flight\b/.test(value)) score += 1
  if (/(地球|发射|出发|码头|航班|舱位|路线|飞船|货船)/.test(value)) score += 1
  return score
}

function normalizeOptions(options = {}) {
  const goal = compact(options.goal, 1200)
  if (!goal) throw new Error("Model-player eval needs --goal <text>.")
  const runId = options.runId || `model_player_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "story", "evals", runId))
  return {
    runId,
    outputDir,
    storyRoot: options.storyRoot || path.join(outputDir, "workspace"),
    goal,
    // default persona shifted to immersive reader. The legacy
    // "demanding but fair" + "remembers prior details" framing combined with
    // the old prompt's "stress-test / challenge assumptions / test memory"
    // verbs was pushing the player into adversarial-evaluator mode — driving
    // the narrator into procedural-investigation prose instead of the genre
    // the worldbook actually asks for. New default lets the worldbook genre
    // and persona shape the player; --player-mode adversarial restores the
    // old behavior when measuring system continuity capability.
    persona: compact(options.persona, 1200) ||
      "A curious reader who lets the story carry them. Picks each action from inside the protagonist's voice — drawn by what the character would want, fear, or wonder about next — rather than auditing the system.",
    playerMode: ["immersive", "adversarial"].includes(options.playerMode) ? options.playerMode : "immersive",
    turns: Math.max(1, Number(options.turns) || DEFAULT_TURNS),
    optionsEnabled: options.optionsEnabled !== false,
    waitBackground: options.waitBackground === true,
    finalWaitBackground: options.finalWaitBackground !== false,
    waitEvery: Math.max(0, Number(options.waitEvery) || 0),
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 180000),
    persistProfiles: options.persistProfiles === true,
    openingAction: compact(options.openingAction, 1000),
    // worldbook is the player-supplied free text. Backgrounds-enabled
    // runs route it through the initializer agent pack before turn 1; backgrounds-
    // disabled runs treat it as turn 1's reader action (a long opening). Limit
    // is generous because worldbooks can be multi-page; the initializer will
    // compress whatever it needs.
    worldbook: typeof options.worldbook === "string" ? options.worldbook : "",
    worldbookSourceHint: compact(options.worldbookSourceHint, 240),
    reading: {
      cpmZh: Number.isFinite(Number(options.readingCpmZh)) ? Math.max(0, Number(options.readingCpmZh)) : 600,
      cpmEn: Number.isFinite(Number(options.readingCpmEn)) ? Math.max(0, Number(options.readingCpmEn)) : 1200,
    },
    player: {
      apiKey:
        options.playerApiKey ||
        process.env.OPENOVEL_EVAL_DEEPSEEK_API_KEY ||
        process.env.OPENOVEL_EVAL_API_KEY ||
        process.env.DEEPSEEK_API_KEY,
      baseUrl:
        options.playerBaseUrl ||
        process.env.OPENOVEL_EVAL_DEEPSEEK_BASE_URL ||
        process.env.OPENOVEL_EVAL_BASE_URL ||
        process.env.DEEPSEEK_BASE_URL ||
        DEFAULT_DEEPSEEK_BASE_URL,
      model:
        options.playerModel ||
        process.env.OPENOVEL_EVAL_LARGE_MODEL ||
        process.env.OPENOVEL_EVAL_MODEL ||
        DEFAULT_PLAYER_MODEL,
      temperature: Number(options.playerTemperature ?? process.env.OPENOVEL_EVAL_TEMPERATURE ?? 0.75),
      // default 500 was too tight after the feeling field was added.
      // v4-pro with thinking burns the output budget on reasoning_content
      // (which counts against the same budget as the user-visible content),
      // empirically truncating ~36% of decisions mid-string. parseJsonObject
      // returns {} on truncation and we fall back to goalDirectedFallback's
      // stock "我选择：..." placeholder — masking the truncation in turns.jsonl.
      // 32000 effectively removes the limit (DeepSeek v4-pro accepts large
      // budgets, player call bypasses the capabilities clamp). maxTokens is
      // an upper bound; the model still produces only what it needs, so this
      // doesn't increase steady-state cost.
      maxTokens: Number(options.playerMaxTokens ?? process.env.OPENOVEL_EVAL_MAX_TOKENS ?? 32000),
      // 180s overall lets reasoning-capable player calls finish complex
      // decisions while provider chunk-stall protection still catches hangs.
      // Player call is non-streaming so only the overall timer applies here.
      timeoutMs: Number(options.playerTimeoutMs ?? process.env.OPENOVEL_EVAL_TIMEOUT_MS ?? 180000),
    },
  }
}

function configureEvalWorkspace(args) {
  if (!args.player.apiKey) {
    throw new Error("Missing eval DeepSeek key. Set OPENOVEL_EVAL_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY.")
  }
  process.env.OPENOVEL_STORY_ROOT = args.storyRoot
}

function publicRunConfig(args) {
  return {
    runId: args.runId,
    outputDir: args.outputDir,
    storyRoot: args.storyRoot,
    goal: args.goal,
    persona: args.persona,
    turns: args.turns,
    optionsEnabled: args.optionsEnabled,
    waitBackground: args.waitBackground,
    finalWaitBackground: args.finalWaitBackground,
    waitEvery: args.waitEvery,
    timeoutMs: args.timeoutMs,
    openingAction: args.openingAction,
    reading: args.reading,
    worldbookChars: String(args.worldbook || "").length,
    worldbookSourceHint: args.worldbookSourceHint,
    openovelProviders: modelInfo(),
    player: {
      provider: "deepseek-eval",
      baseUrl: args.player.baseUrl,
      model: args.player.model,
      keyConfigured: Boolean(args.player.apiKey),
    },
  }
}

function playerCallTelemetry({ message, config }) {
  const telemetry = message._apiTelemetry || {}
  const usage = normalizeUsage(telemetry.usage || {})
  return {
    provider: "deepseek-eval",
    model: config.model,
    durationMs: telemetry.durationMs || 0,
    usage,
    cost: estimateCostUSD({ model: config.model, usage }),
  }
}

function deepseekEvalBodyTransform(body) {
  const value = String(body.model || "").toLowerCase()
  if (value === "deepseek-v4-flash") return { ...body, thinking: { type: "disabled" } }
  if (value === "deepseek-v4-pro") {
    const next = { ...body, thinking: { type: "enabled" }, reasoning_effort: process.env.OPENOVEL_EVAL_REASONING_EFFORT || "medium" }
    delete next.temperature
    return next
  }
  return body
}

async function appendTurnArtifacts(outputDir, record) {
  await appendFile(path.join(outputDir, "turns.jsonl"), `${JSON.stringify(record)}\n`, "utf8")
}

function compactTurnForMemory(record) {
  if (!record || typeof record !== "object") return record
  return {
    ...record,
    foregroundGuidance: record.foregroundGuidance
      ? `[omitted from eval heap: ${String(record.foregroundGuidance).length} chars; full value is in turns.jsonl]`
      : "",
  }
}

function buildRunSummary({ args, turns, playerCalls, stopReason, finalSnapshot, initResult, initUsage = null, finalDrainStatus = "skipped", backgroundUsage = null }) {
  const openovelSummaries = turns.map((turn) => turn.usage).filter(Boolean)
  const playerSummary = summarizePlayerCalls(playerCalls)
  return {
    ok: turns.length > 0,
    runId: args.runId,
    goal: args.goal,
    requestedTurns: args.turns,
    completedTurns: turns.length,
    stopReason,
    outputDir: args.outputDir,
    storyRoot: args.storyRoot,
    providers: modelInfo(),
    // init phase metrics (null when no worldbook given OR when
    // backgrounds were disabled and the worldbook was used as turn 1 instead)
    initializer: initResult
      ? {
          ran: true,
          ready: Boolean(initResult.ready),
          status: initResult.status || "",
          durationMs: initResult.durationMs || 0,
          filesChangedCount: initResult.filesChanged?.length || 0,
          filesChanged: (initResult.filesChanged || []).map((file) => file.path).slice(0, 30),
          summary: initResult.summary || "",
          error: initResult.error || null,
          // init phase cost is captured via runWithUsageProfile so it
          // shows up in cross-variant cost comparison (was previously hidden).
          usage: initUsage,
        }
      : { ran: false },
    player: {
      provider: "deepseek-eval",
      model: args.player.model,
      calls: playerSummary,
    },
    openovel: summarizeOpenovelUsage(openovelSummaries),
    // background jobs run outside the per-turn AsyncLocalStorage and
    // were previously not captured by openovel.* (which only reflects the
    // synchronous foreground profile). backgroundUsage.* is the real cost of
    // storykeeper/memory-review/signal/initializer/subagent calls. Total cost
    // for the openovel side = openovel.estimatedCostUSD + backgroundUsage.total.estimatedCostUSD.
    backgroundUsage: backgroundUsage || { byType: {}, total: { jobs: 0, modelCalls: 0, estimatedCostUSD: 0 } },
    contextGrowth: summarizeContextGrowth(turns),
    final: {
      inboxPending: finalSnapshot.backgroundInboxItems?.length || 0,
      foregroundGuidanceChars: String(finalSnapshot.foregroundGuidance || "").length,
      chapterChars: String(finalSnapshot.chapters || "").length,
      drainStatus: finalDrainStatus,
    },
  }
}

function summarizePlayerCalls(calls) {
  return calls.reduce(
    (acc, call) => {
      const usage = call.usage || {}
      acc.count++
      acc.durationMs += call.durationMs || 0
      acc.inputTokens += usage.inputTokens || 0
      acc.outputTokens += usage.outputTokens || 0
      acc.totalTokens += usage.totalTokens || 0
      acc.estimatedCostUSD = Number((acc.estimatedCostUSD + (call.cost?.estimatedUSD || 0)).toFixed(8))
      return acc
    },
    { count: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
  )
}

function summarizeOpenovelUsage(summaries) {
  return summaries.reduce(
    (acc, summary) => {
      acc.modelCalls += summary.modelCalls || 0
      acc.toolCalls += summary.toolCalls || 0
      acc.inputTokens += summary.inputTokens || 0
      acc.outputTokens += summary.outputTokens || 0
      acc.reasoningTokens += summary.reasoningTokens || 0
      acc.totalTokens += summary.totalTokens || 0
      // surface cumulative prompt-cache hit ratio in the eval report.
      // Healthy DeepSeek with a stable system prompt should hit ~70%+ past
      // turn 3; a low ratio across a 200-turn run is a smoking gun that the
      // system prompt is being rebuilt with volatile content each call.
      acc.cacheReadInputTokens += summary.cacheReadInputTokens || 0
      acc.cacheMissInputTokens += summary.cacheMissInputTokens || 0
      acc.estimatedCostUSD = Number((acc.estimatedCostUSD + (summary.estimatedCostUSD || 0)).toFixed(8))
      if (summary.firstFrameMs !== undefined) acc.firstFrameMs.push(summary.firstFrameMs)
      if (summary.lastFrameMs !== undefined) acc.lastFrameMs.push(summary.lastFrameMs)
      return acc
    },
    {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      estimatedCostUSD: 0,
      firstFrameMs: [],
      lastFrameMs: [],
    },
  )
}

function renderTranscript(summary, turns) {
  return [
    `# Model Player Eval ${summary.runId}`,
    "",
    `Goal: ${summary.goal}`,
    `Completed turns: ${summary.completedTurns}/${summary.requestedTurns}`,
    summary.stopReason ? `Stop reason: ${summary.stopReason}` : "",
    "",
    "## Summary",
    "",
    `- Player model: ${summary.player.model}`,
    `- Openovel foreground model calls: ${summary.openovel.modelCalls} ($${summary.openovel.estimatedCostUSD})`,
    `- Openovel background jobs: ${summary.backgroundUsage.total.jobs} ($${summary.backgroundUsage.total.estimatedCostUSD})`,
    `- Openovel TOTAL cost USD: $${Number(summary.openovel.estimatedCostUSD + summary.backgroundUsage.total.estimatedCostUSD).toFixed(6)}`,
    `- Player estimated cost USD: $${summary.player.calls.estimatedCostUSD}`,
    summary.openovel.inputTokens > 0
      ? `- Prompt cache hit ratio (foreground only): ${Math.round((summary.openovel.cacheReadInputTokens / summary.openovel.inputTokens) * 100)}% (${summary.openovel.cacheReadInputTokens}/${summary.openovel.inputTokens} input tokens)`
      : "",
    summary.backgroundUsage.total.modelCalls > 0
      ? `- Background usage by type: ${Object.entries(summary.backgroundUsage.byType).map(([t, b]) => `${t}=${b.jobs} ($${b.estimatedCostUSD})`).join(", ")}`
      : "",
    "",
    "## Turns",
    "",
    ...turns.flatMap((turn) => [
      `### Turn ${turn.turn}`,
      "",
      // surface the reader-feeling at the top of each turn so a
      // human scanner can read "what did the player feel while reading" in
      // one column without parsing JSON. Reader feeling for turn N is the
      // reaction to turn N-1's narration (since this turn's player call
      // happens AFTER reading the prior narration).
      turn.player.feeling ? `Reader feeling: _${turn.player.feeling}_` : "",
      "",
      `Player: ${turn.player.action}`,
      "",
      turn.player.rationale ? `Rationale: ${turn.player.rationale}` : "",
      "",
      "Openovel:",
      "",
      turn.openovel.narration,
      "",
      ...(turn.openovel.options?.length ? ["Options:", ...turn.openovel.options.map((item, index) => `${index + 1}. ${item}`), ""] : []),
    ]),
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function compactHistory(history = [], maxTurns = 8) {
  return history.slice(-maxTurns).map((turn) => ({
    turn: turn.turn,
    action: compact(turn.action, 300),
    narration: compact(turn.narration, 700),
    options: (turn.options || []).slice(0, 4),
    tension: turn.tension,
  }))
}

function publicJobInfo(job) {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  }
}

export function computeReaderPaceMs(narration = "", { cpmZh = 600, cpmEn = 1200 } = {}) {
  const text = String(narration || "")
  if (!text) return 0
  const cjk = /[㐀-鿿]/.test(text)
  const cpm = cjk ? cpmZh : cpmEn
  if (!Number.isFinite(cpm) || cpm <= 0) return 0
  return Math.round((text.length / cpm) * 60 * 1000)
}

async function readerPaceSleep(narration, reading) {
  const ms = computeReaderPaceMs(narration, reading)
  if (ms > 0) await sleep(ms)
}

async function waitForJobs(jobs, timeoutMs) {
  const started = Date.now()
  while (jobs.some((job) => job.status === "running")) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for jobs after ${timeoutMs}ms`)
    await sleep(250)
  }
}

async function waitForAllBackgroundJobs(timeoutMs) {
  const started = Date.now()
  let quietChecks = 0
  while (quietChecks < 2) {
    const running = backgroundJobs.list().filter((job) => job.status === "running")
    if (!running.length) {
      quietChecks++
      await sleep(250)
      continue
    }
    quietChecks = 0
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for all background jobs after ${timeoutMs}ms`)
    await sleep(250)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const out = { optionsEnabled: true, finalWaitBackground: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--goal") out.goal = argv[++i] || ""
    else if (arg.startsWith("--goal=")) out.goal = arg.slice("--goal=".length)
    else if (arg === "--persona") out.persona = argv[++i] || ""
    else if (arg.startsWith("--persona=")) out.persona = arg.slice("--persona=".length)
    else if (arg === "--player-mode") out.playerMode = argv[++i] || ""
    else if (arg.startsWith("--player-mode=")) out.playerMode = arg.slice("--player-mode=".length)
    else if (arg === "--turns") out.turns = Number(argv[++i])
    else if (arg.startsWith("--turns=")) out.turns = Number(arg.slice("--turns=".length))
    else if (arg === "--output-dir") out.outputDir = argv[++i]
    else if (arg.startsWith("--output-dir=")) out.outputDir = arg.slice("--output-dir=".length)
    else if (arg === "--story-root") out.storyRoot = argv[++i]
    else if (arg.startsWith("--story-root=")) out.storyRoot = arg.slice("--story-root=".length)
    else if (arg === "--run-id") out.runId = argv[++i]
    else if (arg.startsWith("--run-id=")) out.runId = arg.slice("--run-id=".length)
    else if (arg === "--player-model") out.playerModel = argv[++i]
    else if (arg.startsWith("--player-model=")) out.playerModel = arg.slice("--player-model=".length)
    else if (arg === "--player-base-url") out.playerBaseUrl = argv[++i]
    else if (arg.startsWith("--player-base-url=")) out.playerBaseUrl = arg.slice("--player-base-url=".length)
    else if (arg === "--wait-background") out.waitBackground = true
    else if (arg === "--final-no-wait-background") out.finalWaitBackground = false
    else if (arg === "--wait-every") out.waitEvery = Number(argv[++i])
    else if (arg.startsWith("--wait-every=")) out.waitEvery = Number(arg.slice("--wait-every=".length))
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i])
    else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice("--timeout-ms=".length))
    else if (arg === "--options") out.optionsEnabled = true
    else if (arg === "--no-options") out.optionsEnabled = false
    else if (arg === "--persist-profiles") out.persistProfiles = true
    else if (arg === "--opening-action") out.openingAction = argv[++i] || ""
    else if (arg.startsWith("--opening-action=")) out.openingAction = arg.slice("--opening-action=".length)
    else if (arg === "--worldbook") out.worldbook = argv[++i] || ""
    else if (arg.startsWith("--worldbook=")) out.worldbook = arg.slice("--worldbook=".length)
    else if (arg === "--worldbook-from") out.worldbookFromPath = argv[++i] || ""
    else if (arg.startsWith("--worldbook-from=")) out.worldbookFromPath = arg.slice("--worldbook-from=".length)
    else if (arg === "--worldbook-source-hint") out.worldbookSourceHint = argv[++i] || ""
    else if (arg.startsWith("--worldbook-source-hint=")) out.worldbookSourceHint = arg.slice("--worldbook-source-hint=".length)
    else if (arg === "--reading-cpm-zh") out.readingCpmZh = Number(argv[++i])
    else if (arg.startsWith("--reading-cpm-zh=")) out.readingCpmZh = Number(arg.slice("--reading-cpm-zh=".length))
    else if (arg === "--reading-cpm-en") out.readingCpmEn = Number(argv[++i])
    else if (arg.startsWith("--reading-cpm-en=")) out.readingCpmEn = Number(arg.slice("--reading-cpm-en=".length))
  }
  return out
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback
}

function compact(value, maxChars = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  // resolve --worldbook-from before passing to runModelPlayerEval so
  // the worldbook string is in-memory at config-write time.
  if (parsed.worldbookFromPath && !parsed.worldbook) {
    const { readFile } = await import("node:fs/promises")
    parsed.worldbook = await readFile(parsed.worldbookFromPath, "utf8")
    parsed.worldbookSourceHint = parsed.worldbookSourceHint || `file:${parsed.worldbookFromPath}`
  }
  const summary = await runModelPlayerEval(parsed)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
