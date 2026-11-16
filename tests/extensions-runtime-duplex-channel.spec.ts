import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { DuplexChannel, MAX_FRAME_BYTES, MAX_PENDING, RATE_PER_SECOND, RATE_WINDOW_MS, answerFrame, callFrame, classify, decode, encode } from '../src/extensions/runtime-duplex-channel';

// Preview column of R0201 (the duplex channel of background services). These checks run the deterministic model in
// src/extensions/runtime-duplex-channel.ts, which mirrors src-tauri/src/extensions/runtime_duplex_channel.rs. The
// real installed process (B1-free fixture service under the pinned runtime) is the native test
// `runtime_service_lifetime::tests::installed::duplex_*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-duplex-channel/extension.json'));
const accepted = (value: unknown) => validateContract('packages', [value]);

test('extensions duplex channel: a service package needs no activationEvents, and a listed one must still match its commands', () => {
  expect(manifest.runtime.activationEvents).toBeUndefined();
  expect(accepted(manifest).ok).toBe(true);
  const listed = structuredClone(manifest); listed.runtime.activationEvents = ['sample.duplex-channel/echo', 'sample.duplex-channel/other'];
  expect(accepted(listed).ok).toBe(true);
  const partial = structuredClone(manifest); partial.runtime.activationEvents = ['sample.duplex-channel/echo'];
  expect(accepted(partial)).toMatchObject({ ok: false, error: { code: 'UnsupportedRuntime' } });
  const foreign = structuredClone(manifest); foreign.runtime.activationEvents = ['sample.duplex-channel/echo', 'sample.duplex-channel/other', 'sample.duplex-channel/missing'];
  expect(accepted(foreign)).toMatchObject({ ok: false, error: { code: 'UnsupportedRuntime' } });
  // Retained refusals (Q120): without a service the events stay required, and a service stays a named permission.
  const noService = structuredClone(manifest); delete noService.runtime.service;
  expect(accepted(noService)).toMatchObject({ ok: false, error: { code: 'UnsupportedRuntime' } });
  const undeclared = structuredClone(manifest); undeclared.permissions = ['ui.contribute'];
  expect(accepted(undeclared)).toMatchObject({ ok: false, error: { code: 'PermissionDenied' } });
  const lazy = JSON.parse(read('tests/fixtures/extensions/project-summary/extension.json'));
  expect(accepted(lazy).ok).toBe(true);
  expect(read('src/extensions/schema-v1.json')).toContain('"required": ["kind", "entrypoint"]');
});

type Settled = { code: string | null; value?: unknown };
/** A recording service and host on a virtual clock: nothing waits for anything else, replies arrive out of order. */
function simulation() {
  const channel = new DuplexChannel<(settled: Settled) => void>();
  const events: string[] = [];
  const queue: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  const later = (delay: number, run: () => void) => queue.push({ at: now + delay, run });
  const drain = () => { while (queue.length) { queue.sort((a, b) => a.at - b.at); const next = queue.shift()!; now = next.at; next.run(); } };
  const call = (tag: string, serviceMs: number, hostRequestMs = 0) => {
    const begun = channel.beginCall(now, settled => events.push(`${now}: call ${tag} settled ${settled.code ?? 'ok'}`));
    if ('code' in begun) { events.push(`${now}: call ${tag} refused ${begun.code}`); return begun; }
    const frame = callFrame(begun.id, 'command', { commandId: 'sample.duplex-channel/echo', args: { tag } });
    expect(encode(frame as never)).toHaveProperty('bytes');
    events.push(`${now}: host -> service call ${begun.id} ${tag}`);
    // The service handles the call: it may ask the host something while the host's other calls keep arriving.
    const finish = () => later(serviceMs, () => channel.settle(begun.id)?.({ code: null, value: tag }));
    if (hostRequestMs) {
      const requestId = begun.id * 10;
      expect(channel.beginRequest(requestId, now)).toBeNull();
      events.push(`${now}: service -> host request ${requestId} (${tag})`);
      later(hostRequestMs, () => { channel.finishRequest(requestId); events.push(`${now}: host answered request ${requestId} (${tag})`); finish(); });
    } else finish();
    return begun;
  };
  return { channel, events, call, drain, at: () => now, advance: (ms: number) => { now += ms; } };
}

