# Manage moodboards and cloud machines (`workspace.manage`)

Runtime phase R4, slice R0406C. A trusted background service manages the content of a project's moodboards and provisions
and controls cloud machines that the user already connected. The permission is `workspace.manage`: project scoped, granted
with the trust decision, rechecked natively on every call and once more right before the effect, revocable and narrowable.
A package that holds it is never asked again per action (ADR-0005). The two irreversible removals keep the host
confirmation by default, which the user can turn off per package.

```js
const board = await panda.workspace.moodboards.create({ projectId, name: 'Landing page' });       // { id, projectId, name, imageCount, updatedAt }
await panda.workspace.moodboards.rename(board.id, 'Landing page v2');
const detail = await panda.workspace.moodboards.addImage(board.id, { name: 'hero.png', dataUrl }); // the board and its images
await panda.workspace.moodboards.removeImage(board.id, detail.images[0].id);
await panda.workspace.moodboards.remove(board.id);                                                 // irreversible: the host confirms by default

const machine = await panda.workspace.cloud.provision({ provider: 'daytona', name: 'build-box' }); // a provider the user already connected
await panda.workspace.cloud.sync(machine.id);      // bring a cloud task's changes back
await panda.workspace.cloud.retry(machine.id);     // send the first prompt again
await panda.workspace.cloud.open(machine.id);      // show the machine in the machines panel
await panda.workspace.cloud.stop(machine.id);
await panda.workspace.cloud.remove(machine.id);    // irreversible: the host confirms by default
```

## Each method is an existing native seam

No method has behaviour of its own: it reaches the code the original controls reach, so a package and the user's click share
limits and results.

| Method | Native seam | Notes |
|---|---|---|
| `moodboards.create` | `create_moodboard` | 24 boards a project, a name of 1 to 120 characters |
| `moodboards.rename` | `rename_moodboard` | answers the board |
| `moodboards.remove` | `delete_moodboard` | irreversible, confirmed by default |
| `moodboards.addImage` | `add_moodboard_image` | `{ name, dataUrl }`, a `data:image/...` URL up to 17 MiB; 64 images a board; the host decodes and resizes it |
| `moodboards.removeImage` | `remove_moodboard_image` | |
| `cloud.provision` | `cloud_create` | only a provider the user already connected; answers the machine `{ id, provider, name, state, os, desktop, detail }` |
| `cloud.sync`, `retry` | `cloud_agent_action` | of the cloud task that owns the machine; a machine no task owns answers `NotFound` |
| `cloud.open` | `cloud_agent_action` then `vm_show` | shows the machine in the machines panel |
| `cloud.stop` | `cloud_agent_action` or `cloud_power` | the owning task when there is one, so its stage stays true |
| `cloud.remove` | `cloud_agent_action` `delete` or `cloud_power` `delete` | irreversible, confirmed by default |

The window reacts exactly as it does to the user's own change: the moodboard panel reloads on `moodboards-changed`, the
machines panel on `vm-changed`. There is no separate native state.

## Scope

- A moodboard call is gated on the board's project; `create` on the `projectId` it names. A project outside the grant answers
  `PermissionDenied` with the permission name in `path`.
- A machine that a cloud task owns is gated on that task's project. A machine no task owns, and `provision`, are not about a
  project: they need the grant for every project, so a package narrowed to chosen projects cannot reach them.
- A package that holds the permission for no project learns nothing: every answer is `PermissionDenied`, whatever the id.

## Confirmations

`moodboards.remove` and `cloud.remove` (the actions `moodboards.remove` and `cloud.machines.remove` of
`runtime_family_consents`) confirm by default. The main window shows the host's own extension dialog titled with the
package's name and what is removed ("Workspace manager: Delete moodboard ..."), with Delete and Cancel. Cancelling, Escape, a
timeout of two minutes, a disabled or revoked package, a stopped service and a headless host all remove nothing (`Cancelled`,
`Timeout`, `Revoked`, `UnsupportedCapability`). The authority is checked again after the answer, because it can be revoked
while the dialog is open. The user can turn the confirmation off for one package (Settings, Extensions); then that package
removes without asking and every other package still asks. Stopping a machine and removing an image are reversible or small
and never ask.

## What stays with the user

- Connecting a provider (its key or sign-in), pairing a machine, granting remote access and approving access are not methods.
  `provision` with a provider that is not connected answers `UnsupportedCapability` and connects nothing.
- No call takes or returns a credential (ADR-0006). `credentials`, `token`, `apiKey`, `path` and `prompt` are not fields: they
  answer `InvalidShape`. Native error text never reaches a package; it is mapped to a frozen code.
- Recovery dialogs stay built-in.

## Refusals

| Code | When |
|---|---|
| `PermissionDenied` | no grant, a revoked or narrowed grant, a disabled package, a project outside the scope |
| `InvalidShape` | an unknown method, a field the call does not take, a bad id, an empty name, a non-image data URL |
| `LimitExceeded` | a name over 120 characters, 24 boards, 64 images, a data URL over 17 MiB, a fifth confirmation waiting |
| `NotFound` | an unknown board, image or machine (told only to a package that holds the grant) |
| `UnsupportedCapability` | a provider that is not connected |
| `Conflict` | provisioning a machine that exists |
| `Busy` | the owning agent is running: stop it first |
| `Cancelled`, `Timeout`, `Revoked` | the confirmation was declined, unanswered or ended with its service |

These bounds are for predictability and fault isolation, not for trust.

## Attribution and revoking

Every call is recorded with the package, the method, the board or machine id and the outcome (`extensions_runtime_workspace_cloud_activity`),
never a value or a credential; the log keeps the newest 200. A grant that is revoked or narrowed between admission and the
effect changes nothing, and unrelated boards and machines keep working. Disabling, uninstalling, safe mode and a stopped
service end the package's waiting confirmations (`extensions-runtime-workspace-cloud-end`). With no extension installed,
disabled, or in safe mode, the moodboard and machine controls behave exactly as the original.

## Rich panels

The methods are service methods. A rich panel reaches the same operations through its package's service over the duplex
channel; there is no separate panel API for them.

## Refusal-test reconciliation

The rows Q018, Q085, Q086, Q087, Q110, Q111 and Q112 refuse a contributed UI action at a protected location (`sync`,
`target-cloud`, `delete-confirm`, `cloud-start`, `image-remove`, `attach`, `file-picker`, `credentials`). That stays: a
declarative contribution has no user gesture. What this slice adds is the service path above, under the named permission, and
`tests/extensions-runtime-workspace-cloud.spec.ts` asserts it granted, narrowed, revoked, confirmed and declined. The refusals
it retains and the reason of each are in that file's header.
