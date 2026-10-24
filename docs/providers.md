# Provider integrations

PandaCode launches each installed CLI directly. Claude, Codex, Kimi, OpenCode,
Antigravity, and Grok Build own their authentication; sign in using their official
CLI or extension.
The optional Z.AI Coding Plan and MiMo Token Plan API keys are stored as separate
entries in PandaCode's secrets store (see [secret storage](#secret-storage)) and injected only into their isolated Claude subprocesses. The app discovers executable paths
from PATH and common per-user installation folders; provider settings report the
actual path and version. The `default` model delegates model selection to the CLI.

Model menus load metadata on demand from the installed CLI. Each choice keeps its
invocation ID separate from its display name and description, so choosing a named
model does not rewrite an alias or change the provider's configuration. Codex uses
`model/list` and preserves its `displayName` and description. Claude uses the SDK's
initialization `models` response (`value`, `displayName`, `description`, and, when
available, `resolvedModel`). Its resolved model ID supplies the release version
even when the CLI's display name is only “Sonnet”; unresolved aliases stay generic
instead of claiming a guessed version. See [SDK model metadata](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo).

Claude discovery sends only an initialization control request, with conversation
persistence, hooks, and MCP startup disabled. It sends no user prompt and performs
no inference. Codex discovery creates no thread. Both processes have bounded output
(1 MiB total, 256 KiB per frame), deadlines (15 seconds for Claude, 8 for Codex), and
process-group cleanup on completion, cancellation, or failure. Only picker metadata
crosses the desktop bridge; account information in initialization is discarded.
Unavailable catalogs leave the configured/default choice and custom model IDs usable.
The frontend caches successful catalogs for five minutes without a background poll.

