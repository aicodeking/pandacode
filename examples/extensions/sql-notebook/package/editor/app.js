// SQL notebook editor panel. It works on the host's document session (pandaView.document: the current text, a call to
// change it, a callback when the host replaces it) and never saves by itself: the host persists. Statements run in the
// service (named messages over pandaView.postMessage); this page never touches a database driver.
// `window.__sqlNotebook` is what the qualification reads; the product does not need it.
const view = window.pandaView;
const doc = view.document;
const HEADER = /^--[ \t]*sqlnote:[ \t]*db=(.*?)[ \t]*(?:\r?\n|$)/;
const el = id => document.getElementById(id);
const area = el('text'), gutter = el('gutter');

const observed = window.__sqlNotebook = { init: null, results: [], opened: [], replaced: [], saved: [], renders: 0, readOnly: false };
let running = null;     // id of the statement in flight
let sequence = 0;
let database = null;    // the path in the header line, once the service opened the file
let allowed = null;     // the database the user chose and the service has not confirmed yet

const show = (id, text) => { el(id).textContent = text; };
const send = async message => { try { await view.postMessage(message); } catch (error) { showError(`${error?.code ?? 'Failed'}: ${error?.message ?? 'the service is not reachable'}`); } };

function lines() { gutter.textContent = Array.from({ length: area.value.split('\n').length }, (_, index) => index + 1).join('\n'); }
function showError(text) { const box = el('error'); box.textContent = text ?? ''; box.dataset.shown = String(!!text); }

function header() {
  const match = HEADER.exec(area.value);
  database = match ? (match[1] || null) : null;
  show('database', database ? database : 'No database');
  el('choose').textContent = database ? 'Change database' : 'Choose database';
}

/** The statement under the cursor, split like lib/notebook.mjs (the page keeps its own small copy: it may not import). */
function statementAtCursor() {
  const text = area.value, at = area.selectionStart;
  const spans = []; let start = 0, i = 0, code = false;
  const flush = end => { if (code) spans.push({ start, end, sql: text.slice(start, end).replace(/;\s*$/, '').trim() }); code = false; };
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (ch === '-' && next === '-') { const eol = text.indexOf('\n', i); i = eol < 0 ? text.length : eol + 1; continue; }
    if (ch === '/' && next === '*') { const close = text.indexOf('*/', i + 2); i = close < 0 ? text.length : close + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { code = true; i += 1; while (i < text.length) { if (text[i] === ch) { if (text[i + 1] === ch) { i += 2; continue; } i += 1; break; } i += 1; } continue; }
    if (ch === ';') { i += 1; flush(i); start = i; continue; }
    if (!/\s/.test(ch)) code = true;
    i += 1;
  }
  flush(text.length);
  const real = spans.filter(span => span.sql);
  return real.find(span => at >= span.start && at <= span.end) ?? [...real].reverse().find(span => span.end <= at) ?? real[0] ?? null;
}

function draw(result) {
  observed.renders += 1;
  const grid = el('grid');
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const name of result.columns) { const th = document.createElement('th'); th.textContent = name; head.append(th); }
  const thead = document.createElement('thead'); thead.append(head); table.append(thead);
  const body = document.createElement('tbody');
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const item of row) { const td = document.createElement('td'); td.textContent = item.v; td.dataset.kind = item.k; if (item.cut) td.title = 'Shortened'; tr.append(td); }
    body.append(tr);
  }
  table.append(body);
  grid.replaceChildren(table);
}

function onResult(message) {
  if (message.id !== running) return;
  running = null; el('cancel').disabled = true; el('run').disabled = false;
  observed.results.push({ id: message.id, ok: message.ok, code: message.code ?? null, rows: message.rows?.length ?? 0, truncated: message.truncated === true, changes: message.changes ?? null });
  if (!message.ok) { showError(message.message ?? message.code); show('note', ''); return; }
  showError('');
  if (message.columns.length) draw(message); else el('grid').replaceChildren();
  const parts = [`${message.shown ?? message.rows.length} row${message.rows.length === 1 ? '' : 's'}`];
  if (message.truncated) parts.push('truncated: more rows exist than the row limit');
  if (typeof message.changes === 'number') parts.push(`${message.changes} row${message.changes === 1 ? '' : 's'} changed`);
  parts.push(`${message.ms} ms`);
  show('note', parts.join(' - '));
}

