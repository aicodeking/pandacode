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
| bots | — | — | — | — | bot/channel rows, assigned to the T56I controls audit |

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
