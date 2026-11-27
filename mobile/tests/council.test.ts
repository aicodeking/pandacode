/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  councilActions, councilCardShown, councilNotice, councilOn, councilSeats, councilStateText, councilView, COUNCIL_DEFAULTS,
  decodeTeam, formatScore, KEEP_FIXING, lowestSeat, outOfTen, seatVerdict, teamWorkers,
  type CouncilState, type Team,
} from '../src/store/team.ts';
import { demoTeam } from '../src/demo-team.ts';

const NOW = 1_800_000_000_000;

/** A team as the host sends it, with Council turned on in `state`. */
function team(state: CouncilState, extra: Record<string, unknown> = {}, workers: unknown[] = []): Team {
  return decodeTeam({
    status: 'ready', rounds: { used: 2 },
    council: { target: 9, maxRounds: 10, reviewers: 3 },
    councilStatus: { state, round: 2, lowest: 8.25, target: 9, stale: false, ...extra },
    workers,
  })!;
}

test('a host that predates Council, and one with it off, both read as no Council', () => {
  // An older host sends neither field at all.
  const old = decodeTeam({ status: 'ready', rounds: { used: 1 }, workers: [] })!;
  assert.equal(councilOn(old), false);
  assert.equal(councilView(old), null);
  assert.equal(councilCardShown(old), false);
  assert.deepEqual(councilActions(old), { keep: false, accept: false, lower: false, raise: false });
  // A newer host with Council off sends explicit nulls.
  const off = decodeTeam({ status: 'ready', rounds: { used: 1 }, council: null, councilStatus: null, councilAccepted: false, workers: [] })!;
  assert.equal(off.council, null);
  assert.equal(councilOn(off), false);
  assert.equal(councilView(off), null);
});

test('a Council snapshot decodes its setting, state and seats', () => {
  const decoded = team('reviewing', {}, [{ id: 'w1', name: 'W', status: 'completed' }, { id: 'c1', name: 'Security', status: 'completed', council: { round: 2, lens: 'Security', score: 8.25, startedAt: NOW } }])!;
  assert.deepEqual(decoded.council, { target: 9, maxRounds: 10, reviewers: 3 });
  assert.deepEqual(decoded.councilStatus, { state: 'reviewing', round: 2, lowest: 8.25, target: 9, stale: false });
  // Only an accepted cycle carries the flag, so an absent one reads as "not accepted".
  assert.ok(!decoded.councilAccepted);
  assert.equal(decoded.workers[0].council, undefined, 'an ordinary worker has no seat');
  assert.deepEqual(decoded.workers[1].council, { round: 2, lens: 'Security', score: 8.25, startedAt: NOW });
});

test('an unknown Council state is dropped rather than printed', () => {
  const decoded = decodeTeam({ status: 'ready', workers: [], council: { target: 9, maxRounds: 10, reviewers: 0 }, councilStatus: { state: 'nonsense', round: 1, lowest: null, target: 9, stale: false } })!;
  // The setting still reads (Council is on), but there is no state to act on.
  assert.ok(decoded.council);
  assert.equal(decoded.councilStatus, undefined);
  assert.equal(councilView(decoded), null);
});

test('a malformed council block never drops the team', () => {
  const decoded = decodeTeam({ status: 'ready', rounds: { used: 1 }, council: 'nope', councilStatus: 42, workers: [{ id: 'w', name: 'W', status: 'running' }] })!;
  assert.equal(decoded.status, 'ready');
  assert.equal(decoded.workers.length, 1);
  assert.equal(decoded.council, undefined);
  assert.equal(decoded.councilStatus, undefined);
});

test('scores always print one decimal, as the desktop shows them', () => {
  assert.equal(formatScore(9), '9.0');
  assert.equal(formatScore(8.25), '8.3');
  assert.equal(formatScore(9.95), '10.0');
  assert.equal(outOfTen(9.6, 9.5), '9.6 of 10 (target 9.5)');
});

test('the state reads in words, and asking names the lowest score', () => {
  assert.equal(councilStateText(team('asking').councilStatus!, 10), 'Needs you · lowest 8.3 of 10 (target 9.0)');
  assert.equal(councilStateText(team('reviewing').councilStatus!, 10), 'Round 2 of 10 · reviewing');
  assert.equal(councilStateText(team('fixing').councilStatus!, 10), 'Round 2 of 10 · fixing');
  assert.equal(councilStateText(team('passed').councilStatus!, 10), 'Passed at 9.0');
  assert.equal(councilStateText(team('limit').councilStatus!, 3), 'Stopped at round limit (2 of 3)');
  assert.equal(councilStateText(team('accepted').councilStatus!, 10), 'Accepted at 8.3');
});

test('the card is silent until a round ran or the lead asks', () => {
  const fresh = decodeTeam({ status: 'ready', workers: [], council: { target: 9, maxRounds: 10, reviewers: 0 }, councilStatus: { state: 'waiting', round: 0, lowest: null, target: 9, stale: false } })!;
  assert.equal(councilCardShown(fresh), false, 'nothing has reviewed yet');
  assert.equal(councilCardShown(team('reviewing')), true);
  assert.equal(councilCardShown(team('asking')), true);
});

