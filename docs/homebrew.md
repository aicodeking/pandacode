# Homebrew

PandaCode has an official tap,
[aicodeking/homebrew-pandacode](https://github.com/aicodeking/homebrew-pandacode).

```sh
brew install --cask aicodeking/pandacode/pandacode   # macOS 12+, Apple silicon or Intel
brew install aicodeking/pandacode/pandacode          # Linux x86_64 or aarch64
```

## What it installs

- `Casks/pandacode.rb` installs `PandaCode.app` from the release's
  `PandaCode-macOS-arm64.dmg` or `PandaCode-macOS-x64.dmg`, checked against the
  sha256 in the cask. It sets `auto_updates true` because PandaCode updates itself,
  so `brew upgrade` leaves it alone unless you pass `--greedy`.
  `brew uninstall --zap --cask pandacode` also removes PandaCode's own data under
  `~/Library` (the `ai.pandacode.desktop` folders, caches, preferences and WebKit
  storage). It never touches your projects or `~/PandaCode Chats`.
- `Formula/pandacode.rb` installs `PandaCode-Linux-x86_64.AppImage` or
  `PandaCode-Linux-aarch64.AppImage` as `bin/pandacode`. It is Linux-only
  (`depends_on :linux`); on macOS use the cask. AppImages may need FUSE 2 (`libfuse2`).

The cask has no preflight or postflight scripts and does not remove the quarantine
flag; the app is signed and notarized, so macOS opens it without a warning.

## How it stays current

The tap updates itself, so releasing PandaCode needs no change here and no secret in
this repository. Its `.github/workflows/update.yml` runs every 3 hours, on demand
(`workflow_dispatch`) and on a `pandacode-release` repository dispatch. It:

1. reads the latest release tag of `aicodeking/pandacode` with `gh api` and stops
   unless it matches `^v\d+\.\d+\.\d+$`;
2. downloads the four macOS and Linux `.sha256` files from that release and checks
   that each holds a 64-character hex digest;
3. rewrites the version and checksums in the cask and formula, and commits and pushes
   only if something changed, using the tap's own `GITHUB_TOKEN`
   (`permissions: contents: write`).

Release values reach the scripts only through environment variables, never inline in
`run:`, and every action is pinned to a commit SHA. `.github/workflows/test.yml` runs
`brew style` and `brew audit --strict` on the cask and formula for every push and pull
request.

The cask and formula name the release assets, so renaming a macOS or Linux asset in
`release.yml` breaks the tap until it is updated as well.

## Credits

The tap was proposed and first built by Samuel Jędrzejewski
([@238SAMIxD](https://github.com/238SAMIxD)) in issue #85 and PR #90.
