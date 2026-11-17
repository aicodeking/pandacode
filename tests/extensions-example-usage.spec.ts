import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { scopeVisible } from '../src/extensions/runtime-dynamic-items';
import type { SettingsPackage, Store } from '../src/extensions/runtime-content-resources';
import { record, type World as UsageWorld } from '../src/extensions/runtime-usage-resources';
import type { StartWorld } from '../src/extensions/runtime-tasks-start';
import { createRuntimePreview, PandaError, type Grants, type Loaders, type PreviewManifest, type PreviewPanda, type ServiceModule } from '../src/extensions/runtime-preview';

// R1208: the usage band (sample.usage). PREVIEW column: the shipped lib/usage.mjs of the example package runs in the preview
// runner (src/extensions/runtime-preview.ts), whose twins serve the host's resources (usage, limits, accounts), live items,
// notices and grants. What the preview runner does not have yet is written here as a STAND-IN and labelled: the declared
// connection (answered by B3's browser-importable core, with the host's credential kept on this side), the hooks, the draft,
// compact, the harness list and the report panel's channel. The installed package, the real hook path and the real B3 over HTTP
// are qualified by the native tests and the installed run, prepared in tests/fixtures/extensions/example-usage/evidence-columns.json.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/usage/package/extension.json')) as PreviewManifest & { permissions: string[]; contributes: { settings: { id: string; fields: { id: string; kind: string; value?: string }[] }[]; hooks: { event: string }[]; connections: { id: string; operations: { url: string }[] }[]; menus: { id: string; location: string }[]; commands: { id: string }[] } };
const scenario = JSON.parse(read('tests/fixtures/extensions/example-usage/scenario.json')) as {
  tasks: { id: string; projectId: string; harness: string }[]; harnesses: Record<string, { compact: string }>;
  readings: Record<string, { status: string; stale: boolean; plan?: string; email?: string; windows: { label: string; usedPercent: number; resetHours: number }[] }>;
  connection: { id: string; harness: string; name: string; revision: number; reading: { status: string; stale: boolean; windows: { label: string; usedPercent: number; resetHours: number }[] } };
  api: { windows: unknown[]; afterControl: unknown[] }; credential: { handle: string; canary: string };
  turns: { task: string; turn: number; usedTokens: number; contextWindow: number; expect: { fill: number; tone: string } }[];
};
const OWNER = 'sample.usage';
const BAND = `${OWNER}/band`, PAGE = `${OWNER}/options`, REPORT = `${OWNER}/report`;
const FRESH = `${OWNER}/startFresh`, INSERT = `${OWNER}/insertCheckpoint`, CLEAN = `${OWNER}/cleanUp`;
const bandId = (task: string) => `${BAND}-${task}`;
const T0 = Date.parse('2026-11-17T10:00:00Z');
const FAKE = 'sample.launch-agent/fake';

type Menu = { id: string; text?: string; tone?: string; progress?: number; tooltip?: string; visible?: boolean; scope?: { taskId?: string }; items?: { id: string; title: string; command: string }[] };
type Layer = { menus: Menu[]; overrides: Record<string, Record<string, unknown>> };
type Notice = { key?: string; title?: string; text: string };
type Timer = { at: number; fn: () => void; dead: boolean };

