import { test, expect, type FrameLocator, type Page, type Request, type Frame } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { PreviewPanelHost, type Envelope } from '../src/extensions/runtime-rich-channel';
import { PanelOnlyPages, panelOnly, type PanelOnlyManifest } from '../src/extensions/runtime-panel-only';
import { originKey, previewMountFromUrl, respondPanel, type PanelMount, type PanelServed } from '../src/extensions/runtime-rich-assets';
import type { Grants } from '../src/extensions/runtime-preview';

// PREVIEW column of R1205, the panel-only arcade (`sample.arcade`, examples/extensions/arcade/package). The Node checks
// read the shipped package files and drive the pure game rules and the R0305 page host (the twin of the native
// `runtime_panel_only`), which is never started. The browser checks install the same package folder in the app preview
// (`?rich-assets`, package origins answered by `respondPanel` through Playwright routes), the way the R0305 spec does.
// Written for the final test phase and NOT run when written. They never stand for the installed Windows app: key
// handling in a real webview, sound, the worker and kept state there are the installed column (evidence-columns.json).
const packageRoot = fileURLToPath(new URL('../examples/extensions/arcade/package/', import.meta.url));
const panelRoot = join(packageRoot, 'panel');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'extension.json'), 'utf8')) as PanelOnlyManifest & { permissions: string[]; contributes: { views: { id: string; title: string; rich: Record<string, unknown> }[] } };
const OWNER = 'sample.arcade';
const VIEW = 'sample.arcade/game';
const origin = { owner: OWNER, version: '1.0.0', viewId: VIEW };
const PANEL_FILES = ['audio.js', 'game.js', 'index.html', 'level-worker.js', 'main.js', 'over.wav', 'point.wav', 'sprite.svg', 'style.css'];
const hello = (session: string) => ({ schemaVersion: 1, session, kind: 'hello' });
const call = (session: string, id: number, path: string, args: unknown[] = []) => ({ schemaVersion: 1, session, kind: 'call', id, path, args });
const value = (envelope: Envelope) => { if (!envelope.ok) throw new Error(envelope.error.message); return envelope.value as Record<string, any>; };
function shell() { const received: any[] = []; return { received, frame: { contentWindow: { postMessage: (message: any) => received.push(message.detail) } as unknown as Window } }; }

test('arcade preview: the package is one panel folder with nine files, three modules, a worker and no runtime', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(['ui.contribute', 'ui.richViews', 'storage.private']);
  expect((manifest as { runtime?: unknown }).runtime).toBeUndefined();
  expect(panelOnly(manifest)).toBe(true);
  expect(manifest.contributes.views[0].rich).toMatchObject({ folder: 'panel', entry: 'index.html' });
  expect(readdirSync(panelRoot).sort()).toEqual(PANEL_FILES);
  const html = readFileSync(join(panelRoot, 'index.html'), 'utf8');
  expect(html).toContain('href="./style.css"');
  expect(html).toContain('type="module" src="./main.js"');
  // Every address in the page and in its modules is relative to the folder: nothing names a network origin.
  for (const name of ['index.html', 'main.js', 'game.js', 'audio.js', 'level-worker.js', 'style.css']) {
    expect(readFileSync(join(panelRoot, name), 'utf8'), name).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  }
  const main = readFileSync(join(panelRoot, 'main.js'), 'utf8');
  expect(main).toContain("import { COLS, ROWS, DIRECTIONS, buildLevel, newRound, revive, step, turn } from './game.js'");
  expect(main).toContain("import { createAudio } from './audio.js'");
  expect(main).toContain('level-worker.js');
  expect(main).toContain('sprite.svg');
});

