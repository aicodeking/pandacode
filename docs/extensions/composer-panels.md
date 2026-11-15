# Composer queue, token saver and council panels v1 (experimental)

## Decision

Before v1 the main message queue (`src/message-queue.ts`), the token saver panel (`src/token-saver-panel.ts`) and the
council strip and panel (`src/council-panel.ts`) had no extension hook: no public registry, order, visibility,
contributed actions or captured action. Their tray buttons became customizable with the
[composer controls](composer.md). v1 adds, owned by `src/extensions/composer-panels-core.ts` (registry
`PANELS_REGISTRY`, admission) and `src/extensions/composer-panels-host.ts` (presentation, slots, captured actions):

- `panda.composer.queue.controls`: each main queue row's Steer, Send now and Edit, ordered among themselves (Delete
  stays last), and the heading's Resume, which hides in place. Hidden controls keep their node, out of view and inert;
- `panda.composer.queue.actions`: a slot leading each main queue row's actions, captured with
  `selection.kind = "queue-entry"`, `ids = [entry]` (never the text). The By the way panel's queue keeps its own
  contract (`panda.btw.queue`, [BTW](btw.md)) and is not affected;
- `panda.composer.saver.controls`: the token saver panel's Tighten (hides in place in its hint line), Start new threads
  like this and Turn all off (ordered in the footer, both hide);
- `panda.composer.saver.actions`: a slot above the open panel's footer, captured with `selection.kind = "token-saver"`,
  `ids = [task]`;
- `panda.composer.council.controls`: the strip's disclosure and reviewer rows (hide in place; the state still reads on
  the tray button and the Agents flyout, whose rows still open reviewers), and the Council panel's Target score, Max
  rounds and Reviewers rows, ordered in the panel (Target score never hides; a compact panel opened from the strip
  always shows its row);
- `panda.composer.council.actions`: a slot in the strip's head, captured with `selection.kind = "council-cycle"`,
  `ids = ["<task>:<cycle start>"]`;
- `panda.composer.panels.protected`, inspect-only: deleting a queued message, saving or cancelling an edit, queue
  order and delivery, queued text and attachments, pack switches and the Caveman intensity, installing RTK, Keep
  fixing / Accept and finish / Dismiss, and Council's on/off, target and rounds;
- the `composerPanelsPresentation` / `composerPanelsAction` contracts for captured actions.

The panels redraw with `morph` (token saver, council strip) or with the composer (queue), so the user's order and
visibility are part of the markup each draw makes, and mounted slot actions are carried across a redraw with their
focus. With nothing contributed and no layout, the markup is the zero-extension markup.

Rejected alternatives: package-rendered panels (would copy the queue's drag, Alt+arrow and hold handling and move
send, delete and the council's decisions out of the host); hiding Delete, Save or Cancel (the user could no longer end
an edit or remove a message); hiding pack switches or the Target score (the panel's purpose); per-pack or per-reviewer
layout items (dynamic per thread and per cycle); DOM moves after each draw (a `morph` redraw would replace the moved
nodes and drop focus); a new composer recipe (the T33 `toolbar-first` provider is reused as the owner of captured
actions).

## Captured actions

The owner is the selected, unfaulted `panda.composer` provider (`toolbar-first`). A `composerPanelsAction` carries the
opaque window, mount, project, task and revision of the `composerPanelsPresentation` it was built from, plus a control
handle and its resource: the entry for queue entry controls (an edit makes it a new resource), the task's saver for
saver controls and the council cycle for council controls. Editing, moving, sending or removing an entry, a new hold,
opening or redrawing the saver panel, a new council state or cycle, switching task or any redraw changes the revision:
an older request is `StaleContext`.

| Control | Effect |
| --- | --- |
| `queue-edit` | Opens the original editor on the captured entry. |
| `queue-steer`, `queue-send-now`, `queue-resume` | Show a fresh host choice ("Extension requested a composer panel action"); Continue runs the original Steer, Send now (its own title says whether it steers, sends or stops the run first) or Resume handler for the same task and entry. Escape declines. |
| `saver-tighten`, `saver-default`, `saver-off` | The same fresh choice, then the original Tighten, Start new threads like this or Turn all off handler; the panel stays open. |
| `council-strip-toggle`, `council-open-worker` | Run the original disclosure or open the reviewer. |
| `council-lower-target`, `council-raise-rounds` | Open the original compact Council panel, where only the user's own choice changes the council. |

`queue-remove`, `queue-save`, `queue-cancel`, `queue-reorder`, `saver-pack`, `saver-level`, `saver-install`,
`council-accept`, `council-dismiss`, `council-keep-fixing` and `council-set` are refused with `PermissionDenied`
before any other check. Other reasons: `Revoked` (safe mode, fault, disable, another owner's identity), `WrongOwner`,
`InvalidArguments`, `UnsupportedCapability` (disabled or hidden control, other contract version), `Busy` (an open
picker, menu, dialog or host choice), `AlreadyApplied`.

## Recovery

Fault, disable, another selected provider and safe mode restore the built-in panels: queued messages, their order and
hold, an open edit, the council cycle, the draft and focus stay; no send, steer, resume, removal or council decision is
repeated. Safe mode restores built-in order and visibility without deleting the stored preferences. Installed WebView
qualification is not claimed; evidence is the browser preview (`tests/extensions-composer-panels-coverage.spec.ts`,
Chromium and WebKit), the Node contract tests (`tests/extensions-composer-panels.test.mjs`) and native
contract/package tests.
