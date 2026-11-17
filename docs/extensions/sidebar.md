# Sidebar presentation v1 (experimental)

## Decision

Before v1, the sidebar had three partial adapters: whole-sidebar visibility (`panda.sidebar`
as a layout item), the footer action slot (`panda.sidebar.footer`) and the task and project
row menus (`panda.sidebar.task.context`, `panda.sidebar.project.context`). The header,
project row, filter, sections, row parts and the sort/view entry had no public registry,
order, visibility, captured action or recipe. v1 adds the `panda.sidebar` family:

- an explicitly selected `panda.sidebar` closed `filter-first` recipe with `host-sections`,
  `host-rows`, `original-actions`. It moves the original filter row ahead of the header
  actions; it does not remount a row, the filter field or a drag source;
- `panda.sidebar.header` (New task, New chat, Search) and `panda.sidebar.projects`
  (Filter projects, Sort and view, Import conversations, Open project), with order and
  reversible visibility on the original nodes;
- `panda.sidebar.sections` (Pinned, Active, Finished, Chats, Tasks, Project tasks, Settled)
  and `panda.sidebar.rows` (the Settle/Reopen tick, the task actions button, the harness
  logo, the linked pull request or issue and the branch name);
- `panda.sidebar.actions` (an accessory under the header buttons) and
  `panda.sidebar.context` (the section headings' context menu, with the core
  Collapse/Expand row);
- `panda.sidebar.protected`, inspect-only, listing each protected behavior with its reason;
- the `sidebarPresentation` / `sidebarAction` contracts for captured actions.

