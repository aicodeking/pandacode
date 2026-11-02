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

/* Settings → Agents → Cloud sandboxes: the Docker card's engine picker (src/cloud-settings.ts).
 * The picker is native radios under a trackSegment thumb; each engine shows only the fields it
 * takes, and Apple Containers is offered on macOS only (src/platform.ts). */
const settingsRegion = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const picker = (page: Page) => page.locator('.cloud-engine-picker');
async function openDockerForm(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = settingsRegion(page);
  await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  await settings.getByRole('button', { name: 'Connect Docker', exact: true }).click();
  return settings;
}

test('the container engine picker swaps the fields each engine needs', async ({ page }) => {
  const settings = await openDockerForm(page);
  const form = settings.getByRole('form', { name: 'Connect Docker' });
  const options = picker(page).locator('label');
  await expect(options).toHaveCount(4);
  const hint = form.locator('[data-engine-hint]');
  const endpoint = form.locator('[data-field="endpoint"]');
  const tls = form.locator('[data-field="tlsCa"]');
  await expect(endpoint).toBeVisible();
  await expect(tls).toBeVisible();
  await expect(hint).toBeVisible();
  await expect(endpoint.locator('input')).toHaveAttribute('placeholder', /tcp:\/\/host:2376/);
  await options.filter({ hasText: 'Apple' }).click();
  await expect(endpoint).toBeHidden();
  await expect(endpoint.locator('input')).toBeDisabled();
  await expect(tls).toBeHidden();
  await expect(hint).toContainText('this Mac only');
  await options.filter({ hasText: 'Podman' }).click();
  await expect(endpoint).toBeVisible();
  await expect(tls).toBeHidden();
  await expect(endpoint.locator('input')).toHaveAttribute('placeholder', /ssh:\/\/user@host/);
  await expect(hint).toContainText('ssh://');
  await options.filter({ hasText: 'LXC' }).click();
  await expect(endpoint).toBeHidden();
  await expect(hint).toContainText('lxc remote add');
  await options.filter({ hasText: 'Docker' }).click();
  await expect(endpoint).toBeVisible();
  await expect(tls).toBeVisible();
});

test('the container engine picker hides Apple off the Mac', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  const settings = await openDockerForm(page);
  const options = picker(page).locator('label');
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: 'Apple' })).toHaveCount(0);
});

test('the container engine picker sends the picked engine when connecting', async ({ page }) => {
  const settings = await openDockerForm(page);
  await picker(page).locator('label', { hasText: 'Podman' }).click();
  await settings.getByRole('form', { name: 'Connect Docker' }).locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: 'Disconnect Docker', exact: true })).toBeVisible();
  const sent = await page.evaluate(() => (window as any).__cloudConnects?.at(-1));
  expect(sent.provider).toBe('docker');
  expect(sent.options.engine).toBe('podman');
});
