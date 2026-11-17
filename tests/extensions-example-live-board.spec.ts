import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import type { SettingsPackage, Store } from '../src/extensions/runtime-content-resources';
import { PreviewPanelHost } from '../src/extensions/runtime-rich-channel';
import { createRuntimePreview, type DaemonFactory, type Grants, type Loaders, type PreviewManifest, type ServiceModule } from '../src/extensions/runtime-preview';

// R1201 (cut A) and R1202 (cut B): the Work board (sample.live-board). PREVIEW column: the shipped lib/board.mjs of the example package runs in
// the preview runner (src/extensions/runtime-preview.ts) against B1's browser-importable core. It proves the board's logic and
// what the interface would be handed (the live layer); the installed package is qualified by the native tests
// (src-tauri/src/extensions/runtime_live_board_acceptance.rs). Cut B adds the rich panel: the same file also runs with a
// PreviewPanelHost and B2's own argument parser standing in for the command-line tool. The installed-Windows and both-engine
// columns are prepared in tests/fixtures/extensions/example-live-board/evidence-columns.json and not run.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/live-board/package/extension.json')) as PreviewManifest & { permissions: string[]; contributes: { settings: { id: string; fields: { id: string; kind: string; value?: string }[] }[] } };
const OWNER = 'sample.live-board';
const PAGE = `${OWNER}/tracker`, STATUS = `${OWNER}/ready`, VIEW = `${OWNER}/board`, RETRY_ITEM = `${OWNER}/retry-button`, RETRY = `${OWNER}/retry`, WHO = `${OWNER}/who`;
type Seed = { issues: Record<string, unknown>[] };
const SEED: Seed = { issues: [{ id: 'T-1', title: 'One' }, { id: 'T-2', title: 'Two', dependsOn: ['T-1'] }, { id: 'T-3', title: 'Three', status: 'closed' }] };

type Layer = { menus: { id: string }[]; overrides: Record<string, Record<string, unknown>> };
type Table = { kind: string; label: string; columns: string[]; rows: string[][] };

async function boot(over: { offline?: boolean; grants?: Grants; seed?: Seed; safeMode?: boolean; panels?: boolean } = {}) {
  const { createDaemon } = await import('./fixtures/extensions/backends/core/fake-daemon.mjs');
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  const page = manifest.contributes.settings[0];
  const settings: SettingsPackage[] = [{ id: OWNER, enabled: true, pages: [{ id: PAGE, fields: page.fields }], stored: {} } as unknown as SettingsPackage];
  const store: Store = { tasks: [], messages: [], changes: [], revision: 1 };
  let clock = 1000;
  // The tracker can be "away": its answers fail, but frames that were already on the wire still arrive, like an event that
  // reaches the service just before the daemon stops answering.
  const link = { offline: over.offline ?? false };
  const requests: string[] = [];
  let deliver: Parameters<DaemonFactory>[0] = () => undefined;
  const core = createDaemon({ now: () => clock, emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => deliver(topic, frame), seed: over.seed ?? SEED });
  const daemon: DaemonFactory = emit => {
    deliver = emit;
    return {
      request: (op, params) => { requests.push(op); if (link.offline) throw Object.assign(new Error('away'), { code: 'HostUnavailable' }); return core.request(op, params); },
      control: (path, params) => core.control(path, params),
    };
  };
  // B2's own argument parser against the same in-process daemon: what the installed service asks of the real tool.
  const { cliOperation } = await import('./fixtures/extensions/backends/core/fake-cli.mjs');
  const calls: string[][] = [];
  const cli = async (args: string[]) => {
    calls.push(args);
    const operation = cliOperation(args);
    if (link.offline) throw Object.assign(new Error('away'), { code: 'Unreachable' });
    const result = await core.request(operation.op, operation.params ?? {});
    return operation.project ? operation.project(result) : result;
  };
  const loaders: Loaders = { 'main.cjs': async () => {
    const logic = await import('../examples/extensions/live-board/package/lib/board.mjs');
    return { service: (panda: unknown, lifetime: unknown) => logic.run(panda as never, lifetime as never, { ...logic.linkFromPanda(panda as never), cli }) } as unknown as ServiceModule;
  } };
  const panels = over.panels ? new PreviewPanelHost(() => clock) : undefined;
  const preview = createRuntimePreview({ manifest, loaders, grants, settings, store, daemon, now: () => clock, scopes: { tasks: ['t1'], projects: ['p1'] }, safeMode: over.safeMode, panels });
  // The host applies 20 updates a second to a package: every action of the spec happens a second after the last.
  const act = async <T>(run: () => T | Promise<T>): Promise<T> => { clock += 1100; return run(); };
  const owner = () => (preview.layer().owners[OWNER] as Layer | undefined);
  const view = () => owner()?.overrides[VIEW];
  const table = () => (view()?.controls as Table[] | undefined)?.[0];
  return {
    preview, grants, link, core, act, owner, view, table, panels, calls, requests,
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
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'events.workspace', 'ui.dynamic', 'ui.notify', 'ui.richViews']);
  expect(manifest.runtime).toMatchObject({ kind: 'node', entrypoint: 'main.cjs', files: ['lib'], service: { start: 'onEnable' } });
  const logic = read('examples/extensions/live-board/package/lib/board.mjs');
  expect(logic).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(logic).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function/);
  for (const call of ['panda.ui.update(', 'panda.ui.updateView(', 'panda.ui.showDialog(', 'panda.commands.register(', "'settings.changed'", "'task.shown'", 'link.request(']) expect(logic, call).toContain(call);
  const main = read('examples/extensions/live-board/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:net', 'node:child_process']);
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