Rejected alternatives: replacing `renderNavigation` or the section/sort algorithms (would
move grouping, Active/Settled classification, unread state and manual order out of the
host, and break morphing, drag replay and the mutation budget); moving section nodes after
each draw (the morph is positional, so every draw would fight the move); a per-row
renderer hook (each row would cross the boundary on every stream update); letting a
package write the saved sort, collapse or manual order (only the host's own controls do,
with the user's input); a blanket "the sidebar is protected" exception.

## Registry

`SIDEBAR_REGISTRY` (`src/extensions/sidebar-core.ts`) has one entry per member of the
ledger's `panda.sidebar` family plus the sort/view row; `tests/extensions-sidebar.test.mjs`
checks it against the ledger.

| Member | Public locations | Order | Hide | Captured actions | Note |
| --- | --- | --- | --- | --- | --- |
| header | `panda.sidebar.header`, `panda.sidebar.actions` | yes | yes | new-task, new-chat, search | creation needs a fresh host choice |
| footer | `panda.sidebar.footer` | yes | yes | — | existing M1 adapter; its core buttons are public commands |
| projects | `panda.sidebar.projects` | yes | yes | project-filter, sort, import, open-project | the menus and dialogs stay host-drawn |
| filter | `panda.sidebar` (move), `panda.sidebar.protected` | move | no | filter-clear | `/` is the keyboard path to every row |
| sort | `panda.sidebar.projects` | yes | yes | sort | the radio rows are one preference each |
| sections | `panda.sidebar.sections`, `panda.sidebar.rows`, `panda.sidebar.context` | yes | yes | toggle-section, completed-more, folder-more, select-task, task-menu, settle, reopen | Active never hides; Settled stays docked |
| project.context | `panda.sidebar.project.context` | yes | yes | — | existing captured project menu |
| task.context | `panda.sidebar.task.context` | yes | yes | task-menu opens it | existing captured task menu |
| task.marks | `panda.sidebar.task.marks` | yes | yes | — | run-time badges of a service on a task row ([runtime-dynamic-items](runtime-dynamic-items.md)) |
| bots | `panda.sidebar.bots`, `.groups`, `.rows`, `.protected`, `panda.sidebar.bots.actions`, `panda.sidebar.bots.context`, `panda.sidebar.channel.context` | yes | yes | toggle-view, search, mark-read, create-menu, new-bot, new-channel, toggle-hidden, open-bot, bot-settings, bot-menu, open-channel, channel-menu | own `sidebarBotsPresentation` contract; see [Bots panel](#bots-panel) |

## Contract and policy

`sidebarPresentation` and `sidebarAction` are bounded JSON v1 contracts shared by the
schema, SDK (`SidebarComponent`, `SidebarPresentation`, `SidebarAction`), native validator
and catalog. The presentation captures window, mount, project (the project filter, an
opaque handle, empty for all projects), task (the open task, opaque) and a revision, plus
visibility, focus, busy (a drag, a pending reorder, an open host dialog or a pending host
choice), filtering, safe mode, the group/sort preferences, the drawn sections (pinned,
hidden, collapsed, count), up to 128 drawn rows (selected, pinned, unread, active,
settled; no title, path, branch or prompt) and up to 512 controls with their resource
(a row, a section or a Show more key). Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current mount,
project, task and revision, a control listed in both snapshots with the same resource, a
row still drawn for row controls, an enabled and not hidden control, and replay
admission. Rejections use stable reasons: `Revoked`, `WrongOwner`, `PermissionDenied`,
`UnsupportedCapability`, `InvalidArguments`, `StaleContext`, `AlreadyApplied`, `Busy`.
Selecting another task, filtering a project, a redraw or a pending choice changes the
captured state, so an older request is refused instead of retargeted. An action activates
the original node, so the original handler runs: `new-task`, `new-chat`, `toggle-section`
(a saved preference), `settle` and `reopen` first open a fresh host choice ("Extension
requested a sidebar action"); the rest open the original menu, dialog or row directly.
`toggle-section` is disabled while filtering, as its handler is; `filter-clear` only while
filtering. Delete, rename, pin, manual order and project removal have no public control id.

## Presentation and recovery

Sections reorder and hide as whole groups in the original renderer's output: membership
still comes from `sidebarSections()` and the original Chats/Tasks/project lists, and
`sidebar-sort.ts` still orders rows. The group holding the open task stays listed, every
group shows while filtering (as collapsed ones open), Active never hides and Settled stays
docked at the bottom. Header and project-row controls reorder in place with their nodes and
listeners. Row parts hide through one `data-row-hidden` attribute on the list and the
tick/menu pair through `data-row-order`, never per row; a hidden tick still settles with
⌘/Ctrl+Enter and a hidden menu button still opens with the menu key. Keyboard roving focus
follows the drawn order. A part or section that hides under focus hands focus to its row,
the open row or the filter.

Conflict never auto-selects a provider; future contract versions are disabled. Fault,
disable and safe mode restore the built-in sidebar without changing the open task, its
draft, stream or terminal, the collapse/sort/unread preferences or focus. With no package
contributing there, section headings have no context menu, as before.

Browser fixtures use the preview's sample threads and in-memory storage; the drag in the
coverage spec is the synthetic browser replay (`src/pointer-drag.ts`), not installed native
drag qualification, which stays separate and deferred.

## Bots panel

The sidebar's Bots view (`src/sidebar-bots.ts`: the Bots bar, the panel head with search,
Mark all read and the create menu, the Needs you / Pinned / Bots / Hidden bot groups and the
Channels / Deleted channels shared-channel groups) joins the same family. Before T56J it had no
registry entry with locations, no captured action and its row menus passed no extension
surface; only its four dialogs took `panda.dialog` accessories.

Decision: bot and channel rows are bot/channel objects, not task rows, so they get their own
bounded contract (`sidebarBotsPresentation` / `sidebarBotsAction`) inside `panda.sidebar`,
owned by the same selected `panda.sidebar` provider. Rejected: widening `sidebarPresentation`
(a breaking change to a published v1 shape, and its task/section fields mean nothing here); a
second component slot or recipe for the panel (a new family for one list, and a recipe that
would only re-order the same nodes); a per-row renderer hook or remounting rows (would move
grouping, unread state, pins and the dragged order out of `botsListHtml()` and break the
drag replay and the morph); letting a package pin, pause, delete or reorder bots.

| Location | Items | Operations |
| --- | --- | --- |
| `panda.sidebar.bots` | search, mark-read, create (the panel head) | reorder on the original nodes; Mark all read and create hide; the search field never hides |
| `panda.sidebar.bots.groups` | needs-you, pinned, bots, hidden, channels, deleted-channels | reorder and hide as whole groups; Needs you never hides |
| `panda.sidebar.bots.rows` | settings (button), role (tag), time | hide in place through one `data-row-hidden` attribute on the list |
| `panda.sidebar.bots.protected` | bar, search-field, status, selection, manual-order, delete-confirm, channel-membership, credentials | inspect only, each with its reason |
| `panda.sidebar.bots.actions` | panel head accessory | contribute, hide, reorder |
| `panda.sidebar.bots.context` | the bot row menu (Pin, Edit bot, Duplicate bot, Hide (pause), Delete bot…) | contribute, hide, reorder; `selection.kind = "bot"`, the clicked bot id and its workspace `projectId` |
| `panda.sidebar.channel.context` | the shared-channel row menu (Edit, Delete or Restore) | contribute, hide, reorder; `selection.kind = "channel"`, the clicked channel id, no `projectId` or `sessionId` |

Membership never changes: `botsListHtml()` alone classifies bots and channels, and the
arrangement only orders whole groups and leaves some out. The group holding the open bot or
channel stays listed, every group shows while searching and safe mode is built-in. A hidden
settings button keeps its path through the row menu's Edit bot.

The presentation captures window, mount, project (the open bot's workspace), bot and channel
(opaque handles, empty when none is open) and a revision, plus visibility, focus, busy (a bot
drag, an open dialog or a pending host choice), the view, searching, loaded, safe mode, the six
groups (pinned, hidden, open, count), up to 256 drawn rows (kind, group, selected, pinned and a
status: none, waiting, failed, limited, working, unread, responded; no name, role, message or
channel name) and up to 1024 controls with their resource (a row or the Hidden group).

Actions follow the sidebar rules with `bot` and `channel` in place of `task`: the selected
enabled provider with `ui.contribute`, the current mount, project, bot, channel and revision,
a control listed in both snapshots with the same resource, a row still drawn for row controls
(`open-bot`, `bot-settings`, `bot-menu`, `open-channel`, `channel-menu`), an enabled, not
hidden control (everything but `toggle-view` needs the Bots view open; `mark-read` only while
a reply is unread) and replay admission. `toggle-view`, `mark-read`, `toggle-hidden` (a saved
preference), `new-bot` and `new-channel` first open a fresh host choice ("Extension requested
a sidebar action"); creation then only opens the host dialog. `bot-menu` and `channel-menu`
open the original row menu through the row's own context-menu listener. A request naming a
protected operation (`delete-bot`, `pause-bot`, `duplicate-bot`, `delete-channel`,
`restore-channel`, `channel-members`, `bot-credentials`) is refused as `PermissionDenied`
before any other check of its shape, so a package learns it is host-only; other unknown ids
are `InvalidArguments`.

Fault, disable and safe mode restore the built-in panel without changing the open bot or
channel, the search text, the Hidden group preference or focus. Browser fixtures use the
preview's `?bots=sample` data (`tests/extensions-sidebar-bots-coverage.spec.ts`); no bot is
created, deleted or paused and no messaging service is called.
