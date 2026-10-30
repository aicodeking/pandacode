import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewArchitect } from '../src/preview-architect.ts';
import { workerQueueReason } from '../src/worker-scheduling.ts';
import { namedTeamSetup, sameTeamSetup } from '../src/team-mode.ts';

function fixture(t) {
  let time = 1_000_000, timerId = 0, messageId = 0;
  const timers = new Map(), storage = new Map(), events = [], history = [], live = new Set();
  const previous = { window: globalThis.window, storage: globalThis.localStorage, now: Date.now };
  globalThis.window = {
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  Date.now = () => time;
  t.after(() => { globalThis.window = previous.window; globalThis.localStorage = previous.storage; Date.now = previous.now; });
  const parents = new Map(['parent', 'other'].map(id => [id, { id, title: 'New conversation', status: 'idle', taskStage: 'pending', archived: false, provider: 'codex', model: 'sample-model', reasoningEffort: null, updatedAt: 0 }]));
  const host = {
    parent(id) { const value = parents.get(id); if (!value) throw Error('Task not found'); return value; },
    assertIdle(parent) { if (['running', 'waiting'].includes(parent.status)) throw Error('Task is running'); },
    architectLive: id => live.has(id),
    append(sessionId, role, content) { const message = { id: ++messageId, sessionId, role, content, createdAt: time }; history.push(message); return message; },
    finishTiming() {}, finishChanges() {}, nextMessageId: () => ++messageId,
    models: () => [{ id: 'sample-model', reasoningEfforts: [{ id: 'low' }, { id: 'high' }] }],
    emit: snapshot => events.push({ kind: 'snapshot', snapshot }), agent: event => { if (event.kind === 'done') live.delete(event.sessionId); else live.add(event.sessionId); events.push(event); },
  };
  const api = createPreviewArchitect(host);
  function tick() { const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0]; timers.delete(id); time = timer.due; timer.fn(); }
  return { api, host, timers, events, parents, history, storage, tick };
}
const config = (count = 3) => ({
  workers: Array.from({ length: count }, (_, i) => ({ id: `profile-${i}`, name: `Worker ${i + 1}`, provider: 'codex', model: 'sample-model', reasoningEffort: 'low' })),
  maxParallel: 2, maxRounds: 2, maxAssignments: 6, workspace: 'shared', summaryLimit: 512,
});

const assignment = (id, values = {}) => ({ id, name: id, status: 'queued', dependsOn: [], files: [`src/${id}.ts`], ...values });

test('preview eligibility keeps dependencies queued until they complete', () => {
  const dependent = assignment('dependent', { dependsOn: ['dependency'], readOnly: true });
  for (const status of ['queued', 'running', 'waiting', 'failed', 'stopped']) {
    assert.equal(workerQueueReason(dependent, [assignment('dependency', { status }), dependent], 0), 'Waiting for a dependency');
  }
  assert.equal(workerQueueReason(dependent, [dependent], 0), 'Waiting for a dependency');
  assert.equal(workerQueueReason(dependent, [assignment('dependency', { status: 'completed' }), dependent], 0), undefined);
});

test('preview eligibility reserves empty writer scopes and overlapping paths', () => {
  const running = assignment('writer', { status: 'running', files: ['src/App'] });
  for (const files of [[], ['src'], ['SRC/app'], ['src/app/view.ts']]) {
    const queued = assignment('next', { files });
    assert.equal(workerQueueReason(queued, [running, queued], 0), 'Waiting for writer to finish editing shared files');
  }
  for (const files of [['src/Apple'], ['tests/app.ts']]) {
    const queued = assignment('next', { files });
    assert.equal(workerQueueReason(queued, [running, queued], 0), undefined);
  }
  assert.equal(workerQueueReason(assignment('next'), [{ ...running, files: [] }], 0), 'Waiting for writer to finish editing shared files');
  assert.equal(workerQueueReason(assignment('next'), [{ ...running, files: [], status: 'waiting' }], 0), 'Waiting for writer to finish editing shared files');
  assert.equal(workerQueueReason(assignment('next'), [{ ...running, files: [], status: 'completed' }], 0), undefined);
});

