import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import type { SettingsPackage, Store } from '../src/extensions/runtime-content-resources';
import { PreviewPanelHost } from '../src/extensions/runtime-rich-channel';
import { createRuntimePreview, type DaemonFactory, type Grants, type Loaders, type PreviewManifest, type ServiceModule } from '../src/extensions/runtime-preview';

// R1206: the Machine monitor (sample.monitor). PREVIEW column: the shipped lib/monitor.mjs of the example package runs in the
// preview runner (src/extensions/runtime-preview.ts) against B1's browser-importable core (`metrics` topic, scripted samples,
// machine controls), with the R0303 PreviewPanelHost for the rich panel; the panel's own files run in a page whose
// `pandaView` is a stub. It proves the monitor's logic and what the interface would be handed. The installed package and the
// native notice recorder are the native/installed columns prepared in tests/fixtures/extensions/example-monitor/evidence-columns.json.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/monitor/package/extension.json')) as PreviewManifest & { permissions: string[]; contributes: { settings: { id: string; fields: { id: string; kind: string; value?: unknown }[] }[] } };
const OWNER = 'sample.monitor';
const PAGE = `${OWNER}/thresholds`, STATUS = `${OWNER}/status`, VIEW = `${OWNER}/fleet`, TEST = `${OWNER}/test-alert`;
const FIXTURE = JSON.parse(read('tests/fixtures/extensions/example-monitor/scripts.json')) as { machines: { id: string; name: string }[]; scripts: Record<string, { cpu: number; mem: number }[]> };

type Layer = { menus: { id: string }[]; overrides: Record<string, Record<string, unknown>> };
type Table = { kind: string; label: string; columns: string[]; rows: string[][] };
type Out = Record<string, any>;

async function boot(over: { offline?: boolean; grants?: Grants; safeMode?: boolean; panels?: boolean } = {}) {
  const { createDaemon } = await import('./fixtures/extensions/backends/core/fake-daemon.mjs');
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  const page = manifest.contributes.settings[0];
  const settings: SettingsPackage[] = [{ id: OWNER, enabled: true, pages: [{ id: PAGE, fields: page.fields }], stored: {} } as unknown as SettingsPackage];
  const store: Store = { tasks: [], messages: [], changes: [], revision: 1 };
  const time = { clock: 1000 };
  const link = { offline: over.offline ?? false };
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  const hooks = { down: new Set<() => void>(), up: new Set<() => void>() };
  let deliver: Parameters<DaemonFactory>[0] = () => undefined;
  const core = createDaemon({ now: () => time.clock, emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => deliver(topic, frame), seed: { machines: FIXTURE.machines } });
  const daemon: DaemonFactory = emit => {
    deliver = emit;
    return {
      request: (op, params) => { requests.push({ op, params: (params ?? {}) as Record<string, unknown> }); if (link.offline) throw Object.assign(new Error('away'), { code: 'HostUnavailable' }); return core.request(op, params); },
      control: (path, params) => core.control(path, params),
    };
  };
  // The preview link has no connection to lose: the spec adds the two hooks the installed link has (onDown, onUp) and fires them.
  const loaders: Loaders = { 'main.cjs': async () => {
    const logic = await import('../examples/extensions/monitor/package/lib/monitor.mjs');
    const track = (set: Set<() => void>) => (handler: () => void) => { set.add(handler); return { dispose: () => { set.delete(handler); } }; };
    return { service: (panda: unknown, lifetime: unknown) => logic.run(panda as never, lifetime as never, { ...logic.linkFromPanda(panda as never), onDown: track(hooks.down), onUp: track(hooks.up) }, { now: () => time.clock }) } as unknown as ServiceModule;
  } };
  const panels = over.panels ? new PreviewPanelHost(() => time.clock) : undefined;
  const preview = createRuntimePreview({ manifest, loaders, grants, settings, store, daemon, now: () => time.clock, scopes: { tasks: ['t1'], projects: ['p1'] }, safeMode: over.safeMode, panels });
  // The host applies 20 updates a second to a package: every action of the spec happens a second after the last.
  const act = async <T>(run: () => T | Promise<T>): Promise<T> => { time.clock += 1100; return run(); };
  const owner = () => (preview.layer().owners[OWNER] as Layer | undefined);
  const view = () => owner()?.overrides[VIEW];
  const table = () => (view()?.controls as Table[] | undefined)?.[0];
  /** One scripted reading of one machine: B1 queues it and advances the machine by one sample. */
  const reading = async (id: string, cpu: number, mem: number) => { core.control('metrics/script', { machine: id, samples: [{ cpu, mem }] }); return act(() => core.sample(id)); };
  const run = async (id: string, samples: { cpu: number; mem: number }[]) => { for (const item of samples) await reading(id, item.cpu, item.mem); };
  const texts = () => preview.noticeSnapshot().notices.map(notice => notice.text);
  const intervals = () => requests.filter(item => item.op === 'subscribe' && typeof item.params.intervalMs === 'number').map(item => item.params.intervalMs as number);
  return {
    preview, grants, link, core, act, owner, view, table, panels, requests, hooks, time, reading, run, texts, intervals,
    status: () => owner()?.overrides[STATUS] as { text?: string; tone?: string; tooltip?: string } | undefined,
    statusText: () => owner()?.overrides[STATUS]?.text as string | undefined,
    held: () => { try { return JSON.parse(preview.status.text ?? 'null') as Record<string, any>; } catch { return null; } },
    down: () => { link.offline = true; for (const handler of [...hooks.down]) handler(); },
    up: () => { link.offline = false; for (const handler of [...hooks.up]) handler(); },
    save: (values: Record<string, unknown>) => act(() => preview.setSettings(PAGE, values as never)),
  };
}
type Board = Awaited<ReturnType<typeof boot>>;
const within = (what: string, check: () => unknown, timeout = 2000) => expect.poll(check, { message: what, timeout, intervals: [10, 20, 50] });

