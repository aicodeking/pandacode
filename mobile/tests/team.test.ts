/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { demoTeam } from '../src/demo-team.ts';
import { applyTeamEvent, decodeTeam, memberName, workerLabel, workerNames } from '../src/store/team.ts';

const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), provider: 'codex', model: 'gpt-6', status, attempt: 1, summary: '', files: [], dependsOn: [], startedAt: 100, updatedAt: 200, sessionId: `s-${id}`, ...extra });

test('task.team replies decode, the host shape and none', () => {
  const team = decodeTeam({ team: { sessionId: 'a', status: 'running', round: 2, mode: 'auto', rounds: { used: 2, max: 8 }, workers: [row('w1', 'running', { checkpoint: { summary: 'half', nextSteps: 'rest', blocker: null, updatedAt: 150 } }), row('bad', 'exploded')], messages: [{ id: 3, sender: 'w1', recipient: 'architect', message: 'hi', createdAt: 5 }] } });
  assert.ok(team);
  assert.deepEqual([team.mode, team.status, team.rounds, team.workers.length], ['auto', 'running', { used: 2, max: 8 }, 1]);
  assert.deepEqual(team.workers[0].checkpoint, { summary: 'half', nextSteps: 'rest', blocker: null, updatedAt: 150_000 });
  assert.equal(team.workers[0].createdAt, 100_000); // seconds scaled
  assert.equal(memberName(team, 'w1'), 'W1');
  assert.equal(memberName(team, 'architect'), 'Architect');
  assert.deepEqual(team.messages.map(m => m.message), ['hi']);
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
