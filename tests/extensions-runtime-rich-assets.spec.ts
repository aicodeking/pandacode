import { test, expect, type Frame, type FrameLocator, type Page, type Request } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetRefusalNote, folderPath, injectClient, mediaType, originKey, panelOrigin, previewMountFromUrl, respondPanel, richSource, shellUrl, mountFor, type PanelMount, type PanelServed } from '../src/extensions/runtime-rich-assets.ts';

// PREVIEW column (browser iframe and popup). The browser has no `pandapanel` scheme, so this spec answers the package
// origins `http://pandapanel.<key>.localhost` with `respondPanel` (the twin of the native scheme handler) through
// Playwright routes, and fulfils the declared remote origin from fixtures: nothing reaches the network. The installed
// native column is `rich_views::runtime_rich_assets::tests` and the installed qualification record; this spec never
// stands for it.
const root = fileURLToPath(new URL('./fixtures/extensions/runtime-rich-assets/', import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative));
const alpha = JSON.parse(read('alpha/extension.json').toString('utf8'));
const twin = JSON.parse(read('twin/extension.json').toString('utf8'));
const scripts = {
  channel: readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8'),
  host: readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../src/extensions/rich-view-client.js', import.meta.url), 'utf8'),
};
function folder(relative: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (path: string, prefix: string) => { for (const entry of readdirSync(join(root, path), { withFileTypes: true })) entry.isDirectory() ? walk(`${path}/${entry.name}`, `${prefix}${entry.name}/`) : files.set(`${prefix}${entry.name}`, read(`${path}/${entry.name}`)); };
  walk(relative, '');
  return files;
}
type Seed = { manifest: unknown; enabled: boolean; icons: Record<string, string>; executable?: { digest: string; trusted: boolean } };
const trusted = (manifest: unknown, digest: string): Seed => ({ manifest, enabled: true, icons: {}, executable: { digest, trusted: true } });

/** The package origins of this page: mounts announced by shell requests, folders by package, every request seen. */
type Host = { mounts: Map<string, PanelMount>; served: Map<string, PanelServed>; requests: string[]; undeclared: string[]; keys: { alpha: string; twin: string } };
function labelOf(request: Request, shell: string | undefined): string {
  if (shell) return shell;
  let frame: Frame | null = null;
  try { frame = request.frame(); } catch { return ''; }
  for (; frame; frame = frame.parentFrame()) { const match = /\/~panda\/shell\/([A-Za-z0-9-]+)/.exec(frame.url()); if (match) return match[1]; }
  return '';
}
async function serve(page: Page): Promise<Host> {
  const keys = { alpha: await originKey(alpha.id), twin: await originKey(twin.id) };
  const host: Host = { mounts: new Map(), served: new Map([[keys.alpha, { owner: alpha.id, files: folder('alpha/panel') }], [keys.twin, { owner: twin.id, files: folder('twin/panel') }]]), requests: [], undeclared: [], keys };
  await page.context().route(/^http:\/\/pandapanel\.p[0-9a-f]{32}\.localhost\//, async route => {
    const request = route.request(), url = request.url(); host.requests.push(url);
    const shell = previewMountFromUrl(url);
    if (shell) host.mounts.set(shell.label, shell.mount);
    const reply = await respondPanel({ label: labelOf(request, shell?.label), uri: url, method: request.method(), mounts: host.mounts, served: host.served, scripts });
    await route.fulfill({ status: reply.status, headers: { 'content-type': reply.contentType, ...reply.headers }, body: typeof reply.body === 'string' ? reply.body : Buffer.from(reply.body) });
  });
  await page.context().route('https://charts.example.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!['chart.html', 'embed.html'].includes(name)) return route.fulfill({ status: 404, body: 'not a fixture' });
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: read(`remote/${name}`) });
  });
  await page.context().route('https://undeclared.example.test/**', async route => { host.undeclared.push(route.request().url()); await route.fulfill({ status: 200, body: 'undeclared' }); });
  return host;
}
async function setup(page: Page, packages: Seed[], query = '&rich-assets'): Promise<Host> {
  const host = await serve(page);
  await page.addInitScript(packages => {
    if (location.hostname.endsWith('.localhost') || location.hostname.endsWith('.test')) return;
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, packages);
  await page.goto(`/?extensions-baseline${query}`);
  await expect(page.locator('#prompt')).toBeEnabled();
  return host;
}
const grant = (page: Page, id: string) => page.evaluate(id => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op: 'grant', id, permission: 'ui.richViews' }), id);
const slot = (page: Page, title: string, owner: string) => page.locator(`.extension-rich-panel[aria-label="${title} panel — ${owner}"]`);
const content = (page: Page, title: string, owner: string): FrameLocator => page.frameLocator(`.extension-rich-panel[aria-label="${title} panel — ${owner}"] iframe`).frameLocator('iframe');
const board = (page: Page) => content(page, 'Asset board', alpha.id);
const twinBoard = (page: Page) => content(page, 'Twin board', twin.id);
async function open(page: Page, command: string) { await page.getByRole('button', { name: command, exact: true }).click(); }
async function save(frame: FrameLocator, note: string) { await frame.locator('#note').fill(note); await frame.locator('#save').click(); await expect(frame.locator('#stored')).toHaveText(`stored: ${note}`); }

