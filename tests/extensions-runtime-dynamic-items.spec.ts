import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { createUiCatalog } from '../src/extensions/catalog';
import { createLayoutStore } from '../src/extensions/layout';
import { DynamicItems, itemArgs, MARKS_LOCATION, MAX_ITEMS, MAX_UPDATES_PER_SECOND, effective, mergeLayer, parseScope, scopeVisible, serve, taskMarks, type Checks, type Scope } from '../src/extensions/runtime-dynamic-items';
import type { ExtensionSnapshot } from '../src/extensions/manager';

// Preview column of R0205 (scoped live contributions). These checks run the deterministic model in
// src/extensions/runtime-dynamic-items.ts, which mirrors src-tauri/src/extensions/runtime_dynamic_items.rs (whose own
// unit tests are `runtime_dynamic_items::tests`). The installed service under the pinned runtime is the native test
// `runtime_service_lifetime::tests::installed::dynamic_items_*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-dynamic-items/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-dynamic-items/main.cjs');
const OWNER = 'sample.dynamic-items';
const ALERT = `${OWNER}/alert`, STATUS = `${OWNER}/status`, BOARD = `${OWNER}/board`, MARK = `${OWNER}/mark`;

function world(known: { tasks?: string[]; projects?: string[] } = { tasks: ['t1', 't2'], projects: ['A', 'B'] }) {
  const exists = (scope: Scope) => 'taskId' in scope ? (known.tasks ?? []).includes(scope.taskId) : (known.projects ?? []).includes(scope.projectId);
  const clock = { now: 1000 };
  const checks = (): Checks => ({ granted: true, manifest, scopeExists: exists, version: '1.0.0', nowMs: clock.now });
  const items = new DynamicItems();
  const snapshot = (): ExtensionSnapshot => ({ safeMode: false, diagnostics: [], packages: [{ enabled: true, icons: {}, manifest }] as unknown as ExtensionSnapshot['packages'] });
  const merged = (shown = { taskId: null as string | null, projectId: null as string | null }) => mergeLayer(snapshot(), items.snapshot(), shown);
  const menus = (shown?: { taskId: string | null; projectId: string | null }) => (merged(shown).packages[0].manifest.contributes.menus ?? []) as Record<string, unknown>[];
  return { items, clock, checks, merged, menus, known, snapshot };
}
const status = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'menu', id, location: 'panda.status.items', command: `${OWNER}/open`, presentation: 'status', text: '3 builds failed', ...extra });
const mark = (id: string, scope: Record<string, unknown>) => ({ kind: 'menu', id, location: MARKS_LOCATION, command: `${OWNER}/open`, presentation: 'badge', badge: '3', scope });
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;

test('extensions dynamic items: the fixture package declares the permission and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', 'ui.dynamic']));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.ui.register', 'panda.ui.updateView', '.update(', '.dispose()', 'scope: { taskId']) expect(fixtureSource, call).toContain(call);
});

test('extensions dynamic items: a service adds, changes and removes a status item with every field reflected', () => {
  const { items, checks, menus } = world();
  expect(items.register(OWNER, checks(), status(ALERT, { args: { build: 41 }, tone: 'warning', tooltip: 'Three builds failed', progress: 10 }))).toEqual({ ok: true, value: { id: ALERT } });
  const added = menus().find(menu => menu.id === ALERT)!;
  expect(added).toMatchObject({ location: 'panda.status.items', presentation: 'status', text: '3 builds failed', tone: 'warning', tooltip: 'Three builds failed', progress: 10, args: { build: 41 } });
  expect(menus().map(menu => menu.id)).toEqual([STATUS, `${OWNER}/header`, ALERT]);
  expect(code(items.update(OWNER, checks(), ALERT, { text: '4 builds failed', badge: '4', tone: 'danger', tooltip: 'Four\nbuilds failed', progress: 80, enabled: false, visible: true }))).toBe('ok');
  expect(menus().find(menu => menu.id === ALERT)).toMatchObject({ text: '4 builds failed', badge: '4', tone: 'danger', tooltip: 'Four\nbuilds failed', progress: 80, enabled: false, visible: true });
  // `null` takes the override off the condition and the declared (absent) one applies again.
  expect(code(items.update(OWNER, checks(), ALERT, { enabled: null, visible: null }))).toBe('ok');
  expect(menus().find(menu => menu.id === ALERT)).not.toHaveProperty('enabled');
  expect(code(items.dispose(OWNER, checks(), ALERT))).toBe('ok');
  expect(menus().map(menu => menu.id)).toEqual([STATUS, `${OWNER}/header`]);
  // The disposed handle is stale: it answers NotFound however often it is used.
  expect([code(items.update(OWNER, checks(), ALERT, { text: 'late' })), code(items.dispose(OWNER, checks(), ALERT))]).toEqual(['NotFound', 'NotFound']);
  expect(items.count(OWNER)).toBe(0);
});

