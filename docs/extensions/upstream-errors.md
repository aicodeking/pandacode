# Thread errors and the toast after the upstream merge v1 (experimental)

## Decision

PandaCode 0.3.128 groups a thread's identical errors into one row with a count, folds the full text under a
disclosure, dismisses a row or a box of rows with Undo in the toast, and shows a bot's provider failover notice as an
error row (`src/thread-errors.ts`, `src/error-text.ts`, `errorRowHtml` and `dismissErrors` in `src/main.ts`, the bot
and agents-dock copies in `src/bots.ts` and `src/agents-dock-window.ts`). The one app toast has its own model, keys and
clearance (`src/toast-model.ts`, `src/toast-keys.ts`, `src/toast-clearance.ts`). With no package, in safe mode and with
nothing arranged, all of it behaves exactly as upstream: the rows carry no marker, no attribute and no observer.

v1 adds one adapter, `src/extensions/upstream-errors.ts`, built only from public primitives that already exist (the
user's layout store, a selected `panda.transcript` provider with `ui.contribute`, the host choice menu):

- `panda.thread.errors.controls`: an error row's **Details** (the disclosure) and **Dismiss** buttons reorder inside the
  row's own head; Details hides; Dismiss never hides (the user's way out of an error). The count badge, summary and the
  box's Dismiss all keep their place;
- `panda.thread.errors.protected`, inspect-only: error text, saved row ids and the dismissal journal; Dismiss all, the
  failover notice's Dismiss and the toast's Undo and action buttons; the toast text, its timers and the Escape order;
- a captured presentation and action contract (`UpstreamErrorsPresentation`, `UpstreamErrorsAction`) for the selected
  transcript provider, validated in the adapter (no new schema contract).

Rejected alternatives: a package-drawn error list or toast (it would copy the grouping, the dismissal journal and the
Undo window, and move error text out of the host); hiding Dismiss (the way out); letting a package suppress or replace a
host toast (a failure must stay visible); reading error text (it can carry the user's own output and paths).

## Captured actions

The owner is the selected, unfaulted `panda.transcript` provider (`timeline`) whose package holds `ui.contribute`. A
presentation carries a window, a per-mount `context`, opaque project and task handles, a `revision`, how many grouped
rows show, whether a failover notice shows, the toast's shape (`showing`, `tone`, `urgent`, `undo`, `actions`,
`closable`, never its text) and opaque control handles. The revision digests every group's key, count and whether its
details are open, plus the toast's shape and the owner: a new, merged, dismissed or opened group, another task or a
redraw makes an older request `StaleContext`. Streaming text does not.

| Control | Effect |
| --- | --- |
| `error-details` | Opens or closes the original disclosure (`toggle-error`); no choice is needed. |
| `toast-close` | Clicks the toast's own close button, as the user would; the toast text, Undo and actions are not controls. |
| `error-dismiss`, `errors-dismiss-all`, `failover-dismiss` | Show a fresh host choice ("Extension requested to dismiss errors"); Continue runs the original `dismiss-error`, `dismiss-errors` or `dismiss-failover-error` handler for the same task, row and revision, with its Undo toast. Escape declines; nothing is dismissed. |

`error-read`, `error-journal`, `error-restore`, `toast-read`, `toast-undo`, `toast-suppress` and `toast-action` are
refused with `PermissionDenied` before any other check. Other reasons: `Revoked` (safe mode, fault, disable, deselected
provider, another owner's identity), `WrongOwner`, `InvalidArguments`, `UnsupportedCapability`, `StaleContext`, `Busy`
(an open dialog, menu or host choice) and `AlreadyApplied`.

## Order, visibility and keyboard

Order and visibility are the user's (or a layout proposal's, selected with the `ui.customize` grant). Hidden controls
keep their node, out of view and inert; if one holds focus, focus moves to Dismiss. Reordering moves nodes without
recreating them, so a focused button keeps focus. Rows the transcript draws again (dismissal, Undo, a new error) are
arranged before they paint through one observer that exists only while something is arranged. F6, Escape in the toast
and `isImeKey()` handling are untouched.

## Recovery and cleanup

Fault, disable, uninstall, a deselected provider and safe mode put the built-in order and visibility back and end
captured control; the stored preferences are kept, so enabling the package again restores the arrangement. The
transcript, its scroll position, the draft and focus stay, nothing is dismissed twice, and no error reaches a package.

## Handoffs (not claimed here)

A package-contributed action on an error row, a toast notification raised by a package and the usage-limit flow are
new abilities owned by the runtime lane: live notices (R0207) and the limit flow (R0404B). They arrive through their own
contracts, are recorded for S07C and consumed by R1212, and this adapter does not claim them delivered. They are not a
permanent refusal.

## Evidence

- Browser preview, Chromium and WebKit: `tests/upstream-errors-extensions.spec.ts` (fixture
  `tests/fixtures/extensions/upstream-errors/manifest.json`, installed and enabled through the Settings flow). Zero
  extension behavior, captured stale rejection, host choice and Escape, order, hide and restore across a reload, grant,
  revoke, fault, disable, uninstall and safe mode.
- Node contract tests of the pure admission are part of the final test phase (`tests/extensions-surface-ledger.test.mjs`
  checks the ledger rows below).
- Native authority and lifecycle (grants, install and enable, uninstall cleanup) are covered by the existing native
  package tests; this adapter adds no native command, so there is no new native evidence to claim.
- Installed WebView qualification is separate and not claimed; the browser preview never substitutes for it.

Ledger (`tests/fixtures/extensions/surfaces.json`): `src/main.ts#dismiss-error`, `#dismiss-errors`,
`#dismiss-failover-error` and `#toggle-error`, and `src/bots.ts#dismiss-error`, are closed as host-owned (protected)
with this document and the spec as evidence; `src/agents-dock-window.ts#dismiss-error` was closed by the workers
panel adapter ([upstream workers](upstream-workers.md)). `src/bots.ts#models-retry` is closed as host-owned (protected) too: the retry is the host's
own handler, it re-runs the model load of the open form and is the only way back from a failed load, and its dialog band is the bots family's.
