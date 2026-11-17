import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import {
  HARNESSES, Throttle, accountRow, limitRow, metricsItem, query, record, refreshLimits,
  type Gate, type Json, type LedgerRow, type Reading, type World,
} from '../src/extensions/runtime-usage-resources';

// Preview column of R0204 (usage, limits, accounts and metrics). These checks run the deterministic model in
// src/extensions/runtime-usage-resources.ts, which mirrors src-tauri/src/extensions/runtime_usage_resources.rs.
// The real installed process (the fixture service under the pinned runtime) is the native test
// `runtime_usage_resources::tests::installed::*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-usage-resources/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-usage-resources/main.cjs');
const A = 'sample.usage-resources';
const B = 'sample.other';

const reading = (status = 'ready'): Reading => ({
  status, stale: false, checkedAt: 1234, email: 'person@example.test', plan: 'Max', message: 'token=abc', dashboardUrl: 'https://example.test/secret',
  windows: [{ label: '5 hour window', usedPercent: 42.5, resetsAt: '2026-11-17T00:00:00Z' }, { label: 'Weekly', usedPercent: 10 }, { label: 'Weekly', usedPercent: 11 }],
});
function world(overrides: Partial<World> = {}): World {
  return {
    tasks: [{ id: 'a1', projectId: 'A' }, { id: 'b1', projectId: 'B' }], ledger: [], readings: {}, connectionReadings: {}, connections: [],
    app: { coreRssBytes: 100, activeAgents: 2, activeTerminals: 1, databaseBytes: 4096 }, services: [], ...overrides,
  };
}
/** A gate over a mutable table of grants: permission -> projects (`'*'` for every project), per package. */
function grants(table: Record<string, Record<string, string[] | '*'>> = {}): { gate: Gate; table: typeof table } {
  const gate: Gate = (owner, version, permission, project) => {
    if (version !== '1.0.0') return false;
    const scope = table[owner]?.[permission];
    return scope !== undefined && (project === null || scope === '*' || scope.includes(project));
  };
  return { gate, table };
}

test('extensions usage resources: the fixture package declares the four reads and a service', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const permission of ['runtime.service', 'tasks.usage.read', 'harnesses.limits.read', 'harnesses.accounts.read', 'metrics.read']) expect(manifest.permissions, permission).toContain(permission);
  expect(fixtureSource).toContain('panda.context.query');
  expect(fixtureSource).toContain('panda.harnesses.refreshLimits');
});

test('extensions usage resources: the last report of each turn is kept and counted', () => {
  const ledger: LedgerRow[] = [];
  record(ledger, 'a1', 1, { usedTokens: 1000, contextWindow: 200_000 }, 10);
  record(ledger, 'a1', 1, { usedTokens: 1500, contextWindow: 200_000 }, 20);
  record(ledger, 'a1', 2, { usedTokens: 4000 }, 30);
  const { gate } = grants({ [A]: { 'tasks.usage.read': ['A'] } });
  const page = query(gate, world({ ledger: [...ledger] }), A, '1.0.0', { resource: 'usage', taskId: 'a1' }) as { items: Record<string, unknown>[] };
  expect(page.items).toEqual([
    { taskId: 'a1', turn: 1, usedTokens: 1500, contextWindow: 200_000, reports: 2, at: 20 },
    { taskId: 'a1', turn: 2, usedTokens: 4000, reports: 1, at: 30 },
  ]);
  // Nothing is invented: no input, no output and no window the provider did not report.
  expect(page.items.every(item => !('input' in item) && !('output' in item))).toBe(true);
  expect('contextWindow' in page.items[1]).toBe(false);
});