test('extensions dynamic items: a table row with a command keeps its arguments, and a manifest item returns when the service stops', () => {
  const { items, checks, merged } = world();
  const rows = [{ cells: ['tracks'], command: `${OWNER}/open`, args: { table: 'tracks' } }];
  const controls = [{ kind: 'table', label: 'Tables', columns: ['Name'], rows }];
  // Row objects are an extension of the view schema (G9); a plain-text table is accepted today.
  expect(code(items.updateView(OWNER, checks(), BOARD, { text: '1 table', controls: [{ kind: 'table', label: 'Tables', columns: ['Name'], rows: [['tracks']] }] }))).toBe('ok');
  expect(code(items.update(OWNER, checks(), STATUS, { tone: 'danger', text: 'failing' }))).toBe('ok');
  const live = merged().packages[0].manifest.contributes;
  expect(live.menus!.find(menu => menu.id === STATUS)).toMatchObject({ tone: 'danger', text: 'failing', presentation: 'status' });
  expect(live.views![0]).toMatchObject({ text: '1 table' });
  expect(controls[0].rows[0].args).toEqual({ table: 'tracks' });
  // The service stops (disable, uninstall, update, trust loss, safe mode, crash): every override goes.
  items.clear(OWNER);
  expect(merged().packages[0].manifest).toEqual(manifest);
  // Without a layer, and in safe mode, the snapshot is the manifest snapshot itself.
  const bare = { safeMode: false, diagnostics: [], packages: [{ enabled: true, icons: {}, manifest }] } as unknown as ExtensionSnapshot;
  expect(mergeLayer(bare, null, { taskId: null, projectId: null })).toBe(bare);
  const safe = { ...bare, safeMode: true };
  items.register(OWNER, checks(), status(ALERT));
  expect(mergeLayer(safe, items.snapshot(), { taskId: null, projectId: null })).toBe(safe);
  // Only an enabled package is touched.
  const off = { ...bare, packages: [{ ...bare.packages[0], enabled: false }] } as ExtensionSnapshot;
  expect(mergeLayer(off, items.snapshot(), { taskId: null, projectId: null }).packages[0]).toBe(off.packages[0]);
  expect(effective({ a: 1, b: 2 }, { a: null, c: 3 })).toEqual({ b: 2, c: 3 });
});

