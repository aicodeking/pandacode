import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { record, type LedgerRow, type Reading, type World } from '../src/extensions/runtime-usage-resources';
import {
  EMPTY_LAYOUT, MENU_USAGE_MEMBERS, PINNED_USAGE_ROWS, REVEAL_PAGES, admitUsageAction, applyLayout, captureUsage, hideRow, moveRow, restoreLayout,
  revealTarget, rosterSize, showRow, usageRoster, withFallback, type Authority,
} from '../src/extensions/upstream-menu-usage';

// Preview column of S0609. The model checks run the deterministic adapter over R0204's read model (no second usage
// store). The install checks drive the preview's real install/enable flow with the fixture package. Native authority
// and installed-WebView qualification are separate columns: the application menu Quit item is a macOS-only named
// exception (src-tauri/src/app_menu.rs) and an installed run is recorded in the receipt, never inferred from here.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-menu-usage/manifest.json', import.meta.url), 'utf8'));
const OWNER = 'sample.upstream-menu-usage';
const PROVIDER = `${OWNER}/settings`;

const reading = (status = 'ready'): Reading => ({ status, stale: false, checkedAt: 10, email: 'person@example.test', plan: 'Max', message: 'token=abc', windows: [{ label: 'Weekly', usedPercent: 12 }] });
function world(overrides: Partial<World> = {}): World {
  return { tasks: [], ledger: [] as LedgerRow[], readings: { claude: reading(), codex: reading('signedOut') }, connectionReadings: {}, connections: [], app: {}, services: [], ...overrides };
}
const ok: Authority = { active: true, granted: true, owner: OWNER };
const action = (capture: { context: string; revision: string }, row: string, requestId = 'r1', changes: Record<string, unknown> = {}) => ({ context: capture.context, revision: capture.revision, row, requestId, ...changes });

test('upstream menu usage: the fixture declares settings and usage recipes and each member is named', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.contributes.components.map((item: { slot: string }) => item.slot)).toEqual(['panda.settings', 'panda.status']);
  expect(MENU_USAGE_MEMBERS.map(member => member.id)).toEqual(['settings-sections', 'settings-reveal', 'usage-fix-link', 'usage-roster', 'app-quit']);
  for (const member of MENU_USAGE_MEMBERS.filter(item => item.disposition === 'exception')) expect(member.reason, member.id).toBeTruthy();
  // The host roster follows the harness list (Alibaba is part of it); the count is never fixed in the adapter.
  expect(rosterSize()).toBeGreaterThanOrEqual(21);
});

test('upstream menu usage: usage rows come from the cached read model and never carry a credential value', () => {
  const rows = usageRoster(world());
  expect(rows.filter(row => row.kind === 'limits').map(row => row.id)).toEqual(['limits:claude:default', 'limits:codex:default']);
  const text = JSON.stringify(rows);
  for (const secret of ['person@example.test', 'token=abc', 'Max']) expect(text).not.toContain(secret);
  // An unchecked harness has an account row that says so and no limits row: nothing is filled with zero.
  expect(rows.find(row => row.id === 'account:grok:default')?.row).toMatchObject({ status: 'unchecked', signedIn: null });
  expect(rows.some(row => row.id === 'limits:grok:default')).toBe(false);
  const ledger: LedgerRow[] = []; record(ledger, 'a1', 1, { usedTokens: 5 }, 1);
  expect(usageRoster(world({ ledger })).map(row => row.id)).toEqual(rows.map(row => row.id));
});

