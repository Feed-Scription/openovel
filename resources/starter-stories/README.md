# Starter stories

Pre-initialized novels shipped with the app and seeded into a **brand-new
(empty) library** on first run, so a fresh user has something playable to open
without going through initialization first.

- Loader / seeder: [`src/lib/starterStories.js`](../../src/lib/starterStories.js)
- Snapshot format + clean export: [`src/lib/storySnapshot.js`](../../src/lib/storySnapshot.js)
- Packaged via `extraResources` in [`electron-builder.yml`](../../electron-builder.yml)
  (lands at `process.resourcesPath/starter-stories`; `src/electron/main.js` sets
  `OPENOVEL_STARTER_DIR` for dev vs packaged).

## Authoring a starter

1. **Build it in the app.** Create a story and let it initialize. Optionally
   play a few turns; whatever state you export becomes the opening the user sees.
2. **Export it clean.** In the library, open the story card menu →
   **导出为示例（干净）/ Export as sample (clean)**. This is the *clean* snapshot
   export: it strips runtime ledgers (`jobs/`, `packets/`, `profiles/`),
   resident-agent threads/queues/locks, and `research/search-log.md`, keeping
   only authored story content (canon, frontend, guidance, director, world
   state, memory, cover image, the `agents/init-*.json` replay).
   - Want the pristine 0-turn opening instead of your current progress? Use
     **Restart from opening** first, then export.
3. **Drop the JSON here**, e.g. `resources/starter-stories/lighthouse.json`.
4. **Register it in `index.json`** (see schema below).

> Tip: author starters under a clean home (`npm run electron -- --tmp-home`) so
> the export carries no traces from your real workspace. API keys never leak —
> they live in `~/.openovel`, outside the story root the snapshot captures.

## `index.json` schema

```jsonc
{
  "starters": [
    {
      "id": "lighthouse",        // stable logical id — the seeding marker key.
                                 //   NEVER reuse/rename across releases.
                                 //   Defaults to the filename stem if omitted.
      "file": "lighthouse.json", // bundle filename in THIS dir (no subpaths).
      "title": "灯塔看守人",       // optional; display name actually comes from
                                 //   the bundle's own meta.json.
      "lang": "zh",              // optional coarse tag: zh | en | ja | ko.
                                 //   Untagged ⇒ seeded in every locale.
      "order": 10                // optional sort key (ascending).
    }
  ]
}
```

## Seeding behavior

- Seeded **only into an empty library** (no user-created story yet).
- Per-home marker `~/.openovel/.starters-seeded.json` records seeded **logical
  ids**, so a starter the user deletes stays deleted, and an app update can add
  new starters without re-injecting old ones.
- Each starter is imported into its own fresh random slot (like any imported
  story) and banked as that story's "initial" baseline, so **Restart** works.
- `lang` filters to the reader's story-language preference (from `USER.md`);
  ambiguous preference ⇒ no language constraint.

An empty `starters` array (the committed default) ships no starters — the
feature is inert until you add bundles.