async function boot(over: { grants?: Grants; interval?: string; afterReply?: string; signedIn?: boolean; safeMode?: boolean } = {}) {
  const logic = await import('../examples/extensions/usage/package/lib/usage.mjs');
  const { createCloud } = await import('./fixtures/extensions/backends/core/fake-cloud.mjs');
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  let clock = T0;
  const iso = (hours: number) => new Date(T0 + hours * 3600000).toISOString();
  const reading = (source: { status: string; stale: boolean; plan?: string; email?: string; windows: { label: string; usedPercent: number; resetHours: number }[] }) => ({
    status: source.status, stale: source.stale, checkedAt: clock, ...(source.plan ? { plan: source.plan } : {}), ...(source.email ? { email: source.email } : {}),
    windows: source.windows.map(window => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: iso(window.resetHours) })),
  });
  const world = {
    tasks: scenario.tasks.map(task => ({ id: task.id, projectId: task.projectId })), ledger: [],
    readings: Object.fromEntries(Object.entries(scenario.readings).map(([harness, value]) => [harness, reading(value)])),
    connectionReadings: {} as Record<string, unknown>, connections: [] as unknown[], app: {}, services: [], active: {} as Record<string, string>,
  } as { tasks: { id: string; projectId: string }[]; ledger: unknown[]; readings: Record<string, { windows: { usedPercent: number }[] }>; connectionReadings: Record<string, unknown>; connections: unknown[]; app: object; services: unknown[]; active: Record<string, string> };

  // The usage API is B3 (the identity server and model API fake). The credential belongs to the host: it is attached on this side
  // of the stand-in and never appears in anything the service receives.
  const cloud = createCloud({ now: () => clock });
  const link = { signedIn: over.signedIn ?? true, down: false, requests: [] as { path: string; header: string }[], answers: [] as unknown[] };
  const answers = new Map<string, unknown>();
  const hookHandlers = new Map<string, (payload: unknown) => unknown>();
  const posts: { viewId: string; message: { kind: string; ranges?: Record<string, { days: { day: string; tokens: number }[]; groups: { harness: string; model: string; tokens: number; turns: number }[] }> } }[] = [];
  const viewHandlers = new Map<string, (message: unknown, from: unknown) => unknown>();
  const drafts: { taskId: string; text: string }[] = [];
  const compacted: string[] = [];
  const need = (permission: string) => { if (!grants.has(permission)) throw new PandaError('PermissionDenied'); };
  let requestSerial = 0;

  const extend = (panda: PreviewPanda): PreviewPanda => ({
    ...panda,
    hooks: {
      on: (event: string, handler: (payload: unknown) => unknown) => {
        need(event === 'prompt.submit' ? 'harness.hooks.context' : 'harness.hooks.observe');
        hookHandlers.set(event, handler);
        return { ready: Promise.resolve(), dispose: () => { hookHandlers.delete(event); } };
      },
    },
    connections: {
      status: async () => { need('connections.request'); return { schemaVersion: 1, state: link.signedIn ? 'connected' : 'disconnected', credential: link.signedIn ? scenario.credential.handle : null }; },
      start: async (options: { connection: string; operation: string; credential?: string }) => {
        need('connections.request');
        if (options.connection !== `${OWNER}/api` || options.operation !== 'usage') throw new PandaError('PermissionDenied');
        if (options.credential !== scenario.credential.handle) throw new PandaError('NotFound');
        const id = `r${++requestSerial}`;
        if (link.down) answers.set(id, { state: 'failed', error: 'HostUnavailable', response: null });
        else {
          const url = new URL(manifest.contributes.connections[0].operations[0].url);
          const answer = await cloud.request('api', 'GET', url, { 'x-api-key': scenario.credential.canary, 'x-client': 'sample.usage' });
          link.requests.push({ path: url.pathname, header: scenario.credential.canary });
          answers.set(id, { state: 'completed', error: null, response: { schemaVersion: 1, status: answer.status, body: answer.data } });
        }
        return { schemaVersion: 1, request: id, state: 'running', response: null, error: null };
      },
      poll: async (options: { request: string }) => { need('connections.request'); return { schemaVersion: 1, request: options.request, ...(answers.get(options.request) as object) }; },
      cancel: async () => ({}),
    },
    harnesses: {
      list: async (options: { harness?: string }) => ({ schemaVersion: 1, harnesses: Object.entries(scenario.harnesses).filter(([id]) => !options.harness || id === options.harness).map(([id, value]) => ({ id, compact: { how: value.compact } })) }),
      refreshLimits: async () => { need('harnesses.limits.read'); return null; },
    },
    // STAND-IN for the native gate of the band location (runtime_composer_band::gate): the preview twin of live items checks
    // `ui.dynamic`; `ui.presentation` is checked by the band's own gate, which the preview runner does not have.
    ui: {
      ...panda.ui,
      register: async (item: { location?: string }) => { if (item.location === 'panda.composer.band') need('ui.presentation'); return panda.ui.register(item); },
      update: async (id: string, patch: unknown) => { if (id.startsWith(`${BAND}-`)) need('ui.presentation'); return panda.ui.update(id, patch); },
    },
    views: {
      post: async (viewId: string, message: never) => { posts.push({ viewId, message }); return { delivered: 1 }; },
      instances: async () => [],
      onMessage: (viewId: string, handler: (message: unknown, from: unknown) => unknown) => { viewHandlers.set(viewId, handler); return { dispose: () => { viewHandlers.delete(viewId); } }; },
      on: () => ({ dispose: () => undefined }),
    },
    tasks: {
      ...panda.tasks,
      draft: { insert: async (options: { taskId: string; text: string }) => { need('tasks.draft'); drafts.push(options); return { revision: drafts.length }; } },
      compact: async (taskId: string) => { need('tasks.control'); compacted.push(taskId); return null; },
    },
  } as unknown as PreviewPanda);

  // Timers are the spec's: advancing the clock runs what is due, in order, like the host's scheduler would.
  const timers: Timer[] = [];
  const schedule = (fn: () => void, ms: number) => { const timer: Timer = { at: clock + ms, fn, dead: false }; timers.push(timer); return { cancel: () => { timer.dead = true; } }; };
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter(timer => !timer.dead && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true; clock = Math.max(clock, due.at); due.fn(); await flush();
    }
    clock = end; await flush();
  };
  const ledgerRows: unknown[] = [];
  const env = { now: () => clock, schedule, sleep: async () => undefined, liveMs: 500, pollMs: 1, ledger: { read: async () => ledgerRows as never[], write: async (rows: unknown[]) => { ledgerRows.splice(0, ledgerRows.length, ...rows); } } };

  let controls: { faults(): { what: string; code: string }[]; state(): unknown } | null = null;
  const loaders: Loaders = { 'main.cjs': async () => ({ service: async (panda: unknown, lifetime: unknown) => { controls = await logic.run(extend(panda as PreviewPanda) as never, lifetime as never, env); } }) as unknown as ServiceModule };
  const page = manifest.contributes.settings[0];
  const settings: SettingsPackage[] = [{ id: OWNER, enabled: true, pages: [{ id: PAGE, fields: page.fields }], stored: { [PAGE]: { minIntervalSeconds: over.interval ?? '1', afterReply: over.afterReply ?? 'low' } } } as unknown as SettingsPackage];
  const store: Store = { tasks: scenario.tasks.map(task => ({ id: task.id, projectId: task.projectId })) as never, messages: [], changes: [], revision: 1 };
  const tasksStart: StartWorld = {
    projects: ['p1'], worktrees: [], targets: [],
    catalog: { providers: [{ id: 'claude', installed: true }, { id: FAKE, installed: true, models: [{ id: 'fake-1' }], metadata: { modes: ['ask'], readiness: { state: 'ready' } } }], defaultProvider: 'claude', rememberedModel: () => 'sonnet', initialMode: () => 'full' },
  };
  const preview = createRuntimePreview({ manifest, loaders, grants, settings, store, usage: world as unknown as UsageWorld, now: () => clock, scopes: { tasks: scenario.tasks.map(task => task.id), projects: ['p1'] }, safeMode: over.safeMode, tasksStart });

  const act = async <T>(run: () => T | Promise<T>): Promise<T> => { clock += 1100; const value = await run(); await flush(); return value; };
  const owner = () => (preview.layer().owners[OWNER] as Layer | undefined);
  const band = (task: string) => owner()?.menus.find(menu => menu.id === bandId(task));
  const notices = () => (preview.noticeSnapshot().notices as unknown as Notice[]);
  const created = (task: string) => { const entry = scenario.tasks.find(item => item.id === task)!; return act(() => preview.publish({ kind: 'task.created', taskId: task, projectId: entry.projectId, harness: entry.harness, startedBy: 'user' })); };
  const shown = (task: string | null) => act(() => preview.publish({ kind: 'task.shown', windowId: 'main', taskId: task, projectId: task ? 'p1' : null }));
  const report = (turn: number) => { const step = scenario.turns.filter(item => item.task === 't1')[turn - 1]; record(world.ledger as never, step.task, step.turn, { usedTokens: step.usedTokens, contextWindow: step.contextWindow }, clock); return step; };
  const hook = (event: string, payload: Record<string, unknown>) => hookHandlers.get(event)!(payload);
  return {
    logic, preview, grants, world, cloud, link, posts, viewHandlers, drafts, compacted, hookHandlers, act, advance, flush, owner, band, notices, created, shown, report, hook, iso, controls: () => controls!,
    set clock(value: number) { clock = value; }, get clock() { return clock; },
    visibleFor: (task: string) => (owner()?.menus ?? []).filter(menu => menu.scope && scopeVisible(menu as never, { taskId: task, projectId: 'p1' })),
  };
}
type Board = Awaited<ReturnType<typeof boot>>;
const within = (what: string, check: () => unknown, timeout = 2000) => expect.poll(check, { message: what, timeout, intervals: [10, 20, 50] });
const hhmm = (board: Board, hours: number) => board.logic.formatReset(Date.parse(board.iso(hours)));