test('preview read-only assignments share scopes while honoring the worker limit', () => {
  const writer = assignment('writer', { status: 'running', files: [] });
  const reader = assignment('reader', { readOnly: true, files: [] });
  assert.equal(workerQueueReason(reader, [writer, reader], 0), undefined);
  assert.equal(workerQueueReason(reader, [writer, reader], 1), 'Waiting for an available worker slot');
  assert.equal(workerQueueReason(assignment('next'), [{ ...reader, status: 'running' }], 0), undefined);
  assert.equal(workerQueueReason(reader, [{ ...writer, status: 'waiting' }, reader], 1), 'Waiting for an available worker slot');
  assert.equal(workerQueueReason({ ...reader, status: 'running' }, [writer, reader], 1), undefined);
});

test('architect preview validates setup and restores only owned configurations after reload', t => {
  const { api, host, storage } = fixture(t);
  api.configure('parent', config());
  const reloaded = createPreviewArchitect(host);
  assert.deepEqual(reloaded.get('parent').config, api.get('parent').config);
  assert.equal(reloaded.get('parent').status, 'ready');
  assert.equal(reloaded.get('other'), null);
  for (const invalid of [
    { ...config(), maxParallel: -1 }, { ...config(), maxRounds: 0 },
    { ...config(), maxAssignments: 51 }, { ...config(), summaryLimit: 511 },
    { ...config(), workers: [] }, { ...config(), workers: config(7).workers },
    { ...config(), workers: [config().workers[0], config().workers[0]] },
    { ...config(), workers: [{ ...config().workers[0], reasoningEffort: 'unsupported' }] },
  ]) assert.throws(() => api.configure('other', invalid));
  assert.throws(() => api.configure('unknown', config()));
  api.configure('other', { ...config(1), workers: [{ ...config(1).workers[0], model: 'custom-provider-model', reasoningEffort: null }] });
  api.remove(['parent']);
  assert.equal(createPreviewArchitect(host).get('parent'), null);
  assert.equal(storage.size, 2);
});

test('architect preview persists unlimited parallel workers and starts every assignment', t => {
  const { api, host } = fixture(t);
  const unlimited = { ...config(6), maxParallel: 0 };
  api.configure('parent', unlimited);
  assert.equal(createPreviewArchitect(host).get('parent').config.maxParallel, 0);
  api.start('parent', 'Build six independent areas');
  const workers = api.get('parent').workers;
  assert.equal(workers.filter(worker => worker.status === 'running').length, 6);
  assert(workers.every(worker => worker.files.length > 0), 'concurrent sample writers must declare separate edit scopes');
  assert.equal(new Set(workers.flatMap(worker => worker.files)).size, 6);
  api.configure('other', { ...config(), maxParallel: 128 });
  assert.equal(api.get('other').config.maxParallel, 128);
});

test('architect preview streams separate workers under concurrency and assignment caps', t => {
  const { api, events, timers, tick, history, parents } = fixture(t);
  api.configure('parent', { ...config(5), maxParallel: 2, maxAssignments: 3 });
  api.start('parent', 'Inspect the sample project');
  const initial = api.get('parent');
  assert.equal(initial.workers.length, 3);
  assert.equal(initial.workers.filter(worker => worker.status === 'running').length, 2);
  assert.equal(initial.workers.filter(worker => worker.status === 'queued').length, 1);
  assert.equal(workerQueueReason(initial.workers.find(worker => worker.status === 'queued'), initial.workers, initial.config.maxParallel), 'Waiting for an available worker slot');
  assert.throws(() => api.workerMessages('other', initial.workers[0].id), /belong/);
  assert.throws(() => api.workerMessages('parent', initial.workers[0].id, -1), /cursor/);
  let ticks = 0;
  while (timers.size) {
    assert(++ticks < 1000, 'sample run must settle'); tick();
    assert(api.get('parent').workers.filter(worker => worker.status === 'running').length <= 2);
  }
  for (const worker of initial.workers) {
    const chunks = events.filter(event => event.kind === 'text' && event.sessionId === worker.sessionId);
    assert(chunks.length > 10, 'each worker streams partial output');
    const log = api.workerMessages('parent', worker.id).messages;
    assert.equal(log[0].role, 'user');
    assert.equal(log.at(-1).role, 'changes');
    assert.equal(log.findLast(message => message.role === 'assistant').content, chunks.map(chunk => chunk.text).join(''));
    assert.match(log.findLast(message => message.role === 'assistant').content, /No model, command, or file operation is running/);
  }
  assert.equal(api.get('parent').status, 'completed');
  assert.equal(parents.get('parent').taskStage, 'review');
  assert.equal(history.filter(message => message.role === 'user').length, 1);
  assert.equal(history.filter(message => message.content.includes('### Sample architect review')).length, 1);
  assert(api.get('parent').workers.every(worker => worker.summary.length <= 512));
  assert(api.get('parent').workers.every(worker => workerQueueReason(worker, api.get('parent').workers, initial.config.maxParallel) === undefined));
});

