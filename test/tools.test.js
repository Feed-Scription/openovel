import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeStory } from "../src/lib/storyStore.js"
import { ToolRegistry } from "../src/runtime/toolRegistry.js"
import { registerDefaultTools } from "../src/tools/registerTools.js"
import { summarizeToolArgs } from "../src/runtime/toolLoop.js"
import { FileStateCache, FILE_NOT_READ_CODE, STALE_WRITE_CODE } from "../src/runtime/fileStateCache.js"

process.env.OPENOVEL_HOME ||= path.join(os.tmpdir(), `openovel-tools-${Date.now()}`)

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

test("tool registry treats wildcard includeTools as all model-visible tools", () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const names = registry.openAITools({ includeTools: ["*"], excludeTools: ["write"] }).map((tool) => tool.function.name)

  assert.ok(names.includes("read"))
  assert.ok(names.includes("edit"))
  assert.equal(names.includes("write"), false)
  assert.equal(names.includes("fetch_image"), false)
})

test("tool registry exposes agent-only tools only when explicitly included", () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const defaultNames = registry.openAITools({}).map((tool) => tool.function.name)
  const imageNames = registry.openAITools({ includeTools: ["read", "fetch_image", "generate_image"] }).map((tool) => tool.function.name)

  assert.equal(defaultNames.includes("fetch_image"), false)
  assert.equal(defaultNames.includes("generate_image"), false)
  assert.deepEqual(imageNames.sort(), ["fetch_image", "generate_image", "read"])
})

test("bash is model-exposed by default, gated behind includeDangerous", () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  // Default-on now (not hidden), but dangerous — so a pack only receives bash
  // when it opts into dangerous tools. The standalone single Storykeeper opts in
  // (lib/storykeeper.js → includeDangerous: true); the resident sub-agents opt in
  // via their Agent Cards; the narrator-side composer packs do not.
  const withDangerous = registry.openAITools({ includeDangerous: true }).map((t) => t.function.name)
  const withoutDangerous = registry.openAITools({}).map((t) => t.function.name)
  assert.ok(withDangerous.includes("bash"), "bash present when includeDangerous")
  assert.equal(withoutDangerous.includes("bash"), false, "bash gated out without includeDangerous")
})

test("default tool registration supplements a partially initialized registry", () => {
  const registry = new ToolRegistry()
  registry.register({ id: "read", description: "placeholder", execute: async () => "placeholder" })
  registerDefaultTools(registry)
  const imageNames = registry.openAITools({ includeTools: ["read", "fetch_image", "generate_image"] }).map((tool) => tool.function.name)

  assert.deepEqual(imageNames.sort(), ["fetch_image", "generate_image", "read"])
})

test("fetch_image saves story/includes targets in the active story archive", async () => {
  const saved = saveEnv()
  const originalFetch = globalThis.fetch
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-img-home-"))
  const cwd = await mkdtemp(path.join(os.tmpdir(), "openovel-img-cwd-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ID = "s_archive_image_test"
  delete process.env.OPENOVEL_STORY_ROOT
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  globalThis.fetch = async () => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } })
  const previousCwd = process.cwd()
  process.chdir(cwd)
  try {
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const result = await registry.execute(
      "fetch_image",
      {
        url: "https://cdn.example/chikatsuyu.jpg",
        path: "story/includes/beats/t8-chikatsuyu-arrival.jpg",
      },
    )

    assert.equal(result.metadata.path, "story/includes/beats/t8-chikatsuyu-arrival.jpg")
    const archived = await readFile(path.join(home, "stories", "s_archive_image_test", "includes", "beats", "t8-chikatsuyu-arrival.jpg"))
    assert.equal(archived.equals(JPEG), true)
    await assert.rejects(
      () => readFile(path.join(cwd, "story", "includes", "beats", "t8-chikatsuyu-arrival.jpg")),
      /ENOENT/,
    )
  } finally {
    process.chdir(previousCwd)
    globalThis.fetch = originalFetch
    restoreEnv(saved)
  }
})

test("explain is a no-op reader-narration tool; its full sentence surfaces in the args summary", async () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.get("explain")
  assert.ok(tool, "explain tool registered")
  assert.equal(tool.readOnly, true)
  assert.equal(tool.concurrencySafe, true)

  // No-op execute returns ok (no file side effect).
  const res = await tool.execute({ text: "  Researching the protagonist's canon.  " })
  assert.equal(res.output, "ok")
  assert.equal(res.metadata.text, "Researching the protagonist's canon.")

  // Validation rejects empty text.
  assert.equal((await tool.validate({ text: "" })).ok, false)

  // The whole sentence (not the 60-char generic clip) reaches the foreground.
  const long = "我先把现有的脚手架读一遍，再去查证主角的设定，然后写好人物卡，这句话故意写得比六十个字符更长用来验证不会被截断到默认上限。"
  assert.equal(summarizeToolArgs("explain", { text: long }), long)
})

