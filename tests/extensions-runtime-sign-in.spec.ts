import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0803 (browser sign-in). The browser preview runs no package code, opens no browser and binds no
// port: these are the synthetic stand-ins of src/extensions/runtime-sign-in.ts following the native rules on a
// simulated clock and simulated ports. The real host-side behaviour (loopback listener, the fake browser B4 and the
// fake identity server B3, the package secret store) is the native test module `runtime_sign_in::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-sign-in/extension.json'));
const other = { ...manifest, id: 'sample.other-package', runtime: { ...manifest.runtime, activationEvents: ['sample.other-package/connect'] }, contributes: { commands: [{ id: 'sample.other-package/connect', title: 'Other', action: { kind: 'runCommand' } }] } };
const ID = manifest.id, OTHER = other.id;
const CODE = ['canary', 'code', 'r0803'].join('-');
const AUTHORIZE = 'http://127.0.0.1:9/authorize?client_id=sample&redirect_uri={redirect_uri}&state=s1';

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionSignIn.call(command, args), [command, args] as const);
const service = (page: Page, op: string, args: Record<string, unknown> = {}) => ipc(page, 'extensions_sign_in_service', { op, ...args });
const start = (page: Page, id: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  service(page, 'start', { id, params: { authorizeUrl: AUTHORIZE, callback: { path: '/callback' }, timeoutMs: 5000, ...params }, ...extra }) as Promise<{ redirectUri: string; authorizeUrl: string }>;
const outcome = (page: Page, id: string) => service(page, 'outcome', { id }) as Promise<{ pending: boolean; outcome?: Record<string, unknown>; error?: string }>;
const grant = (page: Page, id: string, op: 'grant' | 'revoke') => ipc(page, 'extensions_runtime_grant', { request: { op, id, permission: 'auth.signIn' } });
async function boot(page: Page) {
  await page.addInitScript(([manifest, other]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-sign-in-a', trusted: true } },
      { manifest: other, enabled: true, icons: {}, executable: { digest: 'preview-sign-in-b', trusted: true } },
    ]));
  }, [manifest, other]);
  await page.goto('/?sign-in'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionSignIn);
  await grant(page, ID, 'grant'); await grant(page, OTHER, 'grant');
}
const refused = async (promise: Promise<unknown>, code: string) => { await expect(promise).rejects.toThrow(new RegExp(code)); };

test('extensions sign-in: the browser callback completes the flow with the whole address and shows no code in the notice', async ({ page }) => {
  await boot(page);
  const { redirectUri, authorizeUrl } = await start(page, ID, { title: 'Sample cloud' });
  expect(authorizeUrl).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const waiting = await ipc(page, 'extensions_sign_in') as { flows: { id: string; notice: string; phase: string }[] };
  expect(waiting.flows).toMatchObject([{ id: ID, notice: 'Waiting for sign-in: Sample cloud', phase: 'waiting' }]);
  expect(JSON.stringify(waiting)).not.toContain('redirect_uri');
  expect(await outcome(page, ID)).toMatchObject({ pending: true });
  expect(await service(page, 'browser', { id: ID, target: '/favicon.ico' })).toBe(404);
  expect(await service(page, 'browser', { id: ID, target: '/callback-other?code=x' })).toBe(404);
  expect(await service(page, 'browser', { id: ID, target: `/callback?code=${CODE}&state=s1` })).toBe(200);
  expect(await outcome(page, ID)).toEqual({ pending: false, outcome: { status: 'completed', url: `${redirectUri}?code=${CODE}&state=s1`, redirectUri, via: 'callback' } });
  const after = await ipc(page, 'extensions_sign_in');
  expect(JSON.stringify(after)).not.toContain(CODE);
  expect((after as { flows: unknown[] }).flows).toEqual([]);
  expect(await service(page, 'listening', { port: Number(new URL(redirectUri).port) })).toBe(false);
});

test('extensions sign-in: cancel and timeout return their statuses, the manual path takes a pasted address', async ({ page }) => {
  await boot(page);
  const first = await start(page, ID);
  await refused(ipc(page, 'extensions_sign_in_paste', { id: ID, url: first.redirectUri }), 'UnsupportedCapability');
  expect(await ipc(page, 'extensions_sign_in_cancel', { id: OTHER })).toEqual({ cancelled: false });
  expect(await ipc(page, 'extensions_sign_in_cancel', { id: ID })).toEqual({ cancelled: true });
  expect(await outcome(page, ID)).toEqual({ pending: false, outcome: { status: 'cancelled' } });
  expect(await service(page, 'listening', { port: Number(new URL(first.redirectUri).port) })).toBe(false);

  const second = await start(page, ID, { timeoutMs: 2000 });
  await service(page, 'advance', { ms: 1999 });
  expect(await outcome(page, ID)).toMatchObject({ pending: true });
  await service(page, 'advance', { ms: 1 });
  expect(await outcome(page, ID)).toEqual({ pending: false, outcome: { status: 'timeout' } });
  expect(await service(page, 'listening', { port: Number(new URL(second.redirectUri).port) })).toBe(false);

  // Manual: the wait ends, the listener closes, the paste dialog stays open for two minutes.
  const manual = await start(page, ID, { timeoutMs: 1000, manual: true });
  await service(page, 'advance', { ms: 1000 });
  expect((await ipc(page, 'extensions_sign_in') as { flows: { phase: string }[] }).flows[0].phase).toBe('paste');
  expect(await service(page, 'listening', { port: Number(new URL(manual.redirectUri).port) })).toBe(false);
  for (const url of ['not an address', manual.redirectUri.replace('/callback', '/elsewhere'), 'https://example.com/callback?code=x']) await refused(ipc(page, 'extensions_sign_in_paste', { id: ID, url }), 'InvalidArguments');
  await ipc(page, 'extensions_sign_in_paste', { id: ID, url: `${manual.redirectUri}?code=${CODE}` });
  expect(await outcome(page, ID)).toEqual({ pending: false, outcome: { status: 'completed', url: `${manual.redirectUri}?code=${CODE}`, redirectUri: manual.redirectUri, via: 'manual' } });
  await start(page, ID, { timeoutMs: 1000, manual: true });
  await service(page, 'advance', { ms: 1000 + 120_000 });
  expect(await outcome(page, ID)).toEqual({ pending: false, outcome: { status: 'timeout' } });
});

