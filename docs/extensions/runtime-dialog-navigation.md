# Dialog answers and host navigation

Slice R0206. A trusted package with `runtime.service` and the `ui.dynamic` grant can ask the user a question and wait
for the answer, and can move what the window shows. The grant is checked natively on every call; a package that holds
it is never asked again per action (ADR-0005).

## What a package sees

```js
exports.service = async (panda, lifetime) => {
  const answer = await panda.ui.showDialog({
    title: 'Pick a name', successMessage: 'Done',
    fields: [{ id: 'name', label: 'Name', kind: 'text', required: true }],
  });
  if (answer.status === 'confirmed') await panda.ui.reveal({ taskId: answer.values.name });
};
```

| Call | Does |
|---|---|
| `panda.ui.showDialog(definition)` | Shows the host's extension dialog and resolves with `{ status: 'confirmed', values }` or `{ status: 'cancelled' }`. |
| `panda.ui.reveal(target)` | Opens a view or settings page of the package (`{ view }`, `{ settingsPage }`), selects a task (`{ taskId }`) or opens a file of a project (`{ projectId, path, line?, editor? }`). Resolves `null`. |

Short activations keep `panda.ui.showDialog` as it was (it resolves on admission, not on the answer, and the dialog
shows after the activation ends); the answer is a service feature (`ServicePandaCode`, `ServiceUi` in the SDK).

## Dialogs

- The definition goes through the same validator as a manifest dialog, with the same diagnostics.
- One dialog may be open per package: a second `showDialog` while one is open answers `Conflict` and leaves the first
  alone. A dialog waits (shown later, in order) while another package's dialog, or a host dialog, is open.
- The user's confirm returns the values of the declared fields; Cancel, Escape and closing return `cancelled`.
  Values may name only declared fields and stay under 64 KiB. An answer for a dialog that is gone is `NotFound` and
  reaches no service.
- When the service ends (disable, revoke, uninstall, safe mode, crash, quit) a pending dialog resolves as `cancelled` and
  its window closes at once; the window also closes it the moment the package's identity changes.
- Keyboard and IME: the dialog is the host's own, so Enter submits, Escape cancels, and a composing Enter or Escape
  (keyCode 229) does neither. The focus returns to the control that had it before the dialog opened, or to the prompt.

## Reveal

- `view` and `settingsPage` must be ids that start with the package id and exist now (a manifest or a live view). A
  foreign id is `PermissionDenied`; an unknown one `NotFound`.
- `taskId` and `projectId` must exist now; a deleted task or project is `NotFound`. Nothing is sent to any task: reveal
  only changes what the window shows.
- `path` is relative to the project and stays inside it (`..` and absolute paths are `InvalidShape`); the file must exist.
  `editor` must carry the package id. `line` is a positive integer; the built-in editor opens the file and does not yet
  place the cursor (a package's own editor arrives with `documents.editors`).
- Reveal never takes the keyboard out of a text field the user is typing in: the field keeps focus and selection.

## Refusals kept, with their reasons (ADR-0005: none is a security restriction)

| Refusal | Reason |
|---|---|
| second dialog of one package: `Conflict` | one modal at a time per package keeps answers unambiguous |
| answer for a gone dialog: `NotFound`; undeclared field or oversized answer: `InvalidShape` / `LimitExceeded` | stale context and the declared shape; a bound for stability |
| foreign view, page or editor id: `PermissionDenied` | an id names its own package's things |
| unknown or removed task, project, file, view or page: `NotFound` | stale context |
| path outside the project, line 0, two targets: `InvalidShape` | the declared shape |
| no `ui.dynamic` grant: `PermissionDenied` | the permission itself (checked per call) |

Refusal-test reconciliation: Q017 (protected dialog ids and settings `async` stay refused as extras; the service dialog
answer is a new, permissioned path), Q058 (`onChange: 'eval()'` stays refused: a dialog field never carries code),
Q122 (one dialog at a time stays: the host modal is never stolen, a service dialog waits for it).

## Where it lives

`src-tauri/src/extensions/runtime_dialog_navigation.rs` (state, validation, `uiDialog`/`uiReveal` requests, events
`extensions-runtime-dialog`, `extensions-runtime-dialog-close`, `extensions-runtime-reveal`, commands
`extensions_runtime_dialog_answer`, `extensions_runtime_dialogs`), `src/extensions/runtime-dialog-navigation.ts` (the
preview mirror and the window side), fixture `tests/fixtures/extensions/runtime-dialog-navigation/`.
