import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import {
  PAGE_BYTES, TEXT_BYTES, cut, query, settingsGet, settingsRevision, toolKind,
  type Gate, type Message, type SettingsPackage, type Store, type Task,
} from '../src/extensions/runtime-content-resources';

// Preview column of R0203 (package settings and content resources). These checks run the deterministic model in
// src/extensions/runtime-content-resources.ts, which mirrors src-tauri/src/extensions/runtime_content_resources.rs.
// The real installed process (the fixture service under the pinned runtime) is the native test
// `runtime_content_resources::tests::installed::*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-content-resources/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-content-resources/main.cjs');
const A = 'sample.content-resources';
const B = 'sample.other';
const PAGE = `${A}/preferences`;

const task = (id: string, projectId: string, title = id): Task => ({ id, projectId, status: 'pending', title, harness: 'claude', model: 'opus', mode: 'ask', stage: 'pending' });
const message = (id: number, taskId: string, role: string, content: string): Message => ({ id, taskId, role, content, at: id });
function fixture(messages: Message[] = [], changes: Store['changes'] = []): Store {
  return { tasks: [task('a1', 'A', 'First'), task('a2', 'A', 'Second'), task('b1', 'B', 'Foreign')], messages, changes, revision: 1 };
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
const ids = (page: unknown) => ((page as { items: { id: string }[] }).items).map(item => item.id);

test('extensions content resources: the fixture package declares the reads, a service and its own settings page', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const permission of ['ui.contribute', 'runtime.service', 'events.workspace', 'tasks.summary', 'tasks.transcript.read', 'tasks.tools.read']) expect(manifest.permissions, permission).toContain(permission);
  expect(manifest.contributes.settings[0].id).toBe(PAGE);
  expect(fixtureSource).toContain('panda.settings.get');
  expect(fixtureSource).toContain("panda.events.on('settings.changed'");
  expect(fixtureSource).toContain('panda.context.query');
});

test('extensions content resources: a package reads its own settings revision and refreshes on settings.changed', () => {
  const page = { id: PAGE, fields: [{ id: 'label', kind: 'text' as const, value: 'Local report' }, { id: 'enabled', kind: 'switch' as const, value: true }, { id: 'format', kind: 'select' as const }] };
  const packages: SettingsPackage[] = [
    { id: A, enabled: true, pages: [page], stored: {} },
    { id: B, enabled: true, pages: [{ id: `${B}/preferences`, fields: [{ id: 'label', kind: 'text', value: 'Other' }] }], stored: {} },
  ];
  const first = settingsGet(packages, A, { page: PAGE });
  expect(first).toEqual({ schemaVersion: 1, revision: settingsRevision({ label: 'Local report', enabled: true, format: '' }), values: { label: 'Local report', enabled: true, format: '' } });
  // The same numbers as the native `settings_revision` (keys sorted, 53 bits).
  expect(settingsRevision({})).toBe(5711996017187365);
  expect(settingsRevision({ label: 'Local report', enabled: true })).toBe(2677978762292769);
  expect(settingsRevision({ enabled: true, label: 'Local report' })).toBe(2677978762292769);
  // A save changes the values and with them the revision; the notice carries only the page and the revision.
  packages[0].stored[PAGE] = { label: 'Changed', enabled: false, format: 'long' };
  const notice = { kind: 'settings.changed', page: PAGE, revision: settingsRevision(packages[0].stored[PAGE]) };
  const again = settingsGet(packages, A, { page: notice.page });
  expect(again).toMatchObject({ values: { label: 'Changed' }, revision: notice.revision });
  expect((again as { revision: number }).revision).not.toBe((first as { revision: number }).revision);
  expect(Number.isSafeInteger(notice.revision)).toBe(true);
  // Another package's page, an unknown page and a disabled package are NotFound: the page is the package's own data.
  expect(settingsGet(packages, A, { page: `${B}/preferences` })).toEqual({ code: 'NotFound' });
  expect(settingsGet(packages, B, { page: PAGE })).toEqual({ code: 'NotFound' });
  expect(settingsGet(packages, A, { page: `${A}/missing` })).toEqual({ code: 'NotFound' });
  expect(settingsGet(packages, 'ghost', { page: PAGE })).toEqual({ code: 'NotFound' });
  packages[0] = { ...packages[0], enabled: false };
  expect(settingsGet(packages, A, { page: PAGE })).toEqual({ code: 'NotFound' });
  // The request shape: exactly one `page` string. A field naming another owner is refused whole (stability).
  for (const bad of [{}, { page: '' }, { page: 1 }, { page: PAGE, owner: B }, 'x', null]) expect(settingsGet(packages, A, bad), JSON.stringify(bad)).toEqual({ code: 'InvalidArguments' });
});