// ---- cut B: the rich panel ------------------------------------------------------------------------------------------------

const ORIGIN = { owner: OWNER, version: '1.0.0', viewId: VIEW };
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
type Out = Record<string, any>;
const ok = (envelope: unknown) => { const answer = envelope as { ok: boolean; value?: unknown; error?: { message: string } }; if (!answer.ok) throw new Error(answer.error?.message); return answer.value as Out; };

/** One panel instance: what the host pushed to it, assembled the way the panel's own script assembles it. */
function attach(board: Board, label = 'extension-panel-a') {
  const received: Out[] = [];
  const frame = { contentWindow: { postMessage: (message: { detail: Out }) => received.push(message.detail) } as unknown as Window };
  const session = `s-${label}`;
  board.panels!.bind(label, frame, ORIGIN);
  const init = ok(board.panels!.handle(label, { schemaVersion: 1, session, kind: 'hello' }));
  let next = 0;
  const messages = () => received.filter(item => item.kind === 'message').map(item => item.message as Out);
  const send = (message: unknown) => board.act(async () => ok(board.panels!.handle(label, { schemaVersion: 1, session, kind: 'post', id: ++next, message })));
  /** The latest complete board: `board.begin` plus every `board.rows` chunk of its sequence. */
  const latest = () => {
    const begins = messages().filter(item => item.kind === 'board.begin');
    for (let at = begins.length - 1; at >= 0; at -= 1) {
      const meta = begins[at];
      const chunks = messages().filter(item => item.kind === 'board.rows' && item.seq === meta.seq);
      if (chunks.length === meta.parts) return { meta, issues: chunks.sort((a, b) => a.index - b.index).flatMap(item => item.rows as Out[]), chunks };
    }
    return null;
  };
  const results = () => messages().filter(item => item.kind === 'result');
  return { label, init, received, messages, send, latest, results, details: () => messages().filter(item => item.kind === 'detail') };
}
const ids = (items: Out[]) => items.map(item => item.id);