test('architect preview pause and stop cascade without stray timers or duplicate parent prompts', t => {
  const { api, events, timers, tick, history, parents } = fixture(t);
  api.configure('parent', config(2)); api.start('parent', 'Build a sample');
  for (let index = 0; index < 10; index++) tick();
  api.control('parent', 'pause');
  assert.equal(timers.size, 0);
  assert.equal(api.get('parent').status, 'paused');
  assert(api.get('parent').workers.every(worker => worker.status === 'stopped'));
  assert.equal(parents.get('parent').status, 'idle');
  assert(events.some(event => event.kind === 'done' && event.sessionId === 'parent' && event.text === 'Paused'));
  const before = api.get('parent');
  const workerLogs = before.workers.map(worker => api.workerMessages('parent', worker.id));
  api.configure('parent', { ...config(3), maxRounds: 5 });
  assert.equal(api.get('parent').status, 'paused');
  assert.deepEqual(api.get('parent').workers, before.workers);
  assert.deepEqual(before.workers.map(worker => api.workerMessages('parent', worker.id)), workerLogs);
  assert.equal(api.get('parent').config.workers.length, 3);
  assert.equal(api.get('parent').config.maxRounds, 5);
  api.control('parent', 'resume'); tick();
  api.control('parent', 'stop');
  assert.equal(timers.size, 0);
  assert.match(api.get('parent').error, /stopped/i);
  api.control('parent', 'resume');
  assert(api.get('parent').workers.every(worker => worker.attempt === 2));
  while (timers.size) tick();
  assert.equal(api.get('parent').status, 'completed');
  assert.equal(history.filter(message => message.role === 'user').length, 1);
  assert.throws(() => api.configure('parent', null), /saved setup/);
});

test('architect preview rejects a concurrent goal and isolates returned snapshots from scheduler state', t => {
  const { api, parents } = fixture(t);
  const parent = parents.get('parent');
  parent.goalState = { status: 'active' };
  assert.throws(() => api.configure('parent', config()), /Pause the task goal/);
  parent.goalState = null;
  const saved = api.configure('parent', config());
  saved.config.workers.length = 0;
  assert.equal(api.get('parent').config.workers.length, 3);
  parent.archived = true;
  assert.throws(() => api.start('parent', 'Sample'), /Reopen/);
  parent.archived = false;
  api.start('parent', 'Sample');
  api.start('parent', 'Follow-up while workers run');
  assert.throws(() => api.start('parent', 'Concurrent turn'), /architect is still working/);
  const worker = api.get('parent').workers[0];
  api.workerMessages('parent', worker.id).messages.length = 0;
  assert.equal(api.workerMessages('parent', worker.id).messages.length, 1);
  api.control('parent', 'stop');
});

test('architect preview preserves earlier worker logs and enforces the lifetime assignment cap', t => {
  const { api, timers, tick, history } = fixture(t);
  api.configure('parent', { ...config(2), maxAssignments: 3 });
  api.start('parent', 'First sample request');
  while (timers.size) tick();
  const firstWorker = api.get('parent').workers[0];
  const firstLog = api.workerMessages('parent', firstWorker.id);
  api.start('parent', 'Second sample request');
  assert.equal(api.get('parent').workers.length, 3);
  assert.equal(api.get('parent').workers.filter(worker => worker.status === 'running').length, 1);
  while (timers.size) tick();
  assert.deepEqual(api.workerMessages('parent', firstWorker.id), firstLog);
  assert.throws(() => api.start('parent', 'Over the assignment cap'), /assignment limit/);
  assert.equal(history.filter(message => message.role === 'user').length, 2, 'rejected work must not create a user message');
  api.configure('parent', { ...api.get('parent').config, maxAssignments: 4 });
  api.start('parent', 'Continue after increasing the cap');
  while (timers.size) tick();
  assert.equal(api.get('parent').workers.length, 4);
});

