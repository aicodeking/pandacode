import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
test('extensions skills: registered discovery roots appear in both matrices, disable recovers, installs refuse', async ({ page }) => {
  await page.addInitScript(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }])), manifest);
  await page.goto('/?extension-harness');
  await expect(page.locator('#prompt')).toBeEnabled();
  const result = await page.evaluate(async () => {
    const api = (window as any).__extensionHarness;
    const skills = await api.call('skill_manager_list', {});
    const capabilities = await api.call('capabilities_inventory', {});
    let error = ''; try { await api.call('skill_manager_add', { source: 'owner/repo', skills: ['example'], harnesses: ['sample.fake-harness/recorded'] }); } catch (reason) { error = String(reason); }
    return { skills, capabilities, error };
  });
  const row = result.skills.harnesses.find((row: { id: string }) => row.id === 'sample.fake-harness/recorded');
  expect(row).toMatchObject({ name: 'Recorded harness', installed: true, installable: false, syncable: false, enforcement: 'asked', consoleEnforcement: 'none' });
  expect(row.discovery).toHaveLength(4);
  expect(row.installReason).toContain('UnsupportedCapability'); expect(row.syncReason).toContain('never writes');
  expect(result.error).toContain('UnsupportedCapability');
  expect(result.capabilities.harnesses).toContainEqual({ id: row.id, name: row.name });
  expect(result.capabilities.matrix.filter((row: { kind: string }) => row.kind.endsWith('discovery'))).toHaveLength(4);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await page.getByRole('tab', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skill', exact: true });
  await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
  await dialog.getByRole('button', { name: 'Find skills', exact: true }).click();
  await expect(dialog).toContainText('Recorded harness: UnsupportedCapability');
  await expect(dialog).toContainText('configuration sync is not supported');
  await expect(dialog.getByRole('checkbox', { name: 'Recorded harness', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  const after = await page.evaluate(async () => {
    const packages = JSON.parse(localStorage.getItem('pandacode.preview.extensions.v1')!); packages[0].enabled = false;
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    const api = (window as any).__extensionHarness;
    return { skills: await api.call('skill_manager_list', {}), capabilities: await api.call('capabilities_inventory', {}) };
  });
  expect(after.skills.harnesses.some((row: { id: string }) => row.id.includes('/'))).toBe(false);
  expect(after.capabilities.harnesses.some((row: { id: string }) => row.id.includes('/'))).toBe(false);
});