test('live board preview: the panel is a folder page that only draws the service snapshot and sends wishes back', () => {
  const view = (manifest.contributes as unknown as { views: { id: string; rich: Record<string, unknown> }[] }).views.find(item => item.id === VIEW)!;
  expect(view.rich).toMatchObject({ folder: 'panel', entry: 'index.html', placement: 'inspector' });
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  const page = read('examples/extensions/live-board/package/panel/index.html');
  const script = read('examples/extensions/live-board/package/panel/app.js');
  expect(page).toContain('./app.js');
  for (const call of ['pandaView', 'onDidInitialize', 'onMessage', 'onDidChangeVisibility', 'postMessage', 'state.set', "'board.begin'", "'board.rows'", 'readyIds', 'blockedIds']) expect(`${page}${script}`, call).toContain(call);
  // The panel never reads the tracker and never works out ready or blocked: the daemon's lists are the only truth.
  expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bdependsOn\b.*\bready\b/);
  expect(read('examples/extensions/live-board/package/lib/board.mjs')).toMatch(/panda\.views/);
  expect(read('examples/extensions/live-board/package/lib/board.mjs')).toContain('link.cli(');
});

test('live board preview: a panel that opens gets B1 readyIds and blockedIds exactly, and an addition streams in within 2 s', async () => {
  const board = await boot({ panels: true });
  expect(await board.preview.start()).toEqual({ ok: true });
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  const panel = attach(board);
  await within('the first board in the panel', () => panel.latest()?.meta.total).toBe(3);
  const snapshot = await board.core.request('issues.snapshot', {}) as { readyIds: string[]; blockedIds: string[] };
  const first = panel.latest()!;
  expect(first.meta.readyIds).toEqual(snapshot.readyIds);
  expect(first.meta.blockedIds).toEqual(snapshot.blockedIds);
  expect(first.meta).toMatchObject({ stale: false, undo: null, notice: null, unit: 'ready' });
  expect(ids(first.issues)).toEqual(['T-1', 'T-2', 'T-3']);
  // The host-rendered fallback and the panel agree.
  expect(board.statusText()).toBe(`${first.meta.readyIds.length} ready`);
  // B1 gets a new issue: the panel has it within 2 s, with the daemon's new lists, without a click.
  const started = Date.now();
  await board.issue({ id: 'T-4', title: 'Four' });
  await within('the added issue in the panel', () => panel.latest()?.meta.total).toBe(4);
  expect(Date.now() - started).toBeLessThan(2000);
  const after = await board.core.request('issues.snapshot', {}) as { readyIds: string[]; blockedIds: string[] };
  expect(panel.latest()!.meta.readyIds).toEqual(after.readyIds);
  expect(panel.latest()!.meta.blockedIds).toEqual(after.blockedIds);
  // A second instance opened later gets the current board, to itself only.
  const before = panel.messages().length;
  const second = attach(board, 'extension-view-b');
  await within('the second instance board', () => second.latest()?.meta.total).toBe(4);
  expect(panel.messages().length).toBe(before);
  await board.preview.stop();
});

