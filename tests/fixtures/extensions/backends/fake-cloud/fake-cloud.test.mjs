import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { program, control } from '../test-support.mjs';
import { createCloud } from '../core/fake-cloud.mjs';

const verifier = 'fixture-verifier-for-s256-proof';
const challenge = text => createHash('sha256').update(text).digest('base64url');
function authorization(identity, redirect = 'http://127.0.0.1:1/callback') {
  const url = new URL('/authorize', identity);
  url.search = new URLSearchParams({ response_type: 'code', client_id: 'fixture', redirect_uri: redirect, state: 'state-canary', code_challenge: challenge(verifier), code_challenge_method: 'S256', scope: 'profile' });
  return url;
}
async function token(identity, fields) {
  return fetch(`${identity}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'fixture', ...fields }) });
}
async function exchange(identity) {
  const authorize = authorization(identity);
  const response = await fetch(authorize, { redirect: 'manual' }), location = new URL(response.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 'state-canary');
  const fields = { grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: authorize.searchParams.get('redirect_uri'), code_verifier: verifier };
  return { fields, tokens: await (await token(identity, fields)).json() };
}

test('B3 pure core clock, token expiry and concurrent authorization-code reuse', async () => {
  let now = 100; const state = createCloud({ now: () => now, challenge });
  const url = authorization('http://127.0.0.1:1'), redirect = await state.request('identity', 'GET', url);
  const fields = { grant_type: 'authorization_code', client_id: 'fixture', code: new URL(redirect.headers.location).searchParams.get('code'), redirect_uri: url.searchParams.get('redirect_uri'), code_verifier: verifier };
  const results = await Promise.all([state.request('identity', 'POST', new URL('/token', url), {}, fields), state.request('identity', 'POST', new URL('/token', url), {}, fields)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 400]);
  const access = results.find(x => x.status === 200).data.access_token;
  now += 60001;
  assert.equal((await state.request('api', 'GET', new URL('/v1/models', url), { authorization: `Bearer ${access}` })).status, 401);
});

test('B3 PKCE exchange, reuse, mismatch, expiry, refresh rotation, revoke and listener isolation', async t => {
  const child = program(t, './fake-cloud/fake-cloud.mjs'), ready = await child.out.next(x => x.ready);
  assert.notEqual(ready.identity, ready.api);
  assert.equal((await program(t, './fake-cloud/fake-cloud.mjs', ['--api-port', new URL(ready.api).port]).exited).code, 2);
  const { tokens, fields } = await exchange(ready.identity);
  assert.match(tokens.access_token, /^tok-/); assert.match(tokens.refresh_token, /^tok-/);
  assert.equal((await token(ready.identity, fields)).status, 400);
  const auth = { authorization: `Bearer ${tokens.access_token}` };
  assert.equal((await (await fetch(`${ready.identity}/userinfo`, { headers: auth })).json()).email, 'dev@example.test');
  assert.equal((await (await fetch(`${ready.api}/v1/models`, { headers: auth })).json()).models.length, 2);
  assert.equal((await fetch(`${ready.api}/v1/models`)).status, 401);
  const redirect = await fetch(authorization(ready.identity), { redirect: 'manual' });
  const code = new URL(redirect.headers.get('location')).searchParams.get('code');
  assert.equal((await token(ready.identity, { ...fields, code, code_verifier: 'wrong' })).status, 400);
  assert.equal((await token(ready.identity, { ...fields, code, redirect_uri: 'http://127.0.0.1:2/callback' })).status, 400);
  assert.equal((await token(ready.identity, { ...fields, code, client_id: 'wrong' })).status, 400);
  await control(ready.control, 'expire');
  assert.equal((await fetch(`${ready.api}/v1/models`, { headers: auth })).status, 401);
  const refreshed = await (await token(ready.identity, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json();
  assert.notEqual(refreshed.access_token, tokens.access_token); assert.equal(refreshed.refresh_token, tokens.refresh_token);
  await control(ready.control, 'mode', { refresh: 'rotate' });
  const rotated = await (await token(ready.identity, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await token(ready.identity, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status, 400);
  const log = await (await fetch(`${ready.control}/control/log`)).json();
  assert(log.some(x => x.listener === 'api' && x.headers.authorization === auth.authorization));
  assert(log.filter(x => x.path === '/token').every(x => !x.headers.authorization));
  await control(ready.control, 'revoke');
  assert.equal((await token(ready.identity, { grant_type: 'refresh_token', refresh_token: rotated.refresh_token })).status, 400);
  assert.equal((await fetch(`${ready.api}/v1/models`, { headers: { authorization: `Bearer ${rotated.access_token}` } })).status, 401);
});

test('B3 authorize deny/bad-state/page/hang and no outside callback', async t => {
  const child = program(t, './fake-cloud/fake-cloud.mjs'), ready = await child.out.next(x => x.ready);
  for (const mode of ['deny', 'bad-state']) {
    await control(ready.control, 'mode', { authorize: mode });
    const response = await fetch(authorization(ready.identity), { redirect: 'manual' });
    const location = new URL(response.headers.get('location'));
    if (mode === 'deny') assert.equal(location.searchParams.get('error'), 'access_denied');
    else assert.notEqual(location.searchParams.get('state'), 'state-canary');
  }
  await control(ready.control, 'mode', { authorize: 'page' });
  assert.match(await (await fetch(authorization(ready.identity))).text(), /Manual sign-in/);
  await control(ready.control, 'mode', { authorize: 'hang' });
  await assert.rejects(fetch(authorization(ready.identity), { signal: AbortSignal.timeout(100) }));
  assert.equal((await fetch(authorization(ready.identity, 'https://example.test/callback'))).status, 400);
  await control(ready.control, 'reset');
  assert.equal((await fetch(authorization(ready.identity), { redirect: 'manual' })).status, 302);
});

test('B3 SSE echo/reply/usage, rate limits, header auth, faults, shutdown and EOF', async t => {
  const child = program(t, './fake-cloud/fake-cloud.mjs'), ready = await child.out.next(x => x.ready), { tokens } = await exchange(ready.identity);
  const headers = { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' };
  const chat = () => fetch(`${ready.api}/v1/chat`, { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-large', stream: true, messages: [{ role: 'user', content: 'hello panda' }] }) });
  const response = await chat(); assert.match(response.headers.get('content-type'), /event-stream/);
  const events = (await response.text()).trim().split('\n\n').map(line => line.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const values = events.slice(0, -1).map(line => JSON.parse(line));
  assert.equal(values.filter(x => x.delta).map(x => x.delta).join(''), 'echo: hello panda');
  assert.equal(values.at(-1).usage.contextWindow, 32768);
  await control(ready.control, 'reply', { text: 'fixed answer' });
  assert.match(await (await chat()).text(), /fixed an/);
  await control(ready.control, 'rate-limit', { count: 2, retryAfterMs: 17 });
  const limited = await chat(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after-ms'), '17');
  assert.equal((await chat()).status, 429); assert.equal((await chat()).status, 200);
  const windows = [{ id: '5h', usedPercent: 90, resetsAt: 123 }];
  await control(ready.control, 'usage', { windows, credits: 5 });
  assert.deepEqual(await (await fetch(`${ready.api}/v1/usage`, { headers: { 'x-api-key': 'tok-usage-canary' } })).json(), { windows, credits: 5 });
  assert.deepEqual((await (await fetch(`${ready.api}/v1/usage`, { headers })).json()).windows, windows);
  await control(ready.control, 'fault', { kind: 'garbage' });
  assert.equal(await (await fetch(`${ready.api}/v1/models`)).text(), 'not-json');
  await control(ready.control, 'fault', { kind: 'stall', ms: 120 });
  await assert.rejects(fetch(`${ready.api}/v1/models`, { signal: AbortSignal.timeout(70) }));
  await control(ready.control, 'fault', { kind: 'refuse' });
  await assert.rejects(fetch(`${ready.api}/v1/models`));
  await control(ready.control, 'reset');
  await control(ready.control, 'fault', { kind: 'drop', ms: 1 });
  await control(ready.control, 'shutdown'); assert.equal((await child.exited).code, 0);
  await assert.rejects(fetch(`${ready.api}/v1/models`));
  const other = program(t, './fake-cloud/fake-cloud.mjs'); await other.out.next(x => x.ready);
  other.child.stdin.end(); assert.equal((await other.exited).code, 0);
});