test('extensions dynamic items: refusals keep their reasons (foreign owner, taken id, unknown command, bad fields, no grant)', () => {
  const { items, checks } = world();
  // Retained refusals, each for a non-security reason (an id names one thing, a reference must resolve, a value must
  // have the declared shape); the grant itself is the permission, checked below.
  expect(code(items.register(OWNER, checks(), status('sample.other/alert')))).toBe('PermissionDenied');
  expect(code(items.register(OWNER, checks(), status(STATUS)))).toBe('Conflict');
  items.register(OWNER, checks(), status(ALERT));
  expect(code(items.register(OWNER, checks(), status(ALERT)))).toBe('Conflict');
  expect(code(items.register(OWNER, checks(), status(`${OWNER}/b`, { command: `${OWNER}/ghost` })))).toBe('UnknownReference');
  expect(code(items.register(OWNER, checks(), status(`${OWNER}/c`, { location: 'panda.nowhere' })))).not.toBe('ok');
  expect(code(items.register(OWNER, checks(), { kind: 'widget', id: `${OWNER}/d` }))).toBe('InvalidShape');
  expect(code(items.register(OWNER, checks(), 'text'))).toBe('InvalidShape');
  for (const [patch, expected] of [
    [{ tone: 'rainbow' }, 'InvalidShape'], [{ tooltip: 'x'.repeat(1025) }, 'LimitExceeded'], [{ progress: 101 }, 'InvalidShape'], [{ progress: 1.5 }, 'InvalidShape'], [{ args: { blob: 'x'.repeat(4100) } }, 'LimitExceeded'],
    [{ id: `${OWNER}/z` }, 'InvalidShape'], [{ kind: 'menu' }, 'InvalidShape'], [{ location: 'panda.status.items' }, 'InvalidShape'], [{ command: `${OWNER}/open` }, 'InvalidShape'], [{}, 'InvalidShape'], [{ enabled: 'yes' }, 'InvalidShape'],
  ] as const) expect(code(items.update(OWNER, checks(), ALERT, patch)), JSON.stringify(patch)).toBe(expected);
  // A view is changed by `updateView` with view fields only.
  expect(code(items.updateView(OWNER, checks(), ALERT, { text: 'x' }))).toBe('InvalidShape');
  expect(code(items.updateView(OWNER, checks(), BOARD, { badge: 'x' }))).toBe('InvalidShape');
  expect(code(items.update(OWNER, checks(), `${OWNER}/ghost`, { text: 'x' }))).toBe('NotFound');
  expect(code(items.update(OWNER, checks(), 'sample.other/status', { text: 'x' }))).toBe('PermissionDenied');
  // Without the grant nothing is registered, changed or disposed.
  const denied = { ...checks(), granted: false };
  expect([code(items.register(OWNER, denied, status(`${OWNER}/e`))), code(items.update(OWNER, denied, ALERT, { text: 'x' })), code(items.updateView(OWNER, denied, BOARD, { text: 'x' })), code(items.dispose(OWNER, denied, ALERT))]).toEqual(Array(4).fill('PermissionDenied'));
  expect(items.count(OWNER)).toBe(1);
  // The service request frame answers the broker envelope.
  expect(serve(items, OWNER, checks(), { op: 'register', item: status(`${OWNER}/f`) })).toEqual({ ok: true, value: { id: `${OWNER}/f` } });
  expect(serve(items, OWNER, checks(), { op: 'dispose', id: `${OWNER}/f` })).toEqual({ ok: true, value: null });
  expect(code(serve(items, OWNER, checks(), { op: 'explode' }))).toBe('InvalidShape');
});

test('extensions dynamic items: a task mark follows its task, a stale task is refused, and the task going removes it', () => {
  const { items, checks, menus } = world();
  expect(code(items.register(OWNER, checks(), mark(MARK, { taskId: 't1' })))).toBe('ok');
  expect(items.register(OWNER, checks(), mark(`${OWNER}/gone`, { taskId: 'ghost' }))).toEqual({ ok: false, error: { schemaVersion: 1, code: 'NotFound', path: '$', ids: [] } });
  expect(code(items.register(OWNER, checks(), mark(`${OWNER}/both`, { taskId: 't1', projectId: 'A' })))).toBe('InvalidShape');
  expect(parseScope({ taskId: 't1', extra: 1 })).toBeNull();
  const layer = items.snapshot();
  // The mark belongs to t1's row whatever task the window shows; other rows show nothing.
  expect(taskMarks('t1', 'A', layer)).toEqual([{ owner: OWNER, id: MARK, text: '3', tone: 'neutral', title: `${OWNER}: 3`, command: `${OWNER}/open` }]);
  expect(taskMarks('t2', 'A', layer)).toEqual([]);
  expect(menus({ taskId: 't2', projectId: 'A' }).some(menu => menu.id === MARK)).toBe(true);
  expect(code(items.update(OWNER, checks(), MARK, { badge: '4', tone: 'danger', tooltip: 'Four builds' }))).toBe('ok');
  expect(taskMarks('t1', 'A', items.snapshot())[0]).toMatchObject({ text: '4', tone: 'danger', title: `${OWNER}: Four builds` });
  // A condition that resolved to false hides the mark; null brings the declared one back.
  items.update(OWNER, checks(), MARK, { visible: false });
  expect(taskMarks('t1', 'A', items.snapshot())).toEqual([]);
  items.update(OWNER, checks(), MARK, { visible: null });
  expect(taskMarks('t1', 'A', items.snapshot())).toHaveLength(1);
  // The task is deleted: the item goes with it, and its handle is stale.
  expect(items.forgetScope({ taskId: 't1' })).toBe(1);
  expect(taskMarks('t1', 'A', items.snapshot())).toEqual([]);
  expect(code(items.dispose(OWNER, checks(), MARK))).toBe('NotFound');
  // A service that stops takes every mark with it.
  items.register(OWNER, checks(), mark(`${OWNER}/m2`, { taskId: 't2' }));
  items.clear(OWNER);
  expect(taskMarks('t2', 'A', items.snapshot())).toEqual([]);
});