// ---- one panel instance, assembled the way the panel's own script assembles it ------------------------------------------------

const ORIGIN = { owner: OWNER, version: '1.0.0', viewId: VIEW };
const ok = (envelope: unknown) => { const answer = envelope as { ok: boolean; value?: unknown; error?: { message: string } }; if (!answer.ok) throw new Error(answer.error?.message); return answer.value as Out; };
function attach(board: Board, label = 'extension-panel-a') {
  const received: Out[] = [];
  const frame = { contentWindow: { postMessage: (message: { detail: Out }) => received.push(message.detail) } as unknown as Window };
  const session = `s-${label}`;
  board.panels!.bind(label, frame, ORIGIN);
  const init = ok(board.panels!.handle(label, { schemaVersion: 1, session, kind: 'hello' }));
  let next = 0;
  const messages = () => received.filter(item => item.kind === 'message').map(item => item.message as Out);
  const send = (message: unknown) => board.act(async () => ok(board.panels!.handle(label, { schemaVersion: 1, session, kind: 'post', id: ++next, message })));
  const kinds = (kind: string) => messages().filter(item => item.kind === kind);
  /** The latest complete snapshot: `fleet.begin` plus one `fleet.history` per machine of its sequence. */
  const snapshot = () => {
    const begins = kinds('fleet.begin');
    for (let at = begins.length - 1; at >= 0; at -= 1) {
      const meta = begins[at];
      const histories = kinds('fleet.history').filter(item => item.seq === meta.seq);
      if (histories.length === meta.machines.length) return { meta, histories };
    }
    return null;
  };
  return { label, init, received, messages, send, kinds, snapshot, show: (visible: boolean) => board.panels!.setVisible(label, visible) };
}
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

// ---- the package ------------------------------------------------------------------------------------------------------------

