import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { MAX_LIVE, MAX_PER_WINDOW, MERGED_KEY, Notices, WINDOW_MS, noOsChannel, planRows, rowId, rowSignature, rowView, serve, type Checks, type NoticeRow, type Os, type OsChannel, type RowPlan } from '../src/extensions/runtime-notifications';

// Preview column of R0207 (replaceable, attributed notifications). These checks run the deterministic model in
// src/extensions/runtime-notifications.ts, which mirrors src-tauri/src/extensions/runtime_notifications.rs (whose own
// unit tests are `runtime_notifications::tests`). The installed service under the pinned runtime is the native test
// `runtime_service_lifetime::tests::installed::notifications_*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-notifications/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-notifications/main.cjs');
const OWNER = 'sample.runtime-notifications';
const NAME = 'Runtime notices';

/** An OS channel that delivers and remembers what it was asked; the app's own answers `unavailable`. */
function delivering() {
  const log: string[] = [];
  const channel: OsChannel = { show: (owner, notice: NoticeRow): Os => { log.push(`show ${owner} ${notice.key} ${notice.package}`); return 'delivered'; }, withdraw: (owner, key): Os => { log.push(`withdraw ${owner} ${key}`); return 'delivered'; } };
  return { log, channel };
}
const checks = (nowMs = 1, granted = true): Checks => ({ granted, package: NAME, nowMs });
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;
const keys = (notices: Notices) => notices.snapshot().notices.map(notice => notice.key);
/** What the list shows after applying a plan: the model the in-app list draws from. */
function drawn(notices: Notices, shown: Map<string, string>): RowPlan {
  const plan = planRows(shown, notices.snapshot());
  for (const id of plan.remove) shown.delete(id);
  for (const view of [...plan.add, ...plan.update]) shown.set(view.id, rowSignature(view));
  return plan;
}

test('extensions runtime notifications: the fixture package declares the permission and a service and uses both calls', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', 'ui.notify']));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.ui.notify', 'panda.ui.withdraw', "key: 'build'", 'burst']) expect(fixtureSource, call).toContain(call);
});

test('extensions runtime notifications: a notice names its package, and the same key replaces it on both surfaces', () => {
  const { log, channel } = delivering();
  const notices = new Notices(channel), shown = new Map<string, string>();
  expect(notices.notify(OWNER, checks(1), { key: 'build', title: 'Builds', text: '3 builds failed', tone: 'danger' })).toEqual({ ok: true, value: { key: 'build', replaced: false, merged: false, os: 'delivered' } });
  expect(drawn(notices, shown).add.map(view => [view.label, view.heading, view.text, view.tone])).toEqual([[NAME, 'Builds', '3 builds failed', 'danger']]);
  // The same key again: one notice, updated in its own row; nothing is added or removed.
  expect(notices.notify(OWNER, checks(2), { key: 'build', title: 'Builds', text: '4 builds failed', tone: 'danger' })).toMatchObject({ ok: true, value: { replaced: true } });
  const plan = drawn(notices, shown);
  expect([plan.add.length, plan.remove.length, plan.update.map(view => view.text)]).toEqual([0, 0, ['4 builds failed']]);
  expect(notices.count(OWNER)).toBe(1);
  expect(notices.recorder().map(entry => [entry.op, entry.text, entry.package, entry.os])).toEqual([['show', '3 builds failed', NAME, 'delivered'], ['replace', '4 builds failed', NAME, 'delivered']]);
  expect(log.every(line => line.includes(NAME))).toBe(true);
  // Withdraw removes it from the native recorder and the list; a second withdraw is NotFound.
  expect(notices.withdraw(OWNER, checks(3), 'build')).toEqual({ ok: true, value: null });
  expect(drawn(notices, shown).remove).toEqual([rowId({ owner: OWNER, key: 'build' })]);
  expect(shown.size).toBe(0);
  expect(notices.recorder().at(-1)).toMatchObject({ op: 'withdraw', key: 'build', os: 'delivered' });
  expect(code(notices.withdraw(OWNER, checks(3), 'build'))).toBe('NotFound');
  // Nothing changed: nothing to draw.
  expect(drawn(notices, shown)).toEqual({ add: [], update: [], remove: [] });
});