test('usage band preview: the package is a valid service package whose logic file is browser-safe and holds no credential', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual([
    'ui.contribute', 'runtime.service', 'events.workspace', 'ui.dynamic', 'ui.notify', 'ui.presentation', 'ui.richViews', 'tasks.usage.read', 'harnesses.limits.read',
    'harnesses.accounts.read', 'tasks.summary', 'storage.private', 'connections.request', 'harness.hooks.observe', 'harness.hooks.context', 'tasks.start', 'tasks.draft', 'tasks.control',
  ]);
  expect(manifest.permissions).not.toContain('secrets.private');
  expect(manifest.permissions.some(name => name.startsWith('credentials'))).toBe(false);
  expect(manifest.contributes.menus.find(menu => menu.id === BAND)?.location).toBe('panda.composer.band');
  expect(manifest.contributes.hooks.map(item => item.event)).toEqual(['prompt.submit', 'turn.finish']);
  expect(manifest.contributes.connections[0].operations[0].url).toBe('http://127.0.0.1:19474/v1/usage');
  const logic = read('examples/extensions/usage/package/lib/usage.mjs');
  expect(logic).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(logic).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function|fetch\(|XMLHttpRequest|credentials\.read/);
  for (const call of ['panda.ui.register(', 'panda.connections.start(', 'panda.hooks.on(', 'panda.tasks.draft.insert(', 'panda.tasks.compact(', 'panda.tasks.start(', "resource: 'usage'", "resource: 'limits'", "resource: 'accounts'"]) expect(logic, call).toContain(call);
  const main = read('examples/extensions/usage/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:fs/promises', 'node:path']);
  expect([...main.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['./lib/usage.mjs']);
});

