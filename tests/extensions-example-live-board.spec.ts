import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import type { SettingsPackage, Store } from '../src/extensions/runtime-content-resources';
import { createRuntimePreview, type DaemonFactory, type Grants, type Loaders, type PreviewManifest, type ServiceModule } from '../src/extensions/runtime-preview';

// R1201: the Work board (sample.live-board), cut A. PREVIEW column: the shipped lib/board.mjs of the example package runs in
// the preview runner (src/extensions/runtime-preview.ts) against B1's browser-importable core. It proves the board's logic and
// what the interface would be handed (the live layer); the installed package is qualified by the native tests
// (src-tauri/src/extensions/runtime_live_board_acceptance.rs). Written for the final test phase; not run when written.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/live-board/package/extension.json')) as PreviewManifest & { permissions: string[]; contributes: { settings: { id: string; fields: { id: string; kind: string; value?: string }[] }[] } };
const OWNER = 'sample.live-board';
const PAGE = `${OWNER}/tracker`, STATUS = `${OWNER}/ready`, VIEW = `${OWNER}/board`, RETRY_ITEM = `${OWNER}/retry-button`, RETRY = `${OWNER}/retry`, WHO = `${OWNER}/who`;
const SEED = { issues: [{ id: 'T-1', title: 'One' }, { id: 'T-2', title: 'Two', dependsOn: ['T-1'] }, { id: 'T-3', title: 'Three', status: 'closed' }] };

type Layer = { menus: { id: string }[]; overrides: Record<string, Record<string, unknown>> };
type Table = { kind: string; label: string; columns: string[]; rows: string[][] };

async function boot(over: { offline?: boolean; grants?: Grants; seed?: typeof SEED; safeMode?: boolean } = {}) {
  const { createDaemon } = await import('./fixtures/extensions/backends/core/fake-daemon.mjs');
  const loaders: Loaders = { 'main.cjs': () => import('../examples/extensions/live-board/package/lib/board.mjs') as Promise<ServiceModule> };
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  const page = manifest.contributes.settings[0];
  const settings: SettingsPackage[] = [{ id: OWNER, enabled: true, pages: [{ id: PAGE, fields: page.fields }], stored: {} } as unknown as SettingsPackage];
  const store: Store = { tasks: [], messages: [], changes: [], revision: 1 };
  let clock = 1000;
  // The tracker can be "away": its answers fail, but frames that were already on the wire still arrive, like an event that
  // reaches the service just before the daemon stops answering.
  const link = { offline: over.offline ?? false };
  let deliver: Parameters<DaemonFactory>[0] = () => undefined;
  const core = createDaemon({ now: () => clock, emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => deliver(topic, frame), seed: over.seed ?? SEED });
  const daemon: DaemonFactory = emit => {
    deliver = emit;
    return {
      request: (op, params) => { if (link.offline) throw Object.assign(new Error('away'), { code: 'HostUnavailable' }); return core.request(op, params); },
      control: (path, params) => core.control(path, params),
    };
  };
  const preview = createRuntimePreview({ manifest, loaders, grants, settings, store, daemon, now: () => clock, scopes: { tasks: ['t1'], projects: ['p1'] }, safeMode: over.safeMode });
  // The host applies 20 updates a second to a package: every action of the spec happens a second after the last.
  const act = async <T>(run: () => T | Promise<T>): Promise<T> => { clock += 1100; return run(); };
  const owner = () => (preview.layer().owners[OWNER] as Layer | undefined);
  const view = () => owner()?.overrides[VIEW];
  const table = () => (view()?.controls as Table[] | undefined)?.[0];
  return {
    preview, grants, link, core, act, owner, view, table,
    statusText: () => owner()?.overrides[STATUS]?.text as string | undefined,
    tooltip: () => owner()?.overrides[STATUS]?.tooltip as string | undefined,
    retryButtons: () => (owner()?.menus ?? []).filter(item => item.id === RETRY_ITEM).length,
    held: () => { try { return JSON.parse(preview.status.text ?? 'null') as Record<string, unknown>; } catch { return null; } },
    signal: (payload: Record<string, unknown>) => act(() => preview.daemonControl('signal', { name: 'order', payload })),
    issue: (issue: Record<string, unknown>) => act(() => core.control('issues', { op: 'add', issue })),
  };
}
type Board = Awaited<ReturnType<typeof boot>>;
const within = (what: string, check: () => unknown, timeout = 2000) => expect.poll(check, { message: what, timeout, intervals: [10, 20, 50] });

