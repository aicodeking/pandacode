# Agent usage panel

The activity icon beside Help and Settings opens **Agent usage**. It remains available in the header when the sidebar is collapsed or the board is open. Installed harnesses appear independently with their account limits, plan when reported, and reset times. Every bar represents **percentage used**, never percentage remaining. Missing values stay unavailable rather than appearing as zero.

The panel opens on **Overview**:
- **Estimated API cost** for the chosen week, month or year.
- **Average limit use**: the mean of each reporting agent's most-used window.
- One row per agent with its color, limit meter and cost share.
- A daily cost chart (weekly for a year), totals, and a model or day breakdown.

Each agent has a tab with its limit windows, its cost for the period and a year activity calendar.

The browser preview uses labeled sample limits and costs. The desktop reads the account configured by each harness. Named connections (Settings → Providers → Connections) appear separately under their harness's tab, below its **Default setup**: each Claude Code and Codex connection is read through its own config folder and environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, its variables and secrets) with the same readers, and cached by connection and revision (`agent_usage` with `connection`). Connections of other harnesses say their limits are not read separately rather than showing the default account's. Checks still run only when the panel opens or on Refresh. Limits may include usage from the same account in other applications.

Claude Code and Codex accounts include the default setup even with pooling off and no named connections. Local login identity takes precedence; when its email is missing, Codex can use the email returned by that same account's `account/read` usage check. Refresh re-reads local identity as well as limits. Unavailable limits retain known local identity. Signed-out accounts, shared-login aliases and external-token setups do not invent an identity or borrow another account's email. No tokens are shown or logged.

Each account shows up to two limit windows (5-hour and weekly). Meters are muted below 70%, amber from 70%, and red when full or held by a limit. Pool status icons expose the complete state in their accessible label and tooltip: Ready, Near limit, a named limit with reset time, Not signed in, Same login, or Left out. Signed-out accounts are not checked; shared-login aliases point to the account whose usage is already shown. The card header has one Checked time and source. Reads run on opening and Refresh; nothing polls.

## Estimated API cost

The estimate answers "what would these tokens have cost through the API?". It does not show what a subscription bills.

- **Sources.** Claude Code project logs (`$CLAUDE_CONFIG_DIR` or `~/.claude`, plus `~/.config/claude`, under `projects/`) and Codex rollouts (`$CODEX_HOME` or `~/.codex`, under `sessions/` and `archived_sessions/`). Other harnesses show "Cost not tracked". Their calendars count prompts sent from PandaCode (`prompt_activity`).
- **Counting.** A Claude reply streams several copies and resumed sessions copy history, so replies are de-duplicated by message ID and request ID across all files. Subagent logs count toward cost but not toward sessions.
  - Codex events carry a running total. An event whose total has not moved is a repeat and is skipped. A September 2026 check across 1,200 local rollouts found no token events duplicated between files.
  - Codex `input_tokens` already includes cached and cache-write tokens, and `output_tokens` includes reasoning, so neither is counted twice.
