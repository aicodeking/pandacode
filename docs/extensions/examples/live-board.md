# Example: the Work board, cuts A and B (a background service with a live interface and a rich panel)

Task R1201. One installable package, `sample.live-board` (`examples/extensions/live-board/`), the reference example of the
runtime phases R1 and R2: a trusted background service that reads a tracker daemon and keeps a status item, a table, a Retry
button and a dialog answer up to date. Cut B (R1202, below) grows the same package with the rich panel; no task is started (cut C).

## What the package does

| Part | What it shows |
|---|---|
| Status item `sample.live-board/ready` | `N ready`, where N is the length of the daemon's own `readyIds` (never derived by the package); tone `success` when N > 0; the tooltip counts issues and blocked ones and names who is working. |
| View `sample.live-board/board` | A table with one row per issue (Issue, Title, Status, Assignee), at most 100 rows; ready and blocked come from the daemon. |
| Offline | The last snapshot stays, marked stale: the status item reads `Tracker offline` (tone `warning`), the table label and the view text say `stale since <time>`, a notice names the package, and a **Retry tracker** button appears in the workspace header. Before any snapshot exists the view shows a list that says nothing is known, never an empty table. |
| Retry | The button runs `sample.live-board/retry`, a command handled inside the service. It reconnects and reads again; the button is disposed and the notice withdrawn as soon as a read succeeds, with or without a click (the service also reconnects by itself with a short backoff). |
| Dialog | **Who is working** (`sample.live-board/who`, or a signal `{ "op": "ask" }`) asks for a name; a confirmed answer is kept in the service state and shown in the status tooltip, a cancelled one changes nothing. |
| Settings | Page `sample.live-board/tracker`: the tracker address (`host:port`) and the name of the ready count. A save re-reads the page (`settings.changed`); a new address reconnects. |
| Task and project switches | `task.shown`, `project.opened` and `project.closed` are counted and change nothing: the board is one tracker and rebuilds nothing. |

Signals of the daemon: `{ "op": "refresh" }` reads again, `{ "op": "ask" }` opens the dialog, `{ "op": "state" }` rewrites the
status line. `issues.changed` events read again on their own (one read at a time; a change during a read makes exactly one
more). Snapshots that arrive in chunks are assembled.

## How it is built

- `package/lib/board.mjs`: all of the logic, as one browser-safe ES module (no imports, no Node, nothing but the `panda` it is
  handed). It talks to the tracker through a small `link` (`request`, `subscribe`, optional `onDown`, `onUp`, `reconnect`,
  `retarget`).
- `package/main.cjs`: the installed transport, a newline-delimited JSON client over TCP with a 1.5 s request timeout, reconnect
  and backoff (250, 500, 1000 ms). The address comes from the settings page; `PANDA_FIXTURE_B1` is the address a test hands in.
- The browser preview builds the same `link` from `panda.daemon`, the replaced backend of the preview runner
  ([runtime-preview](../runtime-preview.md)), so one file is tested in both places.
- Permissions: `ui.contribute`, `runtime.service`, `events.workspace`, `ui.dynamic`, `ui.notify`. Services start with the
  application ([service lifetime](../runtime-service-lifetime.md)); live items, dialogs and notices follow
  [dynamic items](../runtime-dynamic-items.md), [dialogs](../runtime-dialog-navigation.md) and
  [notifications](../runtime-notifications.md).

## Evidence

Preview evidence, not native: `tests/extensions-example-live-board.spec.ts` (Chromium port 16171, WebKit 16172) runs
`lib/board.mjs` in the preview runner against B1's browser-importable core: counts and rows within 2 s, the stale snapshot, the
Retry click and the button leaving after recovery, the dialog answer, settings and switches, permission loss, and every stop
reason. It never proves the installed package.

Native evidence: `src-tauri/src/extensions/runtime_live_board_acceptance.rs` (pasted into the `installed` tests of
`runtime_service_lifetime.rs`, feature `extension-runtime-native-tests`, Windows x64) installs the package through the real
package flow and runs it with the B1 fake daemon and the B2 fake command-line tool: B2 creates an issue and the board follows
within 2 s; a control change plus a signal; a B1 `refuse` fault gives the stale table and the Retry button, a click reaches
the service, and recovery removes the button; the dialog answer reaches the service state; safe mode, disable, crashes with
backoff, parking after five in ten minutes, retry and quit each leave no live item behind. Its fixture
`tests/fixtures/extensions/example-live-board/main.cjs` only adds a crash command around the shipped files.

