# Bots: always-on agents on your own computer

A **bot** is a named, persistent agent that lives in PandaCode and keeps working when you are away. You talk to it from the desktop app, a local web page, Telegram, Slack, Discord or WhatsApp. It remembers what matters, runs on schedules, acts through the same harnesses, browser, terminal and tools PandaCode already has, and asks before anything risky.

It combines the ideas behind xAI's Grok Bot, Meta's Muse and OpenAI's Dots, with one deliberate difference: **the bot runs on the user's own computer, not on a vendor's cloud machine.** Files, browser sessions, credentials and memory stay local.

## What each product contributes

| Idea | From | PandaCode form |
| --- | --- | --- |
| Named bots with a job (research, triage, chief of staff), several bots | Grok Bot | `bots` table: name, role, instructions, avatar, harness and model per bot. |
| A persistent computer: browser, terminal, files that carry over | Grok Bot, Muse, Dots | The user's machine through PandaCode's harnesses, browser and terminals, in a per-bot workspace folder. |
| Schedules and triggers | Grok Bot, Dots | `bot_schedules`: every N minutes, daily at a time, weekdays, with a prompt. Runs survive restarts. |
| Standing goals and proactive check-ins | Dots, Muse | Per-bot goals plus an optional heartbeat that reviews them read-only and reports or proposes. |
| Memory that learns from conversations and feedback | Dots, Muse | `bot_memories`, written by the bot (`bot_remember`) or the user; shown, edited and deleted in the app. |
| Messaging-first interface, including WhatsApp | Muse, Dots | Channels: web UI, Telegram, Slack, Discord, WhatsApp Cloud API. One conversation per chat thread. |
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
- **The bot brief** (identity, role, instructions, goals, memories, channel etiquette) is sent as a folded context block at the start of each conversation, and again when memories change.
- **Replies** are captured when a bot task's run finishes and sent back to the thread it came from. Long replies are split per channel limits.
- **Bot tools** (MCP host, scoped to the bot): `bot_remember`, `bot_forget`, `bot_recall`, `bot_schedule`, `bot_list_schedules`, `bot_cancel_schedule`, `bot_notify`. They are registered only in a bot's own tasks and act only on that bot, so they never ask for approval (`bots::tools::self_scoped`, honored by the Claude permission bridge; Codex hosts leave them out of `approval_tools`).
- **The sidebar's Bots section** lists every bot with its status. A row opens the bot's conversation (created on first use by `bot_desktop_thread`) in the main workspace exactly like a task: the same transcript, streaming, approvals, queue and composer, including the model picker, so you can switch harness or model for that conversation. The header names the bot with its state, a pause button and Settings. Prompts typed there go through the gateway like any channel, so the brief, memories and `/stop` apply. Plus adds a bot, which then opens in its conversation. Bot workspaces are kept out of the project tree and project pickers.
- **Settings** open as a modal from the header, the sidebar's gear, or the setup buttons on an empty conversation: Profile (name, instructions, goals, default harness and model, permissions, check-ins), Conversations (this app, channel threads and scheduled work, each opening as a task), Memory, Schedules, Channels, Rules and Activity, with pause, reset and delete. The Bots window shows the same settings beside a list of every bot.

## Safety model

A bot can run commands on the user's computer and can be messaged from outside it, so remote input is untrusted by default.

1. **Pairing.** A channel only accepts messages from paired senders. An unknown sender gets a one-time code; the user approves it in the app. Web UI access needs a per-bot token.
2. **Permission mode.** Bots default to approvals for edits and commands. Full access is an explicit per-bot choice.
3. **Guard.** Approval requests are decided by the bot's rules (deny wins, then the always-ask list, then allow); anything else is asked. The Guard sees what the harness asks about, so a bot set to Full access is not gated by it. That is why bots default to Ask.
4. **Approvals in context.** A pending approval is sent to the channel that started the run; `yes`, `no` or `always` answers it. The desktop app shows every pending approval.
5. **Kill switch.** `/stop` in a paired channel or Pause in the app stops the bot's running work and its schedules.
6. **Audit.** Every decision is logged in `bot_activity`.

## Channels

All connections are outbound or local, so nothing is exposed unless you choose to. Third-party tokens (Telegram, Slack, Discord, WhatsApp) are saved in PandaCode's secrets store (`app.pandacode.bots`, one account per channel and secret: a 0600 `secrets.json` on macOS, the Secret Service on Linux, Credential Manager on Windows; see [secret storage](providers.md#secret-storage)) and are never sent to the webview or the agent; the channel row records only which names were saved, so listing channels never reads a secret. The web chat link's token is PandaCode's own and guards a page on this computer only, so it lives in the database next to the conversations it protects: a keychain access prompt after an update (ad-hoc builds change signature) would otherwise break every open link. **New link** replaces it and revokes old links.

