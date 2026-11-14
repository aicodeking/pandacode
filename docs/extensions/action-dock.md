# Action dock and team progress presentation v1 (experimental)

## Decision

Before v1, the action dock and team progress had three accessory slots only:
`panda.actionDock.actions` (a group after the dock's own), `panda.team.actions` (the inline
Workers line) and `panda.agents.actions` (the Agents flyout, after its panels). The dock's
panel, action and status groups, its items, the Workers line's parts and the flyout had no
public registry, order, visibility, captured action, context menu or recipe. v1 adds the
`panda.actionDock` family:

- an explicitly selected `panda.actionDock` closed `actions-first` recipe with `host-groups`,
  `host-workers`, `original-actions`. It moves the original actions group (Run, Deploy, Task
  actions) ahead of the panels group; the status group stays last. It moves the original group
  nodes, so items, listeners, the roving Tab stop, the hover pill and the Agents flyout stay;
- `panda.actionDock.controls` (Toggle inspector, Toggle terminal, Open browser, Project
  moodboards, Agents, Run project, Deploy, Task actions), with order inside each item's own
  group and reversible visibility on the original nodes; Agents never hides;
- `panda.team.controls` (the Workers toggle and the Open team button of every Workers line),
  with order and reversible visibility through one attribute on the workspace, never per list;
  the Workers toggle never hides;
- `panda.team.context`, the Workers line's context menu (right click, Shift+F10 or the menu
  key on its head), with the core Show/Hide workers and Open team rows; it captures the team
  (`selection.kind = "team"`, the parent task id), never a worker;
- `panda.actionDock.protected`, inspect-only, listing each protected behavior with its reason;
- the `dockPresentation` / `dockAction` contracts for captured actions.

Rejected alternatives: a package-rendered dock or Workers line (would copy the dock's spring,
placement, roving and wheel forwarding, and move worker status and attention out of the host);
a per-worker renderer hook (every stream event would cross the boundary); public Stop,
approval, answer, retry or skip controls (they are authority, not presentation: they stay with
the composer and the team panel); letting a package open the flyout on hover or pin it on its own
(the original Agents click does it, from a captured action); a blanket "the dock is protected"
exception.

## Registry

`DOCK_REGISTRY` (`src/extensions/dock-core.ts`) has one entry per member of the ledger's
`panda.agents` family that this task leads (`dock`, `team`) plus the flyout and status group it
names; `tests/extensions-team-controls.test.mjs` checks it against the ledger.

| Member | Public locations | Order | Hide | Captured actions | Note |
| --- | --- | --- | --- | --- | --- |
| dock | `panda.actionDock`, `panda.actionDock.controls`, `panda.actionDock.actions` | yes | yes | inspector, terminal, browser, moodboards, agents, run, deploy, task-menu | Run needs a fresh host choice; Agents never hides |
| flyout | `panda.agents.actions` | yes | yes | agents | the original Agents click pins it; panels are T56F |
| status | `panda.actionDock` (stays last), `panda.status.items` | — | — | — | the update prompt is the status family (T56G) |
| team | `panda.team.controls`, `panda.team.actions`, `panda.team.context` | yes | yes | team-toggle, team-open, worker-open, workers-more | the Workers toggle never hides |
| subagents, profiles, widget, usage | — | — | — | — | roster/lineage views are T56F, the widget T57, usage T56G |

## Contract and policy

`dockPresentation` and `dockAction` are bounded JSON v1 contracts shared by the schema, SDK
(`ActionDockComponent`, `DockPresentation`, `DockAction`), native validator and catalog. The
presentation captures window, mount, project, task (the open task), team (the open task's team,
empty without one) and a revision, plus visibility, busy (an open dialog, a pending host choice
or a thread switch), safe mode, whether the dock is a header row, whether the flyout is open, the
three groups and whether each shows, and up to 128 controls with their resource (a worker for
`worker-open`, the team for the Workers line's controls).

Progress is permissioned separately from presentation: only a package that declares
`tasks.summary` sees the team status, the running/attention/failed/total counts and up to 64
workers (an opaque id, a status and whether it needs attention; no name, assignment, model,
path or prompt). Without it `progress` is false, the status is `none`, the counts are zero and
the worker list is empty; the controls and their handles are the same. Metadata is not
authority.

Actions require the selected enabled provider and `ui.contribute`, the current mount, project,
task, team and revision, a control listed in both snapshots with the same resource, an enabled
and not hidden control, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`, `StaleContext`,
`AlreadyApplied`, `Busy`. Switching task, a new worker, a status change or a redraw changes the
captured state, so an older request is refused instead of retargeted; a worker of another team
is not in the snapshot. An action activates the original node, so the original handler runs:
`run` first opens a fresh host choice ("Extension requested a dock action"); the rest toggle the
original panel, open the original menu or dialog, pin the flyout, fold the Workers line or open
the team panel or that worker in it. Stop, approve, deny, answer, retry and skip have no public
control id, so a forged one is `InvalidArguments`.

## Presentation and recovery

Dock items reorder in their own group and hide with `data-layout-hidden` on the original
button; the dock's observer re-roves and re-places on the change, and a group with nothing left
to show folds with its separator. An item that hides under focus hands focus to the first shown dock
item; an Open team button that hides under focus hands it to its Workers toggle. A hidden item
keeps its keyboard path (⌘/Ctrl+J still toggles the terminal) and roving skips it. The Workers line's parts hide and reorder through `data-team-hidden` / `data-team-order`
on the workspace, so every list (saved turns, the live turn, thread tiles) follows at once and a
redraw keeps it. The count, attention tone, worker rows and the More row are never hidden.

Conflict never auto-selects a provider; future contract versions are disabled. Fault, disable
and safe mode restore the built-in dock and Workers line without changing the open task, its
draft, stream, team, worker statuses, pending approvals, the flyout's open panels or focus. With
no package contributing there, the Workers head has no context menu, as before.

Browser fixtures use the preview's synthetic `architect-event` team and the extensions baseline
transport; no real harness or agent runs. Installed-window qualification stays separate and
deferred.
