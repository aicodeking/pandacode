# Transcript extras: attachments, find, turn changes and the usage-limit card v1 (experimental)

## Decision

Before v1 four transcript surfaces had no extension hook: no public registry, order, visibility, contributed actions
or captured action. They were a sent message's attachment chips (`src/message-attachments.ts`, opened by
`open-message-attachment` in `src/main.ts`), thread find (`src/thread-find.ts`, ⌘F), a turn's changes card and footer
(`src/turn-changes.ts`: Open diff, the file rows and Run; `showTurnDiff` in `src/main.ts`) and the usage-limit card
(`src/usage-limit.ts`: Resume at reset, Continue now, Continue on <connection>, Dismiss). The attachment dialog's band
(`panda.dialog.attachment.actions`) and the Changed files dialog's band (`panda.dialog.changed-files.actions`,
[core dialogs](core-dialogs.md)) stay as they are; no second band is added. v1 adds, owned by
`src/extensions/thread-extras-core.ts` (registry `THREAD_EXTRAS_REGISTRY`, admission) and
`src/extensions/thread-extras-host.ts` (order, visibility, slot markers, captured actions):

- `panda.thread.attachments.controls`: a sent message's chips by kind (project files, documents, folders, images,
  GitHub items, other context). Chips of a kind reorder and hide together; each shown chip still opens its own
  attachment;
- `panda.thread.attachments.actions`: a slot after a message's chips, captured with
  `selection.kind = "message-attachment"`, `ids = ["<message>:<index>", …]` (never names, paths or contents);
- `panda.thread.find.controls`: the find bar's match count, Previous, Next and Close. They reorder in their own places
  (the field stays first) and the first three hide; Close never hides;
- `panda.thread.find.actions`: a slot after the find field, captured with `selection.kind = "find"`, `ids = [task]`
  (never the query). It mounts after the field took focus and never moves it;
- `panda.thread.changes.controls`: Run and Open diff in the changes card's actions and in the turn card's footer. They
  reorder in their own places; Run hides; Open diff never hides;
- `panda.thread.changes.actions`: a slot in the card's actions or the footer, captured with
  `selection.kind = "turn-changes"`, `ids = [<turn change set>, …changed paths]` (at most 99 paths). A turn's slot keeps
  naming that turn after a new turn streams;
- `panda.thread.usage-limit.controls`: the card's Resume at reset, Continue now and Continue on <connection>, which
  reorder in their own places, and Dismiss, which stays last. Resume at reset and Continue on <connection> hide;
  Continue now and Dismiss never hide;
- `panda.thread.usage-limit.actions`: a slot before Dismiss, captured with `selection.kind = "usage-limit"`,
  `ids = [<harness>]`;
- `panda.thread.extras.protected`, inspect-only: attachment contents, image data and paths; the find text, matches and
  highlights; patch bodies and file contents; the usage limit, its reset and held work; moving the task to another
  connection or provider;
- the `threadExtrasPresentation` / `threadExtrasAction` contracts for captured actions.

The adapter touches the transcript only when a package contributes to one of the four slots or the user arranged one
of the four control locations; otherwise, and in safe mode, every row stays exactly as the host drew it (no marker, no
attribute, no observer). While engaged, rows the transcript or the composer draw again are arranged before they paint.
Hidden controls keep their node, out of view and inert. The slots are host markers mounted by
`src/extensions/thread-actions.ts`, beside the existing thread slots, so a removed row disposes its actions at once.
Contributed actions are never find matches (`findRanges` skips extension slots). Find matching, the CSS Custom
Highlight API, Enter/⇧Enter/Escape with `isImeKey()`, the reader's scroll intent, diff loading and the usage-limit
semantics are unchanged. The By the way panel's and tiles' chips are not part of v1.

Rejected alternatives: a package-rendered find bar, chip row, changes card or limit card (would copy the find
matching, the attachment parser, the diff viewer and the recovery logic and move contents out of the host); hiding
Close, Open diff, Continue now or Dismiss (the surfaces' purpose or the user's way out); per-chip layout items
(dynamic per message); letting packages read attachment contents, set the query, read diffs or assign a connection or
provider (protected); a new transcript recipe (T33's `timeline` provider is reused as the owner of captured actions).

## Captured actions

The owner is the selected, unfaulted `panda.transcript` provider (`timeline`). A `threadExtrasAction` carries the
opaque window, mount, project, task and revision of the `threadExtrasPresentation` it was built from, plus a control
handle and its resource: the message's attachment for a chip, the task's find for find controls, the turn for Open
diff and Run, the turn and path for a card's file row, the limit (its reset and Resume at reset) for usage-limit
controls and the connection for Continue on <connection>. The presentation carries how many chips show, whether find
is open, opaque turn handles and whether the limit card shows with an opaque harness handle; never names, paths,
the query, patches or connection names. Another query, a new or removed changes card, a changed limit, switching task
or any redraw of a control changes the revision: an older request is `StaleContext`. Streaming text does not.

| Control | Effect |
| --- | --- |
| `find-previous`, `find-next`, `find-close` | Step or close the original find bar; focus and the field's text stay. |
| `changes-open`, `changes-file` | Open the original Changed files viewer for the captured turn (and path). |
| `attachment-open` | Shows a fresh host choice ("Extension requested a transcript action"); Continue runs the chip's original handler (preview, open or reveal). Escape declines. |
| `changes-run` | The same fresh choice, then the original Run (`pandacode-run.sh`). |
| `limit-continue`, `limit-switch`, `limit-dismiss`, `limit-resume` | The same fresh choice, then the card's original Continue now, Continue on <connection>, Dismiss or Resume at reset switch for the same task and limit. |

`attachment-read`, `attachment-reveal`, `find-set-query`, `find-read-matches`, `changes-read-diff`, `limit-set`,
`limit-assign-connection` and `limit-switch-provider` are refused with `PermissionDenied` before any other check. Other
reasons: `Revoked` (safe mode, fault, disable, another owner's identity), `WrongOwner`, `InvalidArguments`,
`UnsupportedCapability` (disabled or hidden control, other contract version), `Busy` (an open dialog, menu, IME
composition in the find field or host choice), `AlreadyApplied`.

## Recovery

Fault, disable, another selected provider and safe mode restore the built-in rows: the transcript, its scroll
position, the draft and focus stay; no attachment opens, no script runs and the limit does not change twice. Safe mode
restores built-in order and visibility without deleting the stored preferences. Installed WebView qualification is
not claimed; evidence is the browser preview (`tests/extensions-thread-extras-coverage.spec.ts`, Chromium and WebKit),
the Node contract tests (`tests/extensions-thread-extras.test.mjs`) and native contract/package tests.
