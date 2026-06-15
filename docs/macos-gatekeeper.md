# macOS Gatekeeper Notes

openovel does not currently have an Apple Developer ID certificate. Until the
project adds Developer ID signing and notarization, downloaded macOS release
artifacts can trigger Gatekeeper warnings.

## What the release build does

The macOS release workflow uses the portable macOS build path:

```bash
npm run dist:mac:portable:universal
```

That script builds the Electron `.app`, applies an ad-hoc signature with
`codesign --sign -`, verifies the bundle, and zips the `.app` with `ditto`.
Ad-hoc signing helps local test builds launch consistently, especially on Apple
Silicon, but it is not the same as Developer ID signing and does not notarize the
app with Apple.

## If macOS blocks the app

For a downloaded release, users can remove the quarantine attribute after
extracting the app:

```bash
xattr -dr com.apple.quarantine /Applications/openovel.app
```

Then open the app again.

For developers testing local builds from a source checkout:

```bash
npm run mac:unquarantine -- /Applications/openovel.app
```

Replace the path with wherever the `.app` lives.

## What this does not solve

This does not prove publisher identity, does not notarize the app, and does not
turn Gatekeeper into a green-path install. The real fix is an Apple Developer ID
certificate plus hardened-runtime signing and notarization.

Until then, release notes should explicitly say that macOS builds are unsigned,
not notarized, and may require the quarantine workaround above.
