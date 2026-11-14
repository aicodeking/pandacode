# Module-owned and directly mounted dialog extras v1 (experimental)

## Decision

[Core dialogs](core-dialogs.md) gave every eligible modal opened by `main.ts` an opt-in extension band. The
other `panda.dialog` ledger rows are opened by their own module: some pass HTML to the shared modal helper
through their host object, others mount a dialog element themselves (`dialog.showModal()`). Before v1 none of
them had a band, and a band keyed off the global modal would have captured whatever task happened to be
selected rather than the module's own target.

v1 reuses the same band, the same `dialogAccessory` contract and the same IDs/locations
(`panda.dialog.<id>.bodyExtras`, `panda.dialog.<id>.actions`). Each owner states its dialog ID and target:

- **Module hosts** pass `{ dialog, task, project }` as the modal helper's fourth argument. The helper captures
  only what the module passed for these IDs; it never fills the task or project from the current selection.
- **Direct hosts** call `attachDialogExtras(dialog, request, { owner, container?, alive?, notify? })`
  (`src/extensions/owned-dialogs.ts`). The band lives while the host's `owner` node is in the open dialog and the
  host's own `alive()` holds; the accessory `mount` is `<dialog id>/<opening>` so each opening of each host is
  distinct. Without `notify`, action messages show in the band's own status line.
- **Direct mounts of a main dialog's view** (the integrations and Jev assistance/tests views when they open the
  dialog themselves) reuse that main dialog's ID and attach only in the branch where they called `showModal()`;
  opened through the modal helper they already carry its band. One opening never registers twice.

Rejected alternatives: a second contract or ID namespace for owned dialogs (packages would have to learn two
shapes for one band); reading the target from the global modal accessory or the selected task (switching tasks
would retarget a module's dialog); a separate band framework per module (duplicates disposal and admission);
treating every module dialog as protected (most are ordinary views).

## Registry

`OWNED_DIALOG_EXTRAS`, `OWNED_DIALOG_ALIASES` and `OWNED_DIALOG_PROTECTED` (`src/extensions/surfaces.ts`) cover
every non-`main.ts` `panda.dialog` ledger row; `tests/extensions-owned-dialogs.test.mjs` checks them against the
ledger, the schema, the SDK, the catalog and each owner's source.

| Dialog ID | Owner | Host | Captured target |
| --- | --- | --- | --- |
| `agent-updates` | `src/agent-updates.ts` | module | none |
| `channel-create`, `channel-settings` | `src/bot-shared-channels.ts` | module | none |
| `github-import` | `src/github.ts` | module | project |
| `github-pr`, `github-link` | `src/github.ts` | module | task |
| `sketch` | `src/sketch.ts` | module | task |
| `worktree-create` | `src/worktrees.ts` | module | task |
| `command-center` | `src/command-center.ts` (panels and Goal) | direct | task |
| `progress-lightbox` | `src/progress-lightbox.ts` (band inside the plate) | direct | task |
| `team-model-add` | `src/team-model-add.ts` | direct | none |

Aliases: `integrations-direct` → `integrations`, `jev-assist-direct` → `jev-assist`, `jev-tests-direct` →
`jev-tests`.

Protected rows never mount a band, have no schema ID and are inspect-only items in `panda.dialog.protected`:

| Dialog | Reason |
| --- | --- |
| `machine-link` | Granting agents access to another machine is a permission choice (`panda.machines.protected`). |
| `worktree-cleanup` | Removing a worktree folder or branch is a destructive confirmation (`panda.worktree.protected`). |
| `skill-add` | Installing third-party skills follows a host security scan; verdicts and the install confirmation stay host-owned. |
| `extension-form` | A package's own form is itself the accessory surface; another package's content never goes inside it. |

## Contract, lifetime and recovery

The schema's `mainDialogId` enum (shared by the frontend validator, `src-tauri/src/extensions/contracts.rs`
and the SDK's `MainDialogId`) lists the 23 shared main modals first and then these 11 IDs; protected and alias
IDs appear nowhere in it, so manifests naming them are refused by both validators. Admission, the invocation
context (`dialog`, `revision`, project/task only when present, a `task`/`project` selection only for that
target) and the body-extra limits are the same as for core dialogs.

Close, replacement of the dialog's content by another opening, a closing animation, disable, a faulted package
record and safe mode dispose or empty only the band: host nodes, values, focus and the primary action stay. A
`showDialog` form opened from any band stacks in `#extension-nested-dialog` above the host dialog, closes first
on Escape and unloads without a reply when the host dialog is replaced or closed. In the progress large view
arrow keys on band controls do not step iterations.

Browser fixtures (`tests/extensions-owned-dialogs-coverage.spec.ts`, Chromium and WebKit) open each dialog
through its module's original opener with preview data; they are not installed-native qualification and perform
no real update, install, GitHub push, channel change, worktree, machine link or goal on a harness.