test('extensions content resources: each resource needs its exact grant for the project of the task', () => {
  const store = fixture([message(1, 'a1', 'user', 'hello'), message(2, 'a1', 'assistant', 'hi there')]);
  const { gate, table } = grants();
  const ask = (owner: string, params: unknown, version = '1.0.0') => query(gate, store, owner, version, params);
  const transcript = { resource: 'transcript', taskId: 'a1' };
  // Nothing granted: refused before any lookup, so an unknown task answers the same.
  for (const taskId of ['a1', 'ghost']) expect(ask(A, { resource: 'transcript', taskId })).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'tasks.summary': '*', 'tasks.tools.read': '*' };
  expect(ask(A, transcript)).toEqual({ code: 'PermissionDenied' });
  table[A]['tasks.transcript.read'] = ['A'];
  const page = ask(A, transcript) as { items: { role: string; text: string; turn: number }[] };
  expect(page.items.map(item => [item.role, item.text, item.turn])).toEqual([['user', 'hello', 1], ['assistant', 'hi there', 1]]);
  expect(ask(A, { resource: 'transcript', taskId: 'b1' })).toEqual({ code: 'PermissionDenied' });
  expect(ask(A, { resource: 'transcript', taskId: 'ghost' })).toEqual({ code: 'NotFound' });
  expect(ask(B, transcript)).toEqual({ code: 'PermissionDenied' });
  expect(ask(A, transcript, '0.9.0')).toEqual({ code: 'PermissionDenied' });
  delete table[A]['tasks.transcript.read'];
  expect(ask(A, transcript)).toEqual({ code: 'PermissionDenied' });
});

test('extensions content resources: selectors, resources and pages are validated before anything is read', () => {
  const { gate, table } = grants();
  table[A] = { 'tasks.summary': '*', 'tasks.transcript.read': '*', 'tasks.tools.read': '*' };
  const store = fixture();
  const cases: [unknown, string][] = [
    [{ resource: 'transcript' }, 'InvalidShape'],
    [{ resource: 'transcript', taskId: 'a1', harness: 'claude' }, 'InvalidShape'],
    [{ resource: 'tasks', taskId: 'a1' }, 'InvalidShape'],
    [{ resource: 'transcript', taskId: 'a1', extra: 1 }, 'InvalidShape'],
    [{ resource: 'usage', taskId: 'a1' }, 'UnsupportedCapability'],
    [{ resource: 'projects' }, 'UnsupportedCapability'],
    [{ resource: 'transcript', taskId: 'a1', limit: 51 }, 'LimitExceeded'],
    [{ resource: 'transcript', taskId: 'a1', limit: 0 }, 'LimitExceeded'],
    [{ resource: 'transcript', taskId: 'a1', revision: 'x'.repeat(65) }, 'LimitExceeded'],
  ];
  for (const [params, code] of cases) expect(query(gate, store, A, '1.0.0', params), JSON.stringify(params)).toEqual({ code });
});

test('extensions content resources: tasks carry the extended row for the granted projects only, and a continued page is revisioned', () => {
  const store = fixture();
  const { gate, table } = grants();
  expect(query(gate, store, A, '1.0.0', { resource: 'tasks' })).toEqual({ code: 'PermissionDenied' });
  table[A] = { 'tasks.summary': ['A'] };
  const first = query(gate, store, A, '1.0.0', { resource: 'tasks', limit: 1 }) as { items: unknown[]; revision: string; nextCursor: number | null };
  expect(first.items).toEqual([{ id: 'a1', projectId: 'A', status: 'pending', title: 'First', harness: 'claude', model: 'opus', mode: 'ask', stage: 'pending', startedBy: 'user' }]);
  expect(first.nextCursor).toBe(1);
  const second = query(gate, store, A, '1.0.0', { resource: 'tasks', limit: 5, cursor: 1, revision: first.revision });
  expect(ids(second)).toEqual(['a2']); expect((second as { nextCursor: number | null }).nextCursor).toBeNull();
  expect(JSON.stringify([first, second])).not.toContain('Foreign');
  table[A] = { 'tasks.summary': ['B'] };
  expect(ids(query(gate, store, A, '1.0.0', { resource: 'tasks' }))).toEqual(['b1']);
  store.revision += 1;
  expect(query(gate, store, A, '1.0.0', { resource: 'tasks', cursor: 1, revision: first.revision })).toEqual({ code: 'StaleContext' });
});

