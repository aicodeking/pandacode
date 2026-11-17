# Bots and shared channels (`workspace.bots`, `workspace.channels`)

A trusted background service creates, changes and removes the app's bots and shared bot channels with the
`workspace.manage` permission. Each call is a thin native adapter over the operation the interface itself runs, so a
package gets exactly what the sidebar's forms give the user, labelled with its name, and nothing the interface does not do.

```ts
panda.workspace.bots:     { create(input), update(botId, input), remove(botId) };
panda.workspace.channels: { create(input), update(channelId, input), remove(channelId) };
```

Recipes and wake-ups, moodboards and cloud are the sibling slices (R0406B, R0406C). Posting to a channel, stopping its
members, continuing or reassigning a post are tasks: the `tasks.*` calls cover bot threads and shared channels (PLAN.md,
Scope settled), so they are not repeated here.

## Mapping to the interface

| Call | Native operation it runs | Notes |
|---|---|---|
| `bots.create(input)` | `bots::create` (the `bot_create` command's body), then `bots::set_capabilities` when `skills` or `mcp` are named | Creates the bot's own workspace folder and its project, as the New bot form does. Emits `bots-changed` |
| `bots.update(botId, input)` | `bots::update`, then `bots::set_capabilities` when `skills` or `mcp` are named | A patch over the current bot: a field that is not named keeps its value. Open threads get the new brief and profile, as in the interface |
| `bots.remove(botId)` | The gateway and the channel connections stop (`gateway::stop_bot`, `channels::stop_bot_channels`), then `bots::delete` | Irreversible: host confirmation by default. The bot's workspace folder stays on disk, as in the interface |
| `channels.create(input)` | `bot_shared_channel_create` | The first member leads |
| `channels.update(channelId, input)` | `bot_shared_channel_update` | A patch: name, members and lead. A removed member's pending work stops, as in the interface. A lead who is no longer a member falls back to the first member |
| `channels.remove(channelId)` | `bot_shared_channel_archive(archived = true)` | The interface's "Delete channel": pending work stops and the channel stays under Deleted channels, restorable. It asks for the same confirmation as the other deletions |

Inputs are camelCase objects, the same fields the forms send. Anything else answers `InvalidShape` with the field in `path`.

- **Bot** (`WorkspaceBotInput`): `name` (required on create), `role`, `instructions`, `goals`, `soul`, `avatar`, `provider`,
  `model`, `mode`, `heartbeatMinutes`, `color`, `reasoningEffort`, `backupModels` (up to four `{ provider, model }`),
  `fallbackMode` (`ask` or `auto`), `notify`, `whileWorking` (`queue` or `steer`), `showPlan`, `skills` and `mcp` (up to fifty
  references each: skill ids are library slugs, MCP names are the harness's own server names, never definitions). A create
  needs a built-in harness in `provider`, a `model`, a permission `mode` and a `name`, exactly as the form does: the
  interface's own validation decides every value and answers with the field.
- **Channel** (`WorkspaceChannelInput`): `name` (required on create, up to 48 characters), `memberIds` (required on create,
  up to 64 existing bots, no repeats), `leadBotId` (a member, or `null` for the first member).
- Results are the records the interface lists (a bot, a channel; `null` for a removal). They never carry a credential: bots
  keep their channel tokens in the secret store, which no call reads or writes.

## Permission, scope and failures

`workspace.manage` is global. A bot and a channel belong to no user project, so a grant narrowed to projects does not cover
these calls. It is granted with the trust decision, checked against the grants file on every call, once at admission and
again right before the effect (after the confirmation too), so a revoke, a disable, safe mode or a narrowing in between
changes nothing. A package that holds it is never asked per action (ADR-0005).

| Case | Answer |
|---|---|
| No grant, revoked, package disabled or uninstalled, safe mode | `PermissionDenied`, `path: "workspace.manage"` |
| Unknown or already removed bot, channel or member | `NotFound` |
| A channel that was removed (archived) and is then changed | `StaleContext` |
| A shape or value the form does not take | `InvalidShape`, `path` names the field |
| More than the bound (text 512 KiB, four backups, fifty references, 64 members) | `LimitExceeded` |
| The user refused the deletion's confirmation | `Cancelled`, nothing is removed |
| Nobody answered the confirmation in 120 s / the host has no window to ask | `Timeout` / `HostUnavailable` |

The bounds are for predictability and fault isolation, never for trust.

## The deletion's confirmation

`bots.remove` and `channels.remove` are irreversible actions of `workspace.manage`. The host confirmation is the default
and the user turns it off **per package** (`runtime_family_consents`, `confirmDeletions`); turning it off for one package
changes no other. The window shows the confirmation on the same plate as its own deletions, naming the package and the
thing; the answer reaches the waiting call through `extensions_workspace_automation_confirm_answer`, which asks
`FamilyConsents::answer` again, so the authority is rechecked natively after the dialog (a revoke while it was open removes
nothing). At most eight confirmations wait at once and two per package. A headless host cannot ask: the call answers
`HostUnavailable` until the user turns the confirmation off for the package.

## Attribution

Every effect is labelled with the package's name. A bot's activity log gets a line (`Created by extension <name>`,
`Settings changed by extension <name>`). Both bots and channels are recorded in a file-backed ledger, independent of
SQLite (so the schema stays at 38), that survives the package and keeps the newest origin per bot and channel, bounded to
10,000 entries; the window reads it through `extensions_workspace_automation_origins` and hears
`extensions-workspace-automation-origins` when it changes.

## Disable and revoke

A service that is disabled, uninstalled or revoked keeps what it already made (bots and channels are the user's data) but
every later call answers `PermissionDenied`. A call in flight when the grant goes finishes its native operation or does
nothing, never half of it: the grant is read again right before the write.

## Why some refusals stay

The built-in bot controls that extension *contributions* cannot overlay (`delete-bot`, `channel-members`, `bot-stop`,
`message-send`, `draft-write`, the sidebar bots panel's seven controls; checklist rows Q008, Q010, Q011, Q076, Q077, Q103
and Q104) keep refusing a package's captured UI action. The reason is functional, not security: a contributed button on a
built-in surface acts through the page's own handlers and has no native seam to check a grant against. The permissioned
path for the same power is this namespace (and `tasks.*` for messages and stop), where every call is checked natively.
See `_work/10-docs/extension-runtime-receipt.md` for each row.

## Preview

The browser preview has no service process. `src/extensions/runtime-workspace-automation.ts` mirrors the forms and the
refusal envelope with no I/O; `extensions_workspace_automation_service` answers a call exactly as the native `serve` does and
`extensions_workspace_automation_preview` is the test hook (install, grant, revoke, the package's confirmation preference,
the answer of the next confirmation, state). The native rules are proven by `runtime_workspace_automation::tests`.
