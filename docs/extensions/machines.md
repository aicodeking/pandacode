# Execution target and machine coordination presentation v1 (experimental)

## Decision

Before v1, PandaCode Connect (`src/remote-target.ts`, `src/remote-progress.ts`, dispatched by
`src/main.ts`) and multi-machine orchestration (`src/machine-orchestration.ts`) privately owned the
Run on menu's own rows (this computer, other computers, Connect setup), the fixed task computer chip,
the connection Retry, the start strip's Retry and Dismiss, the behind-GitHub confirmation, the link
request card, the Link a machine dialog and the lineage rows, waiting line and their Stop buttons,
with no public state, action or replacement contract. v1 adds an explicitly selected
`panda.machines` closed `controls-below` recipe with `host-targets`, `host-lineage`,
`original-actions`. It moves the original orchestration slot (link request cards and the waiting
line) below the composer; it does not move the Run on menu, the chip, the start strip, a dialog,
the send that starts on another computer, pairing, link or access consent, or native remote
placement. Arbitrary renderers, selectors, device IDs, fingerprints, access levels, pairing codes,
prompts, copied start/link/stop handlers and public "start", "link", "grant" or "continue" actions
are rejected: each would let a package run work on a computer the user did not choose, grant an
agent access to another computer, bypass the behind-GitHub warning or retarget an operation to
another task or computer.

## Contract and policy

`machinesPresentation` and `machinesAction` are bounded JSON v1 contracts shared by the schema, SDK
(`MachinesComponent`, `MachinesPresentation`, `MachinesAction`), native validator and catalog. They
capture window, mount, project, task and host (the computer chosen for a New task, or the fixed
computer of a task that runs elsewhere; empty for this computer) as opaque handles plus a revision;
a task switch or a new Run on choice changes them, so an older request is refused as `StaleContext`
instead of being retargeted. A presence change, pending start, open dialog, link request or thread
change moves the revision even while no package reads it. `mode` is `none`, `choice` (a New task
that can choose a computer) or `task` (a task fixed on another computer). The start state
(`checking`, `starting`, `reconnecting`, `error`), the open behind and Link dialogs, offline, an
unreachable or unpaired chosen computer, Connect sign-in, the orchestration switch, the number of
link requests (at most 16), threads and running threads (at most 64 each) and truncation are
explicit; at most 64 eligible controls are returned. The computer name requires
`connections.summary`. No device IDs, fingerprints, access levels, request reasons, thread titles,
prompts, raw IDs, selectors or IPC cross the contract. Metadata is not authority, and the displayed
computer never decides where work runs: the original handlers resolve the captured key against
host state, and native placement, grants and orchestration policy re-check it.

Actions require the selected enabled provider and `ui.contribute`, the current
mount/identity/revision, a currently eligible and enabled host control with the same resource, and
replay admission. Rejections use stable reasons: `Revoked`, `WrongOwner`, `PermissionDenied`,
`UnsupportedCapability`, `InvalidArguments`, `StaleContext`, `AlreadyApplied`, `Busy`, `Offline`.
An offline computer's row and controls the user hid stay `UnsupportedCapability`. While a start is
being checked or started, a reconnect is running or any host dialog is open, everything except the
open behind or Link dialog's own cancel is `Busy`. Only `reconnect`, `start-retry`,
`link-decline`, `lineage-stop` and `stop-all` reach the relay or another computer and are `Offline`
without a network; menus, choices, dialogs and opening a thread work offline.

`target-local`, `target-device`, `start-retry`, `link-decline`, `lineage-stop` and `stop-all` need
independent host-user machine control consent, granted from a row in the original Run on menu or
the machine context menu and scoped to the activation, and then a fresh host choice ("Extension
requested a machine action"). Choosing a computer only marks where the next message runs, exactly
like the user's own Run on choice; the user still sends, and the behind-GitHub warning still asks.
`start-retry` presses the strip's own Retry for the captured task. `computer-menu` opens the
original Run on menu, `target-setup` opens Settings → Remote access, `reconnect` is the connection
Retry, `start-dismiss` dismisses a failed start, `behind-cancel` and `link-cancel` close the open
dialog, `link-open` opens the original Link a machine dialog for that request and `lineage-open`
opens the thread.

## Protected policy

The fixed task computer chip, the behind-GitHub Continue, the send that starts on another computer,
the Link a machine submit with its machine and access choice, pairing approval, the orchestration
switch and unlinking are catalogued in the inspect-only `panda.machines.protected` location. The
schema has no `behind-continue`, `remote-start`, `link-confirm`, `pairing`, `orchestration` or
`unlink` control, so they cannot be forged, invoked or replayed; the protected location is not a
layout location. Discovery, install, enable and selection never call a remote, link or thread
command, sign in, pair, reconnect, start or change a security setting, and nothing is copied to or
granted on another computer. A pending start stays with the task it was sent from when the user
switches tasks, and the host's own guard (`configuringSessions`) still refuses a second send while
one is being checked. Native remote commands, placement (`src/extensions/remote-placement.ts`),
grants and orchestration policy are unchanged.

## Presentation and recovery

`panda.machines.targets` orders and hides the Run on menu's own groups (this computer, other
computers, Connect setup) ahead of the cloud rows (`panda.cloud.targets`, see [cloud.md](cloud.md)).
`panda.machines.controls` catalogs a link card's Not now and Link buttons; their order and
reversible visibility are written into the card markup, so a redraw keeps them and keyboard focus
stays on the same button. `panda.machines.context` is the lineage row, waiting line and fixed
remote chip context menu (right click, Shift+F10 or the menu key) with Open thread, Stop thread,
Stop all threads and Retry connection plus contributed entries, with order and visibility; the
consent row stays pinned. It opens only while a provider is selected or a package contributes there.
Conflict never auto-selects; future contract versions are disabled. Fault, disable and safe mode
restore the built-in layout without closing an open dialog, changing the selected task or Run on
choice, dropping a link request or thread, or repeating a start. Browser fixtures use the preview's
in-memory account; they are not installed-native or multi-machine qualification and never reach a
relay, pair a device or change a security setting. The Link a machine dialog accessory is T56C's.
