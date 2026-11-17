import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateContract } from '../src/extensions/contracts';
import { BUILTIN, checkEditorDeclarations, DocumentEditors, extensionOf, PERMISSION, type Content, type Entry as EditorEntry, type Wiring } from '../src/extensions/runtime-document-editors';
import { DocumentSave, kindOf, type SaveEnv, type SaveMember } from '../src/extensions/runtime-document-save';
import { checkNewFileDeclarations, NewFiles, type Entry as FileEntry, type Env, type Project } from '../src/extensions/runtime-new-file-templates';

// R1211: the SQL notebook (sample.sql-notebook), the reference package of the document phase R9. This spec runs in the test
// runner's Node (the browser has no database and no host buffer) and covers three layers apart from the installed app:
//   1. the shipped logic file (lib/notebook.mjs) and the package files;
//   2. the service (the same file, with a fake `panda` and a scripted driver) and the real driver (lib/driver.cjs, node:sqlite
//      in a child process) against B6's database file, created here in a test-owned folder;
//   3. the host side: the webview twins of R0901 (custom editors over host buffers), R0902 (the save path and `save.before`)
//      and R0903 (new-file templates), driven with the package's own manifest, template and hook.
// The wiring of the editor shell and the new-file menu to the twins is still pending in the product; the installed window
// (the real Open with menu, floating editor window, real save and disable on Windows) is "prepared, not run" in
// tests/fixtures/extensions/example-sql-notebook/evidence-columns.json. Written for the final test phase; not run when
// written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PACKAGE = 'examples/extensions/sql-notebook/package';
const manifest = JSON.parse(read(`${PACKAGE}/extension.json`));
const cases = JSON.parse(read('tests/fixtures/extensions/example-sql-notebook/cases.json'));
const columns = JSON.parse(read('tests/fixtures/extensions/example-sql-notebook/evidence-columns.json'));
const template = readFileSync(new URL(`../${PACKAGE}/templates/empty.sql`, import.meta.url));
const OWNER = 'sample.sql-notebook';
const EDITOR = `${OWNER}/editor`, ITEM = `${OWNER}/note`;
type Obj = Record<string, any>;
const logic = () => import('../examples/extensions/sql-notebook/package/lib/notebook.mjs') as Promise<Obj>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const normalize = (text: string) => text.replace(/\r\n/g, '\n');
const revive = (value: any) => (value && typeof value === 'object' && typeof value.int === 'string' ? BigInt(value.int) : value);

// ---- a fake `panda` and drivers -------------------------------------------------------------------------------------

const from = { instanceId: 'i1', viewId: EDITOR, windowId: 'w1', placement: 'editor', visible: true, focused: true, scope: { projectId: 'p1' } };

function world(values: Obj = {}) {
  const messages: Array<(message: any, from: any) => any> = [];
  const opened: Array<(instance: any) => void> = [];
  const hooks = new Map<string, (payload: any) => any>();
  const stops: Array<() => void> = [];
  const posted: Array<{ body: any; instance?: string }> = [];
  const updates: Array<{ id: string; patch: any }> = [];
  const handle = (undo: () => void) => ({ dispose: undo });
  const panda = {
    views: {
      post: async (_view: string, body: any, options?: { instance?: string }) => { posted.push({ body, instance: options?.instance }); return { delivered: 1 }; },
      onMessage: (_view: string, handler: any) => { messages.push(handler); return handle(() => messages.splice(messages.indexOf(handler), 1)); },
      on: (kind: string, handler: any) => { if (kind === 'opened') opened.push(handler); return handle(() => undefined); },
    },
    hooks: { on: (event: string, handler: any) => { hooks.set(event, handler); return handle(() => hooks.delete(event)); } },
    ui: { updateView: async (id: string, patch: any) => { updates.push({ id, patch }); return null; } },
    settings: { get: async () => ({ schemaVersion: 1, revision: 1, values }) },
    events: { on: () => handle(() => undefined) },
  };
  const lifetime = { onStop: (callback: () => void) => { stops.push(callback); } };
  return {
    panda, lifetime, posted, updates, hooks, stops, opened,
    /** The editor panel sends a message; the answers the service posted for it come back. */
    async ask(message: Obj) { const before = posted.length; await messages[0](message, from); return posted.slice(before).map(entry => entry.body); },
    listeners: () => messages.length,
    stop() { for (const callback of stops.splice(0)) callback(); },
  };
}

/** A scripted driver: `answers` maps a statement to its result or error; a statement without an answer waits to be cancelled. */
function scripted(answers: Record<string, any>) {
  const calls: Obj[] = []; const cancelled: string[] = []; const waiting = new Map<string, (error: unknown) => void>();
  return {
    calls, cancelled,
    driver: {
      run: (request: Obj) => new Promise((resolve, reject) => {
        calls.push(request);
        const answer = answers[request.sql];
        if (answer?.error) return reject(Object.assign(new Error(answer.message ?? answer.error), { code: answer.error }));
        if (answer) return resolve(answer);
        waiting.set(request.id, reject);
      }),
      cancel: (id: string) => { cancelled.push(id); waiting.get(id)?.(Object.assign(new Error('Cancelled'), { code: 'Cancelled' })); },
      tables: async () => [{ name: 'tracks', columns: ['id', 'title'] }],
      check: async () => undefined,
    },
  };
}
const envFor = (driver: Obj, databases = ['data/music.db']) => ({ driver, resolve: (_project: string, relative: string) => { if (!databases.includes(relative)) throw Object.assign(new Error('The database file is not in the project.'), { code: 'NotFound' }); return `/project/${relative}`; }, listDatabases: async () => databases });

