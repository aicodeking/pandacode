import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_BASE_MS, BACKOFF_JITTER_MS, BACKOFF_MAX_MS,
  backoffDelay, extractTokenFromHash, parseTokenInput, responseErrorMessage, splitPaths,
} from '../src/web-bridge.ts';

test('extractTokenFromHash takes a lone token and leaves an empty hash', () => {
  assert.deepEqual(extractTokenFromHash('#token=abc'), { token: 'abc', cleanHash: '' });
  assert.deepEqual(extractTokenFromHash('token=abc'), { token: 'abc', cleanHash: '' });
});
test('extractTokenFromHash keeps the other fragment params', () => {
  assert.deepEqual(extractTokenFromHash('#foo=1&token=abc&bar=2'), { token: 'abc', cleanHash: '#foo=1&bar=2' });
});
test('extractTokenFromHash leaves hashes without a token alone', () => {
  assert.deepEqual(extractTokenFromHash('#other'), { token: null, cleanHash: '#other' });
  assert.deepEqual(extractTokenFromHash(''), { token: null, cleanHash: '' });
  assert.deepEqual(extractTokenFromHash('#'), { token: null, cleanHash: '' });
});
test('extractTokenFromHash decodes URL-encoded tokens', () => {
  assert.deepEqual(extractTokenFromHash('#token=a%2Bb%2Fc%3D'), { token: 'a+b/c=', cleanHash: '' });
});
test('extractTokenFromHash strips an empty token but reports none', () => {
  assert.deepEqual(extractTokenFromHash('#token=&x=1'), { token: null, cleanHash: '#x=1' });
});

test('parseTokenInput accepts raw and trimmed tokens', () => {
  assert.equal(parseTokenInput('abc123'), 'abc123');
  assert.equal(parseTokenInput('  abc_123-XYZ \n'), 'abc_123-XYZ');
});
test('parseTokenInput extracts the token from a pasted link', () => {
  assert.equal(parseTokenInput('http://127.0.0.1:8080/#token=abc'), 'abc');
  assert.equal(parseTokenInput(' https://host.local:9000/app?x=1#a=2&token=t0k3n '), 't0k3n');
  assert.equal(parseTokenInput('#token=abc'), 'abc');
  assert.equal(parseTokenInput('token=abc'), 'abc');
});
test('parseTokenInput rejects empty, tokenless and malformed input', () => {
  assert.equal(parseTokenInput(''), '');
  assert.equal(parseTokenInput('   '), '');
  assert.equal(parseTokenInput('http://127.0.0.1:8080/'), '');
  assert.equal(parseTokenInput('http://[bad'), '');
  assert.equal(parseTokenInput('two words'), '');
  assert.equal(parseTokenInput('<script>'), '');
});

test('backoffDelay grows exponentially and is capped', () => {
  const none = () => 0;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(n => backoffDelay(n, none)), [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.equal(backoffDelay(0, none), BACKOFF_BASE_MS);
  assert.equal(backoffDelay(-3, none), BACKOFF_BASE_MS);
  assert.equal(backoffDelay(Number.NaN, none), BACKOFF_BASE_MS);
});
test('backoffDelay jitter stays within range', () => {
  assert.equal(backoffDelay(10, () => 1), BACKOFF_MAX_MS + BACKOFF_JITTER_MS);
  assert.equal(backoffDelay(10, () => 7), BACKOFF_MAX_MS + BACKOFF_JITTER_MS);
  for (let i = 0; i < 200; i++) {
    const delay = backoffDelay(i % 8);
    assert.ok(delay >= BACKOFF_BASE_MS && delay <= BACKOFF_MAX_MS + BACKOFF_JITTER_MS, String(delay));
  }
});

test('responseErrorMessage reads string and object errors', () => {
  assert.equal(responseErrorMessage({ error: 'Unknown command' }, 400), 'Unknown command');
  assert.equal(responseErrorMessage({ error: { message: 'nope' } }, 500), 'nope');
  assert.equal(responseErrorMessage('plain text', 500), 'plain text');
  assert.equal(responseErrorMessage(null, 502), 'PandaCode request failed (502).');
  assert.equal(responseErrorMessage({ error: { code: 1 } }, 500), 'PandaCode request failed (500).');
});
test('splitPaths keeps non-empty trimmed lines', () => {
  assert.deepEqual(splitPaths(' /a/b.png \r\n\n/c d/e.md\n  '), ['/a/b.png', '/c d/e.md']);
});

// ---------------------------------------------------------------------------
// Transport: fetch, WebSocket and the browser globals are mocked; each test loads a
// fresh module instance (its token and socket state are module-level).
// ---------------------------------------------------------------------------

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static all = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; this.closedBy = null; FakeSocket.all.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code) { this.closedBy = code ?? 1000; this.readyState = 3; }
  serverOpen() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  serverSend(frame) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) })); }
  serverClose(code) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
}

