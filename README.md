<p align="center">
  <img src="./assets/hero.webp" alt="Openovel" width="760" />
</p>

<p align="center">
  <strong>Play an AI novel in real time while background agents keep the world coherent in plain files.</strong>
</p>

<p align="center">
  <a href="#preview">Preview</a> ·
  <a href="#download">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-openovel">Why openovel</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="./README.zh-CN.md">中文</a>
</p>

openovel is an open-source, local-first AI interactive fiction app: the reader drives the story in real time, a fast narrator writes the next beat, and an asynchronous background agent team maintains continuity, memory, and world state in Markdown / JSON files. It is a file-native, bring-your-own-model alternative to cloud AI-fiction tools.

It is built around a **dual-loop** design. A fast foreground narrator answers the reader immediately; an asynchronous **background brain** maintains durable story knowledge. By default that brain is a small **resident team** of specialized agents — a Showrunner coordinator plus World Keeper, Director, Card Manager, and Memory agents (and feature-gated render / image / music agents) — with a single **Storykeeper** agent as the fallback (`OPENOVEL_RESIDENT_TEAM=0`). The two loops communicate through Markdown / JSON / JSONL files, with no vector store, no RAG layer, and no graph database.

Status: **Demo phase**. The app is usable end-to-end, but APIs and on-disk layouts may still change between iterations. It is not versioned as a stable downstream dependency yet. Development and testing happen primarily on **macOS**; Windows and Linux builds are produced but only lightly tested.

## Preview

<p align="center">
  <img src="./assets/screenshot.webp" alt="openovel Electron app showing a running interactive fiction scene" width="860" />
</p>

## Download