Both were written for the final test phase and not run when written. The receipt keeps the preview, native and installed
columns apart; an installed-app run (the real window) stays pending until it is made.

## Cut B: the rich panel (R1202)

The same package, the same service and manifest (no second package). One more permission, `ui.richViews`, and the view
`sample.live-board/board` becomes a folder panel (`panel/index.html`, `panel/app.js`, inspector placement) with the host-rendered
table of cut A kept as its fallback. See [rich channel](../runtime-rich-channel.md), [assets](../runtime-rich-assets.md),
[focus](../runtime-rich-focus.md), [panel only](../runtime-panel-only.md) and [Windows qualification](../runtime-platform-qualification.md).

| Part | What it shows |
|---|---|
| Data channel | The service sends the panel `board.begin` (counts, the daemon's own `readyIds` and `blockedIds`, the stale marking, the undo on offer, the last refusal) and then `board.rows` chunks of 200 issues. The panel never derives ready or blocked and never reads the tracker. A panel that opens gets the current board, to its instance only; every change reaches all instances. A tracker change shows up in the panel within 2 s. |
| Board and detail | A windowed list (only the rows in view are in the page), selection with click and arrow keys, a detail pane filled by one `show` of the tracker tool. Selection and scroll position live in `pandaView.state`, so they survive hiding and a reload. |
| Claim, Close, Undo | The panel asks; the service runs the tracker's command-line tool (`claim`, `close`, `reopen`, `update`, `show` as an argument array, no shell; `PANDA_FIXTURE_B2` names the B2 fake tool in tests) and reads the board again. A malformed id never reaches the tool. |
| Undo after a change | Undo of a close is `reopen --if-revision=<revision after the close>`: the tracker answers `Conflict` when the issue moved. Undo of a claim reads the issue first and leaves it alone when its revision moved (`update` has no revision guard). Either way the refusal is a result in the panel and a notice in the board (`T-1 changed since you closed it; the undo was refused.`), the issue is untouched and no second undo is offered. |
| 2,000 issues | B1 chunks the snapshot (`issues.chunk`); the service assembles it and sends the panel 10 messages of 200 rows, each far under the 256 KiB bound. The page draws about 30 rows. Fixture: `tests/fixtures/extensions/example-live-board/issues-2000.json` (or B1 `POST /control/issues/fill {count: 2000}`). |
| Offline | The last snapshot stays in the panel with a stale banner (`stale since <time>`); Claim, Close and Undo answer `Unreachable`; recovery removes the banner. A tracker never read is `board.unknown`, never an empty board. |
| Containment | A panel message the service does not know is ignored; an error in the panel's page fails that panel (Reload panel), not the service or an agent task; disable, revoke, safe mode and stop remove the instances and the live items. |

Limits: the Undo of a claim has a small window between its `show` and its `update`; the native acceptance test of cut A grants four
permissions and not `ui.richViews`, so there the panel calls are recorded refusals and the rest of the board runs unchanged.

### Evidence columns of cut B

Preview, installed Windows and both engines are kept apart (`tests/fixtures/extensions/example-live-board/evidence-columns.json`).
All of them are **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation.

- Preview: `tests/extensions-example-live-board.spec.ts`, tests named `live board preview:` (they run in Node with B1's browser-importable
  core, B2's own argument parser and the R0303 `PreviewPanelHost`). Chromium port 16521, WebKit port 16522.
- Installed Windows: the R0306 runner `tests/fixtures/extensions/runtime-windows-panels/qualify.mjs --build` on a dedicated profile,
  reused, not copied. Its fixture seeds, scenarios (data channel, assets/state/focus, claim/close/undo, scale, offline, failure
  containment, disable/revoke/safe-mode cleanup) and expectations are listed in the evidence-columns file. Adding the package to the
  runner's `stage.mjs` and `expected.json` is a final-phase edit of R0306's files. R3 closes for the board only after that run passes.

## Limits of this cut

- The last snapshot lives in the service's memory: a restart that finds the daemon away shows "unknown", never a stale table
  from an earlier run (private storage is a later cut).
- A settings change or a switch is checked in the preview; natively their delivery is proven by the workspace-events slice.
- Cut A alone had no panel; cut B is below. No Start: cut C.
