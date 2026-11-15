# Contributing to PandaCode

Thanks for helping. PandaCode is an open-source desktop app (MIT-based
[PandaCode License](LICENSE)) built with Tauri 2
(Rust in `src-tauri/`), plain TypeScript (`src/`) and an Astro website
(`website/`). This guide covers setup, checks and pull requests. Code
conventions for humans and coding agents are in [AGENTS.md](AGENTS.md).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security issues privately as described in [SECURITY.md](SECURITY.md),
not in public issues.

## Prerequisites

- **Node.js 22** and npm.
- **Rust stable** via [rustup](https://rustup.rs/).
- **Git**, and at least one coding CLI (Claude Code, Codex, Kimi Code, OpenCode, …)
  if you want to run real agent turns.
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and
    the WebView2 runtime (preinstalled on Windows 11).
  - **Linux (Debian/Ubuntu):**

    ```sh
    sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libdbus-1-dev libayatana-appindicator3-dev librsvg2-dev
    ```

## Set up and run

```sh
git clone https://github.com/aicodeking/pandacode.git
cd pandacode
npm ci
npm run tauri dev      # or: npm run desktop
```

`npm run dev` starts only the Vite frontend on http://127.0.0.1:1420. In a
normal browser it runs a labeled sample workspace with mocked native commands
(`src/preview.ts`), which is what the Playwright suite uses. Add a preview mock
for every new IPC command.

Never point a development build at your real data with risky changes: pass a
different identifier, for example
`npx tauri dev --config '{"identifier":"ai.pandacode.dev"}'`.

To build an installer for your OS: `npm run tauri build`, or
`npm run release:build` for the same packaging the release workflow uses (see
[docs/releasing.md](docs/releasing.md)).

## Checks

Run these before opening a pull request:

```sh
npx tsc --noEmit                                     # typecheck
npm run build                                        # typecheck + bundle; tests read dist/
npm test                                             # Node unit tests (tests/*.test.mjs)
npm run test:release                                 # release script tests
cargo test --manifest-path src-tauri/Cargo.toml      # Rust tests
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

For UI changes, also run the relevant Playwright tests in Chrome and WebKit
(the app runs in WKWebView on macOS):

```sh
npx playwright install chromium webkit               # once
npx playwright test tests/your-area.spec.ts
npx playwright test -c playwright.webkit.config.ts tests/your-area.spec.ts
```

The full browser suite takes several minutes; pass file paths or `-g "title"`
for a subset. Ordinary tests never call paid models. Live provider tests are
`#[ignore]`d and opt-in.

When a change alters how the app looks, refresh the README screenshots with
`npm run screenshots` (needs `cwebp`, e.g. `brew install webp`). It captures the
browser preview with the sample data in `scripts/screenshots/showcase.js` and
writes framed WebP images to `docs/screenshots/`.

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests, website build,
and `cargo test --lib`/Clippy on Linux for every pull request.

## Pull requests

1. Open an issue first for large changes so we can agree on the approach.
2. Branch from `main`, keep the change focused, and add or update tests
   (we aim for tests first: write a failing test, then make it pass).
3. Update docs in `docs/` when behavior changes.
4. Make sure the checks above pass, then open a PR using the template. Describe
   what changed, why, and how you tested it, with screenshots for UI changes.
5. A maintainer reviews it; please respond to feedback with new commits rather
   than force-pushing over review history.

### Commit messages

Use `<type>: <description>` in the imperative mood, for example
`fix: keep the caret when the composer re-renders`.

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

### Ground rules

- No telemetry, analytics or calls home. Network requests must go only to
  services the user chose, or be public, anonymous checks documented in the
  README's privacy section.
- Never commit secrets, API keys or personal paths. Provider keys belong in the
  OS keychain (`secret_store.rs`).
- Keep files small and focused, and handle errors explicitly.
- Wrap user-visible UI strings with `t()` from `src/i18n.ts` (mobile: `mobile/src/i18n/core.ts` via `useT()`), and add the new keys to the catalogs in `src/locales/` (and `mobile/src/i18n/catalogs.ts`). `tests/i18n.test.mjs` fails CI until both full Chinese catalogs carry the new keys with matching `{n}` placeholders — see [src/locales/GLOSSARY.md](src/locales/GLOSSARY.md).
- By contributing, you agree your contributions are licensed under the
  [PandaCode License](LICENSE).