test('extensions runtime notifications: the service request frame answers the broker envelope', () => {
  const notices = new Notices();
  expect(serve(notices, OWNER, checks(), { op: 'notify', notice: { key: 'a', text: 'x' } })).toEqual({ ok: true, value: { key: 'a', replaced: false, merged: false, os: 'unavailable' } });
  expect(serve(notices, OWNER, checks(), { op: 'withdraw', key: 'a' })).toEqual({ ok: true, value: null });
  expect(code(serve(notices, OWNER, checks(), { op: 'explode' }))).toBe('InvalidShape');
  expect(code(serve(notices, OWNER, checks(), 'text'))).toBe('InvalidShape');
});

test('extensions runtime notifications: six a minute, then they merge, and the window slides', () => {
  const notices = new Notices(delivering().channel), shown = new Map<string, string>();
  for (let index = 0; index < MAX_PER_WINDOW; index += 1) expect(code(notices.notify(OWNER, checks(1000 + index), { key: `k${index}`, text: 'x' }))).toBe('ok');
  expect(notices.count(OWNER)).toBe(6);
  const seventh = notices.notify(OWNER, checks(2000), { key: 'k6', text: 'x' }), eighth = notices.notify(OWNER, checks(3000), { key: 'k0', text: 'y' });
  expect([seventh, eighth].map(reply => reply.ok && reply.value.merged)).toEqual([true, true]);
  // One merged notice of the package counts the rest; no other notice was created or replaced.
  const merged = notices.snapshot().notices.find(notice => notice.merged)!;
  expect([merged.count, merged.text, merged.key, merged.package]).toEqual([2, `2 more notices from ${NAME}`, MERGED_KEY, NAME]);
  expect(notices.snapshot().notices.find(notice => notice.key === 'k0')!.text).toBe('x');
  expect(notices.count(OWNER)).toBe(7);
  expect(drawn(notices, shown).add).toHaveLength(7);
  // The merged row updates in place as it counts.
  notices.notify(OWNER, checks(4000), { key: 'k7', text: 'x' });
  expect(drawn(notices, shown)).toMatchObject({ add: [], remove: [], update: [{ merged: true, text: `3 more notices from ${NAME}` }] });
  // A minute later the window has room; another package has its own window.
  expect(notices.notify(OWNER, checks(1000 + WINDOW_MS + 10), { key: 'k9', text: 'z' })).toMatchObject({ ok: true, value: { merged: false } });
  expect(notices.notify('sample.other', checks(2000), { key: 'a', text: 'x' })).toMatchObject({ ok: true, value: { merged: false } });
  expect(notices.recorder().filter(entry => entry.op === 'merge').map(entry => entry.os)).toEqual(['delivered', 'delivered', 'delivered']);
});

test('extensions runtime notifications: the oldest notice goes past the live cap', () => {
  const notices = new Notices();
  for (let index = 0; index < MAX_LIVE + 8; index += 1) notices.notify(OWNER, checks(index * WINDOW_MS), { key: `n${index}`, text: 'x' });
  expect(notices.count(OWNER)).toBe(MAX_LIVE);
  expect(keys(notices)).not.toContain('n0');
  expect(notices.recorder().find(entry => entry.reason === 'evicted')).toMatchObject({ op: 'withdraw', key: 'n0' });
});

test('extensions runtime notifications: a revoked grant, a disabled package, safe mode and a stopped service clear both surfaces', () => {
  const notices = new Notices(delivering().channel), shown = new Map<string, string>();
  for (const [owner, key] of [[OWNER, 'a'], [OWNER, 'b'], ['sample.other', 'c']]) notices.notify(owner, checks(1), { key, text: 'x' });
  drawn(notices, shown);
  // The package loses `ui.notify`: only its notices go, each recorded with the reason.
  expect(notices.sweep(owner => owner !== OWNER, 'revoked-or-disabled')).toBe(true);
  expect(keys(notices)).toEqual(['c']);
  expect(notices.recorder().filter(entry => entry.op === 'withdraw').map(entry => [entry.key, entry.reason])).toEqual([['a', 'revoked-or-disabled'], ['b', 'revoked-or-disabled']]);
  expect(drawn(notices, shown).remove).toHaveLength(2);
  expect(notices.sweep(owner => owner !== OWNER, 'again')).toBe(false);
  // After the revoke the service can no longer raise or withdraw.
  expect([code(notices.notify(OWNER, checks(2, false), { key: 'a', text: 'x' })), code(notices.withdraw(OWNER, checks(2, false), 'c'))]).toEqual(['PermissionDenied', 'PermissionDenied']);
  // Safe mode and a stopped service clear the rest; repeating changes nothing.
  expect(notices.sweep(() => false, 'safe-mode')).toBe(true);
  expect(notices.clear('sample.other', 'service-stopped')).toBe(false);
  expect(notices.snapshot().notices).toEqual([]);
});