test("ask_user exposes optional choices without requiring them", async () => {
  const registry = new ToolRegistry()
  registerDefaultTools(registry)
  const tool = registry.openAITools({ includeTools: ["ask_user"] })[0]

  assert.equal(tool.function.name, "ask_user")
  assert.deepEqual(tool.function.parameters.required, ["question"])
  assert.equal(tool.function.parameters.properties.options.minItems, 2)
  assert.equal(tool.function.parameters.properties.options.maxItems, 4)
  assert.deepEqual(tool.function.parameters.properties.options.items.required, ["label", "description"])

  await assert.rejects(
    () => registry.execute("ask_user", { question: "Pick one?", options: ["Only one"] }),
    /options must include at least 2 choices/,
  )
})

test("file tools accept paths with or without story/ prefix", async () => {
  await initializeStory()
  const registry = new ToolRegistry()
  registerDefaultTools(registry)

  const plain = await registry.execute("read", { filePath: "guidance/FOREGROUND.md", limit: 2 })
  const prefixed = await registry.execute("read", { filePath: "story/guidance/FOREGROUND.md", limit: 2 })

  assert.match(plain.output, /Foreground Guidance/)
  assert.match(prefixed.output, /Foreground Guidance/)
})

test("file tools can read shared reference workspace", async () => {
  await initializeStory()
  const registry = new ToolRegistry()
  registerDefaultTools(registry)

  const shared = await registry.execute("read", { filePath: "shared/INDEX.md", limit: 5 })

  assert.match(shared.output, /Shared References/)
  assert.match(shared.output, /<path>shared\/INDEX\.md<\/path>/)
})

test("writeDeny directory entries block nested writes", async () => {
  const env = await isolatedToolEnv("openovel-tools-write-deny-dir-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const result = await registry.execute(
      "write",
      { filePath: "story/context-cards/mei/CARD.md", content: "# Mei\n" },
      {
        readFileState: new FileStateCache(),
        writeDeny: [
          {
            match: "story/context-cards/",
            reason: "context cards are owned by the cards Agent.",
          },
        ],
      },
    )

    assert.match(result.output, /context cards are owned by the cards Agent/)
    await assert.rejects(
      () => readFile(path.join(env.storyRoot, "context-cards", "mei", "CARD.md"), "utf8"),
      /ENOENT/,
    )
  } finally {
    env.restore()
  }
})

test("read returns an unchanged stub for repeated unchanged ranges", async () => {
  const env = await isolatedToolEnv("openovel-tools-read-dedup-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const target = path.join(env.storyRoot, "canon", "repeat.md")
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8")
    const context = { readFileState: new FileStateCache(), readResultState: new Map() }

    const first = await registry.execute("read", { filePath: "story/canon/repeat.md", limit: 2 }, context)
    const second = await registry.execute("read", { filePath: "story/canon/repeat.md", limit: 2 }, context)
    assert.match(first.output, /alpha/)
    assert.match(second.output, /File unchanged since last read/)
    assert.equal(second.metadata.deduped, true)

    await writeFile(target, "changed\nbeta\ngamma\n", "utf8")
    const third = await registry.execute("read", { filePath: "story/canon/repeat.md", limit: 2 }, context)
    assert.match(third.output, /changed/)
    assert.equal(third.metadata.deduped, undefined)
  } finally {
    env.restore()
  }
})

test("glob reports file age and last writing turn when available", async () => {
  const env = await isolatedToolEnv("openovel-tools-glob-age-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    await registry.execute(
      "write",
      { filePath: "story/canon/clock.md", content: "tick\n" },
      { readFileState: new FileStateCache(), turnId: "turn_7" },
    )
    const result = await registry.execute("glob", { pattern: "story/canon/clock.md" }, { turnId: "turn_10" })

    assert.match(result.output, /story\/canon\/clock\.md/)
    assert.match(result.output, /idle=\d+[smhd]/)
    assert.match(result.output, /modified=\d{4}-\d{2}-\d{2}T/)
    assert.match(result.output, /size=5B/)
    assert.match(result.output, /last_turn=turn_7/)
    assert.match(result.output, /turns_idle=3/)
    assert.equal(result.metadata.files[0].lastTurnId, "turn_7")
    assert.equal(result.metadata.files[0].turnsIdle, 3)
  } finally {
    env.restore()
  }
})