test('live board preview: the package is a valid service package whose logic file is browser-safe', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'events.workspace', 'ui.dynamic', 'ui.notify']);
  expect(manifest.runtime).toMatchObject({ kind: 'node', entrypoint: 'main.cjs', files: ['lib'], service: { start: 'onEnable' } });
  const logic = read('examples/extensions/live-board/package/lib/board.mjs');
  expect(logic).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(logic).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function/);
  for (const call of ['panda.ui.update(', 'panda.ui.updateView(', 'panda.ui.showDialog(', 'panda.commands.register(', "'settings.changed'", "'task.shown'", 'link.request(']) expect(logic, call).toContain(call);
  const main = read('examples/extensions/live-board/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:net']);
  expect([...main.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['./lib/board.mjs']);
});

test('live board preview: the ready count and the dynamic table follow the tracker within 2 s, by event and by signal', async () => {
  const board = await boot();
  expect(await board.preview.start()).toEqual({ ok: true });
  // Ready is the daemon's own list (T-1); T-2 waits on it and T-3 is closed. One table row per issue, no Retry button.
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  expect(board.table()).toMatchObject({ kind: 'table', label: 'Issues', columns: ['Issue', 'Title', 'Status', 'Assignee'] });
  expect(board.table()?.rows).toEqual([['T-1', 'One', 'ready', '-'], ['T-2', 'Two', 'blocked', '-'], ['T-3', 'Three', 'closed', '-']]);
  expect(board.retryButtons()).toBe(0);
  expect(board.owner()?.overrides[STATUS]).toMatchObject({ tone: 'success', tooltip: '3 issues, 1 blocked.' });
  // B1 changes the store and pushes `issues.changed`: no click, no signal.
  const started = Date.now();
  await board.issue({ id: 'T-4', title: 'Four' });
  await within('the added issue', () => board.statusText()).toBe('2 ready');
  expect(board.table()?.rows).toHaveLength(4);
  expect(Date.now() - started).toBeLessThan(2000);
  // Closing T-4 leaves T-1 alone on the ready list; a signal of B1 then says "read again" and changes nothing more.
  await board.act(() => board.core.control('issues', { op: 'update', issue: { id: 'T-4', status: 'closed' } }));
  await within('the closed issue', () => board.statusText()).toBe('1 ready');
  await board.signal({ op: 'refresh' });
  await within('the held status', () => board.held()).toMatchObject({ ready: 1, total: 4, offline: false, unit: 'ready' });
  // An unknown signal does nothing.
  const revision = board.preview.layer().revision;
  await board.signal({ op: 'nothing' });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(board.preview.layer().revision).toBe(revision);
  await board.preview.stop();
});

test('live board preview: a Retry click reaches the service and the button leaves after the tracker recovers', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  // The tracker goes away just as a signal reaches the service: the read fails, the snapshot stays and is marked stale.
  board.link.offline = true;
  await board.signal({ op: 'refresh' });
  await within('the offline marking', () => board.statusText()).toBe('Tracker offline');
  expect(board.retryButtons()).toBe(1);
  expect(board.table()?.rows).toHaveLength(3);
  expect(board.table()?.label).toMatch(/^Issues \(stale since \d\d:\d\d:\d\d UTC\)$/);
  expect(board.view()?.text).toMatch(/^Stale: the tracker is offline \(stale since .*\)\. 1 ready of 3 issues, 1 blocked\.$/);
  expect(board.owner()?.overrides[STATUS]).toMatchObject({ tone: 'warning', text: 'Tracker offline' });
  expect(board.preview.noticeSnapshot().notices.map(notice => notice.text)).toEqual(['Tracker offline']);
  // The button is the live item of the header, wired to the package's own Retry command.
  expect(board.owner()?.menus.find(item => item.id === RETRY_ITEM)).toMatchObject({ location: 'panda.workspace.header.actions', command: RETRY, presentation: 'button', text: 'Retry tracker' });
  // A click while it is still away reaches the service, which stays offline and keeps one button.
  expect(await board.act(() => board.preview.invoke(RETRY))).toEqual({ offline: true, retries: 1 });
  expect(board.retryButtons()).toBe(1);
  expect(board.table()?.rows).toHaveLength(3);
  // The tracker answers again: the next click reads it, the button is disposed and the notice withdrawn.
  board.link.offline = false;
  expect(await board.act(() => board.preview.invoke(RETRY))).toEqual({ offline: false, retries: 2 });
  await within('the recovery', () => board.retryButtons()).toBe(0);
  expect(board.statusText()).toBe('1 ready');
  expect(board.table()?.rows).toHaveLength(3);
  expect(board.table()?.label).toBe('Issues');
  expect(board.view()?.text).not.toContain('Stale');
  expect(board.preview.noticeSnapshot().notices).toEqual([]);
  expect(board.held()).toMatchObject({ offline: false, retries: 2, ready: 1 });
  // And the board follows the tracker again without a click.
  await board.issue({ id: 'T-5', title: 'Five' });
  await within('the new issue after recovery', () => board.statusText()).toBe('2 ready');
  expect(board.table()?.rows).toHaveLength(4);
  // A handler of an unknown command is never reachable.
  await expect(board.preview.invoke(`${OWNER}/nothing`)).rejects.toMatchObject({ code: 'NotFound' });
  await board.preview.stop();
  expect(board.preview.items.count(OWNER)).toBe(0);
});