test.describe('sql notebook (R1211): package, logic and service', () => {
  test('the package is a valid contract with one editor, one template, two host views, a save hook and a settings page', async () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(manifest.id).toBe(OWNER);
    expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'documents.editors', 'ui.richViews', 'ui.dynamic', 'projects.files.metadata']);
    expect(manifest.permissions).not.toContain('secrets.private');
    expect(manifest.runtime).toMatchObject({ kind: 'node', entrypoint: 'main.cjs', files: ['lib', 'editor', 'templates'], service: { start: 'onEnable' } });
    expect(manifest.contributes.editors).toEqual([{ id: EDITOR, title: 'SQL notebook', extensions: ['.sql'], priority: 'default', encoding: 'text', rich: { folder: 'editor', entry: 'index.html' } }]);
    expect(manifest.contributes.newFiles).toEqual([{ id: ITEM, title: 'New SQL note', extension: '.sql', template: 'templates/empty.sql', editor: EDITOR }]);
    expect(manifest.contributes.views.map((view: Obj) => view.title)).toEqual(['Databases', 'Recent notes']);
    expect(manifest.contributes.hooks).toEqual([{ id: `${OWNER}/save`, event: 'save.before', budgetMs: 200, match: { extensions: ['.sql'] } }]);
    expect(checkEditorDeclarations(manifest).ok).toBe(true);
    expect(checkNewFileDeclarations(manifest).ok).toBe(true);
    for (const file of ['extension.json', 'main.cjs', 'lib/notebook.mjs', 'lib/driver.cjs', 'lib/worker.cjs', 'editor/index.html', 'editor/app.js', 'templates/empty.sql']) expect(existsSync(new URL(`../${PACKAGE}/${file}`, import.meta.url)), file).toBe(true);
    // Without documents.editors the contract refuses the editor, the template and the hook, never silently.
    const bare = structuredClone(manifest) as Obj;
    bare.permissions = bare.permissions.filter((permission: string) => permission !== PERMISSION);
    const refused = validateContract('packages', [bare]) as Obj;
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('PermissionDenied');
  });

  test('the logic file is browser-safe, the service entry only loads it, and the driver is the only code that touches a database', () => {
    const notebook = read(`${PACKAGE}/lib/notebook.mjs`);
    expect(notebook).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
    expect(notebook).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function|\bfetch\(|XMLHttpRequest/);
    const main = read(`${PACKAGE}/main.cjs`);
    expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:fs', 'node:path', './lib/driver.cjs']);
    expect([...main.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['./lib/notebook.mjs']);
    const driver = read(`${PACKAGE}/lib/driver.cjs`);
    expect([...driver.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:path', 'node:child_process']);
    expect(driver).toMatch(/windowsHide: true/);
    expect(driver).not.toMatch(/shell\s*:\s*true/);
    expect(read(`${PACKAGE}/lib/worker.cjs`)).toContain("require('node:sqlite')");
    const page = read(`${PACKAGE}/editor/app.js`);
    expect(page).not.toMatch(/node:sqlite|require\(|fetch\(|XMLHttpRequest|import\(/);
    for (const call of ['doc.onWillSave(', 'doc.onDidReplace(', 'doc.onDidSave(', 'doc.edit(', 'doc.save(', 'view.postMessage(']) expect(page, call).toContain(call);
    // The editor never writes the file and the header line is written only once the service has opened the database.
    expect(page).not.toMatch(/writeFile|fs\./);
    expect(page.indexOf("case 'opened'")).toBeGreaterThan(0);
    expect(page).toMatch(/Only now, after the service opened the file, is the header line written/);
    expect(page).toMatch(/event\.ctrlKey \|\| event\.metaKey/);
    expect(page).toMatch(/isComposing/);
  });

  test('the template creates a note whose only text is a hint, a comment and one statement', () => {
    expect(normalize(decoder.decode(template))).toBe('-- New SQL note. Put the database on the first line (the editor writes it when you choose one), then press Ctrl+Enter.\nSELECT 1;\n');
  });

  for (const scripted of cases.statements as Obj[]) {
    test(`statement under the cursor: ${scripted.id}`, async () => {
      const { statementAt } = await logic();
      const found = statementAt(scripted.text, scripted.at);
      expect(found ? found.sql : null).toBe(scripted.expect);
    });
  }

  test('writes are told from reads, with comments and strings out of the way', async () => {
    const { isWrite } = await logic();
    for (const entry of cases.writes as Obj[]) expect(isWrite(entry.sql), entry.sql).toBe(entry.write);
  });

  test('the header line names the database, is parsed and rewritten in place, and database paths stay inside the project', async () => {
    const { parseHeader, setHeader, validDatabasePath } = await logic();
    for (const entry of cases.headers as Obj[]) expect(parseHeader(entry.text), JSON.stringify(entry.text)).toEqual({ db: entry.db, body: entry.body });
    expect(setHeader('SELECT 1;\n', 'data/a.db')).toBe('-- sqlnote: db=data/a.db\nSELECT 1;\n');
    expect(setHeader('-- sqlnote: db=old.db\nSELECT 1;\n', 'new.db')).toBe('-- sqlnote: db=new.db\nSELECT 1;\n');
    expect(setHeader('-- sqlnote: db=old.db\r\nSELECT 1;\r\n', 'new.db')).toBe('-- sqlnote: db=new.db\r\nSELECT 1;\r\n');
    for (const entry of cases.databasePaths as Obj[]) expect(validDatabasePath(entry.path), JSON.stringify(entry.path)).toBe(entry.ok);
  });

  test('values: integers above 2^53 are exact, a BLOB shows its size, long text is shortened, settings are clamped', async () => {
    const { cell, shorten, shape, readSettings, DEFAULTS } = await logic();
    for (const entry of cases.values as Obj[]) expect(cell(revive(entry.value)), entry.id).toEqual(entry.expect);
    expect(cell(9007199254740993n)).toEqual({ k: 'int', v: '9007199254740993' });
    expect(cell(new Uint8Array(1200))).toEqual({ k: 'blob', v: '<blob 1.2 KB>' });
    expect(shorten('x'.repeat(500), 200)).toEqual({ v: `${'x'.repeat(199)}…`, cut: true });
    expect(cell('y'.repeat(500))).toMatchObject({ k: 'text', cut: true });
    expect(cell('y'.repeat(500)).v).toHaveLength(200);
    const rows = Array.from({ length: 101 }, (_, index) => [index]);
    expect(shape(['n'], rows, { rowLimit: 100 })).toMatchObject({ truncated: true, shown: 100 });
    expect(shape(['n'], rows.slice(0, 100), { rowLimit: 100 })).toMatchObject({ truncated: false, shown: 100 });
    expect(DEFAULTS).toMatchObject({ rowLimit: 100, timeoutSeconds: 10, allowWrites: false });
    expect(readSettings({ 'row-limit': '5000', 'timeout-seconds': '0', 'allow-writes': true })).toEqual({ rowLimit: 1000, timeoutSeconds: 1, allowWrites: true });
    expect(readSettings({ 'row-limit': 'many', 'allow-writes': 'yes' })).toEqual({ rowLimit: 100, timeoutSeconds: 10, allowWrites: false });
  });

  test('service: a statement answers with shaped rows; a database error is a result and the next statement still runs', async () => {
    const { run } = await logic();
    const w = world();
    const script = scripted({
      'SELECT id, plays, cover FROM tracks': { columns: ['id', 'plays', 'cover'], rows: [[1n, 9007199254740993n, { blob: 1200 }], [2n, 2n, { blob: 0 }]] },
      'SELEC 1': { error: 'SqlError', message: 'near "SELEC": syntax error' },
    });
    await run(w.panda, w.lifetime, envFor(script.driver));
    const [ok] = await w.ask({ kind: 'run', id: 'q1', db: 'data/music.db', sql: 'SELECT id, plays, cover FROM tracks' });
    expect(ok).toMatchObject({ kind: 'result', id: 'q1', ok: true, columns: ['id', 'plays', 'cover'], truncated: false, shown: 2 });
    expect(ok.rows[0]).toEqual([{ k: 'int', v: '1' }, { k: 'int', v: '9007199254740993' }, { k: 'blob', v: '<blob 1.2 KB>' }]);
    expect(script.calls[0]).toMatchObject({ file: '/project/data/music.db', limit: 101, timeoutMs: 10_000, readOnly: true });
    const [bad] = await w.ask({ kind: 'run', id: 'q2', db: 'data/music.db', sql: 'SELEC 1' });
    expect(bad).toMatchObject({ kind: 'result', id: 'q2', ok: false, code: 'SqlError', message: 'near "SELEC": syntax error' });
    const [again] = await w.ask({ kind: 'run', id: 'q3', db: 'data/music.db', sql: 'SELECT id, plays, cover FROM tracks' });
    expect(again).toMatchObject({ ok: true });
  });

  test('service: malformed requests and unknown messages never reach the driver', async () => {
    const { run } = await logic();
    const w = world();
    const script = scripted({});
    await run(w.panda, w.lifetime, envFor(script.driver));
    for (const bad of [{ kind: 'run' }, { kind: 'run', id: 'a', db: '../x.db', sql: 'SELECT 1' }, { kind: 'run', id: 'a', db: 'data/music.db', sql: '' }, { kind: 'run', id: 'a', db: 'notes.sql', sql: 'SELECT 1' }]) {
      const [answer] = await w.ask(bad);
      expect(answer, JSON.stringify(bad)).toMatchObject({ kind: 'result', ok: false, code: 'InvalidShape' });
    }
    expect(await w.ask({ kind: 'nonsense' })).toEqual([]);
    expect(await w.ask({} as Obj)).toEqual([]);
    expect(script.calls).toEqual([]);
  });

  test('service: writes are refused while "Allow writes" is off, and run with the row count when it is on', async () => {
    const { run } = await logic();
    const off = world();
    const script = scripted({ "UPDATE tracks SET plays = 0": { columns: [], rows: [], changes: 250 } });
    await run(off.panda, off.lifetime, envFor(script.driver));
    const [refused] = await off.ask({ kind: 'run', id: 'w1', db: 'data/music.db', sql: 'UPDATE tracks SET plays = 0' });
    expect(refused).toMatchObject({ ok: false, code: 'WritesOff' });
    expect(refused.message).toContain('Allow writes');
    expect(script.calls).toEqual([]);

    const on = world({ 'allow-writes': true });
    await run(on.panda, on.lifetime, envFor(script.driver));
    const [done] = await on.ask({ kind: 'run', id: 'w2', db: 'data/music.db', sql: 'UPDATE tracks SET plays = 0' });
    expect(done).toMatchObject({ ok: true, changes: 250, columns: [] });
    expect(script.calls[0]).toMatchObject({ readOnly: false });
  });

  test('service: Cancel stops a running statement, a timeout names its limit, and stopping the service cancels what runs', async () => {
    const { run } = await logic();
    const w = world({ 'timeout-seconds': '3' });
    const script = scripted({ 'SELECT slow': { error: 'Timeout' } });
    await run(w.panda, w.lifetime, envFor(script.driver));
    const [timeout] = await w.ask({ kind: 'run', id: 't1', db: 'data/music.db', sql: 'SELECT slow' });
    expect(timeout).toMatchObject({ ok: false, code: 'Timeout' });
    expect(timeout.message).toContain('3 s');

    const running = w.ask({ kind: 'run', id: 'c1', db: 'data/music.db', sql: 'SELECT forever' });
    await expect.poll(() => script.calls.filter(call => call.id === 'c1').length).toBe(1);
    expect(await w.ask({ kind: 'cancel', id: 'c1' })).toEqual([]);
    expect(script.cancelled).toEqual(['c1']);
    expect((await running)[0]).toMatchObject({ id: 'c1', ok: false, code: 'Cancelled' });

    const last = w.ask({ kind: 'run', id: 'c2', db: 'data/music.db', sql: 'SELECT forever' });
    await expect.poll(() => script.calls.filter(call => call.id === 'c2').length).toBe(1);
    w.stop();
    expect(script.cancelled).toContain('c2');
    expect((await last)[0]).toMatchObject({ ok: false, code: 'Cancelled' });
    // A stopped service has let go of its channel: nothing is left to answer.
    expect(w.listeners()).toBe(0);
    expect(w.hooks.has('save.before')).toBe(false);
  });

  test('service: choosing a database lists the project files; the file is opened and checked before the page may write the header', async () => {
    const { run } = await logic();
    const w = world();
    const script = scripted({});
    await run(w.panda, w.lifetime, envFor(script.driver, ['data/music.db', 'notes.sql']));
    const [listed] = await w.ask({ kind: 'databases', id: 'd1' });
    expect(listed).toEqual({ kind: 'databases', id: 'd1', items: ['data/music.db'] });
    const [opened] = await w.ask({ kind: 'open', id: 'o1', db: 'data/music.db' });
    expect(opened).toMatchObject({ kind: 'opened', ok: true, db: 'data/music.db', tables: [{ name: 'tracks' }] });
    const [missing] = await w.ask({ kind: 'open', id: 'o2', db: 'data/gone.db' });
    expect(missing).toMatchObject({ kind: 'opened', ok: false, code: 'NotFound' });
    const [invalid] = await w.ask({ kind: 'open', id: 'o3', db: '../etc.db' });
    expect(invalid).toMatchObject({ kind: 'opened', ok: false, code: 'InvalidShape' });
    // The "Databases" view lists the tables of each file (a host-rendered tree).
    await expect.poll(() => w.updates.filter(update => update.id === `${OWNER}/databases`).length).toBeGreaterThan(0);
    const tree = w.updates.filter(update => update.id === `${OWNER}/databases`).at(-1)!.patch.controls[0];
    expect(tree).toMatchObject({ kind: 'tree', label: 'Tables', items: [{ label: 'data/music.db', children: [{ label: 'tracks' }] }] });
  });

  test('service: the hook before save records the file in Recent notes and never alters or delays the save', async () => {
    const { run } = await logic();
    const w = world();
    await run(w.panda, w.lifetime, envFor(scripted({}).driver));
    const hook = w.hooks.get('save.before')!;
    expect(hook({ projectId: 'p1', path: 'notes/a.sql', text: 'SELECT 1;', trigger: 'user' })).toBeUndefined();
    expect(hook({ projectId: 'p1', path: 'notes/b.sql', text: 'SELECT 2;', trigger: 'auto' })).toBeUndefined();
    expect(hook({ projectId: 'p1', path: 'notes/a.sql', text: 'SELECT 1;', trigger: 'user' })).toBeUndefined();
    expect(hook({ projectId: 'p1' })).toBeUndefined();
    const lists = w.updates.filter(update => update.id === `${OWNER}/recent`);
    expect(lists.at(-1)!.patch.controls[0]).toMatchObject({ kind: 'list', label: 'Notes' });
    expect(lists.at(-1)!.patch.controls[0].items.map((item: string) => item.split(' (')[0])).toEqual(['notes/a.sql', 'notes/b.sql']);
  });
});

// ---- the real driver against B6 ---------------------------------------------------------------------------------------

test.describe('sql notebook (R1211): the real driver and the B6 database file', () => {
  test.describe.configure({ mode: 'serial' });
  let folder = '';
  let driver: Obj;
  test.beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'pandacode-sqlnote-'));
    mkdirSync(join(folder, 'data'));
    mkdirSync(join(folder, 'notes'));
    const { makeDatabase } = await import('./fixtures/extensions/backends/make-sqlite/make-sqlite.mjs');
    makeDatabase(join(folder, 'data', 'music.db'), 250);
    writeFileSync(join(folder, 'notes', 'q.sql'), '-- sqlnote: db=data/music.db\nSELECT id, title, plays, cover FROM tracks;\n');
    driver = createRequire(import.meta.url)(`../${PACKAGE}/lib/driver.cjs`).createDriver();
  });
  test.afterAll(() => { driver?.stopAll(); if (folder) rmSync(folder, { recursive: true, force: true }); });

  async function live(values: Obj = {}) {
    const { run } = await logic();
    const w = world(values);
    const env = { driver, resolve: (_project: string, relative: string) => join(folder, ...relative.split('/')), listDatabases: async () => ['data/music.db'] };
    await run(w.panda, w.lifetime, env);
    return w;
  }
  const query = async (w: Awaited<ReturnType<typeof live>>, sql: string, id = `r${Math.random().toString(36).slice(2)}`) => (await w.ask({ kind: 'run', id, db: 'data/music.db', sql }))[0];

  test('250 tracks show 100 rows with a truncation note, the first row keeps the integer above 2^53 and a 1.2 KB BLOB label', async () => {
    const w = await live();
    const result = await query(w, 'SELECT id, title, plays, cover FROM tracks ORDER BY id');
    expect(result).toMatchObject({ ok: true, truncated: true, shown: 100, columns: ['id', 'title', 'plays', 'cover'] });
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]).toEqual([{ k: 'int', v: '1' }, { k: 'text', v: 'Track 1' }, { k: 'int', v: '9007199254740993' }, { k: 'blob', v: '<blob 1.2 KB>' }]);
    w.stop();
  });

  test('a small table is not truncated; the schema of the file lists both tables', async () => {
    const w = await live();
    expect(await query(w, 'SELECT * FROM albums')).toMatchObject({ ok: true, truncated: false });
    const [opened] = await w.ask({ kind: 'open', id: 'o', db: 'data/music.db' });
    expect(opened.tables.map((table: Obj) => table.name)).toEqual(['albums', 'tracks']);
    expect(opened.tables.find((table: Obj) => table.name === 'tracks').columns).toEqual(['id', 'title', 'minutes', 'cover', 'plays']);
    w.stop();
  });

  test('the database error text reaches the editor and the next statement still runs', async () => {
    const w = await live();
    const bad = await query(w, 'SELEC 1');
    expect(bad).toMatchObject({ ok: false, code: 'SqlError' });
    expect(bad.message).toMatch(/syntax error/i);
    const next = await query(w, 'SELECT count(*) AS n FROM tracks');
    expect(next).toMatchObject({ ok: true, rows: [[{ k: 'int', v: '250' }]] });
    expect(await query(w, 'SELECT * FROM missing_table')).toMatchObject({ ok: false, code: 'SqlError' });
    w.stop();
  });

  test('writes are refused with the setting off (the file is opened read-only) and run with it on, with the changed count', async () => {
    const off = await live();
    expect(await query(off, "UPDATE albums SET name = 'Renamed'")).toMatchObject({ ok: false, code: 'WritesOff' });
    expect((await query(off, 'SELECT name FROM albums')).rows.flat().map((item: Obj) => item.v)).not.toContain('Renamed');
    off.stop();
    const on = await live({ 'allow-writes': true });
    const changed = await query(on, "UPDATE albums SET name = 'Renamed'");
    expect(changed).toMatchObject({ ok: true });
    expect(changed.changes).toBeGreaterThan(0);
    expect((await query(on, 'SELECT name FROM albums')).rows.flat().map((item: Obj) => item.v)).toContain('Renamed');
    on.stop();
  });

  test('a statement that runs longer than the timeout is stopped, and Cancel stops it earlier; the service stays usable', async () => {
    test.setTimeout(60_000);
    const w = await live({ 'timeout-seconds': '1' });
    const endless = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c';
    const started = Date.now();
    const stopped = await query(w, endless, 'slow');
    expect(stopped).toMatchObject({ ok: false, code: 'Timeout' });
    expect(Date.now() - started).toBeLessThan(8000);
    const running = w.ask({ kind: 'run', id: 'early', db: 'data/music.db', sql: endless });
    await new Promise(resolve => setTimeout(resolve, 150));
    await w.ask({ kind: 'cancel', id: 'early' });
    expect((await running)[0]).toMatchObject({ ok: false, code: 'Cancelled' });
    expect(await query(w, 'SELECT 1 AS one')).toMatchObject({ ok: true, rows: [[{ k: 'int', v: '1' }]] });
    w.stop();
  });

  test('a long text value is shortened with a mark, and a file that is not a database is a result, not a crash', async () => {
    const w = await live();
    const long = await query(w, "SELECT replace(hex(zeroblob(400)), '00', 'ab') AS big");
    expect(long.rows[0][0]).toMatchObject({ k: 'text', cut: true });
    expect(long.rows[0][0].v).toHaveLength(200);
    writeFileSync(join(folder, 'data', 'fake.db'), 'this is not a database file at all, just text.');
    const [opened] = await w.ask({ kind: 'open', id: 'bad', db: 'data/fake.db' });
    expect(opened).toMatchObject({ kind: 'opened', ok: false });
    w.stop();
  });
});