const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };
let instance = 0;

/** `routes` maps a path to (request) => Response. Returns the loaded module and recorded requests. */
async function load(routes, initialToken = 'tok1') {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const win = new EventTarget();
  win.sessionStorage = storage;
  globalThis.window = win;
  globalThis.document = { querySelector: () => null, body: { append() {} }, activeElement: null };
  globalThis.location = { hash: initialToken ? `#token=${initialToken}` : '', pathname: '/', search: '', protocol: 'http:', host: '127.0.0.1:4242' };
  globalThis.history = { replaceState: (_state, _title, url) => { globalThis.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } };
  globalThis.WebSocket = FakeSocket;
  FakeSocket.all = [];
  const requests = [];
  globalThis.fetch = async (path, init = {}) => {
    const request = { path, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const route = routes[path];
    if (!route) throw new TypeError('network down');
    return route(request);
  };
  const mod = await import(`../src/web-bridge.ts?transport=${++instance}`);
  return { mod, requests, store, win };
}

const okAuth = { '/api/auth': () => new Response('', { status: 200 }) };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('the token moves from the fragment to sessionStorage and out of the address bar', async () => {
  const { store } = await load(okAuth, 'abc');
  assert.equal(store.get('pandacode.web.token'), 'abc');
  assert.equal(globalThis.location.hash, '');
});

test('webInvoke posts the command and returns parsed JSON', async () => {
  const { mod, requests } = await load({ ...okAuth, '/api/invoke': () => json({ ok: 1 }) });
  assert.deepEqual(await mod.webInvoke('list_sessions', { a: 1 }), { ok: 1 });
  const invoke = requests.find(request => request.path === '/api/invoke');
  assert.equal(invoke.auth, 'Bearer tok1');
  assert.deepEqual(invoke.body, { command: 'list_sessions', args: { a: 1 } });
});

test('webInvoke returns binary replies as an ArrayBuffer', async () => {
  const { mod } = await load({ ...okAuth, '/api/invoke': () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) });
  const res = await mod.webInvoke('simulator_frame');
  assert.ok(res instanceof ArrayBuffer);
  assert.equal(res.byteLength, 4);
  assert.deepEqual([...new Uint8Array(res)], [1, 2, 3, 4]);
});

test('webInvoke returns undefined for an empty body', async () => {
  const { mod } = await load({ ...okAuth, '/api/invoke': () => new Response('', { status: 200 }) });
  assert.equal(await mod.webInvoke('noop'), undefined);
});

test('webInvoke throws the server error text', async () => {
  const { mod } = await load({ ...okAuth, '/api/invoke': () => json({ error: 'Unknown command.' }, 404) });
  await assert.rejects(mod.webInvoke('nope'), /Unknown command\./);
});

test('webInvoke on 403 keeps the stored token', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json({ error: 'Forbidden origin.' }, 403) });
  await assert.rejects(mod.webInvoke('list_sessions'), /Forbidden origin\./);
  assert.equal(store.get('pandacode.web.token'), 'tok1');
  await assert.rejects(mod.webInvoke('list_sessions'));
  assert.equal(requests.filter(request => request.path === '/api/invoke').at(-1).auth, 'Bearer tok1');
});

test('adoptWebToken rejects input without a token', async () => {
  const { mod, store } = await load(okAuth);
  assert.equal(mod.adoptWebToken('http://127.0.0.1:4242/'), false);
  assert.equal(store.get('pandacode.web.token'), 'tok1');
});