test("grep supports output modes, pagination, and context rows", async () => {
  const env = await isolatedToolEnv("openovel-tools-grep-modes-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    await writeFile(path.join(env.storyRoot, "canon", "a.md"), "alpha\nneedle one\nbravo\nneedle two\n", "utf8")
    await writeFile(path.join(env.storyRoot, "canon", "b.md"), "NEEDLE three\ncharlie\n", "utf8")

    const content = await registry.execute("grep", {
      pattern: "needle",
      path: "story/canon",
      include: "*.md",
      headLimit: 2,
      after: 1,
    })
    assert.match(content.output, /Found 3 matches in 2 files/)
    assert.match(content.output, /story\/canon\/a\.md:2: needle one/)
    assert.match(content.output, /story\/canon\/a\.md-3- bravo/)
    assert.equal(content.metadata.truncated, true)

    const files = await registry.execute("grep", {
      pattern: "needle",
      path: "story/canon",
      outputMode: "files_with_matches",
    })
    assert.match(files.output, /story\/canon\/a\.md\tmatches=2/)
    assert.match(files.output, /story\/canon\/b\.md\tmatches=1/)

    const caseSensitive = await registry.execute("grep", {
      pattern: "needle",
      path: "story/canon",
      outputMode: "count",
      caseSensitive: true,
    })
    assert.match(caseSensitive.output, /Found 2 matches in 1 files/)
    assert.doesNotMatch(caseSensitive.output, /story\/canon\/b\.md/)
  } finally {
    env.restore()
  }
})

test("writing a format/*.css with forbidden CSS warns the model (still saves)", async () => {
  const env = await isolatedToolEnv("openovel-tools-fmtcss-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const res = await registry.execute(
      "write",
      { filePath: "story/format/blocks.css", content: ".ovl-x { color: red; position: fixed; background: url('http://e') }" },
      { readFileState: new FileStateCache() },
    )
    assert.match(res.output, /Wrote file successfully/)
    assert.match(res.output, /sanitizer will drop/)
    assert.match(res.output, /position|blocked token/i)
    // a clean format css gets no warning
    const ok = await registry.execute(
      "write",
      { filePath: "story/format/clean.css", content: ".ovl-x { color: red; padding: 8px }" },
      { readFileState: new FileStateCache() },
    )
    assert.doesNotMatch(ok.output, /sanitizer will drop/)
  } finally {
    env.restore()
  }
})

test("write creates a new file without prior read and records a transaction", async () => {
  const env = await isolatedToolEnv("openovel-tools-new-write-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    await registry.execute("write", { filePath: "story/notes/new.md", content: "hello\n" }, { readFileState: new FileStateCache() })
    const text = await readFile(path.join(env.storyRoot, "notes", "new.md"), "utf8")
    assert.equal(text, "hello\n")
    const transactions = await import("../src/runtime/storyTransaction.js")
    const list = await transactions.listStoryTransactions({ limit: 5 })
    assert.ok(list.some((tx) => tx.source === "tool:write" && tx.status === "committed"))
  } finally {
    env.restore()
  }
})

test("write/edit publish story.files_changed for live format-contract reloads", async () => {
  const env = await isolatedToolEnv("openovel-tools-format-event-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const events = []
    const bus = { publish: (name, properties) => events.push({ name, properties }) }
    await registry.execute(
      "write",
      {
        filePath: "story/format/config.json",
        content: '{"version":1,"hud":{"slots":[]}}',
      },
      { readFileState: new FileStateCache(), bus, turnId: "turn_format_test", agent: "render-manager" },
    )
    const event = events.find((e) => e.name === "story.files_changed")
    assert.ok(event, "write should publish a file-change event")
    assert.equal(event.properties.formatUpdated, true)
    assert.deepEqual(event.properties.files.map((f) => f.path), ["story/format/config.json"])
  } finally {
    env.restore()
  }
})

