# Bot connectors: a registry and one bridge

Bots already talk over local web chat, Telegram, Slack, Discord and WhatsApp. This
document answers the next question: what other connectors are worth having, and how do
we add them without each one touching seven files and needing its own migration.

Two changes carry everything:

1. **A channel-kind registry**, so a connector's metadata and dispatch live in one
   descriptor instead of a `match` in every function.
2. **One generic `bridge` channel**, so any platform we do not implement natively can be
   wired up by an adapter the user already has — including a command-line tool — with no
   Rust code and no new dependency.

Native connectors stay native only where the value comes from being local and
outbound-only. Everything else is a preset on the bridge.

## 0. Status

Shipped in this branch: the registry already landed in #468, the bridge channel is here
(`bots/channels/bridge.rs`, one `KINDS` entry, the token and rotation commands, the
persistent reply queue, `examples/pandacode-bridge.sh`, the setup guide, headless
import/export and the schema half of the migration). Inbound auth reuses the webhook
triggers from #261 rather than adding a second acceptance path.

Still open, in order: Mattermost, then Matrix, as one `KINDS` entry and one module each.

## 1. What exists today

| Channel | Transport | Public URL |
| --- | --- | --- |
| Web chat | Local server on `127.0.0.1:47321`, token in the link fragment | No |
| Telegram | Bot API long polling | No |
| Slack | Socket Mode WebSocket | No |
| Discord | Gateway WebSocket | No |
| WhatsApp | Cloud API webhook + `X-Hub-Signature-256` | Yes, via tunnel |

Four of five need no inbound reachability. That is the property worth protecting: a
connector that cannot be reached from the internet cannot be attacked from it.

## 2. What each connector actually costs

`kind` is dispatched in seven places (`channels/mod.rs` for limit, format check, verify,
required secrets, send and start; `channels/http.rs` for routes; `brief.rs` for etiquette;
`gateway.rs` for the kind lookup), plus `secrets::NAMES`, `headless_bots.rs`, the TS
`ChannelKind` union and the two setup-guide switches in `src/bots-connect.ts`. Adding a
connector today means editing all of them, and `bot_channels.kind` has a five-value
`CHECK` (`src-tauri/src/bots.rs:95`) that a migration would have to rebuild.

That fixed overhead is what makes "just add one more" expensive, not the protocol code.
The connector itself is genuinely small: `telegram.rs` is 106 lines, `slack.rs` 150,
`discord.rs` 155.

## 3. The registry

One table in `src-tauri/src/bots/channels/registry.rs`, keyed by `id`, with static
descriptors holding function pointers. The connector set is compiled in, so trait objects
and downcasting buy nothing.

```rust
pub(crate) struct ChannelKind {
    pub id: &'static str,
    pub label: &'static str,
    pub max_message_len: usize,
    pub required_secrets: &'static [&'static str],
    pub validate_input: ValidateFn,
    pub verify: VerifyFn,
    pub run: Option<RunFn>,            // loop connectors only
    pub send: SendFn,
    pub http_route: Option<HttpRouteFn>,
    pub pairing_thread: PairingThread, // SenderId | Prefix("dm:")
    pub brief_etiquette: &'static str,
    pub init: Option<InitFn>,          // e.g. mint a web or bridge token
}
```

The seven duplicate sites become lookups; `chunks()` stays shared. What stays
connector-specific, correctly, is protocol behaviour: WhatsApp's signature check and
payload parsing, the web page and its DB-held token, Slack's two-token swap detection,
Discord's invite. Those are exposed through hooks, not generalised away.

`bot_channels.kind` loses its `CHECK` in a migration. `upgrade()` currently only adds
columns, so this is the first table rebuild in the bots path — a create-copy-drop-rename
that preserves rows. Alternatively the constraint is widened to include the new kinds,
but that repeats the migration for every future connector, which defeats the point.

The TS side keeps a descriptor map keyed by the same ids. Rust is the authority for ids,
labels, limits and required secrets (so desktop, `serve` and the CLI agree); TS owns the
setup prose and the custom render hooks for Slack's manifest and WhatsApp's callback URL.
A `bot_channel_kinds` command exposes the metadata.

## 4. The bridge

One channel kind, `bridge`, covers every platform we do not implement natively. It is the
answer to "can we use a command-line tool that is already installed".

