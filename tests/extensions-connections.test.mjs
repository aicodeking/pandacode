import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { validateContract } from '../src/extensions/contracts.ts';
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/fake-service/extension.json', import.meta.url), 'utf8'));

test('extensions connections: shared descriptors reject secret fields, missing permission, duplicate operations and unsafe URLs', () => {
  const result = validateContract('packages', [manifest]);
  assert.equal(result.ok, true); assert.deepEqual(result.value.packages[0].contributes.connections, manifest.contributes.connections);
  for (const [key, value] of [['secret', 'DUMMY-SECRET'], ['headers', { Authorization: 'DUMMY-SECRET' }]]) {
    const invalid = structuredClone(manifest); invalid.contributes.connections[0][key] = value;
    assert.equal(validateContract('packages', [invalid]).error.code, 'InvalidShape');
  }
  const denied = structuredClone(manifest); denied.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [denied]).error.code, 'PermissionDenied');
  const duplicate = structuredClone(manifest); duplicate.contributes.connections[0].operations.push(duplicate.contributes.connections[0].operations[0]);
  assert.equal(validateContract('packages', [duplicate]).error.code, 'DuplicateId');
  for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com/?token=bad', 'https://example.com/#secret']) {
    const invalid = structuredClone(manifest); invalid.contributes.connections[0].operations[0].url = url;
    assert.equal(validateContract('packages', [invalid]).error.code, 'PermissionDenied');
  }
});

test('extensions connections: manual fake HTTP service echoes only synthetic input and has explicit redirect/limit/error/wait cases', async () => {
  const server = require('./fixtures/extensions/fake-service/service.cjs').service();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const secret = 'DUMMY-T37-credential-never-return';
  try {
    const response = await fetch(`${url}/summary`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.deepEqual(await response.json(), { accepted: true, count: 3, echo: secret });
    const redirect = await fetch(`${url}/redirect`, { redirect: 'manual' }); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), 'https://unauthorized.example/summary');
    assert.equal((await (await fetch(`${url}/large`)).text()).length, 32769);
    const failure = await fetch(`${url}/failure`, { headers: { Authorization: `Bearer ${secret}` } }); assert.equal(failure.status, 401); assert.equal(await failure.text(), secret);
    await assert.rejects(fetch(`${url}/wait`, { signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
  } finally { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
});

test('extensions connections: SDK fixture is lazy, consumes only opaque credential handles and stages sanitized summary', async () => {
  const commands = new Map(), calls = [], dialogs = [];
  const resource = { connection: 'sample.fake-service/api', operation: 'summary' };
  const panda = {
    commands: { register(id, handler) { commands.set(id, handler); } },
    connections: {
      async status(options) { calls.push(['status', options]); return { state: 'connected', credential: 'opaque-handle' }; },
      async start(options) { calls.push(['start', options]); return { state: 'running', request: 'owned-request' }; },
      async poll(options) { calls.push(['poll', options]); return { state: 'completed', response: { accepted: true, count: 3 }, error: null }; },
    },
    ui: { async showDialog(dialog) { dialogs.push(dialog); } },
  };
  require('./fixtures/extensions/fake-service/main.cjs').activate(panda);
  assert.deepEqual(calls, []); assert.equal(commands.size, 1);
  await commands.get('sample.fake-service/request')();
  assert.deepEqual(calls, [['status', resource], ['start', { ...resource, credential: 'opaque-handle' }], ['poll', { ...resource, request: 'owned-request' }]]);
  assert.equal(dialogs[0].successMessage, 'Accepted true; count 3');
});

test('extensions connections: both browser engines and CI explicitly register connection coverage', () => {
  for (const file of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /extensions-connections[.]spec[.]ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /extensions connections/);
});