test('adoptWebToken survives a late 4001 from the old socket and reconnects with the new token', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json(true) });
  await mod.webListen('agent-event', () => {});
  await flush();
  const old = FakeSocket.all[0];
  assert.equal(old.url, 'ws://127.0.0.1:4242/api/events');
  old.serverOpen();
  assert.deepEqual(old.sent[0], { type: 'auth', token: 'tok1' });
  old.serverSend({ type: 'ready' });

  assert.equal(mod.adoptWebToken('http://127.0.0.1:4242/#token=tok2'), true);
  assert.equal(old.closedBy, 1000);
  old.serverClose(4001); // the server's rotation close arrives after the new token
  await flush();
  assert.equal(store.get('pandacode.web.token'), 'tok2');

  const fresh = FakeSocket.all.at(-1);
  assert.notEqual(fresh, old);
  fresh.serverOpen();
  assert.deepEqual(fresh.sent[0], { type: 'auth', token: 'tok2' });
  fresh.serverSend({ type: 'ready' });
  assert.deepEqual(fresh.sent[1], { type: 'subscribe', event: 'agent-event' });
  await mod.webInvoke('ping');
  assert.equal(requests.at(-1).auth, 'Bearer tok2');
});

test('webListen subscribes on ready, delivers events and isolates listener errors', async () => {
  const { mod } = await load(okAuth);
  const seen = [];
  const quiet = console.error; console.error = () => {};
  try {
    await mod.webListen('agent-event', () => { throw new Error('listener bug'); });
    const unlisten = await mod.webListen('agent-event', payload => seen.push(payload));
    await flush();
    const ws = FakeSocket.all[0];
    ws.serverOpen(); ws.serverSend({ type: 'ready' });
    assert.deepEqual(ws.sent.slice(1), [{ type: 'subscribe', event: 'agent-event' }]);
    ws.serverSend({ type: 'event', name: 'agent-event', payload: { kind: 'done' } });
    ws.serverSend({ type: 'event', name: 'other', payload: 1 });
    assert.deepEqual(seen, [{ kind: 'done' }]);
    unlisten();
    ws.serverSend({ type: 'event', name: 'agent-event', payload: 2 });
    assert.deepEqual(seen, [{ kind: 'done' }]);
  } finally { console.error = quiet; }
});

test('the last unlisten for a name unsubscribes it', async () => {
  const { mod } = await load(okAuth);
  const off = await mod.webListen('queue-changed', () => {});
  await mod.webListen('agent-event', () => {});
  await flush();
  const ws = FakeSocket.all[0];
  ws.serverOpen(); ws.serverSend({ type: 'ready' });
  off();
  assert.deepEqual(ws.sent.at(-1), { type: 'unsubscribe', event: 'queue-changed' });
});

test('the first connection, lagged and reconnect all resync: sessions-changed plus pandacode:web-resync', async t => {
  const { mod, win } = await load(okAuth);
  let sessions = 0, resyncs = 0;
  win.addEventListener('pandacode:web-resync', () => { resyncs++; });
  await mod.webListen('sessions-changed', () => { sessions++; });
  await flush();
  const first = FakeSocket.all[0];
  first.serverOpen(); first.serverSend({ type: 'ready' });
  assert.deepEqual([sessions, resyncs], [1, 1], 'the first connection resyncs: events before it landed were missed');

  first.serverSend({ type: 'lagged' });
  assert.deepEqual([sessions, resyncs], [2, 2]);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  first.serverClose(1006);
  assert.equal(FakeSocket.all.length, 1, 'waits for the backoff');
  t.mock.timers.tick(BACKOFF_BASE_MS + BACKOFF_JITTER_MS);
  await flush();
  const second = FakeSocket.all.at(-1);
  assert.notEqual(second, first);
  second.serverOpen(); second.serverSend({ type: 'ready' });
  assert.deepEqual(second.sent[1], { type: 'subscribe', event: 'sessions-changed' });
  assert.deepEqual([sessions, resyncs], [3, 3]);
  t.mock.timers.reset();
});