test('extensions usage resources: usage needs its grant for the project of the task and revocation wins', () => {
  const ledger: LedgerRow[] = [];
  record(ledger, 'a1', 1, { usedTokens: 10 }, 1); record(ledger, 'b1', 1, { usedTokens: 20 }, 1);
  const { gate, table } = grants();
  const ask = (owner: string, params: unknown, version = '1.0.0') => query(gate, world({ ledger }), owner, version, params);
  const params = { resource: 'usage', taskId: 'a1' };
  for (const taskId of ['a1', 'ghost']) expect(ask(A, { resource: 'usage', taskId })).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'harnesses.limits.read': '*', 'harnesses.accounts.read': '*', 'metrics.read': '*' };
  expect(ask(A, params)).toEqual({ code: 'PermissionDenied' });
  table[A]['tasks.usage.read'] = ['A'];
  expect((ask(A, params) as { items: { usedTokens: number }[] }).items[0].usedTokens).toBe(10);
  expect(ask(A, { resource: 'usage', taskId: 'b1' })).toEqual({ code: 'PermissionDenied' });
  expect(ask(A, { resource: 'usage', taskId: 'ghost' })).toEqual({ code: 'NotFound' });
  expect(ask(B, params)).toEqual({ code: 'PermissionDenied' });
  expect(ask(A, params, '0.9.0')).toEqual({ code: 'PermissionDenied' });
  delete table[A]['tasks.usage.read'];
  expect(ask(A, params)).toEqual({ code: 'PermissionDenied' });
});

test('extensions usage resources: limits, accounts and metrics each need their own grant', () => {
  const { gate, table } = grants();
  const w = world({ readings: { claude: reading() } });
  const ask = (resource: string) => query(gate, w, A, '1.0.0', { resource });
  for (const resource of ['limits', 'accounts', 'metrics']) expect(ask(resource), resource).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'harnesses.limits.read': '*' };
  expect(ask('limits')).toMatchObject({ state: 'Ready' });
  expect(ask('accounts')).toEqual({ code: 'PermissionDenied' });
  expect(ask('metrics')).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'harnesses.limits.read': '*', 'harnesses.accounts.read': '*', 'metrics.read': '*' };
  expect(ask('metrics')).toMatchObject({ state: 'Ready' });
  delete table[A]['metrics.read'];
  expect(ask('metrics')).toEqual({ code: 'PermissionDenied' });
});

test('extensions usage resources: selectors and pages are validated before anything is read', () => {
  const { gate } = grants({ [A]: { 'tasks.usage.read': '*', 'harnesses.limits.read': '*', 'harnesses.accounts.read': '*', 'metrics.read': '*' } });
  const cases: [unknown, string][] = [
    [{ resource: 'usage' }, 'InvalidShape'], [{ resource: 'usage', taskId: 'a1', harness: 'claude' }, 'InvalidShape'],
    [{ resource: 'limits', taskId: 'a1' }, 'InvalidShape'], [{ resource: 'accounts', taskId: 'a1' }, 'InvalidShape'],
    [{ resource: 'metrics', harness: 'claude' }, 'InvalidShape'], [{ resource: 'metrics', taskId: 'a1' }, 'InvalidShape'],
    [{ resource: 'limits', harness: 7 }, 'InvalidShape'], [{ resource: 'limits', extra: 1 }, 'InvalidShape'],
    [{ resource: 'transcript', taskId: 'a1' }, 'UnsupportedCapability'], [{ resource: 'limits', limit: 51 }, 'LimitExceeded'],
    [{ resource: 'limits', limit: 0 }, 'LimitExceeded'], [{ resource: 'limits', harness: 'not-a-harness' }, 'NotFound'],
  ];
  for (const [params, code] of cases) expect(query(gate, world(), A, '1.0.0', params), JSON.stringify(params)).toEqual({ code });
});

test('extensions usage resources: limits serve the windows of a reading and never its account', () => {
  const { gate } = grants({ [A]: { 'harnesses.limits.read': '*' } });
  const page = query(gate, world({ readings: { claude: reading() } }), A, '1.0.0', { resource: 'limits', harness: 'claude' }) as { items: { windows: { id: string }[] }[] };
  expect(page.items[0]).toMatchObject({ harness: 'claude', account: 'default', status: 'ready', readAt: 1234 });
  expect(page.items[0].windows[0]).toEqual({ id: '5-hour-window', label: '5 hour window', usedPercent: 42.5, resetsAt: '2026-11-17T00:00:00Z' });
  expect(page.items[0].windows.map(window => window.id).slice(1)).toEqual(['weekly', 'weekly-2']);
  const text = JSON.stringify(page);
  for (const hidden of ['person@example.test', 'Max', 'token=abc', 'secret']) expect(text).not.toContain(hidden);
  // A harness nobody has read has no row, not an invented empty one.
  expect((query(gate, world({ readings: { claude: reading() } }), A, '1.0.0', { resource: 'limits', harness: 'codex' }) as { items: Json[] }).items).toEqual([]);
});