test('architect preview bounds Unicode summaries by bytes without broken characters', t => {
  const { api, timers, tick } = fixture(t);
  const unicode = config(1); unicode.workers[0].name = '漢'.repeat(80);
  api.configure('parent', unicode); api.start('parent', 'Unicode sample');
  while (timers.size) tick();
  const summary = api.get('parent').workers[0].summary;
  assert(new TextEncoder().encode(summary).length <= unicode.summaryLimit);
  assert(!summary.includes('\uFFFD'));
});

test('preview checkpoints survive interruption and team messages page without crossing tasks', t => {
  const { api, timers, tick } = fixture(t);
  api.configure('parent', config(3)); api.configure('other', config(1));
  api.start('parent', 'Explore collaboration');
  const checkpoint = api.get('parent').workers[0].checkpoint;
  assert(checkpoint.nextSteps.length > 0);
  api.control('parent', 'pause');
  assert.deepEqual(api.get('parent').workers[0].checkpoint, checkpoint);
  api.control('parent', 'resume');
  while (timers.size) tick();
  const first = api.teamMessages('parent', 0, 2);
  assert.equal(first.messages.length, 2);
  assert.equal(first.hasMore, true);
  const next = api.teamMessages('parent', first.nextCursor, 2);
  assert.equal(next.messages.length, 1);
  assert.equal(next.hasMore, false);
  assert(next.messages[0].id > first.nextCursor);
  assert(first.messages.every(message => message.recipient === 'architect'));
  assert.match(next.messages[0].message, /sample output only/);
  first.messages[0].message = 'Mutated caller state';
  assert.notEqual(api.teamMessages('parent', 0, 1).messages[0].message, 'Mutated caller state');
  assert.equal(api.teamMessages('other').messages.length, 0);
  assert.throws(() => api.teamMessages('missing'), /not found/);
  assert.throws(() => api.teamMessages('parent', -1), /cursor/);
  assert.throws(() => api.teamMessages('parent', 0, 51), /page size/);
  const finished = api.get('parent').workers[0].checkpoint;
  assert.match(finished.summary, /No files were changed/);
  assert.equal(finished.blocker, null);
});

const setup = (count = 2) => ({ architect: { provider: 'claude', model: 'sample-model', reasoningEffort: 'high' }, config: config(count) });

test('team profiles save templates separately from applying and inheriting the default', t => {
  const { api, host, parents, history, events } = fixture(t);
  assert.deepEqual(api.profiles(), { enabled: false, lastSetup: null, activeProfileId: null, profiles: [] });
  const saved = api.saveProfile(undefined, '  Fast team  ', setup());
  const profile = saved.profiles[0];
  assert.equal(profile.name, 'Fast team');
  assert.equal(saved.enabled, false);
  assert.equal(saved.lastSetup, null);
  assert.equal(api.get('parent'), null);
  api.configure('parent', profile.setup.config, profile.setup.architect, profile.id);
  assert.equal(parents.get('parent').provider, 'claude');
  assert.equal(parents.get('parent').reasoningEffort, 'high');
  const remembered = api.profiles();
  assert.equal(remembered.enabled, true);
  assert.equal(remembered.activeProfileId, profile.id);
  assert.deepEqual(remembered.lastSetup, profile.setup);
  const reloaded = createPreviewArchitect(host);
  assert.deepEqual(reloaded.profiles(), remembered);
  reloaded.inherit('other');
  assert.deepEqual(reloaded.get('other').config, profile.setup.config);
  assert.equal(parents.get('other').provider, 'claude');
  assert.equal(reloaded.get('other').status, 'ready');
  assert.equal(reloaded.get('other').workers.length, 0);
  assert.equal(history.length, 0, 'inheriting never starts an agent');
  assert.equal(events.filter(event => event.kind !== 'snapshot').length, 0);
  remembered.profiles[0].setup.config.workers.length = 0;
  assert.equal(api.profiles().profiles[0].setup.config.workers.length, 2);
  api.configure('parent', null);
  assert.equal(api.profiles().activeProfileId, profile.id, 'disabled default remembers its named association');
});