test('monitor preview: the package is a valid service package whose logic file is browser-safe and whose panel has several asset files', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'events.workspace', 'ui.dynamic', 'ui.notify', 'ui.richViews']);
  expect(manifest.runtime).toMatchObject({ kind: 'node', entrypoint: 'main.cjs', files: ['lib'], service: { start: 'onEnable' } });
  const logic = read('examples/extensions/monitor/package/lib/monitor.mjs');
  expect(logic).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(logic).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function/);
  for (const call of ['panda.ui.update(', 'panda.ui.updateView(', 'panda.ui.notify(', 'panda.ui.withdraw(', 'panda.commands.register(', "'settings.changed'", 'panda.views', "panel.on('visible'", "panel.on('hidden'", 'link.request(', 'link.pace?.(']) expect(logic, call).toContain(call);
  const main = read('examples/extensions/monitor/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:net']);
  expect([...main.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['./lib/monitor.mjs']);
  const view = (manifest.contributes as unknown as { views: { id: string; rich: Record<string, unknown> }[] }).views[0];
  expect(view).toMatchObject({ id: VIEW, rich: { folder: 'panel', entry: 'index.html', placement: 'inspector' } });
  const page = read('examples/extensions/monitor/package/panel/index.html');
  expect(page).toContain('./style.css');
  expect(page).toContain('./app.js');
  expect(read('examples/extensions/monitor/package/panel/app.js')).toContain("from './chart.js'");
  // The panel never reads the daemon: it draws what the service sends.
  expect(read('examples/extensions/monitor/package/panel/app.js')).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

// ---- the service ------------------------------------------------------------------------------------------------------------

test('monitor preview: the status item reads ok, strained and critical through a scripted climb and returns to ok; the table follows', async () => {
  const board = await boot();
  expect(await board.preview.start()).toEqual({ ok: true });
  await within('the first status', () => board.statusText()).toBe('2 machines ok');
  expect(board.status()).toMatchObject({ tone: 'success' });
  expect(board.table()).toMatchObject({ kind: 'table', label: 'Machines', columns: ['Machine', 'Level', 'CPU', 'Memory', 'Seen'] });
  expect(board.table()?.rows.map(row => [row[0], row[1]])).toEqual([['alpha', 'ok'], ['beta', 'ok']]);
  const expected = [['2 machines ok', 'success'], ['alpha strained', 'warning'], ['alpha strained', 'warning'], ['alpha critical', 'danger'], ['alpha critical', 'danger'], ['2 machines ok', 'success'], ['2 machines ok', 'success']];
  for (const [index, item] of FIXTURE.scripts.climb.entries()) {
    await board.reading('m-alpha', item.cpu, item.mem);
    await within(`reading ${index + 1}`, () => [board.statusText(), board.status()?.tone]).toEqual(expected[index]);
  }
  expect(board.table()?.rows[0]).toEqual(['alpha', 'ok', '20%', '30%', 'now']);
  await board.preview.stop();
});

test('monitor preview: notices follow the rules, replace one row per machine, remind after the interval and withdraw on recovery', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first status', () => board.statusText()).toBe('2 machines ok');
  const [calm, first, second, critical, still, falling, recovered] = FIXTURE.scripts.climb;
  await board.reading('m-alpha', calm.cpu, calm.mem);
  await board.reading('m-alpha', first.cpu, first.mem);
  // One strained reading is not enough.
  await within('the first strained reading', () => board.statusText()).toBe('alpha strained');
  expect(board.texts()).toEqual([]);
  await board.reading('m-alpha', second.cpu, second.mem);
  await within('the strained notice', () => board.texts()).toEqual(['alpha is strained: CPU 80%, memory 40%']);
  // Critical at once, in the same row.
  await board.reading('m-alpha', critical.cpu, critical.mem);
  await within('the critical notice replaces it', () => board.texts()).toEqual(['alpha is critical: CPU 95%, memory 45%']);
  await board.reading('m-alpha', still.cpu, still.mem);
  expect(board.texts()).toEqual(['alpha is critical: CPU 95%, memory 45%']);
  // A reminder only after the configured interval (10 minutes by default).
  board.time.clock += 11 * 60000;
  await board.reading('m-alpha', 97, 45);
  await within('the reminder', () => board.texts()).toEqual(['alpha is still critical: CPU 97%, memory 45%']);
  await board.reading('m-alpha', falling.cpu, falling.mem);
  await board.reading('m-alpha', recovered.cpu, recovered.mem);
  await within('the notice is withdrawn', () => board.texts()).toEqual([]);
  expect(board.held()).toMatchObject({ sent: 3, capped: 0 });
  await board.preview.stop();
});

