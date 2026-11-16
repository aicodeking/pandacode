# B6 database file maker

Run `node make-sqlite.mjs <fixture-owned-output.db> [--rows 250]` under Node
v26.1.0. Parent directories must already exist. It prints
`{ready:true,file,rows}`, closes the database and exits; no listener or child
process remains. Exit 2 reports invalid input or a file error on stderr.
`makeDatabase()` is also exported. This finite, synchronous tool does not need
HTTP controls or a persistent stdin protocol.

The database has `tracks(id INTEGER PRIMARY KEY,title TEXT,minutes REAL,
cover BLOB,plays INTEGER)` and `albums(id INTEGER PRIMARY KEY,name TEXT)`.
Count is 1–10,000. Track 1 has the exact integer **9007199254740993**, a
**1,200-byte** BLOB and a fractional duration. The default 250 rows exceed the
notebook's 100-row cap. One named album supplies schema discovery.

Only target a test-owned file: rerunning upserts deterministic rows and removes
fixture track ids above the selected count. It restores edits to fixture rows;
it does not create backups, temp databases or sidecars on successful completion.
The pure `core/make-sqlite.mjs` supplies the same rows without Node imports.

SQL notebook (8) can discover tables, query >100 rows for truncation, display an
exact large integer/BLOB, report SQL errors, and perform writes. Read SQLite
integer columns with `statement.setReadBigInts(true)` to preserve the canary.
Query timeout/cancel, writes-off policy, file picker, save hooks and editor UI
belong to the later notebook service/host. The database cannot prove them.

Test: `node --test make-sqlite.test.mjs` (two tests). Generated databases are
retained under the shared `evidence/` folder for inspection.