test('team profile update rename delete and single-agent choice preserve applied snapshots', t => {
  const { api, host } = fixture(t);
  const profile = api.saveProfile(undefined, 'Fast team', setup()).profiles[0];
  api.configure('parent', profile.setup.config, profile.setup.architect, profile.id);
  const applied = api.profiles().lastSetup;
  api.saveProfile(profile.id, 'Renamed team', setup(3));
  assert.deepEqual(api.profiles().lastSetup, applied);
  assert.equal(api.get('parent').config.workers.length, 2);
  assert.equal(api.profiles().profiles[0].name, 'Renamed team');
  assert.equal(api.profiles().activeProfileId, null, 'updated template no longer describes the applied default');
  api.deleteProfile(profile.id);
  assert.equal(api.profiles().activeProfileId, null);
  assert.deepEqual(api.profiles().lastSetup, applied);
  api.saveProfile(undefined, 'Retained template', setup(1));
  api.configure('parent', null);
  const disabled = createPreviewArchitect(host);
  assert.equal(disabled.profiles().enabled, false);
  assert.deepEqual(disabled.profiles().lastSetup, applied);
  assert.equal(disabled.profiles().profiles.length, 1);
  disabled.inherit('other');
  assert.equal(disabled.get('other'), null);
});

test('team profiles validate ownership names cap and application atomically', t => {
  const { api, parents } = fixture(t);
  const initialParent = structuredClone(parents.get('parent'));
  const profile = api.saveProfile(undefined, 'Fast team', setup()).profiles[0];
  const initialLibrary = api.profiles();
  for (const name of ['', '   ', 'a'.repeat(81), ' FAST TEAM ', 'Bad\nName', 'Bad\u0000Name']) assert.throws(() => api.saveProfile(undefined, name, setup()));
  assert.throws(() => api.saveProfile('unknown', 'Missing', setup()), /not found/);
  assert.throws(() => api.deleteProfile('unknown'), /not found/);
  assert.throws(() => api.configure('parent', config(3), setup().architect, profile.id), /match/);
  assert.throws(() => api.configure('parent', config(2), setup().architect, 'unknown'), /not found/);
  assert.throws(() => api.configure('parent', config(2), { ...setup().architect, reasoningEffort: 'unsupported' }), /effort/);
  assert.deepEqual(api.profiles(), initialLibrary);
  assert.deepEqual(parents.get('parent'), initialParent);
  assert.equal(api.get('parent'), null);
  for (let i = 1; i < 20; i++) api.saveProfile(undefined, `Team ${i}`, setup());
  assert.throws(() => api.saveProfile(undefined, 'Over cap', setup()), /20/);
  assert.equal(api.saveProfile(profile.id, 'Rename at cap', setup()).profiles.length, 20);
});

test('team defaults migrate the latest owned legacy config once and never overwrite explicit disable', t => {
  const { host, storage, parents } = fixture(t);
  parents.get('parent').updatedAt = 10;
  parents.get('other').updatedAt = 20;
  parents.get('other').provider = 'kimi';
  storage.set('pandacode.preview.architect-configs', JSON.stringify({ parent: config(1), removed: config(3), other: config(2) }));
  const migrated = createPreviewArchitect(host);
  assert.equal(migrated.profiles().enabled, true);
  assert.equal(migrated.profiles().lastSetup.architect.provider, 'kimi');
  assert.equal(migrated.profiles().lastSetup.config.workers.length, 2);
  migrated.configure('other', null);
  assert.equal(createPreviewArchitect(host).profiles().enabled, false);
});

test('used teams apply valid profile changes without losing history and reject invalid changes atomically', t => {
  const { api, parents, history } = fixture(t);
  api.configure('parent', config(2));
  api.start('parent', 'Sample');
  api.control('parent', 'pause');
  const before = api.get('parent'), library = api.profiles(), parentHistory = structuredClone(history);
  const workerLogs = before.workers.map(worker => api.workerMessages('parent', worker.id));
  assert.throws(() => api.configure('parent', { ...config(3), maxAssignments: 1 }), /existing assignment count/);
  assert.throws(() => api.configure('parent', config(2), { ...setup().architect, reasoningEffort: 'unsupported' }), /effort/);
  assert.deepEqual(api.profiles(), library);
  assert.deepEqual(api.get('parent'), before);
  assert.equal(parents.get('parent').provider, 'codex');
  parents.get('parent').resumeId = 'previous-harness-context';
  parents.get('parent').contextUsage = { used: 1000, capacity: 10000 };
  const increased = { ...config(3), maxRounds: 4 };
  api.configure('parent', increased, setup().architect);
  assert.equal(api.get('parent').pendingSetup, null);
  assert.equal(api.get('parent').status, 'paused');
  assert.deepEqual(api.get('parent').workers, before.workers);
  assert.deepEqual(before.workers.map(worker => api.workerMessages('parent', worker.id)), workerLogs);
  assert.deepEqual(history, parentHistory);
  assert.equal(parents.get('parent').provider, 'claude');
  assert.equal(parents.get('parent').resumeId, null);
  assert.equal(parents.get('parent').contextUsage, null);
  assert.deepEqual(api.profiles().lastSetup.architect, setup().architect);
  assert.equal(api.profiles().lastSetup.config.maxRounds, 4);
  parents.get('other').resumeId = 'already-started';
  assert.throws(() => api.configure('other', config(1), setup().architect), /harness/);
  assert.equal(api.get('other'), null);
});

