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

/* Settings → Cloud (src/cloud-settings.ts): DigitalOcean's region and machine size selects,
 * filled from the account's catalog (cloud_digitalocean_catalog) with a Custom slug escape. */
const settingsRegion = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
async function openCloudSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsRegion(page).getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  return settingsRegion(page);
}
async function newTask(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.locator('.new-task-button').click();
}
async function connectDigitalocean(page: Page) {
  const settings = await openCloudSettings(page);
  const card = settings.locator('.cloud-provider[data-provider="digitalocean"]');
  await card.getByRole('button', { name: 'Connect DigitalOcean', exact: true }).click();
  // The region field left the connect form: the token is all it asks for.
  await expect(settings.getByRole('form', { name: 'Connect DigitalOcean' }).locator('input')).toHaveCount(1);
  await settings.getByLabel('DigitalOcean API token').fill('do_token');
  await settings.getByRole('form', { name: 'Connect DigitalOcean' }).locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: 'Disconnect DigitalOcean', exact: true })).toBeVisible();
  return card;
}
const saves = (page: Page) => page.evaluate(() => (window as any).__doOptionSaves ?? []);

test('DigitalOcean provider connections list regions and sizes once connected', async ({ page }) => {
  await newTask(page);
  const card = await connectDigitalocean(page);
  const region = card.getByRole('combobox', { name: 'DigitalOcean region' });
  const size = card.getByRole('combobox', { name: 'DigitalOcean machine size' });
  await expect(region).toBeEnabled();
  await expect(size).toBeEnabled();
  await expect(region).toHaveValue('');
  await expect(size).toHaveValue('');
  await expect(region.locator('option')).toHaveText(['Default (nyc1)', 'New York 1 (nyc1)', 'Frankfurt 1 (fra1)', 'Singapore 1 (sgp1)', 'Custom…']);
  await expect(size.locator('option')).toHaveText(['Standard (s-2vcpu-4gb)', '2 vCPU · 4 GB · $24/mo (s-2vcpu-4gb)', '4 vCPU · 8 GB · $48/mo (s-4vcpu-8gb)', '2 vCPU · 4 GB · $15.75/mo (c-2)', 'Custom…']);
});

test('provider connections narrow the machine sizes by region and save the picked pair', async ({ page }) => {
  await newTask(page);
  const card = await connectDigitalocean(page);
  const region = card.getByRole('combobox', { name: 'DigitalOcean region' });
  const size = card.getByRole('combobox', { name: 'DigitalOcean machine size' });

  await region.selectOption('fra1');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · fra1');
  await expect(size.locator('option')).toHaveText(['Standard (s-2vcpu-4gb)', '2 vCPU · 4 GB · $24/mo (s-2vcpu-4gb)', '2 vCPU · 4 GB · $15.75/mo (c-2)', 'Custom…']);
  await expect.poll(() => saves(page)).toEqual([{ region: 'fra1', size: '' }]);

  // c-2 has no region list, so it works everywhere and keeps every region listed.
  await size.selectOption('c-2');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · c-2 · fra1');
  await expect(region.locator('option')).toHaveText(['Default (nyc1)', 'New York 1 (nyc1)', 'Frankfurt 1 (fra1)', 'Singapore 1 (sgp1)', 'Custom…']);

  await region.selectOption('');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · c-2');
  await expect(size.locator('option')).toHaveText(['Standard (s-2vcpu-4gb)', '2 vCPU · 4 GB · $24/mo (s-2vcpu-4gb)', '4 vCPU · 8 GB · $48/mo (s-4vcpu-8gb)', '2 vCPU · 4 GB · $15.75/mo (c-2)', 'Custom…']);

  await size.selectOption('s-4vcpu-8gb');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · s-4vcpu-8gb');
  await expect(region.locator('option')).toHaveText(['Default (nyc1)', 'New York 1 (nyc1)', 'Custom…']);
  await expect.poll(() => saves(page)).toEqual([
    { region: 'fra1', size: '' },
    { region: 'fra1', size: 'c-2' },
    { region: '', size: 'c-2' },
    { region: '', size: 's-4vcpu-8gb' },
  ]);
});

test('provider connections take a custom region or size slug and show save errors', async ({ page }) => {
  await newTask(page);
  const card = await connectDigitalocean(page);
  const size = card.getByRole('combobox', { name: 'DigitalOcean machine size' });

  await size.selectOption('custom');
  const row = card.locator('[data-do-custom]');
  await expect(row).toBeVisible();
  const input = row.getByLabel('Custom DigitalOcean machine size');
  await row.getByRole('button', { name: 'Apply' }).click();
  await expect(card.getByRole('alert')).toHaveText('Enter the machine size slug.');

  await input.fill('c-4');
  await row.getByRole('button', { name: 'Apply' }).click();
  await expect(row).toBeHidden();
  await expect(size.locator('option')).toHaveText(['Standard (s-2vcpu-4gb)', '2 vCPU · 4 GB · $24/mo (s-2vcpu-4gb)', '4 vCPU · 8 GB · $48/mo (s-4vcpu-8gb)', '2 vCPU · 4 GB · $15.75/mo (c-2)', 'c-4', 'Custom…']);
  await expect(size).toHaveValue('c-4');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · c-4');
  await expect.poll(() => saves(page)).toEqual([{ region: '', size: 'c-4' }]);

  // A slug the account API would refuse surfaces in the card and Cancel restores the select.
  await size.selectOption('custom');
  await input.fill('C4!');
  await row.getByRole('button', { name: 'Apply' }).click();
  await expect(card.getByRole('alert')).toHaveText('That does not look like a DigitalOcean machine size (for example s-2vcpu-4gb or c-2).');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toBeHidden();
  await expect(size).toHaveValue('c-4');
});

test('provider connections say why a DigitalOcean catalog failed and retry', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__digitalOceanCatalogFail = true; });
  await newTask(page);
  const card = await connectDigitalocean(page);
  const region = card.getByRole('combobox', { name: 'DigitalOcean region' });
  await expect(card.getByRole('alert')).toHaveText('Could not load regions and sizes: DigitalOcean did not answer in time.');
  await expect(region).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();

  await page.evaluate(() => { (window as any).__digitalOceanCatalogFail = false; });
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(region).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Try again' })).toBeHidden();
  await expect(region).toHaveValue('');

  await card.getByRole('button', { name: 'Disconnect DigitalOcean', exact: true }).click();
  await expect(card.getByRole('combobox', { name: 'DigitalOcean region' })).toBeHidden();
});