test('extensions dynamic items: task and project scope follow task.shown without leaking another project', () => {
  const { items, checks, menus } = world();
  items.register(OWNER, checks(), status(`${OWNER}/t1`, { scope: { taskId: 't1' }, text: 'task one' }));
  items.register(OWNER, checks(), status(`${OWNER}/pa`, { scope: { projectId: 'A' }, text: 'project A' }));
  items.register(OWNER, checks(), status(`${OWNER}/pb`, { scope: { projectId: 'B' }, text: 'project B' }));
  items.register(OWNER, checks(), status(`${OWNER}/all`, { text: 'everywhere' }));
  const shown = (taskId: string | null, projectId: string | null) => menus({ taskId, projectId }).map(menu => String(menu.id).replace(`${OWNER}/`, '')).filter(id => !['status', 'header'].includes(id));
  expect(shown(null, null)).toEqual(['all']);
  expect(shown('t1', 'A')).toEqual(['t1', 'pa', 'all']);
  expect(shown('t2', 'A')).toEqual(['pa', 'all']);
  expect(shown('t2', 'B')).toEqual(['pb', 'all']);
  // Nothing of project B reaches a window showing project A, including in what the catalog lists.
  expect(JSON.stringify(menus({ taskId: 't1', projectId: 'A' }))).not.toContain('project B');
  expect(scopeVisible({ id: 'x', scope: { taskId: 't1' } }, { taskId: 't1', projectId: null })).toBe(true);
  expect(scopeVisible({ id: 'x', scope: { taskId: 't1' } }, { taskId: 't2', projectId: null })).toBe(false);
  // The project is closed: its items go.
  expect(items.forgetScope({ projectId: 'B' })).toBe(1);
  expect(shown('t2', 'B')).toEqual(['all']);
});

test('extensions dynamic items: 128 live items and 20 updates a second, the latest value waiting its turn', () => {
  const { items, checks, clock } = world();
  for (let index = 0; index < MAX_ITEMS; index += 1) expect(code(items.register(OWNER, checks(), status(`${OWNER}/i${index}`)))).toBe('ok');
  expect(code(items.register(OWNER, checks(), status(`${OWNER}/over`)))).toBe('LimitExceeded');
  expect(code(items.dispose(OWNER, checks(), `${OWNER}/i0`))).toBe('ok');
  expect(code(items.register(OWNER, checks(), status(`${OWNER}/over`)))).toBe('ok');
  const badge = () => (items.snapshot().owners[OWNER].menus.find(menu => menu.id === `${OWNER}/i1`) as Record<string, unknown>);
  for (let count = 0; count < MAX_UPDATES_PER_SECOND; count += 1) expect(code(items.update(OWNER, checks(), `${OWNER}/i1`, { badge: String(count) }))).toBe('ok');
  const before = items.revision();
  expect(code(items.update(OWNER, checks(), `${OWNER}/i1`, { badge: 'late-1' }))).toBe('ok');
  expect(code(items.update(OWNER, checks(), `${OWNER}/i1`, { badge: 'late-2', tone: 'info' }))).toBe('ok');
  expect([items.revision(), items.pending(OWNER), badge().badge]).toEqual([before, 1, '19']);
  clock.now += 500;
  expect(items.tick(OWNER, checks())).toBe(false);
  clock.now += 501;
  expect(items.tick(OWNER, checks())).toBe(true);
  expect([badge().badge, badge().tone, items.pending(OWNER)]).toEqual(['late-2', 'info', 0]);
  // A disposed item loses what waited for it.
  for (let count = 0; count < MAX_UPDATES_PER_SECOND + 1; count += 1) items.update(OWNER, checks(), `${OWNER}/i2`, { badge: String(count) });
  expect(items.pending(OWNER)).toBe(1);
  items.dispose(OWNER, checks(), `${OWNER}/i2`);
  expect(items.pending(OWNER)).toBe(0);
});