test("write-gate REJECTS an illegal block template; clean one writes through; edit injection rejected", async () => {
  const env = await isolatedToolEnv("openovel-tools-format-gate-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const target = path.join(env.storyRoot, "format", "blocks", "stat-panel.html")

    const rejected = await registry.execute(
      "write",
      { filePath: "story/format/blocks/stat-panel.html", content: '<div onclick="e()"><iframe src="http://x"></iframe><span style="position:fixed">{{body}}</span></div>' },
      { readFileState: new FileStateCache() },
    )
    // The gate surfaces the rejection in the tool-result output (the model reads
    // it and retries); normalizeToolResult drops the isError flag, same as the
    // path-deny convention, so the file-not-written check is what proves refusal.
    assert.match(rejected.output, /REJECTED/)
    assert.match(rejected.output, /onclick/)
    assert.match(rejected.output, /<iframe>/)
    assert.match(rejected.output, /position/)
    // the file was NOT written
    await assert.rejects(() => readFile(target, "utf8"))

    // a clean template writes through
    const ok = await registry.execute(
      "write",
      { filePath: "story/format/blocks/stat-panel.html", content: '<div class="panel"><span>{{body}}</span></div>' },
      { readFileState: new FileStateCache() },
    )
    assert.match(ok.output, /Wrote file successfully/)
    assert.match(await readFile(target, "utf8"), /class="panel"/)

    // editing the clean template to inject an illegal tag is rejected too, and
    // the on-disk content is unchanged (the gate runs before the write).
    const editRej = await registry.execute(
      "edit",
      {
        filePath: "story/format/blocks/stat-panel.html",
        oldString: "<span>{{body}}</span>",
        newString: "<span>{{body}}</span><script>x()</script>",
      },
      { readFileState: new FileStateCache() },
    )
    assert.match(editRej.output, /REJECTED/)
    assert.match(editRej.output, /<script>/)
    assert.doesNotMatch(await readFile(target, "utf8"), /<script>/)

    // reserved kind + non-html files in blocks/ are refused
    const reserved = await registry.execute(
      "write",
      { filePath: "story/format/blocks/bg.html", content: "<div>{{body}}</div>" },
      { readFileState: new FileStateCache() },
    )
    assert.match(reserved.output, /RESERVED/)
    const nonHtml = await registry.execute(
      "write",
      { filePath: "story/format/blocks/notes.md", content: "notes" },
      { readFileState: new FileStateCache() },
    )
    assert.match(nonHtml.output, /\.html extension/)
  } finally {
    env.restore()
  }
})

test("custom rich blocks OFF freezes block templates while allowing reserved-channel config", async () => {
  const env = await isolatedToolEnv("openovel-tools-plain-block-freeze-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
    const denied = await registry.execute(
      "write",
      { filePath: "story/format/blocks/plain-card.html", content: "<div>{{body}}</div>" },
      { readFileState: new FileStateCache() },
    )
    assert.match(denied.output, /custom rich block styling is disabled/)
    assert.match(denied.output, /story\/format\/blocks/)
    await assert.rejects(() => readFile(path.join(env.storyRoot, "format", "blocks", "plain-card.html"), "utf8"))

    const config = await registry.execute(
      "write",
      { filePath: "story/format/config.json", content: '{"version":1,"include":{"enabled":true,"allow":["image"]},"hud":{"slots":[]}}' },
      { readFileState: new FileStateCache() },
    )
    assert.match(config.output, /Wrote file successfully/)
    assert.match(await readFile(path.join(env.storyRoot, "format", "config.json"), "utf8"), /"include"/)

    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "1"
    const seed = await registry.execute(
      "write",
      { filePath: "story/format/blocks/existing-card.html", content: "<div>{{body}}</div>" },
      { readFileState: new FileStateCache() },
    )
    assert.match(seed.output, /Wrote file successfully/)

    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
    const deniedEdit = await registry.execute(
      "edit",
      {
        filePath: "story/format/blocks/existing-card.html",
        oldString: "{{body}}",
        newString: "{{raw}}",
      },
      { readFileState: new FileStateCache() },
    )
    assert.match(deniedEdit.output, /custom rich block styling is disabled/)
    assert.equal(await readFile(path.join(env.storyRoot, "format", "blocks", "existing-card.html"), "utf8"), "<div>{{body}}</div>")
  } finally {
    env.restore()
  }
})

test("plain-blocks mode warns when rich-rendering.md still teaches custom ovl kinds", async () => {
  const env = await isolatedToolEnv("openovel-tools-plain-rich-guidance-")
  try {
    process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT = "true"
    process.env.OPENOVEL_CUSTOM_RICH_BLOCKS = "0"
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const ctx = { readFileState: new FileStateCache() }
    await registry.execute("read", { filePath: "story/frontend/rich-rendering.md", full: true }, ctx).catch(() => null)

    const result = await registry.execute(
      "write",
      {
        filePath: "story/frontend/rich-rendering.md",
        content: [
          "---",
          "section: rich-rendering",
          "---",
          "",
          "## Rich Rendering",
          "",
          "Keep the HUD current with `ovl:hud`.",
          "When a dossier appears, emit ```ovl:status-card```.",
        ].join("\n"),
      },
      ctx,
    )

    assert.match(result.output, /rich-rendering guidance/)
    assert.match(result.output, /plain-blocks mode/)
    assert.match(result.output, /ovl:status-card/)
    assert.doesNotMatch(result.output, /ovl:hud.*custom/)
    await assert.rejects(() => readFile(path.join(env.storyRoot, "format", "blocks", "status-card.html"), "utf8"))
  } finally {
    env.restore()
  }
})