test('a 4001 for an older token keeps the newer token installed meanwhile', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json(true) });
  await mod.webListen('agent-event', () => {});
  await flush();
  const first = FakeSocket.all[0];
  first.serverOpen(); first.serverSend({ type: 'ready' });
  assert.equal(mod.adoptWebToken('tok2'), true);
  await flush();
  const current = FakeSocket.all.at(-1);
  current.serverOpen(); current.serverSend({ type: 'ready' });
  // The close for the tok1 socket reaches the handler while tok2 is the installed token.
  mod.handleClose({ code: 4001 }, 'tok1');
  assert.equal(store.get('pandacode.web.token'), 'tok2');
  await mod.webInvoke('ping');
  assert.equal(requests.at(-1).auth, 'Bearer tok2');
  // The handler dropped the attached socket; with listeners left it reconnects with tok2, no gate.
  await flush();
  const reconnect = FakeSocket.all.at(-1);
  assert.notEqual(reconnect, current);
  reconnect.serverOpen();
  assert.deepEqual(reconnect.sent[0], { type: 'auth', token: 'tok2' });
});

test('webOpenExternalUrl opens http and https links in a new, unlinked tab', async () => {
  const { mod, win } = await load(okAuth);
  const opened = [];
  win.open = (...args) => { opened.push(args); return null; };
  mod.webOpenExternalUrl('https://github.com/pandacode/pandacode/issues');
  mod.webOpenExternalUrl('http://127.0.0.1:8080/docs?x=1#y');
  assert.deepEqual(opened, [
    ['https://github.com/pandacode/pandacode/issues', '_blank', 'noopener,noreferrer'],
    ['http://127.0.0.1:8080/docs?x=1#y', '_blank', 'noopener,noreferrer'],
  ]);
});

test('webOpenExternalUrl refuses other schemes, malformed URLs and embedded credentials', async () => {
  const { mod, win } = await load(okAuth);
  const opened = [];
  win.open = (...args) => { opened.push(args); return null; };
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', '', 'https://user:pass@example.com/', 'http://user@example.com/', 'data:text/html,hi']) {
    assert.throws(() => mod.webOpenExternalUrl(url), /Only http and https links without credentials can be opened\./, url);
  }
  assert.deepEqual(opened, []);
});

test('submitHint names the shortcut for the keyboard', async () => {
  const { mod } = await load(okAuth);
  assert.equal(mod.submitHint('MacIntel'), 'Press ⌘+Enter to attach.');
  assert.equal(mod.submitHint('iPad'), 'Press ⌘+Enter to attach.');
  assert.equal(mod.submitHint('Win32'), 'Press Ctrl+Enter to attach.');
  assert.equal(mod.submitHint('Linux x86_64'), 'Press Ctrl+Enter to attach.');
});

test('beginWebTokenRotation holds an early 4001 until adoptWebToken installs the new token', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json(true) });
  await mod.webListen('agent-event', () => {});
  await flush();
  const old = FakeSocket.all[0];
  old.serverOpen(); old.serverSend({ type: 'ready' });

  const endRotation = mod.beginWebTokenRotation();
  // Over a slow link the server's rotation close beats the HTTP reply carrying the new token.
  old.serverClose(4001);
  await flush();
  assert.equal(store.get('pandacode.web.token'), 'tok1', 'not cleared while our rotation is pending');
  assert.equal(FakeSocket.all.length, 1, 'no reconnect with the revoked token');

  assert.equal(mod.adoptWebToken('http://127.0.0.1:4242/#token=tok2'), true);
  endRotation();
  await flush();
  assert.equal(store.get('pandacode.web.token'), 'tok2');
  const fresh = FakeSocket.all.at(-1);
  assert.notEqual(fresh, old);
  fresh.serverOpen();
  assert.deepEqual(fresh.sent[0], { type: 'auth', token: 'tok2' });
  await mod.webInvoke('ping');
  assert.equal(requests.at(-1).auth, 'Bearer tok2');
});

