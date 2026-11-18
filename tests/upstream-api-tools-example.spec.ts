import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// S07B: the API-backed provider and the team-tools packages of examples/extensions, exercised against fake loopback
// services with a canary credential. Three layers, each labelled for what it proves:
//  - "package": the shipped main.cjs run in Node with a stand-in for the host (the host's HTTP, secret and team seams).
//    It proves the package's own logic (event order, failures, attribution, no credential in any emitted event).
//  - "preview": the real install flow of the browser preview (model picker, enable and disable) and the preview's
//    declared-connection executor (R0804) calling the same loopback API. The preview runs no package code.
//  - native behaviour (the host's HTTP transport, grants, redaction) is `runtime_connection_adapters::tests`.
// No live inference, no personal credential, no real harness. Written for the final test phase; not run when written.
const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const API_MANIFEST = read('examples/extensions/upstream-api/package/extension.json');
const TEAM_MANIFEST = read('examples/extensions/upstream-team-tools/package/extension.json');
const API_ID = JSON.parse(API_MANIFEST).id as string, TEAM_ID = JSON.parse(TEAM_MANIFEST).id as string;
const CANARY = ['tok', 'fake', 'upstream', 'api', 'key'].join('-');
const load = (dir: string) => { const path = require.resolve(`../examples/extensions/${dir}/package/main.cjs`); delete require.cache[path]; return require(path); };

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
async function fakeApi(mode: { status?: number; wait?: number } = {}) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const reply = () => {
        const authorized = request.headers['x-api-key'] === CANARY;
        const status = !authorized ? 401 : mode.status ?? 200;
        const text = JSON.stringify(status === 200
          ? { id: 'fake-1', chunks: ['Fake ', 'streamed ', 'answer.'], usage: { total: 42 }, echoedKey: request.headers['x-api-key'] }
          : { error: status === 401 ? 'bad key' : 'fake failure' });
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text);
      };
      if (mode.wait) setTimeout(reply, mode.wait); else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** Stand-in for the host's executor: declared operation by name, the package secret attached here, never returned. */
function hostPanda(base: string, secrets: Map<string, string>) {
  const manifest = JSON.parse(API_MANIFEST).contributes.connections[0];
  const commands = new Map<string, () => Promise<unknown>>(); const stops: (() => unknown)[] = [];
  const requests = new Map<string, Promise<any>>();
  const panda = {
    commands: { register: (id: string, handler: () => Promise<unknown>) => { commands.set(id, handler); return { dispose() {} }; } },
    secrets: {
      list: async () => ({ keys: [...secrets.keys()] }),
      get: async ({ key }: { key: string }) => ({ value: secrets.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => { secrets.set(key, value); return null; },
      delete: async ({ key }: { key: string }) => { secrets.delete(key); return null; },
    },
    connections: {
      async start({ connection, operation, body }: any) {
        const op = manifest.operations.find((candidate: any) => candidate.id === operation);
        if (connection !== manifest.id || !op) return { schemaVersion: 1, request: 'x', state: 'failed', response: null, error: 'PermissionDenied' };
        const key = secrets.get(manifest.credential.key);
        if (!key) return { schemaVersion: 1, request: 'x', state: 'failed', response: null, error: 'NotFound' };
        const request = String(requests.size + 1);
        requests.set(request, fetch(op.url.replace('http://127.0.0.1:9', base), { method: op.method, headers: { 'content-type': 'application/json', [manifest.headerName]: key }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(manifest.timeoutMs) })
          .then(async response => ({ schemaVersion: 1, request, state: 'completed', error: null, response: { schemaVersion: 1, status: response.status, body: JSON.parse((await response.text()).replaceAll(key, '[redacted]')) } }))
          .catch(() => ({ schemaVersion: 1, request, state: 'failed', response: null, error: 'Timeout' })));
        return { schemaVersion: 1, request, state: 'running', response: null, error: null };
      },
      async poll({ request }: any) { return requests.get(request)!; },
    },
  };
  const lifetime = { reason: 'enable', restarts: 0, onStop: (handler: () => unknown) => { stops.push(handler); return { dispose() {} }; }, setStatus: async () => null };
  return { panda, lifetime, commands, stop: () => Promise.all(stops.map(handler => handler())) };
}
function providerCore(inputs: unknown[] = []) {
  const events: any[] = [];
  return { events, core: { emit: async (event: unknown) => { events.push(structuredClone(event)); return null; }, nextInput: async () => inputs.shift(), teamTool: async () => { throw new Error('UnsupportedCapability'); } } };
}
const run = (extra: object = {}) => ({ apiVersion: 1, id: 'sample.upstream-api/chat', version: '1.0.0', digest: 'd', model: 'fixture-small', effort: null, mode: 'ask', resumeId: null, prompt: 'hello fake api', instructions: '', teamTools: [], ...extra });

test('upstream api package: streams the fake answer as provider events and the credential never leaves the host', async () => {
  const api = await fakeApi();
  try {
    const main = load('upstream-api');
    const host = hostPanda(api.base, new Map());
    await main.service(host.panda, host.lifetime);
    await host.commands.get('sample.upstream-api/setup')!();
    expect(await host.panda.secrets.list()).toEqual({ keys: ['api-key'] });
    const { events, core } = providerCore();
    await main.providers['sample.upstream-api/chat'](run(), core);
    expect(events.map(event => event.kind)).toEqual(['session', 'text', 'text', 'text', 'usage']);
    expect(events.filter(event => event.kind === 'text').map(event => event.text).join('')).toBe('Fake streamed answer.');
    expect(events.at(-1)).toMatchObject({ usedTokens: 42, contextWindow: 8000 });
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]).toMatchObject({ method: 'POST', url: '/v1/chat' });
    expect(JSON.parse(api.seen[0].body).messages[0].content).toBe('hello fake api');
    expect(api.seen[0].headers['x-api-key']).toBe(CANARY);
    // The echo service returned the key; the host's redaction (here the stand-in's) kept it out of every event.
    expect(JSON.stringify(events)).not.toContain(CANARY);
    await host.stop();
  } finally { await api.close(); }
});