test("foreground/ + context-cards/ warn over the ~6K-token soft limit (language-aware) but still succeed", async () => {
  const env = await isolatedToolEnv("openovel-tools-fgsize-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    // Under the limit: no warning. (Fresh path — new files skip the read gate.)
    const small = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/small.md", content: "字".repeat(3000) }, // ~2000 tokens
      { readFileState: new FileStateCache() },
    )
    assert.match(small.output, /Wrote file successfully/)
    assert.doesNotMatch(small.output, /soft limit/)

    // Chinese over the limit: ~6667 tokens for 10001 CJK chars → warns.
    const big = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/big.md", content: "字".repeat(10001) },
      { readFileState: new FileStateCache() },
    )
    assert.match(big.output, /Wrote file successfully/)
    assert.match(big.output, /soft limit/)
    assert.match(big.output, /estimated tokens/)
    const text = await readFile(path.join(env.storyRoot, "frontend", "extras", "big.md"), "utf8")
    assert.equal([...text].length, 10001)

    // English fairness: 20000 ASCII chars ≈ 5000 tokens — UNDER the limit, so
    // no warning, even though a flat 10K-char cap would have warned.
    const english = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/english.md", content: "y".repeat(20000) },
      { readFileState: new FileStateCache() },
    )
    assert.match(english.output, /Wrote file successfully/)
    assert.doesNotMatch(english.output, /soft limit/)

    // Enough English to exceed ~6000 tokens (>24000 chars) → warns.
    const bigEnglish = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/bigeng.md", content: "y".repeat(28000) }, // ~7000 tokens
      { readFileState: new FileStateCache() },
    )
    assert.match(bigEnglish.output, /soft limit/)

    // A context-card file over the limit also warns (and still succeeds).
    const card = await registry.execute(
      "write",
      { filePath: "story/context-cards/bigchar/extra.md", content: "字".repeat(10001) },
      { readFileState: new FileStateCache() },
    )
    assert.match(card.output, /Wrote file successfully/)
    assert.match(card.output, /soft limit/)
    assert.match(card.output, /context-card/)

    // A large file OUTSIDE both working-set dirs gets no warning.
    const elsewhere = await registry.execute(
      "write",
      { filePath: "story/notes/big.md", content: "字".repeat(20000) },
      { readFileState: new FileStateCache() },
    )
    assert.doesNotMatch(elsewhere.output, /soft limit/)
  } finally {
    env.restore()
  }
})