test('usage band preview: behavior 1, the band shows the context fill and the tightest window within 1 s of each usage report', async () => {
  const board = await boot();
  expect(await board.preview.start()).toEqual({ ok: true });
  await board.created('t1');
  await within('the segment of the task', () => board.band('t1')?.text).toContain('No usage yet');
  // No report yet: no fill, no bar; the window of the host's own reading is the tightest (63% left).
  expect(board.band('t1')?.progress).toBeUndefined();
  expect(board.band('t1')?.text).toBe(`No usage yet | 5h: 63% left, resets ${hhmm(board, 2)}`);
  await board.act(() => board.preview.publish({ kind: 'turn.started', taskId: 't1', projectId: 'p1', index: 1 }));
  for (const step of scenario.turns.filter(item => item.task === 't1')) {
    board.report(step.turn);
    await board.advance(500);                                  // the running task is read again every 500 ms
    await within(`fill ${step.expect.fill}%`, () => board.band('t1')?.text).toMatch(new RegExp(`^Context ${step.expect.fill}% \\| 5h: 63% left`));
    expect(board.band('t1')).toMatchObject({ progress: step.expect.fill, tone: step.expect.tone });
  }
  // The manifest's placeholder segment is hidden: one segment for the task, one per package.
  expect(board.owner()?.overrides[BAND]).toMatchObject({ visible: false });
  expect(board.band('t1')?.items?.map(item => item.title)).toEqual(['Start fresh', 'Insert checkpoint', 'Clean up']);
  await board.preview.stop();
});

test('usage band preview: behavior 2, switching tasks shows that task\'s numbers and a task without usage shows no fill', async () => {
  const board = await boot();
  await board.preview.start();
  await board.created('t1'); await board.created('t2'); await board.created('t3');
  board.report(2);
  record(board.world.ledger as never, 't2', 1, { usedTokens: 1000, contextWindow: 4000 }, board.clock);
  await board.shown('t1');
  await within('task one', () => board.band('t1')?.text).toMatch(/^Context 55%/);
  await board.shown('t2');
  await within('task two', () => board.band('t2')?.text).toMatch(/^Context 25% \| 5h: 30% left/);   // the other harness's window
  await board.shown('t3');
  await within('task three', () => board.band('t3')?.text).toMatch(/^No usage yet/);
  expect(board.band('t3')?.progress).toBeUndefined();
  // Only the shown task's segment is in the composer's layer for that window.
  expect(board.visibleFor('t3').map(menu => menu.id)).toEqual([bandId('t3')]);
  expect(board.visibleFor('t1').map(menu => menu.id)).toEqual([bandId('t1')]);
  await board.shown(null);
  expect(board.visibleFor('none').map(menu => menu.id)).toEqual([]);
  await board.preview.stop();
});

