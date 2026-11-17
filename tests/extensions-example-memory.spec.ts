import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';

// R1207: the project memory reference package (sample.memory). PREVIEW column: the shipped package (main.cjs and lib/memory.mjs) runs in the
// test runner's Node against a stand-in of the service SDK: a scripted transcript and tool rows (tests/fixtures/extensions/example-memory/turns.json),
// a scripted `panda.models.call` that answers the way B5's `#reply` form does, and a real temporary data directory. No real model, harness
// or sign-in is used. The native column (B5 listTools/callTool/echoPrompt, the real tool server) and the installed column are prepared in
// tests/fixtures/extensions/example-memory/evidence-columns.json and not run. Companions are pending (R06 skipped, user decision 2026-11-17):
// the package says so and the spec checks that it claims nothing more.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/memory/package/extension.json'));
const world = JSON.parse(read('tests/fixtures/extensions/example-memory/turns.json')) as { seed: { project: string; text: string }[]; tasks: Record<string, { projectId: string; transcript: Record<string, unknown>[]; tools: Record<string, unknown>[]; summary: string }> };
const columns = JSON.parse(read('tests/fixtures/extensions/example-memory/evidence-columns.json'));
const require = createRequire(import.meta.url);
const mainPath = fileURLToPath(new URL('../examples/extensions/memory/package/main.cjs', import.meta.url));
const OWNER = 'sample.memory';
const TOOL = `${OWNER}/memory`;
const VIEW = `${OWNER}/memories`;
const PAGE = `${OWNER}/settings`;
type Obj = Record<string, any>;
const within = (what: string, check: () => unknown, timeout = 2000) => expect.poll(check, { message: what, timeout, intervals: [10, 20, 50] });
const code = (value: string) => Object.assign(new Error(value), { code: value });

type Options = { dir?: string; settings?: Record<string, string>; noModel?: boolean; noTools?: boolean; seed?: boolean; unavailable?: string[]; contextRefused?: boolean };

