/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { demoTeam } from '../src/demo-team.ts';
import { applyTeamEvent, cutNote, decodeTeam, teamResumable, workerActive, workerClockEnd, workerLabel, workerNames, workersTitle } from '../src/store/team.ts';

const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), provider: 'codex', model: 'gpt-6', status, attempt: 1, summary: '', files: [], dependsOn: [], startedAt: 100, updatedAt: 200, sessionId: `s-${id}`, ...extra });

test('task.team replies decode, the host shape and none', () => {
  const team = decodeTeam({ team: { sessionId: 'a', status: 'running', round: 2, mode: 'auto', rounds: { used: 2, max: 8 }, workers: [row('w1', 'running', { checkpoint: { summary: 'half', nextSteps: 'rest', blocker: null, updatedAt: 150 } }), row('bad', 'exploded')], messages: [{ id: 3, sender: 'w1', recipient: 'architect', message: 'hi', createdAt: 5 }] } });
  assert.ok(team);
  assert.deepEqual([team.mode, team.status, team.rounds, team.workers.length], ['auto', 'running', { used: 2 }, 1]);
  assert.deepEqual(team.workers[0].checkpoint, { summary: 'half', nextSteps: 'rest', blocker: null, updatedAt: 150_000 });
  assert.equal(team.workers[0].createdAt, 100_000); // seconds scaled
  assert.equal(decodeTeam({ team: null }), null);
  assert.equal(decodeTeam(undefined), null);
});

test('team events upsert the changed worker, and removal drops the team', () => {
  const team = decodeTeam({ team: { status: 'running', workers: [row('w1', 'running')] } });
  const done = applyTeamEvent(team, row('w1', 'completed', { summary: 'ok' }));
  assert.deepEqual([done?.workers[0].status, done?.workers[0].summary], ['completed', 'ok']);
  const added = applyTeamEvent(done, row('w2', 'queued'));
  assert.deepEqual(added?.workers.map(w => w.id), ['w1', 'w2']);
  assert.equal(added?.status, 'running');
  assert.equal(applyTeamEvent(added, { removed: true }), null);
  assert.equal(applyTeamEvent(team, 'junk'), team);
  assert.deepEqual(workerNames(added), { w1: 'W1', w2: 'W2' });
});

test('worker labels follow the desktop: Skipped, Paused when the team is idle', () => {
  const team = decodeTeam({ team: { status: 'completed', workers: [row('w1', 'running'), row('w2', 'failed', { abandoned: true }), row('w3', 'completed')] } });
  assert.ok(team);
  assert.deepEqual(team.workers.map(w => workerLabel(w, team)), ['Paused', 'Skipped', 'Completed']);
});

test('the demo team decodes with three workers in different states and a checkpoint', () => {
  const team = decodeTeam({ team: demoTeam(Date.now()) });
  assert.deepEqual(team?.workers.map(w => w.status), ['completed', 'running', 'failed']);
  assert.ok(team?.workers.some(w => w.checkpoint));
});

test('a parked worker reads as waiting on its sub-workers and stays active', () => {
  const team = decodeTeam({ team: { status: 'running', workers: [row('w1', 'parked')] } })!;
  assert.equal(team.workers[0].status, 'waiting');
  assert.equal(workerLabel(team.workers[0], team), 'Waiting on sub-workers');
  assert.equal(workerActive(team.workers[0]), true);
});

test('a parked worker in a failed or paused team reads as Paused, even after a worker event', () => {
  for (const status of ['failed', 'paused', 'interrupted']) {
    const team = decodeTeam({ team: { status, workers: [row('w1', 'parked'), row('w2', 'failed')] } })!;
    assert.equal(workerLabel(team.workers[0], team), 'Paused');
    const after = applyTeamEvent(team, row('w2', 'stopped'))!;
    assert.equal(after.status, status);
    assert.equal(workerLabel(after.workers[0], after), 'Paused');
  }
});

test('an older host\'s messages decode and add no note', () => {
  const team = decodeTeam({ team: { status: 'running', workers: [], messages: [{ id: 1, sender: 'a', recipient: 'b', message: 'm', createdAt: 1 }] } });
  assert.ok(team);
  assert.equal(cutNote(team, false), undefined);
});

test('a team says why it stopped and when Resume applies', () => {
  const team = (status: string, extra = {}) => decodeTeam({ team: { status, workers: [], ...extra } });
  assert.equal(team('paused', { error: 'PandaCode paused this team.' })!.error, 'PandaCode paused this team.');
  assert.equal(team('paused')!.error, undefined, 'older hosts send no error');
  assert.equal(team('running', { error: null })!.error, undefined);
  for (const status of ['paused', 'failed', 'interrupted']) assert.equal(teamResumable(team(status)), true, status);
  for (const status of ['running', 'waiting', 'completed', 'ready']) assert.equal(teamResumable(team(status)), false, status);
  assert.equal(teamResumable(null), false);
});

test('a team keeps every worker past the old cap', () => {
  const workers = Array.from({ length: 70 }, (_, i) => row(`w${i}`, 'running'));
  assert.equal(decodeTeam({ team: { status: 'running', workers } })!.workers.length, 70);
});

test('the round shows alone, whatever maximum a host sends', () => {
  const title = (rounds: unknown) => workersTitle(decodeTeam({ team: { status: 'running', rounds, workers: [] } })!);
  assert.equal(title({ used: 25, max: 8 }), 'Team workers · round 25');
  assert.equal(title({ used: 25, max: 0 }), 'Team workers · round 25');
  assert.equal(title({ used: 0, max: 0 }), 'Team workers');
});

test('the note shows only when a host cut something', () => {
  const team = (extra: Record<string, unknown>, workers: unknown[] = []) => decodeTeam({ team: { status: 'running', workers, ...extra } });
  assert.equal(cutNote(team({}, [row('w', 'running')]), undefined), undefined);
  assert.equal(cutNote('outdated', false), undefined);
  for (const cut of [team({ truncated: true }), team({ workersTruncated: true }), team({}, [row('w', 'running', { filesTruncated: true })])]) assert.match(cutNote(cut, undefined)!, /left out/);
  assert.match(cutNote(null, true)!, /left out/);
});

test('a worker\'s clock runs only while it and its team are active', () => {
  const NOW = 999_000;
  const clock = (status: string, workerStatus: string, extra = {}) => {
    const team = decodeTeam({ team: { status, workers: [row('w', workerStatus, extra)] } })!;
    return workerClockEnd(team.workers[0], team, NOW);
  };
  assert.equal(clock('running', 'running'), NOW);
  assert.equal(clock('waiting', 'parked'), NOW);
  for (const status of ['paused', 'failed', 'interrupted', 'completed']) assert.equal(clock(status, 'running'), 200_000, status);
  assert.equal(clock('running', 'completed'), 200_000);
  assert.equal(clock('running', 'running', { abandoned: true }), 200_000);
  assert.equal(clock('paused', 'running', { updatedAt: 0 }), NOW); // no time known: nothing better to show
});