test('a failed rotation treats the held 4001 as a revocation once it settles', async t => {
  const { mod, store } = await load(okAuth);
  await mod.webListen('agent-event', () => {});
  await flush();
  const old = FakeSocket.all[0];
  old.serverOpen(); old.serverSend({ type: 'ready' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = console.warn; console.warn = () => {};
  try {
    const endRotation = mod.beginWebTokenRotation();
    old.serverClose(4001);
    await flush();
    assert.equal(store.get('pandacode.web.token'), 'tok1');
    endRotation(); // the rotate request failed: no new token arrived
    assert.equal(store.get('pandacode.web.token'), undefined);
    await flush();
  } finally { console.warn = quiet; t.mock.timers.reset(); }
});

test('a 401 during this tab\'s own rotation waits for the new token and retries without the gate', async () => {
  let invokes = 0;
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': request => (++invokes, request.auth === 'Bearer tok2' ? json({ ok: true }) : json({ error: 'Invalid access token.' }, 401)) });
  const endRotation = mod.beginWebTokenRotation();
  const pending = mod.webInvoke('list_sessions');
  await flush();
  assert.equal(invokes, 1, 'the first attempt used the old token');
  assert.equal(store.get('pandacode.web.token'), 'tok1', 'not cleared while the rotation is in flight');
  assert.equal(mod.adoptWebToken('tok2'), true);
  assert.deepEqual(await pending, { ok: true });
  endRotation();
  assert.deepEqual(requests.filter(request => request.path === '/api/invoke').map(request => request.auth), ['Bearer tok1', 'Bearer tok2']);
  assert.equal(store.get('pandacode.web.token'), 'tok2');
});

test('a 401 during a rotation that ends without a token falls back to clearing it', async () => {
  const { mod, store } = await load({ ...okAuth, '/api/invoke': () => json({ error: 'Invalid access token.' }, 401) });
  const endRotation = mod.beginWebTokenRotation();
  const pending = mod.webInvoke('list_sessions');
  pending.catch(() => {});
  await flush();
  assert.equal(store.get('pandacode.web.token'), 'tok1');
  endRotation(); // the rotate request failed
  await flush();
  assert.equal(store.get('pandacode.web.token'), undefined, 'cleared once the rotation settled without a new token');
});

test('clearErrorOnInput clears the error once the field holds something again', async () => {
  const { mod } = await load(okAuth);
  const attributes = new Map([['aria-invalid', 'false']]);
  const input = Object.assign(new EventTarget(), { value: '', getAttribute: name => attributes.get(name) ?? null });
  let error = '';
  const setError = text => { error = text; attributes.set('aria-invalid', text ? 'true' : 'false'); };
  mod.clearErrorOnInput(input, setError);
  setError('Enter a path.'); // an empty submit
  input.value = '   ';
  input.dispatchEvent(new Event('input'));
  assert.equal(error, 'Enter a path.', 'blank text keeps the error');
  assert.equal(attributes.get('aria-invalid'), 'true');
  input.value = '/Users/me/project';
  input.dispatchEvent(new Event('input'));
  assert.equal(error, '');
  assert.equal(attributes.get('aria-invalid'), 'false');
});

const RAN = { error: 'Access token rotated while request was running.', ran: true };

test('a 401 marked ran during our own rotation waits for the new token and never resends the command', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json(RAN, 401) });
  const endRotation = mod.beginWebTokenRotation();
  const pending = mod.webInvoke('send_message', { text: 'hi' });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'waits for the rotation instead of failing or prompting');
  assert.equal(store.get('pandacode.web.token'), 'tok1');
  assert.equal(mod.adoptWebToken('tok2'), true);
  await assert.rejects(pending, /Access token rotated while request was running\./);
  endRotation();
  assert.equal(requests.filter(request => request.path === '/api/invoke').length, 1, 'sent exactly once');
  assert.equal(store.get('pandacode.web.token'), 'tok2', 'the adopted token stays');
});

test('a 401 marked ran from another client\'s rotation clears the stale token and is not retried', async () => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': () => json(RAN, 401) });
  await assert.rejects(mod.webInvoke('send_message', { text: 'hi' }), /Access token rotated while request was running\./);
  assert.equal(requests.filter(request => request.path === '/api/invoke').length, 1, 'sent exactly once');
  assert.equal(store.get('pandacode.web.token'), undefined, 'the next call signs in again');
});