test('live board preview: selecting an issue asks for its detail and Claim, Close and Undo go through the command-line tool', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  const panel = attach(board);
  await within('the first board', () => panel.latest()?.meta.total).toBe(3);
  // Detail: one `show` of the tool, answered to the asking instance.
  await panel.send({ kind: 'detail', id: 'T-2' });
  await within('the detail', () => panel.details().length).toBe(1);
  expect(panel.details()[0].issue).toMatchObject({ id: 'T-2', title: 'Two', dependsOn: ['T-1'] });
  expect(board.calls.at(-1)).toEqual(['show', '--id=T-2']);
  // Claim T-1: the tool's own argument array, the answer, and the board shows who has it.
  await panel.send({ kind: 'claim', id: 'T-1' });
  await within('the claim result', () => panel.results().length).toBe(1);
  expect(board.calls.at(-1)).toEqual(['claim', '--id=T-1', '--actor=board']);
  expect(panel.results()[0]).toMatchObject({ op: 'claim', id: 'T-1', ok: true, undo: 'Undo claim of T-1' });
  await within('the claimed row', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.assignee).toBe('board');
  expect(panel.latest()!.issues.find(item => item.id === 'T-1')!.status).toBe('in_progress');
  // Undo of an unchanged claim: read first (`show`), then put the issue back; the undo is spent.
  await panel.send({ kind: 'undo' });
  await within('the undo result', () => panel.results().length).toBe(2);
  expect(board.calls.slice(-2)).toEqual([['show', '--id=T-1'], ['update', '--id=T-1', '--status=open', '--assignee=']]);
  expect(panel.results()[1]).toMatchObject({ op: 'undo', ok: true, undo: null });
  await within('the claim undone', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.status).toBe('open');
  // Close T-1 and undo it: the daemon's own revision guard decides.
  await panel.send({ kind: 'close', id: 'T-1' });
  await within('the close result', () => panel.results().length).toBe(3);
  expect(board.calls.at(-1)?.slice(0, 2)).toEqual(['close', '--id=T-1']);
  await within('the board after the close', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.status).toBe('closed');
  await panel.send({ kind: 'undo' });
  await within('the reopen result', () => panel.results().length).toBe(4);
  expect(board.calls.at(-1)).toEqual(['reopen', '--id=T-1', expect.stringMatching(/^--if-revision=\d+$/)]);
  expect(panel.results()[3]).toMatchObject({ op: 'undo', ok: true });
  await within('the issue reopened', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.status).toBe('open');
  // Nothing was written without the tool: every mutation of the run is a tool call.
  expect(board.requests.filter(op => op.startsWith('issues.') && op !== 'issues.snapshot' && op !== 'issues.chunk')).toEqual([]);
  // A closed issue cannot be claimed again; a malformed id never reaches the tool.
  const count = board.calls.length;
  await panel.send({ kind: 'close', id: 'T-3' });
  await within('the refusal', () => panel.results().length).toBe(5);
  expect(panel.results()[4]).toMatchObject({ ok: false, code: 'InvalidState' });
  await panel.send({ kind: 'claim', id: '--actor=x' });
  await within('the invalid id', () => panel.results().length).toBe(6);
  expect(panel.results()[5]).toMatchObject({ ok: false, code: 'InvalidShape' });
  expect(board.calls.length).toBe(count);
  await board.preview.stop();
});

test('live board preview: an undo after the issue changed is refused where the user can see it, and the issue stays as it is', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  const panel = attach(board);
  await within('the first board', () => panel.latest()?.meta.total).toBe(3);
  await panel.send({ kind: 'close', id: 'T-1' });
  await within('the close', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.status).toBe('closed');
  // Someone else changes T-1 (B1 control): its revision moves.
  await board.act(() => board.core.control('issues', { op: 'update', issue: { id: 'T-1', assignee: 'Grace' } }));
  await within('the change in the panel', () => panel.latest()?.issues.find(item => item.id === 'T-1')?.assignee).toBe('Grace');
  await panel.send({ kind: 'undo' });
  await within('the refusal result', () => panel.results().at(-1)?.op).toBe('undo');
  const refusal = panel.results().at(-1)!;
  expect(refusal).toMatchObject({ ok: false, code: 'Conflict' });
  expect(refusal.message).toContain('T-1 changed since you closed it');
  expect(board.calls.at(-1)?.[0]).toBe('reopen');
  // The refusal is part of the board the panel draws, the issue is untouched and no second undo is offered.
  await within('the visible notice', () => panel.latest()?.meta.notice).toContain('the undo was refused');
  expect(panel.latest()!.issues.find(item => item.id === 'T-1')).toMatchObject({ status: 'closed', assignee: 'Grace' });
  expect(panel.latest()!.meta.undo).toBeNull();
  // The same for a claim: the service reads the issue first and leaves it alone when its revision moved.
  await panel.send({ kind: 'claim', id: 'T-2' });
  await within('the claim', () => panel.results().at(-1)?.op).toBe('claim');
  await board.act(() => board.core.control('issues', { op: 'update', issue: { id: 'T-2', title: 'Two, renamed' } }));
  const calls = board.calls.length;
  await panel.send({ kind: 'undo' });
  await within('the second refusal', () => panel.results().at(-1)?.op).toBe('undo');
  expect(panel.results().at(-1)).toMatchObject({ ok: false, code: 'Conflict' });
  expect(board.calls.slice(calls).map(call => call[0])).toEqual(['show']);
  expect(panel.latest()!.issues.find(item => item.id === 'T-2')).toMatchObject({ status: 'in_progress', title: 'Two, renamed' });
  await board.preview.stop();
});