test('extensions content resources: stored tool calls are incomplete previews and changes are patches per turn', () => {
  const tool = (id: number, content: Record<string, unknown>) => message(id, 'a1', 'tool', JSON.stringify(content));
  const store = fixture([
    message(1, 'a1', 'user', 'run it'),
    tool(2, { type: 'tool_activity', version: 1, id: 'call-1', name: 'Bash', status: 'completed', input: 'npm test', output: 'PASS', writePaths: [] }),
    tool(3, { type: 'tool_activity', version: 1, id: 'call-2', name: 'Edit', status: 'running', input: '{"file":"a.rs"}', output: '', writePaths: ['a.rs'] }),
    message(4, 'a1', 'user', 'again'),
    message(5, 'a1', 'changes', ''),
  ], [{ taskId: 'a1', afterMessage: 5, path: 'a.rs', patch: '@@ -1 +1 @@\n-a\n+b' }]);
  const { gate, table } = grants();
  table[A] = { 'tasks.transcript.read': '*' };
  for (const resource of ['tools', 'changes']) expect(query(gate, store, A, '1.0.0', { resource, taskId: 'a1' })).toEqual({ code: 'PermissionDenied' });
  table[A]['tasks.tools.read'] = '*';
  const tools = (query(gate, store, A, '1.0.0', { resource: 'tools', taskId: 'a1' }) as { items: Record<string, unknown>[] }).items;
  expect(tools[0]).toEqual({ callId: 'call-1', turn: 1, tool: { kind: 'shell', name: 'Bash' }, status: 'completed', input: 'npm test', output: 'PASS', inputComplete: false, outputComplete: false, writePaths: [] });
  expect(tools[1].tool).toEqual({ kind: 'edit', name: 'Edit' }); expect(tools[1].writePaths).toEqual(['a.rs']);
  expect(tools.every(item => item.inputComplete === false && item.outputComplete === false)).toBe(true);
  expect(query(gate, store, A, '1.0.0', { resource: 'changes', taskId: 'a1' })).toMatchObject({ items: [{ turn: 2, path: 'a.rs', patch: '@@ -1 +1 @@\n-a\n+b' }] });
  const transcript = query(gate, store, A, '1.0.0', { resource: 'transcript', taskId: 'a1' }) as { items: { text: string }[] };
  expect(transcript.items.map(item => item.text)).toEqual(['run it', 'again']);
  for (const [name, kind] of [['Bash', 'shell'], ['Command', 'shell'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['Read', 'read'], ['Grep', 'search'], ['WebFetch', 'web'], ['mcp__x__y', 'mcp'], ['Thing', 'other']]) expect(toolKind(name), name).toBe(kind);
});

test('extensions content resources: pages are 50 items and 256 KiB, text is cut at 64 KiB, and a changed source is stale', () => {
  const { gate, table } = grants();
  table[A] = { 'tasks.transcript.read': '*' };
  const many = fixture(Array.from({ length: 60 }, (_, index) => message(index + 1, 'a1', 'user', `m${index}`)));
  const first = query(gate, many, A, '1.0.0', { resource: 'transcript', taskId: 'a1', limit: 50 }) as { items: unknown[]; nextCursor: number | null; revision: string };
  expect([first.items.length, first.nextCursor]).toEqual([50, 50]);
  const last = query(gate, many, A, '1.0.0', { resource: 'transcript', taskId: 'a1', limit: 50, cursor: 50, revision: first.revision }) as { items: unknown[]; nextCursor: number | null };
  expect([last.items.length, last.nextCursor]).toEqual([10, null]);
  many.revision += 1;
  expect(query(gate, many, A, '1.0.0', { resource: 'transcript', taskId: 'a1', cursor: 50, revision: first.revision })).toEqual({ code: 'StaleContext' });
  expect(query(gate, many, A, '1.0.0', { resource: 'transcript', taskId: 'a1', cursor: 50 })).toMatchObject({ state: 'Ready' });
  // One text field is cut at 64 KiB on a character boundary and says so.
  const one = fixture([message(1, 'a1', 'assistant', 'é'.repeat(40_000))]);
  const [text, truncated] = [(query(gate, one, A, '1.0.0', { resource: 'transcript', taskId: 'a1' }) as { items: { text: string; truncated?: boolean }[] }).items[0]].map(item => [item.text, item.truncated] as const)[0];
  expect([new TextEncoder().encode(text).length, truncated]).toEqual([65_536, true]);
  expect(cut('a'.repeat(TEXT_BYTES))[1]).toBe(false); expect(cut('a'.repeat(TEXT_BYTES + 1))[0].length).toBe(TEXT_BYTES);
  // A full page of cut texts is trimmed to 256 KiB and the continuation starts where the page stopped.
  const big = fixture(Array.from({ length: 8 }, (_, index) => message(index + 1, 'a1', 'assistant', 'x'.repeat(100_000))));
  const page = query(gate, big, A, '1.0.0', { resource: 'transcript', taskId: 'a1', limit: 50 }) as { items: unknown[]; nextCursor: number | null };
  expect(page.items.length).toBe(3); expect(page.nextCursor).toBe(3);
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(PAGE_BYTES + 1024);
});

test('extensions content resources: retained refusals have non-security reasons', () => {
  // Q041 retained: `ContextResource` stays the five subscribable resources (the new reads are `QueryResource`, one-shot:
  // a change notice for them comes from events.workspace and the hooks, so nothing could be subscribed to).
  const { gate, table } = grants();
  table[A] = { 'tasks.summary': '*' };
  expect(query(gate, fixture(), A, '1.0.0', { resource: 'jobs' })).toEqual({ code: 'UnsupportedCapability' });
  // Q028/Q055/Q124 retained for the webview broker (`context.rs`): the short-activation consent path keeps the
  // three-field task row (stable DTO of that surface). The extended row is the service's native read above.
  expect(Object.keys((query(gate, fixture(), A, '1.0.0', { resource: 'tasks' }) as { items: object[] }).items[0])).toEqual(['id', 'projectId', 'status', 'title', 'harness', 'model', 'mode', 'stage', 'startedBy']);
});
