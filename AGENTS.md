# PandaCode — working notes

This file is loaded into every Muse session and subagent, so it must
stay under the 65,536-byte startup limit (guard: `tests/agents-md.test.mjs`).
Keep it to rules an agent needs before writing any code. Detailed subsystem
notes live in [docs/agent-reference.md](docs/agent-reference.md) — read the
section for an area before changing it. New detail goes there or in
`docs/*.md`, not here.

## Project and releases

- Open source (MIT-based PandaCode License in `LICENSE`; forks must credit
  PandaCode). No accounts, license checks or telemetry; never add code that
  phones home, and never commit secrets or personal paths. Any new automatic
  network request goes in the README privacy table and website privacy page.
- Shipping: follow [docs/releasing.md](docs/releasing.md) —
  `npm run release:version X.Y.Z`, write `releases/X.Y.Z.md`, tag `vX.Y.Z`.
  Only release when the user asks.
- Contributor setup and PR process: [CONTRIBUTING.md](CONTRIBUTING.md).
  CI is `.github/workflows/ci.yml`. Commits: `<type>: <description>`.

## Verify

- `npx tsc --noEmit` — typecheck (also runs inside `npm run build`).
- `npm test` — Node unit tests (`tests/*.test.mjs`).
- `npm run test:release` — release script tests (`scripts/release/*.test.mjs`).
- `npx playwright test` — browser suite against the Vite preview
  (`npm run dev` on 127.0.0.1:1420, reused if already running; in a second
  worktree set `PW_PORT=<free port>`). Full run ≈ 3.5 min; pass file paths
  or `-g "title"` for a subset. Needs Google Chrome.
