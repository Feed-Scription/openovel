import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Isolate from the developer's real config + keys. settingsEnv() walks
// projectConfigDirs UP from cwd (reaching ~/.openovel when the repo lives under
// $HOME), and providerRoute reads keys from there + process.env. Pin a temp
// home, ignore project config, and clear provider key env so hasModelKey() is
// deterministically FALSE — the narrator then takes its no-key fallback path
// and preview_narration returns deterministic prose with no network call.
process.env.OPENOVEL_HOME = path.join(os.tmpdir(), `openovel-initpreview-${Date.now()}`)
process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
for (const k of [
  "AI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY",
  "MIMO_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_ALLOW_PAID_FALLBACK",
]) delete process.env[k]
delete process.env.OPENOVEL_ENABLE_INIT_NARRATOR_PREVIEW

const {
  STORY_INIT_SYSTEM_PROMPT,
  buildStoryInitAgentConfig,
  buildStoryInitTeamConfigs,
  buildStoryInitToolPlan,
  buildNarratorPreviewAddendum,
  createStoryInitAgent,
  isStoryInitTeamEnabled,
  isInitNarratorPreviewEnabled,
  runPendingInitInboxWaves,
  storyInitSubAgentSystemPrompt,
} = await import("../src/workflows/storyInitWorkflow.js")
const { initSubAgentBehavior } = await import("../src/workflows/residents/initSubAgent.js")
const { storykeeperSystemPrompt } = await import("../src/workflows/storykeeperContext.js")
const { enqueueAgentMessage, listAgentMessages, setAgentInboxRegistry } = await import("../src/runtime/agentChannel.js")

const TOGGLE = "OPENOVEL_ENABLE_INIT_NARRATOR_PREVIEW"
const INIT_COORDINATION_TOOLS = ["task", "task_status", "agent_message", "monitor", "loop"]

// ── Static init prompt: required style anchor ────────────────────────────────