test('live board preview: a tracker that was never read is unknown, never an empty board', async () => {
  const board = await boot({ offline: true });
  expect(await board.preview.start()).toEqual({ ok: true });
  await within('the offline marking', () => board.statusText()).toBe('Tracker offline');
  // No table: an empty one would say "no issues". The view carries a list that says nothing is known.
  expect(board.table()).toMatchObject({ kind: 'list', items: ['Unknown until the tracker answers'] });
  expect(board.view()?.text).toContain('no snapshot yet');
  expect(board.retryButtons()).toBe(1);
  expect(board.held()).toMatchObject({ ready: null, total: null, offline: true });
  // The first successful read replaces the list with the table and removes the button.
  board.link.offline = false;
  await board.act(() => board.preview.invoke(RETRY));
  await within('the first table', () => board.table()?.kind).toBe('table');
  expect(board.table()?.rows).toHaveLength(3);
  expect(board.retryButtons()).toBe(0);
  await board.preview.stop();
  // A genuinely empty tracker is a table with no rows and a text that says so, not a failure.
  const empty = await boot({ seed: { issues: [] } });
  await empty.preview.start();
  await within('an empty tracker', () => empty.statusText()).toBe('0 ready');
  expect(empty.table()).toMatchObject({ kind: 'table', rows: [] });
  expect(empty.view()?.text).toBe('0 ready of 0 issues, 0 blocked.');
  await empty.preview.stop();
});

test('live board preview: a dialog answer reaches the service state and a cancelled one changes nothing', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  // From a signal: the dialog waits for the user.
  await board.signal({ op: 'ask' });
  await within('the dialog', () => board.preview.dialogs.pending().length).toBe(1);
  const [pending] = board.preview.dialogs.pending();
  expect(pending.owner).toBe(OWNER);
  expect(board.preview.answerDialog(pending.id, { status: 'confirmed', values: { actor: 'Ada' } })).toMatchObject({ ok: true });
  await within('the answer in the service', () => board.held()).toMatchObject({ actor: 'Ada', answers: 1 });
  await within('the actor on the status item', () => board.tooltip()).toBe('3 issues, 1 blocked. Working: Ada.');
  // From the header button's command: the click returns the answer.
  const asking = board.act(() => board.preview.invoke(WHO));
  await within('the second dialog', () => board.preview.dialogs.pending().length).toBe(1);
  board.preview.answerDialog(board.preview.dialogs.pending()[0].id, { status: 'cancelled' });
  expect(await asking).toEqual({ status: 'cancelled', actor: 'Ada' });
  expect(board.held()).toMatchObject({ actor: 'Ada', answers: 2 });
  // A second dialog while one waits is refused by the host and recorded; the first is untouched.
  void board.act(() => board.preview.invoke(WHO));
  await within('the third dialog', () => board.preview.dialogs.pending().length).toBe(1);
  await expect(board.preview.invoke(WHO)).resolves.toEqual({ status: 'refused', actor: 'Ada' });
  expect(board.held()?.refused).toEqual(['Conflict']);
  expect(board.preview.dialogs.pending()).toHaveLength(1);
  // Stopping the service cancels what waits.
  await board.preview.stop('disable');
  expect(board.preview.dialogs.count(OWNER)).toBe(0);
});

