# SQL notebook (`sample.sql-notebook`)

The reference package of the document phase: a custom editor for `.sql` files over the host's buffer, a new-file template, a
`save.before` hook and a service that runs statements against SQLite files with `node:sqlite`. Read the guide:
[docs/extensions/examples/sql-notebook.md](../../../docs/extensions/examples/sql-notebook.md).

The package to install is the folder `package/`:

- `extension.json`: permissions `ui.contribute`, `runtime.service`, `documents.editors`, `ui.richViews`, `ui.dynamic`, `projects.files.metadata`.
- `main.cjs`: the service entry (project folder, list of database files); `lib/notebook.mjs`: all the logic, browser-safe;
  `lib/driver.cjs` and `lib/worker.cjs`: one short-lived Node process per query, so a statement can always be stopped.
- `editor/`: the rich editor panel (a text area with line numbers, run and cancel, the result grid; no third-party component).
- `templates/empty.sql`: the file "New SQL note" creates.

Tests: `tests/extensions-example-sql-notebook.spec.ts` with `tests/fixtures/extensions/example-sql-notebook/`. They were written
for the final test phase and not run when written.
