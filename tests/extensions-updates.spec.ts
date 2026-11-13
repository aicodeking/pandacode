import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const operation of ['update', 'uninstall', 'disable']) test(`extensions updates: active provider stays pinned through ${operation} until explicit cancellation`, async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic-recording', trusted: true } }])); }, manifest);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Recorded harness', exact: true }).click();
  await picker.getByRole('option', { name: 'Recorded harness · Recorded model', exact: true }).click();
  await page.locator('#prompt').fill('Keep provider admission'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  if (operation === 'uninstall') await page.getByRole('button', { name: `Uninstall ${manifest.id}`, exact: true }).click();
  else {
    await page.getByRole('button', { name: `Stage update ${manifest.id}`, exact: true }).click();
    await page.getByRole('button', { name: `Review staged update ${manifest.id}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review extension update — panda.core', exact: true });
    await dialog.getByRole('button', { name: 'Approve reviewed update', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Pinned provider runs: 1' })).toBeVisible();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.preview.extensions.v1')!)); expect(before[0].manifest.version).toBe('1.0.0');
  if (operation === 'disable') await page.getByRole('button', { name: `Disable ${manifest.id}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  if (operation !== 'disable') {
    await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => (window as any).__extensionHarness.task().status)).toBe('idle');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.preview.extensions.v1')!));
  if (operation === 'uninstall') expect(after).toEqual([]); else expect(after[0].manifest.version).toBe('1.1.0');
  if (operation === 'disable') expect(after[0].enabled).toBe(false);
  await expect(page.locator('#transcript')).toContainText('Keep provider admission');
});

test('extensions updates: explicit review, Escape refusal, permission diff and manual rollback preserve draft and core run', async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/project-summary/extension.json', 'utf8'));
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'reviewed-old', trusted: true } }]));
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, manifest);
  await page.goto('/?extensions-baseline');
  const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled();
  await prompt.fill('Keep core run'); await prompt.press('Enter'); await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await prompt.fill('Keep exact draft'); const field = await prompt.elementHandle();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: `Stage update ${manifest.id}`, exact: true }).click();
  const review = page.getByRole('button', { name: `Review staged update ${manifest.id}`, exact: true });
  await expect(page.getByRole('status').filter({ hasText: 'Staged: explicit' })).toBeVisible();
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Review extension update — panda.core', exact: true });
  await expect(dialog).toContainText('tasks.summary'); await expect(dialog).toContainText('not an OS sandbox');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(review).toBeFocused();
  await review.click(); await dialog.getByRole('button', { name: 'Approve reviewed update', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: `Roll back ${manifest.id}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Roll back ${manifest.id}`, exact: true }).click();
  await expect(page.locator('.setting-row').filter({ has: page.getByRole('button', { name: `Stage update ${manifest.id}`, exact: true }) })).toContainText('1.0.0');
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(prompt).toHaveValue('Keep exact draft'); expect(await field!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['send_message', 'stop_session'].includes(call.command)).map((call: any) => call.command))).toEqual(['send_message']);
});

test('extensions updates: safe recovery hides broken extension UI without clearing draft or installed data', async ({ page }) => {
  await page.goto('/'); const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled(); await prompt.fill('Recovery keeps work');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  const before = await page.evaluate(() => localStorage.getItem('pandacode.preview.extensions.v1'));
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Safe mode:' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pandacode.preview.extensions.v1'))).toBe(before);
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt).toHaveValue('Recovery keeps work');
});