test('live board preview: settings and task or project switches keep the board coherent', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  const first = JSON.stringify(board.owner());
  // A switch of task or project changes nothing on the board and builds nothing twice.
  for (const event of [{ kind: 'task.shown', windowId: 'main', taskId: 't1', projectId: 'p1' }, { kind: 'task.shown', windowId: 'main', taskId: null, projectId: null }, { kind: 'project.opened', projectId: 'p1' }, { kind: 'project.closed', projectId: 'p1' }]) {
    expect(await board.act(() => board.preview.publish(event))).toEqual({ queued: 1, dropped: 0 });
  }
  await within('the switches counted', () => board.held()).toMatchObject({ switches: 4 });
  expect(JSON.stringify(board.owner())).toBe(first);
  expect(board.preview.items.count(OWNER)).toBe(0);
  // A settings save moves the name of the count, and only the name.
  const revision = board.held()?.revision;
  const next = await board.act(() => board.preview.setSettings(PAGE, { daemon: '127.0.0.1:7421', unit: 'open' }));
  expect(next).not.toBe(revision);
  await within('the renamed count', () => board.statusText()).toBe('1 open');
  expect(board.held()).toMatchObject({ unit: 'open', revision: next });
  expect(board.table()?.rows).toHaveLength(3);
  expect(board.view()?.text).toBe('1 open of 3 issues, 1 blocked.');
  // An empty name falls back to the default; a switch after a save still changes nothing.
  await board.act(() => board.preview.setSettings(PAGE, { daemon: '127.0.0.1:7421', unit: '   ' }));
  await within('the default name', () => board.statusText()).toBe('1 ready');
  await board.act(() => board.preview.publish({ kind: 'task.shown', windowId: 'main', taskId: 't1', projectId: 'p1' }));
  await within('the fifth switch', () => board.held()).toMatchObject({ switches: 5, unit: 'ready' });
  // Another package's settings event never reaches this board.
  expect(board.preview.publish({ kind: 'settings.changed', page: PAGE, revision: 1 }, 'sample.other')).toEqual({ queued: 0, dropped: 0 });
  await board.preview.stop();
});

test('live board preview: losing a permission is a recorded refusal, never a crash, and the service keeps reading', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  await board.preview.revoke('ui.dynamic');
  expect(board.owner()).toBeUndefined();
  await board.issue({ id: 'T-4', title: 'Four' });
  await within('the refusal', () => board.held()?.refused).toContain('PermissionDenied');
  expect(board.preview.state).toBe('running');
  expect(board.held()).toMatchObject({ ready: 2, offline: false });
  await board.preview.stop();
});

test('live board preview: disable, safe mode and losing the service grant remove the board, and a restart leaves no stale button', async () => {
  for (const [act, reason] of [
    [(board: Board) => board.preview.setEnabled(false), 'disable'],
    [(board: Board) => board.preview.setSafeMode(true), 'safeMode'],
    [(board: Board) => board.preview.revoke('runtime.service'), 'trust'],
  ] as const) {
    const board = await boot({ offline: true });
    await board.preview.start();
    await within('the Retry button', () => board.retryButtons()).toBe(1);
    await act(board);
    expect([board.preview.state, board.preview.stopReason]).toEqual(['stopped', reason]);
    expect(board.owner()).toBeUndefined();
    expect(board.preview.dialogs.count(OWNER)).toBe(0);
    expect(board.preview.noticeSnapshot().notices).toEqual([]);
  }
  // Starting again (a restart after a stop or a crash) begins a new generation: one button, not two.
  const again = await boot({ offline: true });
  await again.preview.start();
  await within('the Retry button', () => again.retryButtons()).toBe(1);
  await again.preview.stop();
  expect(again.owner()).toBeUndefined();
  expect(await again.preview.start()).toEqual({ ok: true });
  await within('the Retry button again', () => again.retryButtons()).toBe(1);
  expect(again.preview.starts).toBe(2);
  await again.preview.stop();
  // Safe mode starts nothing at all.
  const safe = await boot({ safeMode: true });
  expect(await safe.preview.start()).toEqual({ ok: false, code: 'HostUnavailable' });
  expect(safe.owner()).toBeUndefined();
});

test('live board preview: the spec and the package are registered in both browsers, CI and the examples corpus', () => {
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-example-live-board.spec.ts');
  expect(read('playwright.webkit.config.ts')).toContain('live board preview:');
  const corpus = JSON.parse(read('tests/fixtures/extensions/examples-v1.json')) as { examples: { dir: string; id: string; executable: boolean }[] };
  expect(corpus.examples).toContainEqual(expect.objectContaining({ dir: 'live-board', id: OWNER, executable: true }));
  const doc = read('docs/extensions/examples/live-board.md');
  for (const text of ['sample.live-board', 'Preview evidence', 'runtime_live_board_acceptance.rs', 'Retry']) expect(doc, text).toContain(text);
});
