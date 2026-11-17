import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { applyProviderState, createProviderStatePreview, parseProviderStateProjection, parseProviderUpdate } from '../src/extensions/runtime-provider-state';
// Preview column of R0806 (dynamic provider state). The browser preview runs no package code and starts no process:
// these are the labelled stand-in of src/extensions/runtime-provider-state.ts following the native rules of
// src-tauri/src/extensions/runtime_provider_state.rs, driven by a test hook that plays the service's
// `panda.providers.update`. The real host side (the native roster, the send path, the `limits` and `accounts`
// resources, two tasks on one launch state, the fake agent and the fake identity flow) is the native test module
// `runtime_provider_state::tests` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-provider-state/extension.json'));
const OWNER = manifest.id as string;
const PROVIDER = manifest.contributes.providers[0].id as string;
const CANARY = ['canary', 'token', 'r0806'].join('-');
const READY = {
  readiness: { state: 'ready', reason: 'Signed in as Fixture User.' }, account: { label: 'Fixture User' },
  models: [{ id: 'fixture-large', name: 'Fixture large', efforts: ['low', 'high'], contextWindow: 200000, speedTiers: [{ id: 'fast', name: 'Fast' }] }, { id: 'fixture-small', name: 'Fixture small', efforts: [] }],
  limits: { windows: [{ id: 'session', label: 'Session', usedPercent: 12.5, resetsAt: '2026-11-17T12:00:00Z' }] },
};
const SIGNED_OUT = { readiness: { state: 'signedOut', reason: 'Sign in to use the fixture provider.' } };

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionProviderState.call(command, args), [command, args] as const);
const publish = (page: Page, state: unknown, extra: Record<string, unknown> = {}) => ipc(page, 'extensions_provider_state_service', { op: 'update', id: OWNER, provider: PROVIDER, state, ...extra });
const roster = async (page: Page) => (await ipc(page, 'list_providers') as { id: string; installed: boolean; models: { id: string }[]; metadata: Record<string, any> }[]).find(item => item.id === PROVIDER)!;
const grant = (page: Page, op: 'grant' | 'revoke') => ipc(page, 'extensions_runtime_grant', { request: { op, id: OWNER, permission: 'ui.dynamic' } });
const refused = async (promise: Promise<unknown>, code: string) => { await expect(promise).rejects.toThrow(new RegExp(code)); };
async function boot(page: Page) {
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-provider-state-a', trusted: true } },
    ]));
  }, manifest);
  await page.goto('/?provider-state'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionProviderState);
  await grant(page, 'grant');
}