test('usage band preview: behavior 3, one "Context nearly full" notice per task and crossing, re-armed after the fill drops', async () => {
  const board = await boot();
  await board.preview.start();
  await board.created('t1'); await board.created('t2');
  await board.act(() => board.preview.publish({ kind: 'turn.started', taskId: 't1', projectId: 'p1', index: 1 }));
  board.report(3); await board.advance(500);
  await within('warning tone', () => board.band('t1')?.tone).toBe('warning');
  expect(board.notices().filter(notice => /nearly full/i.test(`${notice.title}${notice.text}`))).toHaveLength(0);
  board.report(4); await board.advance(500);
  await within('the notice', () => board.notices().filter(notice => /nearly full/i.test(`${notice.title}${notice.text}`)).length).toBe(1);
  // Another report above 80 raises nothing more; another task raises its own.
  record(board.world.ledger as never, 't1', 4, { usedTokens: 9000, contextWindow: 10000 }, board.clock); await board.advance(500);
  await within('the later report', () => board.band('t1')?.text).toMatch(/^Context 90%/);
  expect(board.notices().filter(notice => /nearly full/i.test(`${notice.title}${notice.text}`))).toHaveLength(1);
  record(board.world.ledger as never, 't2', 1, { usedTokens: 3500, contextWindow: 4000 }, board.clock);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't2', projectId: 'p1', index: 1 }));
  await within('the second task\'s notice', () => board.notices().filter(notice => /nearly full/i.test(`${notice.title}${notice.text}`)).length).toBe(2);
  // A compaction brings the fill under 80; crossing again raises one more for that task.
  record(board.world.ledger as never, 't1', 5, { usedTokens: 2000, contextWindow: 10000 }, board.clock);
  await board.act(() => board.preview.publish({ kind: 'task.compacted', taskId: 't1', projectId: 'p1' }));
  await within('the band after the compaction', () => board.band('t1')?.text).toMatch(/^Context 20%/);
  await board.preview.dismissNotice(`${OWNER}/full-t1`);
  record(board.world.ledger as never, 't1', 6, { usedTokens: 8500, contextWindow: 10000 }, board.clock);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 6 }));
  await within('the crossing again', () => board.notices().filter(notice => /nearly full/i.test(`${notice.title}${notice.text}`)).length).toBe(2);
  await board.preview.stop();
});

test('usage band preview: behavior 4, one request per interval through the declared connection and none while no task exists', async () => {
  // The interval is 5 s here (the plan's test value is 1 s): the spec's own actions are spaced 1.1 s apart, which is under it.
  const board = await boot({ interval: '5' });
  await board.preview.start();
  await board.advance(12000);
  expect(board.link.requests).toHaveLength(0);                 // no task: the service reads nothing
  await board.created('t1');
  await within('the first read', () => board.link.requests.length).toBe(1);
  expect(board.link.requests[0].path).toBe('/v1/usage');
  // Events inside the interval do not read again; each elapsed interval reads once.
  await board.shown('t1'); await board.created('t2');
  expect(board.link.requests).toHaveLength(1);
  const before = board.link.requests.length;
  await board.advance(5000); await board.advance(5000); await board.advance(5000);
  await within('three more intervals', () => board.link.requests.length - before).toBe(3);
  // The API's own windows reach the band and name themselves; a control change reaches it on the next read.
  await board.cloud.control('usage', { windows: scenario.api.afterControl });
  await board.advance(5000);
  await within('the tightest window is now the API\'s', () => board.band('t1')?.text).toMatch(/api 5h: 4% left/);
  // No task left: the poller stops asking.
  await board.act(() => board.preview.publish({ kind: 'task.removed', taskId: 't1', projectId: 'p1' }));
  await board.act(() => board.preview.publish({ kind: 'task.removed', taskId: 't2', projectId: 'p1' }));
  const settled = board.link.requests.length;
  await board.advance(20000);
  expect(board.link.requests.length).toBe(settled);
  await board.preview.stop();
});