- **Pricing.** Rates come from [LiteLLM's public price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), the list ccusage uses. It is fetched with a plain GET at most daily and saved as `usage-prices.json`. Offline, the saved copy or the snapshot bundled in `src-tauri/src/usage_ledger/prices.json` is used.
  - The vendor's own listing wins over reseller entries.
  - Rates cover uncached input, cache reads, 5-minute and 1-hour cache writes, output, and the long-context tier above 200k or 272k tokens.
  - Batch, priority and fast-mode pricing are excluded.
  - Models missing from the list, such as `codex-auto-review`, count as unpriced, and the headline states the unpriced share. *Cache savings* is cache-read tokens times the gap between input and cache-read rates.

## Sources and tradeoffs

Researched on September 22, 2026:

- [CodexBar](https://github.com/steipete/CodexBar) implements separate provider readers using CLI account interfaces or vendor quota endpoints. Its [Claude reader documentation](https://github.com/steipete/CodexBar/blob/main/docs/claude.md) describes OAuth usage and credential-source limitations.
- [Quotio](https://github.com/nguyenphutrong/quotio) also provides quota tracking, alongside account routing and a local proxy. PandaCode already owns its harness connections and does not need another proxy or a bundled menu-bar app.
- The [Codex app-server API](https://developers.openai.com/codex/app-server/) exposes `account/read` and `account/rateLimits/read`. The global panel skips the separate historical-token query used by the existing Codex command center.
- [Kimi's managed usage reader](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts), [Z.ai's official quota script](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs), and [OpenCode Go's usage endpoint](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) supply the provider response contracts.
- Kimi credential locations follow the [modern CLI paths](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/utils/paths.ts), [legacy Python paths](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/share.py), and [legacy OAuth file format](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py). Configuration selection reads only the default model's provider; unrelated keys are ignored.
- Antigravity's [native usage command](https://antigravity.google/docs/cli/commands/usage/) and [headless mode](https://antigravity.google/docs/cli/headless/) support standalone reporting. The version floor and structured response fixtures are covered by [CodexBar's CLI report tests](https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/AntigravityCLIUsageReportTests.swift). PandaCode verifies a stable version of at least 1.1.11 before invoking the report, bounds execution to 12 seconds after a 3-second version check, and declines explicit credential overrides that cannot be matched to the report's account.

These projects informed the approach and response interpretation. PandaCode uses its own small Rust readers and existing dependencies; none of those applications is installed or bundled.

## Provider behavior

| Harness | Limit source | Boundary |
| --- | --- | --- |
| Codex | Installed Codex app-server account APIs | Prefers named limit buckets; API-key accounts do not inherit ChatGPT subscription quotas. |
| Claude Code | Claude's OAuth usage endpoint, with Claude Code's own saved login (read only) | Requires a profile-scoped login. An expired login is refreshed by running the user's Claude Code (a setting, on by default). API keys and custom endpoints are not subscription usage. See [Claude Code logins](#claude-code-logins). |
| Kimi Code | Kimi usage endpoint with its configured Kimi account | Displays reported rolling, weekly, and monthly windows; custom endpoints are not sent credentials by the quota reader. |
| GLM Coding Plan | Z.ai's quota endpoint using the configured Coding Plan key | Reads the plan's reported token and tool-call allowances. |
| OpenCode | OpenCode Go usage endpoint using its existing Go/Zen credential | Reports Go quotas explicitly. This is not a combined quota for every downstream model provider. |
| Antigravity | Version-gated standalone CLI usage report, when available | Older standalone CLIs and ACP-only installations cannot expose this report safely. |
| Grok / MiMo | No verified account-quota reader | Clear unavailable state and account link; session token counts are not substituted for subscription limits. |

Vendor-internal OAuth endpoints may change. Failures leave a clear state; a transient failure can retain the last successful snapshot, labeled as saved. Sign-out and authorization failures do not retain unrelated account windows. Reset timestamps are displayed in the user's local time, with the precise timestamp behind the information icon.

GLM usage reads the saved key without interaction on macOS and Windows. The Linux keyring backend can trigger an unlock prompt and cannot safely establish saved-key precedence without unlocking. When that account cannot be identified, the panel reports unavailable rather than silently querying a different environment account; normal agent authentication is unchanged.

OpenCode authentication content takes precedence over its saved file, and saved API credentials take precedence over an environment key. Kimi declines ambiguous modern and legacy configurations until an explicit CLI home selects one.

## Performance and privacy

- The UI and its stylesheet load only when opened. No usage requests run at startup or on a background timer.
- Provider cards settle independently with at most three reads in flight. Closing the panel stops its queued reads and ignores late responses.
- The native cache coalesces concurrent reads per provider, caches for 60 seconds, and limits explicit refresh to one attempt every 10 seconds (Claude's exceptions are below). Configuration changes in PandaCode invalidate the relevant entry. For Claude Code and Codex, local configuration, login identity and tracked file changes also invalidate the previous account’s cache. If the local source changes during a fetch, its result is discarded; Refresh can check the current account again. The one exception is a Claude reading of the same account the check began with: Claude Code rewriting its own files while PandaCode runs it to refresh the login keeps the reading. These checks add no protected-store reads, CLI calls or network requests. An external change confined to protected storage, with no local change or connection revision signal, is not detected immediately; the same-source 60-second cache and 10-second Refresh throttle still apply.
- Only bounded local credential files and fixed HTTPS quota endpoints are used. Requests have time and response-size limits and do not follow redirects carrying credentials.
- No prompt or paid inference is needed. PandaCode never writes any agent's credentials: the Codex CLI keeps its own authentication lifecycle, and an expired Claude Code login is refreshed by Claude Code itself, which PandaCode may run for that (see [Claude Code logins](#claude-code-logins)).
- No credentials or raw provider responses cross into the webview, logs, analytics, or PandaCode servers. Only normalized limit fields are returned. Token wiping is best-effort: copies PandaCode holds (parsed logins, request bodies it builds, responses it parses, the `security` stdin line) are zeroed when dropped, but reqwest's own request bodies and headers, and operating-system buffers, are not. The limit cache is in memory, except Claude's last good reading (below).
- Agent logs are read only while the panel is open, one scan at a time, in a blocking worker with a 5-minute bound. Parsers keep token counts, the model name and the hour; prompt, reply and tool text is discarded as each line is parsed. Per-file counts are saved as `usage-ledger-cache.json` in the app data folder with each file's read offset, so a reopen only reads appended bytes. On the September 2026 test machine the first scan of 7.9 GB took about 6 s, a rescan 10 ms, and the UI payload was about 100 KB. Results are reused for 60 seconds unless Refresh is pressed.
- The price-list download is the only network request the estimate makes. No usage data is sent.
- Locked or inaccessible credentials produce a card that says what to do. For Claude Code's item, `security` is asked only when the no-UI helper is refused. Claude Code's own item trusts Apple's `security` tool, so no dialog appears; a check (automatic or a Refresh you press) can show a macOS dialog only if the item doesn't trust `security`. Choose Always Allow; a denial stops it until you press Refresh. macOS Keychain reads run in a short-lived, bounded helper with user interaction disabled; PandaCode's own saved keys are read from its secrets file first (see [secret storage](providers.md#secret-storage)). Claude Code's Keychain item is covered below. Users can sign in through their harness and refresh.

## Claude Code logins

PandaCode reads the login Claude Code itself uses (its Keychain item on macOS, else `<config>/.credentials.json`), read only: it never writes Claude Code's credentials or calls its token endpoint. When usage can't be read, it may run the user's own Claude Code once, `claude -p /usage --output-format json --safe-mode --no-session-persistence --tools "" --max-turns 1` (a local command with every tool off and one turn at most: no model call, nothing billed; `--max-turns` is accepted though not listed in `claude --help`). This lets Claude Code refresh and save its own login if it needs to; it may answer from its own snapshot instead. Claude Code serialises its refresh with a lock in its config folder (`.oauth_refresh.lock`, a folder it touches every 5 s and counts stale after 60 s; checked in 2.1.322), so a run PandaCode starts never races an interactive session: while that lock was touched in the last 60 s, PandaCode starts no run and reads the store again instead. The setting is **Let PandaCode ask Claude Code for usage when it can’t read it** (Settings → Providers → Claude Code, on by default).

| Situation | What PandaCode does | What the card shows |
| --- | --- | --- |
| Fresh login | Reads usage with it | The windows |
| Expired login | Runs Claude Code, reads the store again | The fresh reading; else what Claude Code printed; else *Login expired* |
| Run failed (offline, server error, timed out, crashed) | Keeps the slot spent; waits 15 min, then 30, 60, up to 2 h in a row | *Login expired* with **Refresh**: "Opening this panel after HH:MM will ask Claude Code again, or press Refresh"; the saved reading if any |
| The extra Refresh already used | Runs Claude Code again only after the 15-minute slot; **Refresh** still reads the login and the service | *Next try after HH:MM* until then, then *Login expired* |
| Run still going when the card must answer | Lets it finish, saves what it prints (never cached, even with a saved reading standing in) | "Claude Code is still refreshing the login; open this again shortly." |
| Claude Code too old (unknown `--safe-mode`, "/usage isn't available") | Waits 1 h, doubling up to a day | *Update Claude Code* (also while waiting), with `claude update` and **Copy command** |
| Claude Code's login refused, or no subscription usage | Backs off like a failed run | *Sign in via Claude Code*: "Run `claude auth login` in a terminal, or /login in Claude Code, then press Refresh" (with `CLAUDE_CONFIG_DIR='…'` for a connection's own folder), **Copy command** and **Refresh**; no retry times |
| A 429 with a `Retry-After`, and for as long as that wait lasts | Nothing at all, Claude Code included, not even on Refresh | The saved reading, else *Rate limited*: "Press Refresh after HH:MM to check again" (the server's `Retry-After`), with a **Refresh** enabled then; opening the panel checks on its own after at least 5 minutes |
| A 429 without a `Retry-After`, with no saved reading or one over 15 min old | Runs Claude Code (same limits) | Printed numbers; else the saved reading |
| Network or server error; no login; unreadable store | Runs Claude Code (same limits) | Printed numbers, else the check's own message |
| Keychain locked | Drops the remembered login; never runs Claude Code | *Keychain locked* with **Refresh** |
| A run for this setup is already under way (or ended after this check began) | Never starts a second one; waits for it without holding a shared slot, then reads the store again | The fresh reading; *Asking Claude Code…* on that card while it waits |
| Keychain read denied or not answered (also while backing off after a dialog nobody answered) | Runs Claude Code only on a Refresh you press, so it never shows that dialog again unprompted | *Needs refresh* |
| Never signed in (no account in `.claude.json`, no login) | Never runs Claude Code | *Sign-in needed* |
| API key or other non-subscription setup (also in an administrator's `managed-settings.json`) | Never runs Claude Code (so never an admin `apiKeyHelper`) | *Not your subscription* (panel only, not the menu bar) |
| Setting off | Never runs Claude Code | *Login expired* with **Open Settings** |

**Rules**
- At most one run per Claude setup every 15 minutes, never two at once. A Refresh you press may run it once more; the backoff stands. A new backoff never shortens a longer one. A run that never started doesn't count.
- A run starts only with 20 s of the check left (60 s, 75 s on Refresh), then runs to its own 45 s limit. Then its process group gets SIGTERM and 10 s, then SIGKILL before the process is reaped. On Windows it gets a plain `taskkill /T` and up to 5 s, then `taskkill /T /F`; a process started with CREATE_NO_WINDOW (as this run is) and its children have no window to receive the plain request, so they usually need the forced stop.
- On macOS the Keychain is checked three times: before the check runs Claude Code, again right before it spawns (locked: it never starts and the slot is given back), and every 2 s while it runs (locked: it is stopped as at its limit). "Unlocked" means both the default keychain (where Claude Code saves its item) and the login keychain (where the item is when the default was changed); only their lock state is read, never an item.
- The remembered Keychain login (parsed fields only: no refresh token) is dropped when a run is taken and again when it ends. A read made while it ran is never kept.
- The re-read after a run gets all the time the check has left. Usage a run prints is saved, marked *Claude Code CLI*, under the account `.claude.json` names when it ends, even after its card stopped waiting. A printed reading never ends a rate limit.
- Claude Code gets only its config folder, proxy and certificate settings, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` and basic process variables (Windows program, profile and user folders included), in PandaCode's `claude-usage-cli` folder (app data, owner only).
- Its telemetry, error reports, nonessential traffic and self-update are always off for this run. API keys, endpoints and OAuth tokens never reach it.
- Without usage lines, only its JSON `result` text and bounded stderr are read, for fixed phrases ("/login" counts only beside an auth phrase). Both are overwritten with zeros when dropped (best effort: copies the OS or allocator made may remain); only the outcome and exit status are logged. The plan is read only from a "Plan:" line or the subscription header.
- While a Claude card is still checking it shows the saved reading at once (marked *Saved snapshot*) with "Checking limits…" under it, which becomes *Asking Claude Code…* while that setup's run is under way; the menu bar's Claude row does the same. One poll a second serves every waiting card (`agent_usage_asking_claude` with the list of setups); it uses the profile each setup's last check noted and reads only PandaCode's saved-reading file: no login files, Keychain, connection secrets or network.
- A reset Claude Code printed ("Resets Nov 15 at 8pm (…)", read as local time this year) is hidden once its date has passed; one without a date, or that can't be read, stays. Each card's own **Refresh** works while other cards still load.
- Opening the menu bar popover checks usage too, like opening the panel.
- `.claude.json` is read once per check (the owner worked out first is reused).

**Keychain reads**
- Automatic checks reuse the last read login. They read again near expiry, after a 401, on another account, when the item changed, or on Refresh.
- The no-UI helper reads first; `security` runs only when the helper is refused or finds nothing, and only while the Keychain is unlocked.
- Denied (exit 51/128), or two unanswered dialogs in a row: latched across restarts until Refresh. No interaction allowed (exit 36): latched for this launch. Other failures back off from 10 minutes.

**Saved reading and labels**
- The last good reading (`claude-usage-last.json`, tied to the account by an HMAC) stands in, marked stale, for transient errors; never for a sign-out or another account.
- Its key names each store by kind and place (`keychain:<service>`, `file:<path>`). Readings saved under the older key are not found once; the next good reading replaces them.
- Labels follow `action`: *Needs refresh*, *Temporary problem*, *Login expired* (or *Next try after HH:MM*), *Sign in via Claude Code*, *Keychain locked*, *Rate limited*, *Not your subscription*, *Update Claude Code*. **Refresh** and **Open Settings** buttons appear where they help. Rate-limit text gives two times: when a Refresh you press may check again (the server's `Retry-After`, at once without one) and when opening the panel checks on its own (at least 5 minutes, at most an hour).
- The menu bar keeps a Claude row without limits when Claude Code is installed or a login exists, except a non-subscription setup. Printed reset text drops its time zone there.

**Verified live** (10 November 2026, Claude Code 2.1.322, macOS): the usage endpoint answered HTTP 200 for the default profile and a second `CLAUDE_CONFIG_DIR` profile, both read from the Keychain through `security` (the no-UI helper is refused with -25293); no 429 was seen. `claude -p /usage --output-format json --safe-mode --no-session-persistence` against the second profile exited 0 with `num_turns` 0 and `total_cost_usd` 0 and printed the usage lines PandaCode parses. The same run with `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set to 1 still printed them. Later that day the second profile's Keychain login had expired on its own (a read-only check reported *Login expired*). One such run exited 0 (`num_turns` 0, `total_cost_usd` 0, 3.4 s) without usage lines, and a read-only check right after found the login Claude Code had refreshed and saved, and read usage with it (HTTP 200). PandaCode copied, rotated or wrote no credentials.

## Code and verification

- `src/agent-usage.ts` / `src/agent-usage.css`: lazy modal content, tabs, per-provider loading, accessible meters and reset details.
- `src/usage-overview.ts`, `src/usage-cost-chart.ts`, `src/usage-ledger.ts`, `src/usage-heatmap.ts`: the overview, the cost chart, local-day grouping, and the activity calendar. Agents keep one fixed color each, in the validated categorical order.
- `src-tauri/src/usage_ledger.rs` and `usage_ledger/`: log discovery, incremental parsing, pricing, and the `usage_ledger` IPC command.
- `src-tauri/src/agent_usage.rs` (tests in `agent_usage_tests.rs`): guarded IPC, cache, request bounds, Codex reader, and `claude_config_dir` (shared with `usage_ledger.rs`).
- Claude: `agent_usage_claude.rs` (login choice, remembered Keychain login, check flow, messages), `agent_usage_claude_run.rs` (a check's run of Claude Code: taking, joining, re-reading), `agent_usage_claude_cli.rs` (running Claude Code, classifying and parsing what it prints), `agent_usage_claude_connection.rs` (non-subscription connections in Claude Code's order, managed settings), `agent_usage_claude_setup.rs` (`fetch_claude`, `late`, `owner_now`), `agent_usage_claude_env.rs` (launch environment), `agent_usage_claude_store.rs` (reading the stores), `agent_usage_claude_remote.rs` (usage requests), `agent_usage_claude_limits.rs` (rate limits, saved reading). Tests: `agent_usage_claude_tests.rs` (parsing, login choice, the shared `Setup`), `agent_usage_claude_flow_tests.rs` (remembered Keychain logins, latches, rate limits), `agent_usage_claude_connection_tests.rs` (non-subscription connections, deadlines), `agent_usage_claude_cli_tests.rs` (runs of Claude Code through the check), `agent_usage_claude_cli_outcome_tests.rs` (classifying output, environment, command, graceful stop, `fetch_claude` with a scripted CLI), `agent_usage_claude_cli_keychain_tests.rs` (runs beside a Keychain login, macOS). Shared labels: `src/usage-labels.ts` (panel and menu bar popover).
- `src-tauri/src/usage_keychain.rs`: isolated, noninteractive macOS credential reader; `usage_keychain_claude.rs` (included into it): the `security` reads and latches for Claude Code's item (read only); tests in `usage_keychain_tests.rs`. `workspace::run_process_graceful_until` stops a timed-out run with SIGTERM first.
- `src/provider-settings.ts`: the **Let PandaCode ask Claude Code for usage when it can’t read it** switch (`provider_set_claude_cli_refresh` in `provider_settings.rs`).
- `src-tauri/src/agent_usage_providers.rs`: Kimi, GLM, OpenCode and standalone Antigravity readers.
- `tests/agent-usage.spec.ts`: lazy loading, bounded concurrency, refresh (each card's own too), partial failures, close/reopen races, sidebar/board access, narrow layouts, cost ranges, breakdowns, tabs, calendars, Claude labels, fix buttons and *Asking Claude Code…*. `tests/tray-popover.spec.ts`: the menu bar rows and labels. `tests/provider-settings.spec.ts`: the Claude Code switch. `tests/usage-ledger.test.mjs` covers range and day grouping. In Rust, `tray.rs` tests which Claude rows the menu bar keeps.

Run `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml agent_usage usage_ledger`, and the focused Chrome/WebKit Playwright suites. Live account checks are opt-in and never part of the ordinary test suite; `cargo test --lib live_local_logs -- --ignored --nocapture` prints totals from this computer's logs, and `cargo test --lib live_claude_usage_smoke -- --ignored --nocapture` (with `PANDACODE_SMOKE_CLAUDE_CONFIG_DIR` for a connection) checks the real Claude login read-only (it never runs Claude Code; an expired login is only reported); `PANDACODE_LIVE_CLI_CONFIG_DIR=<config> cargo test --lib live_claude_code_usage_command_is_read -- --ignored --nocapture` runs that Claude Code's `/usage` once (no model call) and parses it.
