# Configuration

openovel reads configuration from several layers. Later layers override earlier
ones:

```text
defaults
  -> ~/.openovel/settings.jsonc
    -> .openovel/settings.jsonc
      -> .openovel/settings.local.json
        -> environment variables
```

For local development, prefer the Settings UI or `.openovel/settings.jsonc`.
Use `.env` only for temporary shell workflows; it is ignored by git.

Run these diagnostics when a provider or model route looks wrong:

```bash
npm run config:doctor
npm run provider:doctor
```
