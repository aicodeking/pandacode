import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('extensions trust: install, refusal, full-authority review, explicit enable and revoke preserve core draft', async ({ page }) => {
  await page.goto('/?executable-extension');
  await expect(page.locator('#prompt')).toBeEnabled(); await page.locator('#prompt').fill('Keep trusted-extension draft');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Executable project summary', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable sample.project-summary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  const review = () => page.getByRole('button', { name: 'Review executable trust sample.project-summary', exact: true });
  await review().click();
  const dialog = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  for (const term of ['normal OS account', 'credentials', 'network', 'start programs', 'not an OS sandbox', 'cannot undo prior effects', 'SHA-256']) await expect(dialog).toContainText(term);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(review()).toBeVisible();
  await review().click(); await dialog.getByRole('button', { name: 'Review full authority', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke executable trust sample.project-summary', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable sample.project-summary', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke executable trust sample.project-summary', exact: true }).click();
  await expect(review()).toBeVisible(); await expect(page.getByRole('button', { name: 'Enable sample.project-summary', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(page.locator('#prompt')).toHaveValue('Keep trusted-extension draft');
  await expect(page.getByRole('button', { name: 'Executable project summary', exact: true })).toHaveCount(0);
});

test('extensions trust: an enabled trusted command remains lazy and Escape preserves its core draft', async ({ page }) => {
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/project-summary/extension.json', 'utf8'));
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'preview-fixture', trusted: true } }])); }, manifest);
  await page.goto('/?executable-extension'); await expect(page.locator('#prompt')).toBeEnabled(); await page.locator('#prompt').fill('Keep lazy command draft');
  await page.getByRole('button', { name: 'Executable project summary', exact: true }).click();
  const command = page.getByRole('region', { name: 'Executable command', exact: true });
  await expect(command).toContainText('Ready — no package code started');
  await command.getByRole('button', { name: 'Cancel executable command', exact: true }).focus(); await page.keyboard.press('Escape');
  await expect(command).toHaveCount(0); await expect(page.locator('#prompt')).toHaveValue('Keep lazy command draft');
  await expect(page.getByRole('button', { name: 'Executable project summary', exact: true })).toBeFocused();
});