test('monitor preview: the hourly cap holds back notices and the host merges past six sends a minute', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first status', () => board.statusText()).toBe('2 machines ok');
  // Default cap 4 an hour: the fifth critical in the hour raises nothing and is counted.
  for (let cycle = 0; cycle < 5; cycle += 1) { await board.reading('m-alpha', 95, 40); await board.reading('m-alpha', 20, 30); }
  await within('the cap', () => board.held()).toMatchObject({ sent: 4, capped: 1 });
  expect(board.texts()).toEqual([]);
  await board.preview.stop();
  // A high cap leaves the host's own R2 rule: the sends past six in a minute merge into one notice of the package.
  const merged = await boot();
  await merged.preview.start();
  await within('the first status', () => merged.statusText()).toBe('2 machines ok');
  await merged.save({ cap: '60' });
  for (let cycle = 0; cycle < 8; cycle += 1) { await merged.reading('m-alpha', 95, 40); await merged.reading('m-alpha', 20, 30); }
  await within('the merged notice', () => merged.texts().some(text => /more notices? from Machine monitor/.test(text))).toBe(true);
  expect(merged.texts().length).toBeLessThanOrEqual(2);
  await merged.preview.stop();
});

test('monitor preview: muting stops the notices and the status item keeps following; a test alert always raises one', async () => {
  const board = await boot();
  await board.preview.start();
  await within('the first status', () => board.statusText()).toBe('2 machines ok');
  await board.save({ alerts: false });
  await board.reading('m-alpha', 96, 40);
  await within('the critical status', () => board.statusText()).toBe('alpha critical');
  expect(board.texts()).toEqual([]);
  expect(await board.act(() => board.preview.invoke(TEST))).toEqual({ sent: true, tests: 1 });
  await within('the test alert', () => board.texts()).toEqual(['Test alert from Machines']);
  await board.preview.stop();
});

test('monitor preview: a changed threshold changes the level without a restart', async () => {
  const board = await boot();
  await board.preview.start();
  await board.reading('m-alpha', 60, 30);
  await within('below the default threshold', () => board.statusText()).toBe('2 machines ok');
  const starts = board.preview.starts;
  await board.save({ 'cpu-strained': '50', 'cpu-critical': '55' });
  await within('the new level', () => board.statusText()).toBe('alpha critical');
  expect(board.preview.starts).toBe(starts);
  // Out-of-range or non-numeric values fall back to the defaults.
  await board.save({ 'cpu-strained': 'lots', 'cpu-critical': '0' });
  await within('the defaults', () => board.statusText()).toBe('2 machines ok');
  await board.preview.stop();
});

test('monitor preview: a machine that stops answering keeps its last readings, is noticed once when memory was high, and returns', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  const panel = attach(board);
  await within('the first snapshot', () => panel.snapshot()?.meta.machines.length).toBe(2);
  panel.show(true);
  const [high] = FIXTURE.scripts['memory-high'];
  await board.reading('m-beta', high.cpu, high.mem);
  await board.act(() => board.core.control('machine', { id: 'm-beta', online: false }));
  await within('the offline status', () => board.statusText()).toBe('1 machine ok · 1 offline');
  await within('the stopped-answering notice', () => board.texts()).toEqual(['beta stopped answering (memory was 85%)']);
  const row = board.table()?.rows.find(item => item[0] === 'beta');
  expect(row?.[1]).toBe('offline');
  expect(row?.[2]).toBe('30%');
  expect(row?.[4]).toMatch(/^last seen \d\d:\d\d:\d\d UTC$/);
  await within('the panel knows', () => panel.messages().filter(item => item.kind === 'fleet.samples').at(-1)?.machines.find((item: Out) => item.id === 'm-beta')?.online).toBe(false);
  // The same fact is not raised twice, and a machine that was never high raises nothing.
  await board.act(() => board.core.control('machine', { id: 'm-beta', online: false }));
  await board.act(() => board.core.control('machine', { id: 'm-alpha', online: false }));
  await within('alpha offline', () => board.statusText()).toBe('No machines online · 2 offline');
  expect(board.texts()).toEqual(['beta stopped answering (memory was 85%)']);
  await board.act(() => board.core.control('machine', { id: 'm-beta', online: true }));
  await within('beta is back', () => board.texts()).toEqual([]);
  await board.preview.stop();
});

