/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot, TaskSummary } from '../src/connect/types.ts';
import { botRows, branchFits, computerSummary, emptyCopy, filterInbox, inboxItems, inboxLoading, inboxSections, listProblems, liveSignature, needsYouCount, platformName, runClockStart, SETTLED_MS, stillUpdating, type InboxInput } from '../src/store/inbox.ts';
import { idleLive } from '../src/store/reduce.ts';

const NOW = 1_800_000_000_000;
const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'web', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: NOW - 60_000, lastPromptAt: null, ...extra,
});
const HOSTS = [{ id: 'mac', name: 'Studio', online: true }, { id: 'air', name: 'Air', online: false }];
const sections = (tasks: Record<string, TaskSummary[]>) => {
  const lists: InboxInput['tasks'] = Object.fromEntries(Object.entries(tasks).map(([id, list]) => [id, { tasks: list, projects: [] }]));
  return inboxSections({ hosts: HOSTS, tasks: lists, live: {}, snoozed: {}, pins: {}, outbox: [], now: NOW });
};
const bot = (id: string) => ({ id, name: id }) as Bot;

test('the computer filter keeps an offline host\'s cached rows and its bots only', () => {
  const inbox = sections({ mac: [task('a')], air: [task('b')] });
  const bots = botRows(HOSTS, { mac: [bot('m')], air: [bot('n')] }, {});
  const shown = filterInbox(inbox, bots, { computer: 'air' });
  assert.deepEqual(shown.inbox.recent.map(r => r.task.sessionId), ['b']);
  assert.deepEqual(shown.bots.map(r => r.bot.id), ['n']);
  // Search and computer combine; no filter hands back the same objects.
  assert.equal(filterInbox(inbox, bots, { computer: 'mac', query: 'Air' }).inbox.recent.length, 0);
  assert.equal(filterInbox(inbox, bots, { query: '  ' }).inbox, inbox);
});

test('items slice sections into card pieces and fold Settled until opened', () => {
  const inbox = sections({ mac: [task('a'), task('b'), task('old', { updatedAt: NOW - SETTLED_MS - 1 })] });
  const closed = inboxItems(inbox, [], {});
  assert.deepEqual(closed.map(i => (i.type === 'row' ? [i.first, i.last] : i.key)), ['h/recent', [true, false], [false, true], 'h/settled']);
  assert.deepEqual(closed.at(-1), { type: 'head', key: 'h/settled', section: 'settled', count: 1, open: false, computer: undefined });
  const opened = inboxItems(inbox, [], { settled: true });
  assert.deepEqual(opened.slice(-2).map(i => i.key), ['h/settled', 'mac/old']);
  assert.equal(inboxItems(inbox, [], 'all').at(-1)?.key, 'mac/old');
});

test('Updating only while a list can arrive', () => {
  const cached = { mac: { cachedAt: 1 } };
  assert.equal(stillUpdating(cached, [{ id: 'mac', online: true, host: true }], true), true);
  assert.equal(stillUpdating(cached, [{ id: 'mac', online: true, host: false }], true), false);
  assert.equal(stillUpdating(cached, [{ id: 'mac', online: false, host: true }], true), false);
  assert.equal(stillUpdating(cached, [{ id: 'mac', online: true, host: true }], false), false);
});

test('an inbox is loading until presence and every online host\'s first list arrive', () => {
  assert.equal(inboxLoading(0, [], {}, {}), true);
  assert.equal(inboxLoading(1, [], {}, {}), false);
  assert.equal(inboxLoading(2, HOSTS, {}, {}), true);
  assert.equal(inboxLoading(2, HOSTS, { mac: { tasks: [], projects: [] } }, {}), false);
  assert.equal(inboxLoading(2, HOSTS, {}, { mac: { message: 'no', at: 1 } }), false);
});

test('load errors name the computer and clear on a newer list or going offline', () => {
  const errors = { mac: { message: 'Timed out', at: 100 }, air: { message: 'Timed out', at: 100 } };
  assert.deepEqual(listProblems(errors, HOSTS, { mac: { loadedAt: 50 } }), ['Studio: Timed out']);
  assert.deepEqual(listProblems(errors, HOSTS, { mac: { loadedAt: 150 } }), []);
});

