# Bots: always-on agents on your own computer

A **bot** is a named, persistent agent that lives in PandaCode and keeps working when you are away. You talk to it from the desktop app, a local web page, Telegram, Slack, Discord or WhatsApp. It remembers what matters, runs on schedules, acts through the same harnesses, browser, terminal and tools PandaCode already has, and asks before anything risky.

The **New bot** form keeps unsaved input through background updates, validation errors and failed creation attempts. Picking a suggestion fills it in; New bot starts a fresh draft.

It combines the ideas behind xAI's Grok Bot, Meta's Muse and OpenAI's Dots, with one deliberate difference: **the bot runs on the user's own computer, not on a vendor's cloud machine.** Files, browser sessions, credentials and memory stay local.

## What each product contributes

| Idea | From | PandaCode form |
| --- | --- | --- |
| Named bots with a job (research, triage, chief of staff), several bots | Grok Bot | `bots` table: name, role, instructions, goals, an optional soul (personality), avatar, harness and model per bot. |
| A persistent computer: browser, terminal, files that carry over | Grok Bot, Muse, Dots | The user's machine through PandaCode's harnesses, browser and terminals, in a per-bot workspace folder. |
| Schedules and triggers | Grok Bot, Dots | `bot_schedules`: every N minutes, daily at a time, weekdays, with a prompt. Runs survive restarts. |
| Standing goals and proactive check-ins | Dots, Muse | Per-bot goals plus an optional heartbeat that reviews them read-only and reports or proposes. |
| Memory that learns from conversations and feedback | Dots, Muse | `bot_memories`, written by the bot (`bot_remember`) or the user; shown, edited and deleted in the app. |
| Messaging-first interface, including WhatsApp | Muse, Dots | Connections: web UI, Telegram, Slack, Discord, WhatsApp Cloud API. One conversation per chat thread. |
| Allow once / Deny / Always allow; auto-review rules | Grok Bot, Dots | Approval rules per bot (tool and command patterns), approvals answerable in the app or by replying in the channel. |
| A second check on anything risky | Muse (Sentinel) | **Guard**: every approval request is matched against the bot's rules; a fixed list of risky actions (sudo, force push, `rm -rf`, piping downloads to a shell, passwords, money transfers) always asks, even under a broad allow rule. |
| Complete audit trail and Activity View | Muse, Dots | `bot_activity`: inbound messages, replies, notifications, approvals and rule decisions, memory changes, schedule runs, channel and pairing changes, errors. |
| Monitoring that pauses suspicious work; kill switch | Dots | Pause a bot or all bots from the app or with `/stop` in any paired channel. |
| A credential store the agent cannot see | Muse | Channel tokens live in PandaCode's secrets store and never enter prompts. |
| Reset deletes conversations, memories and schedules together | Dots | **Reset bot**. |

Out of scope: vendor cloud VMs, one-time card numbers and payment rails, health and smart-home connectors, voice calls.

## Architecture

```
 channels ──► gateway ──► bot router ──► PandaCode task (harness run) ──► reply ──► gateway ──► channel
 (web, Telegram,   pairing,      per-thread        existing providers, tools,        captured at the
  Slack, Discord,  allowlists,   conversation      approvals, queue, steering        native "done" hook
  WhatsApp)        approvals
                         ▲
 scheduler ──────────────┘  (due schedules and heartbeats start runs the same way)
```

