import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';
import { readFileSync } from 'node:fs';

// The inspector's VM panel in the browser preview: Tart setup, creating and starting a
// VM, its live screen, and mouse, wheel and keyboard input mapped to screen pixels.
const errors = new WeakMap<Page, string[]>();
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__vmCalls.filter((entry: any) => entry.command === command).map((entry: any) => entry.args), command);
const panel = (page: Page) => page.getByRole('region', { name: 'Virtual machines', exact: true });
const control = (page: Page, name: string) => panel(page).getByRole('toolbar', { name: 'VM controls' }).getByRole('button', { name, exact: true });

const cspViolations = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); expect(cspViolations.get(page) ?? []).toEqual([]); });

async function open(page: Page): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      if (command.startsWith('vm_') || command.startsWith('cloud_')) (window.__vmCalls ??= []).push({ command, args: structuredClone(args) });
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) });
  });
  // The desktop app's Content Security Policy, so the panel is tested under the same rules.
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp.replace("connect-src ipc: http://ipc.localhost", "connect-src 'self' ws: ipc: http://ipc.localhost");
  await page.route(url => new URL(url).pathname === '/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`) });
  });
  const blocked: string[] = [];
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) blocked.push(message.text()); });
  cspViolations.set(page, blocked);
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeVisible();
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-vm');
  await page.locator('.inspector-tabs [data-action="tab-vm"]').click();
  await expect(page.locator('#inspector-content')).toBeHidden();
  await expect(panel(page)).toBeVisible();
}

async function createAndStart(page: Page): Promise<void> {
  await panel(page).getByRole('button', { name: 'Set up VMs' }).click();
  await expect(panel(page).getByText('Create a machine', { exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: /^Ubuntu 24\.04/ }).click();
  // A new VM starts at once and shows its screen while the desktop installs.
  await expect(panel(page).getByRole('img', { name: 'VM screen' })).toBeVisible();
  expect((await calls(page, 'vm_create'))[0]).toEqual({ image: 'ubuntu', name: 'pandacode-ubuntu' });
  await expect(panel(page).getByRole('button', { name: 'Choose VM' })).toContainText('pandacode-ubuntu');
}

test('sets up Tart, creates a VM and shows its live screen', async ({ page }) => {
  await open(page);
  await expect(panel(page).getByText('Run Linux, macOS and Windows machines')).toBeVisible();
  await createAndStart(page);
  await expect(control(page, 'Stop VM')).toBeVisible();
  // Linux gets its desktop on its own; the panel says so until it is done. Only macOS suspends.
  await expect(panel(page).getByRole('status')).toContainText('Installing a desktop for agents');
  await control(page, 'Stop VM').click();
  await control(page, 'Start VM').click();
  await expect(panel(page).locator('.vm-status')).not.toContainText('Installing a desktop');
  await expect(control(page, 'Add a desktop')).toBeHidden();
  await expect(control(page, 'Suspend VM')).toBeHidden();
  const size = await panel(page).getByRole('img', { name: 'VM screen' }).evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
  expect(size).toEqual([1024, 768]);
  await control(page, 'Stop VM').click();
  await expect(panel(page).getByText('pandacode-ubuntu is stopped')).toBeVisible();
  await expect(panel(page).getByRole('img', { name: 'VM screen' })).toBeHidden();
});

test('clicks, drags, scrolls and typing reach the VM in screen pixels', async ({ page }) => {
  await open(page);
  await createAndStart(page);
  const screen = panel(page).getByRole('img', { name: 'VM screen' });
  const box = (await screen.boundingBox())!;
  // The middle of the shown image is the middle of the 1024×768 screen.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // WebKit reports whole CSS pixels; one of them spans several screen pixels in the small panel.
  const slack = Math.ceil(1024 / box.width) + 1;
  const near = (value: number, expected: number) => Math.abs(value - expected) <= slack;
  await expect.poll(async () => { const input = (await calls(page, 'vm_input')).at(-1)?.input; return input?.action === 'click' && near(input.x, 512) && near(input.y, 384); }).toBe(true);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => { const input = (await calls(page, 'vm_input')).at(-1)?.input; return input?.action === 'drag' && near(input.x, 256) && near(input.y, 192) && near(input.endX, 768) && near(input.endY, 384); }).toBe(true);
  await page.mouse.click(box.x + 10, box.y + 10, { button: 'right' });
  await expect.poll(async () => (await calls(page, 'vm_input')).at(-1)?.input.action).toBe('right_click');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await calls(page, 'vm_input')).at(-1)?.input).toMatchObject({ action: 'scroll', direction: 'down', amount: 3 });
  // Typed characters arrive together; special keys and shortcuts as key presses.
  await page.keyboard.type('ls -la');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await expect.poll(async () => (await calls(page, 'vm_input')).slice(-3).map(call => call.input)).toEqual([{ action: 'type', text: 'ls -la' }, { action: 'key', keys: 'Return' }, { action: 'key', keys: 'ctrl+c' }]);
});