test('monitor preview: the daemon going away keeps the last readings honestly stale, and the recovery reads the history again', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  const panel = attach(board);
  panel.show(true);
  await board.run('m-alpha', FIXTURE.scripts.calm);
  await within('the readings', () => board.table()?.rows[0]?.[2]).toBe('30%');
  board.down();
  await within('the daemon offline status', () => board.statusText()).toBe('Daemon offline');
  expect(board.status()).toMatchObject({ tone: 'warning' });
  expect(board.status()?.tooltip).toContain('Last readings kept');
  // The table keeps the machines and says so; it is never an empty fleet.
  expect(board.table()?.rows).toHaveLength(2);
  expect(board.table()?.label).toMatch(/^Machines \(stale since \d\d:\d\d:\d\d UTC\)$/);
  expect(board.view()?.text).toMatch(/^Stale: the metrics daemon is offline/);
  expect(board.texts()).toEqual(['Metrics daemon offline']);
  await within('the panel is told it is stale', () => panel.messages().filter(item => item.kind === 'fleet.samples').at(-1)?.stale).toBe(true);
  // A refresh while it is still away changes nothing and raises no second notice.
  board.preview.publish({ kind: 'app.focus', focused: true });
  await settle();
  expect(board.texts()).toEqual(['Metrics daemon offline']);
  // The daemon answers: the history is read again, the stale marking and the notice go, the panel gets a fresh snapshot.
  const before = board.requests.filter(item => item.op === 'metrics.history').length;
  board.up();
  await within('the recovery', () => board.statusText()).toBe('2 machines ok');
  expect(board.requests.filter(item => item.op === 'metrics.history').length).toBeGreaterThan(before);
  expect(board.texts()).toEqual([]);
  expect(board.table()?.label).toBe('Machines');
  await within('the fresh snapshot', () => panel.snapshot()?.meta.stale).toBe(false);
  expect(panel.snapshot()!.histories.find(item => item.machine === 'm-alpha')!.points).toHaveLength(FIXTURE.scripts.calm.length);
  await board.preview.stop();
  // A daemon that was never read is unknown, never an empty fleet.
  const never = await boot({ offline: true });
  await never.preview.start();
  await within('unknown', () => never.statusText()).toBe('Daemon offline');
  expect(never.table()).toMatchObject({ kind: 'list', items: ['Unknown until the daemon answers'] });
  await never.preview.stop();
});

// ---- visibility, rate and the panel channel ---------------------------------------------------------------------------------

test('monitor preview: the daemon is asked fast while a panel is visible and slowly otherwise, within one change of the visibility', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  expect(board.intervals().at(-1)).toBe(60000);
  const panel = attach(board);
  panel.show(true);
  await within('fast while visible', () => board.intervals().at(-1)).toBe(5000);
  panel.show(false);
  await within('slow while hidden', () => board.intervals().at(-1)).toBe(60000);
  panel.show(true);
  await within('fast again', () => board.intervals().at(-1)).toBe(5000);
  // Two panels: slow only when neither is visible.
  const other = attach(board, 'extension-view-b');
  other.show(true);
  panel.show(false);
  await settle();
  expect(board.intervals().at(-1)).toBe(5000);
  other.show(false);
  await within('slow with both hidden', () => board.intervals().at(-1)).toBe(60000);
  // The settings change the intervals at once.
  panel.show(true);
  await within('fast', () => board.intervals().at(-1)).toBe(5000);
  await board.save({ fast: '2', slow: '30' });
  await within('the new fast interval', () => board.intervals().at(-1)).toBe(2000);
  expect(board.held()).toMatchObject({ paceMs: 2000 });
  await board.preview.stop();
});