- **Conversations are ordinary PandaCode tasks** in the bot's workspace project, so streaming, approvals, the queue, steering, usage limits and history all work unchanged. `bot_threads` maps `(bot, channel, external thread)` to a task.
- **The bot brief** (identity, role, instructions, goals, personality, memories, channel etiquette) is sent as a folded context block at the start of each conversation, again when the profile or memories change, and again after the conversation switches harness (the history replay to the new harness can drop or shorten the old message that carried it). A turn that fails to start does not count as briefed.
- **Profile fields** keep who the bot is apart from what it does: **Name** (Leo), **Role** (Chief of staff), **Goals** (Make sure I don't miss a ship date), **Instructions** (duties, workflows, escalation thresholds, report formats) and an optional **Soul**: Markdown for tone, values and conversational style. **Import soul.md…** copies the file's text into the bot once (UTF-8, at most 64 KB; anything else is refused with an error), so editing, moving or deleting the file later never changes the bot; edit or **Remove** it in Profile. It is stored in `bots.soul` (schema 28) and appears in the brief as a labelled "Personality" section that states it never grants tools, permissions, credentials or authority. A bot without a soul gets the same brief as before.
- **Skills and MCP servers** (Settings → Skills, schema 29): a bot references library skills by id (`bots.skills`) and MCP servers by name (`bots.mcp`), never copies or credentials. In the bot's own conversations the skills are turned on through the skills adapter at project scope in the bot's workspace for that conversation's harness (`skills::scoped::sync_project`; never user scope), or ride in the brief for harnesses without a skill folder; skills with unreviewed safety findings are left out and logged. MCP servers are not passed per run: PandaCode only injects its own server, so a chosen server works when the bot's harness already has it in its own config (the panel shows "From …") and shows **Unsupported for this bot's harness** otherwise. The brief names the chosen servers.
- **Project tasks with a bot**: the context bar of a New task in an ordinary project has a Bot chip (`botTaskControl` in `main.ts`; No bot by default). Choosing a bot links the task (`bot_tasks`, `bot_assign_task`) and applies the bot's harness and model; the task keeps its own project and checkout. Its first message (and the next one after the bot changes) carries the bot's brief from `bot_task_brief`, with skills resolved as the bot's plus the project's activations, deduplicated by id (`skills::scoped::resolve`, provenance bot/project/both). Bot skills ride in that task's brief and are never written into the checkout, so tasks sharing a checkout stay isolated. Bot tools, channels and the Guard apply only to the bot's own conversations.
- **Replies** are captured when a bot task's run finishes and sent back to the thread it came from. Long replies are split per channel limits.
- **Bot tools** (MCP host, scoped to the bot): `bot_remember`, `bot_forget`, `bot_recall`, `bot_schedule`, `bot_list_schedules`, `bot_cancel_schedule`, `bot_notify` and `bot_message_bot`. They are registered only in a bot's own tasks and act only on that bot, so they never ask for approval (`bots::tools::self_scoped`, honored by the Claude permission bridge; Codex hosts leave them out of `approval_tools`). `bot_message_bot` sends work to another bot's desktop task and brings its update back to the sender's thread. It rejects self-messages and caps a collaboration chain at three hops. Tool messages appear as folded, expandable markers with Queued, In progress, Completed or Failed status.
- **The sidebar's Bots view** groups bots under Needs you, Pinned, Bots and Hidden, with badges for approvals, questions, work, usage limits, unread replies and completed runs. The plus menu offers New bot and New channel. New bot opens a starter-aware form and then the bot's conversation. A Channels group lists shared bot channels; deleted channels stay under Deleted channels for restore.
- **Bot conversations** are ordinary tasks in each bot's workspace (`bot_desktop_thread` creates the desktop conversation on first use), with the normal transcript, streaming, approvals, queue, composer and model picker. The header has the bot's state, pause and Settings. Prompts typed there go through the gateway like any channel, so the brief, memories and `/stop` apply. A limit or provider error can hold work for an alternate model; Ask-first failover stays above the composer and offers Wait for the reset only when the reset time is known (otherwise Dismiss, and the message is retried by hand); each model switch appears in the transcript. The sidebar preview leaves out the folded bot brief.
- **Settings** open from the header, sidebar gear or empty-conversation setup. Tabs are Profile, Connections, Schedules, Memory, Skills and Activity (Conversations and Rules are sections of Activity), with pause, reset and delete. Profile holds name, title, instructions, soul (an optional personality, typed or imported once from a soul.md), harness/model under Brain, the permission mode under Rules and check-ins; Skills picks library skills and MCP servers by reference; Connections configures per-bot web, Telegram, Slack, Discord and WhatsApp access. The Bots window uses the same settings beside the bot list. Bot workspaces stay out of the project tree and project pickers.
- **Shared bot channels** (for example `#launch`) are group conversations, separate from each bot's external Connections. A channel stores an ordered member list; its first member is lead. A post with no `@mention` goes to the lead; explicit mentions route to at most two bots in parallel. Each bot works in its own desktop task, and replies return to the channel with the author's avatar and color. Users can stop all active members, continue a stopped post or reassign it. Channel name, members and lead are editable in the header; archived channels are preview-only. `bot_shared_channels`, its member/message/delivery tables and `bot_messages` are created by the idempotent `bots::upgrade()` path, so this bot-only addition does not bump the app-wide storage schema version.

## Safety model

A bot can run commands on the user's computer and can be messaged from outside it, so remote input is untrusted by default.

1. **Pairing.** A channel only accepts messages from paired senders. An unknown sender gets a one-time code; the user approves it in the app. Web UI access needs a per-bot token.
2. **Permission mode.** Bots default to approvals for edits and commands. Full access is an explicit per-bot choice.
3. **Guard.** Approval requests are decided by the bot's rules (deny wins, then the always-ask list, then allow); anything else is asked. The Guard sees what the harness asks about, so a bot set to Full access is not gated by it. That is why bots default to Ask.
4. **Approvals in context.** A pending approval is sent to the channel that started the run; `yes`, `no` or `always` answers it. The desktop app shows every pending approval.
5. **Kill switch.** `/stop` in a paired channel or Pause in the app stops the bot's running work and its schedules.
6. **Audit.** Every decision is logged in `bot_activity`.

## Connections

All connections are outbound or local, so nothing is exposed unless you choose to. Third-party tokens (Telegram, Slack, Discord, WhatsApp) are saved in PandaCode's secrets store (`app.pandacode.bots`, one account per channel and secret: a 0600 `secrets.json` on macOS, the Secret Service on Linux, Credential Manager on Windows; see [secret storage](providers.md#secret-storage)) and are never sent to the webview or the agent; the channel row records only which names were saved, so listing channels never reads a secret. The web chat link's token is PandaCode's own and guards a page on this computer only, so it lives in the database next to the conversations it protects: a keychain access prompt after an update (ad-hoc builds change signature) would otherwise break every open link. **New link** replaces it and revokes old links.

Adding a channel is a guided flow (`src/bots-connect.ts`): numbered steps with buttons that open the exact page, copy buttons for every command and value, a **Test** button, and **Connect**, which checks the credentials with the service before saving (`channels::verify`). Common mistakes are caught before any request (`channels::check_format`): a truncated Telegram token, swapped Slack tokens, a Discord client secret pasted as the token, a WhatsApp phone number instead of its ID. Once connected, each channel shows what to do next.

| Channel | How it connects | What the guide does for you |
| --- | --- | --- |
| Web chat | Local server on `127.0.0.1:47321` (next free port if taken); the link carries its token in the fragment. | One click. **Use from my phone** allows other host names (a tunnel or `tailscale serve --bg 47321`); paste the https address and **Copy link for my phone** builds the link. Requests still need the token. |
| Telegram | Bot API long polling; a webhook set elsewhere is removed when it connects. | Opens BotFather, copies `/newbot` and a username idea, checks the token (`getMe`), then offers **Open @bot in Telegram**. |
| Slack | Socket Mode WebSocket. | **Create Slack app** opens Slack with a manifest that already has the scopes (`app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`), events (`app_mention`, `message.im`) and Socket Mode. You install it and paste the `xoxb-` and `xapp-` tokens; Test checks both (`auth.test`, `apps.connections.open`). |
| Discord | Gateway WebSocket. | Opens the Developer Portal, checks the token, generates the **Add to a server** invite with the right permissions, and warns when the Message Content intent is off. |
| WhatsApp | Cloud API webhook at `/whatsapp/<channel id>`, checked with `X-Hub-Signature-256` and the app secret. | Checks the phone number ID and token against the Graph API, then walks through the tunnel (`cloudflared tunnel --url http://127.0.0.1:47321` or `tailscale funnel --bg 47321`), builds the callback URL from the address you paste, and shows the generated verify token (kept in the channel settings: it only proves the webhook is ours) with copy buttons. The status turns to "Webhook verified" when Meta checks it. |

Unknown senders get a four-digit pairing code and wait until approved in **Bots → Connections**. Web chat holders are the owner and skip pairing. Commands in any connection: `/stop`, `/new`, `/help`; `yes`, `no` and `always` answer a pending approval.

## Shared bot channels

Shared channels are local group conversations between bots, such as `#launch`; they do not connect to a third-party chat service. Create one from the Bots sidebar's plus menu, choose its members, and set a lead in channel settings. The first member is the default lead. A user post goes to that lead unless it names one or two channel members with `@mentions`. Assigned work runs in each bot's existing desktop conversation, so its ordinary task, approvals and history remain available. Each assignment carries the channel's latest eight other posts and replies (each cut to 600 characters), so a bot can build on what the user and other members said. Replies appear in the channel as authored rows. The channel composer sends on Enter. Stop (labeled with the bots it stops) halts every active member task and cancels assignments still waiting in a bot's queue. Every assignment and bot-to-bot message starts queued and is marked in progress in the same step that launches its turn or takes it from the queue, so a finished run is credited only to the request it ran (the gateway records each launched request per task and the run's end settles exactly that one), and a Stop that lands before its turn starts still stops that turn. A turn that fails to launch puts its request back to queued with its queue entry, so Stop still finds it. A Stop, archive or member removal that lands while a post is being handed over stops what the hand-over queued or started. At startup, interrupted assignments and assignments whose queue entry was already taken become failed, and their posts can be continued. Continue or Reassign can restart a stopped or failed post; the retry is a new attempt, the old one stays in the history, and the retry's result replaces the stop or failure. An assignment whose run moves to a backup model, or is held until a usage limit resets, stays in progress until that work ends; dismissing a hold that nothing will resume (a provider error, or a limit without a reset time) settles it as failed, so it can be continued. Stopping a held assignment drops its hold card and any wait for the reset, so a stale Send cannot run it. Resetting or deleting a bot settles its unfinished posts as stopped, so they can be continued with another member. Removing a member stops its pending work in that channel, and deleting a channel marks it deleted first (so no new post is admitted) and then stops all of its pending work; the records stay. Deleting a channel archives it under Deleted channels; archived channels show their history but do not accept posts or settings changes until restored. The channel loads its latest 100 history rows; Show earlier messages loads 100 more and keeps the reading position.

Bot-to-bot work is available through the `bot_message_bot(to, text)` tool in a bot's own task. It delivers to the target bot's desktop conversation, queues behind existing work, records a marker in both conversations and posts the target's result back to the sender as `Update from <bot>`. Consecutive markers fold together and expand to show their text and status. Self-messages are rejected, and nested collaboration is capped at three hops.

## Where things live

| Area | Files |
| --- | --- |
| Data, commands, hooks | `src-tauri/src/bots.rs` (schema 25; `bots.soul` in 28; `bots.skills`, `bots.mcp`, `bot_tasks` in 29; later bot columns and shared-channel tables via `bots::upgrade()`), `src-tauri/src/skills/scoped.rs`, `bots/brief.rs`, `bots/gateway.rs`, `bots/guard.rs`, `bots/schedule.rs`, `bots/secrets.rs`, `bots/tools.rs`, `bots/shared_channels.rs`, `bots/failover.rs` |
| Channels | `src-tauri/src/bots/channels/{mod,http,web,telegram,slack,discord,whatsapp}.rs` |
| Hooks in `lib.rs` | `bots::start` at setup, `bots::approval_requested` in the event sink, `bots::run_finished` after `done`, `bots::tools::with_bot` in the tool host chain |
| UI | `src/bots.ts`, `src/bots-panels.ts`, `src/bots.css`, `src/sidebar-bots.ts`, `src/bot-thread.ts`, `src/bot-shared-channels.ts`, preview mock `src/preview-bots.ts`, tests `tests/bots*.spec.ts` |

Bot tasks deliver their queued messages natively when a run ends, so the window skips `dispatchQueue` for bot projects. Bots run while PandaCode is running. Quitting stops their work; a schedule that came due while the app was closed runs once at the next start, and its missed repeats are skipped.

## Testing

- `cargo test --lib bots::tests::live_services_reject_fake_credentials_clearly -- --ignored --nocapture` sends made-up credentials to the real Telegram, Slack, Discord and Graph APIs and checks each rejection is a clear message (no account needed).
- `cargo test --lib bots::` covers storage, memory, schedules, rules, pairing, the brief, channel parsers, signatures and the HTTP parser.
- `tests/bots*.spec.ts` covers bot creation, sidebar states, conversations, failover, shared channels and agent messaging against the preview mock; `tests/bots-web.spec.ts` runs the real served chat page (extracted from `web.rs`) against a scripted API, in Chrome and WebKit.
- A live run against the native app was done with an isolated identifier (`npx tauri dev --config '{"identifier":"ai.pandacode.botsmoke","build":{"beforeDevCommand":""}}'` and a seeded bot with a web channel): a real Claude turn, the brief, memory via the bot tool, approval from the page, Always allow creating a rule that then auto-approves, the native queue, a self-scheduled run reporting back, `/help`, `/new`, `/stop` and pause. Never point a dev build at the default identifier: it would migrate your real database.

## Not yet built

- A separate model-based reviewer for outbound actions (the Guard is rule-based).
- Connectors beyond chat (email, calendar); bots use the harness's own MCP servers for those today.
- Media messages (images, voice) on chat channels; text only for now.
