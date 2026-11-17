// SQL notebook (sample.sql-notebook): all of the logic, as one browser-safe ES module (no imports, no Node). The installed
// service (main.cjs) hands it a driver that opens SQLite files in a child process; tests hand it a scripted one.
//
// Parts: the statement helpers (split, statement under the cursor, write detection, the `-- sqlnote:` header), the value
// shaping (row limit, shortening, <blob 1.2 KB>, integers above 2^53 kept exact as text), and `run`, the service.

export const VIEW = 'sample.sql-notebook/editor';
export const IDS = Object.freeze({
  editor: VIEW,
  databases: 'sample.sql-notebook/databases',
  recent: 'sample.sql-notebook/recent',
  page: 'sample.sql-notebook/settings',
  hook: 'sample.sql-notebook/save',
});
export const DEFAULTS = Object.freeze({ rowLimit: 100, timeoutSeconds: 10, allowWrites: false, maxCell: 200 });
export const HEADER = /^--[ \t]*sqlnote:[ \t]*db=(.*?)[ \t]*(?:\r?\n|$)/;
export const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
export const MAX_RECENT = 20;
export const MAX_SQL = 256 * 1024;

const fail = (code, message) => Object.assign(new Error(message ?? code), { code });

// ---- statements ----------------------------------------------------------------------------------------------------

/** The statements of `text`: `{ start, end, sql }` (end exclusive, the `;` included in the span but not in `sql`). Quotes,
 *  `--` and block comments hide a `;`. A span that holds only comments and blanks is not a statement. */
export function splitStatements(text) {
  const spans = [];
  let start = 0, i = 0, code = false;
  const flush = end => { if (code) spans.push({ start, end, sql: text.slice(start, end).replace(/;\s*$/, '').trim() }); code = false; };
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (ch === '-' && next === '-') { const eol = text.indexOf('\n', i); i = eol < 0 ? text.length : eol + 1; continue; }
    if (ch === '/' && next === '*') { const close = text.indexOf('*/', i + 2); i = close < 0 ? text.length : close + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      code = true; i += 1;
      while (i < text.length) { if (text[i] === ch) { if (text[i + 1] === ch) { i += 2; continue; } i += 1; break; } i += 1; }
      continue;
    }
    if (ch === '[') { code = true; const close = text.indexOf(']', i + 1); i = close < 0 ? text.length : close + 1; continue; }
    if (ch === ';') { code = code || false; i += 1; flush(i); start = i; continue; }
    if (!/\s/.test(ch)) code = true;
    i += 1;
  }
  flush(text.length);
  return spans.filter(span => span.sql.length > 0);
}

/** The statement under the cursor: the one that contains `offset`, else the closest one before it, else the first. */
export function statementAt(text, offset) {
  const spans = splitStatements(text);
  if (!spans.length) return null;
  const at = Math.max(0, Math.min(offset, text.length));
  return spans.find(span => at >= span.start && at <= span.end)
    ?? [...spans].reverse().find(span => span.end <= at)
    ?? spans[0];
}

const stripNoise = sql => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
const READ_FIRST = new Set(['select', 'with', 'values', 'explain']);
const WRITE_WORDS = /\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/** True when the statement may change data or the file. A `PRAGMA` is a read unless it assigns (`PRAGMA name = value`). */
export function isWrite(sql) {
  const clean = stripNoise(sql).trim();
  const first = /^[a-z]+/i.exec(clean)?.[0]?.toLowerCase() ?? '';
  if (first === 'pragma') return clean.includes('=');
  if (!READ_FIRST.has(first)) return true;
  return first !== 'select' && first !== 'values' && WRITE_WORDS.test(clean);
}

// ---- the header line -----------------------------------------------------------------------------------------------

export const parseHeader = text => { const match = HEADER.exec(text); return { db: match ? match[1] || null : null, body: match ? text.slice(match[0].length) : text }; };
export const setHeader = (text, db) => {
  const line = `-- sqlnote: db=${db}`;
  const match = HEADER.exec(text);
  return match ? line + (match[0].endsWith('\n') ? (match[0].endsWith('\r\n') ? '\r\n' : '\n') : '') + text.slice(match[0].length) : `${line}\n${text}`;
};

/** A database file is a safe `/` relative path inside the project that ends in .db, .sqlite or .sqlite3. */
export function validDatabasePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512) return false;
  if (/^[\\/]|^[a-zA-Z]:|\\|[\0-\x1f<>:"|?*]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))) return false;
  return DB_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension));
}
export const isDatabaseFile = path => DB_EXTENSIONS.some(extension => String(path).toLowerCase().endsWith(extension));

// ---- values --------------------------------------------------------------------------------------------------------