test("write/edit warn when content trips operator tic regexes; forbidden.md + background/ are exempt", async () => {
  const env = await isolatedToolEnv("openovel-tools-tic-")
  const savedTic = process.env.OPENOVEL_NARRATOR_TIC_PATTERNS
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    // No patterns configured → never warns, even on tic-laden prose. (Fresh
    // nested paths skip the read gate that guards existing scaffold files.)
    delete process.env.OPENOVEL_NARRATOR_TIC_PATTERNS
    const off = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/off.md", content: "他不由得又不由得。" },
      { readFileState: new FileStateCache() },
    )
    assert.doesNotMatch(off.output, /tic pattern/i)

    // Two operator patterns: a bare substring and an explicit /regex/ form.
    process.env.OPENOVEL_NARRATOR_TIC_PATTERNS = "不由得\n/眼(神|眸)/"

    // A narrator-facing prose file that commits the tic → warns, still succeeds.
    const hit = await registry.execute(
      "write",
      { filePath: "story/frontend/extras/probe.md", content: "他不由得停下，眼神闪烁，又不由得叹气。" },
      { readFileState: new FileStateCache() },
    )
    assert.match(hit.output, /Wrote file successfully/)
    assert.match(hit.output, /tic pattern/i)
    assert.match(hit.output, /不由得/) // the matched pattern is surfaced
    assert.match(hit.output, /×2/) // counted occurrences (two 不由得)

    // edit (creating via empty oldString on a fresh file) scans the same way.
    const edited = await registry.execute(
      "edit",
      { filePath: "story/frontend/voice.md", oldString: "", newString: "她眼眸低垂。" },
      { readFileState: new FileStateCache() },
    )
    assert.match(edited.output, /Edit applied successfully/)
    assert.match(edited.output, /tic pattern/i)

    // forbidden.md QUOTES the patterns in order to ban them → exempt (no false
    // positive). It already exists from init, so read-then-write in one context.
    const banCtx = { readFileState: new FileStateCache(), readResultState: new Map() }
    await registry.execute("read", { filePath: "story/frontend/forbidden.md", full: true }, banCtx)
    const banlist = await registry.execute(
      "write",
      { filePath: "story/frontend/forbidden.md", content: "## Forbidden / Avoid\n- 不由得\n- 眼神\n" },
      banCtx,
    )
    assert.match(banlist.output, /Wrote file successfully/)
    assert.doesNotMatch(banlist.output, /tic pattern/i)

    // story/director/ is the Storykeeper's internal tic-audit scratchpad → exempt.
    const audit = await registry.execute(
      "write",
      { filePath: "story/director/notes/probe.md", content: "叙述者反复写 不由得 和 眼神，需要收紧。" },
      { readFileState: new FileStateCache() },
    )
    assert.doesNotMatch(audit.output, /tic pattern/i)

    // Everywhere else still scans (the warning covers "all" writes/edits).
    const notes = await registry.execute(
      "write",
      { filePath: "story/notes/draft.md", content: "他不由得笑了。" },
      { readFileState: new FileStateCache() },
    )
    assert.match(notes.output, /tic pattern/i)
  } finally {
    if (savedTic === undefined) delete process.env.OPENOVEL_NARRATOR_TIC_PATTERNS
    else process.env.OPENOVEL_NARRATOR_TIC_PATTERNS = savedTic
    env.restore()
  }
})

test("edit creates a new nested file with empty oldString; non-empty oldString on a missing file errors with guidance", async () => {
  const env = await isolatedToolEnv("openovel-tools-editcreate-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    // Empty oldString creates the file AND its missing parent dirs (extras/).
    const created = await registry.execute(
      "edit",
      { filePath: "story/frontend/extras/relations.md", oldString: "", newString: "# Relations\n" },
      { readFileState: new FileStateCache() },
    )
    assert.match(created.output, /Edit applied successfully/)
    assert.equal(await readFile(path.join(env.storyRoot, "frontend", "extras", "relations.md"), "utf8"), "# Relations\n")

    // Non-empty oldString on a still-missing file errors, and the message points to write.
    await assert.rejects(
      () => registry.execute(
        "edit",
        { filePath: "story/frontend/extras/nope.md", oldString: "something", newString: "x" },
        { readFileState: new FileStateCache() },
      ),
      /File not found[\s\S]*use write/,
    )
  } finally {
    env.restore()
  }
})

test("existing file write/edit require full read and reject stale writes", async () => {
  const env = await isolatedToolEnv("openovel-tools-stale-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const target = path.join(env.storyRoot, "canon", "guard.md")
    await writeFile(target, "one\ntwo\n", "utf8")

    await assert.rejects(
      () => registry.execute("edit", { filePath: "story/canon/guard.md", oldString: "one", newString: "ONE" }, { readFileState: new FileStateCache() }),
      (error) => error.code === FILE_NOT_READ_CODE,
    )

    const partialContext = { readFileState: new FileStateCache() }
    await registry.execute("read", { filePath: "story/canon/guard.md", limit: 1 }, partialContext)
    await assert.rejects(
      () => registry.execute("edit", { filePath: "story/canon/guard.md", oldString: "one", newString: "ONE" }, partialContext),
      (error) => error.code === FILE_NOT_READ_CODE,
    )

    const context = { readFileState: new FileStateCache() }
    await registry.execute("read", { filePath: "story/canon/guard.md", full: true }, context)
    await registry.execute("edit", { filePath: "story/canon/guard.md", oldString: "one", newString: "ONE" }, context)
    assert.equal(await readFile(target, "utf8"), "ONE\ntwo\n")

    await registry.execute("read", { filePath: "story/canon/guard.md", full: true }, context)
    await writeFile(target, "external change\n", "utf8")
    await assert.rejects(
      () => registry.execute("write", { filePath: "story/canon/guard.md", content: "agent change\n" }, context),
      (error) => error.code === STALE_WRITE_CODE,
    )
  } finally {
    env.restore()
  }
})

