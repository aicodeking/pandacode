/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { planPull, pullCurrent, type PullFlight } from '../src/store/git.ts';

test('an unforced call answers from the cache, else joins the fetch in flight, else starts one', () => {
  assert.deepEqual(planPull(true, false, undefined), { kind: 'cached' });
  assert.deepEqual(planPull(true, false, { generation: 3, running: true }), { kind: 'cached' });
  assert.deepEqual(planPull(false, false, { generation: 3, running: true }), { kind: 'join' });
  assert.deepEqual(planPull(false, false, undefined), { kind: 'fetch', generation: 1 });
  assert.deepEqual(planPull(false, false, { generation: 3, running: false }), { kind: 'fetch', generation: 4 });
});

test('a forced call always starts a new fetch with a newer generation, even with one in flight', () => {
  assert.deepEqual(planPull(true, true, undefined), { kind: 'fetch', generation: 1 });
  assert.deepEqual(planPull(false, true, { generation: 2, running: true }), { kind: 'fetch', generation: 3 });
  assert.deepEqual(planPull(true, true, { generation: 2, running: false }), { kind: 'fetch', generation: 3 });
});

test('only the newest fetch writes the cache', () => {
  assert.equal(pullCurrent(1, undefined), false);
  assert.equal(pullCurrent(2, { generation: 2 }), true);
  assert.equal(pullCurrent(1, { generation: 2 }), false);
});

/** loadPull's decisions over a fake host, as client.ts runs them. */
function fakeCache() {
  const flights = new Map<string, { generation: number; run?: Promise<string> }>();
  const cache = new Map<string, string>();
  const pending: Array<{ resolve: (value: string) => void }> = [];
  const load = (key: string, force = false): Promise<string> => {
    const flight = flights.get(key);
    const view: PullFlight | undefined = flight && { generation: flight.generation, running: !!flight.run };
    const plan = planPull(cache.has(key), force, view);
    if (plan.kind === 'cached') return Promise.resolve(cache.get(key)!);
    if (plan.kind === 'join' && flight?.run) return flight.run;
    const generation = plan.kind === 'fetch' ? plan.generation : 0;
    const run = new Promise<string>(resolve => pending.push({ resolve })).then(pull => {
      if (pullCurrent(generation, flights.get(key))) {
        cache.set(key, pull);
        flights.set(key, { generation });
      }
      return pull;
    });
    flights.set(key, { generation, run });
    return run;
  };
  return { load, cache, pending };
}

test('a fetch begun before a merge never overwrites the forced refresh after it', async () => {
  const { load, cache, pending } = fakeCache();
  const before = load('t');
  assert.equal(load('t'), before, 'an unforced call joins');
  const after = load('t', true);
  assert.notEqual(after, before, 'the forced call does not reuse the earlier fetch');
  pending[1].resolve('merged');
  assert.equal(await after, 'merged');
  pending[0].resolve('open');
  await before;
  assert.equal(cache.get('t'), 'merged', 'the stale reply is dropped');
  assert.equal(await load('t'), 'merged');
});
