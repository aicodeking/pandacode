# Project explorer (the Files tab)

Upstream sync P6 (S0601). PandaCode 0.3.128 reworked the inspector's Files tab into a project explorer: a tree, a few
tools above it, a menu per row (New File, New Folder, Rename, Delete, Copy Path, Reveal in OS, Open in Default App)
and one create, rename and delete dialog. It is not a new panel: it extends the existing `panda.inspector.files.*`
surfaces and the `panda.files` presentation. With no extension installed, all disabled, or in safe mode, the explorer
behaves as upstream 0.3.128 (one finding below).

## What a package can do

| Member | Surface | Package can | Host keeps |
|---|---|---|---|
| Tools above the tree | `panda.inspector.files.toolbar` | contribute a button or menu; the user hides and reorders the host tools `new-file`, `new-folder`, `actions`, `collapse` and the contributed ones | `actions` (File actions) never hides: it is the pointer path to the project menu |
| Row, folder and project menu | `panda.inspector.files.context` | contribute rows after the host rows; the user hides and reorders every host row (`open`, `attach`, `new-file`, `new-folder`, `rename`, `delete`, `copy-path`, `reveal`, `open-external`) | the rows run the original handlers |
| Tree presentation | `panda.files` component (`docs/extensions/replacement.md`) | replace how entries are drawn after the user selects it; entries, selection, expansion and open go back to the host handlers | file reads and the host editor |
| Create, rename, delete dialog | none (`panda.dialog.explorer-entry`) | nothing: it is the host confirmation | the unsaved-edit guard and the irreversible deletion choice |

The menu is one: the toolbar and row buttons, the right-click and Shift+F10 / ContextMenu all open it. Files lead with
Open file and Attach file, as the Files tab menu always did, then the upstream rows.

### Captured context

A menu captures, when it opens, `{ projectId, sessionId?, revision, selection: { kind, ids } }` where `kind` is
`file`, `folder` or `project` and `ids` holds the project-relative path (the project id for the root). File content and
absolute paths are not sent. A contributed row is visible by condition, for example `selection.kind eq file`. The menu
closes and runs nothing when the task or project changes, the tree is redrawn for another revision, the row goes away
or an extension is enabled, disabled or removed: a stale target is never acted on, including the host rows.

### Layout

Hide, reorder and restore are the user's, by project or globally, in Settings > Extensions (Control order, Visibility
and recovery) and persist in the layout store. They apply to the original nodes and menu rows: listeners, the roving
keyboard (Arrow keys, Home, End, F2, Delete) and focus stay. A hidden control hands focus to the next visible row;
disabling or uninstalling a package removes its contributions and keeps the user's choices for the host controls;
Reset restores the built-in tools and order; safe mode shows the built-in tools in the built-in order.

### Faults

If opening the extension surface throws (a failing import or a faulted package) the built-in menu opens without the
contributions and a notice says so; the tree, the task and the draft are untouched.

## Zero extensions and one finding

Zero extensions, all disabled and safe mode share one path. The finding: the extension build's Files tab right-click
opened its own two-row menu (Open file, Attach file) while upstream's explorer opened its menu, so a file row showed two
menus after the merge. They are one menu now. The extension build's tests (Open file on the Files context, the
`panda.inspector.files.context` order and hide) and upstream's (`tests/file-explorer.spec.ts`) both hold; the cost to
the original is the two leading rows on a file.

## Handoffs to the runtime phases

These need runtime abilities that do not exist yet. They are named handoffs, not refusals, and this adapter does not
claim them delivered (rows go to S07C and are consumed by R1212):

| Capability | Owner |
|---|---|
| Package-supplied tree entries, decorations and virtual folders | R0205 (live contributions) |
| Package-driven selection, expansion and refresh of the host tree | R0205 (live contributions, duplex channel) |
| Package-initiated file create, rename, delete and move (host confirmation for irreversible deletion by default, off per package by the user) | R0405 (projects) |
| Package file-type editors that open in place of the host editor | R0901-R0903 (editors) |

Reads of project files already go through the scoped file grants; no core filesystem command is a stable API.

## Evidence

Kept apart, none stands in for another:

- Browser preview (synthetic project, preview install flow): `tests/upstream-explorer-extensions.spec.ts` in Chromium and
  WebKit, fixture `tests/fixtures/extensions/upstream-explorer/manifest.json`: install and enable through Settings >
  Extensions (`?upstream-explorer`), a file and folder row action, a toolbar action, stale rejection, hide, reorder and
  restore, keyboard and focus, disable and uninstall cleanup, grant and revoke of `ui.customize`, fault fallback, safe
  mode, then the same with no package.
- Native: the host commands behind the explorer (`manage_workspace_entry`, `open_workspace_file`,
  `write_workspace_file`) are unchanged and not exposed to packages; their tests are `src-tauri/src/workspace/explorer.rs`.
  Native validation of this manifest runs in the final test phase.
- Installed WebView: not claimed. The installed Windows acceptance is separate and pending.

Ledger rows closed: `src/file-explorer.ts`, `panda.dialog.explorer-entry`, `src/main.ts#file-menu`,
`src/main.ts#new-workspace-file`, `src/main.ts#new-workspace-folder` (adapter `panda.explorer`). The dock button
`toggle-files` is with S0602.