test("init prompt REQUIRES a reader style anchor offered via ask_user and persisted to tone.md", () => {
  const p = STORY_INIT_SYSTEM_PROMPT
  assert.match(p, /LOCK THE READER'S STYLE ANCHOR/)
  assert.match(p, /REQUIRED/)
  // The reader picks by READING actual example prose, not a style name…
  assert.match(p, /example sentence/i)
  assert.match(p, /ask_user/)
  // …and the fix: the example sentence itself must be the option label (the
  // prose the reader reads), not a style name with an explanation.
  assert.match(p, /EXAMPLE SENTENCE ITSELF in each option's `label`/)
  // …and the pick is written into tone.md as a load-bearing, exactly-shaped block.
  assert.match(p, /读者认定的风格锚点（叙述者必须贴合此声音）/)
  assert.match(p, /story\/frontend\/tone\.md/)
})

test("init style-anchor step guards against spoilers (voice samples, not plot)", () => {
  assert.match(STORY_INIT_SYSTEM_PROMPT, /SPOILER GUARD/)
})

// ── Loosened, no-spoiler ask_user policy ─────────────────────────────────────

test("init ask_user policy is confirmation-friendly but forbids spoilers", () => {
  const p = STORY_INIT_SYSTEM_PROMPT
  assert.match(p, /LEAN TOWARD asking and CONFIRMING/)
  assert.match(p, /SEVERAL DISTINCT questions/)
  assert.match(p, /HARD RULE, NO SPOILERS/)
  assert.match(p, /never reveal or hint at future plot/)
  // The old hard cap is gone (it fought the confirmation policy).
  assert.doesNotMatch(p, /max 1-2 total/)
  assert.doesNotMatch(p, /call ask_user with ONE concise question/)
})

test("init prompt uses brief-first conflict arbitration instead of asking about generated drift", async () => {
  assert.match(STORY_INIT_SYSTEM_PROMPT, /BRIEF-FIRST CONFLICT ARBITRATION/)
  assert.match(STORY_INIT_SYSTEM_PROMPT, /Do NOT ask the reader to choose among conflicting generated files/)

  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-brief-arb-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const agent = createStoryInitAgent({
      intent: "继续初始化",
      depth: "standard",
      env: {},
      originalBrief: "主角在春末的熊野古道旅店开始故事。",
    })
    const prepared = await agent.buildInitialMessages({ input: { intent: "继续初始化", depth: "standard" } })
    const system = prepared.messages[0].content
    assert.match(system, /BRIEF WINS ON CONFLICT/)
    assert.match(system, /主角在春末的熊野古道旅店开始故事/)
    assert.match(system, /compacted\/truncated context contradict this brief/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("init sub-agent context carries the brief and brief-first conflict rule", async () => {
  const prompt = storyInitSubAgentSystemPrompt({ id: "director", domain: "director" })
  assert.match(prompt, /BRIEF-FIRST conflict rule/)

  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-subagent-brief-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    await initializeStory()
    await writeFile(paths.brief, "# Story Brief\n\n熊野古道的季节是春末。", "utf8")
    const behavior = initSubAgentBehavior({ id: "director", domain: "director" })
    const { contextMarkdown } = await behavior.buildContext({
      input: {
        turnId: "init_test",
        depth: "standard",
        intent: "继续初始化",
        originalBrief: "fallback brief",
        initPlan: "已确认：季节按春末处理；语气锚点保持清亮克制。",
        history: [],
      },
    })
    assert.match(contextMarkdown, /## User Brief/)
    assert.match(contextMarkdown, /熊野古道的季节是春末/)
    assert.match(contextMarkdown, /## Confirmed Init Plan/)
    assert.match(contextMarkdown, /季节按春末处理/)
    assert.match(contextMarkdown, /the brief wins/)
    assert.match(contextMarkdown, /compacted\/truncated context contradict/)
    assert.match(contextMarkdown, /reader's preferred story language/)
    assert.match(contextMarkdown, /Do not import only English AI-writing tells/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("story-init render sub-agent prompt respects plain-blocks mode", () => {
  const env = {
    OPENOVEL_ENABLE_FORMAT_CONTRACT: "true",
    OPENOVEL_CUSTOM_RICH_BLOCKS: "0",
    OPENOVEL_ENABLE_STORY_INCLUDES: "true",
    OPENOVEL_ENABLE_IMAGE_BACKGROUND: "true",
  }
  const prompt = storyInitSubAgentSystemPrompt({ id: "render", domain: "render" }, { env })

  assert.match(prompt, /PLAIN BLOCKS mode/)
  assert.match(prompt, /reserved render channels/)
  assert.match(prompt, /story\/format\/config\.json/)
  assert.doesNotMatch(prompt, /<format_contract>/)
  assert.doesNotMatch(prompt, /author the per-story format contract NOW/)
  assert.doesNotMatch(prompt, /DELIVER A COMPLETE, STYLED CONTRACT/)
  assert.doesNotMatch(prompt, /ovl:<kind>/)
  assert.doesNotMatch(prompt, /ovl:music|music cues|now-playing/)
})

test("story-init render sub-agent prompt exposes music only when enabled in env", () => {
  const off = storyInitSubAgentSystemPrompt(
    { id: "render", domain: "render" },
    {
      env: {
        OPENOVEL_ENABLE_FORMAT_CONTRACT: "true",
        OPENOVEL_CUSTOM_RICH_BLOCKS: "0",
        OPENOVEL_ENABLE_IMAGE_BACKGROUND: "true",
      },
    },
  )
  assert.doesNotMatch(off, /ovl:music|music cues|now-playing/)

  const on = storyInitSubAgentSystemPrompt(
    { id: "render", domain: "render" },
    {
      env: {
        OPENOVEL_ENABLE_FORMAT_CONTRACT: "true",
        OPENOVEL_CUSTOM_RICH_BLOCKS: "0",
        OPENOVEL_ENABLE_IMAGE_BACKGROUND: "true",
        OPENOVEL_ENABLE_MUSIC_GEN: "true",
      },
    },
  )
  assert.match(on, /hud\/include\/bg\/music/)
  assert.match(on, /music cues/)
})

test("story-init image sub-agent orders character sheets before the opening illustration", () => {
  const env = {
    OPENOVEL_ENABLE_IMAGE_GEN: "true",
    OPENOVEL_ENABLE_CHARACTER_SHEETS: "true",
  }
  const prompt = storyInitSubAgentSystemPrompt({ id: "image", domain: "image" }, { env })
  assert.match(prompt, /SHEET-FIRST ORDER applies at init too/)
  // The init remit carries the same structural composition spec as play-time.
  assert.match(prompt, /SHEET COMPOSITION/)
  const cover = prompt.indexOf("STORY COVER (init deliverable")
  const sheets = prompt.indexOf("CHARACTER SHEETS (init deliverable")
  const opening = prompt.indexOf("OPENING ILLUSTRATION (init suggestion")
  assert.ok(cover >= 0 && sheets >= 0 && opening >= 0, "all three image init remits ride the prompt")
  // The remits appear in the order the work must happen: the model plans in
  // reading order, and the old cover -> illustration -> sheets order taught it
  // to illustrate before the cast sheets existed.
  assert.ok(cover < sheets && sheets < opening, "remit order is cover -> sheets -> opening illustration")

  const off = storyInitSubAgentSystemPrompt({ id: "image", domain: "image" }, { env: { OPENOVEL_ENABLE_IMAGE_GEN: "true" } })
  assert.doesNotMatch(off, /CHARACTER SHEETS \(init deliverable/)
  assert.match(off, /OPENING ILLUSTRATION \(init suggestion/)
})

test("init dispatch phase: the single coordinator prompt carries the recommended flow + dispatch directives", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-dispatch-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const team = await buildStoryInitTeamConfigs({ depth: "standard", env: {} })
    const agent = createStoryInitAgent({
      intent: "熊野古道旅店，春末，轻悬疑",
      depth: "standard",
      env: {},
      originalBrief: "熊野古道旅店，春末，轻悬疑",
      team: { enabled: true, phase: "dispatch", subagents: team.subagents },
    })
    // The coordinator owns write + agent_message; the read-only gate is now a
    // prompt recommendation, not a tool boundary.
    assert.ok(agent.includeTools.includes("write"))
    assert.ok(agent.includeTools.includes("agent_message"))
    assert.ok(agent.includeTools.includes("ask_user"))
    const prepared = await agent.buildInitialMessages({})
    const system = prepared.messages[0].content
    assert.match(system, /RECOMMENDED EXECUTION FLOW/)
    assert.match(system, /ACTIVE PHASE: DISPATCH/)
    assert.match(system, /LOCK THE READER STYLE ANCHOR/)
    assert.match(system, /DO NOT do heavy domain work yourself/)
    assert.match(system, /type=init_assignment/)
    assert.match(system, /Priority is the staging order/)
    assert.match(system, /AVAILABLE RESIDENT INIT AGENTS/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("init team mode: dispatch render/image when in the roster, and drop the self-author addendum", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `initrich-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const env = { OPENOVEL_ENABLE_FORMAT_CONTRACT: "true", OPENOVEL_ENABLE_IMAGE_GEN: "true" }
    const dispatch = (subagents) => createStoryInitAgent({
      intent: "x", depth: "deep", env, originalBrief: "x",
      team: { enabled: true, phase: "dispatch", subagents },
    }).buildInitialMessages({})

    const withRich = (await dispatch([{ id: "render" }, { id: "image" }, { id: "worldkeeper" }])).messages[0].content
    assert.match(withRich, /RICH RENDERING \/ ILLUSTRATIONS ARE ENABLED/)
    assert.match(withRich, /format contract to the render sub-agent/)
    assert.match(withRich, /illustrations to the image sub-agent/)
    // In team mode the render sub-agent owns the contract, so the coordinator is
    // NOT also told to author one itself (the old contradictory path).
    assert.doesNotMatch(withRich, /PROTOCOL PRE-GENERATION/)

    // No render/image in the roster (toggles off) → no rich-dispatch line.
    const noRich = (await dispatch([{ id: "worldkeeper" }, { id: "director" }])).messages[0].content
    assert.doesNotMatch(noRich, /RICH RENDERING \/ ILLUSTRATIONS ARE ENABLED/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

// ── Toggle wiring: tool whitelist + prompt addendum in lockstep ──────────────

test("toggle OFF (default): preview_narration absent and no addendum, both depths", () => {
  for (const depth of ["standard", "deep"]) {
    const plan = buildStoryInitToolPlan({ depth, env: {} })
    assert.equal(plan.narratorPreviewEnabled, false, depth)
    assert.equal(plan.includeTools.includes("preview_narration"), false, `${depth}: tool absent`)
    assert.equal(plan.narratorPreviewAddendum, "", `${depth}: no addendum`)
    for (const tool of INIT_COORDINATION_TOOLS) {
      assert.ok(plan.includeTools.includes(tool), `${depth}: keeps ${tool}`)
    }
  }
})

test("toggle ON: preview_narration joins includeTools + addendum present, both depths", () => {
  const env = { [TOGGLE]: "1" }
  for (const depth of ["standard", "deep"]) {
    const plan = buildStoryInitToolPlan({ depth, env })
    assert.equal(plan.narratorPreviewEnabled, true, depth)
    assert.ok(plan.includeTools.includes("preview_narration"), `${depth}: tool present`)
    assert.match(plan.narratorPreviewAddendum, /preview_narration/, `${depth}: addendum present`)
    // The base whitelist is preserved (deep keeps its research tools).
    assert.ok(plan.includeTools.includes("ask_user"), `${depth}: keeps ask_user`)
    for (const tool of INIT_COORDINATION_TOOLS) {
      assert.ok(plan.includeTools.includes(tool), `${depth}: keeps ${tool}`)
    }
  }
})

test("story init agent config carries only mode-specific differences", () => {
  const standard = buildStoryInitAgentConfig({ depth: "standard", env: {} })
  assert.equal(standard.id, "story-init")
  assert.equal(standard.kind, "story-initializer-agent")
  assert.equal(standard.modelProfile, "large")
  assert.equal(standard.json, false)
  assert.equal(standard.maxSteps, 24)
  assert.equal(standard.maxTokens, 12000)
  assert.equal(standard.toolResultWindow, undefined)
  assert.equal(standard.initTeamEnabled, true)
  assert.ok(standard.includeTools.includes("ask_user"))
  for (const tool of INIT_COORDINATION_TOOLS) {
    assert.ok(standard.includeTools.includes(tool), `standard has ${tool}`)
  }

  const deep = buildStoryInitAgentConfig({ depth: "deep", env: { [TOGGLE]: "1" } })
  assert.equal(deep.maxSteps, 200)
  assert.equal(deep.maxTokens, 24000)
  assert.equal(deep.toolResultWindow, 25)
  assert.equal(deep.assistantArgsWindow, 25)
  for (const tool of INIT_COORDINATION_TOOLS) {
    assert.ok(deep.includeTools.includes(tool), `deep has ${tool}`)
  }
  assert.ok(deep.includeTools.includes("preview_narration"))
})

test("story init team defaults on and can be explicitly disabled", () => {
  assert.equal(isStoryInitTeamEnabled({}), true)
  assert.equal(isStoryInitTeamEnabled({ OPENOVEL_INIT_AGENT_TEAM: "0" }), false)
  assert.equal(isStoryInitTeamEnabled({ OPENOVEL_STORY_INIT_TEAM: "off" }), false)
  assert.equal(isStoryInitTeamEnabled({ OPENOVEL_INIT_AGENT_TEAM: "1" }), true)
})

test("story init team config reuses resident domains with init-only differences", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-team-config-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const team = await buildStoryInitTeamConfigs({ depth: "standard", env: {} })
    assert.equal(team.coordinator.id, "story-init")
    assert.deepEqual(team.coordinator.writeScope, ["story/frontend/**", "story/guidance/**"])
    for (const tool of INIT_COORDINATION_TOOLS) {
      assert.ok(team.coordinator.includeTools.includes(tool), `story-init coordinator has ${tool}`)
    }

    const byId = Object.fromEntries(team.subagents.map((c) => [c.id, c]))
    assert.ok(byId.worldkeeper)
    assert.ok(byId.director)
    assert.ok(byId.cards)
    assert.ok(byId.memory)
    assert.equal(byId.music, undefined)
    assert.equal(byId.worldkeeper.coordinatorId, "story-init")
    assert.equal(typeof byId.worldkeeper.behaviorFactory, "function")
    assert.match(byId.worldkeeper.systemPrompt, /story initialization team/)
    assert.ok(byId.worldkeeper.maxSteps <= 16)
    assert.ok(byId.cards.writeScope.includes("story/context-cards/**"))
    for (const config of team.subagents) {
      assert.ok(config.includeTools.includes("websearch"), `${config.id} has websearch during init`)
      assert.ok(config.includeTools.includes("webfetch"), `${config.id} has webfetch during init`)
    }
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("story-init coordinator plain-blocks prompt avoids custom block dispatch/composition", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-team-plain-blocks-${Date.now()}`)
  const env = {
    OPENOVEL_ENABLE_FORMAT_CONTRACT: "true",
    OPENOVEL_CUSTOM_RICH_BLOCKS: "0",
    OPENOVEL_ENABLE_STORY_INCLUDES: "true",
  }
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const team = await buildStoryInitTeamConfigs({ depth: "standard", env })
    const byId = Object.fromEntries(team.subagents.map((c) => [c.id, c]))
    assert.ok(byId.render)
    assert.equal(byId.render.customBlocksDisplayed, false)
    assert.match(byId.render.systemPrompt, /PLAIN BLOCKS mode/)
    assert.doesNotMatch(byId.render.systemPrompt, /<format_contract>/)

    const dispatchAgent = createStoryInitAgent({
      intent: "初始化一个有图片但卡片样式关闭的故事",
      depth: "standard",
      env,
      team: { enabled: true, phase: "dispatch", subagents: team.subagents },
    })
    const dispatch = await dispatchAgent.buildInitialMessages({})
    const dispatchSystem = dispatch.messages[0].content
    assert.match(dispatchSystem, /reserved render-channel config/)
    assert.match(dispatchSystem, /PLAIN BLOCKS mode/)
    assert.match(dispatchSystem, /must NOT design custom block kinds/)
    assert.doesNotMatch(dispatchSystem, /render agent designs a format contract/)
    assert.doesNotMatch(dispatchSystem, /ovl:<kind>/)

    const composeAgent = createStoryInitAgent({
      intent: "初始化一个有图片但卡片样式关闭的故事",
      depth: "standard",
      env,
      team: { enabled: true, phase: "compose", subAgentIds: ["render"], subagents: team.subagents },
    })
    const compose = await composeAgent.buildInitialMessages({})
    const composeSystem = compose.messages[0].content
    assert.match(composeSystem, /RICH-RENDERING FRONTEND, PLAIN BLOCKS MODE/)
    assert.match(composeSystem, /reserved ```ovl:hud```/)
    assert.doesNotMatch(composeSystem, /ovl:<kind>/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("agent_message tool queues an init repair request to a resident Agent inbox", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-agent-message-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
    const { registerDefaultTools } = await import("../src/tools/registerTools.js")
    await initializeStory()
    setAgentInboxRegistry([["director", path.join(paths.root, "director", "inbox.queue.jsonl")]])
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const tool = registry.get("agent_message")
    assert.ok(tool)
    assert.equal(tool.exposeToModel, false)
    const res = await tool.execute({
      agent: "director",
      message: "Repair ARC.md season to match story/BRIEF.md: spring-late, not summer.",
    }, { agent: "story-init", turnId: "init_test" })
    assert.match(res.output, /queued init_repair_request for director/)
    const messages = await listAgentMessages({ agent: "director", status: "pending" })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, "init_repair_request")
    assert.equal(messages[0].source, "story-init")
    assert.match(messages[0].payload.message, /spring-late/)
  } finally {
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("agent_message tool explains unknown init agent ids with available ids and fuzzy suggestions", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-agent-message-suggest-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
    const { registerDefaultTools } = await import("../src/tools/registerTools.js")
    await initializeStory()
    setAgentInboxRegistry([
      ["worldkeeper", path.join(paths.root, "worldkeeper", "inbox.queue.jsonl")],
      ["cards", path.join(paths.root, "cards", "inbox.queue.jsonl")],
    ])
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const tool = registry.get("agent_message")

    const worldValidation = await tool.validate({ agent: "init-world", message: "Seed world state from story/BRIEF.md." })
    assert.equal(worldValidation.ok, false)
    assert.match(worldValidation.message, /unknown agent: init-world/)
    assert.match(worldValidation.message, /available agents: cards, worldkeeper/)
    assert.match(worldValidation.message, /available agent descriptions:/)
    assert.match(worldValidation.message, /- cards: owns context cards/)
    assert.match(worldValidation.message, /- worldkeeper: owns world logic/)
    assert.match(worldValidation.message, /did you mean: worldkeeper/)

    const cardsValidation = await tool.validate({ agent: "init-character-cards", message: "Create context cards from story/BRIEF.md." })
    assert.equal(cardsValidation.ok, false)
    assert.match(cardsValidation.message, /unknown agent: init-character-cards/)
    assert.match(cardsValidation.message, /did you mean: cards/)

    const direct = await tool.execute({
      agent: "init-world",
      type: "init_assignment",
      message: "Seed world state from story/BRIEF.md.",
    }, { agent: "story-init", turnId: "init_test" })
    assert.equal(direct.isError, true)
    assert.match(direct.output, /unknown agent: init-world/)

    const worldMessages = await listAgentMessages({ agent: "worldkeeper", status: "pending" })
    const cardMessages = await listAgentMessages({ agent: "cards", status: "pending" })
    assert.equal(worldMessages.length, 0)
    assert.equal(cardMessages.length, 0)
  } finally {
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("init sub-agent first round can be launched by an inbox assignment", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-subagent-inbox-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    await initializeStory()
    setAgentInboxRegistry([["director", path.join(paths.root, "director", "inbox.queue.jsonl")]])
    await enqueueAgentMessage({
      from: "story-init",
      to: "director",
      type: "init_assignment",
      priority: "now",
      turnId: "init_test",
      payload: {
        from: "story-init",
        message: "Use story/BRIEF.md as canonical. Seed director/ARC.md for the spring-late Kumano setup and hand pacing implications to forShowrunner.",
      },
    })
    const behavior = initSubAgentBehavior({ id: "director", domain: "director" })
    const injected = await behavior.drainQueuedContext({ input: { turnId: "init_test" } })
    assert.equal(injected.length, 1)
    assert.match(injected[0].content, /init_assignment/)
    assert.match(injected[0].content, /spring-late Kumano/)
    assert.match(injected[0].content, /story-init/)
    const pending = await listAgentMessages({ agent: "director", status: "pending" })
    assert.equal(pending.length, 0)
  } finally {
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("init inbox assignments run in priority waves instead of one global fan-out", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-priority-waves-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const team = await buildStoryInitTeamConfigs({ depth: "standard", env: {} })
    setAgentInboxRegistry(team.all.map((config) => [config.id, config.inboxPath]))
    for (const [agent, priority] of [["director", "next"], ["cards", "now"], ["memory", "later"]]) {
      await enqueueAgentMessage({
        from: "story-init",
        to: agent,
        type: "init_assignment",
        priority,
        turnId: "init_test",
        payload: { from: "story-init", message: `${agent} assignment` },
      })
    }

    const calls = []
    const runtime = {
      async run({ agent, input }) {
        calls.push({ agent: agent.id, priority: input.initInboxPriority, wave: input.initInboxWave })
        await agent.drainQueuedContext?.({ input, bus: null })
        return { ok: true }
      },
    }
    const completed = await runPendingInitInboxWaves({
      team,
      runtime,
      input: { turnId: "init_test", intent: "测试", depth: "standard" },
      reason: "test-priority",
    })

    assert.deepEqual(calls.map((call) => call.agent), ["cards", "director", "memory"])
    assert.deepEqual(calls.map((call) => call.priority), ["now", "next", "later"])
    assert.deepEqual(completed, ["cards", "director", "memory"])
  } finally {
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("story init agent pack builds messages and runtime context like background agents", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-agent-pack-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const agent = createStoryInitAgent({
      intent: "把主角改成侦探",
      depth: "standard",
      env: {},
      originalBrief: "一个发生在苏州雨夜的悬疑故事",
      history: [
        { role: "user", content: "一个发生在苏州雨夜的悬疑故事" },
        { role: "assistant", content: "已搭好苏州雨夜的悬疑底稿。" },
      ],
    })
    const prepared = await agent.buildInitialMessages({ input: { intent: "把主角改成侦探", depth: "standard" } })

    assert.equal(prepared.messages[0].role, "system")
    assert.match(prepared.messages[0].content, /ACTIVE MODE: STANDARD/)
    assert.match(prepared.messages[0].content, /苏州雨夜的悬疑故事/)
    assert.equal(prepared.messages.at(-1).role, "user")
    assert.equal(prepared.messages.at(-1).content, "把主角改成侦探")
    assert.equal(prepared.context.storyInitRevision, true)
    assert.ok(prepared.context.writeDeny.some((rule) => rule.match === "canon/chapters.md"))
    assert.match(await readFile(paths.brief, "utf8"), /苏州雨夜的悬疑故事/)
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("story init team coordinator narrows writes to narrator-facing files", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-team-write-deny-${Date.now()}`)
  try {
    const { initializeStory } = await import("../src/lib/storyStore.js")
    await initializeStory()
    const agent = createStoryInitAgent({
      intent: "一个茶馆里的悬疑故事",
      depth: "standard",
      env: {},
      team: { enabled: true, subAgentIds: ["director", "cards"], turnId: "init_test" },
    })
    const prepared = await agent.buildInitialMessages({ input: { intent: "一个茶馆里的悬疑故事", depth: "standard" } })
    const matches = prepared.context.writeDeny.map((entry) => entry.match)
    assert.ok(matches.includes("story/context-cards/"))
    assert.ok(matches.includes("story/director/"))
    assert.ok(matches.includes("story/includes/"))
  } finally {
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})

test("story init coordinator drains sub-agent handoffs into initial context", async () => {
  const savedRoot = process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-init-team-inbox-${Date.now()}`)
  try {
    const { initializeStory, paths } = await import("../src/lib/storyStore.js")
    await initializeStory()
    setAgentInboxRegistry([["story-init", path.join(paths.root, "init", "inbox.queue.jsonl")]])
    await enqueueAgentMessage({
      from: "director",
      to: "story-init",
      type: "subagent_recommendation",
      priority: "now",
      turnId: "init_test",
      payload: { from: "director", recommendations: ["Director Handoff: seed an early deadline in active-pressures.md"] },
    })
    const agent = createStoryInitAgent({
      intent: "一个茶馆里的悬疑故事",
      depth: "standard",
      env: {},
      team: { enabled: true, subAgentIds: ["director"], turnId: "init_test" },
    })
    const prepared = await agent.buildInitialMessages({ input: { intent: "一个茶馆里的悬疑故事", depth: "standard" } })
    const content = prepared.messages.map((m) => String(m.content || "")).join("\n")
    assert.equal(prepared.context.storyInitTeam, true)
    assert.deepEqual(prepared.context.storyInitTeamAgents, ["director"])
    assert.match(content, /INIT TEAM MODE OVERRIDE/)
    assert.match(content, /Story Init Team Handoffs/)
    assert.match(content, /Director Handoff/)
  } finally {
    setAgentInboxRegistry([])
    if (savedRoot === undefined) delete process.env.OPENOVEL_STORY_ROOT
    else process.env.OPENOVEL_STORY_ROOT = savedRoot
  }
})


test("toggle reads the lenient truthy family", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
    assert.equal(isInitNarratorPreviewEnabled({ [TOGGLE]: v }), true, JSON.stringify(v))
  }
  for (const v of ["0", "false", "", "no", undefined, null]) {
    assert.equal(isInitNarratorPreviewEnabled({ [TOGGLE]: v }), false, String(v))
  }
})

test("preview addendum caps the loop and frames it as a dry run vs the anchor", () => {
  const a = buildNarratorPreviewAddendum()
  assert.match(a, /preview_narration/)
  assert.match(a, /2-3 rounds/)
  assert.match(a, /STYLE ANCHOR/)
  assert.match(a, /forbidden\.md/)
  assert.match(a, /DRY RUN/)
  assert.match(a, /never copy the sample into chapters\.md/)
})

// ── preview_narration tool returns the narrator's prose ──────────────────────

test("preview_narration tool returns narrator prose (no-key fallback path)", async () => {
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-initpreview-ws-${Date.now()}`)
  const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../src/tools/registerTools.js")
  const registry = new ToolRegistry()
  registerDefaultTools(registry)

  const tool = registry.get("preview_narration")
  assert.ok(tool, "preview_narration registered")
  assert.equal(tool.exposeToModel, true)
  assert.equal(tool.readOnly, true)
  assert.equal(tool.concurrencySafe, false)

  const res = await tool.execute({})
  assert.match(res.output, /--- narrator output ---/)
  assert.ok(res.output.trim().length > 0)
  // No key in this env → deterministic fallback, surfaced as metadata + a notice.
  assert.equal(res.metadata?.source, "fallback")
  assert.match(res.output, /no model key configured/i)
  // The self-check is skipped for the non-model fallback (it would be meaningless
  // on the placeholder text); on a real model run it appends a tic + repeats audit.
  assert.equal(res.metadata?.selfChecked, false)
  assert.doesNotMatch(res.output, /self-check/i)
})

// ── Storykeeper enforces the anchor downstream ───────────────────────────────

test("storykeeper prompt treats the reader style anchor as authoritative", () => {
  const p = storykeeperSystemPrompt()
  assert.match(p, /STYLE ANCHOR/)
  assert.match(p, /读者认定的风格锚点/)
  assert.match(p, /AUTHORITATIVE/)
  assert.match(p, /story\/frontend\/tone\.md/)
})

test("preview_options joins includeTools only when preview AND options are both on", () => {
  for (const depth of ["standard", "deep"]) {
    // preview off → no preview_options regardless of options
    assert.equal(buildStoryInitToolPlan({ depth, env: {} }).includeTools.includes("preview_options"), false)
    // preview on, options default-on → present + addendum
    const on = buildStoryInitToolPlan({ depth, env: { [TOGGLE]: "1" } })
    assert.ok(on.includeTools.includes("preview_options"), `${depth}: present when both on`)
    assert.match(on.optionsPreviewAddendum, /preview_options/)
    // preview on, options explicitly off → preview_narration stays, preview_options gone
    const noOpts = buildStoryInitToolPlan({ depth, env: { [TOGGLE]: "1", OPENOVEL_OPTIONS_ENABLED: "false" } })
    assert.ok(noOpts.includeTools.includes("preview_narration"), `${depth}: narration preview still on`)
    assert.equal(noOpts.includeTools.includes("preview_options"), false, `${depth}: options preview off`)
    assert.equal(noOpts.optionsPreviewAddendum, "")
  }
})

test("preview_options errors with an explanation when no narration has been previewed", async () => {
  const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../src/tools/registerTools.js")
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("preview_options")
  assert.ok(tool, "preview_options is registered")
  assert.equal(tool.parameters && Object.keys(tool.parameters).length, 0, "takes no arguments (reuses last preview)")
  // No preview_narration ran (no model key in tests → it never stores a beat),
  // so preview_options must refuse and explain rather than fabricate a beat.
  const res = await tool.execute({})
  assert.match(res.output, /call preview_narration first/i)
  assert.match(res.output, /No previewed narration/i)
})

test("openingTriggerAction matches the real opening instruction (CJK vs latin)", async () => {
  const { openingTriggerAction } = await import("../src/lib/narrator.js")
  assert.match(openingTriggerAction("一个中文世界书"), /开始故事/)
  assert.match(openingTriggerAction("一个中文世界书"), /Prelude/)
  assert.match(openingTriggerAction("an english worldbook"), /^\(Begin the story\./)
})

test("preview_narration uses the real opening instruction, not a placeholder", async () => {
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-initpreview-open-${Date.now()}`)
  const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../src/tools/registerTools.js")
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("preview_narration")
  assert.deepEqual(Object.keys(tool.parameters), ["from", "force"], "takes a `from` mode (+ a `force` override), not a free-text action")
  const res = await tool.execute({})
  // opening mode reports the actual opening action, not the old (开场预览…) placeholder
  assert.match(res.output, /Reader action this turn:/)
  assert.doesNotMatch(res.output, /开场预览/)
})

test("preview_narration(from:option) errors when no options were previewed", async () => {
  const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
  const { registerDefaultTools } = await import("../src/tools/registerTools.js")
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const res = await registry.get("preview_narration").execute({ from: "option" })
  assert.match(res.output, /Nothing to advance from/i)
  assert.match(res.output, /preview_options first/i)
})

// ── preview budget: a mechanical cap on perfection-chasing ───────────────────

test("preview_narration enforces a per-run budget and reports the running count", async () => {
  process.env.OPENOVEL_STORY_ROOT = path.join(os.tmpdir(), `openovel-initpreview-budget-${Date.now()}`)
  const { ToolRegistry } = await import("../src/runtime/toolRegistry.js")
  const { registerDefaultTools, resetNarratorPreviewState, previewNarrationBudget } = await import("../src/tools/registerTools.js")
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("preview_narration")
  // Default budget without the env override.
  assert.equal(previewNarrationBudget({}), 5)
  assert.equal(previewNarrationBudget({ OPENOVEL_INIT_PREVIEW_MAX: "3" }), 3)
  process.env.OPENOVEL_INIT_PREVIEW_MAX = "2"
  resetNarratorPreviewState()
  try {
    const r1 = await tool.execute({})
    assert.match(r1.output, /--- preview budget ---/)
    assert.match(r1.output, /1 of 2 narration previews used this run; 1 remaining/)
    const r2 = await tool.execute({})
    assert.match(r2.output, /2 of 2 narration previews used this run; this was the LAST one/)
    // Past the budget: refused, with a finalize-now redirect (not a retry hint).
    const r3 = await tool.execute({})
    assert.equal(r3.isError, true)
    assert.equal(r3.metadata?.previewBudgetExhausted, true)
    assert.match(r3.output, /Preview budget exhausted/)
    assert.match(r3.output, /finalize/i)
    // A new init run resets the counter (and the rehearsal session).
    resetNarratorPreviewState()
    const r4 = await tool.execute({})
    assert.match(r4.output, /1 of 2 narration previews used/)
    // Model-facing budget strings carry no em dash (LLM tell).
    for (const out of [r1.output, r2.output, r3.output]) {
      for (const line of out.split("\n")) {
        if (/preview budget|previews used|budget exhausted/i.test(line)) {
          assert.ok(!line.includes("—"), `em dash in: ${line.slice(0, 80)}`)
        }
      }
    }
  } finally {
    delete process.env.OPENOVEL_INIT_PREVIEW_MAX
    resetNarratorPreviewState()
  }
})

test("preview addendum states the enforced budget so the model plans its rounds", () => {
  const a = buildNarratorPreviewAddendum()
  assert.match(a, /hard budget of \d+ narration previews is ENFORCED per run/)
  assert.match(a, /refused/)
})
