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
    'aws', 'cloudflare', 'daytona', 'docker', 'gcloud', 'colab', 'netlify', 'railway', 'vercel',
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
async function openCloudSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections' }).click();
  // An unconnected DigitalOcean sits in the keyed providers' fold.
  await page.locator('.cloud-more > summary').click();
  return page.getByRole('tabpanel', { name: 'Cloud sandboxes' });
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

/* The preview's Colab sign-in waits for `__colabSignInComplete()` under `__colabSignInHold`, so no test races a timer. */
const holdColabSignIn = (page: Page) => page.evaluate(() => { (window as any).__colabSignInHold = true; });
const completeColabSignIn = (page: Page) => page.evaluate(() => (window as any).__colabSignInComplete());
const SIGN_IN = 'Sign in with Google for Google Colab';

async function openColab(page: Page) {
  await openCloud(page);
  await holdColabSignIn(page);
  const card = page.locator('.cloud-provider[data-provider="colab"]');
  await card.scrollIntoViewIfNeeded();
  return card;
}

async function reopenSettings(page: Page) {
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections' }).click();
}

async function signInColab(page: Page, card: ReturnType<Page['locator']>) {
  await card.getByRole('button', { name: SIGN_IN, exact: true }).click();
  await expect(card.locator('.cloud-row-status')).toHaveText('Finish signing in with Google in your browser…');
  await completeColabSignIn(page);
  await expect(card.getByRole('button', { name: 'Disconnect Google Colab', exact: true })).toBeVisible();
}

test('cloud sandboxes: Google Colab signs in with one click and saves its defaults', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const card = await openColab(page);
  // The accessible name contains the visible text (WCAG 2.5.3).
  const signIn = card.getByRole('button', { name: SIGN_IN, exact: true });
  await expect(signIn).toHaveText('Sign in with Google');
  await expect(card.locator('.cloud-colab-config')).toBeHidden();
  await expect(card.locator('[data-inherit-row]')).toBeHidden();

  // One click starts the browser sign-in: progress, a fallback link and Cancel, no form.
  await signIn.click();
  await expect(card.locator('.cloud-row-status')).toHaveText('Finish signing in with Google in your browser…');
  await expect(card.getByRole('link', { name: 'Open sign-in link' })).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/v2/auth?mock=1');
  await expect(card.getByRole('button', { name: 'Cancel Google Colab sign-in' })).toBeVisible();
  await expect(signIn).toBeDisabled();
  await expect(card.locator('form')).toBeHidden();
  await completeColabSignIn(page);

  const disconnect = card.getByRole('button', { name: 'Disconnect Google Colab', exact: true });
  await expect(disconnect).toBeVisible();
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · alex@example.com');
  await expect(card.locator('.cloud-colab-signin')).toBeHidden();
  // Connected providers lead the list.
  expect((await cardOrder(page))[0]).toBe('colab');
  await expect(card.getByRole('checkbox', { name: 'Include provider environment variables' })).toBeVisible();

  const hardware = card.getByRole('combobox', { name: 'Google Colab default hardware' });
  await expect(hardware).toHaveValue('NONE');
  await expect(hardware.locator('option')).toHaveText(['CPU (Standard)', 'T4 GPU', 'L4 GPU', 'G4 GPU', 'A100 GPU', 'H100 GPU', 'v5e-1 TPU', 'v6e-1 TPU']);
  const highMem = card.getByRole('checkbox', { name: 'High-RAM' });
  const native = card.getByRole('checkbox', { name: 'Let models run code on Colab natively' });
  const mcp = card.getByRole('checkbox', { name: 'Colab browser notebook MCP (colab-mcp)' });
  await expect(native).toBeChecked();
  await expect(mcp).not.toBeChecked();
  await expect(card.locator('.info-mark[aria-label="About native Colab tools"]')).toHaveAttribute('data-tip', /pandacode_colab_\*/);
  // Compute units arrive from their own call, after the settings are already shown.
  const ccu = card.locator('[data-colab-ccu]');
  await expect(ccu).toHaveText('Compute units: 94.2 · 0.07 per hour at this setting');

  await hardware.selectOption('T4');
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. New Colab runtimes use T4 GPU.');
  // The Connected line names the new hardware without reopening Settings.
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · alex@example.com · T4 GPU');
  // Google's unrounded rate (1.7600000000000002) is shown to two places at most.
  await expect(ccu).toHaveText('Compute units: 94.2 · 1.76 per hour at this setting');
  await highMem.check();
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. High-RAM on.');
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · alex@example.com · T4 GPU · High-RAM');
  await native.uncheck();
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. native Colab tools off.');
  await mcp.check();
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. colab-mcp on.');

  // L4 comes in one shape, so High-RAM is off the table: shown off, and not named on the Connected line.
  await hardware.selectOption('L4');
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. New Colab runtimes use L4 GPU.');
  await expect(highMem).toBeDisabled();
  await expect(highMem).not.toBeChecked();
  await expect(card.getByText('This hardware comes in one memory shape')).toBeVisible();
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · alex@example.com · L4 GPU');

  const install = card.getByRole('button', { name: 'Install Colab CLI' });
  await install.click();
  await expect(card.getByText('Colab CLI ready', { exact: true })).toBeVisible();
  await expect(install).toBeHidden();

  // Saved natively, so a reopened Settings shows the same choices.
  await reopenSettings(page);
  await expect(hardware).toHaveValue('L4');
  await expect(highMem).not.toBeChecked();
  await expect(highMem).toBeDisabled();
  await expect(native).not.toBeChecked();
  await expect(mcp).toBeChecked();
  // Back on hardware with two shapes, the saved High-RAM choice returns.
  await hardware.selectOption('A100');
  await expect(highMem).toBeEnabled();
  await expect(highMem).toBeChecked();
  await expect(card.locator('.cloud-detail')).toHaveText('Connected · alex@example.com · A100 GPU · High-RAM');

  await disconnect.click();
  await expect(signIn).toBeVisible();
  await expect(card.locator('.cloud-detail')).toHaveText('');
  await expect(card.locator('.cloud-colab-config')).toBeHidden();
  expect(errors).toEqual([]);
});

