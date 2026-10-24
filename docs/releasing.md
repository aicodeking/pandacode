# Releasing PandaCode

PandaCode releases are GitHub Releases on
[aicodeking/pandacode](https://github.com/aicodeking/pandacode/releases). There
are no private servers: pushing a `vX.Y.Z` tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds
the desktop installers on GitHub-hosted runners and attaches them to a
release whose notes come from `releases/X.Y.Z.md`.

Instructions for agents: a request to write or review release instructions does
not authorize a release. Ship only what the user asked for, and preserve their
uncommitted work.

## Release assets

| Target | Runner / Rust target | Asset |
| --- | --- | --- |
| `darwin-aarch64` | `macos-latest` / `aarch64-apple-darwin` | `PandaCode-macOS-arm64.dmg` |
| `darwin-x86_64` | `macos-15-intel` / `x86_64-apple-darwin` | `PandaCode-macOS-x64.dmg` |
| `windows-x86_64` | `windows-2022` / `x86_64-pc-windows-msvc` | `PandaCode-Windows-x64-setup.exe` |
| `windows-aarch64` | `windows-11-arm` / `aarch64-pc-windows-msvc` | `PandaCode-Windows-arm64-setup.exe` |
| `linux-x86_64` | `ubuntu-22.04` / `x86_64-unknown-linux-gnu` | `PandaCode-Linux-x86_64.AppImage` |
| `linux-aarch64` | `ubuntu-24.04-arm` / `aarch64-unknown-linux-gnu` | `PandaCode-Linux-aarch64.AppImage` |

Each asset has a `NAME.sha256` file beside it (`sha256sum` format). Asset names
do not contain the version, so
`https://github.com/aicodeking/pandacode/releases/latest/download/<asset>`
always serves the newest build. There is no Windows ARM release target. The Intel Mac build runs natively on
`macos-15-intel` because `build.mjs` refuses to cross-build.

## Automatic updates

Installed copies update themselves from GitHub Releases with Tauri's updater
(`src/app-updates.ts`, `plugins.updater` in `src-tauri/tauri.conf.json`). Each release
also carries:

- `PandaCode-macOS-arm64.app.tar.gz`, `PandaCode-macOS-x64.app.tar.gz` and a `.sig` for each platform's update file
  (Windows and Linux update from their installer and AppImage), signed with the
  update key;
- `latest.json`, written by `scripts/release/updater-manifest.mjs`, naming the version,
  notes and each platform's file and signature.

The app reads `releases/latest/download/latest.json`, so publishing a release is what
ships the update. Signing needs two repository secrets, `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; without them the installers still build but
the release updates nobody. The matching public key is in `tauri.conf.json`.

**Keep the private key safe.** Installed apps accept only updates signed by it. If it
is lost, existing installs can no longer update and people must reinstall a build with
a new key; if it leaks, rotate it the same way. The maintainer's copy lives outside the
repository (never commit it). Update downloads need the release to be publicly
readable, so automatic updates start working once the repository is public.

## `npx pandacode`

`packages/npx` is the `pandacode` npm package: it downloads the latest release asset
(the updater file and its `.sig`), verifies the signature against the public key in
`tauri.conf.json` and installs it; on macOS it then runs the app with `--local-sign`.
The `npm` job in `release.yml` publishes it on tag runs with the release version, using
the repository secret `NPM_TOKEN` (an npm automation token); without it the job warns
and skips. If the update key is ever rotated, update `PUBKEY` in
`packages/npx/installer.mjs` (a test compares it with `tauri.conf.json`).

## Homebrew

The tap [aicodeking/homebrew-pandacode](https://github.com/aicodeking/homebrew-pandacode)
updates itself: every 3 hours it reads the latest release and its `.sha256` files and
commits the new version, so a release needs no step here and no secret in this
repository. To pick up a release sooner, run its `update` workflow by hand. Asset names
are part of the cask and formula, so renaming a macOS or Linux asset breaks the tap. See
[homebrew.md](homebrew.md).

## 1. Prepare the version

Work on `main` (or land your branch there first) with a clean, reviewed tree.

```sh
release_version=X.Y.Z
npm run release:version -- "$release_version"
```

This updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, the `pandacode` entry in `src-tauri/Cargo.lock`, and
records today's date in `website/src/data/release-dates.json` (the website's
`/changelog` uses it). Versions are plain numeric SemVer; prerelease suffixes
are rejected.

Write `releases/X.Y.Z.md` with the user-facing changes and known limitations.
The release workflow appends an "Installing" section with the unsigned-build
instructions, so do not repeat those.

## 2. Check

Run what CI runs, plus the browser suites for any UI change:

```sh
npm run build          # typecheck + frontend bundle (tests read dist/)
npm test
npm run test:release
cargo test --manifest-path src-tauri/Cargo.toml
npx playwright test    # or a focused subset; see AGENTS.md
```

## 3. Tag and push

```sh
git add -A package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml \
  src-tauri/Cargo.lock website/src/data/release-dates.json "releases/$release_version.md"
git commit -m "chore: release $release_version"
git tag "v$release_version"
git push origin main "v$release_version"
```

The workflow refuses a tag that does not match the version in
`tauri.conf.json`, and a missing or empty `releases/X.Y.Z.md`. Never move a
published tag; fix problems in a higher version.

To try the build without publishing, run the workflow manually (Actions →
Release → Run workflow) and leave **publish** unchecked: the installers are kept
as workflow artifacts for 14 days. Checking **publish** on a manual run creates
the release and the `vX.Y.Z` tag at the selected commit.

## 4. Watch and verify

```sh
gh run list --workflow release.yml --limit 5
gh run watch RUN_ID
gh release view "v$release_version"
```

The Windows and Linux jobs install or launch the packaged app on the runner and
check that it stays alive (`scripts/release/ci-startup-smoke.mjs`). That proves
only that it did not exit; it does not prove the window rendered. Before calling
a release stable, try each installer on a real machine and note which platforms
were not tested (see [platform support](platform-support.md)).

If a build fails after the tag was pushed, fix it on `main`, bump to the next
patch version, and tag again. If only the publish job failed, re-run it from the
Actions page; the build artifacts are reused.

## Local builds

On each native OS, after `npm ci`:

```sh
npm run release:build            # builds the host's target
# or: node scripts/release/build.mjs darwin-aarch64|darwin-x86_64|windows-x86_64|windows-aarch64|linux-x86_64|linux-aarch64
```

The script checks that all version files agree, runs `tauri build` for the
target, verifies the macOS signature and disk image, and copies the installer to
`release/X.Y.Z/<asset>` with its `.sha256`. It uploads nothing. On macOS, set
`CI=true` to skip the DMG Finder styling step, which needs Automation access.
For a quick unpackaged build, `npm run tauri build` is enough.

On Linux it also needs `mksquashfs` (`squashfs-tools`). The script rebuilds the
finished AppImage without the Wayland libraries linuxdeploy copied from the
Ubuntu 22.04 build host: those older copies stop newer Mesa EGL stacks from
loading and leave WebKit's web process with a blank window (Tauri issue #15665).
The image keeps its runtime and is signed again after the rebuild when update
signing is configured, so publish the asset `build.mjs` produces rather than the
raw `tauri build` output.

## Optional signing

Builds are unsigned by default: macOS gets an ad-hoc signature, Windows and
Linux are not signed. Users see first-launch warnings, which the release notes
explain.

An ad-hoc macOS build is not notarized, and Gatekeeper refuses to open it.
**Open Anyway** in System Settings → Privacy & Security does not always clear
that warning, so the release notes name the step that does:
`xattr -dr com.apple.quarantine /Applications/PandaCode.app`. `npx pandacode`
signs the app locally and needs no such step. The notes come from
`scripts/release/install-notes.mjs`, which takes `--signed` when a Developer ID
signature was used and then asks for no workaround.

To ship Developer ID signed and notarized macOS builds, add these repository
secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Its export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | Its issuer ID |
| `APPLE_API_PRIVATE_KEY` | Contents of the `AuthKey_*.p8` file |

When `APPLE_CERTIFICATE` is set, `scripts/release/ci-apple.mjs` imports it into
a temporary keychain and removes it after the build, and `build.mjs` requires
notarization credentials and checks the result with `stapler` and `spctl`.
Locally, export `APPLE_SIGNING_IDENTITY` plus either `APPLE_API_KEY`,
`APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`, or `APPLE_ID`, `APPLE_PASSWORD` and
`APPLE_TEAM_ID`.

Windows Authenticode signing is not wired up yet. Contributions are welcome.

## Sources

When this guide and the implementation disagree, trust the code:
[release workflow](../.github/workflows/release.yml),
[CI workflow](../.github/workflows/ci.yml),
[version setter](../scripts/release/set-version.mjs),
[build script](../scripts/release/build.mjs),
[shared targets](../scripts/release/common.mjs).