test('extensions dynamic items: a click hands the item\'s current arguments to its command, and a disposed item hands none', () => {
  const { items, checks, merged } = world();
  items.register(OWNER, checks(), status(ALERT, { args: { build: 41 } }));
  expect(itemArgs(merged(), ALERT)).toEqual({ build: 41 });
  items.update(OWNER, checks(), ALERT, { args: { build: 42 } });
  expect(itemArgs(merged(), ALERT)).toEqual({ build: 42 });
  // The captured context carries them under `args`, which the shared `context` contract keeps (opaque, up to 4 KiB).
  const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.status.items', revision: 1, args: { build: 42 } };
  expect(validateContract('context', context)).toMatchObject({ ok: true, value: { args: { build: 42 } } });
  expect(validateContract('context', { ...context, args: { blob: 'x'.repeat(4100) } }).ok).toBe(false);
  items.dispose(OWNER, checks(), ALERT);
  expect(itemArgs(merged(), ALERT)).toBeUndefined();
});

test('extensions dynamic items: hide, order and restore persist by identity across a service restart', () => {
  const { items, checks } = world();
  const memory = new Map<string, string>();
  const store = createLayoutStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); } });
  const LOCATION = 'panda.workspace.header.actions', HEADER = `${OWNER}/header`, OTHER = `${OWNER}/second`;
  items.register(OWNER, checks(), status(ALERT, { location: LOCATION, presentation: 'button' })); items.register(OWNER, checks(), status(OTHER, { location: LOCATION, presentation: 'button' }));
  const ids = () => store.order(LOCATION, [HEADER, ALERT, OTHER]);
  store.setVisible(ALERT, false);
  store.move(LOCATION, [HEADER, ALERT, OTHER], { id: OTHER, target: HEADER, side: 'before' });
  expect([store.isHidden(ALERT), ids()]).toEqual([true, [OTHER, HEADER, ALERT]]);
  // The service stops: its items go, the preference stays dormant, and the manifest item is untouched.
  items.clear(OWNER);
  expect(store.order(LOCATION, [HEADER])).toEqual([HEADER]);
  // The service starts again and registers the same identities: hidden and ordered as the user left them.
  items.register(OWNER, checks(), status(ALERT, { location: LOCATION, presentation: 'button' })); items.register(OWNER, checks(), status(OTHER, { location: LOCATION, presentation: 'button' }));
  expect([store.isHidden(ALERT), ids()]).toEqual([true, [OTHER, HEADER, ALERT]]);
  // Restore shows it again; a different identity never inherits the preference.
  store.setVisible(ALERT, true);
  expect([store.isHidden(ALERT), store.isHidden(`${OWNER}/third`)]).toEqual([false, false]);
});

test('extensions dynamic items: the catalog lists live items while they exist, by identity', () => {
  const { items, checks, snapshot, merged } = world();
  let layerSnapshot = snapshot();
  const ui = createUiCatalog(() => layerSnapshot);
  const ids = () => ui.listItems({ owner: OWNER, limit: 50 }).items.map(item => item.id);
  const before = ids();
  expect(before).not.toContain(ALERT);
  items.register(OWNER, checks(), status(ALERT));
  layerSnapshot = merged();
  expect(ids()).toContain(ALERT);
  expect([...ids()].sort()).toEqual([...before, ALERT].sort());
  items.dispose(OWNER, checks(), ALERT);
  layerSnapshot = merged();
  expect(ids()).toEqual(before);
});