test('active team profile changes keep the latest pending setup and can cancel it without restarting workers', t => {
  const { api, parents, history, timers, tick } = fixture(t);
  api.configure('parent', config(2));
  const effective = { architect: { provider: 'codex', model: 'sample-model', reasoningEffort: null }, config: api.get('parent').config };
  const first = api.saveProfile(undefined, 'First choice', setup(3)).profiles[0];
  const latestSetup = setup(1);
  latestSetup.architect.provider = 'kimi';
  latestSetup.config.workers[0] = { ...latestSetup.config.workers[0], name: 'Future builder', provider: 'claude', reasoningEffort: 'high' };
  const latest = api.saveProfile(undefined, 'Latest choice', latestSetup).profiles[1];
  api.start('parent', 'Keep the current assignments');
  tick();
  const before = api.get('parent'), parent = structuredClone(parents.get('parent')), parentHistory = structuredClone(history);
  const workerLogs = before.workers.map(worker => api.workerMessages('parent', worker.id));
  const activeTimers = [...timers.keys()];
  const queued = api.configure('parent', first.setup.config, first.setup.architect, first.id);
  assert.deepEqual(queued.pendingSetup, first.setup);
  const replaced = api.configure('parent', latest.setup.config, latest.setup.architect, latest.id);
  assert(replaced.revision > queued.revision);
  assert.deepEqual(replaced.pendingSetup, latest.setup);
  assert.deepEqual(replaced.config, before.config);
  assert.deepEqual(replaced.workers, before.workers);
  assert.deepEqual(parents.get('parent'), parent);
  assert.deepEqual(history, parentHistory);
  assert.deepEqual(before.workers.map(worker => api.workerMessages('parent', worker.id)), workerLogs);
  assert.deepEqual([...timers.keys()], activeTimers);
  assert.equal(api.profiles().activeProfileId, latest.id);
  replaced.pendingSetup.config.workers.length = 0;
  assert.deepEqual(api.get('parent').pendingSetup, latest.setup, 'pending snapshots do not expose scheduler state');
  const remembered = api.profiles();
  assert.throws(() => api.configure('parent', { ...latest.setup.config, maxAssignments: 1 }, latest.setup.architect), /existing assignment count/);
  assert.deepEqual(api.profiles(), remembered);
  assert.deepEqual(api.get('parent').pendingSetup, latest.setup);
  const cancelled = api.configure('parent', effective.config, effective.architect);
  assert.equal(cancelled.pendingSetup, null);
  assert.equal(cancelled.status, 'running');
  assert.deepEqual(cancelled.workers, before.workers);
  assert.deepEqual(api.profiles().lastSetup, effective);
  api.configure('parent', latest.setup.config, latest.setup.architect, latest.id);
  while (timers.size) tick();
  const applied = api.get('parent');
  assert.equal(applied.status, 'completed');
  assert.equal(applied.pendingSetup, null);
  assert.deepEqual(applied.config, latest.setup.config);
  assert.equal(parents.get('parent').provider, 'kimi');
  assert.deepEqual(applied.workers.map(worker => [worker.id, worker.provider, worker.model]), before.workers.map(worker => [worker.id, worker.provider, worker.model]));
  const finishedLogs = applied.workers.map(worker => api.workerMessages('parent', worker.id));
  api.start('parent', 'Use the updated setup for new assignments');
  const continued = api.get('parent');
  assert.deepEqual(continued.workers.slice(0, before.workers.length), applied.workers);
  assert.deepEqual(applied.workers.map(worker => api.workerMessages('parent', worker.id)), finishedLogs);
  assert.equal(continued.workers.at(-1).name, 'Future builder');
  assert.equal(continued.workers.at(-1).provider, 'claude');
  assert.equal(history.filter(message => message.role === 'user').length, 2);
});

