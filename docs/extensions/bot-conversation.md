# Bot thread header, shared channel conversation controls and the bot web chat projection v1 (experimental)

## Decision

Before v1 a bot's conversation (`src/bot-thread.ts`: the header's Pause and settings buttons, the welcome's suggestions
and setup shortcuts) and a shared channel's conversation controls (`src/bot-shared-channels.ts`: Stop, Continue,
Reassign, Show earlier messages and the channel settings button) had no extension hook, and the shared bot web chat had
no declared extension policy. v1 makes both views extensible without moving a handler out of `src/main.ts`, owned by
`src/extensions/bot-conversation-core.ts` (registry `BOT_CONVERSATION_REGISTRY`, admission) and
`src/extensions/bot-conversation-host.ts` (slots, layout, captured actions):

- `panda.bot.thread.actions`: an action slot right after the header breadcrumb of a bot thread. Contributed actions
  capture `selection.kind = "bot"` (`ids = [<the bot>]`) with the bot's project as `projectId`, its conversation as
  `sessionId` and the revision, at click time;
- `panda.bot.channel.actions`: an action slot right after the header breadcrumb of a shared channel, capturing
  `selection.kind = "channel"` (`ids = [<the channel>]`);
- `panda.bot.thread.controls`: Pause and the bot settings button swap places; the settings button, the welcome
  suggestions and the welcome setup shortcuts hide (the bot's name in the header still opens settings);
- `panda.bot.channel.controls`: Continue and Reassign (the toggle with its bot menu) swap places; Reassign and the
  channel settings button hide (the channel row menu still opens settings);
- `panda.bot.conversation.protected`, inspect-only, with a reason for each: the bot name button, Stop, pausing,
  settings changes, credentials and pairing, messages and drafts, and the bot web chat projection;
- the `botConversationPresentation` / `botConversationAction` contract for captured actions. The existing selection
  kinds `bot` and `channel` are reused; no new one is added.

A slot exists only while an enabled package contributes to it, and the arrangement reaches `crumbHtml`, `welcomeHtml`,
`sharedChannelThreadHtml` and `sharedChannelActionsHtml` only while the user (or a selected layout proposal) changed
it. With zero extensions, and in safe mode, the header, the welcome and the channel controls draw exactly as before:
same nodes, roles, order and handlers.

## Order and visibility

| Location | Control | Operations | Why |
| --- | --- | --- | --- |
| `panda.bot.thread.controls` | `pause` | reorder | Pause holds the bot's schedules, check-ins and messages; it never hides. |
| | `settings` | hide, show, reorder | The bot's name opens the same page. |
| | `suggestions`, `setup` | hide, show | The welcome groups keep their place. |
| `panda.bot.channel.controls` | `stop` | inspect | Stop ends live work; it never hides and stays first. |
| | `continue` | reorder | A stopped or failed message runs again through it; it never hides. |
| | `reassign` | hide, show, reorder | The toggle and its bot menu move together. |
| | `earlier` | inspect | The only way to older channel history. |
| | `settings` | hide, show | Hides in place in the channel header. |

A hidden control keeps its node, inert and out of view. A forged overlay that hides a pinned control is ignored.

## Captured actions

The owner is the selected `panda.transcript` provider (the existing timeline recipe); no new recipe exists. The
presentation carries opaque `bot`, `session` and `channel` handles, the open `view` (`none`, `bot-thread` or `channel`),
a `revision` that follows the bot's paused state, the channel's messages and work and every control, and up to 128
controls:

| Control id | Runs | Fresh host choice |
| --- | --- | --- |
| `bot-pause` | Pause or resume (`setBotPaused`) | yes |
| `bot-settings` | The settings button or a welcome setup shortcut (`showBotSettings`) | yes |
| `bot-suggest` | A welcome suggestion into the draft | yes |
| `channel-earlier` | Show earlier messages | no |
| `channel-continue` | Continue a stopped or failed message | yes |
| `channel-reassign-open` | Open the Reassign menu | no |
| `channel-reassign` | Reassign the stopped message to one member | yes |
| `channel-settings` | Open channel settings | yes |

The fresh host choice ("Extension requested a bot conversation action") is bound to the same view, bot, conversation
or channel and target; Escape declines and nothing runs; Continue runs the original handler exactly once. Another bot,
conversation or channel, a paused bot or a refreshed channel answers `StaleContext`; an open dialog, menu or host choice
answers `Busy`. `bot-stop`, `channel-stop`, `bot-delete`, `bot-credentials`, `bot-settings-save`,
`channel-settings-save`, `channel-membership`, `channel-delete`, `message-send` and `draft-write` are refused with
`PermissionDenied` before anything else is read. No bot or channel name, message text, draft, reply, setting, token or
pairing code crosses the contract.

## Bot web chat projection

The shared bot web chat (Bots → Channels → Web chat) is a fixed page this computer serves to whoever holds the channel's
link (`src-tauri/src/bots/channels/web.rs`); the link's token and its revocation are its whole authority. Its payload is
built by `bots::web_projection` in `src-tauri/src/bots.rs` from the bot's public face and the thread's user and assistant
text only. The policy:

- **Projected: nothing.** No contributed action, menu, command, component, layout, view, dialog, status item or rich
  view, and no desktop HTML, ever reaches the page. Package UI needs the desktop host's trust, grants, captured context
  and isolated rich-view frames, none of which a web visitor has; rendering package text there would also show the
  visitor contributions the owner enabled for themself. The page renders conversation text with its own escaped
  Markdown renderer, as before.
- **Reported.** `GET /api/chat/<channel>/history` carries
  `extensions: { apiVersion: 1, projected: [], state: "none" | "withheld", reason? }`. `state` is `withheld` while any
  package is enabled on this computer, with the stable reason
  `UnsupportedCapability: the bot web chat is a text-only projection. Extension actions, contributions and desktop HTML stay in the PandaCode desktop app.`
  (`BOT_WEB_WITHHELD` in `src-tauri/src/extensions/projections.rs`); with no enabled package, in safe mode or after
  disabling, it is `none`. It is recomputed per request from the host's own registry, like extension placement, and
  authorizes nothing. Older pages ignore the field.
- **Negotiation.** The page cannot ask for more: there is no request field, version or grant that adds a projection.
  A future projection would be a new `apiVersion` with its own review.

The native test `bot_web_projection_never_forwards_package_actions_contributions_or_desktop_html` installs and enables a
contributing package and a rich-view package and proves the projected chat equals the zero-extension chat except for the
withheld report, contains no package, contribution, command, view or HTML text, no tool or system rows and no token.

## Recovery

Two packages contribute side by side in a slot. A faulted or replaced transcript provider revokes captured actions
(`Revoked`) while the slots, header, welcome and channel controls stay. Disabling a package removes only its buttons;
safe mode removes every slot and arrangement and keeps the draft, the open bot or channel and its controls, with no
duplicate pause, Continue or Reassign.

## Limits

Browser evidence uses the preview's sample bots and `#launch` channel (`tests/extensions-bot-conversation-coverage.spec.ts`
in Chromium and WebKit); no messaging service is called. Installed WebView qualification and the served web chat page on
other devices are not claimed.
