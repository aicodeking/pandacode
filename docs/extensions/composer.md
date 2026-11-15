# Composer tray controls, model picker, Permissions menu and steer bar v1 (experimental)

## Decision

Before v1 the composer had three accessory slots (`panda.composer.actions`, `panda.composer.tray`,
`panda.composer.attachments`) and the T33 `toolbar-first` recipe that moves the whole tray above the
input. The tray's own controls, the model picker's entries, the Permissions (approval mode) menu and the
steer bar had no public registry, order, visibility, contributed actions or captured action. v1 adds:

- `panda.composer.tray.controls`: the model picker, approval mode, agent team, token saver, council and
  Run on, with order among the tray tools and reversible visibility on the original nodes. The model
  picker and the approval mode never hide (the approval mode is the visible indicator of what the agent
  may do without asking; the model picker is the composer's only view of the harness and opens provider
  recovery). Run on sits with the checkout and branch chips: it hides in place and does not reorder;
- `panda.composer.model.entries`: the model picker rail's Recent, Teams and built-in harness entries,
  with order in their own slots and reversible visibility. Hidden entries leave the rail only: search
  still covers every harness. The task's current harness and a selected team never hide; package
  harnesses keep their entry (their identities are not layout item ids);
- `panda.composer.model.actions`: a host-drawn action row under the picker's list (reached with Tab),
  captured with `selection.kind = "model"`, `ids = ["<harness>:<model>"]`;
- `panda.composer.permissions.actions`: contributed rows in the Permissions menu after its modes. Every
  approval mode is pinned (keeps its row and order); the menu's context is `selection.kind =
  "approval-mode"`, `ids = [current mode]`. With nothing contributed the menu keeps its zero-extension
  radio rows;
- `panda.composer.steering.actions`: a slot in the steer bar, captured with `selection.kind = "draft"`,
  `ids = [task]` (never the draft text), and `panda.composer.steering.controls` (Edit draft, Steer,
  Clear draft) with order and reversible visibility; Steer never hides;
- `panda.composer.protected`, inspect-only: approval-mode changes, harness/model/effort/team changes,
  Send and Stop, the draft and its attachments, approval answers;
- the `composerPresentation` / `composerAction` contracts for captured actions.

Rejected alternatives: a package-rendered tray, picker or menu (would copy the editor's focus, IME and
history handling and move the model and mode choice out of the host); hiding the approval mode or the
model picker (removes the visible authority indicator and the provider recovery path); per-model rows as
layout items (the catalog is dynamic and per harness); a new composer recipe (the T33 `toolbar-first`
provider is reused as the owner of captured actions).

## Captured actions

The owner is the selected, unfaulted `panda.composer` provider (`toolbar-first`). A `composerAction`
carries the opaque window, mount, project, task and revision of the `composerPresentation` it was built
from, plus a control handle and its resource (the task's draft for steer bar parts). Editing the draft,
a new mode, switching task or any redraw changes the revision: an older request is `StaleContext`.

| Control | Effect |
| --- | --- |
| `model`, `mode` | Open the original model picker or Permissions menu. Only the user's own choice there changes the model or the mode. |
| `team`, `saver`, `council`, `run-target` | Open their original menu, panel or picker. |
| `steer-edit` | Focuses the prompt. |
| `steer`, `steer-clear` | Show a fresh host choice ("Extension requested a composer action"); Continue runs the original Steer or Clear handler for the same task and draft. Escape declines. |

`mode-set`, `model-set`, `effort-set`, `team-set`, `send`, `stop`, `approve` and `deny` are refused with
`PermissionDenied` before any other check: a package never changes the approval mode or the model
without the user's choice. Other reasons: `Revoked` (safe mode, fault, disable, another owner's
identity), `WrongOwner`, `InvalidArguments`, `UnsupportedCapability` (disabled or hidden control, other
contract version), `Busy` (an open picker, menu, dialog or host choice), `AlreadyApplied`.

## Recovery

Fault, disable, another selected provider and safe mode restore the built-in composer: the prompt node,
its draft and undo history, the selected model, the approval mode, a running turn and focus stay; no
send, steer or stop is repeated. Safe mode restores built-in order and visibility without deleting the
stored preferences. Installed WebView qualification is not claimed; evidence is the browser preview
(`tests/extensions-composer-controls-coverage.spec.ts`, Chromium and WebKit), the Node contract tests
(`tests/extensions-composer-controls.test.mjs`) and native contract/package tests.
