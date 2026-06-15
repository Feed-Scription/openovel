# Releases

openovel is still in the Demo phase, so releases should make the desktop app
easy to try without implying a stable plugin or file-format API.

## What gets released

The maintained product surface is the Electron desktop app. A tagged release can
attach packaged builds for:

- macOS: portable universal zip.
- Windows: portable x64 executable.
- Linux: x64 AppImage.

The packages are currently unsigned. The project does not have an Apple
Developer ID certificate yet, so macOS builds are ad-hoc signed but not
Developer ID signed or notarized. Gatekeeper warnings are expected for downloaded
macOS artifacts until a future signing/notarization setup is added. See
[`docs/macos-gatekeeper.md`](./macos-gatekeeper.md).

## Release checklist

1. Update version metadata if the release should carry a new package version.
2. Run the local checks:

   ```bash
   npm ci
   npm test
   npm run build:electron
   ```

3. Confirm the README quick-start path still matches the app onboarding.
4. Tag the commit:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

5. The `release` GitHub Actions workflow builds packages and opens a draft
   GitHub Release with generated notes.
6. Download at least the macOS package from the draft release, launch it, and
   verify onboarding reaches the provider-key screen. Because the app is
   unsigned and not notarized, document any Gatekeeper workaround in the release
   notes instead of treating the warning as a packaging failure.
7. Publish the draft release once the attached artifacts look right.

## Manual packaging

Use these commands when testing release output locally:

```bash
npm run dist:mac:portable:universal
npm run dist:win
npm run dist:linux
```

Artifacts are written under `dist-electron/release/`.

## Release notes

Good release notes should answer three questions:

- What is newly playable or easier to try?
- What changed in the story/runtime architecture that users may notice?
- Are there data-layout or settings changes that existing users should know
  before upgrading?
- For macOS, remind users that the build is currently unsigned and not notarized
  while the project has no Apple Developer ID certificate. Link to
  [`docs/macos-gatekeeper.md`](./macos-gatekeeper.md).

Keep internal implementation detail out unless it helps users decide whether to
upgrade.
