/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Method } from '../src/connect/rpc.ts';
import type { DemoHost } from '../src/demo-host.ts';
import type { ConnectState } from '../src/store/index.ts';
import { AUTO_TEAM, parseRoster, pickedTeam, teamChoices, teamStartParams, teamSummary, TEAM_METHODS } from '../src/connect/api/team.ts';

const NOW = new Date(2026, 10, 9, 14, 0).getTime();
const ROSTER = parseRoster({
  harnesses: [{ id: 'claude', name: 'Claude Code', models: 4 }, { id: 'codex', name: 'Codex', models: 2 }],
  teams: [{ id: 'crew', name: 'Review crew', auto: false, workers: 3, lead: { provider: 'claude', model: 'opus' } }],
});

test('team methods are registered', () => {
  assert.deepEqual([...TEAM_METHODS], ['team.start', 'team.roster']);
});

test('the roster keeps only well-formed rows', () => {
  assert.deepEqual(parseRoster(null), { harnesses: [], teams: [] });
  const parsed = parseRoster({ harnesses: [{ id: 'kimi', models: -3 }, { name: 'no id' }, 7], teams: [{ id: 't', name: '' }, { id: 'ok', name: 'Ok', workers: 2.7, auto: 'yes' }] });
  assert.deepEqual(parsed.harnesses, [{ id: 'kimi', name: 'kimi', models: 0 }]);
  assert.deepEqual(parsed.teams, [{ id: 'ok', name: 'Ok', auto: false, workers: 2, lead: { provider: '', model: '' } }]);
});

test('the picker offers Auto, then named teams; a gone team falls back to Auto', () => {
  assert.deepEqual(teamChoices(null), [{ value: AUTO_TEAM, label: 'Auto' }]);
  assert.deepEqual(teamChoices(ROSTER).map(c => c.value), [AUTO_TEAM, 'crew']);
  assert.equal(pickedTeam(ROSTER, 'crew'), 'crew');
  assert.equal(pickedTeam(ROSTER, 'gone'), AUTO_TEAM);
  assert.equal(pickedTeam(null, 'crew'), AUTO_TEAM);
  assert.equal(teamSummary(ROSTER, AUTO_TEAM), 'Your model leads · workers from Claude Code, Codex');
  assert.equal(teamSummary(ROSTER, 'crew'), 'Review crew · 3 workers');
  assert.equal(teamSummary(null, AUTO_TEAM), 'Your model leads and picks worker models');
});

test('team.start params: Auto or a named team, empty options dropped, form untouched', () => {
  const form = Object.freeze({ projectId: 'p1', prompt: '  Build it \n', provider: 'claude', model: 'opus', mode: '', effort: 'high', imageIds: [] as string[] });
  assert.deepEqual(teamStartParams(form, AUTO_TEAM), { projectId: 'p1', prompt: 'Build it', provider: 'claude', model: 'opus', effort: 'high', auto: true });
  assert.deepEqual(teamStartParams({ ...form, mode: 'edit', imageIds: ['i1'] }, 'crew'), { projectId: 'p1', prompt: 'Build it', provider: 'claude', model: 'opus', mode: 'edit', effort: 'high', imageIds: ['i1'], auto: false, profileId: 'crew' });
  assert.equal(form.prompt, '  Build it \n');
});

test('the demo starts a team task and lists its roster', async () => {
  const { demoCall } = await import('../src/demo-host.ts');
  let state = {
    devices: [{ id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { studio: { tasks: [], projects: [{ id: 'pandacode', name: 'pandacode', repo: null }], loadedAt: 0 } },
    providers: { studio: [{ id: 'claude', name: 'Claude Code', installed: true, models: [{ id: 'opus', name: 'Opus' }] }, { id: 'kimi', name: 'Kimi', installed: false, models: [] }] },
    messages: {}, live: {}, outdated: {}, sent: {}, bots: {}, teams: {},
  } as unknown as ConnectState;
  const later: (() => void)[] = [];
  const host: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: run => { later.push(run); }, now: () => NOW };
  const call = (method: string, params: object = {}) => demoCall(host, 'studio', method as Method, params) as Promise<any>;

  const roster = parseRoster(await call('team.roster'));
  assert.deepEqual(roster.harnesses, [{ id: 'claude', name: 'Claude Code', models: 1 }]);
  assert.equal(roster.teams[0]?.id, 'review-crew');

  const { sessionId } = await call('team.start', teamStartParams({ projectId: 'pandacode', prompt: 'Ship the team view', provider: 'claude', model: 'opus' }, AUTO_TEAM));
  const task = state.tasks.studio.tasks.find(t => t.sessionId === sessionId);
  assert.equal(task?.projectId, 'pandacode');
  assert.equal(task?.model, 'opus');
  assert.deepEqual(task?.team, { status: 'running', activeWorkers: 0 });

  const named = await call('team.start', teamStartParams({ projectId: 'pandacode', prompt: 'Review', provider: 'codex', model: 'gpt' }, 'review-crew'));
  assert.equal(state.tasks.studio.tasks.find(t => t.sessionId === named.sessionId)?.provider, 'claude', 'a named team brings its lead');
  await assert.rejects(call('team.start', { projectId: 'nope', prompt: 'x', provider: 'claude', model: 'opus' }), /no longer on this computer/);
  await assert.rejects(call('team.start', { projectId: 'pandacode', prompt: ' ', provider: 'claude', model: 'opus' }), /Missing prompt/);
  await assert.rejects(call('team.start', { projectId: 'pandacode', prompt: 'x', provider: 'claude', model: 'opus', auto: false, profileId: 'gone' }), /team is no longer/);
});