async function boot(options: Options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'panda-memory-'));
  const { fileStore } = require(mainPath);
  if (options.seed !== false && !existsSync(join(dir, 'memories.json'))) {
    await fileStore(dir).save({ nextId: world.seed.length + 1, items: world.seed.map((item, index) => ({ id: `m-${index + 1}`, project: item.project, text: item.text, tags: [], at: 0, source: 'tool' })) });
  }
  const tools = new Map<string, (input: Obj, call: Obj) => Promise<Obj>>();
  const hooks = new Map<string, (payload: Obj) => unknown>();
  const events = new Map<string, ((event: Obj) => unknown)[]>();
  const messages = new Map<string, (message: Obj, from: Obj) => unknown>();
  const posts: { message: Obj; instance?: string }[] = [];
  const calls: Obj[] = [];
  const queries: Obj[] = [];
  const applied: ((receipt: Obj) => void)[] = [];
  const stops: (() => void)[] = [];
  let opened: ((instance: Obj) => void) | null = null;
  const values = { inject: 'first', count: '3', debounce: '30', capture: 'on', ...(options.settings ?? {}) };
  const disposable = (fn: () => void = () => undefined) => ({ dispose: fn });
  const panda = {
    storage: { directory: async () => ({ schemaVersion: 1, path: dir }) },
    settings: { get: async () => ({ schemaVersion: 1, revision: 1, values }) },
    modelTools: {
      register: (id: string, handler: (input: Obj, call: Obj) => Promise<Obj>) => {
        tools.set(id, handler);
        return { dispose: () => tools.delete(id), ready: options.noTools ? Promise.reject(code('PermissionDenied')) : Promise.resolve() };
      },
    },
    hooks: {
      on: (event: string, handler: (payload: Obj) => unknown) => { hooks.set(event, handler); return { dispose: () => hooks.delete(event), ready: Promise.resolve() }; },
      onApplied: (handler: (receipt: Obj) => void) => { applied.push(handler); return disposable(); },
    },
    events: {
      on: (kind: string, handler: (event: Obj) => unknown) => { events.set(kind, [...(events.get(kind) ?? []), handler]); return disposable(); },
    },
    context: {
      query: async (request: Obj) => {
        queries.push(request);
        const task = world.tasks[request.taskId];
        if (!task) throw code('NotFound');
        return { schemaVersion: 1, state: 'Ready', revision: '1', nextCursor: null, items: request.resource === 'transcript' ? task.transcript : task.tools };
      },
    },
    models: {
      call: async (request: Obj) => {
        calls.push(request);
        if (options.noModel) throw code('UnsupportedCapability');
        return { text: world.tasks[request.taskId]?.summary ?? 'summary', harness: 'sample.launch-agent/fake', model: 'fake-1', usage: { input: 12, output: 7 } };
      },
    },
    harnesses: {
      list: async () => ({ schemaVersion: 1, decisions: 'delivered', runs: [], harnesses: [{ id: 'claude', name: 'Claude Code', toolServers: { value: true } }, ...(options.unavailable ?? []).map(name => ({ id: name.toLowerCase(), name, toolServers: { value: false } }))] }),
    },
    views: {
      on: (kind: string, handler: (instance: Obj) => void) => { if (kind === 'opened') opened = handler; return disposable(); },
      onMessage: (view: string, handler: (message: Obj, from: Obj) => unknown) => { messages.set(view, handler); return disposable(); },
      post: async (view: string, message: Obj, target?: { instance?: string }) => { posts.push({ message, instance: target?.instance }); return { delivered: 1 }; },
    },
    commands: { register: () => disposable() },
  };
  const lifetime = { onStop: (fn: () => void) => { stops.push(fn); } };
  await require(mainPath).service(panda, lifetime);
  if (options.contextRefused) for (const handler of applied) handler({ event: 'prompt.submit', applied: true, refused: { context: 'PermissionDenied' } });
  const memories = () => JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8')).items as Obj[];
  const host = {
    dir, tools, hooks, calls, queries, posts, memories,
    stop: () => { for (const fn of stops.splice(0)) fn(); },
    tool: (input: Obj, call: Obj = { projectId: 'p1', taskId: 't1' }) => tools.get(TOOL)!(input, call),
    prompt: (turn: Obj) => hooks.get('prompt.submit')!({ taskId: 't1', projectId: 'p1', index: 1, sinceCompaction: 0, ...turn }) as Promise<Obj | undefined>,
    emit: (kind: string, event: Obj) => { for (const handler of events.get(kind) ?? []) handler(event); },
    open: (instanceId = 'i-1') => opened!({ instanceId }),
    message: (message: Obj, from: Obj = { instanceId: 'i-1' }) => messages.get(VIEW)!(message, from),
    latest: () => [...posts].reverse().find(item => item.message.kind === 'memories')?.message as Obj | undefined,
    finish: (taskId: string, projectId = 'p1') => hooks.get('turn.finish')!({ taskId, projectId }),
    idle: (taskId: string, projectId = 'p1') => hooks.get('task.idle')!({ taskId, projectId }),
  };
  return host;
}
type Host = Awaited<ReturnType<typeof boot>>;
const cleanup = (host: Host) => { host.stop(); rmSync(host.dir, { recursive: true, force: true }); };

test('memory example: the package is a valid service package with a model tool, three hooks and a rich panel, and claims no companion', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'events.workspace', 'tools.model', 'harness.hooks.context', 'harness.hooks.observe', 'models.call', 'tasks.transcript.read', 'tasks.tools.read', 'ui.richViews', 'storage.private', 'harnesses.inventory']);
  expect(manifest.permissions).not.toContain('harness.hooks.decide');
  expect(manifest.contributes.modelTools).toHaveLength(1);
  expect(manifest.contributes.modelTools[0]).toMatchObject({ id: TOOL, name: 'memory', approval: 'never' });
  expect(manifest.contributes.hooks.map((hook: Obj) => hook.event)).toEqual(['prompt.submit', 'turn.finish', 'task.idle']);
  expect(manifest.contributes.views[0]).toMatchObject({ id: VIEW, rich: { folder: 'panel', entry: 'index.html' } });
  expect(manifest.contributes.settings[0].id).toBe(PAGE);
  const logic = read('examples/extensions/memory/package/lib/memory.mjs');
  expect(logic).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]/);
  expect(logic).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function/);
  for (const call of ['panda.models.call(', 'panda.modelTools.register(', "panda.hooks.on('prompt.submit'", "panda.hooks.on('turn.finish'", "panda.hooks.on('task.idle'", "resource: 'transcript'", "resource: 'tools'", 'panda.harnesses.list(']) expect(logic, call).toContain(call);
  // The unsupported path is named, never faked: companions are pending, and nothing in the package shapes a harness compaction.
  expect(logic).toContain('pending - companions deferred, user decision 2026-11-17');
  expect(logic).not.toMatch(/harness\.hooks\.decide|\bsummary:\s|instructions:/);
  const main = read('examples/extensions/memory/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:fs', 'node:path']);
  const script = read('examples/extensions/memory/package/panel/app.js');
  expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  for (const text of ['pandaView', "'memories'", 'tool unavailable for', 'companion']) expect(script, text).toContain(text);
});

