import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { program } from './fixtures/extensions/backends/test-support.mjs';
// Preview column of R0805 (held credentials used without being read, and account switching). The browser preview runs no
// package code and has no network or host secret store of its own: its transport is a function this test supplies (a REAL
// loopback call to a recording API of this file and to the shared fake cloud B3) and its held credentials are labelled
// stand-ins seeded below. The host-side behaviour (the real stores, grants per call, the activity file) is the native
// module `runtime_held_credentials::tests` and `runtime_connection_adapters::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MANIFEST = read('tests/fixtures/extensions/runtime-held-credentials/extension.json');
const ID = JSON.parse(MANIFEST).id as string, OTHER = 'sample.other-package';
const CANARY = ['tok', 'canary', 'held', 'credential', 'r0805'].join('-');
const WORK = `${CANARY}-work`, ALERTS = `${CANARY}-alerts`;
const PROVIDER = `${ID}/provider`, ACCOUNT = `${ID}/account`, BOT = `${ID}/bot`, ANOTHER = `${ID}/other`, CLOUD = `${ID}/cloud`;

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined> };
async function recorder() {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    const path = (request.url ?? '').split('?')[0];
    const json = (value: unknown) => { const text = JSON.stringify(value); response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text); };
    // `/mirror` echoes the credential header back, as a hostile or careless API might.
    json({ ok: true, path, echo: path === '/mirror' ? request.headers.authorization ?? null : null, key: path === '/usage' ? request.headers['x-api-key'] ?? null : null });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionHeldCredentials.call(command, args), [command, args] as const);
const connections = (page: Page, id: string, method: string, params?: unknown, caller = 'service') => ipc(page, 'extensions_connection_adapters_service', { id, caller, method, params });
const held = (page: Page, args: Record<string, unknown>) => ipc(page, 'extensions_held_credentials_service', args);
const grant = (page: Page, id: string, permission: string, op: 'grant' | 'revoke' | 'narrow' = 'grant', scope?: Record<string, string[]>) => ipc(page, 'extensions_runtime_grant', { request: { op, id, permission, scope } });
const refused = async (promise: Promise<unknown>, code: string) => { await expect(promise).rejects.toThrow(new RegExp(code)); };
const activity = (page: Page, id = ID) => ipc(page, 'extensions_credential_activity', { id }) as Promise<{ items: { kind: string; item: string; address?: string; package: string }[] }>;
async function finish(page: Page, id: string, started: { request: string }): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await connections(page, id, 'connections.poll', { connection: 'x', operation: 'y', request: started.request }) as { state: string };
    if (polled.state !== 'running') return polled;
    await page.waitForTimeout(20);
  }
  throw new Error('the request never finished');
}
const use = async (page: Page, connection: string, operation = 'get') => finish(page, ID, await connections(page, ID, 'connections.start', { connection, operation }) as { request: string });