test('extensions sign-in: a second flow and a taken port are conflicts that leak no listener', async ({ page }) => {
  await boot(page);
  const first = await start(page, ID);
  await refused(start(page, ID), 'Conflict');
  const second = await start(page, OTHER); // another package waits on its own port
  expect(new URL(second.redirectUri).port).not.toBe(new URL(first.redirectUri).port);
  await ipc(page, 'extensions_sign_in_cancel', { id: ID }); await ipc(page, 'extensions_sign_in_cancel', { id: OTHER });
  await service(page, 'occupy', { port: 51234 });
  await refused(start(page, ID, { callback: { path: '/callback', port: 51234 } }), 'Conflict');
  expect((await ipc(page, 'extensions_sign_in') as { flows: unknown[] }).flows).toEqual([]);
  await service(page, 'free', { port: 51234 });
  const fixed = await start(page, ID, { callback: { path: '/callback', port: 51234, host: 'localhost' } });
  expect(fixed.redirectUri).toBe('http://localhost:51234/callback');
  expect(await service(page, 'listening', { port: 51234 })).toBe(true);
  await ipc(page, 'extensions_sign_in_cancel', { id: ID });
  expect(await service(page, 'listening', { port: 51234 })).toBe(false);
});

test('extensions sign-in: revoke, disable, untrust and a malformed callback dispose the flow', async ({ page }) => {
  await boot(page);
  const free = async (flow: { redirectUri: string }) => expect(await service(page, 'listening', { port: Number(new URL(flow.redirectUri).port) })).toBe(false);
  let flow = await start(page, ID);
  await grant(page, ID, 'revoke');
  expect(await outcome(page, ID)).toEqual({ pending: false, error: 'PermissionDenied' });
  await free(flow);
  await refused(start(page, ID), 'PermissionDenied');
  await grant(page, ID, 'grant');
  flow = await start(page, ID);
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  expect(await outcome(page, ID)).toEqual({ pending: false, error: 'PermissionDenied' });
  await free(flow);
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  flow = await start(page, ID);
  await ipc(page, 'extensions_runtime', { request: { op: 'trust', id: ID, digest: 'preview-sign-in-a', allow: false } });
  expect(await outcome(page, ID)).toEqual({ pending: false, error: 'PermissionDenied' });
  await free(flow);
  await ipc(page, 'extensions_runtime', { request: { op: 'trust', id: ID, digest: 'preview-sign-in-a', allow: true } });
  await ipc(page, 'extensions_enable', { id: ID, enabled: true }); // untrusting also disables the package
  await grant(page, ID, 'grant');
  for (const [request, status] of [[{ target: 'garbage' }, 400], [{ method: 'POST', target: '/callback' }, 405]] as const) {
    flow = await start(page, ID);
    expect(await service(page, 'browser', { id: ID, ...request })).toBe(status);
    expect(await outcome(page, ID)).toEqual({ pending: false, error: 'InvalidShape' });
    await free(flow);
  }
});

test('extensions sign-in: options are validated, service only, and a missing browser needs the manual path', async ({ page }) => {
  await boot(page);
  await refused(start(page, ID, {}, { caller: 'panel' }), 'UnsupportedCapability');
  for (const params of [{ extra: 1 }, { authorizeUrl: 'file:///etc/passwd' }, { authorizeUrl: 'http://user:pw@127.0.0.1/a' }, { authorizeUrl: 5 }, { callback: { path: 'callback' } },
    { callback: { path: '/a?b=1' } }, { callback: { path: '/c', port: 0 } }, { callback: { path: '/c', host: 'evil.example' } }, { timeoutMs: 0 }, { timeoutMs: 900_001 }, { manual: 'yes' }, { title: 'x'.repeat(121) }]) {
    await refused(start(page, ID, params), 'InvalidArguments');
  }
  expect((await ipc(page, 'extensions_sign_in') as { flows: unknown[] }).flows).toEqual([]);
  await refused(start(page, ID, {}, { browser: 'missing' }), 'HostUnavailable');
  const manual = await start(page, ID, { manual: true }, { browser: 'missing' });
  const notice = (await ipc(page, 'extensions_sign_in') as { flows: { copyAddress: string | null }[] }).flows[0];
  expect(notice.copyAddress).toContain(`redirect_uri=${encodeURIComponent(manual.redirectUri)}`);
  await ipc(page, 'extensions_sign_in_paste', { id: ID, url: `${manual.redirectUri}?code=by-hand` });
  expect(await outcome(page, ID)).toMatchObject({ outcome: { status: 'completed', via: 'manual' } });
  // No package can start a flow without declaring the permission, and the SDK has no credentials.read.
  expect(read('src/extensions/sdk/index.d.ts')).not.toMatch(/['"]credentials\.read['"]/);
  const checked = await page.evaluate(manifest => (window as any).__extensionRuntimeGrants.validateContract('packages', [manifest]).ok, manifest);
  expect(checked).toBe(true);
});
