# Example: the SQL notebook (a custom editor over a host buffer, a new-file template, a save hook and a query service)

Task R1211. One installable package, `sample.sql-notebook` (`examples/extensions/sql-notebook/package/`), the reference example of
the document phase R9: it binds an editor to `.sql` files, creates notes from a template, records every saved file through the
hook before save and runs statements against SQLite files in a service. It follows the model of DB Studio reduced to SQLite
(no dependency: `node:sqlite` is part of the pinned runtime, no credential, no network) and takes the hook and the template
from GraphiQL. Its fake back end is B6, `make-sqlite` ([backends](../../../tests/fixtures/extensions/backends/make-sqlite/README.md)),
adopted by R0104A: a database file of 250 tracks, the integer 9007199254740993, a 1,200-byte BLOB and a table `albums`.

## What it does

| # | Behaviour |
|---|---|
| 1 | Opening a `.sql` file opens it in the package's editor with the file's text (`priority: default`, [editor selection](../runtime-document-editors.md)). The built-in editor is one click away and so is the way back. |
| 2 | A first line `-- sqlnote: db=<path relative to the project>` names the database. Without it the editor shows **Choose database** with the `.db`, `.sqlite` and `.sqlite3` files of the project; the line is written only after the service opened the chosen file. |
| 3 | Ctrl+Enter (Cmd+Enter on macOS) runs the statement under the cursor. The grid shows the columns and at most `row-limit` rows (100) with a "truncated" note for the 250-row table; the BLOB shows as `<blob 1.2 KB>`; the integer above 2^53 is exact; long text is shortened to 200 characters. |
| 4 | A failing statement shows the database's own error under the editor and the editor stays usable. A statement that runs longer than `timeout-seconds` is stopped; Cancel stops it earlier. |
| 5 | Statements that change data are refused (`WritesOff`) unless the setting **Allow writes** is on, and the database is then opened read-only; with it on, an `UPDATE` shows the number of changed rows. |
| 6 | Typing marks the tab as changed; Save asks the host, which writes the file ([save path](../runtime-document-save.md)). When the file changes on disk while the tab is unchanged, the editor shows the new text; with unsaved edits the newer disk text is kept aside and a save is refused with `Conflict` until the user chooses. |
| 7 | **New SQL note** in the new-file menu creates a file from the package's template and opens it in the editor ([templates](../runtime-new-file-templates.md)). |
| 8 | On every save the hook `sample.sql-notebook/save` records the file in **Recent notes** (a host-rendered list). It returns nothing: the save is never delayed or altered, and a failing or slow hook never blocks it. |
| 9 | The view **Databases** lists the tables of each database file (host-rendered tree). See the limit below. |
| 10 | Without `documents.editors`, with the package disabled, uninstalled or in safe mode, `.sql` files open in the built-in editor with the saved text. If the editor panel fails, the built-in editor is offered over the same buffer. |

## How it is built

- `package/lib/notebook.mjs`: the statement splitter (quotes and comments hide a `;`), the statement under the cursor, write
  detection, the header line, value shaping, and `run`, the service. It handles the editor's named messages (`run`, `cancel`,
  `databases`, `open`, `settings`) through `panda.views`, the hook through `panda.hooks.on('save.before')` and the two lists through
  `panda.ui.updateView`. It touches no disk: the driver and the folder are handed in.
- `package/main.cjs`: resolves a project-relative path under the project folder (traversal, absolute and drive paths are refused),
  lists the database files two levels deep and hands the driver in. `PANDA_FIXTURE_B6` is the test-owned folder a test hands in.
- `package/lib/driver.cjs` and `package/lib/worker.cjs`: one short-lived Node process per query (argument array, no shell, hidden
  window). Integers are read as `bigint` so values above 2^53 stay exact; a BLOB travels as its length only; the process is ended on
  timeout, cancel and service stop, which also stops a statement that never gives control back to JavaScript.
- `package/editor/`: the rich panel. It works on `pandaView.document` (the host's buffer) and never saves by itself: `onWillSave`
  delivers the pending edit, `onDidReplace` follows a disk change or a revert, `onDidSave` shows the saved revision. It never imports
  a driver and never writes a file. Placement in the original's floating editor window, with the inspector as the fallback.
- Settings page `sample.sql-notebook/settings`: `row-limit`, `timeout-seconds`, `allow-writes`.

## Evidence

All of it is **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation.

- Preview/Node, `tests/extensions-example-sql-notebook.spec.ts` (Chromium port 16701, WebKit port 16702; the spec runs in Node, so both
  engines make the same assertions): the contract, the browser-safe logic, statement splitting, write detection, header and path rules,
  values, the service with a scripted driver (results, errors, write refusal, cancel, timeout, stop, the hook), and the R0901/R0902/R0903
  twins with the package's own manifest, template and hook: create from the template, selection and the way back, save with a failing
  hook and a failing write, an external disk change with and without unsaved edits, panel failure, revoked grant, disabled package,
  reopen without the package, a byte buffer.
- The real driver: the same spec runs `lib/driver.cjs` with `node:sqlite` on a B6 file created in a test-owned temporary folder
  (truncation to 100 rows, the exact integer, the BLOB label, the database's error, timeout, cancel, writes off and on).
- Installed Windows: the scenarios listed in `tests/fixtures/extensions/example-sql-notebook/evidence-columns.json`, run with the R0306
  runner after the host wiring below exists.

## Limits of this cut

- The wiring of the editor shell and the rich channel to `DocumentEditors` / `SaveFlow`, and of the new-file menu to `NewFiles`, is
  still pending in the product; the spec drives the twins and the package, and the installed behaviour is recorded as prepared.
- Behaviour 9 as the plan words it (click a table to create a note, open it and run it) is not built: the SDK has no call for a service
  to create a project file, and a tree row carries a command but no file creation. The Databases tree lists the tables; the user makes the
  note with New SQL note.
- The SDK has no call that returns a project folder to a service: the service reads database files under its working folder (the host sets
  it to the project folder).
- Network databases and their passwords are not built on purpose; they would use `secrets.private`, which another example proves.
- Opening with the built-in editor is the host's menu; the panel has no button for it.