test('asking offers Keep fixing, Lower target and Accept, never Raise', () => {
  const asking = team('asking');
  assert.deepEqual(councilActions(asking), { keep: true, accept: true, lower: true, raise: false });
  // The lead is asking for a decision, so an accepted cycle stops offering anything.
  const accepted = decodeTeam({ status: 'ready', workers: [], council: { target: 9, maxRounds: 10, reviewers: 0 }, councilStatus: { state: 'accepted', round: 2, lowest: 8.3, target: 9, stale: false }, councilAccepted: true })!;
  assert.deepEqual(councilActions(accepted), { keep: false, accept: false, lower: false, raise: false });
});

test('only a lead that asked offers buttons, exactly as the desktop strip', () => {
  // src/council-panel.ts stripHtml shows no button while fixing or reviewing: the lead carries on by
  // itself, and the desktop's own hint is "Send a message to continue." Steering is a normal message.
  assert.deepEqual(councilActions(team('fixing')), { keep: false, accept: false, lower: false, raise: false });
  assert.deepEqual(councilActions(team('reviewing')), { keep: false, accept: false, lower: false, raise: false });
  assert.deepEqual(councilActions(team('dispatch')), { keep: false, accept: false, lower: false, raise: false });
});

test('the round limit offers raising it only while a higher step exists, and a pass offers nothing', () => {
  const limit = team('limit', { round: 10 });
  assert.deepEqual(councilActions(limit), { keep: false, accept: false, lower: false, raise: true });
  // 25 is the desktop's highest limit, so nothing is left to raise to.
  assert.deepEqual(councilActions(team('limit', { round: 25 })).raise, false);
  assert.deepEqual(councilActions(team('passed')), { keep: false, accept: false, lower: false, raise: false });
});

test('seats are the latest round only, and a reviewer is not a worker', () => {
  const decoded = team('reviewing', {}, [
    { id: 'w1', name: 'Writer', status: 'completed' },
    { id: 'c1', name: 'A', status: 'completed', council: { round: 1, lens: 'Old', score: 7, startedAt: NOW } },
    { id: 'c2', name: 'B', status: 'completed', council: { round: 2, lens: 'Security', score: 8.25, startedAt: NOW } },
    { id: 'c3', name: 'C', status: 'completed', council: { round: 2, lens: 'Correctness', score: 9.5, startedAt: NOW } },
    { id: 'c4', name: 'D', status: 'stopped', abandoned: true, council: { round: 2, lens: 'Dropped', score: 1, startedAt: NOW } },
  ])!;
  assert.deepEqual(councilSeats(decoded).map(s => s.council.lens), ['Correctness', 'Security'], 'latest round, dropped seats left out, in lens order');
  assert.deepEqual(teamWorkers(decoded.workers).map(w => w.id), ['w1'], 'reviewers are not drawn as workers');
  assert.equal(lowestSeat(councilSeats(decoded)), 8.25);
});

test('a seat verdict says at target or below it, with one decimal', () => {
  assert.deepEqual(seatVerdict({ round: 1, lens: 'A', score: 9.5, startedAt: 0 }, 9), { tone: 'at', text: '9.5 of 10 · at target' });
  assert.deepEqual(seatVerdict({ round: 1, lens: 'A', score: 8.25, startedAt: 0 }, 9), { tone: 'below', text: '8.3 of 10 · below 9.0' });
  assert.deepEqual(seatVerdict({ round: 1, lens: 'A', score: null, startedAt: 0 }, 9), { tone: 'none', text: 'Not scored yet' });
});

test('Council\'s notice is the user\'s sentence, never the lead\'s refusal prose', () => {
  assert.equal(councilNotice(team('asking', { notice: 'The team stopped after round 2: lowest score 8.0, target 9.0.' })), 'The team stopped after round 2: lowest score 8.0, target 9.0.');
  // No notice from the host: a plain line of our own.
  assert.equal(councilNotice(team('asking')), 'The lead is asking how to continue.');
  assert.equal(councilNotice(team('reviewing')), null);
  assert.equal(councilNotice(undefined), null);
});

test('Keep fixing is the desktop\'s own prompt', () => {
  assert.equal(KEEP_FIXING, 'Keep fixing until every reviewer reaches the target.');
});

test('the demo team shows Council asking, so the Accept card is reachable offline', () => {
  const demo = decodeTeam({ team: demoTeam(NOW) })!;
  assert.equal(councilOn(demo), true);
  assert.equal(demo.councilStatus?.state, 'asking');
  assert.equal(councilCardShown(demo), true);
  const seatIds = councilSeats(demo).map(s => s.id);
  assert.deepEqual(seatIds, ['c-correctness', 'c-security', 'c-ux'], 'the demo reviewers are seats, in lens order');
  // The demo's own workers stay workers.
  assert.deepEqual(teamWorkers(demo.workers).map(w => w.id), ['w-host', 'w-mobile', 'w-review']);
  assert.deepEqual(councilActions(demo), { keep: true, accept: true, lower: true, raise: false });
  assert.equal(COUNCIL_DEFAULTS.target, 9);
});