export function size(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

/** Long text is cut to `max` characters with an ellipsis; `full` tells the page there is more. */
export function shorten(text, max = DEFAULTS.maxCell) {
  const value = String(text);
  return value.length <= max ? { v: value, cut: false } : { v: `${value.slice(0, Math.max(1, max - 1))}…`, cut: true };
}

/** One SQLite value as a grid cell `{ k, v, cut? }`. Integers (bigint or a safe number) show every digit; a BLOB shows its size. */
export function cell(value, max = DEFAULTS.maxCell) {
  if (value === null || value === undefined) return { k: 'null', v: 'NULL' };
  if (typeof value === 'bigint') return { k: 'int', v: value.toString() };
  if (typeof value === 'number') return { k: Number.isInteger(value) ? 'int' : 'real', v: String(value) };
  if (value instanceof Uint8Array || (Array.isArray(value?.bytes)) || (value && typeof value === 'object' && typeof value.blob === 'number')) {
    const length = value instanceof Uint8Array ? value.byteLength : Array.isArray(value.bytes) ? value.bytes.length : value.blob;
    return { k: 'blob', v: `<blob ${size(length)}>` };
  }
  const short = shorten(value, max);
  return short.cut ? { k: 'text', v: short.v, cut: true } : { k: 'text', v: short.v };
}

/** The result the page draws: at most `rowLimit` rows (the driver may hand one more, which proves truncation). */
export function shape(columns, rows, { rowLimit = DEFAULTS.rowLimit, maxCell = DEFAULTS.maxCell } = {}) {
  const shown = rows.slice(0, rowLimit);
  return { columns: columns.map(String), rows: shown.map(row => row.map(value => cell(value, maxCell))), truncated: rows.length > rowLimit, shown: shown.length };
}

const toInt = (value, fallback, min, max) => { const n = Number.parseInt(String(value), 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
export const readSettings = values => ({
  rowLimit: toInt(values?.['row-limit'], DEFAULTS.rowLimit, 1, 1000),
  timeoutSeconds: toInt(values?.['timeout-seconds'], DEFAULTS.timeoutSeconds, 1, 600),
  allowWrites: values?.['allow-writes'] === true,
});

// ---- the service ---------------------------------------------------------------------------------------------------

/**
 * The service. `env` is the side that touches the disk:
 *   driver.run({ id, file, sql, limit, timeoutMs, readOnly }) -> { columns, rows, changes } (rows hold `limit` + 1 at most)
 *   driver.cancel(id), driver.tables(file) -> [{ name, columns }], driver.check(file) -> void (throws when it is not a database)
 *   resolve(projectId, relative) -> absolute path, listDatabases(projectId) -> relative paths
 * It answers the editor panel (viewId VIEW) and records every saved file in "Recent notes" through `save.before`.
 */
export async function run(panda, lifetime, env) {
  const panel = panda.views;
  const state = { settings: { ...DEFAULTS }, recent: [], running: new Map(), opened: new Map(), errors: 0 };
  const disposers = [];
  let stopped = false;
  const refuse = () => { state.errors += 1; };
  const dispose = handle => { try { (handle?.dispose ?? handle)?.call?.(handle); } catch { /* the host disposes the rest */ } };
  const tell = (body, from) => Promise.resolve(panel.post(VIEW, body, from ? { instance: from.instanceId } : undefined)).catch(refuse);

  const loadSettings = async () => {
    const page = await panda.settings?.get({ page: IDS.page }).catch(() => null);
    state.settings = { ...DEFAULTS, ...readSettings(page?.values) };
  };

  const projectOf = from => from?.scope?.projectId ?? state.project ?? null;

  // The two host-rendered lists.
  const drawRecent = () => panda.ui.updateView(IDS.recent, { controls: [{ kind: 'list', label: 'Notes', items: state.recent.map(note => `${note.path} (${note.at})`) }] }).catch(refuse);
  const drawDatabases = async projectId => {
    if (!projectId) return;
    const items = [];
    for (const rel of (await Promise.resolve(env.listDatabases(projectId)).catch(() => [])).slice(0, 100)) {
      let tables = [];
      try { tables = await env.driver.tables(env.resolve(projectId, rel)); } catch { /* an unreadable file lists nothing */ }
      items.push({ label: rel, children: tables.map(table => ({ label: table.name })).slice(0, 100) });
    }
    await panda.ui.updateView(IDS.databases, { controls: [{ kind: 'tree', label: 'Tables', items }] }).catch(refuse);
  };

  const databases = async (from, message) => {
    const projectId = projectOf(from);
    const items = projectId ? await Promise.resolve(env.listDatabases(projectId)).catch(() => []) : [];
    return tell({ kind: 'databases', id: message.id ?? null, items: items.filter(validDatabasePath) }, from);
  };

  /** `choose`: the service opens the file first; the page writes the header line only after `opened` with ok. */
  const open = async (from, message) => {
    const projectId = projectOf(from);
    const rel = message.db;
    if (!projectId || !validDatabasePath(rel)) return tell({ kind: 'opened', id: message.id ?? null, db: rel ?? null, ok: false, code: 'InvalidShape', message: 'That is not a database file of this project.' }, from);
    try {
      const file = env.resolve(projectId, rel);
      await env.driver.check(file);
      const tables = await env.driver.tables(file);
      state.opened.set(`${projectId}\0${rel}`, tables);
      void drawDatabases(projectId);
      return tell({ kind: 'opened', id: message.id ?? null, db: rel, ok: true, tables }, from);
    } catch (error) {
      return tell({ kind: 'opened', id: message.id ?? null, db: rel, ok: false, code: String(error?.code ?? 'NotFound'), message: error?.message ?? 'The database could not be opened.' }, from);
    }
  };

  const execute = async (from, message) => {
    const id = String(message.id ?? '');
    const projectId = projectOf(from);
    const sql = typeof message.sql === 'string' ? message.sql.trim() : '';
    const answer = body => tell({ kind: 'result', id, ...body }, from);
    if (!id || !sql || sql.length > MAX_SQL || !projectId || !validDatabasePath(message.db)) return answer({ ok: false, code: 'InvalidShape', message: 'Nothing to run: choose a database and a statement.' });
    if (state.running.has(id)) return answer({ ok: false, code: 'Conflict', message: 'That statement is already running.' });
    const { rowLimit, timeoutSeconds, allowWrites } = state.settings;
    const write = isWrite(sql);
    if (write && !allowWrites) return answer({ ok: false, code: 'WritesOff', message: 'Writes are off. Turn on "Allow writes" in the SQL notebook settings to run this statement.' });
    state.running.set(id, from?.instanceId ?? null);
    const started = Date.now();
    try {
      const result = await env.driver.run({ id, file: env.resolve(projectId, message.db), sql, limit: rowLimit + 1, timeoutMs: timeoutSeconds * 1000, readOnly: !allowWrites });
      const shaped = shape(result.columns ?? [], result.rows ?? [], { rowLimit, maxCell: DEFAULTS.maxCell });
      const body = { ok: true, ms: Date.now() - started, ...shaped };
      if (write) body.changes = Number(result.changes ?? 0);
      return answer(body);
    } catch (error) {
      const code = String(error?.code ?? 'SqlError');
      const text = code === 'Timeout' ? `The statement ran longer than ${timeoutSeconds} s and was stopped.` : code === 'Cancelled' ? 'The statement was cancelled.' : (error?.message ?? 'The statement failed.');
      return answer({ ok: false, code, message: text });
    } finally {
      state.running.delete(id);
    }
  };

  const cancel = async message => { const id = String(message.id ?? ''); if (state.running.has(id)) await Promise.resolve(env.driver.cancel(id)).catch(refuse); };

  const onMessage = (message, from) => {
    if (stopped || !message || typeof message !== 'object') return null;
    switch (message.kind) {
      case 'run': return execute(from, message);
      case 'cancel': return cancel(message);
      case 'databases': return databases(from, message);
      case 'open': return open(from, message);
      case 'settings': return tell({ kind: 'settings', settings: state.settings }, from);
      default: return null; // a message the service does not know is ignored
    }
  };
  disposers.push(panel.onMessage(VIEW, (message, from) => Promise.resolve(onMessage(message, from)).catch(refuse)));
  disposers.push(panel.on('opened', instance => { if (instance?.viewId === VIEW) { if (instance.scope?.projectId) state.project = instance.scope.projectId; void tell({ kind: 'settings', settings: state.settings }, instance); } }));

  // The hook before save: record the file and never alter or delay the save (it returns nothing).
  if (panda.hooks?.on) {
    disposers.push(panda.hooks.on('save.before', ({ projectId, path }) => {
      if (typeof path !== 'string') return undefined;
      state.project = projectId ?? state.project;
      state.recent = [{ path, at: new Date().toISOString().slice(0, 16).replace('T', ' ') }, ...state.recent.filter(note => note.path !== path)].slice(0, MAX_RECENT);
      void drawRecent();
      return undefined;
    }));
  }
  disposers.push(panda.events.on('settings.changed', () => { void loadSettings(); }));
  for (const kind of ['project.opened', 'task.shown']) disposers.push(panda.events.on(kind, event => { if (typeof event?.projectId === 'string') { state.project = event.projectId; void drawDatabases(event.projectId); } }));

  lifetime.onStop(() => {
    stopped = true;
    for (const id of [...state.running.keys()]) { try { env.driver.cancel(id); } catch { /* ignored */ } }
    for (const handle of disposers.splice(0).reverse()) dispose(handle);
  });

  await loadSettings();
  void drawRecent();
  return state;
}