test('upstream api package: failures are explicit and nothing is emitted as a success', async () => {
  const main = load('upstream-api');
  // Service not running: a stable code, not a hang.
  const idle = providerCore();
  await expect(main.providers['sample.upstream-api/chat'](run(), idle.core)).rejects.toThrow(/HostUnavailable/);
  expect(idle.events).toEqual([]);
  // Wrong model or mode.
  const wrong = providerCore();
  await expect(main.providers['sample.upstream-api/chat'](run({ model: 'other' }), wrong.core)).rejects.toThrow(/UnsupportedCapability/);
  // No key stored (setup never ran): the host answers NotFound.
  const api = await fakeApi();
  try {
    const host = hostPanda(api.base, new Map());
    await main.service(host.panda, host.lifetime);
    const missing = providerCore();
    await expect(main.providers['sample.upstream-api/chat'](run(), missing.core)).rejects.toThrow(/NotFound/);
    expect(api.seen).toEqual([]);
    // A rejected key: the API answers 401 and the provider fails rather than printing an error body as text.
    host.panda.secrets.set({ key: 'api-key', value: 'tok-wrong-key' });
    const rejected = providerCore();
    await expect(main.providers['sample.upstream-api/chat'](run(), rejected.core)).rejects.toThrow(/401/);
    expect(rejected.events.filter(event => event.kind === 'text')).toEqual([]);
    // Stopping the service retires the bridge: the next send fails the same way as a disabled package.
    await host.stop();
    await expect(main.providers['sample.upstream-api/chat'](run(), providerCore().core)).rejects.toThrow(/HostUnavailable/);
  } finally { await api.close(); }
});

test('upstream team tools package: the tool is attributed to its package and delivered to a team role with the catalog', async () => {
  const main = load('upstream-team-tools');
  const calls: string[] = [];
  const { events, core } = providerCore();
  const team = { ...core, teamTool: async (name: string) => { calls.push(name); if (name !== 'pandacode_list_workers') throw new Error('UnsupportedCapability: host tool'); return { workers: [] }; } };
  await main.providers[`${TEAM_ID}/team`](run({ id: `${TEAM_ID}/team`, teamTools: [{ name: 'pandacode_list_workers' }] }), team);
  expect(calls).toEqual(['pandacode_list_workers', 'pandacode_open_browser']);
  const rows = events.filter(event => event.kind === 'tool').map(event => event.tool);
  expect(rows.map(row => [row.name, row.status])).toEqual([[`${TEAM_ID}/lookup`, 'running'], [`${TEAM_ID}/lookup`, 'completed']]);
  expect(JSON.parse(rows[1].output)).toEqual({ source: TEAM_ID, key: 'build-flags', value: 'release, locked' });
  expect(events.some(event => event.kind === 'text' && String(event.text).startsWith(`${TEAM_ID} lookup`))).toBe(true);
  // A role without the team catalog is not eligible: the tool is not delivered and the text says so.
  const bare = providerCore();
  await main.providers[`${TEAM_ID}/team`](run({ id: `${TEAM_ID}/team`, teamTools: [] }), bare.core);
  expect(bare.events.some(event => event.kind === 'tool')).toBe(false);
  expect(JSON.stringify(bare.events)).toContain('was not delivered');
  // The declared tool alone: literal arguments, a stable error for an unknown entry.
  await expect(main.tools[`${TEAM_ID}/lookup-run`](['missing'], { progress: async () => null })).rejects.toThrow(/NotFound/);
});