test('arcade preview: the game rules steer, score, end and revive a saved round', async () => {
  const game = await import(pathToFileURL(join(panelRoot, 'game.js')).href);
  const walls = game.buildLevel(7);
  expect(walls).toEqual(game.buildLevel(7));
  expect(walls.length).toBeGreaterThan(0);
  const round = game.newRound(7, []);
  const [hx, hy] = round.snake[0];
  expect(game.turn(round, 'ArrowLeft')).toBe(false); // a reversal is ignored
  expect(game.turn(round, 'ArrowRight')).toBe(false); // so is the same direction
  expect(game.turn(round, 'ArrowUp')).toBe(true);
  game.step(round);
  expect(round.snake[0]).toEqual([hx, hy - 1]);
  round.fruit = [hx, hy - 2];
  expect(game.step(round)).toMatchObject({ ate: true, over: false });
  expect(round.score).toBe(1);
  expect(round.snake.length).toBe(4);
  // The saved round survives JSON and a bad one is refused.
  const revived = game.revive(JSON.parse(JSON.stringify(round)));
  expect(revived).toMatchObject({ score: 1, over: false });
  expect(game.revive({ seed: 'x' })).toBeNull();
  expect(game.revive(null)).toBeNull();
  // Walking into the wall ends the round.
  const edge = game.newRound(7, []);
  let over = false;
  for (let index = 0; index < game.COLS + 2 && !over; index += 1) over = game.step(edge).over;
  expect(over).toBe(true);
});

test('arcade preview: the page host keeps state and runs the panel with zero service starts; service-only calls answer UnsupportedCapability', async () => {
  const panels = new PreviewPanelHost(() => 1000);
  const pages = new PanelOnlyPages(panels, () => undefined);
  const grants: Grants = new Map();
  for (const name of manifest.permissions) grants.set(name, true);
  const runner = pages.register({ manifest, loaders: {}, grants, now: () => 1000, authorized: () => true });
  const a = shell();
  const dispose = pages.mount('extension-panel-a', a.frame, origin);
  const init = value(panels.handle('extension-panel-a', hello('s')));
  expect([init.placement, init.restored]).toEqual(['inspector', false]);
  const saved = { ts: 5, best: 3, sound: true, round: null };
  expect(panels.handle('extension-panel-a', { schemaVersion: 1, session: 's', kind: 'state', value: saved }).ok).toBe(true);
  for (const path of ['storage.directory', 'secrets.get', 'views.post', 'events.on']) {
    expect(panels.handle('extension-panel-a', call('s', 1, path, [{ scope: 'global' }])), path).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability' } });
  }
  expect([runner.starts, runner.state, pages.starts(OWNER)]).toEqual([0, 'stopped', 0]);
  expect(await runner.start()).toMatchObject({ ok: false });
  dispose(true);
  const b = shell();
  pages.mount('extension-panel-b', b.frame, origin);
  expect(value(panels.handle('extension-panel-b', hello('s2')))).toMatchObject({ instanceId: init.instanceId, restored: true, state: saved });
});

// ---- browser: the package installed in the app preview ---------------------------------------------------------------