test("memory-review owns story memory: write/edit denied + memory tool not exposed", async () => {
  const env = await isolatedToolEnv("openovel-tools-memown-")
  try {
    process.env.OPENOVEL_RESIDENT_TEAM = "0" // legacy memory-review loop owns story/memory/
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const ctx = { readFileState: new FileStateCache() }
    // memory-review is enabled by default (no ablation env) → story/memory/* is
    // owned by it: tool writes are refused.
    const md = await registry.execute("write", { filePath: "story/memory/MEMORY.md", content: "# hack" }, ctx)
    assert.match(md.output, /memory-review loop/)
    const topic = await registry.execute("write", { filePath: "story/memory/topics/x.md", content: "hi" }, ctx)
    assert.match(topic.output, /memory-review loop/)
    // the memory tool is not offered to the model
    const exposed = registry.openAITools({}).map((t) => t.function.name)
    assert.ok(!exposed.includes("memory"), "memory tool must be hidden while memory-review owns memory")
    // mutating the memory tool is refused even if invoked directly
    const mut = await registry.execute("memory", { action: "add", target: "story", content: "x" }, {})
    assert.match(mut.output, /Refusing memory mutation/)
    // unrelated paths still writable
    const canon = await registry.execute("write", { filePath: "story/canon/note.md", content: "ok" }, ctx)
    assert.match(canon.output, /Wrote file successfully/)
  } finally {
    env.restore()
  }
})

test("resident-team mode: Memory agent may write story/memory/ but the memory tool stays owned", async () => {
  const env = await isolatedToolEnv("openovel-tools-memteam-")
  try {
    process.env.OPENOVEL_RESIDENT_TEAM = "1" // team on → resident Memory agent owns story/memory/
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const ctx = { readFileState: new FileStateCache() }
    // The legacy memory-review loop is skipped in team mode, so the path gate
    // must stand down: tool writes to story/memory/ now succeed (the Memory
    // agent's domain). This is the init regression — writes were being refused.
    await registry.execute("read", { filePath: "story/memory/MEMORY.md", full: true }, ctx)
    const md = await registry.execute("write", { filePath: "story/memory/MEMORY.md", content: "# memory" }, ctx)
    assert.match(md.output, /Wrote file successfully/)
    const topic = await registry.execute("write", { filePath: "story/memory/topics/x.md", content: "hi" }, ctx)
    assert.match(topic.output, /Wrote file successfully/)
    // But story memory still has a dedicated owner, so the competing `memory`
    // tool stays hidden and refuses mutations.
    const exposed = registry.openAITools({}).map((t) => t.function.name)
    assert.ok(!exposed.includes("memory"), "memory tool must stay hidden in team mode")
    const mut = await registry.execute("memory", { action: "add", target: "story", content: "x" }, {})
    assert.match(mut.output, /Refusing memory mutation/)
  } finally {
    env.restore()
  }
})

test("websearch tool discovers source URLs through provider registry and logs research", async () => {
  const savedEnv = saveEnv()
  const originalFetch = globalThis.fetch
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-websearch-home-"))
  const storyRoot = await mkdtemp(path.join(os.tmpdir(), "openovel-websearch-story-"))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = storyRoot
  process.env.OPENOVEL_WEBSEARCH_PROVIDER = "custom-http-search"
  process.env.CUSTOM_HTTP_SEARCH_URL = "https://search.example.test/?q={query}&limit={limit}"
  globalThis.fetch = async (url) => {
    assert.match(String(url), /q=magical%20realism%20craft/)
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Magical realism craft",
            url: "https://example.com/style",
            snippet: "A source-backed discussion of narrative texture.",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    const result = await registry.execute("websearch", { query: "magical realism craft", limit: 1 })
    assert.match(result.output, /Magical realism craft/)
    assert.match(result.output, /https:\/\/example\.com\/style/)
    assert.match(result.output, /source-backed/)
    assert.match(result.output, /Use webfetch/)
    assert.equal(result.metadata.discoveryOnly, true)
    assert.equal(result.metadata.researchFile, "story/research/search-log.md")
    const notes = await readFile(path.join(storyRoot, "research", "search-log.md"), "utf8")
    assert.match(notes, /Magical realism craft/)
    assert.match(notes, /discovery only/)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv(savedEnv)
  }
})