test('extensions rich assets: a folder panel loads relative modules, an image and a declared remote frame from its own origin', async ({ page }) => {
  const host = await setup(page, [trusted(alpha, 'preview-rich-assets')]); await grant(page, alpha.id);
  await open(page, 'Open asset board');
  const panel = slot(page, 'Asset board', alpha.id);
  await expect(panel).toHaveAttribute('data-rich-mount', 'browser-iframe');
  await expect(panel).toHaveAttribute('data-mount-id', /^extension-panel-/);
  // The shell keeps the package origin (never the app's), so the entry's storage is that origin's.
  await expect(panel.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  await expect(board(page).locator('#module')).toHaveText('modules: asset board loaded');
  await expect(board(page).locator('#image')).toHaveText('image: loaded');
  await expect(board(page).locator('#origin')).toHaveText(`origin: ${panelOrigin(host.keys.alpha)}`);
  await expect(board(page).locator('#base')).toHaveText(`base: ${panelOrigin(host.keys.alpha)}/`);
  await expect(board(page).locator('#init')).toContainText('init: sample.rich-assets 1.0.0 extension-panel-');
  await expect(board(page).frameLocator('#remote').locator('#remote-embed')).toHaveText('Declared remote frame');
  const paths = host.requests.filter(url => url.startsWith(panelOrigin(host.keys.alpha))).map(url => new URL(url).pathname);
  for (const path of ['/index.html', '/app.js', '/lib/format.js', '/img/logo.svg', '/styles.css', '/~panda/client.js']) expect(paths).toContain(path);
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((call: any) => call.command));
  expect(calls.filter((command: string) => command.startsWith('extensions_rich_mount_'))).toEqual([]);
});

test('extensions rich assets: two packages with the same storage key and relative paths keep separate page storage', async ({ page }) => {
  const host = await setup(page, [trusted(alpha, 'preview-rich-assets'), trusted(twin, 'preview-rich-assets-twin')]);
  await grant(page, alpha.id); await grant(page, twin.id);
  expect(panelOrigin(host.keys.alpha)).not.toBe(panelOrigin(host.keys.twin));
  await open(page, 'Open asset board');
  await save(board(page), 'alpha note');
  await open(page, 'Open twin board');
  await expect(twinBoard(page).locator('#module')).toHaveText('modules: twin board loaded');
  await expect(twinBoard(page).locator('#origin')).toHaveText(`origin: ${panelOrigin(host.keys.twin)}`);
  await expect(twinBoard(page).locator('#stored')).toHaveText('stored: empty');
  await save(twinBoard(page), 'twin note');
  await open(page, 'Open asset board');
  await expect(board(page).locator('#stored')).toHaveText('stored: alpha note');
  // Neither origin is the app's: the app's own storage is not the panels'.
  expect(await page.evaluate(() => localStorage.getItem('panel-note'))).toBeNull();
});