function run() {
  if (running) return;
  if (!database) { showError('Choose a database first.'); return; }
  const statement = statementAtCursor();
  if (!statement) { showError('There is no statement under the cursor.'); return; }
  running = `q${Date.now().toString(36)}${++sequence}`;
  el('cancel').disabled = false; el('run').disabled = true; showError(''); show('note', 'Running');
  void send({ kind: 'run', id: running, db: database, sql: statement.sql });
}

function onOpened(message) {
  observed.opened.push({ db: message.db, ok: message.ok, code: message.code ?? null });
  if (!message.ok) { showError(message.message ?? 'The database could not be opened.'); allowed = null; return; }
  if (message.db !== allowed) return;
  // Only now, after the service opened the file, is the header line written (through the host buffer).
  const text = HEADER.test(area.value) ? area.value.replace(HEADER, `-- sqlnote: db=${message.db}\n`) : `-- sqlnote: db=${message.db}\n${area.value}`;
  area.value = text; allowed = null; after(); push();
  showError(''); el('chooser').dataset.shown = 'false';
}

function onDatabases(message) {
  const box = el('chooser');
  box.replaceChildren();
  if (!message.items.length) { box.textContent = 'No .db or .sqlite file in this project.'; }
  for (const item of message.items) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item;
    button.addEventListener('click', () => { allowed = item; void send({ kind: 'open', id: `o${++sequence}`, db: item }); });
    box.append(button);
  }
  box.dataset.shown = 'true';
}

function after() { lines(); header(); }
function push() { if (doc.readOnly) return; void Promise.resolve(doc.edit({ text: area.value })).then(() => { show('dirty', 'changed'); }, error => showError(`${error?.code ?? 'Failed'}: ${error?.message ?? ''}`)); }

(async () => {
  const current = await doc.read();
  area.value = current.text;
  observed.readOnly = current.readOnly === true || doc.readOnly === true;
  area.readOnly = observed.readOnly;
  after();
  if (observed.readOnly) show('dirty', 'read-only');
})().catch(error => showError(`${error?.code ?? 'Failed'}: ${error?.message ?? ''}`));

// The host asks for pending edits before it saves, and tells what it did to the buffer afterwards.
doc.onWillSave(async () => { if (!doc.readOnly) await doc.edit({ text: area.value }); });
doc.onDidReplace(next => { observed.replaced.push({ reason: next.reason, revision: next.revision }); area.value = next.text; after(); show('dirty', next.reason === 'disk' ? 'updated from disk' : ''); });
doc.onDidSave(info => { observed.saved.push(info.revision); show('dirty', ''); show('status', `saved ${info.revision}`); });

view.onDidInitialize(init => { observed.init = { viewId: view.viewId, instanceId: init.instanceId ?? null, placement: init.placement ?? null }; });
view.onMessage(message => {
  switch (message?.kind) {
    case 'result': onResult(message); break;
    case 'opened': onOpened(message); break;
    case 'databases': onDatabases(message); break;
    default: break;
  }
});

area.addEventListener('input', () => { lines(); header(); push(); });
area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
area.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); }
});
el('run').addEventListener('click', run);
el('cancel').addEventListener('click', () => { if (running) void send({ kind: 'cancel', id: running }); });
el('choose').addEventListener('click', () => { void send({ kind: 'databases', id: `d${++sequence}` }); });
el('save').addEventListener('click', () => { void Promise.resolve(doc.save()).catch(error => showError(`${error?.code ?? 'Failed'}: ${error?.message ?? ''}`)); });
