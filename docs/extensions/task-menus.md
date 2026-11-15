# Team, Task actions, Deploy and Bot assignment menus v1 (experimental)

## Decision

Before v1 the Team menu, Architect & workers, the dock's Task actions menu, the Deploy menu and the task Bot assignment
menu had no extension adapter (the dock's Task actions menu passed no extension surface at all). v1 makes them
extensible without moving a handler out of `src/main.ts`, owned by `src/extensions/task-menus-core.ts` (registry
`TASK_MENUS_REGISTRY`, admission) and `src/extensions/task-menus-host.ts` (extension surfaces, the setup slot, captured
actions):

- `panda.team.menu`: contributed items in the Team menu, captured with `selection.kind = "team"` (`ids = [<task>]`).
  The team kinds (`lead`, `cheapest`, `balanced`, `quality`) hide and reorder; No team and a named team never hide;
- `panda.team.setup.actions`: contributed actions at the end of Architect & workers (the classic setup), captured with
  the same `team` selection. The form, its models, limits and Save stay host-owned;
- `panda.task.menu`: contributed items in the dock's Task actions menu, captured with `selection.kind = "task"`. Pin,
  Rename, Browser tests with Jev, Jev assistance, Settle or Reopen, Manage goal, Background commands, Codex usage, Copy
  path and New task in a worktree hide and reorder; Delete task… and Open harness console never hide;
- `panda.deploy.menu`: contributed items in the Deploy menu, captured with `selection.kind = "connection"` (`ids` = the
  connected platforms, or `project` when none is connected). The six platforms hide and reorder;
- `panda.bot.assignment`: contributed items in the Bot menu, captured with `selection.kind = "bot"` (`ids` = the bots
  listed). No bot and the listed bots keep their place;
- `panda.menus.task.protected`, inspect-only, with a reason for each: No team, a named team, saving a team, team
  profiles, Delete task, the harness console, a deployment, platform connections and credentials, assigning a bot, No
  bot, the bots list and a bot's credentials and settings;
- the `taskMenusPresentation` / `taskMenusAction` contract for captured actions, and the new selection kind
  `connection` (schema `context.selection.kind`, SDK `TaskMenusSelectionKind`, native `contracts.rs`).

A menu passes its extension surface (`showChoices` `extensionSurface`, as the sidebar Task actions menu does) only when an
enabled package contributes to it or the user arranged its entries; otherwise, and in safe mode, it keeps exactly the
host's own rows and roles (the Team and Bot menus keep their radios, also when the surface is engaged). The captured
context is built once, when the menu opens, with the task, project and revision; the menu ends if the task or the host
generation changes, so a contributed item never runs against a later task.

Rejected alternatives: letting a package start, stop or reconfigure a team directly (a team spends models and changes
the task); a package-run deploy (a deployment starts an agent task that ships the project); package-owned bot
assignment (it changes the task's harness, model and first-message brief); a new recipe (the selected `panda.composer`
provider is reused as owner of captured actions, as for the slash menu).

## Captured actions

A `taskMenusAction` carries the opaque window, mount, project, task, team, connection, bot and revision of the
`taskMenusPresentation` it was built from, plus a control handle and its resource (a menu entry). The presentation
carries which host menu is open and the controls; it never carries labels, bot names, platform names, tokens, project
IDs or team configuration. Switching task, a team change, another set of connected platforms, a bot assignment or any
redraw changes the revision: an older request is `StaleContext`.

| Control | Effect |
| --- | --- |
| `team-setup-open` | Opens Architect & workers (the original `showArchitectSetup`), anchored on the Team button. |
| `task-run` | Runs the original Task actions handler (`action(id)`) for Pin, Rename, Jev, Settle, Goal, Jobs, Usage, Copy path and Worktree. |
| `team-select` | Fresh host choice ("Extension requested a task menu action"); Continue runs the original `chooseTeam`. |
| `task-delete` | Fresh host choice, then the original Delete task action, whose own confirmation still follows. |
| `deploy-run` | Fresh host choice, then the original `startDeploy`: one new task with the platform's brief. Only connected platforms. |
| `bot-assign` | Fresh host choice, then the original `assignTaskBot`, only before the task's first message. |

`team-save`, `team-profile-edit`, `task-console`, `task-delete-confirm`, `deploy-connect`, `deploy-credentials`,
`bot-credentials`, `bot-create` and `bot-delete` are refused with `PermissionDenied` before any other check. Other
reasons: `Revoked` (safe mode, fault, disable, another owner's identity), `WrongOwner`, `InvalidArguments`,
`UnsupportedCapability` (hidden or disabled control, a platform that is not connected, another contract version), `Busy`
(an open menu, the setup, another dialog or a host choice), `AlreadyApplied`. The fresh choice runs the handler exactly
once and only for the same task, team, connections and bot; Escape declines and nothing runs.

The connected platforms are read (`cloud_connections`, a local read) only while an owner is active; nothing is requested
when no package consumes them, and the Deploy menu reads them as before when it opens.

## Recovery

Conflict, fault, disable, another selected provider and safe mode keep the task, the team setup and the bot assignment:
the host's rows return once each, a contributed item that cannot run leaves the menu, and a closed menu runs nothing.
Safe mode restores the built-in order and every entry without deleting the stored preferences. Installed WebView
qualification is not claimed; evidence is the browser preview (`tests/extensions-task-menus-coverage.spec.ts`,
Chromium and WebKit), the Node contract tests (`tests/extensions-task-menus.test.mjs`) and the native contract and
package tests.
