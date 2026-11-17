import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { program } from './fixtures/extensions/backends/test-support.mjs';
// Preview column of R0804 (declared connection requests and the JSON adapter). The browser preview runs no package
// code and has no network of its own: its transport is a function this test supplies, and every call below goes
// through it to REAL loopback servers (a recording API of this file and the shared fake cloud B3). The host-side
// behaviour (HTTP transport, grants per call, redaction) is the native module `runtime_connection_adapters::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MANIFEST = read('tests/fixtures/extensions/runtime-connection-adapters/extension.json');
const ID = JSON.parse(MANIFEST).id as string, OTHER = 'sample.other-package';
const CANARY = ['tok', 'canary', 'credential', 'r0804'].join('-');
const USAGE = `${ID}/usage`, REPORT = `${ID}/report`, OPEN = `${ID}/open`;

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
async function recorder() {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      const path = entry.url.split('?')[0];
      const json = (status: number, value: unknown) => { const text = JSON.stringify(value); response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text); };
      if (path === '/text') { response.writeHead(200, { 'content-length': 11 }); response.end('not json :('); }
      else if (path === '/large') json(200, { blob: 'x'.repeat(5000) });
      else if (path === '/redirect') { response.writeHead(302, { location: 'https://elsewhere.example/', 'content-length': 0 }); response.end(); }
      else if (path === '/wait') setTimeout(() => json(200, { late: true }), 2000);
      else if (path === '/missing') json(404, { error: 'no such thing' });
      else json(200, { ok: true, method: entry.method, target: entry.url, echo: entry.body ? JSON.parse(entry.body) : null, authorization: path === '/mirror' ? entry.headers.authorization ?? null : null });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionConnectionAdapters.call(command, args), [command, args] as const);
const connections = (page: Page, id: string, method: string, params?: unknown, caller = 'service') => ipc(page, 'extensions_connection_adapters_service', { id, caller, method, params });
const secrets = (page: Page, id: string, method: string, params?: unknown) => ipc(page, 'extensions_private_secrets_service', { id, caller: 'service', method, params });
const grant = (page: Page, id: string, permission: string, op: 'grant' | 'revoke' = 'grant') => ipc(page, 'extensions_runtime_grant', { request: { op, id, permission } });
const refused = async (promise: Promise<unknown>, code: string) => { await expect(promise).rejects.toThrow(new RegExp(code)); };
async function finish(page: Page, id: string, started: { request: string }): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await connections(page, id, 'connections.poll', { connection: 'x', operation: 'y', request: started.request }) as { state: string };
    if (polled.state !== 'running') return polled;
    await page.waitForTimeout(20);
  }
  throw new Error('the request never finished');
}

