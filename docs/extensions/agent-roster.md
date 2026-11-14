# Agent roster, subagent and profile presentation v1 (experimental)

## Decision

Before v1 the roster members of the ledger's `panda.agents` family had no public surface: the
subagent view (`src/subagents.ts`), the team profile library (`src/team-profiles.ts`) and the
main-window Running agents widget (`src/agents-dock.ts`) had no registry, state, captured action,
order, visibility, context menu or recipe. The Agents flyout accessory (`panda.agents.actions`) and
the dock item that opens the flyout belong to the action dock family (T56E,
[action-dock.md](action-dock.md)). v1 adds the `panda.roster` family:

- an explicitly selected `panda.roster` closed `running-first` recipe with `host-rows`,
  `host-lineage`, `original-actions`. It moves the original rows of the open task's working and
  waiting subagents ahead of the settled ones, keeping start order inside each group. Rows are the
  same nodes, so the open child, its stream, focus, the From lineage label and every listener stay;
- `panda.roster.controls` (Back to Subagents, Close subagents, Choose team profile, Manage team
  profile, Save as…, Update profile, Running agents, Pin widget), with order inside each control's
  own parent and reversible visibility on the original nodes. Back, Close, Choose team profile and
  Running agents never hide;
- `panda.roster.context`, a subagent row's context menu (right click, Shift+F10 or the menu key),
  with the core Open subagent row. It captures the parent task and that child
  (`selection.kind = "subagent"`, the child's opaque handle), never another task's child;
- `panda.roster.protected`, inspect-only, listing each protected behavior with its reason;
- the `rosterPresentation` / `rosterAction` contracts for captured actions.

Rejected alternatives: a package-rendered roster (would copy the panel's incremental row updates,
streaming Markdown, tool details and lineage labels, and move child status out of the host); a
per-child renderer hook (every subagent event would cross the boundary); letting a package apply,
save, rename or delete a profile directly (profiles are user data: selection and Update go through a
fresh host choice and the original handler, rename and delete stay in the host's Profile actions
menu); a public Stop for children (children stop with their task, from the composer); taking over
the pinned widget window (an auxiliary window whose lifecycle and privileges are T57's); merging
subagent lineage with machine lineage (`panda.machines`, T55G): a subagent's parent is another child
of the same task as the harness reports it, not a machine or a linked thread.

## Registry

`DOCK_REGISTRY` (`src/extensions/dock-core.ts`) keeps one entry per `panda.agents` ledger member;
the `subagents` and `profiles` entries now name the `panda.roster` locations and controls, and the
`widget` entry names the main-window parts while its auxiliary window stays T57's.
`ROSTER_REGISTRY` (`src/extensions/roster-core.ts`) lists the three roster members with every
operation and the reason for each exception; `tests/extensions-agent-roster.test.mjs` checks both
against the ledger.

| Member | Public locations | Order | Hide | Captured actions | Note |
| --- | --- | --- | --- | --- | --- |
| subagents | `panda.roster`, `panda.roster.controls`, `panda.roster.context` | yes | no | subagents, subagent-open, subagents-back, subagents-close, subagents-retry | Back and Close never hide; rows move only with the recipe |
| profiles | `panda.roster.controls` | yes | yes | profile-picker, profile-select, profile-manage, profile-create, profile-update | select and Update need a fresh host choice; rename/delete stay in the host menu |
| widget | `panda.roster.controls` | yes | yes (Pin) | widget, widget-open | Running agents never hides; its on/off preference is the user's; the pinned window is T57 |

## Contract and policy

`rosterPresentation` and `rosterAction` are bounded JSON v1 contracts shared by the schema, SDK
(`AgentRosterComponent`, `RosterPresentation`, `RosterAction`), native validator and catalog. The
presentation captures window, mount, project, task (the open task, the parent of its subagents),
profile (the selected saved profile of an open team setup, empty without one) and a revision, plus
visibility, busy (an open dialog, a pending host choice, a pending profile save or an open profile
menu), safe mode, the subagent view (`closed`, `list` or `detail`) and the open child, whether a team
setup with profiles is open, whether the widget is on and open, and up to 128 controls with their
resource (a child for `subagent-open`, a profile for `profile-select`, a running task for
`widget-open`).

Child and running-agent data are permissioned separately from presentation: only a package that
declares `tasks.summary` sees up to 64 children (an opaque id, the opaque id of the child it came
from or empty for the task itself, a status and whether it is active), the running count and up to
64 widget rows (an opaque id and `running` or `waiting`). No name, assignment, response, tool,
model, project name or path crosses. Without it `progress` is false and the lists are empty; the
controls and their handles are the same. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current mount, project,
task, profile and revision, a control listed in both snapshots with the same resource, an enabled
and not hidden control, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`, `StaleContext`,
`AlreadyApplied`, `Busy`. Child handles are keyed by their parent task and profile handles by the
profile, so a child of another task, a profile that was deleted or renamed away, a new child, a
status change, opening or leaving a child, or a redraw changes the captured state and an older
request is refused instead of retargeted. An action activates the original node, so the original
handler runs: the Subagents toggle, a row (opens that child and loads its full work), Back, Close,
Retry, the profile picker and Profile actions menus, Save as…, the widget trigger and a widget row
(opens that task, as a click would, only while the widget is open). `profile-select` and
`profile-update` first open a fresh host choice ("Extension requested a roster action"); Continue
runs the original profile selection (which replaces the setup form) or Update profile. Stop,
pin, unpin, rename, delete, approvals and answers have no public control id, so a forged one is
`InvalidArguments`.

## Presentation and recovery

Controls reorder inside their own parent and hide with `data-layout-hidden` on the original node;
a hidden control that had focus hands it to the first shown control of the same view. The
recipe's order is recomputed from the host's own child list each time the list draws, so a new
child or a settled one lands in place without a redraw of other rows; built-in order (start order)
returns at once when the recipe is cleared, faults, is disabled or safe mode starts.

Conflict never auto-selects a provider; future contract versions are disabled. Fault, disable and
safe mode restore the built-in roster without changing the open task, the open child, its stream,
the subagent list's scroll, the setup form, the selected profile, a pending profile save, the
widget's preference or its pinned window, or focus. With no package contributing there, a subagent
row has no context menu, as before.

Browser fixtures use the preview's synthetic `subagent` events, its team profile library and its
Running agents snapshot; no real harness or agent runs. Installed-window qualification stays
separate and deferred.