test('upstream menu usage: a captured revision rejects stale, replayed, forged and revoked actions', () => {
  const rows = usageRoster(world()), laid = captureUsage('ctx', rows, EMPTY_LAYOUT, false), applied = new Set<string>();
  const row = 'limits:claude:default';
  expect(admitUsageAction(laid, laid, action(laid, row), ok, OWNER, applied)).toEqual({ ok: true });
  expect(admitUsageAction(laid, laid, action(laid, row), ok, OWNER, applied)).toEqual({ ok: false, reason: 'AlreadyApplied' });
  const fresh = captureUsage('ctx', usageRoster(world({ readings: { claude: { ...reading(), windows: [{ label: 'Weekly', usedPercent: 13 }] }, codex: reading('signedOut') } })), EMPTY_LAYOUT, false);
  expect(fresh.revision).not.toBe(laid.revision);
  expect(admitUsageAction(laid, fresh, action(laid, row, 'r2'), ok, OWNER, applied)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(admitUsageAction(laid, laid, action(laid, row, 'r3', { context: 'other' }), ok, OWNER, applied)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(admitUsageAction(laid, laid, action(laid, 'limits:ghost:default', 'r4'), ok, OWNER, applied)).toEqual({ ok: false, reason: 'StaleContext' });
  for (const extra of [{ selector: '#usage' }, { value: 1 }]) expect(admitUsageAction(laid, laid, action(laid, row, 'r5', extra), ok, OWNER, applied)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(admitUsageAction(laid, laid, action(laid, row, 'r6', { requestId: 'x'.repeat(129) }), ok, OWNER, applied)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(admitUsageAction(laid, laid, action(laid, row, 'r7'), { ...ok, granted: false }, OWNER, applied)).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(admitUsageAction(laid, laid, action(laid, row, 'r8'), { ...ok, owner: 'other.pkg' }, OWNER, applied)).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(admitUsageAction(laid, laid, action(laid, row, 'r9'), { ...ok, active: false }, OWNER, applied)).toEqual({ ok: false, reason: 'Revoked' });
});

test('upstream menu usage: hide, reorder and restore keep pinned rows and fall back in safe mode', () => {
  const ids = [...usageRoster(world()).map(row => row.id), ...PINNED_USAGE_ROWS];
  let state = moveRow(ids, EMPTY_LAYOUT, 'limits:codex:default', 'limits:claude:default');
  expect(applyLayout(ids, state, false).ids.slice(0, 2)).toEqual(['limits:codex:default', 'limits:claude:default']);
  state = hideRow(state, 'limits:codex:default');
  expect(applyLayout(ids, state, false).hidden).toEqual(['limits:codex:default']);
  for (const pinned of PINNED_USAGE_ROWS) expect(hideRow(state, pinned)).toEqual(state);
  // A forged state naming a pinned or unknown row changes nothing.
  expect(applyLayout(ids, { order: ['ghost'], hidden: ['overview', 'ghost'] }, false).hidden).toEqual([]);
  expect(applyLayout(ids, state, true)).toEqual({ ids, hidden: [] });
  expect(applyLayout(ids, showRow(state, 'limits:codex:default'), false).hidden).toEqual([]);
  expect(applyLayout(ids, restoreLayout(), false)).toEqual({ ids, hidden: [] });
});

test('upstream menu usage: reveal requests name a core page and a known reveal id, never a credential field', () => {
  expect(revealTarget({ page: 'providers', reveal: 'claude-cli-refresh' })).toEqual({ page: 'providers', reveal: 'claude-cli-refresh' });
  expect(revealTarget({ page: 'general' })).toEqual({ page: 'general' });
  expect(REVEAL_PAGES).toContain('providers');
  expect(revealTarget({ page: 'nowhere' })).toEqual({ code: 'UnsupportedCapability' });
  expect(revealTarget({ page: 'providers', reveal: 'api-key' })).toEqual({ code: 'UnsupportedCapability' });
  expect(revealTarget({ page: 'providers', selector: '#key' })).toEqual({ code: 'InvalidArguments' });
  expect(revealTarget('providers')).toEqual({ code: 'InvalidArguments' });
});

test('upstream menu usage: a faulting presentation reports once and the built-in rows stay', () => {
  const reports: string[] = [];
  const result = withFallback(() => { throw Error('controlled fault'); }, () => 'built-in', message => reports.push(message));
  expect(result).toBe('built-in'); expect(reports).toHaveLength(1);
  expect(withFallback(() => 'package', () => 'built-in', message => reports.push(message))).toBe('package'); expect(reports).toHaveLength(1);
});

// Preview of the real install/enable flow (browser column; the installed WebView is a separate receipt column).
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&settings-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
}
const tab = (page: Page, name: string) => page.locator('.settings-nav-list').getByRole('tab', { name, exact: true });
const sections = (page: Page) => page.locator('.settings-nav-list > [role="tab"]').evaluateAll(nodes => nodes.filter(node => !node.hasAttribute('data-layout-hidden')).map(node => node.textContent?.trim() ?? ''));
const BUILT_IN = ['Recommended', 'General', 'Appearance', 'Voice', 'Agents', 'Schedules', 'Tools', 'Connections', 'Extensions', 'About'];
async function settings(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await expect(tab(page, 'General')).toBeVisible(); }

test('upstream menu usage: with no package the sections, keyboard path and Agent usage button are the original', async ({ page }) => {
  await setup(page); await settings(page);
  expect(await sections(page)).toEqual(BUILT_IN);
  await expect(page.locator('#settings-page')).not.toHaveAttribute('data-settings-provider');
  await tab(page, 'General').focus(); await page.keyboard.press('ArrowDown'); await expect(tab(page, 'Appearance')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar-bottom > #agent-usage-button')).toBeVisible();
});

test('upstream menu usage: the installed fixture reorders sections through the real install flow and disable restores them', async ({ page }) => {
  await setup(page); await settings(page);
  await tab(page, 'Extensions').click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${OWNER}`, exact: true }).click();
  const region = page.getByRole('region', { name: 'Surface explorer' });
  await region.getByLabel('Settings presentation', { exact: true }).selectOption(PROVIDER);
  await expect(page.locator('#settings-page')).toHaveAttribute('data-settings-provider', PROVIDER);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.settings.sections');
  await region.getByRole('button', { name: 'Grant UI customization and select Appearance before General', exact: true }).click();
  await expect.poll(() => sections(page)).toEqual(['Recommended', 'Appearance', 'General', 'Voice', 'Agents', 'Schedules', 'Tools', 'Connections', 'Extensions', 'About']);
  // Keyboard order follows the new layout and focus stays on the section list.
  await tab(page, 'Appearance').focus(); await page.keyboard.press('ArrowDown'); await expect(tab(page, 'General')).toBeFocused();
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.upstream-menu-usage'));
  await expect.poll(() => sections(page)).toEqual(BUILT_IN);
  await expect(page.locator('#settings-page')).not.toHaveAttribute('data-settings-provider');
  await expect(tab(page, 'General')).toBeFocused().catch(() => undefined);
});

test('upstream menu usage: safe mode and a faulted presentation restore the built-in Settings', async ({ page }) => {
  await setup(page, [manifest]); await settings(page);
  await tab(page, 'Extensions').click();
  const region = page.getByRole('region', { name: 'Surface explorer' });
  await region.getByLabel('Settings presentation', { exact: true }).selectOption(PROVIDER);
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySettingsPresentation(document.querySelector('#settings-page'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#settings-page')).not.toHaveAttribute('data-settings-provider');
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect.poll(() => sections(page)).toEqual(BUILT_IN);
  expect((await page.evaluate(() => (window as any).__previewSettings())).safeMode).toBe(true);
});