test('live board preview: 2,000 issues arrive in chunks of at most 256 KiB, quickly, and the last offline snapshot stays marked stale', async () => {
  const seed = JSON.parse(read('tests/fixtures/extensions/example-live-board/issues-2000.json')) as Seed;
  expect(seed.issues).toHaveLength(2000);
  const board = await boot({ panels: true, seed });
  const started = Date.now();
  await board.preview.start();
  const panel = attach(board);
  await within('2,000 issues in the panel', () => panel.latest()?.meta.total, 2000).toBe(2000);
  expect(Date.now() - started).toBeLessThan(2000);
  const full = panel.latest()!;
  // The daemon's own snapshot was chunked (B1 chunk protocol) and the panel got it in many small messages, never one big one.
  expect(board.requests).toContain('issues.chunk');
  expect(full.meta.parts).toBe(10);
  expect(full.chunks).toHaveLength(10);
  for (const message of panel.messages()) expect(JSON.stringify(message).length, message.kind).toBeLessThan(256 * 1024);
  const snapshot = await board.core.request('issues.snapshot', {}) as { transfer?: string; chunks?: number; readyIds?: string[] };
  const whole = snapshot.transfer ? JSON.parse((await Promise.all(Array.from({ length: snapshot.chunks! }, (_, index) => board.core.request('issues.chunk', { transfer: snapshot.transfer, index }) as Promise<{ text: string }>))).map(part => part.text).join('')) : snapshot;
  expect(full.meta.readyIds).toEqual(whole.readyIds);
  expect(full.issues.map(item => item.id)).toEqual(seed.issues.map(item => item.id));
  // The host-rendered table is bounded at 100 rows and says so; the panel carries every issue.
  expect(board.table()?.rows).toHaveLength(100);
  expect(board.view()?.text).toContain('Showing the first 100');
  // The tracker goes away: the last snapshot stays, marked stale, still with 2,000 rows.
  board.link.offline = true;
  await board.signal({ op: 'refresh' });
  await within('the stale board', () => panel.latest()?.meta.stale).toBe(true);
  expect(panel.latest()!.meta.total).toBe(2000);
  expect(panel.latest()!.meta.since).toMatch(/^\d\d:\d\d:\d\d UTC$/);
  expect(board.statusText()).toBe('Tracker offline');
  // While it is away an action is refused with a code, never faked.
  await panel.send({ kind: 'claim', id: 'T-1' });
  await within('the offline refusal', () => panel.results().at(-1)?.code).toBe('Unreachable');
  // It answers again: the stale marking leaves without a click.
  board.link.offline = false;
  await board.signal({ op: 'refresh' });
  await within('the fresh board', () => panel.latest()?.meta.stale).toBe(false);
  await board.preview.stop();
});

