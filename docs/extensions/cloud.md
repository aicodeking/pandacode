# Cloud machine presentation v1 (experimental)

## Decision

Before v1, cloud agents (`src/cloud-agents.ts`, dispatched by `src/main.ts`) privately
owned the Run on menu's cloud rows and setup entry, the fixed cloud chip, the status
strip above a cloud task's composer, the Cloud machine menu and the delete
confirmation, with no public state, action or replacement contract. v1 adds an
explicitly selected `panda.cloud` closed `controls-below` recipe with
`host-machine`, `host-targets`, `original-actions`. It moves the original status
strip below the composer; it does not move the menu, the dialog, the chip, the send
that provisions a machine, provider credentials or native cloud policy. Arbitrary
renderers, selectors, provider keys or tokens, regions, machine names, error
details, prompts, copied start/sync/stop/delete handlers and public "start",
"connect" or "confirm delete" actions are rejected: each would let a package spend
money, enter or read credentials, provision a machine the user did not ask for,
bypass the delete confirmation or retarget an operation to another task.

## Contract and policy

`cloudPresentation` and `cloudAction` are bounded JSON v1 contracts shared by the
schema, SDK (`CloudComponent`, `CloudPresentation`, `CloudAction`), native
validator and catalog. They capture window, mount, project, task, provider (the
task's provider, or the provider chosen in Run on for a New task) and machine as
opaque handles plus a revision; a task switch, a new Run on choice or a deleted
machine changes them, so an older request is refused as `StaleContext` instead of
being retargeted. Progress, pending actions and the confirmation move the revision
even while no package reads it. `mode` is `none`, `choice` (a New task that can
choose a cloud target) or `task` (a cloud task). Stage, pending machine action,
open delete confirmation, offline, error, harness support, the number of ready
providers and truncation are explicit; at most 64 eligible controls are returned.
The provider label requires `connections.summary`. No keys, tokens, regions,
machine names, error details, prompts, raw IDs, selectors or IPC cross the
contract. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current
mount/identity/revision, a currently eligible and enabled host control with the
same resource, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`,
`StaleContext`, `AlreadyApplied`, `Busy`, `Offline`. Controls the original menu
disables (Sync while syncing, Stop while stopped) and controls the user hid stay
`UnsupportedCapability`. While a machine action is pending for the task or any host
dialog is open, everything except the open confirmation's own cancel is `Busy`.
Only `sync`, `retry`, `open`, `stop` and `delete` reach the provider and are
`Offline` without a network; choosing a target, setup and the menu work offline.

`target-cloud`, `sync`, `retry`, `open`, `stop` and `delete` need independent
host-user cloud machine control consent, granted from a row in the original Cloud
machine or Run on menu and scoped to the activation, and then a fresh host choice
("Extension requested a cloud action"). `target-cloud` only marks where the next
message runs, exactly like the user's own Run on choice; the user still sends, and
nothing is provisioned. `delete` opens the original confirmation after that choice.
`target-setup` opens Settings → Cloud sandboxes, where the user connects a provider.
`machine-menu` opens the original menu and `delete-cancel` closes the open
confirmation.

## Protected policy

The fixed cloud chip, the delete confirmation, the send that creates and prepares a
machine and provider credential entry are catalogued in the inspect-only
`panda.cloud.protected` location. The schema has no `delete-confirm`,
`cloud-start` or `credentials` control, so they cannot be forged, invoked or
replayed; the protected location is not a layout location. Discovery, install,
enable and selection never call a cloud command, set up a provider, poll, provision
or fall back to another target. The host now runs one machine action per task at a
time: a repeated sync, stop or delete while one is pending (including an open
confirmation) is refused with a notice, never started twice, and it stays with the
task it was chosen on when the user switches tasks. Native cloud commands, the
supported harness list and provider policy are unchanged.

## Presentation and recovery

`panda.cloud.controls` catalogs the strip's status and menu button; their order
and reversible visibility are written into the host strip markup, so a progress
redraw keeps them and keyboard focus stays on the same control.
`panda.cloud.targets` orders and hides the Run on cloud provider rows and setup
entry as two groups after the other computers. `panda.cloud.actions` holds the
original machine menu rows plus shared contributed entries, with order and
visibility; the consent row stays pinned. `panda.cloud.context` is the strip and
chip context menu (right click, Shift+F10 or the menu key) with the same rows plus
contributed entries; it opens only while a provider is selected or a package
contributes there. Conflict never auto-selects; future contract versions are
disabled. Fault, disable and safe mode restore the built-in layout without closing
the open confirmation, changing the selected task or Run on choice, or repeating a
pending action. Browser fixtures use the preview cloud mock with a preview-only
key; they are not installed-native qualification and never reach a real provider,
spend money, stop or delete a machine.