test('extensions rich assets: page storage survives a task switch, a reopen and a reload, and the separate window opens the same origin', async ({ page }) => {
  const host = await setup(page, [trusted(alpha, 'preview-rich-assets')]); await grant(page, alpha.id);
  await open(page, 'Open asset board');
  await save(board(page), 'kept across reopen');
  // Task switch: a recorded task, a new task, back to the recorded one, then the board again.
  await page.locator('#prompt').fill('Keep this recorded task'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('#prompt')).toBeEnabled();
  const recorded = await page.locator('#navigation .task-item.selected').getAttribute('data-id');
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await page.locator(`#navigation .task-item[data-id="${recorded}"]`).click();
  await open(page, 'Open asset board');
  await expect(board(page).locator('#stored')).toHaveText('stored: kept across reopen');
  // Reopen after a reload of the app (a new shell document, the same origin).
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await open(page, 'Open asset board');
  await expect(board(page).locator('#stored')).toHaveText('stored: kept across reopen');
  // The separate window: the same package origin at the top level. (Sharing storage between the two placements is a
  // native property — both are top-level documents of that origin in one WebView2 profile; a browser partitions the
  // iframe's storage under the app page, so this preview does not assert it.)
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open isolated extension window', exact: true }).click();
  const popup = await opened;
  await popup.waitForURL(url => url.href.startsWith(shellUrl(host.keys.alpha, 'extension-view-')));
  await expect(popup.frameLocator('iframe').locator('#origin')).toHaveText(`origin: ${panelOrigin(host.keys.alpha)}`);
  await expect(popup.frameLocator('iframe').locator('#init')).toContainText('extension-view-');
  await popup.close();
});

test('extensions rich assets: a path outside the folder and an undeclared origin show useful panel errors, and a remote page is shown as is', async ({ page }) => {
  const host = await setup(page, [trusted(alpha, 'preview-rich-assets')]); await grant(page, alpha.id);
  await open(page, 'Open asset board');
  await expect(board(page).locator('#module')).toHaveText('modules: asset board loaded');
  await board(page).locator('#outside').click();
  await expect(board(page).locator('h1')).toHaveText('Not in the panel folder');
  await expect(board(page).locator('p')).toContainText("extension.json is not a file of this panel's folder");
  const panel = slot(page, 'Asset board', alpha.id);
  await panel.getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect(board(page).locator('#module')).toHaveText('modules: asset board loaded');
  await board(page).locator('#undeclared').click();
  await expect(panel).toHaveAttribute('data-rich-state', 'origin');
  await expect(panel).toContainText('does not declare in rich.remote');
  await expect(panel.locator('iframe')).toHaveCount(0);
  expect(host.undeclared).toEqual([]);
  await panel.getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect(board(page).locator('#module')).toHaveText('modules: asset board loaded');
  // A remote page: framed from its declared origin, without the client (no pandaView, no channel).
  await open(page, 'Open remote chart');
  const chart = content(page, 'Remote chart', alpha.id);
  await expect(chart.locator('#remote-chart')).toHaveText('Remote chart: three series');
  await expect(chart.locator('#has-view')).toHaveText('absent');
  // Without ?rich-assets the preview has no panel host and says so; the host-rendered view stays.
  await page.goto('/?extensions-baseline'); await expect(page.locator('#prompt')).toBeEnabled(); await grant(page, alpha.id);
  await open(page, 'Open asset board');
  await expect(page.locator('.extension-inspector-view')).toContainText('Host-rendered asset board');
  await expect(slot(page, 'Asset board', alpha.id)).toContainText('only with ?rich-assets');
});