test('empty copy', () => {
  assert.equal(emptyCopy([], {}).title, 'No computers yet');
  assert.equal(emptyCopy(HOSTS.slice(1), {}).title, 'Air is offline');
  assert.equal(emptyCopy(HOSTS, { computer: 'air' }).title, 'No tasks on Air');
  assert.equal(emptyCopy(HOSTS, { query: 'x' }).title, 'No matching tasks');
  assert.equal(emptyCopy(HOSTS, {}).title, 'No tasks yet');
});

test('a prompt during a run does not restart its clock', () => {
  assert.equal(runClockStart({ startedAt: 5 }, { runStartedAt: 7, lastPromptAt: 9 }), 5);
  assert.equal(runClockStart(undefined, { runStartedAt: 7, lastPromptAt: 9 }), 7);
  assert.equal(runClockStart({}, { lastPromptAt: 9 }), 9);
  assert.equal(runClockStart(undefined, undefined), undefined);
});

test('the live signature ignores new events and reuses unchanged entries', () => {
  const live = { ...idleLive(), status: 'running' as const };
  const tasks = { mac: { tasks: [task('a')] } };
  const before = liveSignature({ 'mac/a': live }, tasks);
  assert.equal(liveSignature({ 'mac/a': { ...live, lastEventAt: NOW } }, tasks), before);
  assert.notEqual(liveSignature({ 'mac/a': { ...live, status: 'waiting' } }, tasks), before);
  // Same Live and list: the second call must not read the list again.
  let reads = 0;
  const list = { get tasks() { reads += 1; return [task('a')]; } };
  const once = { ...live };
  liveSignature({ 'mac/a': once }, { mac: list });
  liveSignature({ 'mac/a': once }, { mac: list });
  assert.equal(reads, 1);
});

test('platforms and computer summaries read as words', () => {
  assert.equal(platformName('macos'), 'macOS');
  assert.equal(platformName('plan9'), 'plan9');
  const inbox = sections({ mac: [task('r', { status: 'running' }), task('f', { status: 'failed' })], air: [task('a')] });
  assert.equal(computerSummary(inbox, 'mac'), '1 running · 1 needs you');
  assert.equal(computerSummary(inbox, 'air'), '1 task');
  assert.equal(computerSummary(inbox, 'none'), '');
});

test('a branch chip shows only when the meta line has room for it', () => {
  const parts = { status: '9m', statusIcon: false, branch: 'docs/relay', project: 'pandacode' };
  assert.equal(branchFits(parts, 298), true);
  assert.equal(branchFits({ ...parts, status: 'Limited until 03:29', statusIcon: true, project: 'pandacode-web', branch: 'i18n/settings', computer: 'Mac Studio' }, 298), false);
  assert.equal(branchFits(parts, 298, 3), false);
});

test('a section all on one computer says so on its head; mixed sections say it per row; one computer says nothing', () => {
  const inbox = sections({ mac: [task('f', { status: 'failed' }), task('a')], air: [task('b')] });
  const items = inboxItems(inbox, [], {});
  const headComputer = (id: string) => items.flatMap(i => (i.type === 'head' && i.section === id ? [i.computer] : []))[0];
  assert.equal(headComputer('needs'), 'Studio');
  assert.equal(headComputer('recent'), undefined);
  assert.deepEqual(items.filter(i => i.type === 'row').map(i => i.type === 'row' && [i.key, i.showComputer]), [['mac/f', false], ['mac/a', true], ['air/b', true]]);
  const solo = inboxItems(sections({ mac: [task('f', { status: 'failed' }), task('a')] }), [], {});
  assert.ok(solo.every(i => (i.type === 'head' ? i.computer === undefined : !i.showComputer)));
});

test('the attention badge counts Needs you rows, not snoozed ones', () => {
  const lists = { mac: { tasks: [task('f', { status: 'failed' }), task('q', { status: 'waiting' }), task('s', { status: 'failed' }), task('a')], projects: [] } };
  const inbox = inboxSections({ hosts: HOSTS, tasks: lists, live: {}, snoozed: { 'mac/s': NOW + 1000 }, pins: {}, outbox: [], now: NOW });
  assert.equal(needsYouCount(inbox), 2);
  assert.equal(needsYouCount(sections({})), 0);
});
