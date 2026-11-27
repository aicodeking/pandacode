/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_HANDLERS } from '../src/demo/index.ts';
import type { ConnectState } from '../src/store/index.ts';

const NOW = 1_800_000_000_000;

/** The demo `rooms` handlers over plain state, exercised through DEMO_HANDLERS as the host does.
 *  The demo keeps rooms per device, so each test names its own device to seed fresh. */
function ctx(state?: Partial<ConnectState>, deviceId = 'mac') {
  let now = NOW;
  const base = {
    configured: false, ready: true, signedIn: true, connected: true, account: null, deviceId: 'phone', error: null, demo: true, older: {}, teams: {},
    devices: [], tasks: {}, messages: {}, history: {}, sent: {}, live: {}, providers: {}, models: {}, pulls: {}, outdated: {},
    bots: { mac: [
      { id: 'b1', name: 'Leo', avatar: null, state: 'ready', paused: false, desktopSession: 's1', projectId: 'p1' },
      { id: 'b2', name: 'Nova', avatar: null, state: 'ready', paused: false, desktopSession: 's2', projectId: 'p2' },
      { id: 'b3', name: 'Ada', avatar: null, state: 'ready', paused: false, desktopSession: 's3', projectId: 'p3' },
    ] },
    ...state,
  } as unknown as ConnectState;
  const call = (method: string, params: Record<string, unknown> = {}) => {
    const handler = DEMO_HANDLERS.get(method);
    assert.ok(handler, `${method} has a demo handler`);
    return handler!({ host: { get: () => base, set: () => {}, later: () => {}, now: () => now }, deviceId, state: base, reply: () => {} }, params) as any;
  };
  return { call, tick: (ms = 60_000) => { now += ms; } };
}

test('every rooms method has a demo handler', () => {
  for (const method of ['rooms.list', 'rooms.messages', 'rooms.post']) assert.ok(DEMO_HANDLERS.has(method), method);
});

test('rooms.list seeds rooms from the computer\'s bots and carries members', () => {
  const { call } = ctx();
  const { rooms } = call('rooms.list');
  assert.ok(rooms.length >= 2);
  const launch = rooms.find((room: any) => room.name === 'launch');
  assert.deepEqual(launch.memberIds, ['b1', 'b2', 'b3']);
  assert.equal(launch.leadBotId, 'b1');
  // A list row is a summary: the timeline lives in rooms.messages.
  assert.equal(launch.messages, undefined);
});

test('rooms.messages returns a bounded page and says when more exist', () => {
  const { call } = ctx();
  const full = call('rooms.messages', { channelId: 'room-launch' });
  assert.ok(full.messages.length > 0);
  assert.equal(full.hasMore, false);
  const page = call('rooms.messages', { channelId: 'room-launch', limit: 2 });
  assert.equal(page.messages.length, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map((m: any) => m.id), full.messages.slice(-2).map((m: any) => m.id));
  assert.throws(() => call('rooms.messages', { channelId: 'nope' }), /no longer exists/);
  assert.throws(() => call('rooms.messages', {}), /Missing channelId/);
});

test('a post appends the post and routes it to the lead, then to a named member', () => {
  const { call } = ctx();
  const before = call('rooms.messages', { channelId: 'room-launch' }).messages.length;
  assert.deepEqual(call('rooms.post', { channelId: 'room-launch', text: 'Ship it?' }), { posted: true });
  const after = call('rooms.messages', { channelId: 'room-launch' });
  assert.equal(after.messages.length, before + 2, 'the post and its assignment row');
  const post = after.messages.at(-2);
  assert.deepEqual([post.kind, post.text, post.authorBotId], ['user', 'Ship it?', null]);
  assert.equal(after.messages.at(-1).authorBotId, 'b1', 'the lead got it');
  // A named member wins over the lead; the posted text is trimmed.
  call('rooms.post', { channelId: 'room-launch', text: '  Nova, take this  ', recipients: ['b3'] });
  const named = call('rooms.messages', { channelId: 'room-launch' });
  assert.equal(named.messages.at(-1).authorBotId, 'b3');
  assert.equal(named.messages.at(-2).text, 'Nova, take this');
});

test('a blank post and an unknown room are refused rather than stored', () => {
  const { call } = ctx();
  assert.throws(() => call('rooms.post', { channelId: 'room-launch', text: '   ' }), /Write a room message/);
  assert.throws(() => call('rooms.post', { channelId: 'nope', text: 'hi' }), /no longer exists/);
  assert.throws(() => call('rooms.post', { text: 'hi' }), /Missing channelId/);
});

test('a computer with fewer than two bots has no rooms to show', () => {
  const { call } = ctx({ bots: { mac: [{ id: 'b1', name: 'Solo', avatar: null, state: 'ready', paused: false, desktopSession: 's', projectId: 'p' }] } } as any, 'solo');
  assert.deepEqual(call('rooms.list').rooms, []);
});
