# Static audit: telemetry and outbound requests — T3 Code (Nightly) vs PandaCode

Date: 2026-10-29. Method: reading the shipped code, with no network capture. "Verified reachable" means the call site was traced from a startup path or a user action to the request. "String only" means the host appears in a bundled library whose code path is never turned on in this build. "Not fully traced" means the call site exists but its startup timing was not proven.

- **T3 Code** `0.1.3-nightly.20261026.3717` (commit `1316d48b0c68`) from `/Applications/T3 Code (Nightly).app`, `app.asar` extracted to `/tmp/t3asar`. The bundles are not minified, so the line numbers below refer to the shipped files:
  - `apps/server/dist/binCli-BCouE1oK.mjs` (node server)
  - `apps/desktop/dist-electron/main.cjs` (Electron main)
  - `apps/server/dist/client/assets/*.js` (web client)
- **PandaCode**: worktree `bench/telemetry-compare` (== origin/main). Paths are relative to the repository root.

## Comparison table

| App | Endpoint / host | Process | Trigger | Data sent | Default on? | Opt-out | Evidence |
|---|---|---|---|---|---|---|---|
| T3 Code | `https://ingest.t3.codes/batch/` (PostHog, first-party proxy) | node server | Buffered events flushed every 10 s and at shutdown. `server.boot.heartbeat` fires at every launch. | Event name, uuid, timestamp, `distinct_id` (SHA-256 of the Codex `account_id`, else the Claude `userID`, else the install id), `installId` (SHA-256 of `~/.t3/userdata/anonymous-id`), platform, arch, WSL distro, app version, channel, client type, server mode, plus per-event properties (below). | **Yes** | `T3CODE_TELEMETRY_ENABLED=false` (also read from the login shell by the desktop app). `T3CODE_POSTHOG_HOST`/`_KEY` redirect it. No setting in the UI. | Verified reachable |
| T3 Code | `https://us-east-1.aws.edge.axiom.co/v1/traces` (OTLP to Axiom, dataset `t3-code-relay-traces-prod`) | node server + web client | Spans of T3 Connect relay operations only | OTLP spans with service name/version, `service.instance.id`, runtime, component, client surface, node runtime attributes, sanitized error stacks | Yes, **but only while T3 Connect is in use** | `T3CODE_TELEMETRY_ENABLED=false`, `T3CODE_OTEL_SDK_DISABLED=true` or `OTEL_SDK_DISABLED=true` | Verified wiring; Connect-only |
| T3 Code | `relay.t3.codes`, `clerk.t3.codes` (Clerk Frontend API), `app.t3.codes` | server / web client | T3 Connect link, sign-in. The Clerk auth shell is imported at web-client startup in the desktop build. | Account auth; relay traffic | Relay: only if a link is stored. Clerk: likely loads at launch. | Do not sign in or link | Relay: reachable when linked. Clerk at idle launch: not fully traced. |
| T3 Code | `github.com/pingdotgg/t3code/releases.atom` + `releases/download/…/nightly-mac.yml` (redirects to GitHub asset CDN) | Electron main (electron-updater) | 15 s after launch, then every **4 min** | Plain GET; User-Agent and app version | Yes | `T3CODE_DISABLE_AUTO_UPDATE=1`. No UI toggle; only the channel is configurable. | Verified reachable |
| T3 Code | `registry.npmjs.org/<pkg>/latest` | node server | Provider version advisory for installed and enabled providers when provider snapshots refresh | Plain GET | Yes (`enableProviderUpdateChecks` default true) | Setting `enableProviderUpdateChecks: false` | Reachable; startup timing not fully traced |
| T3 Code | `api.anthropic.com/api/oauth/usage`, `chatgpt.com`, `cursor.com`, `opencode.ai`, `cloudcode-pa.googleapis.com`, `api.expo.dev`, `dl.google.com`, `storage.googleapis.com`, `api.github.com` | node server | Usage page, provider installs, EAS simulator, preview browser download, GitHub PR features, CLI release lookups | The user's own tokens to that vendor | On use | Do not use the feature | Reachable on demand |
| T3 Code | `clerk-telemetry.com` | web client (Clerk SDK) | — | — | **No**: Clerk sends only for `instanceType === "development"`; the key is `pk_live_…` (`clerk.t3.codes`, production) | n/a | String only (gated off) |
| T3 Code | `as.coinbase.com`, `analytics-service*.cbhq.net` | web client (Coinbase Wallet SDK inside Clerk) | Only if a `coinbase_wallet` Web3 sign-in is started | — | No | n/a | String only |
| T3 Code | Any `OTEL_EXPORTER_OTLP_*` / `T3CODE_OTLP_*_URL` endpoint | desktop + server | Only when the user configures it | Traces, metrics, logs | No | Leave unset | Reachable when configured |
| PandaCode | `github.com/aicodeking/pandacode/releases/latest/download/latest.json` (+ GitHub asset CDN for the update) | webview → Tauri updater | 30 s after launch, then every 6 h | Plain GET (Tauri updater User-Agent) | Yes | Settings → About → Updates → **Off** | Verified reachable |
| PandaCode | Agent CLI version metadata: `downloads.claude.ai`, `registry.npmjs.org`, `releases.openai.com`, `api.github.com`, `cdn.kimi.com`, `pypi.org`, `storage.googleapis.com` (Grok), `formulae.brew.sh` | native (`reqwest`) | 8 s after launch, then every 6 h; only the sources of the CLIs that are installed | Plain GET, UA `PandaCode agent update checker`, no identifiers | Yes | No switch (only per-version dismissal) | Verified reachable |
| PandaCode | `api.github.com` via the user's `gh auth status` | `gh` child process | Each time a task is shown (cached 5 min) when `gh` is installed | Whatever `gh` sends with the user's own token | Yes, while GitHub integration is not Off | Settings → GitHub off (`pandacode.github = off`) | Reachable (gh's own traffic not inspected) |
| PandaCode | `raw.githubusercontent.com/BerriAI/litellm/…/model_prices…json` | native | When the Usage dialog loads the ledger and the saved copy is more than 24 h old | Plain GET | On use | Do not open Usage | Verified; not at idle launch |
| PandaCode | Provider usage endpoints (Anthropic, OpenAI, Kimi, Z.ai, MiMo, DeepSeek…) | native | Opening the menu-bar popover or the Usage dialog | The user's own provider credential | On use | Do not open | Verified |
| PandaCode | Connect relay (`PANDACODE_RELAY_URL`, set at build time) + `github.com` device flow | native | Only after sign-in; the socket starts at launch only if signed in | E2E ciphertext + routing metadata | No | Do not sign in / sign out | Verified |
| PandaCode | Bot channels (`discord.com`, `api.telegram.org`, `slack.com`, `graph.facebook.com`) | native | At launch only for channels already configured | Messages for that bot | No | Do not add channels | Verified |
| PandaCode | Cloud sandbox / deploy providers (Daytona, Cloudflare, AWS, E2B, Vercel, Netlify…) | native | User action; re-attach check 3 s after launch, then every 60 s, **only for active cloud runs** | Task checkout, prompt, harness login (to the chosen provider) | No | Do not use | Verified |
| PandaCode | `open-vsx.org`, `openrouter.ai`, Jev zip on `github.com`, routing model on `raw.githubusercontent.com` | native | Explicit user action only | Search terms / user key / plain GET | No | n/a | Verified |

## T3 Code

### PostHog product analytics (first-party, verified reachable, on by default)

- **Config**, `binCli-BCouE1oK.mjs:154809`: `TelemetryEnvConfig`.
  - `T3CODE_POSTHOG_KEY` defaults to a built-in `phc_…` key.
  - `T3CODE_POSTHOG_HOST` defaults to `https://ingest.t3.codes`.
  - `T3CODE_TELEMETRY_ENABLED` defaults to **true**.
  - The batch size is 20 events, and at most 1,000 events are buffered.
- **Sender**, `:154873` (`AnalyticsService.sendBatch`): POSTs `{api_key, batch:[…]}` to `${posthogHost}/batch/` with a 10 s timeout. Failed batches retry with backoff up to 5 times.
  - Flush interval: `FLUSH_INTERVAL_MS = 1e4` (`:154793`), plus one flush at shutdown.
  - Each event carries: `distinct_id`, `installId`, `$process_person_profile:false`, `platform`, `wsl`, `arch`, `t3CodeVersion`, `telemetryChannel` ("nightly", `:120569`), `clientType` ("desktop-app" | "cli-web-client"), `serverOs`, `serverArch`, `serverWslDistro`, `serverAppVersion`, `serverMode`.
- **Identity**, `:154731–154773`:
  - `installId` is the SHA-256 of a random UUID stored at `~/.t3/userdata/anonymous-id`. The file exists on this machine.
  - `distinctId` is chosen in priority order. First the SHA-256 of `account_id` from `~/.codex/auth.json`. Next, the `userID` from `~/.claude.json`. Last, the `installId`.
  - The server reads the user's Codex and Claude login files to build this identity.
- **Owner linking**, `:154779` (`getServerOwnersForHome`) and `:325282` (`readClientOwners`): emits `install.owner_observed` with `ownerSource` and the hashed `ownerId` for each of these:
  - the linked T3 Connect user id
  - the OpenAI user id taken from the Codex `id_token`
  - the Claude `oauthAccount.accountUuid`
  - the client-reported hashed Connect account (`clientOwner`) and device id (`clientDevice`)

  These are hashes, but they are stable per account, so events can be joined across installs of the same account.
- **Events**:
  - `server.boot.heartbeat`: sent at every launch, with `threadCount` and `projectCount`. Source: `:311318`, forked during startup at `:311547`.
  - `client.thread.started` and `client.turn.requested`: `:325584`, `:326093`.
  - `feature.used`: about 30 feature names, e.g. `terminal.open`, `worktree.create`, `thread.fork`, `pull_request.review`, `guest_share.*`, `queue.steer`.
  - `provider.turn.completed`: `:155108`. Properties: provider, status, input/cached/reasoning/output tokens, model, effort, runtime/interaction mode, durationMs.
  - `mcp.tool.invoked`: `:340226`. Sent for failed tools and handoff tools.
  - `mcp.delegated_task.finished`: `:327339`. Properties: caller/target provider and model, duration.
  - Client context on each event: surface, app version, OS, device type, browser, connection method, mobile device model. These come from WebSocket query parameters (`:325238`).
  - Message text was not seen in any analytics payload.
- **Opt-out**: there is no in-app toggle. Settings search only links to the "Privacy policy" (`client/assets/settingsSearch-BC-1OFBG.js`).
  - Setting `T3CODE_TELEMETRY_ENABLED=false` makes `record` and `sendBatch` return early.
  - The desktop app copies `T3CODE_TELEMETRY_ENABLED` from the user's login-shell environment into the server's environment (`main.cjs:85667`, `:142236`). Exporting it in a shell profile is therefore enough, even when the app is launched from the Dock.

### Relay tracing to Axiom (first-party, Connect-only)

- Build-time defaults are at `binCli:141877`: Axiom URL, dataset, and a bearer token baked into the build.
- `resolveRelayClientTracingConfig` returns `null` when `T3CODE_TELEMETRY_ENABLED=false` or the OTEL SDK is disabled (`:119787`, `isRelayTracingEnabled`).
- The exporter is `function layer$198` at `:136267`. Per the code comment, it exports "only T3 Connect spans", wrapped around relay client and relay broker layers (`:143340`).
- The web client has the same config (`client/assets/runtime-D0h1Ae2g.js`, `la()`). It asks the desktop app through `desktopBridge.getRelayTelemetryEnabled()` (`main.cjs:146076`).

### Auto-update (Electron main, verified reachable)

- The feed is set in `Contents/Resources/app-update.yml`: `provider: github`, `owner: pingdotgg`, `repo: t3code`, `channel: nightly`, `releaseType: prerelease`.
- electron-updater's GitHub provider requests `${basePath}.atom`, i.e. `github.com/pingdotgg/t3code/releases.atom`, then the channel yml.
- Timing: `AUTO_UPDATE_STARTUP_DELAY = "15 seconds"`, `AUTO_UPDATE_POLL_INTERVAL = "4 minutes"` (`main.cjs:143527`).
- Off switch: `T3CODE_DISABLE_AUTO_UPDATE` (`main.cjs:42094`). `DEFAULT_DESKTOP_SETTINGS` has no setting to disable updates.

### Other first-party outbound (reachable on demand)

- Desktop/server OTLP export goes only to user-set `T3CODE_OTLP_{TRACES,METRICS,LOGS}_URL` (`main.cjs:42086`) or the standard `OTEL_EXPORTER_OTLP_*` variables. There is no default endpoint.
- "Resource telemetry" in Settings → Diagnostics is local process metrics shown over the local RPC. It is not sent anywhere.
- npm latest-version lookups: `fetchNpmLatestVersion` (`binCli:50502`), gated by `enableProviderUpdateChecks` (default true).
- Usage lookups and other features: Anthropic OAuth usage, ChatGPT, Cursor dashboard (session cookie), OpenCode, Google Cloud Code, Expo GraphQL, Chrome-for-Testing download, Antigravity download from `dl.google.com`, GitHub REST/GraphQL. These run only when the user uses the feature.

### Vendor strings only (not reachable in this build)

- **`clerk-telemetry.com`**, in `client/assets/ElectronManagedAuthShell-LIRTZtup.js`. The `isEnabled` check requires `instanceType === "development"`. The bundled publishable key `pk_live_Y2xlcmsudDMuY29kZXMk` decodes to `clerk.t3.codes`, a production instance, so the collector never sends.
- **`as.coinbase.com` / `analytics-service*.cbhq.net`**, in the same chunk. This is the Coinbase Wallet SDK bundled by Clerk's Web3 support. It is dynamically imported only for a `coinbase_wallet` sign-in.
- **`api.bitbucket.org`, `s3.amazonaws.com`**: alternative electron-updater providers. They are not configured.
- **`challenges.cloudflare.com`**: only appears in the CSP `script-src` allowance, for Clerk's Turnstile.
- **No Sentry, no `posthog-js`, no crashReporter upload** was found in the desktop or client bundles.

## PandaCode

### No analytics / telemetry SDK: confirmed

- No PostHog, Sentry, OpenTelemetry, Segment, Amplitude or Mixpanel dependency was found:
  - `src-tauri/Cargo.toml` and `package.json` contain none.
  - A keyword scan of `src/` and `src-tauri/src/` finds only these: the Sentry brand icon in `src/trace-brands.ts:21,48`, and code that turns **off** third-party CLI telemetry:
    - `src-tauri/src/code_search.rs:46-49` (`--no-telemetry`, `CODEDB_NO_TELEMETRY=1`)
    - `src-tauri/src/cloud/deploy.rs:290,305` (`RAILWAY_NO_TELEMETRY`, `NETLIFY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`)
    - `deploy.rs:121` refuses `--telemetry-enable`
- The webview cannot reach the network directly. The CSP in `src-tauri/tauri.conf.json:32` is `connect-src ipc: http://ipc.localhost` and `img-src 'self' data: asset:`, so every request goes through native code.
- No PandaCode-operated server receives anything automatically. The Connect relay is opt-in.
- The About page states "No account, no telemetry." (`src/about-settings.ts:20`).

### Automatic requests (no user action)

1. **App update check.**
   - The endpoint is `github.com/aicodeking/pandacode/releases/latest/download/latest.json`, verified against the pubkey (`src-tauri/tauri.conf.json:69-71`).
   - The first check runs 30 s after launch (`src/app-updates.ts:35,109`), then every 6 h (`src/app-updates-policy.ts:18`, `app-updates.ts:110-111`).
   - Skipped when the mode is `off` (`app-updates.ts:45,124`).
2. **Agent CLI version checks.**
   - The first check runs 8 s after launch (`src/agent-updates.ts:42`), then every 6 h (`:32`). The native side caches results for 6 h (`src-tauri/src/agent_updates.rs:267`).
   - Endpoints are listed in `agent_updates.rs:283-332`. Only the source matching each installed CLI is fetched.
   - The User-Agent is `PandaCode agent update checker` (`:371`). No identifiers are sent.
   - **There is no setting to turn this off.**
3. **`gh auth status`**, run by `src-tauri/src/github.rs:199` through `github_status`.
   - It runs whenever a task's composer renders (`src/main.ts:2043`), cached for 5 min (`src/github.ts:9`).
   - It requires `gh` to be installed and GitHub not set to Off. Integration defaults to on (`src/github.ts:30-31`: on unless `pandacode.github` is `off`).
   - The traffic is the user's own `gh` talking to GitHub with the user's token. It is not PandaCode code making the request.
4. **Conditional at launch**:
   - The Connect socket opens only if signed in (`src-tauri/src/remote.rs:250-258`).
   - Configured bot channels start (`src-tauri/src/bots.rs:1048-1056`, `bots/channels/mod.rs:431`).
   - Cloud runs re-attach only if `active_runs` is non-empty (`src-tauri/src/cloud_agents/resume.rs:11-30`).

### On-demand / opt-in

- **Price list**: `raw.githubusercontent.com` (`src-tauri/src/usage_ledger/pricing.rs:14,17`). Loaded only when the Usage dialog builds the ledger (`usage_ledger.rs:442`, called from `src/agent-usage.ts:198`), and refreshed only when the saved copy is older than 24 h.
- **Plan usage**: when the tray popover opens (`src-tauri/src/tray.rs:167,306`) or the Usage dialog is used.
- **Other opt-in features**: Connect sign-in, cloud sandboxes and deploys, bots, Open VSX theme search (`vsix_themes.rs:18`), Jev/OpenRouter (`jev.rs`), model-routing profiler download (`model_routing.rs:1-5`), GitHub hub/PR features through `gh`.
- **Agent harnesses**: Claude Code, Codex and the other CLIs that PandaCode launches, including `providers/warm.rs` pre-warming after a turn, make their own network calls under their own telemetry settings. This audit does not cover them.

### README privacy table vs code

- README `## Privacy` (`README.md:127-156`) says "No telemetry, no analytics, no accounts". That claim is consistent with the code.
- The table's row for agent CLI versions lists `formulae.brew.sh`, `downloads.claude.ai`, `api.github.com`, `cdn.kimi.com`, `registry.npmjs.org (Cline)`. The code also contacts:
  - `releases.openai.com` (Codex native)
  - `registry.npmjs.org` for Claude Code, Codex and OpenCode npm installs, not only Cline
  - `pypi.org` (kimi-cli)
  - `storage.googleapis.com` (Grok)

  The row is therefore **incomplete**.
- The table has no row for the automatic `gh auth status`.
- The price list row says "Daily". In the code it is daily at most, and only when the Usage dialog is opened.
- AGENTS.md describes the update check as "the only check of PandaCode's own". The agent CLI version checks (+8 s, every 6 h) are also automatic and have no off switch.

## Hosts expected at idle launch (for checking a network capture)

Assumptions: default environment, no sign-in, no Connect link, no bots or cloud runs.

**T3 Code (Nightly)**
- `ingest.t3.codes`: boot heartbeat plus `install.owner_observed`, within about 10–20 s of launch.
- `github.com`: updater at 15 s, then every 4 min, plus GitHub's release-asset CDN host (`release-assets.githubusercontent.com` / `objects.githubusercontent.com`) for the channel yml redirect.
- `registry.npmjs.org`: provider version advisories, when providers are installed.
- `clerk.t3.codes`: likely, because the Clerk auth shell is imported at startup.
- Not expected unless Connect is linked: `relay.t3.codes`, `us-east-1.aws.edge.axiom.co`.
- Child CLIs that T3 probes (codex, claude, …) may contact their own vendors. This is not T3's own code.

**PandaCode**
- `github.com` at +30 s (`latest.json`), plus the GitHub release-asset CDN host for the redirect.
- At +8 s, the subset matching installed CLIs: `downloads.claude.ai`, `registry.npmjs.org`, `releases.openai.com`, `api.github.com`, `cdn.kimi.com`, `pypi.org`, `storage.googleapis.com`, `formulae.brew.sh`.
- `api.github.com` from the user's `gh`, when a task is open and `gh` is installed.
- Nothing else is expected.