test('cloud sandboxes: a failed Google Colab save shows in the danger colour and Disconnect waits for saves', async ({ page }) => {
  const card = await openColab(page);
  await signInColab(page, card);
  const status = card.locator('[data-colab-status]');
  await card.getByRole('checkbox', { name: 'Colab browser notebook MCP (colab-mcp)' }).check();
  await expect(status).toHaveText('Saved. colab-mcp on.');
  const muted = await status.evaluate(el => getComputedStyle(el).color);

  await page.evaluate(() => { (window as any).__colabSetConfigFail = true; });
  const native = card.getByRole('checkbox', { name: 'Let models run code on Colab natively' });
  // click(), not uncheck(): the failed save puts the box back, which uncheck() would report as a failure.
  await native.click();
  await expect(status).toHaveText('Could not save the Colab settings: the disk is full.');
  await expect(status).toHaveClass(/cloud-error/);
  // Back to the saved value, and drawn in --ds-danger, not the muted grey of a success.
  await expect(native).toBeChecked();
  const danger = await status.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ds-danger)'; el.parentElement!.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  expect(await status.evaluate(el => getComputedStyle(el).color)).toBe(danger);
  expect(danger).not.toBe(muted);
  await page.evaluate(() => { (window as any).__colabSetConfigFail = false; });

  // While a save runs, Disconnect waits; it comes back once the save lands.
  const disconnect = card.getByRole('button', { name: 'Disconnect Google Colab', exact: true });
  await expect(disconnect).toBeEnabled();
  await page.evaluate(() => { const preview = window as any; preview.__colabSaveGate = new Promise(resolve => { preview.__colabSaveRelease = resolve; }); });
  await native.uncheck();
  await expect(disconnect).toBeDisabled();
  await page.evaluate(() => { const preview = window as any; preview.__colabSaveGate = null; preview.__colabSaveRelease(); });
  await expect(card.locator('[data-colab-status]')).toHaveText('Saved. native Colab tools off.');
  await expect(disconnect).toBeEnabled();
});

