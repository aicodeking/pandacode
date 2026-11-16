import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { evidence, program } from '../test-support.mjs';
import { databaseRows } from '../core/make-sqlite.mjs';

test('B6 writes a real SQLite fixture with exact bigint/BLOB and closes the file', async t => {
  const path = await evidence('notebook.db');
  const generated = await program(t, './make-sqlite/make-sqlite.mjs', [path]).exited;
  assert.equal(generated.code, 0, generated.stderr); assert.equal(JSON.parse(generated.stdout).rows, 250);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM tracks').get().n, 250);
    const query = db.prepare('SELECT * FROM tracks WHERE id = 1'); query.setReadBigInts(true);
    const row = query.get(); assert.equal(row.plays, 9007199254740993n); assert.equal(row.cover.byteLength, 1200);
    assert.equal(typeof row.minutes, 'number'); assert.equal(db.prepare('SELECT name FROM albums').get().name, 'Fixture album');
    const limited = db.prepare('SELECT * FROM tracks LIMIT 101'); limited.setReadBigInts(true);
    assert.equal(limited.all().length, 101);
    assert.throws(() => db.prepare('SELECT missing FROM tracks').all(), /no such column/);
    assert.equal(db.prepare('UPDATE tracks SET title = ? WHERE id = 2').run('changed').changes, 1);
  } finally { db.close(); }
  assert.equal((await program(t, './make-sqlite/make-sqlite.mjs', [path]).exited).code, 0);
});

test('B6 configurable count and invalid input', async t => {
  const path = await evidence('notebook-small.db');
  assert.equal(JSON.parse((await program(t, './make-sqlite/make-sqlite.mjs', [path, '--rows', '3']).exited).stdout).rows, 3);
  assert.equal((await program(t, './make-sqlite/make-sqlite.mjs', [path, '--rows', '0']).exited).code, 2);
  assert.equal((await program(t, './make-sqlite/make-sqlite.mjs', []).exited).code, 2);
  assert.throws(() => databaseRows(-1)); assert.equal(databaseRows(3).length, 3);
});