test('extensions rich assets: no panel obtains raw native commands, the app document or host storage', async ({ page }) => {
  await setup(page, [trusted(alpha, 'preview-rich-assets')]); await grant(page, alpha.id);
  await open(page, 'Open asset board');
  await expect(board(page).locator('#module')).toHaveText('modules: asset board loaded');
  const frame = page.frames().find(candidate => /\/index\.html$/.test(candidate.url()))!;
  const probe = await frame.evaluate(() => {
    const blocked = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
    return {
      tauri: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
      appDocument: blocked(() => window.top!.document.title),
      appStorage: localStorage.getItem('pandacode.preview.extensions.v1'),
      bridge: typeof (window as any).__extensionRuntimeGrants,
    };
  });
  expect(probe).toEqual({ tauri: false, appDocument: true, appStorage: null, bridge: 'undefined' });
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((call: any) => call.command));
  expect(calls.filter((command: string) => /secret|credential|token/i.test(command))).toEqual([]);
});

test('extensions rich assets: the served rules answer forms, paths, media types, owners and the budget like the native handler', async () => {
  expect(richSource(alpha.contributes.views[0].rich)).toEqual({ kind: 'folder', folder: 'panel', entry: 'index.html', remote: ['https://charts.example.test'] });
  expect(richSource(alpha.contributes.views[1].rich)).toEqual({ kind: 'remote', url: 'https://charts.example.test/chart.html', remote: ['https://charts.example.test'] });
  expect(richSource({ html: 'assets/a.html', css: 'assets/a.css', script: 'assets/a.js' })).toBeUndefined();
  for (const bad of [{ html: 'assets/a.html', css: 'assets/a.css', script: 'assets/a.js', folder: 'panel' }, { folder: 'panel', entry: '../x.html' }, { url: 'https://other.example.test/x', remote: ['https://charts.example.test'] }, { url: 'https://charts.example.test/x' }, { folder: 'panel', entry: 'index.html', remote: ['https://charts.example.test/path'] }]) {
    expect(() => richSource(bad), JSON.stringify(bad)).toThrow(/^InvalidShape/);
  }
  const [a, b] = [await originKey(alpha.id), await originKey(twin.id)];
  expect(a).toMatch(/^p[0-9a-f]{32}$/); expect(a).not.toBe(b); expect(await originKey(alpha.id)).toBe(a);
  expect(folderPath('/lib/format.js')).toBe('lib/format.js'); expect(folderPath('/')).toBe('index.html');
  for (const bad of ['/../extension.json', '/%2e%2e/x', '/a//b', '/a\\b', '/%zz']) expect(folderPath(bad), bad).toBeUndefined();
  expect(mediaType('lib/format.js')).toBe('text/javascript; charset=utf-8'); expect(mediaType('img/logo.svg')).toBe('image/svg+xml'); expect(mediaType('x.wasm')).toBe('application/wasm');
  expect(injectClient('<html><header></header><head><title>x</title></head></html>', 's')).toBe('<html><header></header><head><script src="/~panda/client.js" data-panda-session="s"></script><title>x</title></head></html>');
  const theme = { schemaVersion: 1, colorScheme: 'light' };
  const mounts = new Map([['extension-panel-a', mountFor(alpha.id, '1.0.0', alpha.contributes.views[0], { kind: 'folder', folder: 'panel', entry: 'index.html', remote: [] }, 'extension-panel-a', theme, a, 'session-a')]]);
  const served = new Map<string, PanelServed>([[a, { owner: alpha.id, files: folder('alpha/panel') }], [b, { owner: twin.id, files: folder('twin/panel') }]]);
  const ask = (label: string, uri: string) => respondPanel({ label, uri, mounts, served, scripts });
  expect((await ask('extension-panel-a', `${panelOrigin(a)}/app.js`)).status).toBe(200);
  expect((await ask('extension-panel-a', `${panelOrigin(b)}/app.js`)).status).toBe(403);
  expect((await ask('main', `${panelOrigin(a)}/app.js`)).status).toBe(403);
  const shell = await ask('extension-panel-a', shellUrl(a, 'extension-panel-a'));
  expect(shell.headers['Content-Security-Policy']).toContain("frame-src 'self'");
  expect((await ask('extension-panel-a', `${panelOrigin(a)}/app.js`)).headers['Content-Security-Policy']).toBeUndefined();
  expect(assetRefusalNote('LimitExceeded: open extension panels would hold more than 256 MiB of panel assets.')).toContain('Close a panel of another package');
});