test('usage band preview: behavior 5, the limits notice after a reply follows the afterReply setting', async () => {
  const low = await boot({ afterReply: 'low' });
  await low.preview.start();
  await low.created('t2');
  record(low.world.ledger as never, 't2', 1, { usedTokens: 1000, contextWindow: 4000 }, low.clock);
  // codex 5h has 30% left: above the 20% line, so "low" says nothing.
  await low.hook('turn.finish', { taskId: 't2', projectId: 'p1', harness: 'codex', model: 'm', index: 1, usage: { usedTokens: 1000 } });
  expect(low.notices().filter(notice => /limits/i.test(notice.title ?? ''))).toHaveLength(0);
  // The host's reading moves to 85% used (15% left): the next reply lists every window with its percentage and reset time.
  low.world.readings.codex.windows[0].usedPercent = 85;
  await low.act(() => low.hook('turn.finish', { taskId: 't2', projectId: 'p1', harness: 'codex', model: 'm', index: 2, usage: { usedTokens: 1000 } }));
  await within('the notice', () => low.notices().filter(notice => /limits/i.test(notice.title ?? '')).length).toBe(1);
  expect(low.notices().find(notice => /limits/i.test(notice.title ?? ''))?.text).toContain(`5h: 15% left, resets ${hhmm(low, 3)}`);
  await low.preview.stop();
  const always = await boot({ afterReply: 'always' });
  await always.preview.start(); await always.created('t1');
  await always.hook('turn.finish', { taskId: 't1', projectId: 'p1', harness: 'claude', model: 'm', index: 1, usage: { usedTokens: 10 } });
  await within('the always notice', () => always.notices().filter(notice => /limits/i.test(notice.title ?? '')).length).toBe(1);
  await always.preview.stop();
  const off = await boot({ afterReply: 'off' });
  await off.preview.start(); await off.created('t2');
  off.world.readings.codex.windows[0].usedPercent = 95;
  await off.hook('turn.finish', { taskId: 't2', projectId: 'p1', harness: 'codex', model: 'm', index: 1, usage: { usedTokens: 10 } });
  expect(off.notices().filter(notice => /limits/i.test(notice.title ?? ''))).toHaveLength(0);
  await off.preview.stop();
});

test('usage band preview: behavior 6, each turn end is recorded and the report panel gets today, 7 and 30 days', async () => {
  const board = await boot();
  await board.preview.start();
  await board.created('t1');
  for (const step of scenario.turns.filter(item => item.task === 't1').slice(0, 3)) {
    board.report(step.turn);
    await board.act(() => board.hook('turn.finish', { taskId: 't1', projectId: 'p1', harness: 'claude', model: 'sonnet', index: step.turn, usage: { usedTokens: step.usedTokens } }));
  }
  await within('three ledger rows folded into one group', () => board.posts.at(-1)?.message.ranges?.today.groups[0]).toEqual({ harness: 'claude', model: 'sonnet', tokens: 2000 + 5500 + 7400, turns: 3 });
  const last = board.posts.at(-1)!;
  expect(last.viewId).toBe(REPORT);
  expect(Object.keys(last.message.ranges!)).toEqual(['today', 'd7', 'd30']);
  expect(last.message.ranges!.d30.days).toEqual([{ day: '2026-11-17', tokens: 14900 }]);
  // The same turn is never counted twice, and the panel can ask again.
  await board.act(() => board.hook('turn.finish', { taskId: 't1', projectId: 'p1', harness: 'claude', model: 'sonnet', index: 3, usage: { usedTokens: 7400 } }));
  expect(board.posts.at(-1)!.message.ranges!.today.groups[0].turns).toBe(3);
  const before = board.posts.length;
  await board.viewHandlers.get(REPORT)!({ kind: 'report.request' }, { instanceId: 'i1' });
  await within('the answer to the request', () => board.posts.length).toBeGreaterThan(before);
  // A later day goes into its own bar.
  board.clock = board.clock + 2 * 86400000;
  board.report(4);
  await board.act(() => board.hook('turn.finish', { taskId: 't1', projectId: 'p1', harness: 'claude', model: 'sonnet', index: 4, usage: { usedTokens: 8300 } }));
  await within('two days', () => board.posts.at(-1)?.message.ranges?.d7.days.map(item => item.tokens)).toEqual([14900, 8300]);
  await board.preview.stop();
});

test('usage band preview: behavior 7, a context note above 70% at most once per five minutes and three times per task', async () => {
  const board = await boot({ interval: '3600' });
  await board.preview.start();
  await board.created('t1');
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toBeNull();     // no usage yet
  board.report(2);
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toBeNull();     // 55%: quiet
  board.report(3);
  await board.advance(0);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 3 }));
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toEqual({ context: 'context is 74% full; keep output brief' });
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toBeNull();     // inside five minutes
  await board.advance(300000);
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toEqual({ context: 'context is 74% full; keep output brief' });
  await board.advance(300000);
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toEqual({ context: 'context is 74% full; keep output brief' });
  await board.advance(300000);
  expect(await board.hook('prompt.submit', { taskId: 't1', projectId: 'p1', harness: 'claude' })).toBeNull();     // the third was the last
  await board.preview.stop();
});