- `npx playwright test -c playwright.webkit.config.ts` — same suite in
  WebKit (the real target is WKWebView).
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml` and Clippy with
  `-D warnings` when Rust changes.

## Always-on rules

### UI

- Colour: never write a literal accent colour. Use `--accent`,
  `--accent-rgb` (for `rgb(var(--accent-rgb) / a)`), `--on-accent`,
  `--accent-dim`/`--accent-ink`, `--focus`, `--accent-hover`, `--accent-tint`
  (set by `src/palette.ts` / `src/palette-core.ts`). Detail:
  [reference](docs/agent-reference.md#colour-material-and-flat-ui),
  [tests/palette.test.mjs](tests/palette.test.mjs).
- Material: every floating surface (dialog plate, menus, tooltips, toast)
  is the one `--glass-*` glass in `src/motion.css` (translucent fill +
  backdrop blur + 1px `--glass-border` hairline, no highlight or ring),
  with solid fallbacks for reduced transparency/contrast.
- Surfaces: hairline `--ds-border` plus `--ds-shadow-card` /
  `--ds-shadow-raised`; fills are `--ds-card` / `--ds-card-inner` /
  `--ds-raised`. Use only `--ds-*` tokens, never literal greys. Increase
  Contrast turns hairlines solid and drops shadows. Tokens live in
  `src/design-system.css`. Detail:
  [reference](docs/agent-reference.md#colour-material-and-flat-ui).
- Inset shell (`src/inset-shell.css`): the frame (`--frame`) fills
  `.workspace`; sidebar and Settings nav sit on it with no fill. Conversation,
  inspector and Settings content are inset `--panel-surface` panels (12px
  radius, 8px from window edges, no border); with the sidebar hidden the
  main pane is full-bleed. Detail:
  [reference](docs/agent-reference.md#inset-shell),
  [tests/layout-preferences.spec.ts](tests/layout-preferences.spec.ts).
- Motion (`src/motion.ts`, `MOTION = true`): short critically damped springs
  (~120–220 ms, exits ~120 ms), never gated input, always an instant path
  (`MOTION = false`). CSS transitions only for colour, background, opacity,
  box-shadow, `scale`/`rotate` (100–200 ms); never animate layout. Press
  feedback uses `scale`, never `transform`. Respect
  `prefers-reduced-motion`. Detail:
  [reference](docs/agent-reference.md#motion).
- The `<dialog>` stays transparent and untransformed (`.dialog-plate`
  carries the glass); never put `backdrop-filter`/`transform` on it. Menu
  triggers (`aria-haspopup`) keep `--press: 1`. Segmented controls hand
  their highlight to `.segment-thumb` via `trackSegment()`. Detail:
  [reference](docs/agent-reference.md#dialogs-menus-and-segmented-controls).
- Menus and dialogs are one line per row; long details/help move behind an
  `infoMark()` (`src/tooltip.ts`) with the text still in the DOM as
  `.sr-only` (live hints opt out with `data-live`; never nest a mark inside
  a `<label>`/`<h2>`). Detail:
  [reference](docs/agent-reference.md#menu-and-dialog-text-rules).
- Composer-rendered UI must be styled from an always-loaded stylesheet;
  lazily imported CSS (e.g. `architect.css`) arrives too late.
- Markdown everywhere goes through `markdownHtml()` in `src/dom.ts`
  (vendored md4c Wasm + DOMPurify + lazy KaTeX). CSP keeps
  `'wasm-unsafe-eval'`, never `'unsafe-eval'`
  ([tests/bundle.test.mjs](tests/bundle.test.mjs) guards this). New Markdown
  elements need `.md-*` styles in `styles.css`. Detail:
  [reference](docs/agent-reference.md#markdown-rendering).

### Native and agents

- `workspace::run_process` is the one bounded runner for external tools
  (`git`, `gh`); user text goes to `gh` as `--flag=value`. Turn-speed and
  warm-process rules: [reference](docs/agent-reference.md#native-runner-and-turn-speed).
- Add a browser preview mock in `src/preview.ts` for every new IPC command
  so Playwright can cover it ([reference](docs/agent-reference.md#browser-preview-mocks)).
- Adding a provider touches every `"kimi" | "opencode" | "antigravity"`
  match in `providers.rs`/`acp.rs`, allowlists in `storage.rs`,
  `overlay.rs`, `architect*.rs`, `terminal.rs`, `slash_commands*.rs`,
  `provider_settings.rs`, plus `ProviderId` and its `Record` maps on the
  frontend (tsc flags the maps). Record real frames in tests; keep an
  ignored live smoke test per installed CLI. Detail:
  [reference](docs/agent-reference.md#harnesses-providers-and-storage-schema),
  [docs/providers.md](docs/providers.md).
- Storage schema is at `user_version` 36. A migration bumps
  `storage::SCHEMA_VERSION`, adds the `PRAGMA user_version=` step, and
  updates the tests that assert the number. Full version history:
  [reference](docs/agent-reference.md#harnesses-providers-and-storage-schema).
- Provider environment variables merge in `environment()`
  (`provider_settings.rs`) and apply at every harness spawn; cloud runs
  inherit nothing unless explicitly enabled per cloud. Detail:
  [reference](docs/agent-reference.md#harnesses-providers-and-storage-schema),
  [docs/providers.md](docs/providers.md#environment-variables).
- Secrets go through `secret_store.rs` (macOS: one 0600 `secrets.json` in
  app data, never the Keychain) and never reach the webview.

## Area index — read before changing

Each row: area — key files — where the detail lives. The reference preserves
the original `AGENTS.md` bullets verbatim; `docs/*.md` holds the design docs.

- Shell motion, thread switching, sidebar collapse — `src/motion.ts`,
  `src/main.ts` (`settleIn`, `holdTranscript`) —
  [reference](docs/agent-reference.md#motion),
  [reference](docs/agent-reference.md#thread-switching).
- Action dock — `src/action-dock.ts`, `src/action-dock.css`,
  `#action-dock` — [reference](docs/agent-reference.md#action-dock),
  [tests/action-dock.spec.ts](tests/action-dock.spec.ts).
- Workspace view (Conversation/Board/GitHub), top row, inspector strip —
  `src/inspector-bar.css`, `renderSidebarVisibility`, `renderInspector` —
  [reference](docs/agent-reference.md#workspace-view-switch),
  [reference](docs/agent-reference.md#top-row-and-header),
  [reference](docs/agent-reference.md#inspector-strip-and-tabs).
- App updates — `src/app-updates.ts`, `src/app-updates-policy.ts` —
  [reference](docs/agent-reference.md#app-updates). This is PandaCode's only
  self-check; keep the privacy docs in step.
- Tray / menu bar item — `src-tauri/src/tray.rs`, `src/tray-popover.ts` —
  [reference](docs/agent-reference.md#menu-bar-item-tray),
  [tests/tray-popover.spec.ts](tests/tray-popover.spec.ts).
- GitHub view, branches, worktrees, linked PRs — `src/github-hub.ts`,
  `src/worktrees.ts`, `src/github.ts`, `src/github-pull.ts` — everything
  returns nothing while `githubEnabled()` is false —
  [reference](docs/agent-reference.md#github-view),
  [reference](docs/agent-reference.md#branches-worktrees-and-linked-prs),
  [docs/github.md](docs/github.md), [docs/worktrees.md](docs/worktrees.md).
- Token saver — `src/token-saver.ts`, `src/token-saver-panel.ts` —
  [reference](docs/agent-reference.md#token-saver).
- Local VMs and cloud sandboxes/deploys — `src-tauri/src/vm*`,
  `src-tauri/src/cloud*` — machine IDs are `provider:native-id` —
  [reference](docs/agent-reference.md#local-vms),
  [reference](docs/agent-reference.md#cloud-sandboxes-and-deploys).
- Cloud agents — `src-tauri/src/cloud_agents/`, `src/cloud-agents.ts` —
  [reference](docs/agent-reference.md#cloud-agents),
  [docs/cloud-agents.md](docs/cloud-agents.md).
- Agents panels, teams, model picker — `mountAgents()` in
  `src/action-dock.ts`, `src/agent-teams.ts`, `src/model-picker.ts` —
  [reference](docs/agent-reference.md#agents-panels-in-the-dock),
  [reference](docs/agent-reference.md#teams),
  [reference](docs/agent-reference.md#model-picker),
  [docs/architect-workers.md](docs/architect-workers.md).
- Attachments, thread switching, sidebar sections, find, agent questions —
  `src/attachments.ts`, `src/sidebar-sections.ts`, `src/thread-find.ts`,
  `src/agent-input.ts` —
  [reference](docs/agent-reference.md#prompt-attachments),
  [reference](docs/agent-reference.md#sidebar-sections),
  [reference](docs/agent-reference.md#find-in-thread),
  [reference](docs/agent-reference.md#agent-questions).
- Queue and steering — `src/message-queue.ts`, `providers/steering.rs` —
  Enter queues, ⌘/Ctrl-Enter steers; steering never stops a run —
  [reference](docs/agent-reference.md#queue-and-steering),
  [docs/parity-plan.md](docs/parity-plan.md).
- Remote access (Connect) and machine orchestration — `src-tauri/src/remote*`,
  `relay/`, `src/remote*.ts` — opt-in, end-to-end encrypted, no traffic
  before GitHub sign-in —
  [reference](docs/agent-reference.md#remote-access-and-machine-orchestration),
  [docs/remote-access.md](docs/remote-access.md),
  [docs/machine-orchestration.md](docs/machine-orchestration.md).
- Headless host — `pandacode serve`, `src-tauri/src/headless.rs` — frontend
  behaviours with real effects need a native twin —
  [reference](docs/agent-reference.md#headless-host),
  [docs/headless.md](docs/headless.md).
- Bots — `src-tauri/src/bots*`, `src/bots*.ts` —
  [reference](docs/agent-reference.md#bots), [docs/bots.md](docs/bots.md).
- Chats — `src-tauri/src/chats.rs`, `src/chats.ts` —
  [reference](docs/agent-reference.md#projectless-chats),
  [docs/chats.md](docs/chats.md).
- Visual progress, design canvas, skills library, Jujutsu, capabilities —
  [reference](docs/agent-reference.md#visual-progress),
  [reference](docs/agent-reference.md#design-canvas),
  [reference](docs/agent-reference.md#skills-and-rules-library),
  [reference](docs/agent-reference.md#jujutsu),
  [reference](docs/agent-reference.md#capabilities-and-cache-panel),
  [docs/visual-progress.md](docs/visual-progress.md),
  [docs/design-canvas.md](docs/design-canvas.md),
  [docs/skills-library.md](docs/skills-library.md),
  [docs/jj.md](docs/jj.md), [docs/capabilities.md](docs/capabilities.md).
- Schedules, recipes, turn checks — `src-tauri/src/schedules/`,
  `recipes.rs`, `checks.rs` —
  [reference](docs/agent-reference.md#task-schedules),
  [reference](docs/agent-reference.md#workflow-recipes),
  [reference](docs/agent-reference.md#turn-checks),
  [docs/schedules.md](docs/schedules.md), [docs/recipes.md](docs/recipes.md).
- Files, file tabs and workspace search — `src/file-tabs.ts`,
  `src/search-panel.ts`, `workspace::search_text` —
  [reference](docs/agent-reference.md#files-and-file-tabs),
  [reference](docs/agent-reference.md#workspace-search).
- /btw side threads — `src/btw-panel.ts`, `src/btw.ts` — panel controls act
  on the side thread via `actionTask()`, never the main one —
  [reference](docs/agent-reference.md#btw-side-threads),
  [docs/btw.md](docs/btw.md), [tests/btw.spec.ts](tests/btw.spec.ts).
- Model routing (Panda Router) — `src-tauri/src/panda_router*`,
  `src/model-routing.ts` —
  [reference](docs/agent-reference.md#model-routing),
  [docs/model-routing.md](docs/model-routing.md).
- Specific harnesses — Devin (`providers/devin.rs`, never call
  `authenticate`), ZCode (`providers/zcode.rs`, private app-server protocol)
  — [reference](docs/agent-reference.md#devin-cli),
  [reference](docs/agent-reference.md#zcode),
  [docs/providers.md](docs/providers.md).
- Mobile app — `mobile/` (Expo viewer/controller; never runs tasks) —
  start from [mobile/AGENTS.md](mobile/AGENTS.md); full notes:
  [reference](docs/agent-reference.md#mobile-app). Verify with
  `cd mobile && npx tsc --noEmit && npm test && npx expo lint`.