test('extensions runtime notifications: an unavailable OS path is reported, never pretended, and never blocks the notice', () => {
  const notices = new Notices(noOsChannel), shown = new Map<string, string>();
  expect(notices.notify(OWNER, checks(1), { key: 'a', text: 'x' })).toEqual({ ok: true, value: { key: 'a', replaced: false, merged: false, os: 'unavailable' } });
  expect(drawn(notices, shown).add).toHaveLength(1);
  expect(notices.snapshot().notices[0].os).toBe('unavailable');
  expect(notices.recorder()[0]).toMatchObject({ op: 'show', os: 'unavailable' });
  // Withdraw still removes the in-app row and says so.
  notices.withdraw(OWNER, checks(2), 'a');
  expect(notices.recorder().at(-1)).toMatchObject({ op: 'withdraw', os: 'unavailable' });
  expect(notices.count(OWNER)).toBe(0);
});

test('extensions runtime notifications: the user can dismiss one notice or the merged one', () => {
  const notices = new Notices(delivering().channel);
  for (let index = 0; index < 7; index += 1) notices.notify(OWNER, checks(10 + index), { key: `k${index}`, text: 'x' });
  expect([notices.dismiss(OWNER, 'k1'), notices.dismiss(OWNER, MERGED_KEY), notices.dismiss(OWNER, 'k1')]).toEqual([true, true, false]);
  expect(notices.count(OWNER)).toBe(5);
  expect(notices.recorder().filter(entry => entry.op === 'dismiss').map(entry => entry.key)).toEqual(['k1', MERGED_KEY]);
});

test('extensions runtime notifications: refusals keep their reasons (no grant, shapes, sizes)', () => {
  const notices = new Notices();
  // The grant itself is the permission; every other refusal is input validation or a size bound kept for predictability.
  expect(code(notices.notify(OWNER, checks(1, false), { key: 'a', text: 'x' }))).toBe('PermissionDenied');
  for (const [raw, expected] of [
    ['text', 'InvalidShape'], [{ text: 'x' }, 'InvalidShape'], [{ key: '', text: 'x' }, 'InvalidShape'], [{ key: 'a' }, 'InvalidShape'], [{ key: 'a', text: '  ' }, 'InvalidShape'],
    [{ key: 'a', text: 'x', tone: 'rainbow' }, 'InvalidShape'], [{ key: 'a', text: 'x', action: 'run' }, 'InvalidShape'], [{ key: 'a', text: 'x'.repeat(1025) }, 'LimitExceeded'], [{ key: 'a', text: 'x', title: 't'.repeat(121) }, 'LimitExceeded'],
  ] as const) expect(code(notices.notify(OWNER, checks(1), raw)), JSON.stringify(raw)).toBe(expected);
  expect(code(notices.withdraw(OWNER, checks(1), ''))).toBe('InvalidShape');
  expect(notices.count(OWNER)).toBe(0);
});

test('extensions runtime notifications: a row leads with the package, a long text has a bounded hover and only danger is marked', () => {
  const row: NoticeRow = { owner: OWNER, package: NAME, key: 'a', title: NAME, text: 'x'.repeat(900), tone: 'warning', merged: false, count: 1, os: 'unavailable', seq: 1 };
  const view = rowView(row);
  expect([view.label, view.heading, view.tone, view.hover.length]).toEqual([NAME, '', undefined, 500]);
  expect(rowView({ ...row, tone: 'danger', title: 'Builds' })).toMatchObject({ heading: 'Builds', tone: 'danger' });
});

test('extensions runtime notifications: the host wires the call, the request, the cleanup and the registrations', () => {
  const host = read('src-tauri/src/extensions/node-host.cjs');
  expect(host).toContain("rpc('notice'");
  expect(read('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain('runtime_notifications::serve_app');
  expect(read('src-tauri/src/extensions/runtime_grants.rs')).toContain('runtime_notifications::sweep_app');
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-notifications.spec.ts');
});
