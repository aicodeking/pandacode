import { expect, test, type Page } from '@playwright/test';

/* Settings → Agents → Cloud sandboxes on the preview's mock providers: connected cards lead
 * alphabetically, and the environment checkbox keeps its label beside it (it once stretched
 * full-width under the global input rule). Titles start with "cloud sandboxes" for the WebKit grep. */
async function openCloud(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections' }).click();
  await page.locator('.cloud-more > summary').click();
  return page.getByRole('tabpanel', { name: 'Cloud sandboxes' });
}

async function connect(page: Page, provider: string) {
  const card = page.locator(`.cloud-provider[data-provider="${provider}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: `Connect ${provider}` }).click();
  await card.locator('input[name="key"]').fill('k');
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByRole('button', { name: `Disconnect ${provider}` })).toBeVisible();
  return card;
}

const cardOrder = (page: Page) =>
  page.locator('.cloud-settings > .cloud-provider[data-provider]').evaluateAll(els => els.map(e => e.getAttribute('data-provider')));

test('cloud sandboxes: connected providers lead, the rest alphabetical, and only unconnected one-key ones stay in the fold', async ({ page }) => {
  await openCloud(page);
  expect(await cardOrder(page).then(order => order.slice(0, 3))).toEqual(['aws', 'cloudflare', 'daytona']);
  await connect(page, 'instabox');
  await connect(page, 'boat');
  expect(await cardOrder(page)).toEqual([
    'boat', 'instabox',
    'aws', 'cloudflare', 'daytona', 'docker', 'gcloud', 'netlify', 'railway', 'vercel',
    'blaxel', 'codesandbox', 'digitalocean', 'e2b', 'freestyle', 'hetzner', 'modal', 'runloop', 'runpod', 'tensorlake', 'vultr',
  ]);
  await expect(page.locator('.cloud-more .cloud-provider[data-provider="boat"]')).toHaveCount(0);
  await connect(page, 'daytona');
  expect((await cardOrder(page)).slice(0, 3)).toEqual(['boat', 'daytona', 'instabox']);
});

test('cloud sandboxes: the environment checkbox keeps its label beside it', async ({ page }) => {
  await openCloud(page);
  const card = await connect(page, 'boat');
  const row = card.locator('.cloud-inherit');
  await row.scrollIntoViewIfNeeded();
  const box = card.locator('[data-cloud-inherit]');
  await expect(box).toBeVisible();
  const size = await box.boundingBox();
  expect(size!.width).toBeLessThanOrEqual(24);
  expect(size!.height).toBeLessThanOrEqual(24);
  // The info mark sits just past its label, never inside it (it would join the checkbox's name).
  await expect(box).toHaveAccessibleName('Include provider environment variables');
  await expect(row.locator('label .info-mark')).toHaveCount(0);
  const label = await row.locator('label').boundingBox();
  const mark = await row.locator('.info-mark').boundingBox();
  expect(mark!.x - (label!.x + label!.width)).toBeGreaterThanOrEqual(0);
  expect(mark!.x - (label!.x + label!.width)).toBeLessThanOrEqual(12);
  await box.check();
  await expect(card.locator('.cloud-row-status')).toContainText('Saved.');
  await box.uncheck();
  await expect(card.locator('.cloud-row-status')).toContainText('Saved. Nothing from the provider environment is sent to this cloud.');
});