Adding a channel is a guided flow (`src/bots-connect.ts`): numbered steps with buttons that open the exact page, copy buttons for every command and value, a **Test** button, and **Connect**, which checks the credentials with the service before saving (`channels::verify`). Common mistakes are caught before any request (`channels::check_format`): a truncated Telegram token, swapped Slack tokens, a Discord client secret pasted as the token, a WhatsApp phone number instead of its ID. Once connected, each channel shows what to do next.

| Channel | How it connects | What the guide does for you |
| --- | --- | --- |
| Web chat | Local server on `127.0.0.1:47321` (next free port if taken); the link carries its token in the fragment. | One click. **Use from my phone** allows other host names (a tunnel or `tailscale serve --bg 47321`); paste the https address and **Copy link for my phone** builds the link. Requests still need the token. |
| Telegram | Bot API long polling; a webhook set elsewhere is removed when it connects. | Opens BotFather, copies `/newbot` and a username idea, checks the token (`getMe`), then offers **Open @bot in Telegram**. |
| Slack | Socket Mode WebSocket. | **Create Slack app** opens Slack with a manifest that already has the scopes (`app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`), events (`app_mention`, `message.im`) and Socket Mode. You install it and paste the `xoxb-` and `xapp-` tokens; Test checks both (`auth.test`, `apps.connections.open`). |
| Discord | Gateway WebSocket. | Opens the Developer Portal, checks the token, generates the **Add to a server** invite with the right permissions, and warns when the Message Content intent is off. |
| WhatsApp | Cloud API webhook at `/whatsapp/<channel id>`, checked with `X-Hub-Signature-256` and the app secret. | Checks the phone number ID and token against the Graph API, then walks through the tunnel (`cloudflared tunnel --url http://127.0.0.1:47321` or `tailscale funnel --bg 47321`), builds the callback URL from the address you paste, and shows the generated verify token (kept in the channel settings: it only proves the webhook is ours) with copy buttons. The status turns to "Webhook verified" when Meta checks it. |

Unknown senders get a four-digit pairing code and wait until approved in **Bots → Channels**. Web chat holders are the owner and skip pairing. Commands in any channel: `/stop`, `/new`, `/help`; `yes`, `no` and `always` answer a pending approval.

## Where things live

| Area | Files |
| --- | --- |
| Data, commands, hooks | `src-tauri/src/bots.rs` (schema 25), `bots/brief.rs`, `bots/gateway.rs`, `bots/guard.rs`, `bots/schedule.rs`, `bots/secrets.rs`, `bots/tools.rs` |
| Channels | `src-tauri/src/bots/channels/{mod,http,web,telegram,slack,discord,whatsapp}.rs` |
| Hooks in `lib.rs` | `bots::start` at setup, `bots::approval_requested` in the event sink, `bots::run_finished` after `done`, `bots::tools::with_bot` in the tool host chain |
| UI | `src/bots.ts`, `src/bots-panels.ts`, `src/bots.css`, preview mock `src/preview-bots.ts`, tests `tests/bots.spec.ts` |

Bot tasks deliver their queued messages natively when a run ends, so the window skips `dispatchQueue` for bot projects. Bots run while PandaCode is running. Quitting stops their work; a schedule that came due while the app was closed runs once at the next start, and its missed repeats are skipped.

## Testing

- `cargo test --lib bots::tests::live_services_reject_fake_credentials_clearly -- --ignored --nocapture` sends made-up credentials to the real Telegram, Slack, Discord and Graph APIs and checks each rejection is a clear message (no account needed).
- `cargo test --lib bots::` covers storage, memory, schedules, rules, pairing, the brief, channel parsers, signatures and the HTTP parser.
- `tests/bots.spec.ts` covers the Bots window against the preview mock; `tests/bots-web.spec.ts` runs the real served chat page (extracted from `web.rs`) against a scripted API, in Chrome and WebKit.
- A live run against the native app was done with an isolated identifier (`npx tauri dev --config '{"identifier":"ai.pandacode.botsmoke","build":{"beforeDevCommand":""}}'` and a seeded bot with a web channel): a real Claude turn, the brief, memory via the bot tool, approval from the page, Always allow creating a rule that then auto-approves, the native queue, a self-scheduled run reporting back, `/help`, `/new`, `/stop` and pause. Never point a dev build at the default identifier: it would migrate your real database.

## Not yet built

- A separate model-based reviewer for outbound actions (the Guard is rule-based).
- Connectors beyond chat (email, calendar); bots use the harness's own MCP servers for those today.
- Media messages (images, voice) on chat channels; text only for now.
