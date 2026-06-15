# Resident agents — Agent Cards

Every background agent (the **Showrunner** coordinator and each specialized
sub-agent) is built from ONE generic scaffold (`src/workflows/residentAgent.js`)
and specialized entirely by a declarative **Agent Card** YAML. Adding, removing,
overriding, or re-purposing an agent is a config change — no code edit required.

## Where cards live

- **Built-in defaults:** `src/agents/*.agent.yaml` (shipped: showrunner, worldkeeper, director, cards, memory, render).
- **Per-story overrides / additions:** `story/agents/*.agent.yaml`. Loaded after the defaults; a card with the same `id` **overrides** the built-in (shallow merge), and a new `id` **adds** a new resident agent. Drop a file in, it runs.

`src/agents/loadAgentConfigs.js` discovers both, validates, derives the domain
paths (thread / inbox / lock under `story/<domain>/`), populates the channel inbox
map + the write-scope registry, and drops `enabledWhen: format-contract` agents
unless rich rendering is on.

## Schema

```yaml
id: lorekeeper                 # required, unique. Also the channel address + domain default.
kind: lore-agent              # free-form label (telemetry).
role: subagent                # coordinator | subagent. Exactly one coordinator (the Showrunner).
modelProfile: storykeeper     # which model profile to resolve (see provider/modelProfiles.js).
maxSteps: 30                  # tool-loop budget.
maxTokens: 10000
temperature: 0.35
toolConcurrency: 4
domain: lorekeeper            # → story/lorekeeper/ (its inbox, thread, lock, notebook).
tools: [read, edit, write, grep, glob, websearch, webfetch]   # includeTools whitelist.
writeScope:                   # globs this agent may WRITE (enforced by the tool-loop guard).
  - story/lorekeeper/**
readScope:                    # globs it may READ (default story/** — reads are broad).
  - story/**
enabledWhen: always           # always | format-contract.
turnBroadcastWhen: always     # always | custom-rich-blocks. Evaluated PER BROADCAST (not at load):
                              # an ineligible agent skips the per-turn summary + launch but stays
                              # registered and message-woken (forAgents → wakeAgent). E.g. the Render
                              # Manager drops to message-only while the reader displays custom blocks
                              # in the plain host style.

# System prompt — choose ONE (precedence: systemPrompt > promptFile > prompt):
systemPrompt: |               # inline: author the agent's behavior right here.
  You are the Lore Keeper. Maintain a wiki of world lore under your domain...
# promptFile: lorekeeper.md   # OR a path (relative to this YAML) to a prompt file.
# prompt: worldKeeperContract # OR a built-in named contract (src/prompts/agentContracts.js).
includeContract: true         # default true for sub-agents: auto-wrap a custom prompt with the
                              # shared safety contract + the standard { status, filesTouched,
                              # forShowrunner, forAgents } output envelope, so you only write domain guidance.
coordinates: [worldkeeper, director, cards, memory]   # (coordinator only) the agents it composes from.
```

## How it runs

Each turn the runtime broadcasts a short **summary + a pointer** to the latest
narrative into every agent's inbox (never the full prose — agents read it
themselves). A sub-agent reads canon + its own domain, writes ONLY its domain
(writes elsewhere are refused), and returns recommendations in `forShowrunner`.
The **Showrunner** reads the sub-agent domains + those recommendations and is the
single author of the narrator-facing `story/frontend/` + `story/guidance/`.

Sub-agents can also return `forAgents` peer requests:

```json
{
  "forAgents": [
    {
      "to": "worldkeeper",
      "priority": "now",
      "type": "state_check",
      "message": "Director needs a feasibility check: can Jieyi be at Fuse-no-oji on Turn 11? If not, retarget the entrance to the nearest plausible waypoint."
    }
  ]
}
```

These reuse the recipient's normal `story/<domain>/inbox.queue.jsonl`. If the
recipient is already running, it drains the message between tool calls; if it is
idle, the resident-team runtime wakes that peer sub-agent. Use `forShowrunner`
for the coordinator rather than targeting `showrunner` via `forAgents`.

Communication (foreground↔background and agent↔agent) all flows through the one
unified channel (`src/runtime/agentChannel.js`); delivery is mid-tool-call via the
`drainQueuedContext` hook. Per-agent leases (`src/runtime/agentLease.js`) let any
number of agents run without contending.

## Toggles

- `OPENOVEL_RESIDENT_TEAM` — `false`/`0`/`off` to fall back to the single
  Storykeeper; otherwise the team is on (default).
- `OPENOVEL_ENFORCE_AGENT_WRITE_SCOPE` — enforce `writeScope` (otherwise denials
  are logged but allowed, for observing false-denials during rollout).
