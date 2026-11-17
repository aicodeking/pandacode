import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { crashed, ready, SWITCH } from './crash-recovery-helpers';

/* S0608 (upstream sync P6): crash restart and quit as an extension adapter (docs/extensions/upstream-recovery.md).
 * Preview column only: the browser preview runs no package code and stands in for the native crash guard
 * (src/preview-crash.ts) and the quit account (`extensions_service_quit_preview`). Native authority and lifecycle
 * (`runtime_service_status::tests`, `quit_guard::tests`, the crash guard) and the installed WebView are separate evidence
 * and are NOT claimed here; installed qualification is pending (docs/extensions/upstream-recovery.md, "Evidence"). */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/upstream-recovery/manifest.json'));
const second = JSON.parse(read('tests/fixtures/extensions/upstream-recovery/manifest.json').replaceAll('sample.upstream-recovery', 'sample.upstream-recovery-two'));
const ID = 'sample.upstream-recovery', TWO = 'sample.upstream-recovery-two';
const PAGE = `${ID}/crash-recovery`;
const NOTE = 'Review the recovery checklist before you resume.';
const CHECKLIST = 'Recovery checklist: review git status, then reopen the thread you were working in.';
test.setTimeout(90_000);

const record = (m: unknown, digest: string) => ({ manifest: m, enabled: true, icons: {}, executable: { digest, trusted: true } });
const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionServiceSupervision.call(command, args), [command, args] as const);
const grant = (page: Page, id: string) => ipc(page, 'extensions_runtime_grant', { request: { op: 'grant', id, permission: 'runtime.service' } });
const revoke = (page: Page, id: string) => ipc(page, 'extensions_runtime_grant', { request: { op: 'revoke', id, permission: 'runtime.service' } });
const script = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_service_status_preview', request);
const quit = async (page: Page) => (await ipc(page, 'extensions_service_quit_preview')) as { confirm: boolean; message: string; packages: { id: string; text: string | null; jobs: number }[] };
const toast = (page: Page) => page.locator('#toast');
const notice = (page: Page) => page.locator('#toast > .toast-text');
const checklist = (page: Page, name: string) => toast(page).getByRole('button', { name: `${name} checklist, from an extension`, exact: true });
const group = (page: Page) => page.locator('#crash-restart-settings');
const notes = (page: Page) => page.locator('[data-crash-extras]');

type Options = { crash?: boolean; packages?: unknown[]; stored?: Record<string, string> };
async function boot(page: Page, { crash = true, packages = [], stored = {} }: Options = {}) {
  if (crash) await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false, agentsInterrupted: false });
  await page.addInitScript(([packages, stored]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (packages.length && !localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    for (const [key, value] of Object.entries(stored)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, [packages, stored] as const);
  await page.goto('/?service-supervision&upstream-recovery'); await ready(page);
  await page.waitForFunction(() => (window as any).__extensionServiceSupervision);
}
async function openGeneral(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  const tab = page.locator('.settings-nav-list').getByRole('tab', { name: 'General', exact: true });
  await expect(async () => { await tab.click({ timeout: 2000 }); await expect(group(page)).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 15_000 });
}
async function openExtensions(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  const tab = page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true });
  await expect(async () => { await tab.click({ timeout: 2000 }); await expect(page.locator('#settings-panel-extensions')).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 15_000 });
}
const settingsKey = (id: string) => `pandacode.preview.extension-settings.v1.${id}.${id}/crash-recovery`;
const installed = (digest = 'preview-upstream-recovery-a') => record(manifest, digest);
const crashSentence = (page: Page) => notice(page).evaluate(node => node.firstChild?.nodeValue ?? '');

