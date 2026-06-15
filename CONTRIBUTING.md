# Contributing

Thanks for taking a look at openovel.

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

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Do not commit provider API keys, generated story logs, packaged apps, model
  transcripts, or private benchmark data.
- For UI changes, include a short note about the surface tested.