Kimi reads `provider list --json` without creating an ACP session. A typed whitelist
extracts only the configured aliases, model IDs, and display names; provider
configuration and credentials are discarded rather than sent to the UI. Its process
is limited to 8 seconds and 1 MiB of output. Provider-supplied `displayName` values
take precedence; entries without display metadata show the exact wire model name.
See [Kimi model configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files#models).

## Named connections

Settings → Providers → Connections adds named setups of one harness, such as
`Claude Work` and `Claude Personal`, or two Pi profiles. Each connection has a
name, an optional executable, extra launch arguments (one per line; at most 32,
each under 1024 characters, no NUL), environment variables and, for harnesses
that read one, a config folder: `CLAUDE_CONFIG_DIR` (Claude Code, GLM, MiMo),
`CODEX_HOME` (Codex), `PI_CODING_AGENT_DIR` (Pi) or `OPENCODE_CONFIG_DIR`
(OpenCode). Other harnesses take their folder variable under Environment.

Connections live in `connections.json` beside the provider settings
(`src-tauri/src/connections.rs`). Variables marked Secret are stored in PandaCode's
secrets store (service `app.pandacode.connections`, one account per connection
and variable); the file and the webview only see their names, and an edit that
leaves a secret empty keeps the saved value. Deleting a connection removes its
secrets and returns its tasks to the harness's own setup.

The model picker lists each connection as its own group (`Claude Work · Claude
Sonnet 5`); choosing a row sets the task's connection (`connection_assign`),
and the composer label shows it. The assignment is kept per task in the same
file, so no schema change was needed, and a task never changes connection on
its own. A task without one, or whose harness no longer matches its connection,
uses the global configuration exactly as before.

At launch (`run_inner` in `providers.rs`, and warm Claude agents in
`providers/warm.rs`) the connection's executable replaces the discovered one,
its arguments are appended and its environment, including the config folder
variable, is set after the harness's own configuration. Secret values are
removed from any error the run returns. The warm-agent key includes the
connection id and its revision, so another connection, or a saved change to the
same one, never adopts an idle process. Model catalogs, usage checks and slash
command discovery still use the global setup. Tasks running on another
computer use that computer's setup.

## GitHub Copilot CLI

Install GitHub Copilot CLI using [GitHub's installation guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli), then sign in in a terminal with `copilot login`. PandaCode discovers or uses the configured `copilot` executable and starts its local ACP stdio server with `copilot --no-auto-update --acp --stdio`. The CLI owns GitHub authentication; PandaCode does not store GitHub credentials or add a separate login flow. ACP support is a public preview; see [GitHub's ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).

The model picker reads only ACP metadata. It offers the models Copilot advertises and keeps **Default** available if the catalog is empty or unavailable. A model override is sent only when Copilot advertises that setting; the picker does not accept arbitrary model IDs for this provider. Copilot CLI 1.0.82 advertised task modes Agent, Plan and Autopilot, plus an Allow All setting, but no model catalog. PandaCode maps Agent with Allow All off to **Standard**, Plan with Allow All off to **Plan mode**, and Agent with Allow All on to **Full access**. Autopilot is not exposed because it does not map to a PandaCode permission mode. In Plan mode, read, search and think requests can proceed while other permission requests are declined. No prompt is sent during catalog discovery.

## Claude login and environment credentials

Open **Settings → Agents → Set up → Claude Code** to see the credential source
detected in PandaCode's environment. **Check login** separately checks Claude's
saved login using `claude auth status --json`; it sends no prompt. The card shows
credential variable names and the origin of a custom endpoint, never keys,
tokens, account details, URL paths, or URL query values.

**Use current environment** is the default and preserves existing setups. To
prefer the account saved by `claude auth login`, choose **Prefer saved Claude
login**. New Claude turns, model/command discovery, and harness consoles then
remove inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, custom API endpoints/headers, cloud-provider switches,
Anthropic profile/federation selectors, and model-routing overrides. The
preference does not change the system environment, saved Claude credentials,
active processes, GLM, or MiMo. Switch back to **Use current environment** to
restore inherited configuration for newly launched Claude processes.

Claude settings files, `apiKeyHelper`, active profiles, and organization policies
can still affect the credential used. Check `/status` in a newly opened Claude
console to confirm the account and login method. A detected saved login does not
verify its plan, quota, expiry, or access to a particular model. See Claude's
[authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)
and [environment variable reference](https://code.claude.com/docs/en/env-vars).

## Conversation continuity

An idle task can switch harnesses from the model picker without changing its
project, checkout, or saved transcript. PandaCode starts a fresh native session for
the chosen harness and transfers bounded text history with the next normal
message, using the recovery mechanism below. A **Conversation carried forward**
disclosure explains the transfer. Earlier replies retain their original provider
labels, including in paginated history, conversation forks, and the quick overlay.
Private reasoning, tool execution state, and earlier image bytes do not transfer.
Running tasks and active architect/worker configurations retain their existing
configuration guards. Provider-specific goal/settings state and a previous
harness's native resume ID are not reused by a different harness.

The saved provider session ID is reused across ordinary turns and app restarts.
Changing a task's team settings retains Claude/Kimi's native context. Codex only
supports registering dynamic tools when a thread is created; enabling or disabling
its team therefore queues a conversation transfer before replacing its native ID.
Saving the same setup or selecting single-agent mode again does not reset anything.

If a task has history but lacks a native session ID, PandaCode also queues that
history automatically. Schema 14 repairs tasks affected by the earlier architect
reset notice, including tasks that already received a replacement native ID.
The next normal prompt includes the earlier user/assistant messages as historical
JSON, followed by the current request. The visible transcript is unchanged. Tool,
system, and diff records are excluded; history is limited to the newest 200
messages and 64 KiB encoded, and truncation is disclosed in the handoff.

Recovery is acknowledged only after a successful, persisted turn with a saved
native session ID. Startup failures, cancellation, and app restarts keep the
transfer pending. Once delivered, later prompts use native resumption without
resending the transcript. Native slash commands, goal start/resume, harness
console launch, and forking require a normal message first when recovery is
pending because those paths cannot deliver a historical prompt. Goal inspection,
pause, and clear remain available without acknowledging the transfer.

## Reasoning effort and context

Effort choices come from the selected model's reported capabilities. Claude's
initialization `supportedEffortLevels` supplies the choices, and explicit selections
are passed with `--effort` on new and resumed runs. Codex supplies
`supportedReasoningEfforts` and `defaultReasoningEffort`; the selected ID is applied
in thread configuration and `turn/start.effort`. Catalog validation runs before
sending the prompt. The installed app-server's generated v2 JSON schemas were used
to verify these fields; see [app-server reference](https://developers.openai.com/codex/app-server).

The installed Kimi ACP adapter exposes a `thinking` configuration option with
on/off values. Only those advertised settings are offered; a model declaring
`always_thinking` cannot select Off. Although Kimi configuration can name numeric
effort levels, this adapter cannot apply them. The app waits for configuration
acknowledgement before prompting. See [Kimi ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
and [model configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files).

**Default** sends no PandaCode override. The harness retains control, including any
saved effort in a resumed session. It does not promise to reset external harness
settings. Claude can resolve capabilities for its default alias; an unresolved
Codex/Kimi default requires choosing a catalog model to expose effort choices.

Context capacity is shown only when explicitly reported. Codex usage uses
`tokenUsage.last.totalTokens` with `modelContextWindow`, not cumulative totals.
Claude counts the latest main-agent message's input, cache reads, cache creation
and output; its result may supply that model's context-window size. Subagent and
cumulative per-model billing totals are excluded. Kimi configured `maxContextSize`
supplies capacity; ACP `usage_update` can supply current usage when emitted by the
installed version. Unknown usage is hidden. Counts are last reported snapshots and
may decrease after compaction; the UI does not estimate them from conversation text.

Each active turn owns one process. Completed turns close stdin and release that
process; the next turn resumes the saved provider session. Stop sends the provider's
interruption message, then terminates its process group after a short grace period.
Closing the app also drops the input channel and stops the group. Runtime output
uses bounded frames (4 MiB maximum) and a 16 KiB stderr tail. No Node/Python SDK host
or network bridge runs inside PandaCode.

## Response streaming

Complete newline-delimited JSON events are forwarded as soon as stdout supplies
them; the adapter does not wait for the turn to finish. Claude launches with
`--include-partial-messages`; Codex app-server and Kimi ACP stream by default.
`message_start` precedes the first nonempty `text` delta of each main assistant
message, with bounded `data.messageId` and optional `data.phase` (Codex commentary
or final answer). Native persistence flushes the preceding assistant message at
this boundary without storing a marker row.
If message IDs interleave, a resumed ID starts a new contiguous display segment;
text never appends silently to another message's live buffer.

The latest assistant message stays visible outside the activity disclosure while
tools run. A tool call or `message_start` records its place in history without
clearing that visible message. The next nonempty text delta replaces it in the
same live message element, then subsequent deltas append normally. Only then does
the previous message appear in activity history (or as an earlier Board comment).
Repeated boundaries and empty deltas do not create duplicates or blank the slot;
completion materializes the retained response once before loading saved history.

Claude and Codex completion snapshots supply only a missing suffix whose prefix
matches the emitted stream. Replayed snapshots and empty deltas do not duplicate
text or open empty messages. Tracking retains at most 128 message IDs, byte counts,
and incremental digests; it does not keep another copy of response bodies. A
completion that changes an already-emitted prefix is not appended as unrelated
replacement text. Claude excludes child-agent transcript frames while retaining
top-level Agent/Task tools, their results, and child permission requests. Codex
filters notifications by active thread and turn so child events cannot contaminate
or prematurely finish the parent response.

Kimi honors ACP `messageId` when supplied. The installed Kimi 0.26 adapter omits it
and already filters child-agent events, so PandaCode derives boundaries when text
resumes after a new tool call or thinking segment. Late updates to an existing tool
do not split subsequent text; history replay during session loading is excluded.
See [Claude streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output),
[Codex app-server events](https://developers.openai.com/codex/app-server), and
[ACP message IDs and prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn#message-ids).

Tool events send a bounded snapshot containing the tool's name, status, input and
output across the desktop bridge. Input previews are limited to 4 KiB and output
previews to 8 KiB, with UTF-8-safe truncation notices. Each adapter keeps at most 64
tool snapshots to join starts, sparse updates and results. The UI shows separate
Input and Output sections and preserves one tool row through completion and reload.
Opaque event metadata still uses a small scalar allowlist; pending approval requests
remain native until answered so the provider receives its complete input correctly.

Each active task owns its protocol state, input channel, process group and stderr
reader. Stopping or aborting a run cleans up that group and its reader without
interrupting other tasks. Newline detection scans each stdout byte once, avoiding
quadratic rescans when several providers emit large tool-result frames together.
Admission has no global simultaneous-task limit. It rejects duplicate starts for
the same task before adding another user message or spawning another process.

Claude joins `tool_use` and `tool_result` by call ID and assembles bounded partial
tool input before emitting it. Codex extracts command, working directory, exit code,
output, file changes and MCP results from item notifications. Kimi merges ACP tool
updates, retaining input previews until terminal result content arrives. Already
saved label-only entries cannot recover details that earlier versions discarded.

| Provider | Entry point | Persistence | Interruption |
| --- | --- | --- | --- |
| Codex | `codex app-server` | `thread/start`, then `thread/resume` | `turn/interrupt` |
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` | CLI session ID, `--resume=<id>` | control request subtype `interrupt` |
| Kimi Code | `kimi acp` | `session/new`, then advertised `session/resume` or `session/load` | `session/cancel` |

Codex uses newline-delimited app-server requests and item notifications. The native
adapter covers thread creation/resumption, text streaming, tool events, and file,
command, and permission approval requests. Ask and Auto both use `workspace-write`
with `on-request` approvals routed to the user: operations allowed by Codex's sandbox
can run, while escalation requests appear in PandaCode. Neither mode disables its
sandbox. Codex's own rules still apply. The protocol was checked against the installed
CLI's generated schemas, version 0.150.1. See [official app-server documentation](https://developers.openai.com/codex/app-server).

Claude uses the installed executable's bidirectional control protocol. Ask retains
print mode's normal manual permissions; Auto selects `acceptEdits`, which approves
workspace edits while other protected actions still request permission. The adapter
waits for the initialization response, streams text deltas, and avoids repeating the
final full assistant message. The raw control protocol is an implementation interface
used by Anthropic's SDK and should be tested when upgrading Claude. See
[headless usage](https://code.claude.com/docs/en/headless),
[stream events](https://code.claude.com/docs/en/agent-sdk/streaming-output), and
[the official SDK's control transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).

Kimi uses ACP version 1 with no client filesystem/terminal capabilities advertised;
Kimi performs those operations through its own tools. The adapter explicitly selects
ACP's `default` mode, which maps to manual permissions, before each prompt; it fails
if that mode is unavailable. Auto currently keeps Kimi's manual
approval behavior: its `--auto` flag enables unattended approval of far more than
file edits, so PandaCode does not map to it. Permission responses select an option ID
actually offered by the server. Kimi 0.26.0 is the newer Kimi Code executable, distinct
from the legacy Python Kimi CLI and its Wire protocol. See
[Kimi ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp),
[permission modes](https://moonshotai.github.io/kimi-code/en/guides/interaction.html),
[ACP mode mapping](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/modes.ts),
[ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), and
[permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls).

The first release supports boolean tool approvals. Structured provider questions
and custom elicitation forms are not implemented. Kimi's multiple-choice questions
are cancelled rather than selecting an answer through a generic Approve button.
Other unsupported reverse requests receive explicit errors; Claude is asked to put
questions in its text response so the user can answer in the next turn. Existing CLI hooks, MCP configuration, and
provider rules remain provider-owned and can affect startup time and memory.

Run `cargo test` for parser and permission tests. Live integration tests are ignored
by default because they consume provider usage. To explicitly exercise a provider:

```sh
PANDACODE_SMOKE_PROVIDER=codex cargo test smoke_provider_from_env -- --ignored --nocapture
```

Use `claude` or `kimi` for the other providers. The test creates a temporary Git
repository, asks for one fixed token, resumes the conversation, and checks that the
provider remembers that token. It rejects all tool approval requests and validates
that the same provider session is reused. Successful output prints only the fixed
token, event count, and presence of a session ID.

Set `PANDACODE_SMOKE_MODEL` to test a specific model without modifying the user's
provider settings. Live checks on September 12, 2026 verified successful Claude
`sonnet` and Codex `gpt-5.6-sol` generation and resumption across both turns. The
configured Codex default required a newer CLI. Claude's configured default reported
unavailable usage credits. Explicit model overrides worked without changing those
settings. Kimi required authentication; that response verifies startup and error
handling but does not establish successful Kimi generation or resumption.

A read-only `model/list` query against Codex 0.150.1 returned `gpt-5.6-sol`
(catalog default), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and
`gpt-5.3-codex-spark`. This catalog differs from the user's configured default;
PandaCode leaves that configuration intact and accepts explicit model IDs.

Read-only catalog checks do not consume model inference usage:

```sh
cargo test installed_claude_catalog -- --ignored --nocapture
cargo test installed_codex_catalog -- --ignored --nocapture
cargo test installed_kimi_catalog -- --ignored --nocapture
```

## Subagent activity

Delegation snapshots use `kind: "subagent"`, empty `text`, and `data` containing
`id`, `parentId`, `name`, `prompt`, `status`, `response`, `tools`, `startedAt`, and
`updatedAt`. Times are Unix milliseconds. Status is `running`, `waiting`,
`completed`, `failed`, or `stopped`. Native code namespaces provider identities by
parent run and persists child history separately from the parent's messages.

- **Codex:** the installed executable's generated app-server schema includes
  `collabAgentToolCall`, `subAgentActivity`, and child `thread/started` source
  linkage. PandaCode records those identities, routes their text/tool notifications
  into isolated parsers, and uses `agentsStates.message` to recover results when
  child notifications are absent. Completing a spawn call does not complete its
  child. Child failures/completions never terminate the parent's turn. Source:
  `codex app-server generate-json-schema --experimental --out <temporary-directory>`
  (`ItemStartedNotification`, `ThreadStartedNotification`, and
  `ThreadStatusChangedNotification`), plus the
  [official app-server documentation](https://developers.openai.com/codex/app-server).
- **Claude:** `Agent` (and legacy `Task`) tool calls establish children;
  `parent_tool_use_id` routes their streamed text and tool results. Background
  `task_started`, `task_progress`, `task_notification`, and terminal
  `task_updated.patch.status` events update the same child. Background Bash tasks
  are excluded. Final result snapshots reconcile with previously streamed text.
  Sources: [subagent protocol guidance](https://code.claude.com/docs/en/agent-sdk/subagents)
  and [official SDK lifecycle types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).
- **Kimi:** identifiable `Agent` calls expose their prompt, progress, and returned
  result. The current Kimi Code ACP implementation subscribes only to the main
  agent, so live child-internal messages/tools and independent background-child
  completion are unavailable through this transport. PandaCode does not invent
  those details, parse terminal text for fake identities, or start another server.
  Calls remain correlated after ACP replaces the tool title with its description.
  Sources: [ACP session subscriptions](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/session.ts),
  [tool notification mapping](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/events-map.ts),
  and [Agent tool parameters](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/tools.md).

Each run retains at most 64 child previews at a time. When that cache fills,
its oldest terminal child retires to make room for later delegates; active children
are never evicted (up to 64 simultaneous children). Each retained child keeps a 32 KiB response preview and its latest 16 tools (2 KiB input / 4 KiB output
per tool); prompt previews are 4 KiB. Consumed child frames move into the parser
instead of copying potentially multi-megabyte envelopes. Rendering receives only
bounded snapshots, and storage checkpoints ongoing updates at most once per
second. Parent exit/stop and app recovery settle children still marked active.

Deterministic protocol tests cover interleaved child identities, nested linkage,
permission waiting/resumption, final-suffix recovery and replay deduplication,
background lifecycle, unrelated/stale turn exclusion, and output/count bounds.
No provider inference requests are required by these tests.

## OpenCode, GLM Coding Plan, and Antigravity

OpenCode launches `opencode acp` using ACP v1. Models come from its installed
`models --verbose` catalog with real display names, provider/model IDs, context
limits, and variant IDs. Catalog output is bounded and whitelisted so provider
headers and arbitrary options never reach the UI. Live `configOptions` are
authoritative: PandaCode selects mode, then model, then advertised reasoning effort,
waiting for each acknowledgement before sending the prompt. Session loading
suppresses replayed history, and resumption uses the advertised `resume` or
`loadSession` capability. Unsupported capabilities fail before prompting.

OpenCode's process-local `OPENCODE_CONFIG_CONTENT` sets Standard to approval for
actions with read/search allowed; Auto edits also allows edits; Plan denies
non-read actions; Full access allows actions. The selected built-in `build` or
`plan` agent gets the same policy override, including on resumed sessions. No
OpenCode configuration files are rewritten.

GLM uses Claude Code's existing bidirectional streaming protocol with Z.AI's
`https://api.z.ai/api/anthropic` endpoint. Its default is `glm-5.3`; the other
choices are documented Coding Plan model IDs, not fictional Claude aliases.
Legacy Coding Plan IDs (`glm-5.2`, `glm-5.1`, `glm-4.7`) are routed server-side
to current models, so the picker lists the current lineup — `glm-5.3`,
`glm-5.3-flash`, their `[1m]` variants, and the still-advertised
`glm-5-turbo`. Model
availability depends on the user's Z.AI plan; custom IDs remain available. Claude's
normal model catalog cannot advertise Z.AI plan entitlements, so this picker uses
the published Coding Plan list and does not claim measured context/effort metadata.
Explicit `--model` choices override the default environment value.

**GLM settings isolation:** Claude settings-file environment values override
inherited shell environment. Therefore GLM uses `--setting-sources ""` and
non-secret command-line settings to prevent user/project Claude credentials or
endpoints replacing the Coding Plan connection. It does not inherit those settings
files' hooks/plugins/permissions; PandaCode's explicitly supplied MCP tools remain
available. Claude-managed enterprise policies still apply. The key is never
written into argv or a settings file; it is resolved from PandaCode's secrets store or
`ZAI_API_KEY`. Competing Anthropic/cloud auth variables are removed, and Claude's
subprocess credential scrubbing is enabled.

Antigravity launches Google's official `agy_acp_server.par` (`agy_acp_server.exe`
on Windows), which can be selected in Settings. The standalone `agy` terminal
CLI is not misidentified as an ACP server. The executable and provider sign-in
must already be installed. ACP initialization/session metadata supplies its model
labels and supported controls; image, HTTP MCP, resume, and planning support are
checked explicitly. No private API, unofficial adapter, or browser-cookie
authentication is used. Antigravity's own policy applies, with ACP approval
requests shown in Standard; Auto edits approves explicit edit requests and Full
access approves offered one-time permissions. Structured questions are not
auto-selected. Modes not advertised by the server are not invented.

**Connection check.** In Settings, expand Antigravity's installation details and
choose **Check connection**. This separately verifies ACP initialization and an
empty session, reports a required sign-in or failed startup, and allows retry. It
does not send a prompt, sign in automatically, or verify model quota. A detected
executable alone is never presented as a verified connection.

ACP model discovery allows up to 60 seconds for cold startup. Successful metadata
is cached for five minutes by executable identity and shared with slash-command
discovery. Default-only results do not overwrite a known catalog; explicit
refresh invalidates both native and UI caches, including older pending results.
During an Antigravity turn, startup, session creation/resumption, setting changes,
and waiting for the response have separate status messages.

Both ACP adapters stream text/tool/usage updates, publish available slash commands,
route explicit approval responses using offered option IDs, and preserve task
context across restart. They advertise no client filesystem or terminal capabilities:
those actions run through each harness's own tools. Provider metadata discovery
sends no inference request; ACP-only metadata discovery can create an empty
harness session.

Verified interfaces (2026-09-16): [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/),
[OpenCode models CLI](https://dev.opencode.ai/docs/cli/#models),
[OpenCode permissions](https://opencode.ai/docs/permissions/),
[ACP session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options),
[Z.AI Claude setup](https://docs.z.ai/devpack/tool/claude),
[Claude environment precedence](https://code.claude.com/docs/en/env-vars#precedence),
[official Google ACP registry entry](https://raw.githubusercontent.com/agentclientprotocol/registry/refs/heads/main/antigravity-acp/agent.json),
and [Antigravity authentication](https://antigravity.google/docs/ide/extensions).

## MiMo Token Plan

Xiaomi's MiMo models reach PandaCode the same way GLM does: through the installed
Claude Code, pointed at MiMo's Anthropic-compatible endpoint with a MiMo key
(documented at https://mimo.mi.com/docs/en-US/tokenplan/integration/claudecode).
The Token Plan is a fixed subscription with a dedicated cluster per account —
`https://token-plan-{cn|sgp|ams}.xiaomimimo.com/anthropic`, keys `tp-…` (individual) or
`ttp-…` (team); the pay-as-you-go API is `https://api.xiaomimimo.com/anthropic` with
`sk-…` keys. Settings → Agents → Provider connections has one MiMo card: a cluster
picker (the four endpoints above, nothing free-form — the URL is shown for the chosen
one) and the key. The key goes into PandaCode's secrets store under its own account
(`mimo-token-plan`) or comes from `MIMO_API_KEY`; the cluster choice is a plain
setting (`mimoEndpoint`). Unknown cluster IDs are dropped on load and refused on save.

A MiMo task cannot start until a cluster is chosen and a key exists; both errors name
the setting to fix. The launch mirrors GLM's isolation: `--setting-sources ""` plus a
process-local `--settings` block that fixes `ANTHROPIC_BASE_URL`, blanks
`ANTHROPIC_API_KEY`/OAuth/cloud variables, sets the Sonnet/Opus slots to
`mimo-v2.6-pro` and the Haiku slot to `mimo-v2.6-flash` (background work at a third of
the credit cost), and enables `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` as MiMo's
guide recommends. The key travels only in `ANTHROPIC_AUTH_TOKEN`, never in argv, and
`ZAI_API_KEY`/`MIMO_API_KEY` are scrubbed from the child. Slash-command discovery and
the harness console use the same flags. Everything else — streaming, approvals,
`--permission-mode`, effort, resume, MCP tools, image blocks — is Claude Code's normal
stream-json protocol.

The picker lists the documented plan models (`mimo-v2.6-pro`, its `[1m]` 1M-context
variant, `mimo-v2.6-flash`, and the V2.5 pair that retires on October 21, 2026) with
descriptions only; MiMo publishes no per-plan entitlements, so no context or effort
metadata is claimed and custom IDs stay usable. Endpoints and models verified against
the MiMo docs on 2026-09-22.

## Grok Build

xAI's Grok Build CLI (`grok`, installed with `curl -fsSL https://x.ai/cli/install.sh | bash`)
exposes ACP v1 on `grok agent stdio`, which PandaCode drives with the shared ACP
adapter. The launch line is `grok --no-auto-update --permission-mode <mode> agent
[--always-approve] [--model ID] [--reasoning-effort E] stdio`: global flags precede
`agent`, agent flags precede the `stdio` transport, and the permission mode
overrides whatever the user's `~/.grok/config.toml` saved for the TUI (a saved
`always-approve` would otherwise silence every prompt).

**Sign-in.** Grok Build requires `authenticate` before any session call, even with
cached credentials. PandaCode picks the advertised `defaultAuthMethodId` (normally
`cached_token`, backed by `~/.grok/auth.json`) and only then sends `session/new`
or `session/resume`. Without a cached method, or when it fails, the turn stops with
“Grok Build is not signed in. Run `grok login` in a terminal, then send again.” No
browser sign-in is ever triggered from the app.

**Models and effort.** `initialize` returns `_meta.modelState` with every model, its
`totalContextTokens`, and its reasoning efforts (`low`…`xhigh`, with the default
marked), so discovery never creates a session. `session/new` also returns
`configOptions` (`model`, `reasoning_effort` in the `thought_level` category), and the
adapter applies the chosen model and effort through `session/set_config_option`
before prompting; the same values ride the launch flags so a resumed session that
does not re-advertise options keeps them. Custom models from `config.toml` appear
with their configured names.

**Approvals.** Standard → `--permission-mode default` (Grok asks through
`session/request_permission`; PandaCode shows the request). Accept edits →
`acceptEdits` plus automatic approval of `edit` requests. Full access →
`bypassPermissions` with `--always-approve`. Grok's ACP agent has no read-only
session mode, so **Plan mode** launches in `default` mode, prefixes the prompt with a
read-only instruction, allows requests the agent marks `read_only` (or of kind
`read`/`search`/`fetch`/`think`), and declines everything else with the offered
`reject_once` option, noting “Plan mode declined: …” in the activity stream.

**Turn data.** Streaming text arrives as `agent_message_chunk`; reasoning arrives as
`agent_thought_chunk` and is summarized as a single “Reasoning” status per stretch
rather than echoed. Every `session/update` carries `_meta.totalTokens` (the context
currently held), which feeds the context indicator against the active model's
`totalContextTokens`; `_x.ai/session_notification` `model_changed` keeps the active
model current, and the `session/prompt` result's `_meta.totalTokens` closes the turn.
Other `_x.ai/*` notifications (queue, settings, announcements, hooks) are ignored.
Tool calls, diffs, slash commands (`available_commands_update`, including installed
skills), HTTP MCP for PandaCode tools, cancel, and resume all use the common ACP paths.

**Not yet.** The agent advertises `promptCapabilities.image: false`, so the composer
offers documents and folders but refuses images for Grok tasks with a note; the
mockup sketcher is hidden for them. Slash-command discovery and the harness console
(`grok --resume <id> --permission-mode …`) follow the same flags; `plan` maps to the
TUI's native plan mode there.

Verified against `grok` 1.0.30/1.0.40 on 2026-09-21 by driving `grok agent stdio`
directly; the recorded frames back the unit tests in `providers/acp.rs`, and an
ignored smoke test (`installed_grok_negotiates_settings_without_prompt`) replays the
real handshake up to the prompt boundary without spending tokens.

## Command Code

Command Code (`command-code`, installed with `npm i -g command-code`, Node 22 or
newer) exposes ACP v1 on `command-code acp` — the transport OpenCode also uses — so
PandaCode drives it with the shared ACP adapter. The launch line is
`command-code acp`. Its npm package also ships the aliases `cmd`, `commandcode` and,
on Windows, `cmdc`; PandaCode looks for `command-code`.

**Sign-in.** Command Code keeps its own login (`command-code login`, stored in
`~/.commandcode/auth.json`). A key saved in Settings → Agents, or
`COMMAND_CODE_API_KEY`, authenticates the same account and is injected into the ACP
process; the CLI reads the environment variable ahead of its own file, so a key-only
setup never needs the CLI login. The same key also authenticates Command Code's
Provider API. With neither, `session/new` fails with ACP `-32000` and the turn stops
with “Command Code is not signed in. Run `command-code login` in a terminal, or save
an API key in Settings → Agents, then send again.”

**Models and effort.** `session/new` returns `configOptions` (`model`, and `effort`
in the `thought_level` category) with display names and descriptions, so discovery
opens an empty session and never prompts. The adapter applies the mode, then the
model, then the advertised reasoning effort, waiting for each acknowledgement before
sending the prompt. ACP reports reasoning efforts for the model the session currently
holds, so they are attached to that model only, and the catalog is whatever the
account's plan can reach (Command Code's own models plus any BYOK providers).

**Approvals.** Command Code's ACP modes are its permission modes, so each PandaCode
choice maps onto one directly: Standard → `default`, Accept edits → `auto-accept`,
Plan → `plan` (read-only: no edits or commands), Full access → `bypass`. A mode the
server stops advertising fails the turn instead of silently running in a different
one; plan mode needs no prompt prefix, because the harness enforces it.

**Turn data.** Streaming text, tool calls, context usage (`usage_update`), slash
commands (`available_commands_update`, including installed skills), cancel, resume
(`session/resume`) and HTTP MCP for PandaCode tools all use the common ACP paths.
`loadSession` is advertised, so a task keeps its native session across turns.

**Not yet.** The harness console is not offered for Command Code, and a mid-turn
message stays queued: its ACP server refuses a second prompt while a turn is running,
so there is no steering path to hook into.

Verified against `command-code` 1.87.1 on 2026-10-22 by driving `command-code acp`
directly; the recorded frames back the unit tests in `providers/commandcode.rs`, and
an ignored smoke test (`live_command_code_lists_models`) reads the real catalog
without spending tokens.

## Cline

Cline (`cline`, installed with `npm i -g cline`) exposes ACP v1 with
`cline --acp`, so PandaCode drives it with the shared ACP adapter. The npm package's
`bin/cline` is a Node launcher for a bundled native binary. On Windows the npm
`cline.cmd` shim resolves to that declared entry.

**Sign-in.** Cline keeps its own sign-in (`cline auth`: Cline, ClinePass or a ChatGPT
subscription), or reads `CLINE_API_KEY` from the environment. Without either,
`session/new` fails with ACP `-32000` (“Authentication required: Call authenticate
before starting a session”), and the turn stops with “Cline is not signed in. Run
`cline auth` in a terminal, then send again.” PandaCode never starts Cline's browser
OAuth itself.

**Models and effort.** `session/new` returns `configOptions` (`provider`, `model`,
`mode`, boolean `auto_approve`), so discovery opens an empty session and never
prompts. The `provider` option shares the model category, so the adapter matches
options by ID first. There is no ACP effort option. The effort is the launch flag
`--thinking none|low|medium|high|xhigh`, offered for every model.

**Approvals.** See [approvals](approvals.md): Plan → `plan`, everything else → `act`.
Full access adds `--auto-approve true`.

**Turn data.** Streaming text, thoughts, tool calls with `rawInput`/`rawOutput`,
cancel and `session/load` (resume) use the common ACP paths. Cline can load a
session only after it has received a prompt. It has no `session/resume`.

**Not available from Cline's ACP server (3.0.73).** Images: `image: true` is
advertised, but the prompt keeps only text blocks, so screenshots are sent as
file paths that its `read_files` tool opens. Cline ignores the ACP `mcpServers`
list and does not advertise HTTP MCP, so PandaCode tools (titles, run/preview,
team tools) are unavailable, and a task that requires them fails at startup.
There are also no `available_commands_update` (slash commands), no `usage_update`
(context meter) and no usage limits. Mid-turn messages stay queued.

Verified against `cline` 3.0.73 on 2026-10-22 by driving `cline --acp`
directly. The recorded frames back the unit tests in `providers/cline.rs`, and
an ignored smoke test (`live_cline_lists_models`) reads the real catalog without
spending tokens.

## Kilo Code

Kilo Code (`npm i -g @kilocode/cli`) exposes ACP v1 with `kilo acp`, so PandaCode
uses its shared ACP adapter. Sign in with `kilo auth login` (or `/connect` in
Kilo). Credentials and provider configuration stay with Kilo; PandaCode adds no
separate account or key store. See the [official CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli).

**Models and effort.** Discovery opens an empty session without sending a prompt
or spending model tokens. Kilo advertises `model`, `effort` and `mode` config
options; the current model's effort choices belong only to that model. Default
leaves selection to Kilo. Mode, model and effort changes must be acknowledged
before the prompt is sent. Missing advertised choices fail the turn.

**Approvals.** Standard, Accept edits and Full access select Kilo's `code` agent;
Plan selects `plan`. A process-local `KILO_CONFIG_CONTENT` sets global and
code/plan wildcard permissions to `ask` in both `agent` and legacy `mode`
settings; the inherited `KILO_PERMISSION` override is removed. PandaCode allows read/search/fetch/think
requests, approves edits in Accept edits, and declines all other requests in Plan
(cancelling if no rejection option is offered). Full access uses `allow` instead.
Kilo's own configuration and managed restrictions still apply. These are tool
permissions, not an OS sandbox. Kilo auto-updates are disabled for
these subprocesses; update the CLI yourself.

**Turn data.** Images, streaming text, tool calls, HTTP MCP for PandaCode tools,
advertised slash commands, cancellation and session resume use the shared ACP
paths. Kilo advertises both `session/resume` and `session/load`; older servers
with only `loadSession` use `session/load`. Mid-turn messages remain queued for
the next turn. Named connections accept `KILO_CONFIG_DIR` as their config folder.
Their inline model/provider settings are retained, but the task's permission
policy is applied after connection overrides.

**Not integrated.** The interactive harness console, cloud-agent installation,
automatic CLI updates and account balance/limits are not offered for Kilo. Check
your Kilo or connected provider dashboard for credits and limits.

Verified against `kilo` 7.3.41 on 2026-10-24 with real ACP metadata. Recorded
frames back `providers/kilo.rs` tests; `live_kilo_lists_models` is an ignored,
opt-in smoke test that reads the installed CLI's catalog without prompting.

## Muse Code

Muse Code (Meta's coding agent CLI, `muse`, installed by its launcher into
`~/.local/bin`) has no ACP mode. Its machine interface is MSP, a newline-delimited
JSON-RPC protocol served by `muse serve` over stdio, so `providers/muse.rs` is a
native MSP client (the schema comes from `muse schema generate-ts --out DIR`). The
launch line is `muse serve`, plus the sandbox flags below; `MUSE_LOGIN=0` keeps the
launcher from starting a device login on PandaCode's pipes. MSP commands carry a
client-minted UUIDv7 `commandId`; Muse refuses any other version.

**Sign-in.** Muse keeps its own login (`muse login`, `~/.config/muse/auth.json`).
Without it the turn ends `failed` with error kind `authRequired`, and PandaCode stops
with “Muse Code is not signed in. Run `muse login` in a terminal, then send again.”

**Session flow.** `initialize` (requesting the `sessionMcp` capability) →
`initialized` → `session/start` with the workspace root, approval mode, model and
PandaCode's tool server as a per-session `streamableHttp` MCP server, or
`session/resume` with the saved MSP session ID followed by
`session/setApprovalMode` and `session/setModel` (resume takes neither). The session
ID is the task's resume ID. `turn/start` carries the prompt parts and the reasoning
effort; starting or resuming subscribes the connection, so no `view/subscribe` is
needed. A run ends at `turn/completed` for its turn, after Muse's blocking reminder
agents finish (`turn/foregroundCompleted` comes earlier and is not the end).

**Turn data.** `item/delta` (field `text`) streams `agentMessage` text and
`item/completed` snapshots it (`messagePhase` `commentary` / `finalAnswer`).
`reasoning` items show a Reasoning status. `toolCall`, `webSearch`, `subagent` and
`userShell` items become tool activity with their arguments and visible output;
`write_file`/`edit_file`/`apply_patch` arguments and `bash` calls feed change
tracking. `session/contextUsage` reports context usage, and a turn that fails with a
quota (`error.quota.resetsAtMs`) reports the usage limit and its reset time.
Images ride the turn as `image` parts (`base64Data`, `mediaType`). A leading
`/name` that matches `skill/list` is sent as a `skill` part with the rest as its
arguments; the `/` menu lists those skills, read from a memory-only host
(`muse serve --no-session-log`) in the task folder. Model discovery reads
`model/list` the same way (models, their effort `variants`, default effort and
context limit) and never prompts.

**Approvals and questions.** `approval/request` and `userInput/request` are
server requests: PandaCode acknowledges presentation at once (`{}`), then answers
with `approval/decide` (the offered `approved` choice, or `denied`/`abort` to
decline) or `userInput/answer` (an offered label as `selectedLabel`, anything else as
`freeText`; an empty or stopped form sends `userInput/cancel`). Questions use the
shared structured-input form. `approval/resolved` and `userInput/settled` close a
prompt that Muse's LLM approval judge, a rule or another client settled first.

**Steering and stop.** A mid-turn message goes to `turn/steer` with the running
`expectedTurnId`. Once Muse accepts it, the steer is reported `pending` (mode `live`);
it is `delivered` when Muse echoes it as a `userMessage` carrying its `commandId`
(`steered: true`) or, when the turn finished before the model read it, when Muse
starts it as its own turn (`turnId` is the steer's `commandId`); the run stays open
for that turn. The echo can arrive before the acknowledgement, so either order counts.
With no turn running (startup, or between turns) or when Muse refuses the steer
because its turn just ended, the run holds it (mode `next-turn`) and sends it as the
next `turn/start` of the same MSP session when the current turn ends. Steers the run
never delivered are reported `failed` when it ends, so the app queues them again.
Stop sends `turn/interrupt`, and the run ends at the cancelled `turn/completed`.

**Approval modes.** Approval mode is selected on the wire; sandbox posture is fixed
by process flags, so both are set for each run:

| PandaCode | MSP approval mode | `muse serve` flags |
| --- | --- | --- |
| Standard | `promptUnmatched` | — (sandbox on, network proxy-only) |
| Accept edits | `onRequest` | — |
| Plan mode | `denyUnmatched` | `--disable-write --disable-shell` |
| Full access | `allowAll` | `--disable-sandbox` |

**What Muse cannot express.** Muse's LLM approval judge reviews prompt-bound calls
before they reach PandaCode and approves those it considers safe; `muse serve` has no
flag to turn it off (only `muse exec --approval-judge off`), so Standard and Accept
edits show only the calls the judge escalates and sandbox escalations. Plan mode has
no native equivalent: PandaCode makes the host read-only and prefixes the prompt with
the plan instruction. Muse does not load a workspace's own skills and rules unless the
workspace is trusted in Muse (PandaCode does not pass `--trust-workspace`). Account
usage windows (`usage/read`) are known only inside a running host, so Agent usage
shows Muse as unsupported. Subagent transcripts, goals, workflows, `/compact` and
background tasks are not wired; `muse exec --json` is not used.

**Console.** The harness console runs the Muse TUI (`muse resume <id>`) with
`--approval-mode untrusted|on-request|never`, the same sandbox flags,
`--disable-approval` for Full access, `--model` and `--reasoning-effort`.

Verified against Muse Code 1.4.7 (launcher; the host reported 1.4.12) on 2026-10-22
by driving `muse serve` directly. The recorded frames back the unit tests in
`providers/muse.rs` and `slash_commands/muse.rs`; an ignored test
(`installed_muse_catalog`) reads the real catalog without prompting, and
`PANDACODE_SMOKE_PROVIDER=muse cargo test smoke_provider_from_env -- --ignored` runs
two real turns (start, then resume).

## omp (Oh My Pi)

omp (`omp`, from `@oh-my-pi/pi-coding-agent`, a Bun program) is a fork of Pi and
speaks the same JSONL RPC (`--mode rpc`), so `providers/pi.rs` drives both. The
differences, read from omp 18.12's `modes/rpc/rpc-types.ts` and CLI flag table:

- A run ends with `prompt_result` (`status` completed/aborted/error) once the
  session is settled, or with a later `session_settled` when `sessionSettled` is
  false. Pi's `agent_settled` is never sent.
- Resume uses `--resume <id>` (omp has no `--session-id`); it looks in the task
  folder first and fails rather than prompting when stdin is not a terminal.
- `--approval-mode yolo` turns omp's own approvals off: the same bridge extension
  as Pi enforces PandaCode's modes, and registers app tools as `essential` so
  omp does not hide them behind tool discovery.
- Model discovery skips Pi-only flags (`--offline`, `--no-mcp`, …); slash
  commands come from `get_available_commands`.
- A mid-turn message steers the running turn, exactly as it does for Pi, so a
  recipe step that requires a steer is supported on omp too.

Accounts, models and thinking levels are omp's own. Live check:
`cargo test installed_omp -- --ignored`.

## Secret storage

`src-tauri/src/secret_store.rs` holds every app secret: provider keys
(`app.pandacode.providers`), connection secrets (`app.pandacode.connections`), cloud keys
and settings (`app.pandacode.cloud`) and bot channel tokens (`app.pandacode.bots`).

- **macOS:** one JSON file, `secrets.json` in the app data folder, keyed
  `"<service>/<account>"`, mode 0600, written atomically (0600 temp file in the same folder,
  fsync, rename) under a process lock and a `secrets.lock` advisory lock. Never the Keychain:
  without an Apple Team ID each item is pinned to the build that made it, so every update
  asked for the login password. A corrupt or unreadable file reads as none and is never
  overwritten. An item saved in the Keychain by an older version is found with an
  attributes-only query (no data, no prompt), read once, written to the file and deleted,
  so each item can prompt at most once, ever; a denied read is not retried until the next
  launch. Cloud agent bridge processes get the folder in their run spec. The usage check's
  GLM read uses the file, else the noninteractive helper (`usage_keychain.rs`).
- **Linux:** the Secret Service. **Windows:** Credential Manager. Neither prompts after an
  update.
