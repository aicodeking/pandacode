import { DatabaseSync } from 'node:sqlite';
import { databaseRows } from '../core/make-sqlite.mjs';
import { args, integer, main } from '../common.mjs';

export function makeDatabase(path, count = 250) {
  const rows = databaseRows(count), db = new DatabaseSync(path);
  try {
    db.exec('BEGIN; CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, title TEXT, minutes REAL, cover BLOB, plays INTEGER); CREATE TABLE IF NOT EXISTS albums(id INTEGER PRIMARY KEY, name TEXT);');
    db.prepare('DELETE FROM tracks WHERE id > ?').run(count);
    // Fixture-owned file only. Stable primary keys make repeated generation idempotent.
    const insert = db.prepare('INSERT OR REPLACE INTO tracks VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.id, row.title, row.minutes, row.cover, row.plays);
    db.prepare('INSERT OR REPLACE INTO albums VALUES (?, ?)').run(1, 'Fixture album');
    db.exec('COMMIT');
    return { ready: true, file: path, rows: db.prepare('SELECT count(*) AS n FROM tracks').get().n };
  } finally { db.close(); }
}
if (main(import.meta.url)) {
  try {
    const { options, rest } = args(process.argv.slice(2), ['rows']);
    if (rest.length !== 1) throw new Error('Usage: node make-sqlite.mjs <out.db> [--rows 250]');
    console.log(JSON.stringify(makeDatabase(rest[0], integer(options.rows, 250, 1, 10000))));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
