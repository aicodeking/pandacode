// One query, one short-lived Node process (started by lib/driver.cjs): the service stops a statement by ending the
// process, which also ends a statement that never returns control to JavaScript (an aggregate over an endless CTE), and a
// crash of the database never takes the service with it. The process reads one JSON request from stdin, opens the file
// with node:sqlite, runs one statement and writes one JSON answer to stdout. Integers are read as bigint so a value above
// 2^53 stays exact (`{ int }`); a BLOB travels as its length only (`{ blob }`); long text is cut at 4096 characters.
const { DatabaseSync } = require('node:sqlite');

const MAX_TEXT = 4096;

function plain(value) {
  if (typeof value === 'bigint') return { int: value.toString() };
  if (value instanceof Uint8Array) return { blob: value.byteLength };
  if (typeof value === 'string' && value.length > MAX_TEXT) return value.slice(0, MAX_TEXT);
  return value;
}

function main(request) {
  const { file, sql, limit, readOnly, mode } = request;
  const db = new DatabaseSync(file, { readOnly: readOnly === true });
  try {
    if (mode === 'check') { db.prepare('SELECT count(*) FROM sqlite_master').get(); return { ok: true }; }
    if (mode === 'tables') {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return { ok: true, tables: names.map(row => ({ name: String(row.name), columns: db.prepare(`PRAGMA table_info("${String(row.name).replace(/"/g, '""')}")`).all().map(column => String(column.name)) })) };
    }
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map(column => column.name);
    if (columns.length) {
      const rows = [];
      for (const row of statement.iterate()) { rows.push(columns.map(name => plain(row[name]))); if (rows.length >= limit) break; }
      return { ok: true, columns, rows };
    }
    const info = statement.run();
    return { ok: true, columns: [], rows: [], changes: Number(info.changes ?? 0) };
  } finally {
    try { db.close(); } catch { /* the process ends anyway */ }
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let answer;
  try { answer = main(JSON.parse(input)); } catch (error) { answer = { ok: false, code: 'SqlError', message: String(error?.message ?? error) }; }
  process.stdout.write(JSON.stringify(answer), () => process.exit(0));
});
