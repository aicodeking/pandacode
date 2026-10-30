# What this bench found: PandaCode vs T3 Code telemetry

This is a hand-written summary of everything in this folder. Every claim points to its source: the bench results in [results/](results/), the static code reading in [static-audit.md](static-audit.md), the payload capture in [results/t3-payload/](results/t3-payload/), the shipped T3 Code bundle, and T3 Code's public repository pinned to commit [`aa11ef6`](https://github.com/pingdotgg/t3code/tree/aa11ef6783da81039e6646e2e96941748afb358e).

References to `binCli-BCouE1oK.mjs:N` are line numbers in `apps/server/dist/binCli-BCouE1oK.mjs` inside the installed T3 Code app's `app.asar` (see [Reproduce](#10-limitations-and-how-to-reproduce)). The bundle is not minified, and it keeps comments naming the source files, for example `// src/telemetry/Identify.ts` (`binCli-BCouE1oK.mjs:154622`) and `// src/telemetry/AnalyticsService.ts` (`:154792`). This is T3 Code's own server code, not code from OpenAI or Anthropic.

## 1. What was tested

| | |
| --- | --- |
| PandaCode | 0.3.79, release bundle built from commit `37ef134`, bundle ID `ai.pandacode.bench` ([README.md](README.md#environment-of-the-published-run), [results/summary.md](results/summary.md) last line) |
| T3 Code | T3 Code (Nightly) 0.1.3-nightly.20261026.3717 (`com.t3tools.t3code`), the installed production Electron build ([README.md](README.md#environment-of-the-published-run)) |
| Idle bench | 5 cold launches per app, alternating order, 60 s each, each with a new empty `HOME`, nothing clicked, no agent run ([results/summary.md](results/summary.md) line 3) |
| Payload capture | T3 Code's server from the same installed bundle, 45 s, fresh `HOME` with fake "canary" Codex, Claude and T3 Connect logins, analytics host pointed at a local sink ([results/t3-payload/summary.md](results/t3-payload/summary.md), "Method and scope") |
| Static audit | Reading of both apps' shipped code, dated 2026-10-29 ([static-audit.md](static-audit.md)) |
| Machine | Mac16,5, Apple M4 Max, 48 GB RAM, macOS 27.0.1, home Wi-Fi, no proxy or VPN ([README.md](README.md#environment-of-the-published-run)) |

Neither app was configured. What each one does by default for a new user is what was measured ([README.md](README.md#how-each-app-runs)).

## 2. Resources and network at idle launch

Medians of 5 launches, from [results/summary.md](results/summary.md) lines 9-26. Ratio is PandaCode / T3 Code.

| Metric | PandaCode | T3 Code | Ratio |
| --- | ---: | ---: | ---: |
| Physical footprint at end (MB) | 418 | 633 | 0.66 |
| Threads at end | 43 | 140 | 0.31 |
| CPU time, launch to 60 s (s) | 10.26 | 7.37 | 1.39 |
| of which the app's own processes (s) | 3.23 | 7.02 | 0.46 |
| of which tools it started (s) | 6.97 | 0.50 | 14.03 |
| CPU time, last 30 s (s) | 0.10 | 0.65 | 0.16 |
| Time to first window (ms) | 740 | 2906 | 0.25 |
| Data written by a launch (MB) | 5.45 | 12.58 | 0.43 |
| Remote flows | 18 | 21 | 0.86 |
| KB received / sent | 256.6 / 10.1 | 750.1 / 46.3 | 0.34 / 0.22 |
| App bundle on disk (MB) | 48.6 | 456.5 | 0.11 |

PandaCode used more CPU over the whole minute, but most of it was not PandaCode itself. About 7 s went to the agent CLIs it starts once at launch to detect them (`<cli> --version` for each installed CLI, and `npm view command-code versions`). Its own processes used 3.2 s against T3 Code's 7.0 s ([results/summary.md](results/summary.md) lines 12-14 and 63-103; [README.md](README.md#what-the-published-run-shows)).

## 3. Hosts contacted at idle launch

From [results/summary.md](results/summary.md) lines 28-59 (PandaCode) and 107-130 (T3 Code). Names are inferred from addresses (DNS match, certificate, reverse DNS); see the limits in [README.md](README.md#known-limitations).

| Host | PandaCode | T3 Code | Purpose |
| --- | --- | --- | --- |
| `github.com`, `*.github.com`, `api.github.com` | 5/5 | 5/5 | App update checks; PandaCode's CLI version checks |
| `raw.githubusercontent.com` | 5/5 | 5/5 | GitHub raw content |
| `registry.npmjs.org` | 5/5 (`node` started by PandaCode) | 5/5 | CLI version lookups |
| `downloads.claude.ai`, `releases.openai.com`, `storage.googleapis.com` | 5/5 | – | PandaCode's agent CLI version checks |
| Address of `ingest.t3.codes` / `relay.t3.codes` | – | 5/5, about 3.3 KB sent per run | T3 analytics (PostHog proxy) or relay; both names share the address |
| `us-east-1.aws.edge.axiom.co` | – | 5/5, about 18 KB sent per run | Axiom trace ingestion |
| `*.nel.cloudflare.com` | – | 2/5 | Cloudflare network error logging |
| Anthropic address (`api.anthropic.com` and others) | – | 5/5, from the `claude` CLI T3 started | The CLI's own traffic |
| 104.18.34.146, 172.64.153.110 | – | 4/5, 2/5 | Unidentified Cloudflare addresses |

The per-run byte figures for the T3 hosts were summed from the flows in [results/2026-10-30.json](results/2026-10-30.json) (addresses 104.21.3.218 and 172.67.153.155 for ingest/relay; 44.216.55.45 and 32.196.68.31 for Axiom). They were the same in every run: 3.3 KB out and 4.8 KB in to the ingest/relay address, 18.0-18.1 KB out and 14.5 KB in to Axiom.

No analytics or telemetry host was seen for PandaCode ([README.md](README.md#what-the-published-run-shows)).

## 4. T3 Code analytics, from the code

| Fact | Evidence |
| --- | --- |
| On by default. `T3CODE_TELEMETRY_ENABLED` defaults to `true`. | `binCli-BCouE1oK.mjs:154812` |
| Endpoint `https://ingest.t3.codes` (override `T3CODE_POSTHOG_HOST`), with a built-in PostHog `phc_…` key (override `T3CODE_POSTHOG_KEY`). | `binCli-BCouE1oK.mjs:154810-154811` |
| The endpoint forwards to PostHog. | [telemetry.md L3-L7](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L3-L7); privacy policy names PostHog, [L249-L250](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L249-L250) |
| Events are buffered and POSTed to `/batch/` every 10 s (`FLUSH_INTERVAL_MS = 1e4`) and at shutdown, up to 5 attempts per batch. | `binCli-BCouE1oK.mjs:154793-154795`, `:154900`, `:154979-154980` |
| Sending is gated only by `enabled && distinctId`, both in `record` and in `sendBatch`. | `binCli-BCouE1oK.mjs:154958`, `:154874` |
| Every event carries `distinct_id`, `installId`, platform, arch, WSL distro, app version, channel, client type, server OS/arch/mode. | `binCli-BCouE1oK.mjs:154875-154898` |

Events found in the bundle ([static-audit.md](static-audit.md) lines 57-65, call sites re-checked):

| Event | Where | Content |
| --- | --- | --- |
| `server.boot.heartbeat` | `binCli-BCouE1oK.mjs:311332`, started at `:311547` | Every launch: thread and project counts |
| `install.owner_observed` | `binCli-BCouE1oK.mjs:154974` | One per hashed owner id (see below) |
| `client.thread.started`, `client.turn.requested` | `binCli-BCouE1oK.mjs:326093`, `:325584` | Origin of the action |
| `provider.turn.completed` | `binCli-BCouE1oK.mjs:155108` | Provider, model, effort, modes, token counts, status, duration |
| `feature.used` | for example `binCli-BCouE1oK.mjs:292605`, `:326694` | Feature name |
| `mcp.tool.invoked`, `mcp.delegated_task.finished` | `binCli-BCouE1oK.mjs:340226`, `:327339` | Tool / delegation details |

### Identity

| Step | Evidence |
| --- | --- |
| The hash is `sha256(value)` as hex, with no salt or key. | `binCli-BCouE1oK.mjs:154619` (`packages/shared/src/telemetryId.ts`) |
| The server reads `~/.codex/auth.json` (Codex CLI login) and `~/.claude.json` (Claude Code config) from the user's home. | `binCli-BCouE1oK.mjs:154754-154755` |
| `installId` is the hash of a random UUID stored in `~/.t3/userdata/anonymous-id`. | `binCli-BCouE1oK.mjs:154731-154750`, `:154766` |
| `distinct_id` is the hash of the Codex `tokens.account_id`; if absent, of the Claude `userID`; if absent, the `installId`. | `binCli-BCouE1oK.mjs:154758-154771` |
| `install.owner_observed` sends hashed ids for: the linked T3 Connect user, the OpenAI user id read (unverified) from the Codex `id_token`, and the Claude `oauthAccount.accountUuid`. | `binCli-BCouE1oK.mjs:154779-154789`, `:154713-154719`, recorded at `:154967-154978` |
| T3's own ChatGPT sign-in also records the hashed OpenAI user id as an owner. | `binCli-BCouE1oK.mjs:237766-237771` |
| The code comment says the Codex `account_id` "is the ChatGPT workspace, which a whole Team shares; the `id_token` names the person". | `binCli-BCouE1oK.mjs:154626-154627` |

## 5. Does T3 Code collect email addresses?

**No, not in the analytics.** Both the live capture and the code agree.

Live capture ([results/t3-payload/summary.md](results/t3-payload/summary.md)). The fake logins contained an email address and a name in the Codex `id_token`, and an email and display name in `~/.claude.json`, plus access and refresh tokens. One batch was sent: `server.boot.heartbeat` once and `install.owner_observed` three times.

- No canary value appeared in any body as plain text, base64 or base64url (lines 7 and 15-28).
- No `@` and no `email` in any case appeared anywhere in the bodies (lines 8-9). No paths, user name or host name (line 10).
- What was sent instead were SHA-256 hashes of: the Codex `account_id` (as `distinct_id`), the OpenAI user id, the Claude `accountUuid`, the Connect user id (as `ownerId`), and the install id (lines 17-26). Two of these hashes were recomputed independently for this summary and match.
- The email and name canaries are not in the bodies even as hashes (lines 19-20, 23-24).

Code. The schemas used to decode the login files declare only id fields: `account_id` and `id_token` for Codex, `userID` and `oauthAccount.accountUuid` for Claude, and only `user_id` from the `id_token` claims (`binCli-BCouE1oK.mjs:154629-154638`). Fields not in a schema are not passed on. Email fields do exist elsewhere in the server, for other features: provider usage and setup contracts (`binCli-BCouE1oK.mjs:15714`, `:33209`), Git hosting credentials and commit authors (for example `:57755`, `:67561`). None of them feeds an analytics call. In the web client, email appears in the T3 Connect sign-in UI (Clerk, `client/assets/ElectronManagedAuthShell-LIRTZtup.js`). When a user signs in to a T3 account, T3 does receive the email address; that is account data, described separately in the privacy policy ([L66-L69](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L66-L69)).

## 6. Is it used without T3 Connect?

**Yes.**

- The identity function reads only the Codex and Claude files and the local install id. It never reads T3 Connect (`binCli-BCouE1oK.mjs:154764-154771`).
- Connect only adds one more owner entry, when a linked user id is stored (`binCli-BCouE1oK.mjs:154780-154783`).
- The heartbeat is sent at every server start (`binCli-BCouE1oK.mjs:311547`). In the capture it was sent with no window or client connected ([results/t3-payload/summary.md](results/t3-payload/summary.md) line 68).
- In the idle bench, with no Connect sign-in and no logins at all, T3 Code contacted the `ingest.t3.codes` / `relay.t3.codes` address in 5/5 runs ([results/summary.md](results/summary.md) lines 123-124). The traffic is HTTPS, so the contents were not visible there, and the address is shared by both names.

## 7. "Anonymous" or pseudonymous?

T3's privacy policy says:

> By default, T3 Code sends us anonymous usage data, such as which provider and model a turn used, whether it succeeded, and your app version and operating system.
> ([privacy-policy.astro L85-L87](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L85-L87))

> To analyze and improve T3 Code using product usage data and aggregated, de-identified, or other anonymous operational information.
> ([L166-L167](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L166-L167))

T3's own telemetry doc is more precise. It says events are "associated with a hashed account or installation identifier", and that "to count how many installations one person uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and Claude accounts when you are signed in" ([telemetry.md L3-L6](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L3-L6)).

An unsalted SHA-256 of a stable account id is a pseudonym, not anonymous data. Anyone who holds the plain id can compute the same hash and match the events:

- OpenAI holds Codex account ids and user ids; Anthropic holds Claude account UUIDs.
- A ChatGPT Team admin knows the workspace `account_id`, which is the `distinct_id` for every member who uses Codex with it (`binCli-BCouE1oK.mjs:154626-154627`).
- T3 holds the Connect user id of its own account holders, along with their name and email address ([privacy-policy.astro L66-L69](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L66-L69)). The hash is the same "on every surface" by design (`binCli-BCouE1oK.mjs:154616-154617`).
- The capture shows how this links accounts: one batch carried the Codex, OpenAI, Claude and Connect hashes together under one `distinct_id` and `installId` ([results/t3-payload/summary.md](results/t3-payload/summary.md) lines 39-47).

How the law treats this (not legal advice):

- **GDPR**: [Art. 4(5)](https://eur-lex.europa.eu/eli/reg/2016/679/oj) defines pseudonymisation, and [Recital 26](https://eur-lex.europa.eu/eli/reg/2016/679/oj) says pseudonymised data that can be attributed to a person with additional information is information on an identifiable person, that is, personal data. Only data that is truly anonymous falls outside the GDPR.
- **CJEU, C-582/14 *Breyer*** (2016): data is personal when the holder has legal means to identify the person with additional data held by someone else ([judgment](https://curia.europa.eu/juris/liste.jsf?num=C-582/14)).
- **CCPA/CPRA**: [Cal. Civ. Code §1798.140](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140) counts unique and persistent identifiers that can recognize a consumer over time and across services as personal information.

## 8. Disclosure concerns

These are factual gaps between the code and the documents. Nothing here claims bad intent.

1. **"Anonymous" wording.** The privacy policy and the in-app texts call the data anonymous. The welcome screen says "T3 Code collects anonymous usage data to help us improve it" (`client/assets/welcome-7DMNd9pv.js`), and Settings → About says "the anonymous usage data T3 Code collects" (`client/assets/SettingsPanels-AJtmkC2d.js`). The data carries stable hashed account ids (section 7). The telemetry doc describes the hashes correctly ([L3-L6](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L3-L6)).
2. **Reading other apps' login files.** Neither the telemetry doc nor the privacy policy says that T3 Code reads `~/.codex/auth.json` and `~/.claude.json` (files written by the Codex and Claude Code CLIs) to build its analytics identity. The doc says only "your OpenAI and Claude accounts when you are signed in" ([L5-L6](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L5-L6)); a search of both documents for `codex`, `claude.json` and `auth.json` finds no mention.
3. **Cross-account linking.** The stated purpose is "to count how many installations one person uses" ([L4-L5](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L4-L5)), which means joining a person's OpenAI, Claude and T3 accounts in one analytics record. The privacy policy does not mention this.
4. **On by default, no in-app switch.** There is a first-run notice (the welcome text above, with a link to the privacy policy) but no toggle. Opting out needs `T3CODE_TELEMETRY_ENABLED=false` in the shell profile and a restart ([telemetry.md L16-L22](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L16-L22); [privacy-policy.astro L345-L349](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/apps/marketing/src/pages/privacy-policy.astro#L345-L349); [static-audit.md](static-audit.md) line 66). The heartbeat is sent at server start, before the user can act on the notice (section 6). By contrast, mobile crash reports do have a toggle, **Send crash reports** ([telemetry.md L32](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L32)).
5. **Axiom traces without Connect.** The telemetry doc says relay traces are sent "to diagnose T3 Connect connectivity" ([L14](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L14)), and the code comment on the exporter says "only T3 Connect spans" ([static-audit.md](static-audit.md) line 74). Yet a fresh, never-signed-in launch sent about 18 KB to `us-east-1.aws.edge.axiom.co` in 5/5 runs (section 3). The bench cannot see what those spans contain.
6. **Codex `account_id` is shared by a Team.** For Team users the `distinct_id` names the workspace, not the person, so several people's events merge under one id while the OpenAI user id is sent as an owner beside it (`binCli-BCouE1oK.mjs:154626-154627`, `:154760`).

What T3 Code does well:

- No email, name, token, prompt or file content was sent in the capture (section 5), and the doc states this ([L11-L12](https://github.com/pingdotgg/t3code/blob/aa11ef6783da81039e6646e2e96941748afb358e/docs/user/telemetry.md#L11-L12)).
- `$process_person_profile: false` is set on every event (`binCli-BCouE1oK.mjs:154884`).
- The analytics go to a first-party endpoint, and one environment variable turns off both analytics and relay tracing; the desktop app reads it from the shell profile ([static-audit.md](static-audit.md) lines 67-68).
- There is a first-run notice, the telemetry doc is public and specific, and the bundled Clerk and Coinbase analytics are gated off ([static-audit.md](static-audit.md) lines 91-97).

## 9. PandaCode

- **No analytics or telemetry SDK.** None in `src-tauri/Cargo.toml` or `package.json`; the only telemetry code turns third-party CLI telemetry off ([static-audit.md](static-audit.md) lines 101-108).
- **The webview cannot reach the network.** The CSP is `connect-src ipc: http://ipc.localhost` (`src-tauri/tauri.conf.json:32`), so every request goes through native code ([static-audit.md](static-audit.md) line 109).
- **No PandaCode-operated server receives anything automatically**; the Connect relay is opt-in ([static-audit.md](static-audit.md) line 110). The idle bench saw no analytics host (section 3).

Automatic requests ([static-audit.md](static-audit.md) lines 113-131; line numbers re-checked in this worktree):

| Request | When | Off switch | Evidence |
| --- | --- | --- | --- |
| App update: `latest.json` on GitHub Releases | 30 s after launch, then every 6 h | Settings → About → Updates → Off | `src/app-updates.ts:35`, `:109-111`; `src/app-updates-policy.ts:18` |
| Agent CLI version checks (`downloads.claude.ai`, `registry.npmjs.org`, `releases.openai.com`, `api.github.com`, `cdn.kimi.com`, `pypi.org`, `storage.googleapis.com`, `formulae.brew.sh`; only for installed CLIs) | 8 s after launch, then every 6 h | **None** | `src/agent-updates.ts:32`, `:42`; `src-tauri/src/agent_updates.rs:267`, `:283-332`; UA `PandaCode agent update checker` at `:371` |
| `gh auth status` (the user's own `gh` and token) | When a task's composer renders, cached 5 min | Settings → GitHub off | `src-tauri/src/github.rs:199`; `src/main.ts:2043`; `src/github.ts:9`, `:30-31` |

README privacy table gaps ([static-audit.md](static-audit.md) lines 140-152; table at `README.md:144-156`):

- The agent CLI row lists `formulae.brew.sh`, `downloads.claude.ai`, `api.github.com`, `cdn.kimi.com` and `registry.npmjs.org (Cline)`. The code also contacts `releases.openai.com`, `pypi.org`, `storage.googleapis.com`, and `registry.npmjs.org` for more CLIs than Cline. `releases.openai.com` and `storage.googleapis.com` were both contacted by the PandaCode process in 5/5 idle runs (section 3).
- There is no row for the automatic `gh auth status`.
- The price list row says "Daily"; the code fetches it at most daily and only when the Usage dialog opens.
- AGENTS.md calls the app update check "the only check of PandaCode's own", but the agent CLI checks are also automatic and cannot be turned off.

## 10. Limitations and how to reproduce

Limitations:

- **Payload capture.** It ran T3's server alone (Electron as Node), not the GUI, so `clientType`/`serverMode` were `cli-web-client`/`web`. With no client connected, only startup events were captured; turn and feature events and client-side owners were not exercised ([results/t3-payload/summary.md](results/t3-payload/summary.md) lines 67-68).
- **Idle bench.** Traffic is TLS, so the bench saw destinations and byte counts, not contents. Host names are inferred from addresses, nettop samples once a second, and traffic made by system daemons is not attributed ([README.md](README.md#known-limitations)).
- **Out of scope.** Telemetry sent by the provider CLIs themselves (Codex, Claude Code and others started by either app) ([results/t3-payload/summary.md](results/t3-payload/summary.md) line 69; [static-audit.md](static-audit.md) line 138).
- **Versions.** The installed T3 build is commit `1316d48b0c68` ([static-audit.md](static-audit.md) line 5); the public documents are quoted at `aa11ef6`. One machine, one network, one run date.

Reproduce:

```sh
# Idle bench (builds and setup in README.md)
node bench/telemetry-compare/run.mjs                  # RUNS=5 IDLE_S=60

# T3 Code analytics payload with canary logins (never reads the real ~/.codex, ~/.claude.json or ~/.t3)
node bench/telemetry-compare/t3-payload.mjs 45
# Linux: the same capture from an extracted AppImage (writes results/t3-payload-linux/)
T3_APP=/path/to/squashfs-root node bench/telemetry-compare/t3-payload.mjs 45

# Extract the T3 Code bundle to check the line numbers above
mkdir /tmp/t3asar-new && cd /tmp/t3asar-new
npx -y @electron/asar extract "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar" .
grep -n 'T3CODE_TELEMETRY_ENABLED' apps/server/dist/binCli-BCouE1oK.mjs
```
