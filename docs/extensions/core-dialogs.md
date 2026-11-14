# Main dialog extras v1 (experimental)

## Decision

Before v1 only Colors and Wallpapers accepted package content (`dialog-extras.ts` named two contracts and the
schema enumerated two dialog IDs). Every other modal opened through main.ts's shared modal helper had no
accessory seam. v1 gives each eligible main-window modal the same opt-in band:

- a stable dialog ID (`mainDialogId`) and two locations per dialog: `panda.dialog.<id>.bodyExtras`
  (owner-labelled plain text) and `panda.dialog.<id>.actions` (secondary actions);
- one band, appended after the host content as a direct child of the dialog and outside every form. The
  original fields, primary action, confirmation, Escape policy and initial focus stay where the host put them;
  Enter in a host field or a pending host submit never reaches the band;
- a `dialogAccessory` JSON v1 contract captured once when the dialog opens: window, dialog, mount (that one
  opening), revision, project and task handles (empty when none) and the captured target kind;
- secondary actions through the shared action slot (`mountExtensionActions`): buttons, menu triggers with
  nested items, status and badge, icons with the safe fallback, visibility/order overlays, and `showDialog`
  forms with the shared text/select/switch fields.

Rejected alternatives: replacing dialog bodies or forms (would move form ownership, validation and submit out
of the host and create a second form framework); inserting extras inside each host form (a band inside a form
is reached by Enter and implicit submission, and owners that re-render their content would drop it); keying
dialogs by title text (titles are dynamic and localizable; the stable ID is passed by each opener); a blanket
"modals are protected" exception (most main dialogs are ordinary views).

## Registry

`MAIN_DIALOG_EXTRAS` and `MAIN_DIALOG_PROTECTED` (`src/extensions/surfaces.ts`) cover every ledger
`panda.dialog` member owned by `src/main.ts`; `tests/extensions-core-dialogs.test.mjs` checks the registry
against the ledger, the schema and each opener. The ledger's `dialogCoverage` maps all 47 dialog rows.

| Dialog ID | Opener | Captured target |
| --- | --- | --- |
| `recipes` | Workflow recipes | task |
| `attachment` | sent-message attachment viewer | task |
| `task-details` | Task details / Add task (Board) | task, or project when adding |
| `subagents` | `/subagents` fallback | task |
| `task-status` | `/status` | task |
| `integrations-fallback` | `/integrations` on a non-Codex harness | task |
| `working-directory` | `/pwd` | task |
| `changed-files` | saved turn diff | task |
| `open-project` | Open project | none |
| `rename-task` | Rename task | task |
| `colors`, `wallpapers` | Appearance dialogs | none |
| `opencode-models` | OpenCode models | none |
| `moodboards` | Moodboards | project |
| `integrations` | Tools & integrations | project |
| `jev-settings`, `jev-assist`, `jev-tests` | Jev add-on, assistance, browser tests | none, task, task |
| `conversation-import` | Import conversations | none |
| `bots`, `bot-settings` | Bots, one bot's settings | none |
| `usage` | Agent usage | none |
| `command-palette` | Go to anything | none |

Protected main dialogs never mount the band, have no schema ID and are inspect-only items in
`panda.dialog.protected`, each with its reason:

| Dialog | Reason |
| --- | --- |
| `remove-project` | Destructive confirmation (the folder stays on disk). |
| `delete-task` | Destructive confirmation. |
| `provider-connections` | Credential entry and sign-in. |
| `delete-cloud` | Destructive confirmation (`panda.cloud.protected`). |
| `github-behind` | Start-anyway recovery choice (`panda.machines.protected`). |
| `delete-bot` | Destructive confirmation. |

Eligible dialogs that embed a host credential or pairing sub-form (Jev provider keys, bot channel tokens)
keep that sub-form host-owned; the band is outside it and no field value crosses the contract.

Module-owned dialogs that reach the main modal through their own host object (agent updates, shared
channels, GitHub import/PR/link, Link a machine, sketch, worktree create/cleanup) and directly mounted
dialog elements (command center, integrations/Jev direct mounts, progress lightbox, skill add, team model
add, extension forms) are T56C's: they must capture their own target rather than inherit the global modal.
`dialogCoverage` names each one.

## Contract and policy

`mainDialogId`, `dialogExtra.dialog`, the `panda.dialog.<id>.actions` action locations, the optional
`context.dialog` invocation field and `dialogAccessory` are one schema shared by the frontend validator,
the native validator (`src-tauri/src/extensions/contracts.rs`) and the SDK (`MainDialogId`, `DialogExtra`,
`DialogAccessory`, `InvocationContext.dialog`). A manifest naming a protected or unknown dialog, in either
`dialogExtras` or a menu location, is refused by both validators. `dialogExtras` holds at most 64 entries per
package; at most 8 notes are shown per dialog across packages and the rest is summarized as a count.

Admission (`admitDialogAccessory`, `src/extensions/dialog-accessory.ts`) compares a captured accessory with
the dialog open now and returns stable reasons: `UnsupportedCapability` (future contract version or a
protected dialog), `InvalidArguments` (shape, unknown dialog, extra fields such as selectors or IPC),
`Revoked` (no open dialog) and `StaleContext` (another mount, dialog, revision, project, task or target).
The action context carries the captured `dialog`, `revision`, project and task (omitted when empty) and a
`task`/`project` selection only for dialogs whose target is that object. Selecting another task while the
dialog is open changes nothing in the capture; replacing or closing the dialog makes the old capture stale.

## Lifetime and recovery

The opener passes its ID to the modal helper, which captures the accessory and lazily mounts the band. Close,
replacement by another modal, a queued close event from the previous opening, disable, a faulted package
record and safe mode dispose or empty only the band: host nodes, values, focus and the primary action stay.
When an owner replaces its loading view, the band is put back after the new content. With no contributing
package the band stays hidden and the dialog looks exactly as before.

A `showDialog` action opened from the band stacks a separate top-layer dialog (`#extension-nested-dialog`)
above the host dialog instead of replacing it. Escape closes that form first (with its cancel message), IME
composition never submits it, and focus returns into the host dialog. Replacing or closing the host dialog
unloads the form without a success message or late reply.

Browser fixtures (`tests/extensions-core-dialogs-coverage.spec.ts`, Chromium and WebKit) open each dialog
through its original opener with preview data; they are not installed-native qualification and change no real
project, task, bot, credential, cloud machine or repository.