type Rig = { api: Awaited<ReturnType<typeof recorder>>; cloud: string; control: string };
async function boot(page: Page, rig: Rig, extra: (manifest: any) => void = () => undefined) {
  const text = MANIFEST.replaceAll('http://127.0.0.1:9/v1/', `${rig.cloud}/v1/`).replaceAll('http://127.0.0.1:9', rig.api.base);
  const manifest = JSON.parse(text); extra(manifest);
  const other = { ...manifest, id: OTHER, runtime: { ...manifest.runtime, activationEvents: [`${OTHER}/store`], service: { start: 'onEnable' } }, contributes: { commands: [{ id: `${OTHER}/store`, title: 'Other', action: { kind: 'runCommand' } }] }, permissions: ['ui.contribute', 'runtime.service', 'connections.request'] };
  await page.exposeFunction('__nodeLoopback', async (request: { method: string; url: string; headers: [string, string][]; body: string | null }) => {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { status: response.status, text: await response.text(), redirected: response.status >= 300 && response.status < 400 };
  });
  await page.addInitScript(([manifest, other]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__connectionTransport = (request: unknown) => (window as any).__nodeLoopback(request);
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-connections-a', trusted: true } },
      { manifest: other, enabled: true, icons: {}, executable: { digest: 'preview-connections-b', trusted: true } },
    ]));
  }, [manifest, other]);
  await page.goto('/?private-secrets&connection-adapters'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionConnectionAdapters);
  for (const permission of ['connections.request', 'secrets.private', 'credentials.use']) await grant(page, ID, permission);
  await grant(page, OTHER, 'connections.request');
  await secrets(page, ID, 'secrets.set', { key: 'api-key', value: CANARY });
}
const withRig = (name: string, body: (page: Page, rig: Rig, cloud: { control: string }) => Promise<void>) => test(name, async ({ page }, info) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  const api = await recorder();
  const backend = program({ after: (cleanup: () => Promise<void> | void) => cleanups.push(cleanup) } as any, './fake-cloud/fake-cloud.mjs', ['--identity-port', '0', '--api-port', '0']);
  try {
    const ready = await backend.out.next((value: any) => value.ready === true, 8000) as { api: string; control: string };
    const url = (value: string) => value.startsWith('http') ? value : `http://${value}`;
    const rig = { api, cloud: url(ready.api), control: url(ready.control) };
    void info;
    await boot(page, rig);
    await body(page, rig, { control: rig.control });
  } finally {
    await api.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

withRig('extensions connection adapters: a granted GET and POST reach loopback with the declared method, headers, query and body, and the JSON answer reaches the service', async (page, rig, cloud) => {
  // GET, header authentication from a package secret, a declared query and a caller query.
  const started = await connections(page, ID, 'connections.start', { connection: USAGE, operation: 'get', query: { window: '5h' } }) as { state: string; request: string };
  expect(started.state).toBe('running');
  const done = await finish(page, ID, started);
  expect(done).toMatchObject({ state: 'completed', response: { schemaVersion: 1, status: 200, body: { ok: true, method: 'GET' } } });
  expect(rig.api.seen[0]).toMatchObject({ method: 'GET', url: '/usage?unit=percent&window=5h' });
  expect(rig.api.seen[0].headers['x-api-key']).toBe(CANARY);
  expect(rig.api.seen[0].headers['x-client']).toBe('sample');
  // POST with a JSON body and bearer authentication.
  const body = { range: { from: '2026-01-01' }, tags: ['a', 'b'], n: 3 };
  const posted = await finish(page, ID, await connections(page, ID, 'connections.start', { connection: REPORT, operation: 'send', body }) as { request: string });
  expect(posted.response.body.echo).toEqual(body);
  const post = rig.api.seen.at(-1)!;
  expect(post.method).toBe('POST'); expect(post.url).toBe('/report');
  expect(post.headers.authorization).toBe(`Bearer ${CANARY}`); expect(post.headers['content-type']).toBe('application/json');
  expect(JSON.parse(post.body)).toEqual(body);
  // Query authentication, and no authentication at all.
  await finish(page, ID, await connections(page, ID, 'connections.start', { connection: `${ID}/keyed`, operation: 'get', query: { page: '2' } }) as { request: string });
  expect(rig.api.seen.at(-1)!.url).toBe(`/query?page=2&key=${CANARY}`);
  await finish(page, ID, await connections(page, ID, 'connections.start', { connection: OPEN, operation: 'get' }) as { request: string });
  expect(Object.keys(rig.api.seen.at(-1)!.headers)).not.toContain('authorization');
  // The shared fake cloud B3: the host attached the secret as the x-api-key header; the answer is its parsed JSON.
  const usage = await finish(page, ID, await connections(page, ID, 'connections.start', { connection: `${ID}/cloud`, operation: 'usage' }) as { request: string });
  expect(usage.state, JSON.stringify(usage)).toBe('completed');
  expect(Array.isArray(usage.response.body.windows)).toBe(true);
  const log = await (await fetch(`${cloud.control}/control/log`)).text();
  expect(log).toContain('x-api-key'); expect(log).toContain(CANARY);
  // The credential never reaches the service, whatever the API echoes.
  const mirror = await finish(page, ID, await connections(page, ID, 'connections.start', { connection: `${ID}/mirror`, operation: 'get' }) as { request: string });
  expect(mirror.response.body.authorization).toBe('Bearer [redacted]');
  expect(JSON.stringify([started, done, posted, usage, mirror])).not.toContain(CANARY);
  expect(await connections(page, ID, 'connections.status', { connection: USAGE, operation: 'get' })).toEqual({ schemaVersion: 1, state: 'connected', credential: null });
});

withRig('extensions connection adapters: invalid JSON, oversized, error status, redirect, timeout, cancel and unsupported operations have bounded, explicit outcomes', async (page, rig, cloud) => {
  const outcome = async (connection: string, operation: string) => finish(page, ID, await connections(page, ID, 'connections.start', { connection, operation }) as { request: string });
  expect(await outcome(`${ID}/limits`, 'text')).toMatchObject({ state: 'failed', error: 'InvalidShape', response: null });
  expect(await outcome(`${ID}/limits`, 'large')).toMatchObject({ state: 'failed', error: 'LimitExceeded' });
  expect(await outcome(`${ID}/limits`, 'redirect')).toMatchObject({ state: 'failed', error: 'PermissionDenied' });
  expect(await outcome(`${ID}/limits`, 'missing')).toMatchObject({ state: 'completed', response: { status: 404, body: { error: 'no such thing' } } });
  expect(await outcome(`${ID}/summary`, 'summary'), 'the summary adapter reads accepted and count only; this API answers neither').toMatchObject({ state: 'failed', error: 'InvalidShape' });
  // B3 answers garbage on demand: still InvalidShape.
  await fetch(`${cloud.control}/control/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'garbage' }) });
  expect(await outcome(`${ID}/cloud`, 'usage')).toMatchObject({ state: 'failed', error: 'InvalidShape' });
  // Timeout (500 ms against an API that waits 2 s), and cancel before the answer.
  const waited = Date.now();
  expect(await outcome(`${ID}/slow`, 'wait')).toMatchObject({ state: 'failed', error: 'Timeout' });
  expect(Date.now() - waited).toBeLessThan(2000);
  const slow = await connections(page, ID, 'connections.start', { connection: `${ID}/slow`, operation: 'wait' }) as { request: string };
  expect(await connections(page, ID, 'connections.cancel', { connection: 'x', operation: 'y', request: slow.request })).toMatchObject({ state: 'failed', error: 'Cancelled' });
  await page.waitForTimeout(700);
  expect(await connections(page, ID, 'connections.poll', { connection: 'x', operation: 'y', request: slow.request })).toMatchObject({ error: 'Cancelled' });
  // Unsupported: a held credential with no value to attach is NotFound (the held resolver is R0805), a host handle nobody entered too.
  await refused(connections(page, ID, 'connections.start', { connection: `${ID}/held`, operation: 'get' }), 'NotFound');
  await refused(connections(page, ID, 'connections.start', { connection: `${ID}/hosted`, operation: 'get', credential: 'opaque' }), 'NotFound');
  await refused(connections(page, ID, 'connections.start', { connection: `${ID}/hosted`, operation: 'get' }), 'InvalidShape');
  await refused(connections(page, ID, 'connections.connect', {}), 'UnsupportedCapability');
  await refused(connections(page, ID, 'connections.start', { connection: USAGE, operation: 'undeclared' }), 'PermissionDenied');
  await refused(connections(page, ID, 'connections.start', { connection: USAGE, operation: 'get', url: 'https://evil.example' }), 'InvalidShape');
  await refused(connections(page, ID, 'connections.start', { connection: USAGE, operation: 'get', body: { a: 1 } }), 'InvalidShape');
  await refused(connections(page, ID, 'connections.start', { connection: REPORT, operation: 'send', body: { big: 'x'.repeat(256 * 1024) } }), 'LimitExceeded');
  await refused(connections(page, ID, 'connections.start', { connection: `${ID}/keyed`, operation: 'get', query: { key: 'mine' } }), 'InvalidShape');
  expect(rig.api.seen.some(entry => entry.url.startsWith('/open') && entry.method === 'POST')).toBe(false);
});

withRig('extensions connection adapters: the grant is rechecked on every call, a panel never uses the channel and a foreign package meets nothing', async (page, rig) => {
  const started = await connections(page, ID, 'connections.start', { connection: OPEN, operation: 'get' }) as { request: string };
  const done = await finish(page, ID, started);
  await refused(connections(page, OTHER, 'connections.poll', { connection: 'x', operation: 'y', request: started.request }), 'PermissionDenied');
  await refused(connections(page, ID, 'connections.poll', { connection: 'x', operation: 'y', request: 'forged' }), 'PermissionDenied');
  await refused(connections(page, ID, 'connections.start', { connection: OPEN, operation: 'get' }, 'panel'), 'UnsupportedCapability');
  await grant(page, ID, 'connections.request', 'revoke');
  for (const method of ['connections.start', 'connections.status', 'connections.poll', 'connections.cancel']) await refused(connections(page, ID, method, { connection: OPEN, operation: 'get', request: done.request ?? started.request }), 'PermissionDenied');
  await grant(page, ID, 'connections.request');
  // A request running when the grant goes away loses its output.
  const slow = await connections(page, ID, 'connections.start', { connection: `${ID}/slow`, operation: 'wait' }) as { request: string };
  await grant(page, ID, 'connections.request', 'revoke');
  await refused(connections(page, ID, 'connections.poll', { connection: 'x', operation: 'y', request: slow.request }), 'PermissionDenied');
  await grant(page, ID, 'connections.request');
  expect(await connections(page, ID, 'connections.poll', { connection: 'x', operation: 'y', request: slow.request })).toMatchObject({ state: 'failed', error: 'PermissionDenied', response: null });
  expect(rig.api.seen.length).toBeGreaterThan(0);
});

test('extensions connection adapters: the schema accepts the declared values and the address rules allow a query and any numeric loopback', async ({ page }) => {
  await page.goto('/?private-secrets&connection-adapters'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionRuntimeGrants);
  const checked = await page.evaluate(([text]) => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    const manifest = JSON.parse(text);
    const withUrl = (url: string) => { const copy = structuredClone(manifest); copy.contributes.connections[0].operations[0].url = url; return validateContract('packages', [copy]); };
    const without = (change: (connection: any) => void) => { const copy = structuredClone(manifest); change(copy.contributes.connections[0]); return validateContract('packages', [copy]); };
    return {
      fixture: validateContract('packages', [manifest]).ok,
      query: withUrl('https://api.example.com/v1/usage?window=5h').ok,
      loopback: withUrl('http://127.0.0.2:4000/x').ok && withUrl('http://[::1]:4000/x').ok,
      plain: withUrl('http://example.com/').error?.code,
      userinfo: withUrl('https://user:pass@example.com/').error?.code,
      fragment: withUrl('https://example.com/#x').error?.code,
      headerWithoutName: without(connection => { delete connection.headerName; }).error?.code,
      unknownAdapter: without(connection => { connection.adapter = 'stream'; }).ok,
      unknownMethod: without(connection => { connection.operations[0].method = 'TRACE'; }).ok,
    };
  }, [MANIFEST]);
  expect(checked).toEqual({ fixture: true, query: true, loopback: true, plain: 'PermissionDenied', userinfo: 'PermissionDenied', fragment: 'PermissionDenied', headerWithoutName: 'InvalidShape', unknownAdapter: false, unknownMethod: false });
  expect(read('src/extensions/sdk/index.d.ts')).not.toMatch(/['"]credentials\.read['"]/);
});