test('extensions usage resources: accounts name each account and carry no credential value', () => {
  const connections = [{ id: 'conn-1', harness: 'claude', name: 'Work', revision: 3, env: { SECRET_ENV: 'SECRET_VALUE' }, secretEnv: ['SECRET_AUTH'], configDir: 'SECRET_DIR' }];
  const rows = [
    accountRow('claude', 'default', true, undefined, reading()), accountRow('claude', 'conn-1', false, 'Work', undefined),
    accountRow('codex', 'default', true, undefined, reading('signedOut')), accountRow('grok', 'default', true, undefined, reading('error')),
  ];
  expect(rows[0]).toEqual({ harness: 'claude', id: 'default', active: true, signedIn: true, status: 'ready', label: 'person@example.test', plan: 'Max' });
  expect(rows[1]).toEqual({ harness: 'claude', id: 'conn-1', active: false, signedIn: null, status: 'unchecked', label: 'Work' });
  expect(rows[2].signedIn).toBe(false);
  expect((rows[3] as { signedIn: unknown }).signedIn).toBeNull();
  const { gate } = grants({ [A]: { 'harnesses.accounts.read': '*' } });
  const page = query(gate, world({ connections, connectionReadings: {} }), A, '1.0.0', { resource: 'accounts', harness: 'claude' });
  expect(JSON.stringify(page)).not.toContain('SECRET');
  expect((page as { items: { id: string }[] }).items.map(item => item.id)).toEqual(['default', 'conn-1']);
  expect(JSON.stringify(limitRow('claude', 'default', reading()))).not.toContain('secret');
  // Every built-in harness has its own default row.
  const all = query(gate, world(), A, '1.0.0', { resource: 'accounts', limit: 50 }) as { items: unknown[] };
  expect(all.items.length).toBe(HARNESSES.length);
});

test('extensions usage resources: metrics report what is measured and name what is not', () => {
  const item = metricsItem({ coreRssBytes: 10, activeAgents: 2, databaseBytes: 0 }, [
    { id: 'sample.measured', state: 'running', residentBytes: 5000 }, { id: 'sample.fresh', state: 'running' }, { id: 'sample.stopped', state: 'stopped' },
  ]);
  expect(item).toEqual({
    app: { coreRssBytes: 10, activeAgents: 2, databaseBytes: 0 },
    services: [{ package: 'sample.measured', rssBytes: 5000 }, { package: 'sample.fresh' }],
    unmeasured: ['tasks', 'app.activeTerminals', 'services.sample.fresh'],
  });
  expect('tasks' in (item as object)).toBe(false);
  expect((metricsItem({}, []) as { app: object }).app).toEqual({});
});

test('extensions usage resources: refresh is admitted once per harness per 60 seconds', () => {
  const { gate, table } = grants();
  const w = world({ readings: { claude: reading(), codex: reading() } });
  const throttle = new Throttle();
  const ask = (params: unknown, now: number) => refreshLimits(gate, w, throttle, A, '1.0.0', params, now);
  expect(ask({ harness: 'claude' }, 1000)).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'harnesses.limits.read': '*' };
  expect(ask({ harness: 'claude' }, 1000)).toEqual({ harnesses: ['claude'] });
  expect(ask({ harness: 'claude' }, 60_999)).toEqual({ code: 'LimitExceeded' });
  expect(ask({ harness: 'claude' }, 61_000)).toEqual({ harnesses: ['claude'] });
  // A refusal does not move the window.
  expect(ask({ harness: 'claude' }, 120_999)).toEqual({ code: 'LimitExceeded' });
  expect(ask({ harness: 'claude' }, 121_000)).toEqual({ harnesses: ['claude'] });
  // Without a harness: the cached ones, the admitted subset; none admitted is LimitExceeded.
  expect(ask(undefined, 121_001)).toEqual({ harnesses: ['codex'] });
  expect(ask({}, 121_002)).toEqual({ code: 'LimitExceeded' });
  expect(ask({ harness: 'nope' }, 200_000)).toEqual({ code: 'NotFound' });
  for (const bad of [{ harness: 3 }, { harness: '' }, { harness: 'claude', force: true }, 'claude']) expect(ask(bad, 200_000), JSON.stringify(bad)).toEqual({ code: 'InvalidArguments' });
  // Revocation is refused on the very next call.
  delete table[A]['harnesses.limits.read'];
  expect(ask({ harness: 'kimi' }, 300_000)).toEqual({ code: 'PermissionDenied' });
});