test('memory example: the scorer, the privacy filter and deduplication are exact', async () => {
  const { stripPrivate, hasPrivate, similarity, relevance, tokens, rank, shorten, readSettings, DUPLICATE } = await import('../examples/extensions/memory/package/lib/memory.mjs');
  expect(stripPrivate('keep <private>drop this</private> and <PRIVATE>this\nmultiline</PRIVATE>end')).toBe('keep  and end');
  expect(stripPrivate('<private>everything</private>')).toBe('');
  expect(stripPrivate('open <private>never closed')).toBe('open');
  expect(hasPrivate('x <private>y</private>')).toBe(true);
  expect([...tokens('The migrations, the DB and run!')].sort()).toEqual(['migrations', 'run']);
  expect(similarity('team uses pnpm node', 'team uses pnpm node')).toBe(1);
  expect(similarity('team uses pnpm node', 'completely different words here')).toBe(0);
  expect(similarity('alpha beta gamma delta epsilon zeta eta theta iota kappa', 'alpha beta gamma delta epsilon zeta eta theta iota')).toBeCloseTo(0.9, 5);
  expect(DUPLICATE).toBe(0.9);
  const items = [{ id: 'm-1', project: 'p1', text: 'Migrations run before tests', tags: [] }, { id: 'm-2', project: 'p1', text: 'Deploys use staging', tags: [] }, { id: 'm-3', project: 'p2', text: 'Migrations in the other project', tags: [] }];
  expect(relevance('run migrations', items[0])).toBe(1);
  expect(rank(items, 'migrations tests', { project: 'p1' }).map(hit => hit.memory.id)).toEqual(['m-1']);
  expect(rank(items, 'migrations tests', { project: 'p1', scope: 'all-projects' }).map(hit => hit.memory.id)).toEqual(['m-1', 'm-3']);
  expect(rank(items, 'zzz', { project: 'p1' })).toEqual([]);
  expect(shorten('a   b\n c', 100)).toBe('a b c');
  expect(shorten('x'.repeat(20), 10)).toHaveLength(10);
  expect(readSettings({ inject: 'ALWAYS', count: '99', debounce: 'x', capture: 'Off' })).toEqual({ inject: 'always', count: 3, debounceMs: 10000, capture: false });
  expect(readSettings({ inject: 'first', count: '5', debounce: '200', capture: 'on' })).toEqual({ inject: 'first', count: 5, debounceMs: 200, capture: true });
});