Tagged releases can publish packaged desktop builds through GitHub Actions: [Releases](https://github.com/Feed-Scription/openovel/releases). If your platform does not have an attached build yet, use the source install below.

macOS release builds are portable zip archives with an ad-hoc-signed `.app`. They are not Developer ID signed or notarized because the project does not have an Apple Developer ID certificate yet, so Gatekeeper warnings are expected. See [`docs/macos-gatekeeper.md`](./docs/macos-gatekeeper.md) for the current workaround.

Maintainer release notes live in [`docs/releases.md`](./docs/releases.md).

## Why openovel

Most coding-agent runtimes are single-loop systems: the user asks, the agent reasons, calls tools, and eventually returns. That shape works for coding tasks. It breaks for long-form interactive fiction, where the reader expects a response in seconds but the world model needs to keep evolving across hours of play.

openovel splits those concerns:

- **Foreground narrator**: fast, tool-free, and bounded. It reads a compact working set — `story/guidance/FOREGROUND.md`, selected context cards, recent canon, user preferences — and produces one chunk of prose.
- **Background brain**: slower, tool-equipped, and asynchronous. It receives the reader action plus the foreground response, then updates guidance, context cards, memory, state files, and pending inbox items at its own pace. By default this is a coordinated **resident team** (a Showrunner that composes the narrator's working set, plus specialized World Keeper / Director / Card Manager / Memory sub-agents); a single **Storykeeper** is the fallback.
- **File-native memory**: durable knowledge lives in ordinary files. Cards, world state, timelines, research, memory, and scene logs can be inspected, edited, diffed, and tested without an opaque retrieval layer.

## Requirements

- Node.js >= 20
- npm
- One supported model provider key. The Electron onboarding flow can collect it; CLI and eval tooling read keys from settings or environment variables.

## Quick start

```bash
git clone https://github.com/Feed-Scription/openovel.git
cd openovel
npm install
npm run electron
```

`npm run electron` is the recommended daily-driver entry point and bundles the renderer on first launch. The desktop app then opens onboarding: pick UI / story language, paste a provider API key, optionally narrow the prose style with preference tags. Everything else lives behind the gear icon in Settings (API keys, behavior toggles, preferences, environment paths).

Try a first action in the input bar:

```text
I wake up in the abandoned ferry terminal and look around.
```

The narrator answers in seconds. The background brain continues asynchronously, so the next turn benefits from updated continuity without blocking the current one.

## How it works

<p align="center">
  <img src="./assets/architecture.svg" alt="openovel dual-loop architecture: a fast foreground narrator, a file-native substrate, and an asynchronous background resident team" width="100%" />
</p>

The runtime appends every turn to `story/canon/scene_log.jsonl` and queues pending background work in `story/inbox/INBOX.md`. The background brain later resolves those items into `story/frontend/*`, `story/guidance/FOREGROUND.md`, `story/memory/MEMORY.md`, and `story/state/*`.

## Features

Most surface features are toggles in Settings → Behavior. Opt-in experimental features also have matching `OPENOVEL_ENABLE_*` environment variables. Defaults below are for a fresh install.

**On by default**

- **Suggested choices** — a separate post-narration call proposes a few next actions the reader can pick instead of typing (`OPENOVEL_OPTIONS_ENABLED`).
- **Reading-pace reveal** — prose reveals at a local reading speed, independent of how fast the model streams (`OPENOVEL_DISPLAY_CPM`, default 720).
- **Resident agent team** — the background brain runs as a Showrunner coordinator plus specialized sub-agents; set `OPENOVEL_RESIDENT_TEAM=0` for the single-Storykeeper path.
- **Repetition / tic control** — the runtime ranks the narrator's most-repeated phrases and feeds them back so the background team can tighten guidance and kill verbal tics.
- **Novel export** — export a finished story to EPUB or TXT from the story menu.

**Opt-in / experimental** (off by default)

- **Rich rendering** — the narrator emits `ovl:<kind>` blocks that render as styled cards, stat panels, and a persistent HUD, from a per-story HTML/CSS contract (`OPENOVEL_ENABLE_FORMAT_CONTRACT`).
- **Media includes** — embed images, video, audio, or text from the story's `includes/` folder via an `ovl:include` directive (`OPENOVEL_ENABLE_STORY_INCLUDES`).
- **Scene backdrops** — a dimmed full-page background image sits behind the narration (`OPENOVEL_ENABLE_IMAGE_BACKGROUND`).
- **Image generation** — a background image agent prepares scene art and character references ahead of the plot (`OPENOVEL_ENABLE_IMAGE_GEN`; requires an image-provider key).
- **Background music** — a music agent curates mood tracks the narrator cues by id (`OPENOVEL_ENABLE_MUSIC_GEN`).
- **Narration audio** — speak the narration through a configured text-to-speech provider (`OPENOVEL_ENABLE_TTS`).
- **Comic mode / Fast mode** — per-story modes that swap prose for a picture-panel strip, or for short, time-compressing bursts.
- **Setup voice preview** — audition the narrator's voice on the draft during story setup (`OPENOVEL_ENABLE_INIT_NARRATOR_PREVIEW`).

Model-authored rich content is sandboxed: block templates are HTML filtered to a closed tag/attribute allowlist and CSS passed through a property allowlist before rendering (never `innerHTML`), and the narrator never sees raw CSS. Block *kinds* are open — the model composes ordinary HTML — while the capability envelope stays closed.

## Settings and providers

For normal use, configure models inside the desktop app. First launch walks through two steps: choose a language, then connect an LLM by pasting an API key. Later, use the gear icon → **AI → API Keys** to pick a provider, save the key, and run **Test connection**.

Simple settings mode keeps this to the common path. Advanced mode adds custom OpenAI-compatible or Anthropic-format endpoints, model routing, per-agent routing, and model catalog edits. Optional services such as search, image generation, speech, behavior toggles, display, and environment paths live in the adjacent Settings tabs.

The Settings UI saves secrets and toggles to `$OPENOVEL_HOME/settings.local.json` (default `~/.openovel/settings.local.json`) and mirrors them into the app environment at startup. CLI and eval tools read the same settings. General JSONC config files layer in this order, with later entries winning:

```text
defaults
  -> ~/.openovel/settings.jsonc
    -> .openovel/settings.jsonc
      -> .openovel/settings.local.json
        -> environment variables
```

JSONC and trailing commas are supported, along with `{env:VAR}` and `{file:path}` interpolation.

Useful diagnostics:

```bash
npm run config:doctor       # show settings layering + effective config
npm run provider:doctor     # show provider + model resolution when debugging routing
```

## Project structure

```text
src/
  runtime/       shared engine: sessions, jobs, events, tools, permissions
  workflows/     agent packs: Storykeeper/Showrunner, resident agents, initializer, memory review, onboarding
  lib/           story files, narration, snapshots, paths, retry helpers
  context/       foreground prompt compilation and context-card inserts
  provider/      provider registry, model profiles, OpenAI-compatible adapters
  electron/      desktop app: main process, preload, renderer, IPC bridge
  tools/         tool registration
  agents/        resident agent cards (*.agent.yaml) + subagent definitions
  memory/        memory store and registry
  search/        web search provider registry
  eval/          smoke tests, probes, judge, model-player harnesses
  config/        settings resolution and doctor
test/            node --test suites
scripts/         build and launch helpers
story/           local story workspace, normally gitignored runtime data
```

The main runtime path:

```text
UI -> SessionViewModel -> SessionProcessor
   -> Foreground Narrator -> Provider
   -> BackgroundJob -> BackgroundAgentRuntime -> ToolLoop -> ToolRegistry
   -> StoryStore / files
```

## Storage model

openovel uses two roots:

```text
~/.openovel/                 user-global data
  memory/USER.md             user-owned preferences (model read-only)
  memory/OBSERVED.md         model-observed reader notes (memory-review writes)
  context-cards/             reusable cards
  references/                shared reference material
  stories/<story-id>/        optional per-story workspaces

story/                       project-local working story
  BRIEF.md                   original brief — written once at init, then read-only
  canon/                     chapters and append-only scene log
  frontend/                  narrator-facing sections composed into the foreground
  guidance/                  FOREGROUND.md (read-only composed view), FG_template.md (manifest), cards.md, cards.auto.md
  director/ worldkeeper/     internal agent scratchpads (analysis, planning, simulation)
  state/                     structured world state such as stats and characters
  context-cards/             story-scoped cards
  inbox/                     pending and resolved background work
  memory/                    story-scoped memory
  format/ includes/          opt-in rich-render contract + embeddable media
  research/ packets/         search log + per-turn diagnostics
```

`frontend/`, `guidance/`, and the context cards are narrator-facing — every word there can reach the reader. `director/`, `worldkeeper/`, `state/`, and the per-turn `packets/` are internal scratchpads the narrator never sees; the background agents use them for analysis, planning, and world simulation.

USER.md and OBSERVED.md split global memory by writeability: the user owns USER.md (Settings UI + onboarding); the model owns OBSERVED.md (background memory-review loop). File tools enforce the read-only constraint on USER.md regardless of which workflow is running.

`OPENOVEL_HOME` defaults to `~/.openovel`. `OPENOVEL_STORY_ID` and `OPENOVEL_STORY_ROOT` control story workspace resolution. Legacy `AI_STORY_*` variables are still recognized for compatibility.

## Commands

```bash
# interactive
npm run electron              # default — desktop client (bundles renderer on launch)
npm run electron:dev          # desktop client with devtools

# build
npm run build:electron        # bundle renderer to dist-electron/ (run by `npm run electron`)
npm run dist                  # electron-builder package (add :mac / :win / :linux for one platform)

# tests
npm test                                                           # full suite
node --test test/sessionViewModel.test.js                          # single file
node --test --test-name-pattern "<regex>" test/foo.test.js         # filter by name

# diagnostics
npm run config:doctor                                              # settings + env layering
npm run provider:doctor                                            # provider + key + model resolution

# evals
npm run eval:smoke -- --action "..." --expect "..." --wait-background
npm run eval:model-player                                          # DeepSeek-driven simulated reader
npm run eval:judge                                                 # LLM judge over a generated story
npm run eval:ablation                                              # toggle OPENOVEL_ABLATION_DISABLE_* per child run
npm run eval:tms:prepare && npm run eval:tms                       # Tell-Me-A-Story benchmark adapter
```

## Tests

`node --test` runs everything under `test/*.test.js`. The suite is hermetic: no network calls, no real model invocations, no writes outside temporary directories. New features should mock providers through `src/provider/provider.js` and assert on durable file patches or `SessionViewModel` state, not on generated prose.

## Contributing

Issues and focused pull requests are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for development guidelines and good first contribution areas.

## Troubleshooting

- Provider routing looks wrong: `npm run provider:doctor`.
- Settings are not taking effect: `npm run config:doctor` to inspect the layering order.
- Renderer bundle is stale after a pull: `rm -rf dist-electron && npm run electron`.
- A clean local story workspace: `story/` is project-local runtime data and is normally gitignored.

## FAQ

**What is openovel?**
openovel is an open-source, local-first AI interactive fiction runtime. A fast foreground narrator responds to the reader in seconds, while an asynchronous background agent team keeps continuity, memory, and world state in plain Markdown / JSON files.

**What design problem is openovel focused on?**
Long-running interactive fiction needs low-latency prose and durable continuity at the same time. openovel keeps the narrator fast and bounded, then lets background agents maintain the slower story substrate in files.

**Is my data private? Where is it stored?**
Your story, memory, and settings stay on your machine, under `story/` and `~/.openovel/`. openovel only contacts the model provider you configure; nothing else leaves your computer.

**Which AI models does it support?**
Use Settings → AI → API Keys to pick a built-in option or add a custom OpenAI-compatible / Anthropic-format endpoint.

**What platforms does it run on?**
A cross-platform Electron desktop app for macOS, Windows, and Linux. It is primarily tested on macOS today.

**Is openovel free and open source?**
Yes — it is released under the Apache-2.0 license.

## Acknowledgements

The dual-loop interaction model is inspired by Thinking Machines writing on interaction models, and the runtime shape borrows from Claude Code, opencode, and Hermes Agent. The file-native context substrate is a deliberate departure from vector-RAG patterns in the AI-fiction community, informed by long-run experiments with AI-fiction tools and `fate-river`, this project's prequel.

## License

Apache License, Version 2.0. See [`LICENSE`](./LICENSE) for the full text.
