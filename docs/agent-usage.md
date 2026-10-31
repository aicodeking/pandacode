# Agent usage panel

The activity icon beside Help and Settings opens **Agent usage**. It remains available in the header when the sidebar is collapsed or the board is open. Installed harnesses appear independently with their account limits, plan when reported, and reset times. Every bar represents **percentage used**, never percentage remaining. Missing values stay unavailable rather than appearing as zero.

The panel opens on **Overview**:
- **Estimated API cost** for the chosen week, month or year.
- **Average limit use**: the mean of each reporting agent's most-used window.
- One row per agent with its color, limit meter and cost share.
- A daily cost chart (weekly for a year), totals, and a model or day breakdown.

Each agent has a tab with its limit windows, its cost for the period and a year activity calendar.

The browser preview uses labeled sample limits and costs. The desktop reads the account configured by each harness. Named connections (Settings → Providers → Connections) appear separately under their harness's tab, below its **Default setup**: each Claude Code and Codex connection is read through its own config folder and environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, its variables and secrets) with the same readers, and cached by connection and revision (`agent_usage` with `connection`). Connections of other harnesses say their limits are not read separately rather than showing the default account's. Checks still run only when the panel opens or on Refresh. Limits may include usage from the same account in other applications.

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
| Claude Code | Direct Claude OAuth usage endpoint using its existing local login | Requires a valid profile-scoped token. Custom relays and API credentials are not reported as Claude subscription usage. No browser cookie extraction or independent token refresh. |
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
- The native cache coalesces concurrent reads per provider, caches for 60 seconds, and limits explicit refresh to one attempt every 10 seconds. Configuration changes in PandaCode invalidate the relevant entry.
- Only bounded local credential files and fixed HTTPS quota endpoints are used. Requests have time and response-size limits and do not follow redirects carrying credentials.
- No prompt or paid inference is needed. PandaCode does not independently refresh or rewrite harness OAuth tokens; the Codex CLI remains responsible for its own authentication lifecycle.
- No credentials or raw provider responses cross into the webview, logs, analytics, or PandaCode servers. Only normalized limit fields are returned. The limit cache is in memory and creates no database migration or new credential store.
- Agent logs are read only while the panel is open, one scan at a time, in a blocking worker with a 5-minute bound. Parsers keep token counts, the model name and the hour; prompt, reply and tool text is discarded as each line is parsed. Per-file counts are saved as `usage-ledger-cache.json` in the app data folder with each file's read offset, so a reopen only reads appended bytes. On the September 2026 test machine the first scan of 7.9 GB took about 6 s, a rescan 10 ms, and the UI payload was about 100 KB. Results are reused for 60 seconds unless Refresh is pressed.
- The price-list download is the only network request the estimate makes. No usage data is sent.
- Locked or inaccessible credentials produce an actionable state rather than a Keychain prompt. macOS Keychain reads run in a short-lived, bounded helper with user interaction disabled; PandaCode's own saved keys are read from its secrets file first (see [secret storage](providers.md#secret-storage)). Users can sign in through their harness and refresh.

## Code and verification

- `src/agent-usage.ts` / `src/agent-usage.css`: lazy modal content, tabs, per-provider loading, accessible meters and reset details.
- `src/usage-overview.ts`, `src/usage-cost-chart.ts`, `src/usage-ledger.ts`, `src/usage-heatmap.ts`: the overview, the cost chart, local-day grouping, and the activity calendar. Agents keep one fixed color each, in the validated categorical order.
- `src-tauri/src/usage_ledger.rs` and `usage_ledger/`: log discovery, incremental parsing, pricing, and the `usage_ledger` IPC command.
- `src-tauri/src/agent_usage.rs`: guarded IPC, cache, request bounds, Codex and Claude readers.
- `src-tauri/src/usage_keychain.rs`: isolated, noninteractive macOS credential reader.
- `src-tauri/src/agent_usage_providers.rs`: Kimi, GLM, OpenCode and standalone Antigravity readers.
- `tests/agent-usage.spec.ts`: lazy loading, bounded concurrency, refresh, partial failures, close/reopen races, sidebar/board access, narrow layouts, cost ranges, breakdowns, tabs and calendars. `tests/usage-ledger.test.mjs` covers range and day grouping.

Run `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml agent_usage usage_ledger`, and the focused Chrome/WebKit Playwright suites. Live account checks are opt-in and never part of the ordinary test suite; `cargo test --lib live_local_logs -- --ignored --nocapture` prints totals from this computer's logs.