test('upstream recovery: the fixture is a valid package and the registry names every upstream member with a reason or a handoff', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(validateContract('packages', [manifest, second]).ok).toBe(true);
  const doc = read('docs/extensions/upstream-recovery.md');
  const source = read('src/extensions/upstream-recovery.ts');
  for (const member of ['crash-notice-text', 'crash-notice-actions', 'crash-notice-arrangement', 'quit-confirmation', 'crash-restart-decision', 'crash-report', 'unsent-drafts', 'window-reload-notice', 'safe-mode']) {
    expect(source, member).toContain(`member: '${member}'`);
    expect(doc, member).toContain(`\`${member}\``);
  }
  // A protected member says why; one that waits on a runtime ability names the owning phase.
  expect(source).toMatch(/member: 'crash-restart-decision'[^\n]*reason:[^\n]*handoff: 'R0106/);
  expect(source).toMatch(/member: 'unsent-drafts'[^\n]*reason:[^\n]*handoff: 'R0403/);
  // The ledger names the evidence; the quit guard and the crash guard are consumed, never copied.
  const ledger = JSON.parse(read('tests/fixtures/extensions/surfaces.json'));
  expect(JSON.stringify(ledger.discoveryLimits)).toContain('docs/extensions/upstream-recovery.md');
  expect(JSON.stringify(ledger.discoveryLimits)).toContain('tests/upstream-recovery-extensions.spec.ts');
  expect(source, 'no second quit dialog or counter').not.toMatch(/confirm\s*\(|ask_account|should_confirm/);
});

test('upstream recovery: with no package the crash notice, the Settings group and the quit question are upstream\'s', async ({ page }) => {
  await boot(page);
  await expect(notice(page)).toContainText('PandaCode crashed');
  expect(await crashSentence(page)).not.toContain('From ');
  await expect(toast(page).getByRole('button', { name: /checklist/ })).toHaveCount(0);
  await openGeneral(page);
  await expect(notes(page)).toHaveCount(0);
  await expect(page.locator('[data-extension-settings-group]')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: SWITCH })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([]);
  expect(await quit(page)).toMatchObject({ packages: [] });
  // Without a crash there is no notice and no hook: the adapter is silent.
  const quiet = await page.context().newPage();
  await boot(quiet, { crash: false });
  await expect(toast(quiet)).toBeHidden();
  expect(await quiet.evaluate(() => (window as any).__upstreamRecovery)).toBeUndefined();
});

test('upstream recovery: installing, trusting, enabling and granting the package adds its labelled note and checklist, and uninstalling restores upstream', async ({ page }) => {
  await boot(page);
  await openExtensions(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await expect(page.getByRole('button', { name: `Enable ${ID}`, exact: true })).toBeVisible();
  // Installed is not enabled: nothing changed yet.
  expect(await crashSentence(page)).not.toContain('From ');
  await expect(ipc(page, 'extensions_enable', { id: ID, enabled: true })).rejects.toThrow(/ExecutableTrustRequired/);
  await ipc(page, 'extensions_runtime', { request: { op: 'trust', id: ID, digest: 'preview-upstream-recovery-a', allow: true } });
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  await grant(page, ID);
  await expect(notice(page)).toContainText(`From upstream recovery: ${NOTE}`);
  await expect(checklist(page, 'upstream recovery')).toBeVisible();
  // The package's own button runs its declared command.
  await checklist(page, 'upstream recovery').click();
  await expect(toast(page)).toContainText(CHECKLIST);
  // The notice comes back after the message, as upstream's does after another toast.
  await expect(notice(page)).toContainText(`From upstream recovery: ${NOTE}`);
  // The package's page is a labelled group in General, in its own namespace.
  await openGeneral(page);
  await expect(page.locator(`[data-extension-settings-group="${PAGE}"]`)).toBeVisible();
  await expect(notes(page).locator('[data-crash-extra]')).toHaveCount(1);
  // Uninstall: the note, the button, the group and the Settings block are gone and the text is upstream's again.
  await ipc(page, 'extensions_uninstall', { id: ID });
  await expect(notice(page)).not.toContainText('From upstream recovery');
  await expect(toast(page).getByRole('button', { name: /checklist/ })).toHaveCount(0);
  await expect(notes(page)).toHaveCount(0);
  await expect(page.locator(`[data-extension-settings-group="${PAGE}"]`)).toHaveCount(0);
});

test('upstream recovery: saving the package\'s page changes the notice, and an invalid or unreadable value falls back without a note loop', async ({ page }) => {
  await boot(page, { packages: [installed()] });
  await grant(page, ID);
  await expect(notice(page)).toContainText(`From upstream recovery: ${NOTE}`);
  await openGeneral(page);
  const fields = page.locator(`[data-extension-settings-group="${PAGE}"]`);
  await fields.getByLabel('Note', { exact: true }).fill('Check the build before resuming.');
  await fields.getByRole('button', { name: 'Save extension settings', exact: true }).click();
  await expect(notice(page)).toContainText('From upstream recovery: Check the build before resuming.');
  await expect(notes(page)).toContainText('Check the build before resuming.');
  await fields.getByLabel('Show my note in the crash notice', { exact: true }).uncheck();
  await fields.getByRole('button', { name: 'Save extension settings', exact: true }).click();
  await expect(notice(page)).not.toContainText('From upstream recovery');
  await expect(notes(page)).toHaveCount(0);
  // Fault fallback: an unreadable stored value drops that package's note only; an invalid one falls back to the declared defaults.
  await page.evaluate(key => localStorage.setItem(key, '{not json'), settingsKey(ID));
  await page.evaluate(() => (window as any).__upstreamRecovery.refresh());
  expect(await page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([]);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ show: 'yes', note: 3 })), settingsKey(ID));
  await page.evaluate(() => (window as any).__upstreamRecovery.refresh());
  await expect(notice(page)).toContainText(`From upstream recovery: ${NOTE}`);
  // A long note is cut and a markup-looking one stays text.
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ show: true, note: `<img src=x onerror=alert(1)> ${'x'.repeat(400)}` })), settingsKey(ID));
  await page.evaluate(() => (window as any).__upstreamRecovery.refresh());
  const text = await crashSentence(page);
  expect(text).toContain('From upstream recovery: <img src=x onerror=alert(1)>');
  expect(text.length).toBeLessThan(900);
  await expect(toast(page).locator('img')).toHaveCount(0);
});