type Rig = { api: Awaited<ReturnType<typeof recorder>>; cloud: string; control: string };
async function boot(page: Page, rig: Rig) {
  const text = MANIFEST.replaceAll('http://127.0.0.1:9/v1/', `${rig.cloud}/v1/`).replaceAll('http://127.0.0.1:9', rig.api.base);
  const manifest = JSON.parse(text);
  const other = { ...manifest, id: OTHER, runtime: { ...manifest.runtime, activationEvents: [`${OTHER}/store`], service: { start: 'onEnable' } }, contributes: { commands: [{ id: `${OTHER}/store`, title: 'Other', action: { kind: 'runCommand' } }] }, permissions: ['ui.contribute', 'runtime.service', 'credentials.use'] };
  await page.exposeFunction('__nodeLoopback', async (request: { method: string; url: string; headers: [string, string][]; body: string | null }) => {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { status: response.status, text: await response.text(), redirected: response.status >= 300 && response.status < 400 };
  });
  await page.addInitScript(([manifest, other]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__connectionTransport = (request: unknown) => (window as any).__nodeLoopback(request);
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-held-a', trusted: true } },
      { manifest: other, enabled: true, icons: {}, executable: { digest: 'preview-held-b', trusted: true } },
    ]));
  }, [manifest, other]);
  await page.goto('/?held-credentials&connection-adapters'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionHeldCredentials);
  for (const permission of ['connections.request', 'harnesses.accounts.read']) await grant(page, ID, permission);
  // Stand-ins for what PandaCode holds. The user grants three items; `provider:deepseek` stays outside the grant.
  for (const [item, value] of [['provider:glm', CANARY], ['connection:work', WORK], ['bot:alerts', ALERTS], ['provider:deepseek', `${CANARY}-deepseek`]]) await held(page, { op: 'seed', item, value });
  await grant(page, ID, 'credentials.use', 'grant', { items: ['provider:glm', 'connection:work', 'bot:alerts'] });
}
const withRig = (name: string, body: (page: Page, rig: Rig) => Promise<void>) => test(name, async ({ page }) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  const api = await recorder();
  const backend = program({ after: (cleanup: () => Promise<void> | void) => cleanups.push(cleanup) } as any, './fake-cloud/fake-cloud.mjs', ['--identity-port', '0', '--api-port', '0']);
  try {
    const ready = await backend.out.next((value: any) => value.ready === true, 8000) as { api: string; control: string };
    const url = (value: string) => value.startsWith('http') ? value : `http://${value}`;
    const rig = { api, cloud: url(ready.api), control: url(ready.control) };
    await boot(page, rig);
    await body(page, rig);
  } finally {
    await api.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

withRig('extensions held credentials: a granted request reaches the API with the held credential as a header, a bearer token and a query value, and the service sees none of it', async (page, rig) => {
  // Header authentication: the host attached the held provider key.
  const header = await use(page, PROVIDER);
  expect(header, JSON.stringify(header)).toMatchObject({ state: 'completed', response: { schemaVersion: 1, status: 200 } });
  expect(rig.api.seen[0].headers['x-api-key']).toBe(CANARY);
  // Bearer authentication from a saved connection's secret, echoed back by the API: the host replaced it in the answer.
  const bearer = await use(page, ACCOUNT);
  expect(rig.api.seen.at(-1)!.headers.authorization).toBe(`Bearer ${WORK}`);
  expect(bearer.response.body.echo).toBe('Bearer [redacted]');
  // Query authentication from a bot token.
  const query = await use(page, BOT);
  expect(rig.api.seen.at(-1)!.url).toBe(`/query?key=${ALERTS}`);
  // The shared fake cloud B3 saw the header the host attached.
  const cloud = await use(page, CLOUD, 'usage');
  expect(cloud.state, JSON.stringify(cloud)).toBe('completed');
  const log = await (await fetch(`${rig.control}/control/log`)).text();
  expect(log).toContain('x-api-key'); expect(log).toContain(CANARY);
  // No result, status or poll carries any held value.
  const status = await connections(page, ID, 'connections.status', { connection: PROVIDER, operation: 'get' });
  expect(status).toEqual({ schemaVersion: 1, state: 'connected', credential: null });
  expect(JSON.stringify([header, bearer, query, cloud, status])).not.toContain(CANARY);
  // The activity list names the credential, the address and the package, newest first, and never the value.
  const list = await activity(page);
  expect(list.items.map(entry => [entry.kind, entry.item, entry.package])).toEqual([
    ['credential.use', 'provider:glm', ID], ['credential.use', 'bot:alerts', ID], ['credential.use', 'connection:work', ID], ['credential.use', 'provider:glm', ID],
  ]);
  expect(list.items[2].address).toBe(`${rig.api.base}/mirror`);
  expect(list.items[1].address, 'the query is not kept').toBe(`${rig.api.base}/query`);
  expect(JSON.stringify(list)).not.toMatch(new RegExp(CANARY));
  expect((await activity(page, OTHER)).items).toEqual([]);
});

withRig('extensions held credentials: another item, a narrowed or revoked grant, a credential nobody holds and a foreign package are denied', async (page, rig) => {
  await refused(connections(page, ID, 'connections.start', { connection: ANOTHER, operation: 'get' }), 'PermissionDenied');
  expect(rig.api.seen, 'a denied use reaches no API').toEqual([]);
  expect((await activity(page)).items, 'a denied use writes nothing').toEqual([]);
  // Narrowing drops an item; the next use of it is denied while the others continue.
  await grant(page, ID, 'credentials.use', 'narrow', { items: ['provider:glm'] });
  await refused(connections(page, ID, 'connections.start', { connection: ACCOUNT, operation: 'get' }), 'PermissionDenied');
  expect((await use(page, PROVIDER)).state).toBe('completed');
  // Revoking denies every use and every status of a held credential.
  await grant(page, ID, 'credentials.use', 'revoke');
  await refused(connections(page, ID, 'connections.start', { connection: PROVIDER, operation: 'get' }), 'PermissionDenied');
  await refused(connections(page, ID, 'connections.status', { connection: PROVIDER, operation: 'get' }), 'PermissionDenied');
  // A credential PandaCode does not hold: NotFound, and nothing is written for a use that did not happen.
  await grant(page, ID, 'credentials.use', 'grant', { items: ['provider:glm', 'bot:alerts'] });
  await held(page, { op: 'seed', item: 'bot:alerts', value: null });
  const before = (await activity(page)).items.length;
  await refused(connections(page, ID, 'connections.start', { connection: BOT, operation: 'get' }), 'NotFound');
  expect((await activity(page)).items.length).toBe(before);
  // A panel never uses the channel; another package has no grant and meets nothing; there is no way to read a value.
  await refused(connections(page, ID, 'connections.start', { connection: PROVIDER, operation: 'get' }, 'panel'), 'UnsupportedCapability');
  await refused(connections(page, OTHER, 'connections.start', { connection: PROVIDER, operation: 'get' }), 'PermissionDenied');
  await refused(connections(page, ID, 'credentials.read', { item: 'provider:glm' }), 'UnsupportedCapability');
  expect(rig.api.seen.every(entry => entry.headers['x-api-key'] === CANARY || entry.url === '/mirror' || entry.url.startsWith('/query'))).toBe(true);
  expect(read('src/extensions/sdk/index.d.ts')).not.toMatch(/['"]credentials\.read['"]\s*[|;]/);
});

withRig('extensions held credentials: switching a known account changes the active flags and the accounts revision, needs the account\'s item and returns or replaces no credential', async (page) => {
  const accounts = async (harness = 'claude') => await held(page, { op: 'accounts', harness }) as { items: { id: string; active: boolean }[]; revision: string };
  const first = await accounts();
  expect(first.items.map(row => [row.id, row.active])).toEqual([['default', true], ['work', false], ['personal', false]]);
  await grant(page, ID, 'credentials.use', 'grant', { items: ['connection:work', 'provider:claude'] });
  expect(await held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'work' } })).toBeNull();
  const second = await accounts();
  expect(second.items.map(row => [row.id, row.active])).toEqual([['default', false], ['work', true], ['personal', false]]);
  expect(second.revision).not.toBe(first.revision);
  // Switching to the active account again is a no-op with the same revision; another harness is not touched.
  expect(await held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'work' } })).toBeNull();
  expect((await accounts()).revision).toBe(second.revision);
  expect((await accounts('codex')).items.map(row => [row.id, row.active])).toEqual([['default', true]]);
  // The account's own item is the grant: `personal` is outside it.
  await refused(held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'personal' } }), 'PermissionDenied');
  expect((await accounts()).revision).toBe(second.revision);
  // Unknown harness or account, a field the contract does not know, a panel and a foreign package.
  await refused(held(page, { op: 'switch', id: ID, params: { harness: 'nobody', account: 'work' } }), 'NotFound');
  await refused(held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'missing' } }), 'NotFound');
  await refused(held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'work', credential: 'x' } }), 'InvalidArguments');
  await refused(held(page, { op: 'switch', id: ID, caller: 'panel', params: { harness: 'claude', account: 'work' } }), 'UnsupportedCapability');
  await refused(held(page, { op: 'switch', id: OTHER, params: { harness: 'claude', account: 'work' } }), 'PermissionDenied');
  // Back to the harness's own setup needs `provider:claude`.
  expect(await held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'default' } })).toBeNull();
  expect((await accounts()).items.map(row => [row.id, row.active])).toEqual([['default', true], ['work', false], ['personal', false]]);
  // Revoking ends it.
  await grant(page, ID, 'credentials.use', 'revoke');
  await refused(held(page, { op: 'switch', id: ID, params: { harness: 'claude', account: 'work' } }), 'PermissionDenied');
  const list = await activity(page);
  expect(list.items.every(entry => entry.kind === 'account.switch' && entry.address === undefined && entry.package === ID)).toBe(true);
  expect(list.items.map(entry => entry.item)).toEqual(['provider:claude', 'connection:work', 'connection:work']);
  expect(JSON.stringify([first, second, list])).not.toContain(CANARY);
});

test('extensions held credentials: the schema accepts the held source and the contract has no credentials.read, a webview or panel reader of a value or a stream adapter', async ({ page }) => {
  await page.goto('/?held-credentials&connection-adapters'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionRuntimeGrants);
  const checked = await page.evaluate(([text]) => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    const manifest = JSON.parse(text);
    const change = (edit: (connections: any[]) => void) => { const copy = structuredClone(manifest); edit(copy.contributes.connections); return validateContract('packages', [copy]); };
    return {
      fixture: validateContract('packages', [manifest]).ok,
      streaming: change(connections => { connections[0].adapter = 'stream'; }).ok,
      readPermission: (() => { const copy = structuredClone(manifest); copy.permissions.push('credentials.read'); return validateContract('packages', [copy]).ok; })(),
    };
  }, [MANIFEST]);
  expect(checked).toEqual({ fixture: true, streaming: false, readPermission: false });
  expect(read('src/extensions/sdk/index.d.ts')).toContain('switchAccount(options: { harness: string; account: string }): Promise<null>');
});