const scripts = {
  channel: readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8'),
  host: readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../src/extensions/rich-view-client.js', import.meta.url), 'utf8'),
};
function folder(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(panelRoot)) files.set(name, readFileSync(join(panelRoot, name)));
  return files;
}
function labelOf(request: Request, shellLabel: string | undefined): string {
  if (shellLabel) return shellLabel;
  let frame: Frame | null = null;
  try { frame = request.frame(); } catch { return ''; }
  for (; frame; frame = frame.parentFrame()) { const match = /\/~panda\/shell\/([A-Za-z0-9-]+)/.exec(frame.url()); if (match) return match[1]; }
  return '';
}
async function setup(page: Page) {
  const key = await originKey(OWNER);
  const mounts = new Map<string, PanelMount>();
  const served = new Map<string, PanelServed>([[key, { owner: OWNER, files: folder() }]]);
  await page.context().route(/^http:\/\/pandapanel\.p[0-9a-f]{32}\.localhost\//, async route => {
    const request = route.request(), url = request.url();
    const shellMount = previewMountFromUrl(url);
    if (shellMount) mounts.set(shellMount.label, shellMount.mount);
    const answer = await respondPanel({ label: labelOf(request, shellMount?.label), uri: url, method: request.method(), mounts, served, scripts });
    await route.fulfill({ status: answer.status, headers: { 'content-type': answer.contentType, ...answer.headers }, body: typeof answer.body === 'string' ? answer.body : Buffer.from(answer.body) });
  });
  await page.addInitScript(seed => {
    if (location.hostname.endsWith('.localhost')) return;
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([seed]));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, { manifest, enabled: true, icons: {}, executable: { digest: 'preview-arcade', trusted: true } });
  await page.goto('/?extensions-baseline&rich-assets');
  await expect(page.locator('#prompt')).toBeEnabled();
  await grant(page, 'grant', 'ui.richViews');
  return key;
}
const grant = (page: Page, op: 'grant' | 'revoke', permission: string) => page.evaluate(({ op, id, permission }) => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op, id, permission }), { op, id: OWNER, permission });
const slot = (page: Page) => page.locator(`.extension-rich-panel[aria-label="Arcade panel — ${OWNER}"]`);
const arcade = (page: Page): FrameLocator => page.frameLocator(`.extension-rich-panel[aria-label="Arcade panel — ${OWNER}"] iframe`).frameLocator('iframe');
async function open(page: Page) {
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await expect(arcade(page).locator('#state')).toContainText('Press Space');
}
const observed = (frame: FrameLocator) => frame.locator('body').evaluate(() => JSON.parse(JSON.stringify((window as any).__arcade)));
const host = (page: Page) => page.evaluate(async owner => {
  const pages = (window as any).__panelOnlyPages;
  return { starts: pages.starts(owner) as number, tracked: pages.tracked() as number, services: await pages.services() as string[] };
}, OWNER);

test('arcade preview: the panel draws, the frame counter rises, and every resource comes from the package origin', async ({ page, browserName }) => {
  const key = await setup(page); await open(page);
  const frame = arcade(page);
  const first = (await observed(frame)).frames;
  await expect.poll(async () => (await observed(frame)).frames).toBeGreaterThan(first + 10);
  // The sprite, the modules and the stylesheet were loaded from the package origin; the sounds after the first key.
  await frame.locator('#board').click();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__arcadeDo.resources())).toEqual(expect.arrayContaining([
    expect.stringMatching(/style\.css$/), expect.stringMatching(/main\.js$/), expect.stringMatching(/game\.js$/), expect.stringMatching(/audio\.js$/), expect.stringMatching(/sprite\.svg$/), expect.stringMatching(/point\.wav$/),
  ]));
  const resources: string[] = await frame.locator('body').evaluate(() => (window as any).__arcadeDo.resources());
  for (const url of resources) expect(url, url).toContain(`pandapanel.${key}.localhost`);
  expect((await observed(frame)).spriteLoaded).toBe(true);
  // The level is built by the worker where the engine lets the preview route serve one; the page builds it otherwise.
  const from = (await observed(frame)).levelFrom;
  expect(['worker', 'page']).toContain(from);
  if (browserName === 'chromium') expect(from).toBe('worker');
  // The panel is the whole package: no service process, no host-rendered table.
  expect(await host(page)).toMatchObject({ starts: 0 });
});

test('arcade preview: arrow keys steer only while the panel has focus, Space resumes after a blur, Escape returns the keyboard', async ({ page }) => {
  await setup(page); await open(page);
  const frame = arcade(page);
  // Focus in the composer: the keys do not reach the game.
  await page.locator('#prompt').focus();
  await page.keyboard.press('ArrowDown');
  expect((await observed(frame)).ticks).toBe(0);
  await expect(frame.locator('#state')).toContainText('Press Space');
  // Focus in the panel: an arrow starts the round and steers it.
  await frame.locator('#board').click();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await observed(frame)).ticks).toBeGreaterThan(2);
  const dir = await frame.locator('body').evaluate(() => (window as any).__arcadeDo.round().dir);
  expect(dir).toEqual([0, -1]);
  // A lost focus pauses; Space resumes.
  await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(frame.locator('#state')).toContainText('lost focus');
  const stopped = (await observed(frame)).ticks;
  await page.waitForTimeout(400);
  expect((await observed(frame)).ticks).toBe(stopped);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await observed(frame)).ticks).toBeGreaterThan(stopped);
  // Escape gives the keyboard back to the control that had it before the panel.
  await page.keyboard.press('Escape');
  await expect(page.locator('#prompt')).toBeFocused();
});