test('extensions duplex channel: two requests interleave in either direction without waiting for each other', () => {
  const sim = simulation();
  // A is slow and asks the host (200 ms) while B and C, started afterwards, finish first: replies are out of order.
  const a = sim.call('A', 50, 200);
  sim.advance(10);
  const b = sim.call('B', 20);
  sim.advance(10);
  const c = sim.call('C', 5, 30);
  expect([a, b, c]).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(sim.channel.pendingCalls()).toBe(3);
  expect(sim.channel.pendingRequests()).toBe(2);
  sim.drain();
  const settled = sim.events.filter(event => event.includes('settled')).map(event => event.split(' ')[2]);
  expect(settled).toEqual(['B', 'C', 'A']);
  expect(sim.events).toContain('250: call A settled ok');
  expect(sim.channel.pendingCalls()).toBe(0);
  expect(sim.channel.pendingRequests()).toBe(0);
  // The wire shapes of both directions.
  expect(callFrame(7, 'command', { commandId: 'a/b', args: { n: 1 } })).toEqual({ call: { id: 7, method: 'command', params: { commandId: 'a/b', args: { n: 1 } } } });
  expect(answerFrame(4, { ok: true, value: null })).toEqual({ id: 4, reply: { ok: true, value: null } });
  expect(classify({ schemaVersion: 1, token: 't', reply: { id: 2, ok: true, value: 'B' } })).toMatchObject({ kind: 'reply', id: 2, result: { ok: true, value: 'B' } });
  expect(classify({ schemaVersion: 1, token: 't', id: 9, method: 'context', params: { op: 'query' } })).toMatchObject({ kind: 'request', id: 9, method: 'context' });
});

test('extensions duplex channel: the 2 MiB frame, 64 pending calls and 200 requests per second over 10 s each refuse deterministically', () => {
  // Frame boundary: exactly 2 MiB fits, one byte more is LimitExceeded, and the length is refused before any body.
  const overhead = JSON.stringify({ v: '' }).length;
  const exact = encode({ v: 'x'.repeat(MAX_FRAME_BYTES - overhead) });
  expect(exact).toHaveProperty('bytes');
  expect((exact as { bytes: Uint8Array }).bytes.length).toBe(MAX_FRAME_BYTES + 4);
  expect(encode({ v: 'x'.repeat(MAX_FRAME_BYTES - overhead + 1) })).toEqual({ code: 'LimitExceeded' });
  const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true);
  expect(decode(header)).toEqual({ code: 'LimitExceeded' });
  expect(decode(new Uint8Array(4))).toEqual({ code: 'LimitExceeded' });
  expect(decode((exact as { bytes: Uint8Array }).bytes)).toHaveProperty('value');
  expect(decode(new Uint8Array([1, 0]))).toEqual({ code: 'HostUnavailable' });

  // 64 pending per direction; each settle frees one slot.
  const pending = new DuplexChannel<number>();
  for (let index = 0; index < MAX_PENDING; index += 1) expect(pending.beginCall(0, index)).toEqual({ id: index + 1 });
  expect(pending.beginCall(0, 99)).toEqual({ code: 'LimitExceeded' });
  for (let id = 1; id <= MAX_PENDING; id += 1) expect(pending.beginRequest(id, 0)).toBeNull();
  expect(pending.beginRequest(65, 0)).toBe('LimitExceeded');
  expect(pending.settle(3)).toBe(2);
  expect(pending.beginCall(0, 100)).toEqual({ id: MAX_PENDING + 1 });
  expect(pending.finishRequest(1)).toBe(true);
  expect(pending.beginRequest(65, 0)).toBeNull();

  // 200 per second averaged over 10 s is 2000 per window, per direction; the window slides.
  const budget = RATE_PER_SECOND * (RATE_WINDOW_MS / 1000);
  const rate = new DuplexChannel<number>();
  for (let index = 0; index < budget; index += 1) {
    const begun = rate.beginCall(index / 4, index) as { id: number }; rate.settle(begun.id);
    expect(rate.beginRequest(index, index / 4)).toBeNull(); rate.finishRequest(index);
  }
  expect(rate.beginCall(600, 0)).toEqual({ code: 'LimitExceeded' });
  expect(rate.beginRequest(budget, 600)).toBe('LimitExceeded');
  expect(rate.beginCall(RATE_WINDOW_MS, 0)).toHaveProperty('id');
  expect(rate.beginRequest(budget + 1, RATE_WINDOW_MS)).toBeNull();
});