test('upstream recovery: hide, show again, reorder and restore follow the keyboard and keep focus', async ({ page }) => {
  await boot(page, { packages: [installed(), record(second, 'preview-upstream-recovery-b')] });
  await grant(page, ID); await grant(page, TWO);
  await expect(notice(page)).toContainText('From upstream recovery: ' + NOTE);
  expect(await page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([ID, TWO]);
  await openGeneral(page);
  const row = (id: string) => notes(page).locator(`[data-crash-extra="${id}"]`);
  await expect(row(ID)).toBeVisible(); await expect(row(TWO)).toBeVisible();
  // The first cannot move up and the last cannot move down.
  await expect(row(ID).getByRole('button', { name: 'Move upstream recovery note up' })).toHaveAttribute('aria-disabled', 'true');
  await expect(row(TWO).getByRole('button', { name: 'Move upstream recovery two note down' })).toHaveAttribute('aria-disabled', 'true');
  // Reorder by keyboard: focus stays on the same control after the list is redrawn.
  const down = row(ID).getByRole('button', { name: 'Move upstream recovery note down' });
  await down.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([TWO, ID]);
  await expect(notes(page).locator('[data-crash-extra]').first()).toHaveAttribute('data-crash-extra', TWO);
  await expect(page.locator('[data-crash-extras] [data-crash-act="down"][data-owner="' + ID + '"]')).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.crashAct)).toBeTruthy();
  // The notice follows the order: the second package's sentence first.
  const ordered = await crashSentence(page);
  expect(ordered.indexOf('From upstream recovery two:')).toBeGreaterThan(-1);
  expect(ordered.indexOf('From upstream recovery two:')).toBeLessThan(ordered.indexOf('From upstream recovery:'));
  // Hide one: its sentence and button go, Show again brings it back, the other is untouched.
  await row(TWO).getByRole('button', { name: 'Hide upstream recovery two note in the crash notice' }).press('Space');
  await expect(notice(page)).not.toContainText('From upstream recovery two');
  await expect(notice(page)).toContainText('From upstream recovery:');
  await expect(row(TWO)).toHaveAttribute('data-hidden', 'true');
  await expect(row(TWO).getByRole('button', { name: 'Show upstream recovery two note in the crash notice' })).toBeFocused();
  await row(TWO).getByRole('button', { name: 'Show upstream recovery two note in the crash notice' }).press('Enter');
  await expect(notice(page)).toContainText('From upstream recovery two');
  // Restore all: the discovery order and nothing hidden; the arrangement is a local preference only.
  await page.getByRole('button', { name: 'Restore all notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([ID, TWO]);
  await expect(page.getByRole('button', { name: 'Restore all notes', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.crashRecovery.extras.v1') ?? '{}'))).toEqual({ hidden: [], order: [] });
  // Safe mode and the zero state: Esc closes Settings and the notice is where it was.
  await page.keyboard.press('Escape');
  await expect(notice(page)).toContainText('From upstream recovery:');
});

test('upstream recovery: an action captured before a change is refused instead of retargeted', async ({ page }) => {
  await boot(page, { packages: [installed()] });
  await grant(page, ID);
  await expect(checklist(page, 'upstream recovery')).toBeVisible();
  const handle = await page.evaluateHandle(() => (window as any).__upstreamRecovery.capture());
  // A request id runs once.
  expect(await handle.evaluate(capture => capture.run('sample.upstream-recovery', 'one'))).toEqual({ ok: true });
  expect(await handle.evaluate(capture => capture.run('sample.upstream-recovery', 'one'))).toEqual({ ok: false, reason: 'AlreadyApplied' });
  // Another owner is not this capture's.
  expect(await handle.evaluate(capture => capture.run('sample.other', 'two'))).toEqual({ ok: false, reason: 'WrongOwner' });
  // Disabling the package changes its identity: the older capture refuses, the checklist message never appears again.
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  const stale = await handle.evaluate(capture => capture.run('sample.upstream-recovery', 'three'));
  expect(stale.ok).toBe(false);
  expect(['StaleContext', 'Revoked']).toContain(stale.reason);
  await expect(toast(page)).not.toContainText(CHECKLIST);
  // Enabled again, a fresh capture works while the old one stays refused (a new generation).
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  await grant(page, ID);
  await expect(checklist(page, 'upstream recovery')).toBeVisible();
  const again = await handle.evaluate(capture => capture.run('sample.upstream-recovery', 'four'));
  expect(again.ok).toBe(false);
  const fresh = await page.evaluate(() => (window as any).__upstreamRecovery.run('sample.upstream-recovery', 'five'));
  expect(fresh).toEqual({ ok: true });
  // Hiding after capture also refuses the captured action (the arrangement is part of the context).
  const before = await page.evaluateHandle(() => (window as any).__upstreamRecovery.capture());
  await openGeneral(page);
  await notes(page).getByRole('button', { name: 'Hide upstream recovery note in the crash notice' }).click();
  const hidden = await before.evaluate(capture => capture.run('sample.upstream-recovery', 'six'));
  expect(hidden.ok).toBe(false);
});

test('upstream recovery: disable, safe mode and revoke leave upstream exactly, and the quit question stays the one native account', async ({ page }) => {
  await boot(page, { packages: [installed()] });
  await grant(page, ID);
  await expect(notice(page)).toContainText('From upstream recovery');
  // Quit: the package's working service is named by the one account; Settings only reads the same list.
  await script(page, { op: 'status', id: ID, text: 'Syncing 2 repositories', working: true });
  const expected = 'Extension still working: sample.upstream-recovery (Syncing 2 repositories). Quitting stops it.';
  expect(await quit(page)).toEqual({ confirm: true, packages: [{ id: ID, text: 'Syncing 2 repositories', jobs: 0 }], message: expected });
  await openGeneral(page);
  await expect(page.locator('[data-recovery-quit]')).toHaveText(`Quitting now asks first. ${expected}`);
  // Clearing the work clears the sentence and the question.
  await script(page, { op: 'status', id: ID, text: 'Idle', working: false });
  await expect(page.locator('[data-recovery-quit]')).toHaveCount(0, { timeout: 10_000 });
  expect((await quit(page)).confirm).toBe(false);
  // Revoking the service grant stops the service: nothing to name even if it said working.
  await script(page, { op: 'status', id: ID, text: 'Syncing', working: true });
  await expect(page.locator('[data-recovery-quit]')).toHaveCount(1, { timeout: 10_000 });
  await revoke(page, ID);
  await expect(page.locator('[data-recovery-quit]')).toHaveCount(0, { timeout: 10_000 });
  expect((await quit(page)).packages).toEqual([]);
  await expect(notice(page)).toContainText('From upstream recovery');
  await grant(page, ID);
  // Disable: note, button, settings group and block go; the restart switch and drafts controls stay.
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  await expect(notice(page)).not.toContainText('From upstream recovery');
  await expect(notes(page)).toHaveCount(0);
  await expect(page.getByRole('switch', { name: SWITCH })).toBeVisible();
  await expect(page.locator('#crash-drafts-clear')).toBeVisible();
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  await expect(notice(page)).toContainText('From upstream recovery');
  // Safe mode removes every note exactly like uninstall, without touching the package or the arrangement.
  await page.keyboard.press('Escape');
  await openExtensions(page);
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(notice(page)).not.toContainText('From upstream recovery');
  await expect(toast(page).getByRole('button', { name: /checklist/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__upstreamRecovery.owners())).toEqual([]);
});

test('upstream recovery: the restart switch, reports and drafts keep working with notes present, and the notice survives other toasts', async ({ page }) => {
  await boot(page, { packages: [installed()] });
  await grant(page, ID);
  await expect(notice(page)).toContainText('From upstream recovery');
  await openGeneral(page);
  const restart = page.getByRole('switch', { name: SWITCH });
  await expect(restart).toBeChecked();
  await restart.uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).__crashRestartEnabled)).toBe(false);
  await restart.check();
  await expect.poll(() => page.evaluate(() => (window as any).__crashRestartEnabled)).toBe(true);
  // Drafts: the controls are the upstream ones and untouched by the block.
  await expect(page.getByRole('switch', { name: 'Keep unsent drafts' })).toBeVisible();
  await page.locator('#crash-drafts-clear').click();
  await expect(notice(page)).toContainText('From upstream recovery');
  // The guard is told once, and closing Settings leaves the notice with its note and button.
  const shown = await page.evaluate(() => ((window as any).__crashCalls ?? []).filter((call: any) => call.command === 'crash_recovery_shown').length);
  expect(shown).toBe(1);
  await page.keyboard.press('Escape');
  await expect(toast(page).getByRole('button', { name: 'upstream recovery checklist, from an extension' })).toBeVisible();
});
