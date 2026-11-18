/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  ANSWER_MS, BACKGROUND_MS, CONNECT_MS, PING_MS, PROBE_MS, RelayConnection,
  type ConnectionQuality, type SocketEnv, type SocketHandlers, type SocketLike,
} from '../src/connect/relay-socket.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(text: string) { this.sent.push(text); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
  accept() { this.readyState = 1; this.onopen?.({}); }
  receive(data: string) { this.onmessage?.({ data }); }
  fail(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function harness(random = 0.5) {
  const sockets: FakeSocket[] = [];
  let appState = 'active';
  let appListener: (state: string) => void = () => {};
  const env: SocketEnv = {
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    appState: () => appState,
    onAppState: listener => { appListener = listener; return { remove() {} }; },
    random: () => random,
  };
  const events: string[] = [];
  const handlers: SocketHandlers = {
    token: () => 'tok',
    url: () => 'wss://relay.test/v1/socket?host=0',
    onOpen: () => events.push('open'),
    onClose: () => events.push('close'),
    onText: text => events.push(`text:${text}`),
    onRefused: () => events.push('refused'),
  };
  const socket = new RelayConnection(handlers, env);
  const qualities: ConnectionQuality[] = [];
  socket.subscribeQuality(q => qualities.push(q));
  const setApp = (state: string) => { appState = state; appListener(state); };
  return { socket, sockets, events, qualities, setApp, last: () => sockets[sockets.length - 1] };
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test('a ping answered in time keeps the socket and records the round trip', () => {
  const h = harness();
  h.socket.start();
  h.last().accept();
  assert.equal(h.socket.quality.state, 'open');
  mock.timers.tick(PING_MS);
  assert.deepEqual(h.last().sent, ['ping']);
  mock.timers.tick(120);
  h.last().receive('pong');
  assert.equal(h.socket.quality.rttMs, 120);
  mock.timers.tick(ANSWER_MS);
  assert.equal(h.sockets.length, 1, 'no reconnect');
  assert.equal(h.socket.quality.failures, 0);
  h.socket.dispose();
});

test('any frame answers a ping', () => {
  const h = harness();
  h.socket.start();
  h.last().accept();
  mock.timers.tick(PING_MS + 50);
  h.last().receive('{"kind":"presence","devices":[]}');
  mock.timers.tick(ANSWER_MS);
  assert.equal(h.sockets.length, 1);
  assert.ok(h.events.includes('text:{"kind":"presence","devices":[]}'));
  h.socket.dispose();
});

test('a pong after another frame answered the ping does not inflate the round trip', () => {
  const h = harness();
  h.socket.start();
  h.last().accept();
  mock.timers.tick(PING_MS);
  mock.timers.tick(80);
  h.last().receive('{"kind":"presence","devices":[]}');
  mock.timers.tick(2_000);
  h.last().receive('pong');
  assert.equal(h.socket.quality.rttMs, null, 'the late pong times nothing');
  mock.timers.tick(PING_MS - 2_080);
  mock.timers.tick(90);
  h.last().receive('pong');
  assert.equal(h.socket.quality.rttMs, 90, 'the next ping still measures');
  h.socket.dispose();
});

test('a ping unanswered within the answer limit is a dead socket: reconnect at once', () => {
  const h = harness();
  h.socket.start();
  const first = h.last();
  first.accept();
  mock.timers.tick(PING_MS);
  mock.timers.tick(ANSWER_MS - 1);
  assert.equal(h.sockets.length, 1, 'still waiting for the answer');
  mock.timers.tick(1);
  assert.equal(h.sockets.length, 2, 'reconnected immediately');
  assert.equal(first.closedWith, 1000);
  assert.equal(first.onmessage, null, 'the dead socket is detached');
  assert.equal(h.socket.quality.state, 'connecting');
  assert.equal(h.socket.quality.failures, 1);
  h.last().accept();
  assert.equal(h.socket.quality.failures, 0, 'a successful open clears failures');
  assert.ok(h.qualities.some(q => q.state === 'connecting' && q.failures === 1));
  h.socket.dispose();
});

test('failed attempts back off with jitter and the quality reports waiting', () => {
  const h = harness(1);
  h.socket.start();
  h.last().fail(); // first failure retries at once
  assert.equal(h.sockets.length, 2);
  h.last().fail(); // then 1 s × 1.3 with random = 1
  assert.equal(h.socket.quality.state, 'waiting');
  assert.equal(h.socket.quality.failures, 2);
  mock.timers.tick(1299);
  assert.equal(h.sockets.length, 2);
  mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);
  h.socket.dispose();
});

test('kick() skips a pending backoff wait and connects now', () => {
  const h = harness();
  h.socket.start();
  h.last().fail();
  h.last().fail();
  h.last().fail(); // now waiting ~2 s
  assert.equal(h.socket.quality.state, 'waiting');
  const before = h.sockets.length;
  h.socket.kick();
  assert.equal(h.sockets.length, before + 1);
  assert.equal(h.socket.quality.state, 'connecting');
  mock.timers.tick(CONNECT_MS - 1);
  assert.equal(h.sockets.length, before + 1, 'the cancelled timer never fires');
  h.socket.kick();
  assert.equal(h.sockets.length, before + 1, 'kick while connecting is a no-op');
  h.socket.dispose();
});

test('kick() probes an open socket; no answer within the probe limit reconnects', () => {
  const h = harness();
  h.socket.start();
  h.last().accept();
  h.socket.kick();
  assert.deepEqual(h.last().sent, ['ping']);
  mock.timers.tick(PROBE_MS);
  assert.equal(h.sockets.length, 2);
  h.socket.dispose();
});

test('kick() does nothing when stopped or in the background', () => {
  const h = harness();
  h.socket.kick();
  assert.equal(h.sockets.length, 0);
  h.socket.start();
  h.last().accept();
  h.setApp('background');
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(h.socket.quality.state, 'offline', 'the background closes the socket');
  h.socket.kick();
  assert.equal(h.sockets.length, 1);
  h.setApp('active');
  assert.equal(h.sockets.length, 2, 'foreground reconnects');
  h.socket.dispose();
});

test('a connect stuck past CONNECT_MS is retried', () => {
  const h = harness();
  h.socket.start();
  mock.timers.tick(CONNECT_MS);
  assert.equal(h.sockets.length, 2);
  assert.ok(h.events.includes('refused'));
  h.socket.dispose();
});

test('quality listeners unsubscribe and get immutable snapshots', () => {
  const h = harness();
  const seen: ConnectionQuality[] = [];
  const off = h.socket.subscribeQuality(q => seen.push(q));
  h.socket.start();
  const connecting = h.socket.quality;
  h.last().accept();
  assert.equal(connecting.state, 'connecting', 'an old snapshot never changes');
  off();
  h.socket.stop();
  assert.deepEqual(seen.map(q => q.state), ['connecting', 'open']);
  assert.equal(h.socket.quality.state, 'offline');
  h.socket.dispose();
});