test('extensions duplex channel: a late, repeated, forged or malformed id cannot resolve another call', () => {
  const channel = new DuplexChannel<string>();
  const ids = ['a', 'b', 'c'].map(name => (channel.beginCall(0, name) as { id: number }).id);
  expect(channel.settle(ids[1])).toBe('b');
  expect(channel.settle(ids[1])).toBeUndefined();
  expect(channel.settle(0)).toBeUndefined();
  expect(channel.settle(4)).toBeUndefined();
  expect(channel.settle(-1)).toBeUndefined();
  expect(channel.settle(Number.NaN)).toBeUndefined();
  expect(channel.pendingCalls()).toBe(2);
  // A duplicate request id in flight is refused and does not disturb the first.
  expect(channel.beginRequest(7, 0)).toBeNull();
  expect(channel.beginRequest(7, 0)).toBe('InvalidShape');
  expect(channel.pendingRequests()).toBe(1);
  for (const bad of [
    null, [], { token: 't', id: 1, method: 'm', params: null },
    { schemaVersion: 1, token: 't', reply: { id: '5', ok: true, value: null } },
    { schemaVersion: 1, token: 't', reply: { id: 5, ok: true } },
    { schemaVersion: 1, token: 't', reply: { id: 5, ok: true, value: null, extra: 1 } },
    { schemaVersion: 1, token: 't', reply: { id: 5, ok: 'yes', value: null } },
    { schemaVersion: 1, token: 't', reply: { id: 5, ok: false, value: null } },
    { schemaVersion: 1, token: 't', reply: { id: -1, ok: true, value: null } },
    { schemaVersion: 1, token: 't', reply: { id: 5, ok: true, value: null }, id: 9 },
    { schemaVersion: 1, token: 't', id: 1, method: 'm' },
    { schemaVersion: 1, token: 't', id: 1.5, method: 'm', params: null },
    { schemaVersion: 1, token: 7, id: 1, method: 'm', params: null },
  ]) expect(classify(bad), JSON.stringify(bad)).toBeNull();
  expect(classify({ schemaVersion: 1, token: 't', reply: { id: 5, ok: false, error: { code: 'not a code!' } } })).toMatchObject({ result: { ok: false, code: 'HostUnavailable' } });
});

test('extensions duplex channel: disconnect settles every outstanding call and leaves no handler or pending id', () => {
  const sim = simulation();
  sim.call('A', 1000, 500); sim.call('B', 1000); sim.call('C', 1000, 100);
  expect(sim.channel.pendingCalls()).toBe(3);
  // Disable, trust loss and a crash all end in the same settlement, oldest first.
  const outstanding = sim.channel.settleAll();
  expect(outstanding.map(([id]) => id)).toEqual([1, 2, 3]);
  for (const [, settle] of outstanding) settle({ code: 'Cancelled' });
  expect(sim.events.filter(event => event.includes('settled Cancelled'))).toHaveLength(3);
  expect(sim.channel.pendingCalls()).toBe(0);
  // Later replies of the dead connection resolve nothing; the queued completions find no waiter.
  sim.drain();
  expect(sim.events.filter(event => event.includes('settled ok'))).toHaveLength(0);
  expect(sim.channel.settleAll()).toEqual([]);
});