test('architect preview carries lead guidance and rejects oversized guidance', t => {
  const { api } = fixture(t);
  assert.equal(api.configure('parent', { ...config(), leadGuidance: '  You only lead.  ' }).config.leadGuidance, 'You only lead.');
  assert.equal(api.configure('parent', { ...config(), leadGuidance: '   ' }).config.leadGuidance, undefined);
  assert.throws(() => api.configure('parent', { ...config(), leadGuidance: 'x'.repeat(2001) }), /Lead guidance/);
  // Native counts UTF-8 bytes: 700 three-byte characters are 2100 bytes but 700 UTF-16 units.
  assert.throws(() => api.configure('parent', { ...config(), leadGuidance: '界'.repeat(700) }), /Lead guidance/);
  assert.equal(api.configure('parent', { ...config(), leadGuidance: '界'.repeat(666) }).config.leadGuidance.length, 666);
});

test('a guidance-only edit is a different team setup', () => {
  const setup = { architect: { provider: 'codex', model: 'm', reasoningEffort: null }, config: { ...config(), leadGuidance: 'Lead only.' } };
  assert.equal(sameTeamSetup(setup, structuredClone(setup)), true);
  assert.equal(sameTeamSetup(setup, { ...setup, config: { ...setup.config, leadGuidance: 'Review everything.' } }), false);
  assert.equal(sameTeamSetup({ ...setup, config: { ...setup.config, leadGuidance: null } }, { ...setup, config: { ...setup.config, leadGuidance: undefined } }), true);
});

test('named teams keep lead guidance and a separate effort per role', () => {
  const sol = { provider: 'codex', harness: 'Codex', model: 'sol-6.1', name: 'Sol 6.1' };
  const setup = namedTeamSetup(' Sol ', { ...sol, reasoningEffort: 'high' }, [{ ...sol, reasoningEffort: 'medium' }, { ...sol, model: 'mini', name: 'Mini', reasoningEffort: '' }], { ...config(), leadGuidance: 'Lead only.' });
  assert.deepEqual(setup.architect, { provider: 'codex', model: 'sol-6.1', reasoningEffort: 'high' });
  assert.deepEqual(setup.config.workers.map(worker => worker.reasoningEffort), ['medium', null]);
  assert.equal(setup.config.leadGuidance, 'Lead only.');
  assert.equal('leadGuidance' in namedTeamSetup('Sol', sol, [sol]).config, false);
});


test('architect preview accepts follow-ups between turns without changing running workers', t => {
  const { api, host, history, timers, tick } = fixture(t);
  api.configure('parent', { ...config(2), maxAssignments: 2 });
  api.start('parent', 'Build a sample');
  const workers = api.get('parent').workers;
  assert.equal(host.architectLive('parent'), false);
  api.start('parent', 'Cover the edge case');
  assert.equal(host.architectLive('parent'), true);
  assert.deepEqual(api.get('parent').workers, workers);
  assert.throws(() => api.start('parent', 'Wait for this turn'), { message: 'The architect is still working; the message stays queued.' });
  assert.equal(history.filter(message => message.role === 'user').length, 2);
  while (host.architectLive('parent')) tick();
  assert(api.get('parent').workers.every(worker => worker.status === 'running'));
  assert(timers.size > 0);
  api.start('parent', 'Next architect turn');
  assert.equal(history.filter(message => message.role === 'user').length, 3);
  api.control('parent', 'stop');
  assert.equal(timers.size, 0, 'stopping also cancels the follow-up turn');
});


test('architect preview resumes a paused review after workers have finished', t => {
  const { api, timers, tick } = fixture(t);
  api.configure('parent', config(1)); api.start('parent', 'Build a sample');
  while (api.get('parent').workers.some(worker => worker.status !== 'completed')) tick();
  api.control('parent', 'pause');
  api.control('parent', 'resume');
  while (timers.size) tick();
  assert.equal(api.get('parent').status, 'completed');
});