// ---- the host side: the R0901 / R0902 / R0903 twins with this package ---------------------------------------------------

class Disk implements Project {
  files = new Map<string, Uint8Array>();
  failWrite = false;
  known() { return true; }
  async createNew(_project: string, path: string, bytes: Uint8Array) { if (this.files.has(path)) return { ok: false as const, code: 'Conflict' as const }; this.files.set(path, bytes); return { ok: true as const }; }
  async read(_project: string, path: string) { const bytes = this.files.get(path); return bytes ? { ok: true as const, bytes, readOnly: false } : { ok: false as const, code: 'NotFound' as const }; }
}

/** The package's editor, template and save hook over an in-memory project; `installed: false` is the app without the package. */
async function host(options: { installed?: boolean; disk?: Disk } = {}) {
  const disk = options.disk ?? new Disk();
  const state = { grant: true, dynamic: true, installed: options.installed !== false, throws: false, gone: false };
  const editorsDecl = (checkEditorDeclarations(manifest) as { editors: any[] }).editors;
  const itemsDecl = (checkNewFileDeclarations(manifest) as { items: any[] }).items;
  const holds = (_owner: string, _version: string, permission: string, _project: string | null) => state.installed && state.grant && permission === PERMISSION;
  const editorEntry = (): EditorEntry[] => (state.installed && !state.gone ? [{ owner: OWNER, version: '1.0.0', packageName: manifest.name, editors: editorsDecl }] : []);
  const wiring: Wiring = {
    source: editorEntry, holds,
    write: async (_project, path, content: Content) => { if (disk.failWrite) return false; disk.files.set(path, 'text' in content ? encoder.encode(content.text) : content.bytes); return true; },
  };
  const editors = new DocumentEditors(wiring);
  const fileEntry: FileEntry = { owner: OWNER, version: '1.0.0', packageName: manifest.name, items: itemsDecl };
  const env: Env = { source: () => (state.installed && !state.gone ? [fileEntry] : []), holds, dynamic: () => state.dynamic, template: (_owner, _version, path) => (path === 'templates/empty.sql' ? new Uint8Array(template) : undefined), files: disk };
  const flow = new NewFiles(env);

  // The package's own service, with the hook the host asks on every .sql save.
  const { run } = await logic();
  const w = world();
  await run(w.panda, w.lifetime, envFor(scripted({}).driver));
  const saveEnv: SaveEnv = {
    members: (_project, path) => (state.installed && !state.gone && extensionOf(path) === '.sql'
      ? [{ owner: OWNER, name: manifest.name, hookId: `${OWNER}/save`, budgetMs: 200, ask: async payload => { if (state.throws) throw new Error('boom'); return w.hooks.get('save.before')!(payload); } } as SaveMember]
      : []),
    admitted: (_owner, project) => state.installed && !state.gone && state.grant && project === 'p1',
    holds: (_owner, project) => state.installed && state.grant && project === 'p1',
    deliver: () => undefined,
  };
  const save = new DocumentSave(editors, saveEnv);
  const text = (path: string) => decoder.decode(disk.files.get(path)!);
  return { disk, state, editors, flow, save, w, text };
}