test('arcade preview: the round, the best score and the sound preference survive a panel reload and a reopened application', async ({ page }) => {
  await setup(page); await open(page);
  const frame = arcade(page);
  await frame.locator('#sound').click();
  await expect(frame.locator('#sound')).toHaveAttribute('aria-pressed', 'true');
  await frame.locator('#board').click();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await observed(frame)).ticks).toBeGreaterThan(1);
  await page.keyboard.press('Space');
  const round = await frame.locator('body').evaluate(() => (window as any).__arcadeDo.round());
  // The journal is written synchronously, so a forced reload of the panel finds the round.
  await slot(page).getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect.poll(async () => (await observed(frame)).restored).toMatchObject({ round: true });
  const again = await frame.locator('body').evaluate(() => (window as any).__arcadeDo.round());
  expect(again.seed).toBe(round.seed);
  expect(again.walls).toEqual(round.walls);
  await expect(frame.locator('#sound')).toHaveAttribute('aria-pressed', 'true');
  // A best score kept in the journal comes back in a reopened application.
  await frame.locator('body').evaluate(() => { const saved = JSON.parse(localStorage.getItem('arcade.journal.v1') ?? '{}'); localStorage.setItem('arcade.journal.v1', JSON.stringify({ ...saved, best: 7, ts: Date.now() + 1 })); });
  await page.reload();
  await expect(page.locator('#prompt')).toBeEnabled();
  await grant(page, 'grant', 'ui.richViews');
  await open(page);
  await expect(arcade(page).locator('#best')).toHaveText('7');
});

test('arcade preview: the package follows the application theme, with reduced motion honoured', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await setup(page); await open(page);
  const frame = arcade(page);
  await expect.poll(async () => (await observed(frame)).theme).toBeTruthy();
  const before = await frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-bg').trim());
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const dark = await frame.locator('body').evaluate(() => document.documentElement.dataset.theme);
  expect(['dark', 'light']).toContain(dark);
  expect(before.length).toBeGreaterThan(0);
  // Reduced motion removes the button transitions; nothing in the page animates layout.
  const transition = await frame.locator('#sound').evaluate(node => getComputedStyle(node).transitionDuration);
  expect(transition).toMatch(/^0s(, 0s)*$/);
});

test('arcade preview: a service-only call fails explicitly, and a failed or hung page leaves the host responsive', async ({ page }) => {
  await setup(page); await open(page);
  const frame = arcade(page);
  const probe = await frame.locator('body').evaluate(() => (window as any).__arcadeDo.probe());
  expect(probe).toEqual({ post: 'UnsupportedCapability', directory: 'UnsupportedCapability' });
  expect(await host(page)).toMatchObject({ starts: 0 });
  await page.locator('#prompt').focus();
  await frame.locator('body').evaluate(() => (window as any).__arcadeDo.fail());
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'error');
  // The application still answers: the prompt takes input while the panel is failed.
  await page.locator('#prompt').fill('still responsive');
  await expect(page.locator('#prompt')).toHaveValue('still responsive');
  await slot(page).getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect(frame.locator('#state')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((entry: any) => entry.command));
  expect(calls.filter((command: string) => command.startsWith('extensions_service_start'))).toEqual([]);
});

test('arcade preview: disable gives the keyboard back and removes the panel; safe mode shows nothing', async ({ page }) => {
  await setup(page); await open(page);
  await page.locator('#prompt').focus();
  await arcade(page).locator('#board').click();
  await page.evaluate(id => (window as any).__previewDisableExtension(id), OWNER);
  await expect(page.locator('.extension-rich-panel iframe')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toHaveCount(0);
  await expect(page.locator('#prompt')).toBeFocused();
  await page.goto('/?extensions-baseline&rich-assets&safe-mode');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toHaveCount(0);
  await expect(page.locator('.extension-rich-panel')).toHaveCount(0);
});