test('live board preview: a tracker never read is unknown in the panel, and a bad panel message never stops the service', async () => {
  const board = await boot({ panels: true, offline: true });
  await board.preview.start();
  const panel = attach(board);
  await within('the unknown board', () => panel.messages().some(item => item.kind === 'board.unknown' && item.offline === true)).toBe(true);
  expect(panel.latest()).toBeNull();
  board.link.offline = false;
  await board.act(() => board.preview.invoke(RETRY));
  await within('the first board', () => panel.latest()?.meta.total).toBe(3);
  // Garbage from the page is ignored; the service keeps answering.
  for (const message of [7, 'x', { kind: 'unknown' }, { kind: 'claim' }, { kind: 'detail', id: 'T-404' }, { kind: 'claim', id: 'T-404' }]) await panel.send(message);
  await within('the unknown issue refusal', () => panel.results().filter(item => item.code === 'NotFound').length).toBeGreaterThanOrEqual(1);
  await board.issue({ id: 'T-4', title: 'Four' });
  await within('the board still follows', () => panel.latest()?.meta.total).toBe(4);
  expect(board.preview.state).toBe('running');
  await board.preview.stop();
});

test('live board preview: losing ui.richViews, a disable, safe mode and a stop leave no panel instance and no live item', async () => {
  // Without the panel permission the service keeps reading and records the refusal; the host-rendered board still works.
  const board = await boot({ panels: true });
  await board.preview.start();
  await within('the first snapshot', () => board.statusText()).toBe('1 ready');
  const panel = attach(board);
  await within('the first board', () => panel.latest()?.meta.total).toBe(3);
  await board.preview.revoke('ui.richViews');
  await board.issue({ id: 'T-4', title: 'Four' });
  await within('the host-rendered board follows', () => board.statusText()).toBe('2 ready');
  expect(board.preview.state).toBe('running');
  await board.preview.stop();
  for (const [act, reason] of [
    [(item: Board) => item.preview.setEnabled(false), 'disable'],
    [(item: Board) => item.preview.setSafeMode(true), 'safeMode'],
    [(item: Board) => item.preview.revoke('runtime.service'), 'trust'],
  ] as const) {
    const run = await boot({ panels: true });
    await run.preview.start();
    attach(run);
    await within('the first board', () => run.statusText()).toBe('1 ready');
    await act(run);
    expect([run.preview.state, run.preview.stopReason]).toEqual(['stopped', reason]);
    expect(run.owner()).toBeUndefined();
    expect(await run.preview.panelViews().instances(VIEW).catch(() => [])).toEqual([]);
  }
});

test('live board preview: the spec, the package, the evidence columns and the guide are registered', () => {
  const columns = JSON.parse(read('tests/fixtures/extensions/example-live-board/evidence-columns.json')) as { columns: { preview: { status: string; engines: Record<string, { port: number; status: string }> }; installedWindows: { status: string; runner: string } } };
  expect(columns.columns.preview.engines.chromium.port).toBe(16521);
  expect(columns.columns.preview.engines.webkit.port).toBe(16522);
  for (const status of [columns.columns.preview.status, columns.columns.installedWindows.status, columns.columns.preview.engines.chromium.status, columns.columns.preview.engines.webkit.status]) expect(status).toContain('prepared, not run');
  expect(columns.columns.installedWindows.runner).toContain('qualify.mjs');
  const doc = read('docs/extensions/examples/live-board.md');
  for (const text of ['Cut B', 'prepared, not run', 'qualify.mjs', 'issues-2000.json']) expect(doc, text).toContain(text);
});

test('live board preview: the spec and the package are registered in both browsers, CI and the examples corpus', () => {
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-example-live-board.spec.ts');
  expect(read('playwright.webkit.config.ts')).toContain('live board preview:');
  const corpus = JSON.parse(read('tests/fixtures/extensions/examples-v1.json')) as { examples: { dir: string; id: string; executable: boolean }[] };
  expect(corpus.examples).toContainEqual(expect.objectContaining({ dir: 'live-board', id: OWNER, executable: true }));
  const doc = read('docs/extensions/examples/live-board.md');
  for (const text of ['sample.live-board', 'Preview evidence', 'runtime_live_board_acceptance.rs', 'Retry']) expect(doc, text).toContain(text);
});
