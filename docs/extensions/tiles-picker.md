# Thread tiles and the draft project picker v1 (experimental)

## Decision

Before v1 two workspace views had no extension hook: no public registry, order, visibility, contributed actions or
captured action. They were the thread tiles (`src/thread-tiles.ts`: the focused thread plus up to `MAX_TILES - 1`
read-only mirrors, each with a bar holding Close view and the title, and a mirror's "Ask for follow-up changes…"
button) and the draft project picker (`showProjectPicker` in `src/main.ts`, opened by the `change-task-project` action
on a new task's heading, drawn by `src/project-picker.ts`). v1 adds, owned by `src/extensions/tiles-picker-core.ts`
(registry `TILES_PICKER_REGISTRY`, admission) and `src/extensions/tiles-picker-host.ts` (order, visibility, slot
markers, captured actions):

- `panda.workspace.tiles.controls`: a tile bar's Close view and title, and a mirror's follow-up button. Close view and
  the title reorder inside the bar; Close view hides; the follow-up button hides in place; the title never hides;
- `panda.workspace.tiles.actions`: a slot at the end of every tile bar, captured with `selection.kind = "tile"`,
  `ids = [<the tile's own thread>]` and that thread's own project and session, never the focused thread's. It is a
  host marker mounted by `src/extensions/thread-actions.ts`, so a closed tile disposes its actions at once. Clicking a
  contributed action neither focuses nor closes the tile;
- `panda.workspace.project-picker.entries`: the picker's entries. No project orders before or after the other projects
  and hides (never while it is the draft's current project); Open project… hides in place; the draft's current project
  (`current`, inspect-only) and the other projects never hide;
- `panda.workspace.project-picker.actions`: a slot in the picker's footer, captured with
  `selection.kind = "draft-project"`, `ids = [<draft>]`, the draft's project and the revision at open (never the draft
  text). A contributed action's dialog keeps its captured draft after the picker closes;
- `panda.workspace.tiles-picker.protected`, inspect-only: input to a tile, tile placement, size and count, tile rows
  and streaming text, the draft and its attachments, moving the draft to another project, the picker's search text and
  opening a new project folder;
- the `tilesPresentation` / `tilesAction` and `projectPickerPresentation` / `projectPickerAction` contracts for
  captured actions.

The adapter touches a tile bar only when a package contributes to `panda.workspace.tiles.actions` or the user arranged
`panda.workspace.tiles.controls`, and the picker gets an extension only when a package contributes to its footer or
the user arranged its entries; otherwise, and in safe mode, the bars and the picker are exactly as the host draws
them (no marker, attribute or footer slot). Hidden controls keep their node, out of view and inert. `MAX_TILES`, the
tile rectangles (`tile-layout.ts`), drag placement, the saved tile list, mirrors' read-only rows, search, keyboard,
IME, Escape and the picker's own selection are unchanged.

Rejected alternatives: a package-rendered tile bar or picker (would copy the focus switch, tile layout, project list
and the draft's move); per-project layout items (project ids are dynamic and may start with a digit); hiding a tile's
title, the current project or the other projects (the views' purpose); letting packages type into a tile, read its
rows, open, move or resize tiles, read the draft or move it directly (protected); a new recipe (the selected
`panda.transcript` and `panda.composer` providers are reused as owners).

## Captured actions

Tile actions are owned by the selected, unfaulted `panda.transcript` provider (`timeline`): tiles show transcripts.
Picker actions are owned by the selected, unfaulted `panda.composer` provider (`toolbar-first`): the draft is the
composer's. A `tilesAction` carries the opaque window, mount, focused thread's project and task and revision of the
`tilesPresentation` it was built from, plus a control handle and its resource (the tile). A `projectPickerAction`
carries the draft's project, the draft and the revision, plus a control and its resource (the draft or a listed
project). The tiles' presentation lists the tiled threads' opaque handles in order; the picker's says whether it is
open, whether the draft has text and how many projects it lists; never titles, rows, the draft text, the search text
or project names. Another focused tile, a closed tile, an edited draft, another search, another current project or any
redraw of a control changes the revision: an older request is `StaleContext`.

| Control | Effect |
| --- | --- |
| `tile-focus` | The tile's original title: an ordinary thread switch (focusing the focused tile focuses its composer). |
| `tile-composer` | A mirror's original follow-up button: focuses that thread, then its own composer. Nothing is typed or sent. |
| `tile-close` | Shows a fresh host choice ("Extension requested a tile action"); Continue runs the original Close view for the same tile while the same thread is focused. Escape declines. |
| `picker-toggle` | The original Change task project trigger: opens or closes the host's picker. |
| `picker-open` | The picker's original Open project…: the host's folder dialog, where the user chooses. |
| `picker-select` | The same fresh choice ("Extension requested a project change"); Continue runs the picker's own choice (`chooseTaskProject` in `main.ts`) for the same draft, current project and target. |

`tile-send-input`, `tile-read-rows`, `tile-open`, `tile-move`, `tile-resize`, `picker-move`, `picker-read-draft`,
`picker-set-search`, `picker-create-project` and `picker-clear-attachments` are refused with `PermissionDenied` before
any other check: a mirror is read-only and only the user's own choice, or a fresh host choice, moves a draft. Other
reasons: `Revoked` (safe mode, fault, disable, another owner's identity), `WrongOwner`, `InvalidArguments`,
`UnsupportedCapability` (disabled or hidden control, such as the focused tile's follow-up button, other contract
version), `Busy` (an open dialog, menu, drag, pending project change or host choice), `AlreadyApplied`.

## Recovery

Fault, disable, another selected provider and safe mode restore the built-in bars and picker: the focused thread, the
mirrors, the draft and its project stay; no view closes and the draft does not move (a fault between a request and its
Continue moves nothing). Safe mode restores built-in order and visibility without deleting the stored preferences.
Installed WebView qualification is not claimed; evidence is the browser preview
(`tests/extensions-tiles-picker-coverage.spec.ts`, Chromium and WebKit), the Node contract tests
(`tests/extensions-tiles-picker.test.mjs`) and native contract/package tests.