test.describe('sql notebook (R1211): host buffers, new file, save and reopen', () => {
  test('New SQL note creates the file from the package template and opens it in the notebook editor', async () => {
    const h = await host();
    expect(h.flow.menu('p1').map(item => [item.id, item.package])).toEqual([[ITEM, 'SQL notebook']]);
    const created = await h.flow.handle(h.editors, { op: 'create', projectId: 'p1', item: ITEM, name: 'notes/today' });
    expect(created).toMatchObject({ ok: true, path: 'notes/today.sql', editor: EDITOR, reason: 'declared' });
    expect(normalize(h.text('notes/today.sql'))).toBe(normalize(decoder.decode(template)));
    expect(h.editors.mounts('p1', 'notes/today.sql').map(mount => [mount.editor, mount.owner, mount.placement])).toEqual([[EDITOR, OWNER, 'window']]);
    expect(h.editors.buffer('p1', 'notes/today.sql')?.dirty).toBe(false);
    // An existing name is never overwritten.
    expect(await h.flow.handle(h.editors, { op: 'create', projectId: 'p1', item: ITEM, name: 'notes/today' })).toMatchObject({ ok: false, code: 'Conflict', what: 'file' });
    // The user's choice of the built-in editor wins over the template's editor.
    expect(await h.flow.handle(h.editors, { op: 'create', projectId: 'p1', item: ITEM, name: 'notes/plain', editor: BUILTIN })).toMatchObject({ ok: true, editor: BUILTIN, reason: 'override' });
  });

  test('a .sql file opens in the notebook editor, the built-in editor is one click away and so is the way back', async () => {
    const h = await host();
    h.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    expect(h.editors.select('p1', 'q.sql')).toMatchObject({ editor: EDITOR, reason: 'default' });
    const opened = await h.flow.reveal(h.editors, null, 'p1', 'q.sql');
    expect(opened).toMatchObject({ ok: true, editor: EDITOR, reason: 'selected' });
    const mount = h.editors.mounts('p1', 'q.sql')[0];
    const builtin = h.editors.switchTo(mount.id, BUILTIN);
    expect(builtin).toMatchObject({ ok: true, mount: { editor: BUILTIN, owner: null } });
    expect(h.editors.select('p1', 'q.sql')).toMatchObject({ editor: BUILTIN });
    expect(h.editors.buffer('p1', 'q.sql')?.snapshot().content).toEqual({ text: 'SELECT 1;\n' });
    if (!builtin.ok) return;
    expect(h.editors.switchTo(builtin.mount.id, EDITOR)).toMatchObject({ ok: true, mount: { editor: EDITOR, owner: OWNER } });
  });

  test('save writes the host buffer, the hook only records the file, and the panel hears didSave', async () => {
    const h = await host();
    h.disk.files.set('notes/a.sql', encoder.encode('SELECT 1;\n'));
    await h.flow.reveal(h.editors, null, 'p1', 'notes/a.sql');
    const mount = h.editors.mounts('p1', 'notes/a.sql')[0];
    h.editors.editBuiltin('p1', 'notes/a.sql', { text: '-- sqlnote: db=data/music.db\nSELECT 2;\n' });
    expect(h.editors.buffer('p1', 'notes/a.sql')?.dirty).toBe(true);
    const saved = await h.save.save('p1', 'notes/a.sql', 'user');
    expect(saved).toMatchObject({ ok: true, transformed: false });
    expect(h.text('notes/a.sql')).toBe('-- sqlnote: db=data/music.db\nSELECT 2;\n');
    expect(h.editors.buffer('p1', 'notes/a.sql')?.dirty).toBe(false);
    expect(h.save.drain(mount.id).map(kindOf)).toEqual(['didSave']);
    const recent = h.w.updates.filter(update => update.id === `${OWNER}/recent`).at(-1)!;
    expect(recent.patch.controls[0].items[0]).toContain('notes/a.sql');
    expect(h.save.audit.map(entry => entry.action)).toContain('save.before');
  });

  test('a failing hook, a failing write and a grant revoked in the middle never lose the text', async () => {
    const h = await host();
    h.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    await h.flow.reveal(h.editors, null, 'p1', 'q.sql');
    h.editors.editBuiltin('p1', 'q.sql', { text: 'SELECT 3;\n' });
    h.state.throws = true;
    expect(await h.save.save('p1', 'q.sql', 'user')).toMatchObject({ ok: true });
    expect(h.text('q.sql')).toBe('SELECT 3;\n');
    h.state.throws = false;
    // The write itself fails: the buffer stays dirty and keeps the text; the next save works.
    h.editors.editBuiltin('p1', 'q.sql', { text: 'SELECT 4;\n' });
    h.disk.failWrite = true;
    expect(await h.save.save('p1', 'q.sql', 'user')).toEqual({ ok: false, code: 'HostUnavailable' });
    expect(h.editors.buffer('p1', 'q.sql')).toMatchObject({ dirty: true });
    expect(h.editors.buffer('p1', 'q.sql')?.snapshot().content).toEqual({ text: 'SELECT 4;\n' });
    expect(h.text('q.sql')).toBe('SELECT 3;\n');
    h.disk.failWrite = false;
    expect(await h.save.save('p1', 'q.sql', 'auto')).toMatchObject({ ok: true });
    expect(h.text('q.sql')).toBe('SELECT 4;\n');
  });

  test('an external disk change replaces an unchanged tab; with unsaved edits it is kept aside and the save is refused until the user picks', async () => {
    const h = await host();
    h.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    await h.flow.reveal(h.editors, null, 'p1', 'q.sql');
    const mount = h.editors.mounts('p1', 'q.sql')[0];
    expect(h.editors.diskChanged('p1', 'q.sql', { text: 'SELECT 10;\n' })).toBe('replaced');
    expect(h.save.drain(mount.id).map(kindOf)).toEqual(['replace:disk']);
    expect(h.editors.buffer('p1', 'q.sql')?.snapshot().content).toEqual({ text: 'SELECT 10;\n' });

    h.editors.editBuiltin('p1', 'q.sql', { text: 'SELECT mine;\n' });
    expect(h.editors.diskChanged('p1', 'q.sql', { text: 'SELECT theirs;\n' })).toBe('conflict');
    expect(h.editors.buffer('p1', 'q.sql')?.snapshot().content).toEqual({ text: 'SELECT mine;\n' });
    expect(await h.save.save('p1', 'q.sql', 'user')).toEqual({ ok: false, code: 'Conflict' });
    expect(h.editors.resolveConflict('p1', 'q.sql', 'keep')).toEqual({ ok: true });
    expect(await h.save.save('p1', 'q.sql', 'user')).toMatchObject({ ok: true });
    expect(h.text('q.sql')).toBe('SELECT mine;\n');
  });

  test('a panel that fails, a revoked grant and a disabled package all end in the built-in editor over the same text', async () => {
    const h = await host();
    h.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    await h.flow.reveal(h.editors, null, 'p1', 'q.sql');
    h.editors.editBuiltin('p1', 'q.sql', { text: 'SELECT unsaved;\n' });
    const mount = h.editors.mounts('p1', 'q.sql')[0];
    expect(h.editors.panelFailed(mount.id)).toMatchObject({ ok: true, mount: { editor: BUILTIN, failure: 'panel-failed' } });
    expect(h.editors.buffer('p1', 'q.sql')?.snapshot().content).toEqual({ text: 'SELECT unsaved;\n' });

    const second = await host();
    second.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    await second.flow.reveal(second.editors, null, 'p1', 'q.sql');
    second.state.grant = false;
    expect(second.editors.grantsChanged().map(item => item.failure)).toEqual(['grant-revoked']);
    expect(await second.flow.handle(second.editors, { op: 'create', projectId: 'p1', item: ITEM, name: 'x' })).toMatchObject({ ok: false, code: 'PermissionDenied', what: 'grant' });
    expect(second.flow.menu('p1')).toEqual([]);

    const third = await host();
    third.disk.files.set('q.sql', encoder.encode('SELECT 1;\n'));
    await third.flow.reveal(third.editors, null, 'p1', 'q.sql');
    third.editors.editBuiltin('p1', 'q.sql', { text: 'SELECT unsaved;\n' });
    third.state.gone = true;
    expect(third.save.packageGone(OWNER).map(item => item.failure)).toEqual(['editor-removed']);
    expect(third.editors.buffer('p1', 'q.sql')).toMatchObject({ dirty: true });
    // The next save (no package hook, built-in mount) writes the unsaved text.
    expect(await third.save.save('p1', 'q.sql', 'user')).toMatchObject({ ok: true });
    expect(third.text('q.sql')).toBe('SELECT unsaved;\n');
  });

  test('save and reopen without the package: the app without it (disabled, uninstalled, safe mode) opens the same text in the built-in editor', async () => {
    const h = await host();
    const created = await h.flow.handle(h.editors, { op: 'create', projectId: 'p1', item: ITEM, name: 'notes/keep' });
    expect(created.ok).toBe(true);
    h.editors.editBuiltin('p1', 'notes/keep.sql', { text: '-- sqlnote: db=data/music.db\nSELECT count(*) FROM tracks;\n' });
    expect(await h.save.save('p1', 'notes/keep.sql', 'user')).toMatchObject({ ok: true });
    const bare = await host({ installed: false, disk: h.disk });
    expect(bare.editors.select('p1', 'notes/keep.sql')).toMatchObject({ editor: BUILTIN, reason: 'builtin' });
    expect(await bare.flow.reveal(bare.editors, null, 'p1', 'notes/keep.sql')).toMatchObject({ ok: true, editor: BUILTIN, reason: 'selected' });
    expect(bare.editors.buffer('p1', 'notes/keep.sql')?.snapshot().content).toEqual({ text: '-- sqlnote: db=data/music.db\nSELECT count(*) FROM tracks;\n' });
    expect(bare.flow.menu('p1')).toEqual([]);
    // With the package back, the same file opens in its editor over the same content.
    const back = await host({ disk: h.disk });
    expect(await back.flow.reveal(back.editors, null, 'p1', 'notes/keep.sql')).toMatchObject({ ok: true, editor: EDITOR });
  });

  test('a .sql file that is not UTF-8 text (a byte buffer) is not forced into the text editor; the built-in editor shows it', async () => {
    const h = await host();
    h.disk.files.set('odd.sql', new Uint8Array([0x53, 0x45, 0x4c, 0xff, 0xfe, 0x00]));
    expect(await h.flow.reveal(h.editors, null, 'p1', 'odd.sql', EDITOR)).toMatchObject({ ok: false, code: 'InvalidShape', what: 'editor' });
    expect(await h.flow.reveal(h.editors, null, 'p1', 'odd.sql', BUILTIN)).toMatchObject({ ok: true, editor: BUILTIN });
    const buffer = h.editors.buffer('p1', 'odd.sql')!;
    expect(buffer.encoding).toBe('bytes');
    expect(Array.from((buffer.snapshot().content as { bytes: Uint8Array }).bytes)).toEqual([0x53, 0x45, 0x4c, 0xff, 0xfe, 0x00]);
    expect(await h.save.save('p1', 'odd.sql', 'user')).toMatchObject({ ok: true });
    expect(Array.from(h.disk.files.get('odd.sql')!)).toEqual([0x53, 0x45, 0x4c, 0xff, 0xfe, 0x00]);
  });
});

// ---- the evidence columns ----------------------------------------------------------------------------------------------

test('sql notebook (R1211): every installed and both-engine column is prepared, not run, and the spec is registered for both engines', () => {
  expect(columns.package).toBe(OWNER);
  for (const column of columns.columns as Obj[]) {
    expect(column.status, column.id).toBe('prepared, not run (deferred to the final test phase)');
    expect(column.behaviours.length, column.id).toBeGreaterThan(0);
  }
  expect((columns.columns as Obj[]).map(column => column.id)).toEqual(['preview-node', 'native-real-driver', 'installed-windows', 'both-engines']);
  for (const config of ['playwright.config.ts', 'playwright.webkit.config.ts']) expect(read(config), config).toContain('extensions-example-sql-notebook.spec.ts');
});