async function openPicker(page: Page, manifests: object[], enabled = true) {
  await page.addInitScript(([list, enabled]) => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify((list as object[]).map((manifest, index) => ({ manifest, enabled, icons: {}, executable: { digest: `preview-s07b-${index}`, trusted: true } })))), [manifests, enabled] as const);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
}

test('upstream api tools preview: both packages install into the model picker; disabled they are gone and the built-ins remain', async ({ page }) => {
  await openPicker(page, [JSON.parse(API_MANIFEST), JSON.parse(TEAM_MANIFEST)]);
  await expect(page.getByRole('tab', { name: 'Fake chat API', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Team tools worker', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('upstream api tools preview: disabled packages offer nothing and fall back to the built-in pickers', async ({ page }) => {
  await openPicker(page, [JSON.parse(API_MANIFEST), JSON.parse(TEAM_MANIFEST)], false);
  await expect(page.getByRole('tab', { name: 'Fake chat API', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Team tools worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab').first()).toBeVisible();
  await page.keyboard.press('Escape');
});

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionConnectionAdapters.call(command, args), [command, args] as const);
const connection = (page: Page, method: string, params: unknown) => ipc(page, 'extensions_connection_adapters_service', { id: API_ID, caller: 'service', method, params });
const grant = (page: Page, permission: string, op: 'grant' | 'revoke') => ipc(page, 'extensions_runtime_grant', { request: { op, id: API_ID, permission } });
async function finish(page: Page, started: { request: string }): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await connection(page, 'connections.poll', { connection: `${API_ID}/chat-api`, operation: 'complete', request: started.request }) as { state: string };
    if (polled.state !== 'running') return polled;
    await page.waitForTimeout(20);
  }
  throw new Error('the request never finished');
}

test('upstream api tools preview: the declared chat connection answers with the canary attached by the host; revoke and a wrong key fail with stable codes', async ({ page }) => {
  const api = await fakeApi();
  try {
    const manifest = JSON.parse(API_MANIFEST.replaceAll('http://127.0.0.1:9', api.base));
    await page.exposeFunction('__nodeLoopback', async (request: { method: string; url: string; headers: [string, string][]; body: string | null }) => {
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return { status: response.status, text: await response.text(), redirected: response.status >= 300 && response.status < 400 };
    });
    await page.addInitScript(manifest => {
      localStorage.setItem('pandacode.wallpapers', 'false');
      (window as any).__connectionTransport = (request: unknown) => (window as any).__nodeLoopback(request);
      localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'preview-s07b-api', trusted: true } }]));
    }, manifest);
    await page.goto('/?private-secrets&connection-adapters'); await expect(page.locator('#prompt')).toBeEnabled();
    await page.waitForFunction(() => (window as any).__extensionConnectionAdapters);
    for (const permission of ['connections.request', 'secrets.private']) await grant(page, permission, 'grant');
    const resource = { connection: `${API_ID}/chat-api`, operation: 'complete' };
    const body = { model: 'fixture-small', stream: false, messages: [{ role: 'user', content: 'hi' }] };
    // No key yet: NotFound, and the fake API was never reached.
    expect(await connection(page, 'connections.start', { ...resource, body })).toMatchObject({ state: 'failed', error: 'NotFound' });
    expect(api.seen).toEqual([]);
    await ipc(page, 'extensions_private_secrets_service', { id: API_ID, caller: 'service', method: 'secrets.set', params: { key: 'api-key', value: CANARY } });
    const done = await finish(page, await connection(page, 'connections.start', { ...resource, body }) as { request: string });
    expect(done).toMatchObject({ state: 'completed', response: { status: 200, body: { chunks: ['Fake ', 'streamed ', 'answer.'] } } });
    expect(api.seen[0].headers['x-api-key']).toBe(CANARY);
    expect(done.response.body.echoedKey).toBe('[redacted]');
    expect(JSON.stringify(done)).not.toContain(CANARY);
    // A wrong key is the API's own 401 and completes with its error JSON; the service decides what it means.
    await ipc(page, 'extensions_private_secrets_service', { id: API_ID, caller: 'service', method: 'secrets.set', params: { key: 'api-key', value: 'tok-wrong-key' } });
    expect((await finish(page, await connection(page, 'connections.start', { ...resource, body }) as { request: string })).response.status).toBe(401);
    // Revoke: the next call is refused before anything is sent.
    const before = api.seen.length;
    await grant(page, 'connections.request', 'revoke');
    await expect(connection(page, 'connections.start', { ...resource, body })).rejects.toThrow(/PermissionDenied/);
    expect(api.seen.length).toBe(before);
  } finally { await api.close(); }
});