function saveEnv() {
  return {
    OPENOVEL_HOME: process.env.OPENOVEL_HOME,
    OPENOVEL_STORY_ROOT: process.env.OPENOVEL_STORY_ROOT,
    OPENOVEL_STORY_ID: process.env.OPENOVEL_STORY_ID,
    AI_STORY_ID: process.env.AI_STORY_ID,
    OPENOVEL_IGNORE_PROJECT_CONFIG: process.env.OPENOVEL_IGNORE_PROJECT_CONFIG,
    OPENOVEL_WEBSEARCH_PROVIDER: process.env.OPENOVEL_WEBSEARCH_PROVIDER,
    CUSTOM_HTTP_SEARCH_URL: process.env.CUSTOM_HTTP_SEARCH_URL,
    OPENOVEL_ENABLE_FORMAT_CONTRACT: process.env.OPENOVEL_ENABLE_FORMAT_CONTRACT,
    OPENOVEL_CUSTOM_RICH_BLOCKS: process.env.OPENOVEL_CUSTOM_RICH_BLOCKS,
    OPENOVEL_RESIDENT_TEAM: process.env.OPENOVEL_RESIDENT_TEAM,
  }
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function isolatedToolEnv(prefix) {
  const saved = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), `${prefix}home-`))
  const storyRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}story-`))
  process.env.OPENOVEL_HOME = home
  process.env.OPENOVEL_STORY_ROOT = storyRoot
  process.env.OPENOVEL_IGNORE_PROJECT_CONFIG = "1"
  return {
    home,
    storyRoot,
    restore() {
      restoreEnv(saved)
    },
  }
}

test("write/edit REJECT an unparseable *.json target before persisting; valid JSON writes through", async () => {
  const env = await isolatedToolEnv("openovel-tools-jsongate-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)

    // Unparseable JSON (trailing comma) is refused; nothing lands on disk.
    const bad = await registry.execute(
      "write",
      { filePath: "story/state/world_state.json", content: '{ "hp": 10, }' },
      { readFileState: new FileStateCache() },
    )
    assert.match(bad.output, /REJECTED/)
    assert.match(bad.output, /not valid JSON/)
    await assert.rejects(() => readFile(path.join(env.storyRoot, "state", "world_state.json"), "utf8"))

    // Valid JSON writes through normally.
    const good = await registry.execute(
      "write",
      { filePath: "story/state/world_state.json", content: '{ "hp": 10 }' },
      { readFileState: new FileStateCache() },
    )
    assert.match(good.output, /Wrote file successfully/)

    // edit validates the RESULTING content: a corrupting edit is refused and
    // the prior file content survives.
    const context = { readFileState: new FileStateCache() }
    await registry.execute("read", { filePath: "story/state/world_state.json", full: true }, context)
    const badEdit = await registry.execute(
      "edit",
      { filePath: "story/state/world_state.json", oldString: '"hp": 10 }', newString: '"hp": 11' },
      context,
    )
    assert.match(badEdit.output, /REJECTED/)
    assert.equal(await readFile(path.join(env.storyRoot, "state", "world_state.json"), "utf8"), '{ "hp": 10 }')

    const goodEdit = await registry.execute(
      "edit",
      { filePath: "story/state/world_state.json", oldString: '"hp": 10', newString: '"hp": 11' },
      context,
    )
    assert.match(goodEdit.output, /Edit applied successfully/)
    assert.equal(await readFile(path.join(env.storyRoot, "state", "world_state.json"), "utf8"), '{ "hp": 11 }')
  } finally {
    env.restore()
  }
})

test("write-gate REJECTS legacy CONTRACT.md outright and rejects invalid config.json", async () => {
  const env = await isolatedToolEnv("openovel-tools-rulesdoc-")
  try {
    await initializeStory()
    const registry = new ToolRegistry()
    registerDefaultTools(registry)
    // The retired single-markdown contract is refused regardless of content,
    // and the rejection teaches the file-based layout.
    const legacy = await registry.execute(
      "write",
      { filePath: "story/format/CONTRACT.md", content: "# anything at all" },
      { readFileState: new FileStateCache() },
    )
    assert.match(legacy.output, /REJECTED/)
    assert.match(legacy.output, /RETIRED/)
    assert.match(legacy.output, /blocks\/<kind>\.html/)
    await assert.rejects(() => readFile(path.join(env.storyRoot, "format", "CONTRACT.md"), "utf8"))

    // config.json must be a JSON object
    const badCfg = await registry.execute(
      "write",
      { filePath: "story/format/config.json", content: "# not json" },
      { readFileState: new FileStateCache() },
    )
    assert.match(badCfg.output, /REJECTED/)
    const goodCfg = await registry.execute(
      "write",
      { filePath: "story/format/config.json", content: '{ "version": 1 }' },
      { readFileState: new FileStateCache() },
    )
    assert.match(goodCfg.output, /Wrote file successfully/)
  } finally {
    env.restore()
  }
})