test('usage band preview: behaviors 8 and 9, start fresh needs two clicks, insert checkpoint only writes the draft, clean up follows the harness', async () => {
  const board = await boot();
  await board.preview.start();
  await board.created('t1'); await board.created('t2');
  board.report(2);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 2 }));
  await within('the checkpoint-ready band', () => board.band('t1')?.text).toMatch(/^Context 55%/);
  // The first click only arms the button.
  expect(await board.act(() => board.preview.invoke(FRESH, { taskId: 't1' }))).toEqual({ armed: true });
  expect(board.preview.starter!.tasks).toHaveLength(0);
  await within('the armed label', () => board.band('t1')?.items?.[0].title).toBe('Click again to start fresh');
  expect(await board.act(() => board.preview.invoke(FRESH, { taskId: 't1' }))).toEqual({ started: true });
  expect(board.preview.starter!.tasks).toHaveLength(1);
  expect(board.preview.starter!.tasks[0]).toMatchObject({ projectId: 'p1', title: 'Fresh start' });
  expect(board.preview.starter!.tasks[0].prompt).toBe('Checkpoint from task t1 (claude): 55% of the context was used after 2 turn(s). Continue from where it stopped and keep the answers short.');
  await within('the button is back', () => board.band('t1')?.items?.[0].title).toBe('Start fresh');
  // An armed button that is not clicked again disarms by itself.
  await board.act(() => board.preview.invoke(FRESH, { taskId: 't1' }));
  await board.advance(9000);
  await within('the disarmed label', () => board.band('t1')?.items?.[0].title).toBe('Start fresh');
  expect(board.preview.starter!.tasks).toHaveLength(1);
  // Insert checkpoint writes the draft and sends nothing.
  expect(await board.act(() => board.preview.invoke(INSERT, { taskId: 't1' }))).toEqual({ inserted: true });
  expect(board.drafts).toHaveLength(1);
  expect(board.drafts[0].text).toContain('55% of the context was used');
  expect(board.preview.starter!.tasks).toHaveLength(1);
  // Clean up appears only where the harness compacts (claude: yes, codex: no) and compacts that task.
  expect(board.band('t1')?.items?.map(item => item.command)).toEqual([FRESH, INSERT, CLEAN]);
  expect(board.band('t2')?.items?.map(item => item.command)).toEqual([FRESH, INSERT]);
  expect(await board.act(() => board.preview.invoke(CLEAN, { taskId: 't1' }))).toEqual({ compacting: true });
  expect(board.compacted).toEqual(['t1']);
  await board.preview.stop();
});

test('usage band preview: a changed account, a stale reading and an offline API update the right band and expose no credential', async () => {
  const board = await boot();
  await board.preview.start();
  await board.created('t1'); await board.created('t2');
  await within('the default account', () => board.band('t1')?.text).toBe(`No usage yet | 5h: 63% left, resets ${hhmm(board, 2)}`);
  // The user switches the harness to a saved connection (R0806): the resources report the new active flags and its own windows.
  board.world.connections.push({ id: scenario.connection.id, harness: scenario.connection.harness, name: scenario.connection.name, revision: scenario.connection.revision });
  board.world.connectionReadings[`${scenario.connection.id}#${scenario.connection.revision}`] = {
    status: 'ready', stale: false, checkedAt: board.clock, windows: scenario.connection.reading.windows.map(window => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: board.iso(window.resetHours) })),
  };
  board.world.active.claude = scenario.connection.id;
  await board.act(() => board.preview.publish({ kind: 'app.focus', focused: true }));
  await within('the band follows the account', () => board.band('t1')?.text).toBe(`No usage yet | 5h: 9% left, resets ${hhmm(board, 1)}`);
  expect(board.band('t1')?.tone).toBe('warning');
  expect(board.band('t1')?.tooltip).toContain(`Account: ${scenario.connection.name}`);
  // The other harness's band is not touched by that account.
  expect(board.band('t2')?.text).toBe(`No usage yet | 5h: 30% left, resets ${hhmm(board, 3)}`);
  // A stale reading is marked, a failing API keeps the last values and says so.
  (board.world.connectionReadings[`${scenario.connection.id}#${scenario.connection.revision}`] as { stale: boolean }).stale = true;
  await board.act(() => board.preview.publish({ kind: 'app.focus', focused: true }));
  await within('the stale mark', () => board.band('t1')?.text).toContain('(stale)');
  board.link.down = true;
  await board.advance(1000);
  await within('the API is offline', () => board.band('t1')?.tooltip).toContain('did not answer');
  expect(board.band('t1')?.tooltip).toMatch(/api 5h: 63% left, resets \d\d:\d\d \(stale\)/);
  // Never a credential or an identity: not in the layer, the notices, the posts, the faults or the requests the service saw.
  const everything = JSON.stringify([board.preview.layer(), board.notices(), board.posts, board.controls().faults(), board.preview.steps]);
  for (const secret of [scenario.credential.canary, scenario.credential.handle, 'canary-user@example.test']) expect(everything).not.toContain(secret);
  await board.preview.stop();
});