test('cloud sandboxes: a Google Colab sign-in can be cancelled, fail, or use gcloud ADC', async ({ page }) => {
  const card = await openColab(page);
  const signIn = card.getByRole('button', { name: SIGN_IN, exact: true });
  const disconnect = card.getByRole('button', { name: 'Disconnect Google Colab' });

  await signIn.click();
  await card.getByRole('button', { name: 'Cancel Google Colab sign-in' }).click();
  await expect(card.locator('.cloud-row-status')).toHaveText('Sign-in cancelled.');
  await expect(signIn).toBeEnabled();
  // The cancelled attempt can no longer finish.
  await completeColabSignIn(page);
  await expect(card.locator('.cloud-row-status')).toHaveText('Sign-in cancelled.');
  await expect(disconnect).toHaveCount(0);

  await page.evaluate(() => { (window as any).__colabSignInFail = true; });
  await signIn.click();
  await expect(card.locator('.cloud-colab-signin')).toBeVisible();
  await completeColabSignIn(page);
  await expect(card.locator('.cloud-row-status.cloud-error')).toHaveText('Google sign-in was denied (access_denied).');
  await expect(signIn).toBeEnabled();
  await page.evaluate(() => { (window as any).__colabSignInFail = false; });

  // A sign-in the backend ends as cancelled clears the progress without an error.
  await page.evaluate(() => { (window as any).__colabSignInCancelled = true; });
  await signIn.click();
  await expect(card.locator('.cloud-colab-signin')).toBeVisible();
  await completeColabSignIn(page);
  await expect(card.locator('.cloud-row-status')).toHaveText('Sign-in cancelled.');
  await expect(card.locator('.cloud-row-status')).not.toHaveClass(/cloud-error/);
  await expect(card.locator('.cloud-colab-signin')).toBeHidden();
  await expect(signIn).toBeEnabled();
  await page.evaluate(() => { (window as any).__colabSignInCancelled = false; });

  // More options holds the power-user ways in, out of the one-click path; its note says what each one touches.
  const more = card.getByRole('button', { name: 'More options' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.cloud-note')).toContainText('names the Colab CLI');
  await expect(card.locator('.cloud-note')).toContainText('~/.config/gcloud');
  const file = card.getByLabel('Google Colab OAuth client file');
  await expect(file).toBeVisible();

  // Escape closes the form and puts focus back on More options.
  await file.focus();
  await page.keyboard.press('Escape');
  await expect(card.locator('form')).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Connections' })).toBeVisible();

  // A client file that is not there fails before any browser opens.
  await more.click();
  await file.fill('/Users/you/missing.json');
  await card.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(card.locator('.cloud-row-status.cloud-error')).toContainText('No OAuth client file at /Users/you/missing.json');
  await expect(card.locator('.cloud-colab-signin')).toBeHidden();
  await expect(signIn).toBeEnabled();

  await card.getByRole('button', { name: 'Use gcloud ADC' }).click();
  await expect(card.locator('.cloud-row-status')).toHaveText('Reading gcloud application-default credentials…');
  await completeColabSignIn(page);
  await expect(card.getByRole('button', { name: 'Disconnect Google Colab', exact: true })).toBeVisible();
  await expect(card.locator('form')).toBeHidden();
  await expect(card.getByRole('button', { name: 'More options' })).toBeHidden();
});

test('cloud sandboxes: reopened Settings picks up a running Google Colab sign-in and ignores older attempts', async ({ page }) => {
  const card = await openColab(page);
  const signIn = card.getByRole('button', { name: SIGN_IN, exact: true });
  await signIn.click();
  await expect(card.locator('.cloud-row-status')).toHaveText('Finish signing in with Google in your browser…');

  // Closing Settings leaves the sign-in running; reopening shows its progress, link and Cancel again.
  await reopenSettings(page);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.cloud-row-status')).toHaveText('Finish signing in with Google in your browser…');
  await expect(card.getByRole('link', { name: 'Open sign-in link' })).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/v2/auth?mock=1');
  await expect(card.getByRole('button', { name: 'Cancel Google Colab sign-in' })).toBeVisible();
  await expect(signIn).toBeDisabled();

  // Cancel, then start again: the first attempt's late `cancelled` must not end the second.
  const first = 1; // The preview numbers attempts from 1 on each page load.
  await card.getByRole('button', { name: 'Cancel Google Colab sign-in' }).click();
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(card.locator('.cloud-colab-signin')).toBeVisible();
  await page.evaluate(id => (window as any).__previewEmit('colab-sign-in', { id, state: 'cancelled' }), first);
  await expect(card.locator('.cloud-row-status')).toHaveText('Finish signing in with Google in your browser…');
  await expect(card.getByRole('button', { name: 'Cancel Google Colab sign-in' })).toBeVisible();
  await expect(signIn).toBeDisabled();

  await completeColabSignIn(page);
  await expect(card.getByRole('button', { name: 'Disconnect Google Colab', exact: true })).toBeVisible();
  await expect(card.locator('.cloud-colab-signin')).toBeHidden();
});
