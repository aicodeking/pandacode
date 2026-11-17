import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { speedItemId } from '../src/extensions/upstream-speed-core';
// Browser preview only: a seeded, trusted package declares speed tiers through the harness contract and the model
// picker draws them. Native authority and the installed WebView are separate evidence (see docs/extensions/upstream-speed.md).
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-speed/manifest.json', import.meta.url), 'utf8'));
const LAYOUT = 'pandacode.extensions.layout.v1';
const picker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
async function open(page: Page, packages: unknown[]) {
  await page.addInitScript(packages => { if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic-recording', trusted: true } })))); }, packages);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function chooseTiered(page: Page) {
  await page.locator('#model-picker-trigger').click();
  await picker(page).getByRole('tab', { name: 'Speed tiers harness', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Speed tiers harness · Tiered model', exact: true }).click();
  await expect(picker(page)).toBeHidden();
  await page.locator('#model-picker-trigger').click();
}
const speeds = (page: Page) => picker(page).locator('[data-kind="speed"] [role="radio"]').evaluateAll(nodes => nodes.map(node => node.textContent));
const hideTier = (page: Page, id: string) => page.evaluate(([key, id]) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { [id]: false }, extensionLayoutsEnabled: true, orders: {}, selected: {} })), [LAYOUT, id]);

test('upstream speed: without a package the picker offers no extension harness', async ({ page }) => {
  await open(page, []);
  await page.locator('#model-picker-trigger').click();
  await expect(picker(page).getByRole('tab', { name: 'Speed tiers harness', exact: true })).toHaveCount(0);
});

test('upstream speed: an installed package declares tiers and the picker lists Standard first, then each tier', async ({ page }) => {
  await open(page, [manifest]); await chooseTiered(page);
  expect(await speeds(page)).toEqual(['Standard', 'Fast', 'Ultra fast', 'Batch']);
  await picker(page).getByRole('radio', { name: 'Fast', exact: true }).click();
  await expect(picker(page).getByRole('radio', { name: 'Fast', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('upstream speed: a model without declared tiers shows no Speed row', async ({ page }) => {
  await open(page, [manifest]);
  await page.locator('#model-picker-trigger').click();
  await picker(page).getByRole('tab', { name: 'Speed tiers harness', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Speed tiers harness · Plain model', exact: true }).click();
  await page.locator('#model-picker-trigger').click();
  await expect(picker(page).locator('[data-kind="speed"]')).toHaveCount(0);
});

test('upstream speed: keyboard moves through the speed radios and Escape closes the picker', async ({ page }) => {
  await open(page, [manifest]); await chooseTiered(page);
  await picker(page).getByRole('radio', { name: 'Standard', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(picker(page).getByRole('radio', { name: 'Fast', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
});

test('upstream speed: a layout change after the list was drawn refuses the stale click', async ({ page }) => {
  await open(page, [manifest]); await chooseTiered(page);
  const id = speedItemId('sample.upstream-speed/tiers', 'tiered-model', 'fast');
  await hideTier(page, id);
  await picker(page).getByRole('radio', { name: 'Fast', exact: true }).click();
  await expect(picker(page)).toContainText('The speed options changed');
});

test('upstream speed: hide leaves the tier out, restore brings it back, Standard and the saved tier never hide', async ({ page }) => {
  await open(page, [manifest]);
  const id = speedItemId('sample.upstream-speed/tiers', 'tiered-model', 'ultra');
  await hideTier(page, id);
  await chooseTiered(page);
  expect(await speeds(page)).toEqual(['Standard', 'Fast', 'Batch']);
  await page.keyboard.press('Escape');
  await page.evaluate(key => localStorage.removeItem(key), LAYOUT);
  await page.locator('#model-picker-trigger').click();
  expect(await speeds(page)).toEqual(['Standard', 'Fast', 'Ultra fast', 'Batch']);
});

test('upstream speed: disabling the package removes its harness and tiers; enabling restores them', async ({ page }) => {
  await open(page, [manifest]);
  await page.evaluate(() => (window as any).__extensionHarness.call('extensions_enable', { id: 'sample.upstream-speed', enabled: false }));
  await page.locator('#model-picker-trigger').click();
  await expect(picker(page).getByRole('tab', { name: 'Speed tiers harness', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__extensionHarness.call('extensions_enable', { id: 'sample.upstream-speed', enabled: true }));
  await page.locator('#model-picker-trigger').click();
  await expect(picker(page).getByRole('tab', { name: 'Speed tiers harness', exact: true })).toHaveCount(1);
});