test('memory example: the memory tool adds, searches (this project or all), lists and forgets, and blocks private content', async () => {
  const host = await boot();
  try {
    const added = await host.tool({ mode: 'add', content: 'The release branch is main.' });
    expect(added).toEqual({ content: { success: true, id: 'm-6' } });
    expect(host.memories().at(-1)).toMatchObject({ id: 'm-6', project: 'p1', source: 'tool', text: 'The release branch is main.' });
    const found = (await host.tool({ mode: 'search', query: 'migrations tests', limit: 2 })).content as Obj;
    expect(found.results.length).toBeLessThanOrEqual(2);
    expect(found.results[0]).toMatchObject({ id: 'm-2', project: 'p1' });
    expect(found.results.map((item: Obj) => item.score)).toEqual([...found.results.map((item: Obj) => item.score)].sort((a, b) => b - a));
    expect(found.results.every((item: Obj) => item.project === 'p1')).toBe(true);
    const other = (await host.tool({ mode: 'search', query: 'secrets vault' })).content as Obj;
    expect(other.results).toEqual([]);
    const all = (await host.tool({ mode: 'search', query: 'secrets vault', scope: 'all-projects' })).content as Obj;
    expect(all.results.map((item: Obj) => item.project)).toEqual(['p2']);
    const listed = (await host.tool({ mode: 'list', limit: 3 })).content as Obj;
    expect(listed.memories.map((item: Obj) => item.id)).toEqual(['m-6', 'm-4', 'm-3']);
    expect(await host.tool({ mode: 'forget', id: 'm-6' })).toEqual({ content: { success: true } });
    expect(host.memories().some(item => item.id === 'm-6')).toBe(false);
    // A memory of another project cannot be forgotten from this one, and an unknown id is an error result.
    expect(await host.tool({ mode: 'forget', id: 'm-5' })).toMatchObject({ isError: true });
    expect(await host.tool({ mode: 'forget', id: 'm-404' })).toMatchObject({ isError: true });
    expect(host.memories().some(item => item.id === 'm-5')).toBe(true);
    // Private content: stripped when mixed, blocked when it is all private.
    await host.tool({ mode: 'add', content: 'visible <private>hidden-token</private> text' });
    expect(host.memories().at(-1)!.text).toBe('visible  text');
    expect(JSON.stringify(host.memories())).not.toContain('hidden-token');
    const before = host.memories().length;
    expect(await host.tool({ mode: 'add', content: '<private>all of it</private>' })).toEqual({ content: { success: false, error: 'Private content blocked' }, isError: true });
    expect(host.memories()).toHaveLength(before);
    expect(await host.tool({ mode: 'frobnicate' })).toMatchObject({ isError: true });
  } finally { cleanup(host); }
});

test('memory example: recall is appended on the first message, not the second with `first`, and again after a compaction', async () => {
  const host = await boot();
  try {
    const first = await host.prompt({ text: 'How do I run the migrations before the tests?', index: 1, sinceCompaction: 0 });
    // At most three, ordered by relevance, only this project, never the other project's memory.
    const lines = (first!.context as string).split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toContain('Database migrations live in db/migrations');
    expect(first!.context).not.toContain('vault');
    expect(Object.keys(first!)).toEqual(['context']);
    // The second message of the same task gets nothing with `first`.
    expect(await host.prompt({ text: 'And the migrations again?', index: 2, sinceCompaction: 1 })).toBeUndefined();
    // The turn after a compaction (sinceCompaction 0 on a task already seen) gets recall again.
    const afterCompaction = await host.prompt({ text: 'Remind me about the migrations', index: 3, sinceCompaction: 0 });
    expect(afterCompaction!.context).toContain('migrations');
    // Another task starts its own first message.
    expect((await host.prompt({ taskId: 't2', text: 'pnpm scripts please', index: 1 }))!.context).toContain('pnpm');
    // No hit, no context: nothing is appended.
    expect(await host.prompt({ taskId: 't3', text: 'zzz qqq', index: 1 })).toBeUndefined();
    // A deleted memory is no longer recalled.
    await host.tool({ mode: 'forget', id: 'm-2' });
    const forgotten = await host.prompt({ taskId: 't4', text: 'How do I run the migrations before the tests?', index: 1 });
    expect(forgotten?.context ?? '').not.toContain('Database migrations');
  } finally { cleanup(host); }
});

test('memory example: with `always` every message is recalled, and the count follows the setting', async () => {
  const host = await boot({ settings: { inject: 'always', count: '1' } });
  try {
    for (const index of [1, 2, 3]) {
      const turn = await host.prompt({ text: 'migrations before tests', index, sinceCompaction: index });
      expect((turn!.context as string).split('\n')).toHaveLength(1);
    }
  } finally { cleanup(host); }
});