test('shares the project read-only when asked, and a VM can be deleted', async ({ page }) => {
  await open(page);
  await panel(page).getByRole('button', { name: 'Set up VMs' }).click();
  await panel(page).getByRole('button', { name: /^Debian/ }).click();
  await expect(panel(page).getByRole('img', { name: 'VM screen' })).toBeVisible();
  await control(page, 'Stop VM').click();
  await expect(panel(page).getByText('pandacode-debian is stopped')).toBeVisible();
  await control(page, 'Share project read-only at start').click();
  await expect(control(page, 'Share project read-only at start')).toHaveAttribute('aria-pressed', 'true');
  await control(page, 'Start VM').click();
  await expect(panel(page).getByRole('img', { name: 'VM screen' })).toBeVisible();
  const start = (await calls(page, 'vm_power')).filter(call => call.action === 'start').at(-1);
  expect(start.share).toMatch(/^\//);
  await panel(page).getByRole('button', { name: 'Choose VM' }).click();
  await page.getByRole('menuitemradio', { name: 'Delete pandacode-debian' }).click();
  await expect(panel(page).getByText('Create a machine', { exact: true })).toBeVisible();
});

async function connect(page: Page, provider: string, fields: Record<string, string>, sandboxes = false): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  await settings.getByRole('button', { name: `Connect ${provider}`, exact: true }).click();
  const form = settings.getByRole('form', { name: `Connect ${provider}` });
  for (const [label, value] of Object.entries(fields)) await form.getByRole('textbox', { name: `${provider} ${label}` }).or(form.getByLabel(`${provider} ${label}`)).fill(value);
  await form.locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: `Disconnect ${provider}`, exact: true })).toBeVisible();
  if (sandboxes) {
    await settings.getByRole('button', { name: 'Set up sandboxes', exact: true }).click();
    await expect(settings.getByText(/sandboxes ready/)).toBeVisible();
  }
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings).toBeHidden();
}

test('connecting a cloud provider checks the key and offers its machines', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  await settings.getByRole('button', { name: 'Connect Daytona', exact: true }).click();
  const form = settings.getByRole('form', { name: 'Connect Daytona' });
  await form.locator('[type="submit"]').click();
  await expect(form.getByRole('alert')).toHaveText('Enter the api key.');
  await form.getByLabel('Daytona API key').fill('bad');
  await form.locator('[type="submit"]').click();
  await expect(form.getByRole('alert')).toContainText('refused the credentials');
  await form.getByLabel('Daytona API key').fill('dtn_good');
  await form.getByLabel('Daytona Organization ID').fill('org-1');
  await form.locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: 'Disconnect Daytona', exact: true })).toBeVisible();
  const connect = (await calls(page, 'cloud_connect')).at(-1);
  expect(connect).toEqual({ provider: 'daytona', key: 'dtn_good', options: { organization: 'org-1', apiUrl: '' } });
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings).toBeHidden();
  // The panel now offers a Daytona desktop even before Tart is set up.
  await expect(panel(page).getByRole('button', { name: /^Daytona desktop/ })).toBeVisible();
});

test('a cloud desktop streams its screen and takes input; a commands-only sandbox explains itself', async ({ page }) => {
  await open(page);
  await connect(page, 'Daytona', { 'API key': 'dtn_good' });
  await connect(page, 'Cloudflare', { 'API token': 'cf_token', 'Account ID': '0123456789abcdef0123456789abcdef' }, true);
  await panel(page).getByRole('button', { name: /^Daytona desktop/ }).click();
  const screen = panel(page).getByRole('img', { name: 'VM screen' });
  await expect(screen).toBeVisible();
  expect((await calls(page, 'cloud_create'))[0]).toMatchObject({ provider: 'daytona' });
  const box = (await screen.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const slack = Math.ceil(1280 / box.width) + 1;
  await expect.poll(async () => { const input = (await calls(page, 'cloud_input')).at(-1)?.input; return input?.action === 'click' && Math.abs(input.x - 640) <= slack && Math.abs(input.y - 400) <= slack; }).toBe(true);
  await control(page, 'Stop VM').click();
  await expect.poll(async () => (await calls(page, 'cloud_power')).at(-1)).toMatchObject({ action: 'stop' });
  await expect(panel(page).getByText(/is stopped/)).toBeVisible();
  await control(page, 'New VM').click();
  await page.getByRole('menuitemradio', { name: 'Cloudflare container' }).click();
  await expect(panel(page).getByText(/has no screen/)).toBeVisible();
  await expect(control(page, 'Share project read-only at start')).toBeHidden();
});