**Inbound** — `POST /api/bridge/<channelId>/messages` on the existing loopback server,
`Authorization: Bearer <token>`, a stable `eventId` for dedupe (unique
`(channel_id, event_id)`, kept 7 days), 128 KiB body cap, 30 requests per minute per
channel. It calls the existing `handle_inbound`, so pairing and allowlists apply
unchanged and `trusted` is never set.

```json
{ "eventId": "mm:post:abc123", "senderId": "mm:team-7:user-42",
  "senderName": "Ada", "thread": "mm:chan-9:root-55", "text": "What changed?" }
```

**Outbound** — `GET /api/bridge/<channelId>/events?after=<cursor>` long-polls for
replies, served from a bounded SQLite queue (1,000 events, 7 days) so an adapter survives
a restart. Replacement for the web channel's in-memory outbox, which is fine for a page
in a tab and wrong for a daemon. Pull only: pushing to a user-supplied `outboundUrl` would
be SSRF with extra steps.

**The helper** — `examples/pandacode-bridge.sh`, plain `curl` + `jq`, reading
`PANDACODE_BRIDGE_URL`, `..._CHANNEL`, `..._TOKEN` and `..._CURSOR`. Three subcommands:
`send --json`, `receive`, `listen`. PandaCode learns no new protocol and gains no
dependency.

**Presets, zero new Rust:** Mattermost (outgoing webhook → `send`; `listen` → bot API),
Signal (`signal-cli daemon --receive` | `jq` | `send`), Matrix (`matrix-client sync`
long-poll both ways), ntfy (publish/subscribe via `curl`), Zulip, Gotify, Google Chat,
Teams, email, IRC, XMPP, LINE, Zalo, Twilio SMS — each is a different `jq` filter and a
different reply call in the adapter.

**Trust boundary.** The token authenticates the *adapter*, not the person in the body. A
holder can assert an already-approved `senderId`. So: namespaced stable ids, one bridge
channel per trust boundary, token rotation on the `bot_web_new_link` pattern, and
audit logging of accepted messages and rotations.

## 5. What to add, and in what order

| # | Connector | Form | Cost | Why |
| --- | --- | --- | --- | --- |
| 1 | **Bridge + registry** | native plumbing | medium | Unlocks everything below; the actual ask |
| 2 | **Mattermost** | native | medium | Self-hosted, outbound WebSocket, bot tokens; *your* question |
| 3 | **Matrix** | native | medium | Open and self-hostable, outbound sync, wide client choice |
| 4 | **Signal / iMessage** | bridge only | tiny | No bot API; `signal-cli` and a local Mac helper are the way in |
| 5 | ntfy, Gotify | bridge preset | tiny | Outbound push, trivial HTTP |
| 6 | Google Chat, Teams | bridge preset | small | Webhook-shaped; their auth stays in the adapter |
| 7 | Email (IMAP+SMTP) | native later | medium | Needs a new mail dependency; revisit after the bridge ships |

Mattermost and Matrix are the two worth native code because both are commonly
self-hosted, both work outbound-only, and both are asked for by exactly the user this
product targets. `tokio-tungstenite` (0.28) and `reqwest` are already dependencies, so
Mattermost's WebSocket and Matrix's sync loop need no new crates.

Deliberately skipped: Zalo, DingTalk, WeCom, LINE, Feishu — vendor-specific auth and
regionally narrow; Nostr — key-management UX that does not fit; RSS inbound — cheap but a
different feature (watching, not talking).

## 6. Rollout

1. Registry, schema migration, `bot_channel_kinds`. No behaviour change; existing tests
   should pass with the dispatch sites swapped for lookups.
2. Bridge channel, bridge routes, persistent queue, helper script, setup guide, headless
   import/export (`secrets: {"token": "env:PANDACODE_BRIDGE_TOKEN"}`), rotation.
3. Mattermost, then Matrix, each as one descriptor plus one module.
4. Docs: this file, `docs/bots.md` Connections table, README privacy table for new
   outbound traffic, `docs/headless.md`.

## Testing

- Registry: unique ids, complete metadata for every kind, lookup and dispatch.
- Bridge: bearer rejection, replay/duplicate `200`, oversized `413`, remote-off `403`,
  pairing still applies, queue resume across a restart, cursor `truncated`.
- Migration: an old database with existing channels keeps them and accepts a new kind.
- Preview/Playwright: the new setup guide and the bridge copy/rotate actions.
