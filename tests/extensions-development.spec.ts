import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('extensions development: explicit selection and full-authority trust review precede lazy enable', async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/sample-project-helper/extension.json', 'utf8'));
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
    localStorage.setItem('pandacode.wallpapers', 'false');
  }, manifest);
  await page.goto('/?extension-development');
  const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload sample.sdk-summary', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select development folder', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Development logs sample.sdk-summary', exact: true })).toContainText('No code executed');
  await page.getByRole('button', { name: 'Enable sample.sdk-summary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  const review = () => page.getByRole('button', { name: 'Review executable trust sample.sdk-summary', exact: true });
  await review().click();
  const dialog = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  await expect(dialog).toContainText('not an OS sandbox');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await review().click(); await dialog.getByRole('button', { name: 'Review full authority', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.sdk-summary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable sample.sdk-summary', exact: true })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Development logs sample.sdk-summary', exact: true })).toContainText('Package output redacted');
});

test('extensions development: owner-only reload preserves a running harness, another package and the exact draft node', async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/sample-project-helper/extension.json', 'utf8'));
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, manifest);
  await page.goto('/?extensions-baseline');
  const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled();
  await prompt.fill('Keep active harness'); await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await prompt.fill('Keep development draft'); const element = await prompt.elementHandle();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Select development folder', exact: true }).click();
  await page.getByRole('button', { name: 'Reload sample.sdk-summary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review executable trust sample.sdk-summary', exact: true })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Development logs sample.sdk-summary', exact: true })).toContainText('changed content disabled');
  await expect(page.getByRole('button', { name: 'Disable sample.project-helper', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(prompt).toHaveValue('Keep development draft');
  expect(await element!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'Still streaming after reload' }));
  await expect(page.locator('#stream-region .live-text')).toHaveText('Still streaming after reload');
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['send_message', 'stop_session'].includes(call.command)).map((call: any) => call.command))).toEqual(['send_message']);
});

test('extensions development: zero selection safe recovery keeps developer loading unavailable', async ({ page }) => {
  await page.goto('/?safe-mode'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select development folder', exact: true })).toBeDisabled();
  await expect(page.getByRole('log')).toHaveCount(0);
});

test('extensions development: reloading a selected owner does not close or clear another package dialog', async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/menu-laboratory/extension.json', 'utf8'));
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); }, manifest);
  await page.goto('/?extension-development'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Select development folder', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Menu laboratory', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reports', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Configure report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report options — sample.menu-laboratory', exact: true });
  await dialog.getByRole('textbox', { name: 'Report name', exact: true }).fill('Keep other package state');
  const field = await dialog.getByRole('textbox', { name: 'Report name', exact: true }).elementHandle();
  await page.evaluate(() => (window as any).__previewDevelopmentReload('sample.sdk-summary'));
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue('Keep other package state');
  expect(await field!.evaluate(node => node === document.querySelector('#dialog input[type="text"]'))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
});
