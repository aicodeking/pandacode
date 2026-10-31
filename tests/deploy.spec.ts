import { expect, test, type Page } from '@playwright/test';

// Deploy: connected platforms start an agent task that ships the project end to end;
// Cloudflare's container sandboxes are a separate one-time setup.
const errors = new WeakMap<Page, string[]>();
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__deployCalls.filter((entry: any) => entry.command === command).map((entry: any) => entry.args), command);
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

async function open(page: Page): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__deployCalls ??= []).push({ command, args: structuredClone(args) });
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) });
  });
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeVisible();
}
async function connect(page: Page, provider: string, fields: Record<string, string>): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  await settings(page).getByRole('button', { name: `Connect ${provider}`, exact: true }).click();
  const form = settings(page).getByRole('form', { name: `Connect ${provider}` });
  for (const [label, value] of Object.entries(fields)) await form.getByLabel(`${provider} ${label}`).fill(value);
  await form.locator('[type="submit"]').click();
  await expect(settings(page).getByRole('button', { name: `Disconnect ${provider}`, exact: true })).toBeVisible();
}

test('deploy offers connected platforms and starts a task with the brief', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Deploy' });
  await expect(menu.getByRole('menuitem', { name: 'Deploy to Vercel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await connect(page, 'Vercel', { 'Access token': 'vcp_token', 'Team slug': 'acme' });
  expect((await calls(page, 'cloud_connect')).at(-1)).toEqual({ provider: 'vercel', key: 'vcp_token', options: { team: 'acme' } });
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings(page)).toBeHidden();
  const before = await page.locator('#prompt').getAttribute('data-session-id');
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Deploy to AWS' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Deploy to Vercel' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sent = (await calls(page, 'send_message'))[0];
  expect(sent.sessionId).not.toBe(before);
  expect(sent.text).toMatch(/^Deploy this project to Vercel\./);
  expect(sent.text).toContain('pandacode_cloud_cli');
  expect(sent.text).toContain('deploy --prod --yes');
  expect(sent.text).not.toContain('vcp_token');
});

test('Netlify connects a project, starts a deploy task and disconnects', async ({ page }, testInfo) => {
  await open(page);
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Deploy' });
  await expect(menu.getByRole('menuitem', { name: 'Deploy to Netlify' })).toBeDisabled();
  await page.keyboard.press('Escape');
  const site = '12345678-1234-4234-8234-123456789abc';
  await connect(page, 'Netlify', { 'Personal access token': 'netlify-test-token', 'Project ID': site });
  expect((await calls(page, 'cloud_connect')).at(-1)).toEqual({ provider: 'netlify', key: 'netlify-test-token', options: { siteId: site } });
  const card = settings(page).locator('.cloud-provider[data-provider="netlify"]');
  await expect(card).toContainText(`Connected · ${site}`);
  await card.screenshot({ path: testInfo.outputPath('netlify-connected.png') });
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Deploy to Netlify' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sent = (await calls(page, 'send_message'))[0];
  expect(sent.text).toMatch(/^Deploy this project to Netlify\./);
  expect(sent.text).toContain('--no-build');
  expect(sent.text).toContain('pandacode_cloud_cli');
  expect(sent.text).toContain('deploy --prod');
  expect(sent.text).not.toContain('netlify-test-token');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Disconnect Netlify', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'Connect Netlify', exact: true })).toBeVisible();
});

test('Railway connects with a workspace and starts a deploy task', async ({ page }) => {
  await open(page);
  await connect(page, 'Railway', { 'API token': 'railway_token', 'Workspace ID': 'ws-1' });
  expect((await calls(page, 'cloud_connect')).at(-1)).toEqual({ provider: 'railway', key: 'railway_token', options: { workspace: 'ws-1' } });
  await expect(settings(page).locator('.cloud-provider[data-provider="railway"]')).toContainText('Connected · ws-1');
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.getByRole('menu', { name: 'Deploy' }).getByRole('menuitem', { name: 'Deploy to Railway' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sent = (await calls(page, 'send_message'))[0];
  expect(sent.text).toMatch(/^Deploy this project to Railway\./);
  expect(sent.text).toContain('up --ci');
  expect(sent.text).not.toContain('railway_token');
});

test('Google Cloud connects with the gcloud login, a project and a region', async ({ page }) => {
  await open(page);
  await connect(page, 'Google Cloud', { 'Project ID': 'my-app-123', Region: 'us-central1' });
  expect((await calls(page, 'cloud_connect')).at(-1)).toEqual({ provider: 'gcloud', key: '', options: { project: 'my-app-123', region: 'us-central1' } });
  await expect(settings(page).locator('.cloud-provider[data-provider="gcloud"]')).toContainText('Connected · my-app-123 · us-central1');
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.getByRole('menu', { name: 'Deploy' }).getByRole('menuitem', { name: 'Deploy to Google Cloud' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sent = (await calls(page, 'send_message'))[0];
  expect(sent.text).toMatch(/^Deploy this project to Google Cloud\./);
  expect(sent.text).toContain('run deploy <service> --source .');
  expect(sent.text).toContain('pandacode=deploy');
});

test('Cloudflare connects for deploys first and sets up container sandboxes separately', async ({ page }) => {
  await open(page);
  await connect(page, 'Cloudflare', { 'API token': 'cf_token', 'Account ID': '0123456789abcdef0123456789abcdef' });
  const row = settings(page).locator('.cloud-provider[data-provider="cloudflare"]');
  await expect(row).toContainText('sandboxes not set up');
  await row.getByRole('button', { name: 'Set up sandboxes', exact: true }).click();
  await expect(row).toContainText('sandboxes ready');
  await expect(row.getByRole('button', { name: 'Set up sandboxes', exact: true })).toBeHidden();
  expect(await calls(page, 'cloud_setup_sandboxes')).toHaveLength(1);
});