test('usage band preview: a signed-out API reads nothing and says so; usage is never reconstructed from display text', async () => {
  const board = await boot({ signedIn: false });
  await board.preview.start();
  await board.created('t1');
  await board.advance(2000);
  expect(board.link.requests).toHaveLength(0);
  await within('the API note', () => board.band('t1')?.tooltip).toContain('needs its credential');
  // The numbers are the resources' figures: change them and nothing else, and the band follows exactly.
  record(board.world.ledger as never, 't1', 1, { usedTokens: 3333, contextWindow: 10000 }, board.clock);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 1 }));
  await within('33%', () => board.band('t1')?.progress).toBe(33);
  const logic = read('examples/extensions/usage/package/lib/usage.mjs');
  expect(logic).not.toMatch(/\.text\.match|\.text\.split|parseFloat\(\s*[a-z.]*text|replace\(\s*\/%/);
  await board.preview.stop();
});

test('usage band preview: each grant is separate, and revoke, disable and safe mode clear the band and the subscriptions', async () => {
  // A refused draft or compaction costs that button only: the band and the other buttons keep working.
  const board = await boot();
  await board.preview.start();
  await board.created('t1');
  board.report(2);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 2 }));
  await board.preview.revoke('tasks.draft');
  expect(await board.act(() => board.preview.invoke(INSERT, { taskId: 't1' }))).toEqual({ inserted: false });
  expect(board.drafts).toHaveLength(0);
  expect(board.notices().some(notice => /not written/.test(notice.text))).toBe(true);
  await board.preview.revoke('tasks.control');
  expect(await board.act(() => board.preview.invoke(CLEAN, { taskId: 't1' }))).toEqual({ compacting: false });
  expect(board.compacted).toEqual([]);
  expect(board.band('t1')?.text).toMatch(/^Context 55%/);
  // Without tasks.usage.read the band says so instead of inventing numbers; without ui.presentation no band is drawn at all.
  await board.preview.revoke('tasks.usage.read');
  board.report(3);
  await board.act(() => board.preview.publish({ kind: 'turn.finished', taskId: 't1', projectId: 'p1', index: 3 }));
  await within('usage unavailable', () => board.band('t1')?.text).toMatch(/^Usage unavailable/);
  await board.preview.stop();

  // Revoking ui.presentation while the band is up removes it natively (runtime_composer_band::strip_ungranted, qualified by
  // the native column and tests/extensions-runtime-composer-band.spec.ts); the preview runner has no band gate. Here: a
  // package that never held it registers nothing, keeps running, and reports the refusal.
  const gone = await boot({ grants: new Map(manifest.permissions.filter(name => name !== 'ui.presentation').map(name => [name, true as const])) });
  await gone.preview.start();
  await gone.created('t1');
  await gone.advance(1000);
  expect(gone.band('t1')).toBeUndefined();
  expect(gone.controls().faults().some(fault => fault.what === 'ui.register' && fault.code === 'PermissionDenied')).toBe(true);
  await gone.preview.stop();

  for (const reason of ['disable', 'safeMode'] as const) {
    const run = await boot();
    await run.preview.start();
    await run.created('t1');
    await within('the segment', () => run.band('t1')?.id).toBe(bandId('t1'));
    expect(run.hookHandlers.size).toBe(2);
    await (reason === 'disable' ? run.preview.setEnabled(false) : run.preview.setSafeMode(true));
    expect(run.owner()?.menus ?? []).toEqual([]);
    expect(run.hookHandlers.size).toBe(0);
    expect(run.viewHandlers.size).toBe(0);
    expect(run.notices()).toEqual([]);
    // A stopped service starts no more timers and answers no more events.
    const requests = run.link.requests.length;
    await run.advance(5000);
    expect(run.link.requests.length).toBe(requests);
    expect(await run.preview.start()).toMatchObject({ ok: false });
  }

  const started = await boot({ safeMode: true });
  expect(await started.preview.start()).toMatchObject({ ok: false, code: 'HostUnavailable' });
  expect(started.owner()).toBeUndefined();
});