test('extensions provider state: the fixture manifest is valid, signed out with no models, and its sign-in commands are the package\'s own', () => {
  const checked = validateContract('packages', [manifest]);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(manifest.contributes.providers[0].models).toEqual([]);
  expect(manifest.contributes.providers[0].metadata.readiness.state).toBe('signedOut');
  const withBadCommand = structuredClone(manifest); withBadCommand.contributes.providers[0].metadata.signOut = { command: 'sample.provider-state/nowhere' };
  expect(validateContract('packages', [withBadCommand]).ok, 'a sign-out command the package does not declare').toBe(false);
  const withoutSignIn = structuredClone(manifest); delete withoutSignIn.contributes.providers[0].metadata.signIn; delete withoutSignIn.contributes.providers[0].metadata.signOut;
  expect(validateContract('packages', [withoutSignIn]).ok, 'empty models need the sign-in binding for a handler provider; a launch provider is exempt').toBe(true);
  expect(readFileSync(new URL('./fixtures/extensions/runtime-provider-state/main.cjs', import.meta.url), 'utf8')).not.toMatch(/accessToken|access_token['"]?\s*:/);
});

test('extensions provider state: updates are strict, bounded and carry nothing a credential could ride in', () => {
  expect(parseProviderUpdate(READY).models).toHaveLength(2);
  for (const bad of [{}, { extra: 1 }, { readiness: { state: 'ready' } }, { readiness: { state: 'fine', reason: 'x' } }, { account: { label: 'x', token: CANARY } },
    { models: [{ id: 'a', name: 'A', efforts: ['Bad Effort'] }] }, { models: [{ id: 'a', name: 'A', efforts: [] }, { id: 'a', name: 'A', efforts: [] }] },
    { models: Array.from({ length: 33 }, (_, index) => ({ id: `m${index}`, name: 'M', efforts: [] })) }, { limits: { windows: [{ id: 's', label: 'S', usedPercent: 101 }] } },
    { limits: { windows: [], secret: CANARY } }, 'ready', null]) expect(() => parseProviderUpdate(bad), JSON.stringify(bad)).toThrow(/InvalidShape/);
  expect(() => parseProviderUpdate({ limits: { windows: [], credits: 'x'.repeat(4096) } })).toThrow(/LimitExceeded/);
  expect(parseProviderStateProjection({ schemaVersion: 2 }).providers).toEqual([]);
  expect(parseProviderStateProjection({ schemaVersion: 1, revision: 0, recorder: [], providers: [{ id: 'a.b/c', owner: 'a.b', token: CANARY }] }).providers).toEqual([]);
});

test('extensions provider state: sign-in fills the roster, picker data and limits from one overlay, and sign-out invalidates readiness', async ({ page }) => {
  await boot(page);
  const before = await roster(page);
  expect(before.models).toEqual([]);
  expect(before.installed).toBe(false);
  expect(before.metadata.readiness.state).toBe('signedOut');
  // Sign-in (the fake identity flow is native): the service publishes the account's models, limits and label.
  await publish(page, READY);
  const ready = await roster(page);
  expect(ready.installed).toBe(true);
  expect(ready.models.map(model => model.id)).toEqual(['fixture-large', 'fixture-small']);
  expect(ready.metadata).toMatchObject({ readiness: { state: 'ready' }, account: { label: 'Fixture User' }, limits: { windows: [{ id: 'session', usedPercent: 12.5 }] } });
  const models = await ipc(page, 'list_provider_models', { provider: PROVIDER }) as { id: string }[];
  expect(models.map(model => model.id)).toEqual(['fixture-large', 'fixture-small']);
  // The projection the usage view and the resources read says the same thing, field for field.
  const projection = await ipc(page, 'extensions_provider_state') as { providers: any[] };
  expect(projection.providers).toHaveLength(1);
  expect(projection.providers[0]).toMatchObject({ id: PROVIDER, owner: OWNER, readiness: { state: 'ready' }, account: { label: 'Fixture User' }, limits: ready.metadata.limits });
  expect(projection.providers[0].models.map((model: { id: string }) => model.id)).toEqual(ready.models.map(model => model.id));
  // A partial update merges: limits move, the models stay.
  await publish(page, { limits: { windows: [{ id: 'session', label: 'Session', usedPercent: 99 }] } });
  expect((await roster(page)).metadata.limits.windows[0].usedPercent).toBe(99);
  expect((await roster(page)).models).toHaveLength(2);
  // Sign-out: readiness is invalidated and nothing ready-looking survives, whatever else the update carried.
  await publish(page, { ...SIGNED_OUT, models: READY.models, limits: READY.limits });
  const out = await roster(page);
  expect(out.installed).toBe(false);
  expect(out.models).toEqual([]);
  expect(out.metadata.readiness).toEqual(SIGNED_OUT.readiness);
  expect(out.metadata.account).toBeUndefined();
  expect(out.metadata.limits).toBeUndefined();
  // The Sign in and Sign out actions resolve to the package's own commands.
  expect(await ipc(page, 'extensions_provider_action', { provider: PROVIDER, action: 'signIn' })).toMatchObject({ command: 'sample.provider-state/sign-in', owner: OWNER });
  expect(await ipc(page, 'extensions_provider_action', { provider: PROVIDER, action: 'signOut' })).toMatchObject({ command: 'sample.provider-state/sign-out' });
  await refused(ipc(page, 'extensions_provider_action', { provider: PROVIDER, action: 'delete' }), 'NotFound');
});

test('extensions provider state: a rejected update, a revoke, a disable and a stopped service each leave the manifest values and show no secret', async ({ page }) => {
  await boot(page);
  await publish(page, READY);
  // Fault: a bad update changes nothing and is only counted.
  await refused(publish(page, { models: 'no' }), 'InvalidShape');
  await refused(publish(page, { account: { label: 'x', accessToken: CANARY } }), 'InvalidShape');
  expect((await roster(page)).models).toHaveLength(2);
  const counted = await ipc(page, 'extensions_provider_state') as { providers: { updates: number; rejected: number }[] };
  expect(counted.providers[0]).toMatchObject({ updates: 1, rejected: 2 });
  // Ownership and caller rules, checked on every call.
  await refused(publish(page, READY, { provider: 'sample.other/agent' }), 'NotFound');
  await refused(publish(page, READY, { provider: 'codex' }), 'NotFound');
  await refused(publish(page, READY, { caller: 'panel' }), 'UnsupportedCapability');
  // A stopped service returns the manifest values.
  expect(await ipc(page, 'extensions_provider_state_service', { op: 'stop', id: OWNER })).toBe(true);
  expect((await roster(page)).models).toEqual([]);
  expect((await roster(page)).metadata.readiness.state).toBe('signedOut');
  // Revoke wins at once.
  await publish(page, READY);
  expect((await roster(page)).models).toHaveLength(2);
  await grant(page, 'revoke');
  expect((await roster(page)).models).toEqual([]);
  await refused(publish(page, READY), 'PermissionDenied');
  // Disable drops it as well.
  await grant(page, 'grant');
  await publish(page, READY);
  await ipc(page, 'extensions_enable', { id: OWNER, enabled: false });
  expect(((await ipc(page, 'extensions_provider_state')) as { providers: unknown[] }).providers).toEqual([]);
  await refused(publish(page, READY), 'NotFound');
  // Nothing the UI reads holds a secret.
  const text = JSON.stringify([await ipc(page, 'extensions_provider_state'), await ipc(page, 'list_providers'), await page.locator('body').innerText()]);
  expect(text).not.toContain(CANARY);
});

test('extensions provider state: two tasks and the roster read one overlay, and the pure store follows the same rules', () => {
  const store = createProviderStatePreview();
  const allowed = { granted: true, declared: true };
  store.update(OWNER, PROVIDER, READY, allowed);
  store.update(OWNER, PROVIDER, { limits: { windows: [] } }, allowed); // a second task's refresh lands on the same entry
  expect(store.projection().providers).toHaveLength(1);
  expect(store.projection().providers[0]).toMatchObject({ updates: 2, rejected: 0 });
  const base = { id: PROVIDER, name: 'Fixture account agent', installed: false, path: null, version: '1.0.0', models: [], metadata: manifest.contributes.providers[0].metadata } as any;
  const shown = applyProviderState(base, store.projection());
  expect(shown.models.map((model: { id: string }) => model.id)).toEqual(['fixture-large', 'fixture-small']);
  expect(shown.models[0]).toMatchObject({ contextWindow: 200000, speedTiers: [{ id: 'fast', name: 'Fast' }] });
  expect(shown.installed).toBe(true);
  expect(applyProviderState(base, parseProviderStateProjection({ schemaVersion: 0 }))).toBe(base);
  expect(() => store.update('other.package', PROVIDER, READY, allowed)).toThrow(/NotFound/);
  expect(() => store.update(OWNER, PROVIDER, READY, { granted: false, declared: true })).toThrow(/PermissionDenied/);
  expect(store.sweep(owner => owner !== OWNER, 'revoked-or-disabled')).toBe(true);
  expect(store.projection().providers).toEqual([]);
  expect(store.projection().recorder.some(item => item.what === 'clear' && item.detail === 'revoked-or-disabled')).toBe(true);
});