test('a 401 marked ran without an error text still names what happened', async () => {
  const { mod } = await load({ ...okAuth, '/api/invoke': () => json({ ran: true }, 401) });
  await assert.rejects(mod.webInvoke('send_message'), /Access token rotated while request was running\./);
});

test('our own rotate request refused with 401 fails at once, is not retried, and releasing flushes the held 4001', async t => {
  const { mod, store, requests } = await load({ ...okAuth, '/api/invoke': request => request.body.command === 'web_server_rotate_token'
    ? json({ error: 'Invalid access token.' }, 401) : json(true) });
  await mod.webListen('agent-event', () => {});
  await flush();
  const old = FakeSocket.all[0];
  old.serverOpen(); old.serverSend({ type: 'ready' });
  const endRotation = mod.beginWebTokenRotation();
  old.serverClose(4001); // another client rotated first: the server closed us, held while our rotation is pending
  await flush();
  assert.equal(store.get('pandacode.web.token'), 'tok1');
  // Would wait on its own rotation (which only ends after this call) if it were not special-cased.
  const outcome = await Promise.race([
    mod.webInvoke('web_server_rotate_token').then(() => 'resolved', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
  ]);
  assert.equal(outcome, 'Invalid access token.');
  assert.equal(requests.filter(request => request.path === '/api/invoke').length, 1, 'not retried');
  assert.equal(store.get('pandacode.web.token'), undefined, 'the stale token is cleared');
  // Releasing flushes the held close: the tab asks for the new token (the gate needs a DOM, so here it only tries).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  const quiet = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
  try {
    endRotation();
    await flush();
    assert.ok(warnings.some(text => /event stream/.test(text)), 'reconnecting asked for a token');
  } finally { console.warn = quiet; t.mock.timers.reset(); }
});

test('a call waiting on a rotation gives up after ROTATION_WAIT_MS', async t => {
  const { mod, store } = await load({ ...okAuth, '/api/invoke': () => json({ error: 'Invalid access token.' }, 401) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = console.warn; console.warn = () => {};
  try {
    mod.beginWebTokenRotation(); // never released
    const pending = mod.webInvoke('list_sessions');
    pending.catch(() => {});
    await flush();
    assert.equal(store.get('pandacode.web.token'), 'tok1', 'still waiting');
    t.mock.timers.tick(mod.ROTATION_WAIT_MS);
    await flush();
    assert.equal(store.get('pandacode.web.token'), undefined, 'stopped waiting and fell back to clearing it');
  } finally { console.warn = quiet; t.mock.timers.reset(); }
});

test('markWebServerStopped closes the stream and nothing reconnects or says "Reconnecting…" again', async t => {
  const { mod, win } = await load(okAuth);
  await mod.webListen('agent-event', () => {});
  await flush();
  const ws = FakeSocket.all[0];
  ws.serverOpen(); ws.serverSend({ type: 'ready' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Settings in this tab stops the server: it says so through the window event.
    win.dispatchEvent(new CustomEvent('pandacode:web-stopped', { detail: 'Turn it back on in the desktop app.' }));
    assert.equal(ws.closedBy, 1000, 'the event stream is closed cleanly');
    ws.serverClose(1006); // the server going away afterwards
    mod.handleClose({ code: 1006 }, 'tok1'); // or any later close that reaches the handler
    mod.handleClose({ code: 4001 }, 'tok1');
    await mod.webListen('queue-changed', () => {});
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(FakeSocket.all.length, 1, 'no reconnect, however long it waits');
  } finally { t.mock.timers.reset(); }
});

test('markWebServerStopped can be called directly', async () => {
  const { mod } = await load(okAuth);
  await mod.webListen('agent-event', () => {});
  await flush();
  FakeSocket.all[0].serverOpen(); FakeSocket.all[0].serverSend({ type: 'ready' });
  mod.markWebServerStopped();
  assert.equal(FakeSocket.all[0].closedBy, 1000);
  assert.equal(mod.WEB_STOPPED_TEXT, 'Web server stopped.');
});
