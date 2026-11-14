# Cached usage, status and progress presentation v1 (experimental)

## Decision

Before v1 the ledger's `panda.status` family (the update prompt, the toast, the visual progress
picture-in-picture and the Jev activity entry) and the `usage` member of `panda.agents` (the cached
Agent usage panel) had only two accessory slots: `panda.status.items` (contributed items in the
dock's status group, beside the update prompt) and `panda.dialog.usage.actions` (the Agent usage
dialog's accessory band, [core dialogs](core-dialogs.md)). Their tabs, period, breakdown, Refresh,
agent rows, the picture-in-picture's controls and the Jev entry had no public registry, state,
captured action, order, visibility, context menu or recipe. v1 adds the `panda.status` family:

- an explicitly selected `panda.status` closed `details-first` recipe with `host-usage`,
  `host-feedback`, `original-actions`. It moves the original cost breakdown of the usage overview
  ahead of the agent list (after the period row). The nodes are the same, so the period, the
  breakdown switch, focus, the cached ledger and the limits already read stay;
- `panda.status.controls` (Usage views, Refresh usage, and the picture-in-picture's Previous, Play,
  Next, Annotations, Compare, Large view and Clear history buttons), with order inside each
  control's own parent and reversible visibility on the original nodes; Usage views never hide;
- `panda.status.context`, an agent row's context menu in the usage overview (right click,
  Shift+F10 or the menu key), with the core Show details row. It captures that harness
  (`selection.kind = "usage-provider"`, an opaque handle), never a task;
- `panda.status.protected`, inspect-only, listing each protected behavior with its reason;
- the `statusPresentation` / `statusAction` contracts for captured actions.

`panda.status.items` and `panda.dialog.usage.actions` are unchanged and keep their own contracts.

Rejected alternatives: a package-rendered usage panel (would copy the native cache, the per-provider
workers, sign-in and same-login handling, and move account data out of the host); a package
Refresh that reads providers on its own or on a timer (usage is read only when the panel opens and
on an explicit Refresh; a package Refresh is a request the user confirms); exposing account email,
plan, messages, costs or dashboard links (account data, not presentation); a public Undo, toast
action or restart (Undo and toast actions run whatever the notice offered, and restart is the
updater's safe-idle decision); hiding the update prompt, the toast or the Jev entry (live feedback
about the user's own work); a per-snapshot renderer hook for the picture-in-picture (every
iteration image would cross the boundary).

## Registry

`STATUS_REGISTRY` (`src/extensions/status-core.ts`) has one entry per member of the ledger's
`panda.status` family (`items`, `toast`, `progress`, `jev`) plus the `usage` member of
`panda.agents`, with its public locations, parts, captured actions and the reason for each
operation it does not support. `DOCK_REGISTRY` names the same family for the dock's status group
and for usage. `tests/extensions-status.test.mjs` checks both against the ledger.

| Member | Public locations | Order | Hide | Captured actions | Note |
| --- | --- | --- | --- | --- | --- |
| items | `panda.status.items`, `panda.status.protected` | contributed items only | contributed items only | — | the update prompt never hides and restarts only while safe |
| toast | `panda.status.protected` | — | — | — | state exposes only whether a notice, an Undo or an action shows |
| progress | `panda.status.controls`, `panda.status.protected` | yes | yes | progress-expand, progress-collapse, progress-prev, progress-next, progress-play, progress-marks, progress-compare, progress-enlarge, progress-thumb | Clear needs the card's own confirmation; the lightbox band is `panda.dialog.progress-lightbox.actions` |
| jev | `panda.status` | — | — | jev-open | the only entry to the task's test reports from the conversation |
| usage | `panda.status`, `panda.status.controls`, `panda.status.context`, `panda.status.protected`, `panda.dialog.usage.actions`, `panda.sidebar.footer` | yes | Refresh only | usage-open, usage-tab, usage-details, usage-range, usage-breakdown, usage-refresh | Refresh needs a fresh host choice; no polling |

## Contract and policy

`statusPresentation` and `statusAction` are bounded JSON v1 contracts shared by the schema, SDK
(`StatusComponent`, `StatusPresentation`, `StatusAction`), native validator and catalog. The
presentation captures window, mount, project, task (the open task), provider (the selected usage
tab's harness, empty on the overview or with the panel closed), range (the usage period) and a
revision, plus visibility, busy (another open dialog, a pending host choice or the
picture-in-picture's Clear confirmation), safe mode, whether the usage panel is open, its tab and
breakdown, whether it is loading, whether the update prompt shows, the toast's kind (`hidden`,
`notice`, `undo`, `action`), the picture-in-picture's state (`hidden`, `collapsed`, `expanded`),
whether the Jev entry shows, and up to 128 controls with their resource (a tab or harness for the
usage tabs and agent rows, a period, a breakdown, an iteration for `progress-thumb`).

Data is permissioned separately from presentation. Only a package that declares
`harnesses.inventory` sees up to 64 harness rows of the open usage panel (an opaque id, the
harness id, its read status, the highest window used as a whole percent or -1, and whether it is a
saved snapshot). Only a package that declares `tasks.summary` sees the open task's iteration count,
the shown iteration and the Jev status (`none`, `testing`, `passed`, `failed`, `finished`,
`stopped`, `attention`). No email, plan, message, cost, dashboard link, snapshot title, note,
image, report or toast text crosses. Without them `inventory` and `progress` are false and the
data is empty; the controls and their handles are the same. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current mount, project,
task, provider, range and revision, a control listed in both snapshots with the same resource, an
enabled and not hidden control, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`, `StaleContext`,
`AlreadyApplied`, `Busy`. Switching task, another tab or period, a new iteration, a read that
settles or a redraw changes the captured state, so an older request is refused instead of
retargeted. Usage controls act only inside the open usage panel; picture-in-picture and Jev
controls only while no dialog is open, as a pointer could. An action activates the original node,
so the original handler runs: the footer's Agent usage button, a tab, an agent row, a period, a
breakdown, the picture-in-picture's pill, collapse, step, play, annotations, compare, large view
and filmstrip buttons, and the Jev entry. `usage-refresh` first opens a fresh host choice
("Extension requested a status action"); Continue runs the original Refresh, whose native cache
and ten-second per-provider limit still apply. Restart, Undo, toast actions, Clear history, the
dashboard link and sign-in have no public control id, so a forged one is `InvalidArguments`.

## Presentation and recovery

Controls reorder inside their own parent and hide with `data-layout-hidden` on the original node;
the panel and the picture-in-picture redraw their toolbars, and each draw re-applies the layout to
the new nodes. A hidden control that had focus hands it to the first shown control of the same
toolbar. The recipe is applied each time the usage panel mounts; built-in order returns at once
when it is cleared, faults, is disabled or safe mode starts.

Conflict never auto-selects a provider; future contract versions are disabled. Fault, disable and
safe mode restore the built-in presentation without changing the open task, the usage panel's
tab, period, breakdown, cached limits and ledger, the picture-in-picture's iteration, corner and
collapsed preference, a live toast and its Undo, the update prompt or focus. With no package
contributing there, an agent row has no context menu, as before. Nothing in this family starts a
read, a timer or a network request: opening the panel reads what it always read, and only an
explicit Refresh (the user's, or a package's after the user's Continue) asks the providers again.

Browser fixtures use the preview's sample usage, its six-iteration `?progress` thread and synthetic
`jev-run` events with the extensions baseline transport; no provider, browser test or update runs.
Installed-window qualification stays separate and deferred.