test('monitor preview: a panel gets a snapshot when it opens, at most one push a second, and nothing while hidden', async () => {
  const board = await boot({ panels: true });
  await board.preview.start();
  await board.run('m-alpha', FIXTURE.scripts.calm);
  const panel = attach(board);
  panel.show(true);
  await within('the snapshot', () => panel.snapshot()?.histories.length).toBe(2);
  const snapshot = panel.snapshot()!;
  expect(snapshot.meta).toMatchObject({ stale: false, windowMs: 1800000, thresholds: { cpuStrained: 70, cpuCritical: 90, memStrained: 75, memCritical: 90 } });
  expect(snapshot.histories.find(item => item.machine === 'm-alpha')!.points.map((point: number[]) => [point[1], point[2]])).toEqual(FIXTURE.scripts.calm.map(item => [item.cpu, item.mem]));
  // Five readings inside one second: at most one push goes out at once, the rest arrive together afterwards.
  const pushed = () => panel.kinds('fleet.samples').length;
  const base = pushed();
  board.core.control('metrics/script', { machine: 'm-alpha', samples: [1, 2, 3, 4, 5].map(cpu => ({ cpu, mem: 10 })) });
  for (let index = 0; index < 5; index += 1) { board.time.clock += 10; board.core.sample('m-alpha'); }
  await settle();
  expect(pushed() - base).toBeLessThanOrEqual(1);
  await within('the trailing push', () => panel.kinds('fleet.samples').slice(base).flatMap(item => item.samples).length, 2500).toBe(5);
  expect(pushed() - base).toBeLessThanOrEqual(2);
  // Hidden: nothing is pushed, the service keeps the truth, and showing the panel again brings a snapshot with it.
  panel.show(false);
  await settle();
  const quiet = panel.messages().length;
  await board.reading('m-alpha', 44, 33);
  await settle();
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(panel.messages().length).toBe(quiet);
  panel.show(true);
  await within('the snapshot on show', () => panel.snapshot()?.histories.find(item => item.machine === 'm-alpha')?.points.at(-1)?.[1]).toBe(44);
  // A reload of the panel (a snapshot request) redraws the same 30 minutes from the service's memory.
  await panel.send({ kind: 'snapshot' });
  await within('the requested snapshot', () => panel.kinds('fleet.begin').length).toBeGreaterThanOrEqual(3);
  expect(panel.snapshot()!.histories.find(item => item.machine === 'm-alpha')!.points.length).toBeGreaterThanOrEqual(6);
  // Garbage from the page changes nothing.
  for (const message of [7, 'x', { kind: 'unknown' }, { kind: 'snapshot', extra: true }]) await panel.send(message);
  expect(board.preview.state).toBe('running');
  await board.preview.stop();
});

