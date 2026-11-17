import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { settingsRevision, type SettingsPackage, type Store } from '../src/extensions/runtime-content-resources';
import { COLUMN, PandaError, createRuntimePreview, evidenceLabel, type DaemonFactory, type Grants, type Loaders, type PreviewManifest, type ServiceModule } from '../src/extensions/runtime-preview';

// PREVIEW column of R0208 (run service logic in the browser preview). These checks run src/extensions/runtime-preview.ts,
// which loads the fixture ES module tests/fixtures/extensions/runtime-preview/service.mjs through a table of known modules
// and answers it with the browser twins of the native slices (R0202 to R0207) and B1's browser-importable core as the
// replaced backend. They are preview evidence only: a package installed natively is qualified by the native tests, never
// by this file (docs/extensions/runtime-preview.md).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-preview/extension.json')) as PreviewManifest & { permissions: string[] };
const OWNER = 'sample.runtime-preview';
const PAGE = `${OWNER}/preferences`;
const settle = async () => { for (let index = 0; index < 4; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const code = (reply: { ok: boolean; error?: { code: string }; code?: string }) => reply.ok ? 'ok' : (reply.error?.code ?? reply.code);

const TASK = { id: 't1', projectId: 'p1', status: 'idle', title: 'One', harness: 'codex', model: 'm', mode: 'agent', stage: 'done' };
const created = (taskId = 't1') => ({ kind: 'task.created', taskId, projectId: 'p1', harness: 'codex', startedBy: 'user' });

async function boot(over: { grants?: Grants; loaders?: Loaders; manifest?: PreviewManifest; safeMode?: boolean; enabled?: boolean } = {}) {
  const { createDaemon } = await import('./fixtures/extensions/backends/core/fake-daemon.mjs');
  const loaders: Loaders = over.loaders ?? { 'service.mjs': () => import('./fixtures/extensions/runtime-preview/service.mjs') as Promise<ServiceModule> };
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  const settings: SettingsPackage[] = [{ id: OWNER, enabled: true, pages: [{ id: PAGE, fields: [{ id: 'label', kind: 'text', value: 'Preview' }] }], stored: {} }];
  const store: Store = { tasks: [TASK], messages: [], changes: [], revision: 1 };
  let clock = 1000;
  // One backend per boot (its state survives a restart of the service); each start points its events at the new run.
  let deliver: Parameters<DaemonFactory>[0] = () => undefined;
  const core = createDaemon({ now: () => clock, emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => deliver(topic, frame) });
  const daemon: DaemonFactory = emit => { deliver = emit; return core; };
  const preview = createRuntimePreview({
    manifest: over.manifest ?? manifest, loaders, grants, settings, store, daemon, now: () => clock,
    reveal: { views: [`${OWNER}/board`], settingsPages: [PAGE], taskExists: id => id === 't1', projectDir: id => (id === 'p1' ? '/work/p1' : null), fileExists: (_dir, path) => path === 'src/a.ts' },
    scopes: { tasks: ['t1'], projects: ['p1'] }, safeMode: over.safeMode, enabled: over.enabled,
  });
  return { preview, grants, settings, store, advance: (ms: number) => { clock += ms; }, signal: async (payload: Record<string, unknown>) => { preview.daemonControl('signal', { name: 'go', payload }); await settle(); }, status: () => { try { return JSON.parse(preview.status.text ?? 'null'); } catch { return preview.status.text; } }, core: () => core };
}

test('extensions runtime preview: the fixture is a browser-safe module and the runner never builds code from text', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', 'ui.notify', 'ui.dynamic', 'events.workspace']));
  const fixture = read('tests/fixtures/extensions/runtime-preview/service.mjs');
  expect(fixture).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(fixture).not.toMatch(/\bprocess\b|node:|child_process|\beval\b/);
  for (const call of ['panda.settings.get', "panda.events.on('settings.changed'", 'panda.ui.notify', 'panda.ui.showDialog', 'panda.daemon.subscribe']) expect(fixture, call).toContain(call);
  const runner = read('src/extensions/runtime-preview.ts');
  expect(runner).not.toMatch(/\beval\s*\(|new Function|blob:|from 'node:|require\(/);
});

test('extensions runtime preview: only a known module of an enabled, granted package starts, and every refusal keeps its reason', async () => {
  const unknown = await boot({ manifest: { ...manifest, runtime: { ...manifest.runtime, entrypoint: 'elsewhere.mjs' } } });
  expect(await unknown.preview.start()).toEqual({ ok: false, code: 'NotFound' });
  const withoutGrant = await boot({ grants: new Map([['ui.notify', true as const]]) });
  expect(await withoutGrant.preview.start()).toEqual({ ok: false, code: 'PermissionDenied' });
  expect(await (await boot({ safeMode: true })).preview.start()).toEqual({ ok: false, code: 'HostUnavailable' });
  expect(await (await boot({ enabled: false })).preview.start()).toEqual({ ok: false, code: 'HostUnavailable' });
  const hollow = await boot({ loaders: { 'service.mjs': async () => ({}) } });
  expect(await hollow.preview.start()).toEqual({ ok: false, code: 'InvalidShape' });
  const lazy = await boot({ manifest: { ...manifest, runtime: { kind: 'node', entrypoint: 'service.mjs' } } });
  expect(await lazy.preview.start()).toEqual({ ok: false, code: 'UnsupportedCapability' });
  const run = await boot();
  expect(await run.preview.start()).toEqual({ ok: true });
  expect(await run.preview.start()).toEqual({ ok: false, code: 'Conflict' });
  expect([run.preview.state, run.preview.column, run.preview.starts]).toEqual(['running', 'preview', 1]);
  await run.preview.stop();
  // Nothing refused ever reached a module of another name.
  expect(unknown.preview.steps.at(-1)).toMatchObject({ column: COLUMN, step: 'refused', code: 'NotFound' });
});

test('extensions runtime preview: settings carry the native revision and a save reaches only this package', async () => {
  const run = await boot();
  await run.preview.start();
  const first = settingsRevision({ label: 'Preview' });
  expect(run.status()).toMatchObject({ revision: first, label: 'Preview' });
  const next = run.preview.setSettings(PAGE, { label: 'Renamed' });
  await settle();
  expect(next).toBe(settingsRevision({ label: 'Renamed' }));
  expect(next).not.toBe(first);
  expect(run.status()).toMatchObject({ revision: next, label: 'Renamed' });
  // A second package with the same page name would hear nothing: the event is limited to its owner.
  expect(run.preview.publish({ kind: 'settings.changed', page: PAGE, revision: 1 }, 'sample.other')).toEqual({ queued: 0, dropped: 0 });
  await run.preview.stop();
});

test('extensions runtime preview: workspace events are shaped, gated by the grant and ordered', async () => {
  const run = await boot();
  await run.preview.start();
  expect(run.preview.publish({ kind: 'task.created', taskId: 't1' })).toEqual({ code: 'InvalidShape' });
  expect(run.preview.publish(created('t1'))).toEqual({ queued: 1, dropped: 0 });
  expect(run.preview.publish(created('t2'))).toEqual({ queued: 1, dropped: 0 });
  await settle();
  expect(run.status().tasks).toEqual(['t1', 't2']);
  expect(run.preview.steps.filter(step => step.step === 'event').map(step => step.detail)).toEqual(['task.created#1', 'task.created#2']);
  // The user narrows the grant to another project: nothing of p1 arrives; revoking it leaves nothing queued either.
  await run.preview.revoke('events.workspace', new Set(['p9']));
  expect(run.preview.publish(created('t3'))).toEqual({ queued: 0, dropped: 0 });
  await run.preview.revoke('events.workspace');
  expect(run.preview.publish(created('t4'))).toEqual({ queued: 0, dropped: 0 });
  await settle();
  expect(run.status().tasks).toEqual(['t1', 't2']);
  await run.preview.stop();
});

test('extensions runtime preview: notices name the package, replace by key and leave with the grant', async () => {
  const run = await boot();
  await run.preview.start();
  await run.signal({ op: 'notify' });
  const [notice] = run.preview.noticeSnapshot().notices;
  expect([notice.package, notice.key, notice.text, notice.tone]).toEqual(['Runtime preview', 'build', '4 builds failed', 'danger']);
  expect(run.status().answers).toEqual([false, true]);
  run.preview.publish(created('t1')); run.preview.publish(created('t2'));
  await settle();
  expect(run.preview.noticeSnapshot().notices.map(item => item.text)).toEqual(['4 builds failed', '2 new tasks']);
  expect(run.preview.dismissNotice('task')).toBe(true);
  // The permission goes: each notice leaves with its reason and a new one is refused.
  await run.preview.revoke('ui.notify');
  expect(run.preview.noticeSnapshot().notices).toEqual([]);
  expect(run.preview.notices.recorder().filter(entry => entry.reason).map(entry => [entry.key, entry.reason])).toEqual([['build', 'revoked-or-disabled']]);
  run.preview.publish(created('t5'));
  await settle();
  expect(run.status().refused).toContain('PermissionDenied');
  await run.preview.stop();
});

test('extensions runtime preview: live items follow the grant, scope and ownership rules of the native layer', async () => {
  const run = await boot();
  await run.preview.start();
  await run.signal({ op: 'register' });
  const layer = run.preview.layer();
  expect(layer.owners[OWNER].menus).toMatchObject([{ id: `${OWNER}/live`, text: 'busy', tone: 'warning' }]);
  const revision = layer.revision;
  expect(revision).toBeGreaterThan(0);
  // Losing the permission removes the layer at once; a new registration is then refused.
  await run.preview.revoke('ui.dynamic');
  expect(run.preview.layer().owners[OWNER]).toBeUndefined();
  await run.signal({ op: 'register' });
  expect(run.status().refused).toContain('PermissionDenied');
  await run.preview.stop();
});

test('extensions runtime preview: a dialog answers once and a stopped service sees it cancelled', async () => {
  const run = await boot();
  await run.preview.start();
  await run.signal({ op: 'ask' });
  const [pending] = run.preview.dialogs.pending();
  expect(pending.owner).toBe(OWNER);
  expect(code(run.preview.answerDialog(pending.id, { status: 'confirmed', values: { other: 'x' } }))).toBe('InvalidShape');
  expect(code(run.preview.answerDialog(pending.id, { status: 'confirmed', values: { name: 'Ada' } }))).toBe('ok');
  await settle();
  expect(code(run.preview.answerDialog(pending.id, { status: 'cancelled' }))).toBe('NotFound');
  expect(run.preview.dialogs.count(OWNER)).toBe(0);
  // A second dialog is cancelled by the stop, not left waiting.
  await run.signal({ op: 'ask' });
  expect(run.preview.dialogs.count(OWNER)).toBe(1);
  await run.preview.stop('disable');
  expect(run.preview.dialogs.count(OWNER)).toBe(0);
});

test('extensions runtime preview: reveals are checked and recorded, never performed', async () => {
  const run = await boot();
  await run.preview.start();
  await run.signal({ op: 'reveal', target: { view: `${OWNER}/board` } });
  await run.signal({ op: 'reveal', target: { projectId: 'p1', path: 'src/a.ts', line: 3 } });
  await run.signal({ op: 'reveal', target: { projectId: 'p1', path: '../outside' } });
  await run.signal({ op: 'reveal', target: { view: 'sample.other/board' } });
  await run.signal({ op: 'reveal', target: { taskId: 'gone' } });
  expect(run.preview.revealed).toEqual([{ view: `${OWNER}/board` }, { projectId: 'p1', path: 'src/a.ts', line: 3 }]);
  expect(run.status().refused).toEqual(['InvalidShape', 'PermissionDenied', 'NotFound']);
  await run.preview.stop();
});

test('extensions runtime preview: content resources need their grant and go stale when the workspace moves', async () => {
  const run = await boot();
  await run.preview.start();
  await run.signal({ op: 'read' });
  expect(run.status().answers).toEqual([['t1']]);
  await run.preview.revoke('tasks.summary');
  await run.signal({ op: 'read' });
  expect(run.status().refused).toContain('PermissionDenied');
  run.grants.set('tasks.summary', true);
  expect(run.preview.touchStore()).toBe(2);
  await run.preview.stop();
});

test('extensions runtime preview: stop disposes every surface in order, is repeatable and survives a throwing cleanup', async () => {
  const order: string[] = [];
  const module: ServiceModule = {
    async service(panda, lifetime) {
      await panda.ui.notify({ key: 'a', text: 'x' });
      await panda.ui.register({ kind: 'menu', id: `${OWNER}/m`, location: 'panda.status.items', command: `${OWNER}/open`, presentation: 'status', text: 'x' });
      panda.events.on('task.removed', () => order.push('event'));
      lifetime.onStop(() => { order.push('first'); });
      lifetime.onStop(() => { order.push('second'); throw new Error('cleanup failed'); });
      lifetime.onStop(() => { order.push('third'); });
    },
  };
  const run = await boot({ loaders: { 'service.mjs': async () => module } });
  expect(await run.preview.start()).toEqual({ ok: true });
  expect([run.preview.notices.count(OWNER), run.preview.items.count(OWNER), run.preview.events.listeners(OWNER), run.preview.events.attached()]).toEqual([1, 1, 1, 1]);
  expect(await run.preview.stop('update')).toBe(true);
  expect(order).toEqual(['third', 'second', 'first']);
  expect(run.preview.faults).toEqual(['Error: cleanup failed']);
  expect([run.preview.notices.count(OWNER), run.preview.items.count(OWNER), run.preview.events.listeners(OWNER), run.preview.events.attached(), run.preview.dialogs.count(OWNER)]).toEqual([0, 0, 0, 0, 0]);
  expect(run.preview.daemonControl('signal', { name: 'late' })).toBeNull();
  expect(run.preview.publish({ kind: 'app.focus', focused: true })).toEqual({ queued: 0, dropped: 0 });
  expect(await run.preview.stop()).toBe(false);
  expect([run.preview.state, run.preview.stopReason]).toEqual(['stopped', 'update']);
  // Restarting begins a new generation with nothing left from the first.
  expect(await run.preview.start()).toEqual({ ok: true });
  expect(run.preview.starts).toBe(2);
  await run.preview.stop();
});

test('extensions runtime preview: a service that fails while starting is disposed and reported, never left half alive', async () => {
  const module: ServiceModule = { async service(panda) { await panda.ui.notify({ key: 'a', text: 'x' }); await panda.settings.get({ page: 'nope' }); } };
  const run = await boot({ loaders: { 'service.mjs': async () => module } });
  expect(await run.preview.start()).toEqual({ ok: false, code: 'NotFound' });
  expect([run.preview.state, run.preview.stopReason, run.preview.notices.count(OWNER), run.preview.events.attached()]).toEqual(['failed', 'failed', 0, 0]);
  const crash: ServiceModule = { async service() { throw new Error('boom'); } };
  const other = await boot({ loaders: { 'service.mjs': async () => crash } });
  expect(await other.preview.start()).toEqual({ ok: false, code: 'HostUnavailable' });
  expect(new PandaError('Conflict').code).toBe('Conflict');
});

test('extensions runtime preview: disabling, safe mode and losing the service grant stop the service with their reasons', async () => {
  for (const [act, reason] of [
    [(run: Awaited<ReturnType<typeof boot>>) => run.preview.setEnabled(false), 'disable'],
    [(run: Awaited<ReturnType<typeof boot>>) => run.preview.setSafeMode(true), 'safeMode'],
    [(run: Awaited<ReturnType<typeof boot>>) => run.preview.revoke('runtime.service'), 'trust'],
  ] as const) {
    const run = await boot();
    await run.preview.start();
    await run.signal({ op: 'notify' });
    await act(run);
    expect([run.preview.state, run.preview.stopReason, run.preview.noticeSnapshot().notices.length]).toEqual(['stopped', reason, 0]);
    expect(run.status()).toBe('stopped');
  }
});

test('extensions runtime preview: the replaced backend answers B1 requests, subscriptions and errors through the same codes', async () => {
  const probe: ServiceModule = { async service(panda) {
    const reply = await panda.daemon.request('issues.get', { id: 'T-1' }) as { title: string };
    const missing = await panda.daemon.request('issues.get', { id: 'nope' }).catch((error: PandaError) => error.code);
    const topic = await panda.daemon.subscribe('bogus', () => undefined).catch((error: PandaError) => error.code);
    panda.ui.notify({ key: 'r', text: `${reply.title}|${missing}|${topic}` }).catch(() => undefined);
  } };
  const second = await boot({ loaders: { 'service.mjs': async () => probe } });
  second.core().request('issues.create', { id: 'T-1', title: 'one' });
  expect(await second.preview.start()).toEqual({ ok: true });
  await settle();
  expect(second.preview.noticeSnapshot().notices[0].text).toBe('one|NotFound|UnknownTopic');
  await second.preview.stop();
});

test('extensions runtime preview: evidence is labelled preview and the spec is registered in both browsers and CI', () => {
  expect(evidenceLabel()).toMatchObject({ column: 'preview', native: false, installed: false });
  const doc = read('docs/extensions/runtime-preview.md');
  for (const text of ['Preview evidence', 'not native', 'src/extensions/runtime-preview.ts']) expect(doc, text).toContain(text);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-preview.spec.ts');
  expect(read('playwright.webkit.config.ts')).toContain('extensions runtime preview:');
});