test('memory example: a finished turn is captured once after the debounce, with one model call, tags and the package usage', async () => {
  const host = await boot();
  try {
    await host.finish('t1');
    await host.idle('t1');
    await within('the captured memory', () => host.memories().length).toBe(world.seed.length + 1);
    // turn.finish and task.idle share one debounce: one model call, one capture.
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toMatchObject({ taskId: 't1', projectId: 'p1' });
    expect(host.calls[0].prompt).toContain('Why do the migrations fail on CI?');
    expect(host.calls[0].prompt).toContain('write_file');
    expect(host.calls[0]).not.toHaveProperty('tools');
    const stored = host.memories().at(-1)!;
    expect(stored).toMatchObject({ project: 'p1', source: 'capture', text: world.tasks.t1.summary });
    expect(stored.tags.length).toBeGreaterThan(0);
    for (const tag of stored.tags) expect(stored.text.toLowerCase()).toContain(tag);
    // The captured turn read goes through the host's transcript and tools reads only.
    expect(host.queries.map(query => query.resource).sort()).toEqual(['tools', 'transcript']);
    // The same turn again is not captured twice.
    await host.finish('t1');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(host.calls).toHaveLength(1);
    expect(host.memories()).toHaveLength(world.seed.length + 1);
  } finally { cleanup(host); }
});

