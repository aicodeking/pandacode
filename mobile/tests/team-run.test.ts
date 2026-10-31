/// <reference types="node" />
// A team (architect) task or subagents keep a task working after the main agent's turn ends.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, TaskSummary } from '../src/connect/types.ts';
import { demoTeam } from '../src/demo-team.ts';
import { glanceOf, inboxSections, type InboxInput } from '../src/store/inbox.ts';
import { applyEvent, ended, fromList, fromSubscribe, idleLive, type Live } from '../src/store/reduce.ts';
import { applyTeamEvent, decodeTeam, decodeTeamRun, teamRun, waitingOn } from '../src/store/team.ts';

const NOW = 1_800_000_000_000;
const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'web', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: NOW - 60_000, lastPromptAt: null, ...extra,
});
const input = (tasks: TaskSummary[], extra: Partial<InboxInput> = {}): InboxInput => ({
  hosts: [{ id: 'mac', name: 'Studio' }], tasks: { mac: { tasks, projects: [] } }, live: {}, snoozed: {}, pins: {}, outbox: [], now: NOW, ...extra,
});
const ev = (kind: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({ sessionId: 's', kind, text: '', ...extra });
const agent = (id: string, status: string, updatedAt: number, tools: object[] = []) => ({ id, name: 'Explore', prompt: 'Find it', status, response: '', tools, startedAt: 10, updatedAt });
const busy = { status: 'running', activeWorkers: 2 };
const working: Live = { ...idleLive(), status: 'running', activity: 'Generating response', startedAt: 5, items: [{ kind: 'text', text: 'Dispatched.' }] };

test('team runs decode from rows and team events; junk is ignored', () => {
  assert.deepEqual(decodeTeamRun({ status: 'waiting', activeWorkers: 3 }), { status: 'waiting', activeWorkers: 3 });
  assert.deepEqual(decodeTeamRun({ teamStatus: 'completed', activeWorkers: 0 }), { status: 'completed', activeWorkers: 0 });
  assert.deepEqual(decodeTeamRun({ status: 'running', activeWorkers: -4 }), { status: 'running', activeWorkers: 0 });
  assert.equal(decodeTeamRun(null), undefined);
  assert.equal(decodeTeamRun({ activeWorkers: 1 }), undefined);
  assert.equal(waitingOn(1), 'Waiting on 1 worker');
  assert.equal(waitingOn(3), 'Waiting on 3 workers');
  // A loaded task.team (older hosts): busy while active with a working worker.
  const team = decodeTeam(demoTeam(NOW));
  assert.deepEqual(teamRun(team), { status: 'running', activeWorkers: 1 });
  assert.equal(teamRun(applyTeamEvent(team, { teamStatus: 'paused', activeWorkers: 0 }))?.status, 'paused');
  assert.equal(teamRun('outdated'), undefined);
});

test('an idle architect with an active team is Working; older hosts use the loaded team', () => {
  const rows = [task('t', { team: busy }), task('plain'), task('old')];
  let inbox = inboxSections(input(rows));
  assert.deepEqual(inbox.running.map(r => [r.task.sessionId, r.badge, r.run.activity]), [['t', 'working', 'Waiting on 2 workers']]);
  inbox = inboxSections(input(rows, { teams: { 'mac/old': decodeTeam(demoTeam(NOW)) } }));
  assert.deepEqual(inbox.running.map(r => r.task.sessionId).sort(), ['old', 't']);
  // A settled team doesn't; the row's own team wins over a stale loaded one.
  inbox = inboxSections(input([task('t', { team: { status: 'completed', activeWorkers: 0 } })], { teams: { 'mac/t': decodeTeam(demoTeam(NOW)) } }));
  assert.equal(inbox.running.length, 0);
  // Subagents still running keep it working too, and show their current tool.
  const live = { ...idleLive(), subagents: [agent('a', 'running', 1, [{ id: 'x', name: 'Bash', status: 'running', input: '{"command":"npm test"}', output: '' }])] } as Live;
  inbox = inboxSections(input([task('kids')], { live: { 'mac/kids': live } }));
  assert.equal(inbox.running[0]?.badge, 'working');
  assert.match(glanceOf(live).activity, /npm test/);
});

test('run.finished with an active team keeps the task running, waiting on its workers', () => {
  const held = ended(working, 'idle', busy);
  assert.deepEqual([held.status, held.activity, held.held, held.items.length, held.startedAt], ['running', 'Waiting on 2 workers', 'idle', 0, 5]);
  assert.equal(ended(working, 'idle', { status: 'running', activeWorkers: 1 }).activity, 'Waiting on 1 worker');
  // Older hosts' run.finished has no team; a settled one ends the run as before.
  assert.deepEqual(ended(working, 'idle'), idleLive());
  assert.deepEqual(ended(working, 'idle', { status: 'completed', activeWorkers: 0 }), idleLive());
  // A list still showing the team busy updates the count, and keeps it held.
  const listed = fromList(held, 'running', undefined, { team: { status: 'running', activeWorkers: 1 } });
  assert.deepEqual([listed?.status, listed?.activity], ['running', 'Waiting on 1 worker']);
  // A newer host lists the architect running for a task this phone has no live view of.
  const seeded = fromList(undefined, 'running', undefined, { team: busy });
  assert.deepEqual([seeded?.status, seeded?.activity], ['running', 'Waiting on 2 workers']);
  // The architect working again clears the hold.
  const again = applyEvent(held, ev('text', { text: 'Next round' }));
  assert.deepEqual([again.held, again.team, again.activity], [undefined, undefined, 'Generating response']);
});

test('the team-settled event and an ended list row settle a held task', () => {
  const held = ended(working, 'idle', busy);
  // A worker row event changes nothing about the hold.
  assert.equal(applyEvent(held, ev('team', { data: { id: 'w1', status: 'completed', name: 'W' } })).held, 'idle');
  const settled = applyEvent(held, ev('team', { data: { teamStatus: 'completed', activeWorkers: 0 } }));
  assert.deepEqual([settled.status, settled.held, settled.activity], ['idle', undefined, '']);
  assert.equal(applyEvent(held, ev('team', { data: { teamStatus: 'failed', activeWorkers: 0 } })).status, 'failed');
  assert.equal(applyEvent(held, ev('team', { data: { teamStatus: 'running', activeWorkers: 1 } })).activity, 'Waiting on 1 worker');
  // A task that isn't held ignores it.
  assert.equal(applyEvent(working, ev('team', { data: { teamStatus: 'completed', activeWorkers: 0 } })).status, 'running');
  // The host lists it ended with no active team (newer: `team` settled; older: none loaded).
  assert.deepEqual(fromList(held, 'idle', undefined, { team: { status: 'completed', activeWorkers: 0 } }), idleLive());
  assert.deepEqual(fromList(held, 'idle'), idleLive());
  assert.equal(fromSubscribe(held, 'failed').status, 'failed');
  // An older host's loaded team still working keeps it held through the list.
  assert.equal(fromList(held, 'idle', undefined, {}, { status: 'running', activeWorkers: 1 })?.status, 'running');
});

test('subagents active at the turn end are kept, then settle; stale ones never stick', () => {
  const live: Live = { ...working, subagents: [agent('a', 'running', 1), agent('b', 'completed', 1)] as Live['subagents'] };
  const held = ended(live, 'idle');
  assert.deepEqual([held.status, held.subagents?.map(a => a.id)], ['running', ['a']]);
  // Stop ends them.
  assert.equal(ended(live, 'stopped').status, 'stopped');
  // The last one finishing settles the task with the turn's status.
  const done = applyEvent(held, ev('subagent', { data: agent('a', 'completed', 2) }));
  assert.deepEqual([done.status, done.subagents], ['idle', undefined]);
  // A list that shows the task ended and no subagents running settles it (older hosts send none).
  assert.deepEqual(fromList(held, 'idle'), idleLive());
  assert.deepEqual(fromList(held, 'idle', undefined, { subagents: [agent('a', 'completed', 3)] }), idleLive());
  // One the host still lists as running keeps it.
  assert.equal(fromList(held, 'idle', undefined, { subagents: [agent('a', 'running', 3)] })?.status, 'running');
});