test('monitor preview: disable, safe mode and losing the service grant leave no panel, no item, no notice, no listener and no request', async () => {
  for (const [act, reason] of [
    [(board: Board) => board.preview.setEnabled(false), 'disable'],
    [(board: Board) => board.preview.setSafeMode(true), 'safeMode'],
    [(board: Board) => board.preview.revoke('runtime.service'), 'trust'],
  ] as const) {
    const board = await boot({ panels: true });
    await board.preview.start();
    const panel = attach(board);
    panel.show(true);
    await board.reading('m-alpha', 95, 40);
    await within('a notice and a status', () => [board.texts().length, board.statusText()]).toEqual([1, 'alpha critical']);
    await act(board);
    expect([board.preview.state, board.preview.stopReason]).toEqual(['stopped', reason]);
    expect(board.owner()).toBeUndefined();
    expect(board.texts()).toEqual([]);
    expect(board.hooks.down.size + board.hooks.up.size).toBe(0);
    expect(await board.preview.panelViews().instances(VIEW).catch(() => [])).toEqual([]);
    // Nothing the daemon does reaches a stopped service: no request, no notice, no push.
    const requests = board.requests.length, received = panel.received.length;
    await board.reading('m-alpha', 99, 99);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect([board.requests.length, panel.received.length, board.texts()]).toEqual([requests, received, []]);
  }
  // Safe mode starts nothing at all.
  const safe = await boot({ safeMode: true });
  expect(await safe.preview.start()).toEqual({ ok: false, code: 'HostUnavailable' });
  expect(safe.owner()).toBeUndefined();
  // Losing ui.notify keeps the service and the status item; the refusal is recorded. Losing ui.richViews keeps the host-rendered fleet.
  const board = await boot({ panels: true });
  await board.preview.start();
  attach(board).show(true);
  await board.preview.revoke('ui.notify');
  await board.reading('m-alpha', 95, 40);
  await within('the status follows', () => board.statusText()).toBe('alpha critical');
  await within('the refusal', () => board.held()?.refused).toContain('PermissionDenied');
  expect(board.texts()).toEqual([]);
  await board.preview.revoke('ui.richViews');
  await board.reading('m-alpha', 20, 30);
  await within('the host-rendered fleet follows', () => board.statusText()).toBe('2 machines ok');
  expect(board.preview.state).toBe('running');
  await board.preview.stop();
});

// ---- the panel's own files ---------------------------------------------------------------------------------------------------

test('monitor preview: the chart module plots exactly the samples it is given, with the average and the peak', async () => {
  const source = read('examples/extensions/monitor/package/panel/chart.js');
  const chart = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as typeof import('../examples/extensions/monitor/package/panel/chart.js');
  const points = FIXTURE.scripts.calm.map((item, index) => [index * 60000, item.cpu, item.mem]);
  const cpu = chart.series(points, 1);
  expect(cpu.map(item => item.v)).toEqual([20, 25, 30]);
  expect(chart.stats(cpu)).toEqual({ count: 3, avg: 25, peak: 30 });
  expect(chart.stats([])).toEqual({ count: 0, avg: null, peak: null });
  // Newest at the right edge, 0 at the bottom and 100 at the top, nothing outside the window.
  const plotted = chart.plot(cpu, { width: 300, height: 100, end: 120000, pad: 0 });
  expect(plotted.map(item => item.v)).toEqual([20, 25, 30]);
  expect(plotted[2].x).toBeCloseTo(300, 5);
  expect(plotted[2].y).toBeCloseTo(70, 5);
  expect(plotted[2].x).toBeGreaterThan(plotted[1].x);
  expect(plotted[2].y).toBeLessThan(plotted[0].y);
  expect(chart.series([[0, 1, 1], [chart.WINDOW_MS + 1, 50, 50]], 1).map(item => item.v)).toEqual([50]);
});

const FILES: Record<string, [string, string]> = {
  '/index.html': ['examples/extensions/monitor/package/panel/index.html', 'text/html'],
  '/app.js': ['examples/extensions/monitor/package/panel/app.js', 'text/javascript'],
  '/chart.js': ['examples/extensions/monitor/package/panel/chart.js', 'text/javascript'],
  '/style.css': ['examples/extensions/monitor/package/panel/style.css', 'text/css'],
};
// A `pandaView` stand-in: what the host client would define. The page's own script is the shipped one.
const STUB = `(() => {
  const handlers = { message: [], visibility: [] };
  window.__posted = []; window.__state = null;
  window.pandaView = {
    viewId: 'sample.monitor/fleet', instanceId: 'i1', baseUrl: '',
    state: { set(value) { window.__state = value; } },
    onDidInitialize(handler) { handler({ instanceId: 'i1', placement: 'inspector', restored: false, state: window.__initState ?? null }); },
    onDidChangeVisibility(handler) { handlers.visibility.push(handler); },
    onMessage(handler) { handlers.message.push(handler); },
    async postMessage(message) { window.__posted.push(message); return null; },
    releaseFocus() {},
  };
  window.__emit = message => handlers.message.forEach(handler => handler(message));
})();`;