test('memory example: a private-only turn stores nothing and asks no model, and a near duplicate is not stored again', async () => {
  const host = await boot();
  try {
    await host.finish('t-private');
    await host.finish('t-dup');
    await within('the duplicate call', () => host.calls.length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    // The private turn never reached the model; the duplicate (score 1, over 0.9) was asked for but not stored.
    expect(host.calls.map(call => call.taskId)).toEqual(['t-dup']);
    expect(host.memories()).toHaveLength(world.seed.length);
    expect(JSON.stringify(host.calls)).not.toContain('abc-123');
    expect(JSON.stringify(host.memories())).not.toContain('abc-123');
    const state = JSON.stringify(host.latest() ?? {});
    expect(state).not.toContain('abc-123');
  } finally { cleanup(host); }
});

test('memory example: capture can be switched off in the settings', async () => {
  const host = await boot({ settings: { capture: 'off' } });
  try {
    await host.finish('t1');
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(host.calls).toHaveLength(0);
    expect(host.memories()).toHaveLength(world.seed.length);
  } finally { cleanup(host); }
});

test('memory example: without models.call capture stores the raw turn shortened, with a visible note, and nothing pretends a model answered', async () => {
  const host = await boot({ noModel: true });
  try {
    host.open();
    await host.finish('t1');
    await within('the raw capture', () => host.memories().length).toBe(world.seed.length + 1);
    const stored = host.memories().at(-1)!;
    expect(stored).toMatchObject({ source: 'capture', raw: true });
    expect(stored.text).toContain('Why do the migrations fail on CI?');
    expect(stored.text.length).toBeLessThanOrEqual(600);
    await within('the note in the panel', () => host.latest()?.status.notes.join(' ')).toContain('No model call (UnsupportedCapability)');
    expect(host.latest()!.status.capture).toBe('raw (UnsupportedCapability)');
  } finally { cleanup(host); }
});

test('memory example: losing a grant is a named state in the panel, never a crash', async () => {
  const noTool = await boot({ noTools: true });
  try {
    noTool.open();
    await within('the tool state', () => noTool.latest()?.status.tool).toBe('inactive (PermissionDenied)');
    // Recall at send still works without the tool.
    expect((await noTool.prompt({ text: 'migrations tests', index: 1 }))!.context).toContain('migrations');
  } finally { cleanup(noTool); }
  const noContext = await boot({ contextRefused: true });
  try {
    noContext.open();
    await within('the recall state', () => noContext.latest()?.status.recall).toBe('inactive (PermissionDenied)');
    expect(noContext.latest()!.status.notes.join(' ')).toContain('harness.hooks.context');
  } finally { cleanup(noContext); }
});

test('memory example: the panel lists the current project, searches, deletes and names the harnesses that take no tool server', async () => {
  const host = await boot({ unavailable: ['ZCode'] });
  try {
    host.emit('project.opened', { projectId: 'p1' });
    host.open('i-1');
    await within('the first snapshot', () => host.latest()?.total).toBe(4);
    const first = host.latest()!;
    expect(host.posts.at(-1)!.instance).toBe('i-1');
    expect(first.items.every((item: Obj) => item.project === 'p1')).toBe(true);
    expect(first.status.unavailable).toEqual(['ZCode']);
    expect(first.status.compaction).toEqual({ recallAfterCompaction: true, companion: 'pending - companions deferred, user decision 2026-11-17' });
    // Search narrows the list; an empty search brings the whole list back.
    await host.message({ kind: 'search', query: 'migrations' });
    await within('the search', () => host.latest()?.items.map((item: Obj) => item.id)).toEqual(['m-2']);
    await host.message({ kind: 'search', query: '' });
    await within('the full list', () => host.latest()?.items.length).toBe(4);
    // Delete one: it leaves the list and the file, and is no longer recalled.
    await host.message({ kind: 'delete', id: 'm-2' });
    await within('the delete', () => host.latest()?.total).toBe(3);
    expect(host.memories().some(item => item.id === 'm-2')).toBe(false);
    expect((await host.prompt({ taskId: 'tx', text: 'database migrations before the tests', index: 1 }))?.context ?? '').not.toContain('Database migrations');
    // A garbage message changes nothing and never throws.
    const count = host.posts.length;
    for (const message of [7, 'x', { kind: 'nothing' }, { kind: 'delete' }]) await host.message(message as Obj);
    expect(host.posts.length).toBe(count);
    // Another project's memory is invisible here and visible when no project is shown.
    host.emit('project.opened', { projectId: 'p2' });
    await within('the second project', () => host.latest()?.items.map((item: Obj) => item.project)).toEqual(['p2']);
  } finally { cleanup(host); }
});

test('memory example: the memories survive a service restart and an update, and the data stays in the package directory', async () => {
  const first = await boot();
  const dir = first.dir;
  try {
    await first.tool({ mode: 'add', content: 'Persistent fact about the release flow.' });
    first.stop();
    const second = await boot({ dir, seed: false });
    expect((await second.tool({ mode: 'list', limit: 50 })).content).toMatchObject({ memories: expect.arrayContaining([expect.objectContaining({ id: 'm-6', text: 'Persistent fact about the release flow.' })]) });
    // The counter continues: ids are never reused after a restart.
    expect((await second.tool({ mode: 'add', content: 'Another fact' })).content).toEqual({ success: true, id: 'm-7' });
    second.stop();
    // An update of the package files starts a new generation over the same directory.
    const third = await boot({ dir, seed: false });
    expect(third.memories().map(item => item.id)).toContain('m-7');
    third.stop();
    expect(existsSync(join(dir, 'memories.json'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory example: a tool call while the service is stopped has no handler, and a stop leaves no timer, handler or capture behind', async () => {
  const host = await boot();
  try {
    await host.finish('t1');
    host.stop();
    // The host answers an error result for a tool whose handler is gone; here the stand-in shows the handler is removed.
    expect(host.tools.has(TOOL)).toBe(false);
    expect(host.hooks.size).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(host.calls).toHaveLength(0);
    expect(host.memories()).toHaveLength(world.seed.length);
  } finally { cleanup(host); }
});

test('memory example: the evidence columns, the guide and the registrations are prepared and say what is not run', () => {
  for (const name of ['preview', 'native', 'installedWindows']) expect(columns.columns[name].status, name).toContain('prepared, not run');
  expect(columns.columns.preview.engines.chromium.port).toBe(16661);
  expect(columns.columns.preview.engines.webkit.port).toBe(16662);
  expect(columns.columns.companions.status).toContain('pending - companions deferred, user decision 2026-11-17');
  const doc = read('docs/extensions/examples/memory.md');
  for (const text of ['sample.memory', 'prepared, not run', 'companions deferred, user decision 2026-11-17', 'Preview evidence', 'UnsupportedCapability']) expect(doc, text).toContain(text);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-example-memory.spec.ts');
  expect(read('playwright.webkit.config.ts')).toContain('memory example:');
});
