import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadAgentConfigs } from "../src/agents/loadAgentConfigs.js"
import { buildResidentAgent, resolvePromptFn } from "../src/workflows/residents/buildResidentAgent.js"
import { isCoordinatorAlias, normalizeSubAgentEnvelope, subAgentBehavior } from "../src/workflows/residents/subAgent.js"
import { drainAgentMessages, enqueueAgentMessage, inboxQueuePath, setAgentInboxRegistry } from "../src/runtime/agentChannel.js"
import { broadcastTurn, resetResidentConfigs, getResidentConfigs, isResidentTeamEnabled, getCoordinatorConfig, signalShowrunnerHandoffsIfIdle } from "../src/runtime/residentTeam.js"
import { bus } from "../src/runtime/bus.js"

function withRoot() {
  const root = path.join(os.tmpdir(), `p5-team-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = root
  resetResidentConfigs()
  return root
}

function withImageEnv(values, run) {
  const keys = [
    "AI_STORY_CONFIG",
    "AI_STORY_CONFIG_CONTENT",
    "AI_STORY_CONFIG_DIR",
    "OPENOVEL_CONFIG",
    "OPENOVEL_CONFIG_CONTENT",
    "OPENOVEL_CONFIG_DIR",
    "OPENOVEL_IGNORE_PROJECT_CONFIG",
    "OPENOVEL_IMAGE_API_KEY",
    "OPENOVEL_IMAGE_BASE_URL",
    "OPENOVEL_IMAGE_MODEL",
    "OPENOVEL_IMAGE_PROVIDER",
  ]
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  const emptyConfigDir = path.join(os.tmpdir(), `p5-image-env-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.AI_STORY_CONFIG_DIR = emptyConfigDir
  process.env.OPENOVEL_CONFIG_DIR = emptyConfigDir
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  if (values?.provider) process.env.OPENOVEL_IMAGE_PROVIDER = values.provider
  if (values?.baseUrl) process.env.OPENOVEL_IMAGE_BASE_URL = values.baseUrl
  if (values?.apiKey) process.env.OPENOVEL_IMAGE_API_KEY = values.apiKey
  if (values?.model) process.env.OPENOVEL_IMAGE_MODEL = values.model
  try {
    return run()
  } finally {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("getResidentConfigs self-invalidates when the active story root changes", async () => {
  const rootA = withRoot()
  const a = await getResidentConfigs()
  assert.ok(a.length > 0)
  assert.ok(a.every((c) => c.threadPath.startsWith(rootA)), "first load binds to root A")

  // Flip the active story WITHOUT calling resetResidentConfigs (no switch call
  // site did): the stale cache kept story A's absolute thread/inbox paths live
  // for story B's turns, cross-contaminating both stories.
  const rootB = path.join(os.tmpdir(), `p5-team-b-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = rootB
  const b = await getResidentConfigs()
  assert.ok(b.every((c) => c.threadPath.startsWith(rootB)), "reload follows the new root")
  // The global inbox registry follows too: messages for story B land in B.
  assert.ok(inboxQueuePath("director").startsWith(rootB))
})

test("buildResidentAgent constructs every agent from its Agent Card", async () => {
  withRoot()
  const configs = await loadAgentConfigs({ formatEnabled: true })
  const byId = Object.fromEntries(configs.map((c) => [c.id, buildResidentAgent(c)]))
  assert.equal(byId.showrunner.id, "showrunner")
  assert.equal(byId.showrunner.kind, "story-maintenance-agent") // reuses the Storykeeper composer
  assert.equal(byId.worldkeeper.id, "worldkeeper")
  assert.ok(byId.worldkeeper.includeTools.includes("websearch"))
  assert.ok(byId.cards.includeTools.includes("webfetch"))
  // sub-agents have the generic lifecycle hooks
  assert.equal(typeof byId.director.buildInitialMessages, "function")
  assert.equal(typeof byId.director.drainQueuedContext, "function")
})

test("image agent receives generate_image only when image generation is configured", () => {
  const root = withRoot()
  const config = {
    id: "image",
    kind: "image-maintenance-agent",
    role: "subagent",
    prompt: "imageAgentContract",
    domain: "image",
    includeTools: ["read", "write", "grep", "glob", "websearch", "webfetch", "fetch_image", "generate_image"],
    threadPath: path.join(root, "image", "thread.jsonl"),
    threadSource: "image",
  }

  withImageEnv({}, () => {
    const agent = buildResidentAgent(config)
    const prompt = resolvePromptFn(config)()
    assert.ok(agent.includeTools.includes("fetch_image"))
    assert.equal(agent.includeTools.includes("generate_image"), false)
    assert.doesNotMatch(prompt, /generate_image/)
  })

  withImageEnv({ baseUrl: "https://img.example/v1", apiKey: "secret" }, () => {
    const agent = buildResidentAgent(config)
    const prompt = resolvePromptFn(config)()
    assert.ok(agent.includeTools.includes("fetch_image"))
    assert.equal(agent.includeTools.includes("generate_image"), false)
    assert.doesNotMatch(prompt, /generate_image/)
  })

  withImageEnv({ baseUrl: "https://img.example/v1", apiKey: "secret", model: "img-test" }, () => {
    const agent = buildResidentAgent(config)
    const prompt = resolvePromptFn(config)()
    assert.ok(agent.includeTools.includes("fetch_image"))
    assert.ok(agent.includeTools.includes("generate_image"))
    assert.match(prompt, /generate_image/)
  })
})

test("broadcastTurn fans a summary + pointer (never prose) to every agent inbox", async () => {
  withRoot()
  // broadcastTurn re-derives the roster from getResidentConfigs(), which reads
  // formatEnabled from the env (not from this test's loadAgentConfigs call), so
  // the env must enable the format-contract agent (render) for it to be in the
  // fan-out. Set it deterministically rather than rely on ambient leak.
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  try {
    await loadAgentConfigs({ formatEnabled: true }) // populates the channel inbox registry
    const longNarration = "字".repeat(5000)
    await broadcastTurn({
      event: "narration_generated",
      turnId: "turn_p5",
      action: "look around",
      foreground: { narration: longNarration, tension: "rising" },
    })

    for (const id of ["showrunner", "worldkeeper", "director", "cards", "memory", "render"]) {
      const msgs = await drainAgentMessages({ agent: id })
      assert.equal(msgs.length, 1, `${id} received the broadcast`)
      const m = msgs[0]
      assert.equal(m.type, "narration_generated")
      assert.equal(m.payload.narrativePointer.file, "chapters.recent.md")
      assert.equal(m.payload.narrativePointer.turnId, "turn_p5")
      assert.ok(m.payload.summary.length < 400, "summary is short")
      // the full 5000-char prose must NOT be in the message
      assert.ok(!JSON.stringify(m).includes("字".repeat(300)), "no full prose in the broadcast")
    }
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
  }
})

test("broadcastTurn carries a compacted chosen-effect when present, omits it otherwise", async () => {
  withRoot()
  await loadAgentConfigs({ formatEnabled: true })
  const longConsequence = "陷".repeat(5000)
  await broadcastTurn({
    event: "narration_generated",
    turnId: "turn_eff",
    action: "走过去开门",
    foreground: { narration: "她推开门。", tension: "rising" },
    selectedEffect: { intent: "开门", consequence: longConsequence, risk: "high", difficulty: "守卫警觉", stateHints: [{ key: "door", op: "set", value: "open" }] },
  })
  const wk = await drainAgentMessages({ agent: "worldkeeper" })
  assert.equal(wk.length, 1)
  assert.equal(wk[0].payload.selectedEffect.intent, "开门")
  assert.equal(wk[0].payload.selectedEffect.risk, "high")
  assert.ok(wk[0].payload.selectedEffect.consequence.length < 400, "consequence is compacted")
  assert.ok(!JSON.stringify(wk[0]).includes("陷".repeat(300)), "no full effect prose in the broadcast")

  // A free-typed turn (no selectedEffect) → no payload.selectedEffect at all.
  await broadcastTurn({ event: "narration_generated", turnId: "turn_free", action: "我等。", foreground: { narration: "夜更深了。", tension: "low" } })
  const wk2 = await drainAgentMessages({ agent: "worldkeeper" })
  assert.equal(wk2.length, 1)
  assert.equal("selectedEffect" in wk2[0].payload, false)
})

test("sub-agent buildContext renders the hidden chosen-effect block only when one is bound", async () => {
  withRoot()
  const behavior = subAgentBehavior({ id: "worldkeeper", domain: "worldkeeper" })
  const withEffect = await behavior.buildContext({
    input: {
      turnId: "t1",
      action: "走过去开门",
      selectedEffect: { intent: "开门", consequence: "门后埋伏", risk: "high", difficulty: "守卫警觉", reversible: false, stateHints: [{ key: "door", op: "set", value: "open", note: "玩家推门" }] },
    },
  })
  const md = withEffect.contextMarkdown
  assert.match(md, /## Chosen effect this turn/)
  assert.match(md, /intent: 开门/)
  assert.match(md, /consequence \(the next beat must honor this\): 门后埋伏/)
  assert.match(md, /risk: high/)
  assert.match(md, /difficulty seed: 守卫警觉/)
  assert.match(md, /key=door/)

  const without = await behavior.buildContext({ input: { turnId: "t2", action: "我等。" } })
  assert.equal(without.contextMarkdown.includes("Chosen effect this turn"), false)
})

test("normalizeSubAgentEnvelope coerces a sub-agent's status receipt", () => {
  const env = normalizeSubAgentEnvelope({
    status: "applied",
    summary: "  updated world state  ",
    filesTouched: ["story/worldkeeper/state.md", 7, ""],
    notes: ["a"],
    forShowrunner: ["raise the deadline pressure in active-pressures"],
    forAgents: [
      { to: "worldkeeper", priority: "now", type: "state_check", message: "validate the off-screen location" },
      { to: "", message: "drop me" },
      { to: "cards", request: "refresh character card triggers" },
    ],
    junk: "ignored",
  })
  assert.equal(env.status, "applied")
  assert.equal(env.summary, "updated world state")
  assert.deepEqual(env.filesTouched, ["story/worldkeeper/state.md", "7"])
  assert.equal(env.forShowrunner.length, 1)
  assert.deepEqual(env.forAgents, [
    { to: "worldkeeper", type: "state_check", priority: "now", message: "validate the off-screen location" },
    { to: "cards", type: "peer_request", priority: "next", message: "refresh character card triggers" },
  ])
  assert.equal("junk" in env, false)

  assert.equal(normalizeSubAgentEnvelope({}).status, "skipped")
  assert.equal(normalizeSubAgentEnvelope({ notes: ["tooling blocked"] }).status, "applied")
})

test("sub-agent forAgents routes to peer inbox and wakes an idle target hook", async () => {
  const root = withRoot()
  setAgentInboxRegistry([
    ["worldkeeper", path.join(root, "worldkeeper", "inbox.queue.jsonl")],
    ["director", path.join(root, "director", "inbox.queue.jsonl")],
  ])
  try {
    const wakes = []
    const behavior = subAgentBehavior({
      id: "director",
      domain: "director",
      wakeAgent: async (agent, input) => wakes.push({ agent, input }),
    })

    await behavior.apply(
      normalizeSubAgentEnvelope({
        status: "applied",
        summary: "routed",
        filesTouched: [],
        notes: [],
        forAgents: [
          { to: "worldkeeper", priority: "now", type: "state_check", message: "Can Jieyi plausibly be at Fuse-no-oji?" },
        ],
      }),
      { input: { turnId: "turn_peer", action: "walk", foreground: { tension: "rising" }, backgroundSignal: { tasks: [] } } },
    )

    const messages = await drainAgentMessages({ agent: "worldkeeper" })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].source, "director")
    assert.equal(messages[0].to, "worldkeeper")
    assert.equal(messages[0].type, "state_check")
    assert.match(messages[0].payload.message, /Jieyi/)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].agent, "worldkeeper")
    assert.equal(wakes[0].input.turnId, "turn_peer")
  } finally {
    setAgentInboxRegistry([])
  }
})

test("sub-agent forAgents addressed to the coordinator (any name) reroutes to its inbox instead of dropping", async () => {
  const root = withRoot()
  setAgentInboxRegistry([
    ["showrunner", path.join(root, "showrunner", "inbox.queue.jsonl")],
    ["director", path.join(root, "director", "inbox.queue.jsonl")],
    ["cards", path.join(root, "cards", "inbox.queue.jsonl")],
  ])
  try {
    const wakes = []
    const behavior = subAgentBehavior({
      id: "director",
      domain: "director",
      wakeAgent: async (agent, input) => wakes.push({ agent, input }),
    })

    await behavior.apply(
      normalizeSubAgentEnvelope({
        status: "applied",
        summary: "flagged canon drift",
        filesTouched: [],
        notes: [],
        forAgents: [
          // Legacy single-agent address should be remapped to the coordinator.
          { to: "storykeeper", priority: "now", type: "canon_repair", message: "canon contradicts BRIEF, restore the brief's setting" },
          // A genuinely unknown id still drops.
          { to: "nobody-here", message: "this one is dropped" },
        ],
      }),
      { input: { turnId: "turn_alias", action: "walk", foreground: null, backgroundSignal: null } },
    )

    const messages = await drainAgentMessages({ agent: "showrunner" })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].source, "director")
    assert.equal(messages[0].type, "subagent_recommendation")
    assert.equal(messages[0].priority, "now") // director reroutes keep the director's now-priority
    assert.match(messages[0].payload.recommendations[0], /canon contradicts BRIEF/)
    // No peer inbox got the message and no wake fired for the coordinator alias.
    assert.equal(wakes.length, 0)
    assert.deepEqual(await drainAgentMessages({ agent: "cards" }), [])
  } finally {
    setAgentInboxRegistry([])
  }
})

test("isCoordinatorAlias matches coordinator names case-insensitively and nothing else", () => {
  assert.equal(isCoordinatorAlias("storykeeper"), true)
  assert.equal(isCoordinatorAlias("Showrunner"), true)
  assert.equal(isCoordinatorAlias("coordinator"), true)
  assert.equal(isCoordinatorAlias("story-init", "story-init"), true)
  assert.equal(isCoordinatorAlias("worldkeeper"), false)
  assert.equal(isCoordinatorAlias(""), false)
})

test("director forShowrunner recommendations are now-priority handoffs", async () => {
  const root = withRoot()
  setAgentInboxRegistry([
    ["showrunner", path.join(root, "showrunner", "inbox.queue.jsonl")],
    ["director", path.join(root, "director", "inbox.queue.jsonl")],
  ])
  try {
    const behavior = subAgentBehavior({ id: "director", domain: "director" })
    const handoff = [
      "Director Handoff: sceneCandidate=bridge north bank;",
      "nextPressureBeat=[HIGH] The guard tests the key promise;",
      "difficultyNode=advance;",
      "openThreadDelta=reinforce;",
      `directedBeat=none ${"line-of-sight ".repeat(24)}KEEP_SUFFIX.`,
    ].join(" ")

    await behavior.apply(
      normalizeSubAgentEnvelope({
        status: "applied",
        summary: "sized next pressure",
        filesTouched: ["story/director/ARC.md"],
        notes: [],
        forShowrunner: [handoff],
      }),
      { input: { turnId: "turn_director", action: "walk", foreground: { tension: "rising" }, backgroundSignal: { tasks: [] } } },
    )

    const messages = await drainAgentMessages({ agent: "showrunner" })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].source, "director")
    assert.equal(messages[0].priority, "now")
    assert.equal(messages[0].type, "subagent_recommendation")
    assert.match(messages[0].payload.recommendations[0], /Director Handoff/)
    assert.match(messages[0].payload.recommendations[0], /KEEP_SUFFIX/)
  } finally {
    setAgentInboxRegistry([])
  }
})

test("resident team defaults ON; off only when explicitly disabled", () => {
  assert.equal(isResidentTeamEnabled({}), true) // unset → on (the new default)
  assert.equal(isResidentTeamEnabled({ OPENOVEL_RESIDENT_TEAM: "true" }), true)
  assert.equal(isResidentTeamEnabled({ OPENOVEL_RESIDENT_TEAM: "1" }), true)
  assert.equal(isResidentTeamEnabled({ OPENOVEL_RESIDENT_TEAM: "0" }), false)
  assert.equal(isResidentTeamEnabled({ OPENOVEL_RESIDENT_TEAM: "off" }), false)
  assert.equal(isResidentTeamEnabled({ OPENOVEL_RESIDENT_TEAM: "false" }), false)
})

test("a brand-new agent can be defined entirely from config (inline systemPrompt, no code)", () => {
  // A third party drops a YAML with an inline prompt — no JS edit, no registry entry.
  const text = resolvePromptFn({
    id: "lorekeeper",
    role: "subagent",
    domain: "lorekeeper",
    systemPrompt: "You are the Lore Keeper. Maintain a wiki of world lore under your domain.",
    includeContract: true,
  })()
  assert.match(text, /Lore Keeper/) // the author's own prompt
  assert.match(text, /<agent_contract>/) // shared safety contract auto-prepended
  assert.match(text, /forShowrunner/) // sub-agent output envelope auto-appended
  assert.match(text, /forAgents/) // peer-agent output envelope auto-appended
})

test("includeContract:false keeps a custom prompt verbatim", () => {
  assert.equal(resolvePromptFn({ id: "x", role: "subagent", systemPrompt: "RAW PROMPT", includeContract: false })().trim(), "RAW PROMPT")
})

test("a config with no prompt throws a helpful error listing the options", () => {
  assert.throws(() => resolvePromptFn({ id: "x", role: "subagent" }), /systemPrompt.*promptFile.*prompt/s)
})

test("named built-in prompts still resolve (batteries included)", () => {
  assert.match(resolvePromptFn({ id: "worldkeeper", role: "subagent", prompt: "worldKeeperContract" })(), /World Keeper/)
})

test("director handoff is a first-class resident-team contract", () => {
  const directorPrompt = resolvePromptFn({ id: "director", role: "subagent", prompt: "directorContract" })()
  assert.match(directorPrompt, /DIRECTOR FRONTEND HANDOFF/)
  assert.match(directorPrompt, /sceneCandidate/)
  assert.match(directorPrompt, /directedBeat/)

  const showrunnerPrompt = resolvePromptFn({ id: "showrunner", role: "coordinator", prompt: "showrunnerContract" })()
  assert.match(showrunnerPrompt, /Director handoffs are high-priority composition inputs/)
  assert.match(showrunnerPrompt, /inboxNotes/)
})

// Regression: generated image assets can be handed to Showrunner while Render
// Manager correctly declines frontend writes. Showrunner must own the
// rich-rendering permission so the narrator learns those assets exist.
test("showrunner contract owns rich-rendering handoffs when the format contract is on", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  try {
    const prompt = resolvePromptFn({ id: "showrunner", role: "coordinator", prompt: "showrunnerContract" })()
    assert.match(prompt, /RICH-RENDERING HANDOFFS/)
    assert.match(prompt, /story\/frontend\/rich-rendering\.md/)
    assert.match(prompt, /@include story\/frontend\/rich-rendering\.md/)
    assert.match(prompt, /Do NOT spend your composition pass on open-web research/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
  }
})

test("showrunner plain-blocks prompt composes only reserved render-channel handoffs", () => {
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  try {
    const prompt = resolvePromptFn({ id: "showrunner", role: "coordinator", prompt: "showrunnerContract" })()
    assert.match(prompt, /RESERVED RENDERING HANDOFFS/)
    assert.match(prompt, /PLAIN BLOCKS/)
    assert.match(prompt, /reserved ```ovl:hud```/)
    assert.match(prompt, /story\/format\/blocks\/ is frozen/)
    assert.doesNotMatch(prompt, /RICH-RENDERING HANDOFFS are first-class/)
    assert.doesNotMatch(prompt, /each kind named by its LITERAL/)
    assert.doesNotMatch(prompt, /A rich-rendering\.md still sitting at its placeholder while story\/format\/blocks\//)
    assert.doesNotMatch(prompt, /ovl:<kind>/)
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
  }
})

// Race fix: the Showrunner often finishes before the sub-agents, so the last
// finisher must signal when its forShowrunner handoffs are still unconsumed —
// otherwise generated assets wait for the next reader turn (or forever).
test("last-finishing sub-agent signals pending Showrunner handoffs over the bus", async () => {
  withRoot()
  await loadAgentConfigs({ formatEnabled: true })
  const coord = await getCoordinatorConfig()
  assert.ok(coord, "coordinator config resolves")

  // Empty coordinator inbox → no signal.
  await drainAgentMessages({ agent: coord.id }).catch(() => [])
  const quiet = await signalShowrunnerHandoffsIfIdle({ completedAgent: "image", turnId: "turn_w1" })
  assert.equal(quiet.signaled, false)
  assert.equal(quiet.reason, "no-pending")

  // Pending handoff in the coordinator inbox → bus event fires.
  await enqueueAgentMessage(
    { from: "image", to: coord.id, type: "subagent_recommendation", turnId: "turn_w1", payload: { forShowrunner: ["embed story/includes/bg/x.jpg"] } },
    { queuePath: coord.inboxPath },
  )
  const events = []
  const unsubscribe = bus.subscribe("resident.handoffs.pending", (event) => events.push(event))
  try {
    const signaled = await signalShowrunnerHandoffsIfIdle({ completedAgent: "image", turnId: "turn_w1" })
    assert.equal(signaled.signaled, true)
    assert.equal(events.length, 1)
    assert.equal(events[0].properties.completedAgent, "image")
    assert.equal(events[0].properties.coordinator, coord.id)
  } finally {
    unsubscribe()
  }
})

test("a custom-prompt config builds into a runnable agent via the generic behavior", () => {
  const agent = buildResidentAgent({
    id: "lorekeeper",
    kind: "lore-agent",
    role: "subagent",
    domain: "lorekeeper",
    modelProfile: "storykeeper",
    maxSteps: 12,
    maxTokens: 5000,
    temperature: 0.3,
    toolConcurrency: 2,
    includeTools: ["read", "edit", "write", "grep", "glob"],
    writeScope: ["story/lorekeeper/**"],
    readScope: ["story/**"],
    systemPrompt: "You are the Lore Keeper.",
    includeContract: true,
    threadPath: "/tmp/lorekeeper/thread.jsonl",
  })
  assert.equal(agent.id, "lorekeeper")
  assert.equal(typeof agent.buildInitialMessages, "function")
  assert.equal(typeof agent.drainQueuedContext, "function")
})

test("broadcastTurn leaves a turnBroadcastWhen-ineligible agent out of the fan-out (plain-blocks mode)", async () => {
  withRoot()
  const savedFormat = process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
  const savedBlocks = process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
  process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
  // The reader displays custom blocks in plain host style: render's
  // `turnBroadcastWhen: custom-rich-blocks` makes it message-woken only.
  process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
  try {
    await loadAgentConfigs({ formatEnabled: true })
    await broadcastTurn({
      event: "narration_generated",
      turnId: "turn_plain",
      action: "看看四周",
      foreground: { narration: "夜色沉了下来。", tension: "low" },
    })
    for (const id of ["showrunner", "worldkeeper", "director", "cards", "memory"]) {
      const msgs = await drainAgentMessages({ agent: id })
      assert.equal(msgs.length, 1, `${id} still receives the broadcast`)
    }
    assert.equal((await drainAgentMessages({ agent: "render" })).length, 0, "render is skipped, no stale backlog")

    // Flip the display pref back on: eligibility is re-evaluated per broadcast,
    // no config reload needed — render rejoins the fan-out immediately.
    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "1"
    await broadcastTurn({
      event: "narration_generated",
      turnId: "turn_styled",
      action: "继续",
      foreground: { narration: "灯亮了。", tension: "low" },
    })
    assert.equal((await drainAgentMessages({ agent: "render" })).length, 1, "render rejoins when styling is back on")
  } finally {
    if (savedFormat === undefined) delete process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT
    else process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = savedFormat
    if (savedBlocks === undefined) delete process.env.OPENOVEL_CUSTOM_RICH_BLOCKS
    else process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = savedBlocks
  }
})

test("config cache + registries are slotted per root: a left story's tail run does not evict or clobber the new story", async () => {
  const rootA = withRoot()
  const a = await getResidentConfigs()
  assert.ok(a.every((c) => c.threadPath.startsWith(rootA)))

  const rootB = path.join(os.tmpdir(), `p5-team-b2-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  process.env.OPENOVEL_STORY_ROOT = rootB
  const b = await getResidentConfigs()
  assert.ok(b.every((c) => c.threadPath.startsWith(rootB)))

  // Story A's agent finishing after the switch (pinned to root A) resolves A's
  // configs from cache — and A's inbox addresses, not B's. A single global
  // inbox registry once routed this tail-end message into B's queue.
  process.env.OPENOVEL_STORY_ROOT = rootA
  const aAgain = await getResidentConfigs()
  assert.equal(aAgain, a, "root A's configs are cached, not reloaded")
  assert.ok(inboxQueuePath("director").startsWith(rootA))

  // ...and B's slot survived A's tail-end resolution untouched.
  process.env.OPENOVEL_STORY_ROOT = rootB
  assert.equal(await getResidentConfigs(), b)
  assert.ok(inboxQueuePath("director").startsWith(rootB))
})
