# Contributing

Thanks for taking a look at openovel.

openovel is young, so the most helpful contributions are the ones that make the
desktop app easier to try, easier to understand, or safer to change. Small,
focused pull requests are very welcome.

## Good first contributions

- Improve onboarding copy, troubleshooting notes, or settings explanations.
- Add or polish starter stories under `resources/starter-stories/`.
- Add focused tests around file persistence, provider routing, or view-model
  behavior.
- Improve cross-platform packaging notes for Windows or Linux.
- Add provider metadata for an OpenAI-compatible or Anthropic-format endpoint.
- Fix UI rough edges in the Electron renderer while matching the existing
  desktop reading surface.

## Development

Requirements:

- Node.js 20 or newer
- npm

Useful commands:

```bash
npm install
npm test
npm run electron
```

The runtime stores local stories and settings in `story/`, `.openovel/`, and
`~/.openovel/`. Keep those out of commits unless a future change explicitly
adds sanitized fixtures.

For provider and settings issues, these commands are usually the fastest way to
see what the app resolved:

```bash
npm run config:doctor
npm run provider:doctor
```

## Architecture guidelines

- Keep the two-loop shape intact: foreground narration stays fast, bounded, and
  tool-free; background workflows own slower continuity and state updates.
- Put story-domain behavior in `src/workflows/` or `src/prompts/`, not in the
  generic runtime.
- Treat ordinary files as the durable source of truth. Do not add a retrieval or
  database dependency unless the tradeoff is explicit and discussed first.
- Route model calls through `src/provider/provider.js`; do not import vendor SDKs
  directly.
- Do not silently drop, truncate, or reject user/model data. Surface discards
  through `src/lib/notices.js` where appropriate.

## Testing

Run the full suite before opening a pull request:

```bash
npm test
```

The suite should stay hermetic: no network calls, no real model invocations, and
no writes outside temporary directories. For behavior changes, prefer assertions
on durable file patches, event payloads, or `SessionViewModel` state instead of
asserting exact generated prose.

For UI changes, also run:

```bash
npm run electron
```

Mention the platform and surface you tested in the pull request.

## Starter stories

Starter stories are pre-initialized story snapshots seeded into a brand-new
library. See `resources/starter-stories/README.md` for the clean export format
and registration steps.

Good starter stories should:

- Reach a playable first decision quickly.
- Avoid private names, API keys, raw model transcripts, or personal filesystem
  paths.
- Show what openovel is good at: foreground momentum plus background continuity.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Do not commit provider API keys, generated story logs, packaged apps, model
  transcripts, or private benchmark data.
- For UI changes, include a short note about the surface tested.
- Link related issues when possible.
- Call out any on-disk story layout or settings changes.

## Community tone

Assume good intent, be specific about tradeoffs, and keep criticism tied to the
code or user experience. openovel touches creative writing, local data, and model
configuration, so privacy and user trust matter as much as clever architecture.