test('monitor preview: the panel draws cards, sparklines and the detail charts from what the service sends, and keeps the last readings when stale', async ({ page }, testInfo) => {
  await page.route('http://monitor.test/**', route => {
    const entry = FILES[new URL(route.request().url()).pathname];
    if (!entry) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: entry[1], body: read(entry[0]) });
  });
  await page.addInitScript(STUB);
  await page.goto('http://monitor.test/index.html');
  const machines = [
    { id: 'm-alpha', name: 'alpha', level: 'ok', online: true, cpu: 30, mem: 31, lastSeen: 120000 },
    { id: 'm-beta', name: 'beta', level: 'critical', online: true, cpu: 95, mem: 40, lastSeen: 120000 },
  ];
  const calm = FIXTURE.scripts.calm.map((item, index) => [index * 60000, item.cpu, item.mem]);
  await page.evaluate(([list, points]) => {
    const emit = (window as unknown as { __emit(message: unknown): void }).__emit;
    emit({ kind: 'fleet.begin', seq: 1, machines: list, stale: false, since: null, status: 'beta critical', intervalMs: 5000, thresholds: {}, windowMs: 1800000 });
    emit({ kind: 'fleet.history', seq: 1, machine: 'm-alpha', points });
    emit({ kind: 'fleet.history', seq: 1, machine: 'm-beta', points: [[0, 90, 40], [60000, 95, 40]] });
  }, [machines, calm] as const);
  const cards = page.locator('#cards .card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toHaveAttribute('data-level', 'critical');
  await expect(page.locator('#summary')).toHaveText('beta critical');
  // Each pushed sample extends the sparkline without a reload.
  await page.evaluate(() => (window as unknown as { __emit(message: unknown): void }).__emit({ kind: 'fleet.samples', samples: [{ machine: 'm-alpha', t: 180000, cpu: 35, mem: 31 }], machines: [{ id: 'm-alpha', name: 'alpha', level: 'ok', online: true, cpu: 35, mem: 31, lastSeen: 180000 }, { id: 'm-beta', name: 'beta', level: 'critical', online: true, cpu: 95, mem: 40, lastSeen: 120000 }], stale: false, since: null, status: 'beta critical' }));
  await expect(cards.first()).toHaveAttribute('data-points', '4');
  // Selecting a machine draws its two charts from exactly the points the service sent; the average and the peak match.
  await cards.first().click();
  await expect(page.locator('#detail-title')).toHaveText('alpha');
  await expect(page.locator('#cpu-stats')).toHaveText('average 28%, peak 35%');
  const drawn = await page.evaluate(() => (window as unknown as { __monitor: { charts: { machine: string; field: string; given: number[][] }[] } }).__monitor.charts.filter(item => item.machine === 'm-alpha').slice(-2));
  expect(drawn.map(item => item.field)).toEqual(['cpu', 'mem']);
  expect(drawn[0].given.map(item => item[1])).toEqual([20, 25, 30, 35]);
  expect(await page.evaluate(() => (window as unknown as { __state: unknown }).__state)).toEqual({ selected: 'm-alpha' });
  // Stale: the last readings stay, with a banner.
  await page.evaluate(() => (window as unknown as { __emit(message: unknown): void }).__emit({ kind: 'fleet.samples', samples: [], machines: [], stale: true, since: '12:00:00 UTC', status: 'Daemon offline' }));
  await expect(page.locator('#banner')).toContainText('stale since 12:00:00 UTC');
  await expect(cards).toHaveCount(2);
  // The reload button asks the service; the panel itself reads nothing.
  await page.locator('#reload').click();
  expect(await page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted)).toEqual([{ kind: 'snapshot' }]);
  await testInfo.attach('monitor-panel', { body: await page.screenshot(), contentType: 'image/png' });
});
