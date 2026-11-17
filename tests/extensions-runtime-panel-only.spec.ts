import { test, expect, type FrameLocator, type Page, type Request, type Frame } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { CLOSED, NO_SERVICE, PreviewPanelHost, type Envelope } from '../src/extensions/runtime-rich-channel';
import { PAGE_ENDED, PageWork, PanelOnlyPages, lifecycleRefusal, panelOnly, type PanelOnlyManifest } from '../src/extensions/runtime-panel-only';
import { originKey, previewMountFromUrl, respondPanel, type PanelMount, type PanelServed } from '../src/extensions/runtime-rich-assets';
import type { Grants } from '../src/extensions/runtime-preview';

// PREVIEW column of R0305. The Node checks drive `src/extensions/runtime-panel-only.ts` (the twin of the native
// `rich_views::runtime_panel_only`) over the R0303 panel host and the R0208 runner's page panda, which is never
// started; the browser checks install the canvas fixture in the app preview (`?rich-assets`, package origins answered
// by `respondPanel` through Playwright routes) and use it through the inspector. Native fixtures are
// `runtime_panel_only::tests`; installed qualification is pending. None of this stands for the installed app.
const root = fileURLToPath(new URL('./fixtures/extensions/runtime-panel-only/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'extension.json'), 'utf8')) as PanelOnlyManifest & { permissions: string[]; contributes: { views: { id: string; title: string; rich: Record<string, unknown> }[] } };
const OWNER = 'sample.panel-only';
const VIEW = 'sample.panel-only/sketch';
const origin = { owner: OWNER, version: '1.0.0', viewId: VIEW };
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const hello = (session: string) => ({ schemaVersion: 1, session, kind: 'hello' });
const call = (session: string, id: number, path: string, args: unknown[] = []) => ({ schemaVersion: 1, session, kind: 'call', id, path, args });
const value = (envelope: Envelope) => { if (!envelope.ok) throw new Error(envelope.error.message); return envelope.value as Record<string, any>; };
const notice = { key: 'sketch', title: 'Sketch', text: '1 strokes saved' };
const item = { kind: 'menu', id: 'sample.panel-only/strokes', location: 'panda.status.items', command: 'sample.panel-only/open', presentation: 'status', text: '1 strokes' };

/** A shell the Node checks stand in for: what the host pushes to it is kept. */
function shell() { const received: any[] = []; return { received, frame: { contentWindow: { postMessage: (message: any) => received.push(message.detail) } as unknown as Window } }; }
const reply = (frame: ReturnType<typeof shell>, id: number) => frame.received.find(message => message.kind === 'reply' && message.id === id);

function boot() {
  const clock = 1000;
  const panels = new PreviewPanelHost(() => clock);
  const released: string[] = [];
  const pages = new PanelOnlyPages(panels, label => released.push(label));
  let allowed = true;
  const grants: Grants = new Map();
  for (const name of manifest.permissions) grants.set(name, true);
  const runner = pages.register({ manifest, loaders: {}, grants, now: () => clock, authorized: () => allowed });
  return { panels, pages, runner, grants, released, deny: () => { allowed = false; }, allow: () => { allowed = true; } };
}

test('extensions panel only: the canvas fixture is a valid package with a panel and no runtime, and the twin keeps the native names', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect((manifest as { runtime?: unknown }).runtime).toBeUndefined();
  expect(panelOnly(manifest)).toBe(true);
  expect(panelOnly({ ...manifest, runtime: { service: { start: 'onEnable' } } })).toBe(false);
  expect(panelOnly({ ...manifest, contributes: { views: [{ id: VIEW }] } })).toBe(false);
  expect(manifest.contributes.views[0].rich).toMatchObject({ folder: 'canvas', entry: 'index.html' });
  const native = readFileSync(new URL('../src-tauri/src/extensions/runtime_panel_only.rs', import.meta.url), 'utf8');
  expect(native).toContain(`pub const PAGE_ENDED: &str = "${PAGE_ENDED}";`);
  // Declared once, beside the other panel modules (never in mod.rs too); the channel notes page calls and the mount
  // gives the keyboard back when a focused panel ends.
  const views = readFileSync(new URL('../src-tauri/src/extensions/rich_views.rs', import.meta.url), 'utf8');
  expect(views).toContain('#[path = "runtime_panel_only.rs"]');
  expect(views).toContain('runtime_panel_only::reconcile(app)');
  expect(readFileSync(new URL('../src-tauri/src/extensions/mod.rs', import.meta.url), 'utf8')).not.toContain('runtime_panel_only');
  expect(readFileSync(new URL('../src-tauri/src/extensions/runtime_rich_channel.rs', import.meta.url), 'utf8')).toContain('runtime_panel_only::note_call');
  expect(readFileSync(new URL('../src-tauri/src/extensions/runtime_rich_mount.rs', import.meta.url), 'utf8')).toContain('runtime_panel_only::release_focus');
});

test('extensions panel only: the page keeps its state and calls the host with zero service starts; messaging and storage.directory answer UnsupportedCapability', async () => {
  const { panels, pages, runner, grants } = boot();
  const a = shell();
  const disposeA = pages.mount('extension-panel-a', a.frame, origin);
  const init = value(panels.handle('extension-panel-a', hello('s')));
  expect([init.placement, init.restored]).toEqual(['inspector', false]);
  expect(panels.handle('extension-panel-a', { schemaVersion: 1, session: 's', kind: 'state', value: { strokes: [[10, 10, 80, 100]] } }).ok).toBe(true);
  // Calls available in a panel run on the page panda, checked per call.
  expect(value(panels.handle('extension-panel-a', call('s', 1, 'ui.notify', [notice])))).toEqual({ accepted: true });
  expect(value(panels.handle('extension-panel-a', call('s', 2, 'ui.register', [item])))).toEqual({ accepted: true });
  await settle();
  expect(reply(a, 1)).toMatchObject({ ok: true, value: expect.objectContaining({ key: 'sketch', merged: false }) });
  expect(reply(a, 2)).toMatchObject({ ok: true });
  expect(runner.noticeSnapshot().notices.map(row => [row.owner, row.key])).toEqual([[OWNER, 'sketch']]);
  expect(runner.items.count(OWNER)).toBe(1);
  expect(pages.work.size).toBe(1);
  // The grant is read at every call: without ui.notify the same call is refused.
  grants.delete('ui.notify');
  panels.handle('extension-panel-a', call('s', 3, 'ui.notify', [notice]));
  await settle();
  expect(reply(a, 3)).toMatchObject({ ok: false, error: { code: 'PermissionDenied' } });
  grants.set('ui.notify', true);
  // postMessage has nobody to receive it; the data directory and other service-only calls never leave the panel.
  panels.handle('extension-panel-a', { schemaVersion: 1, session: 's', kind: 'post', id: 4, message: { kind: 'saved' } });
  await settle();
  expect(reply(a, 4)).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', message: NO_SERVICE } });
  for (const path of ['storage.directory', 'secrets.get', 'auth.signIn', 'views.post', 'events.on', 'commands.register']) {
    expect(panels.handle('extension-panel-a', call('s', 5, path, [{ scope: 'global' }])), path).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability' } });
  }
  // Zero service starts: the runner was never started, and starting it is refused (no service is declared).
  expect([runner.starts, runner.state, pages.starts(OWNER)]).toEqual([0, 'stopped', 0]);
  expect(await runner.start()).toMatchObject({ ok: false });
  expect(runner.starts).toBe(0);
  // A reload of the panel (a new mount of the same inspector slot) gets the same instance and its state back.
  disposeA(true);
  const b = shell();
  pages.mount('extension-panel-b', b.frame, origin);
  const again = value(panels.handle('extension-panel-b', hello('s2')));
  expect([again.instanceId, again.restored, again.state]).toEqual([init.instanceId, true, { strokes: [[10, 10, 80, 100]] }]);
});

test('extensions panel only: disable and safe mode close the instances, give the keyboard back and end the page work, even after the panel failed', async () => {
  const { panels, pages, runner, released, deny, allow } = boot();
  const a = shell();
  pages.mount('extension-panel-a', a.frame, origin);
  value(panels.handle('extension-panel-a', hello('s')));
  panels.handle('extension-panel-a', { schemaVersion: 1, session: 's', kind: 'focus', focused: true });
  panels.handle('extension-panel-a', call('s', 1, 'ui.notify', [notice]));
  panels.handle('extension-panel-a', call('s', 2, 'ui.register', [item]));
  await settle();
  expect([runner.noticeSnapshot().notices.length, runner.items.count(OWNER)]).toEqual([1, 1]);
  // Allowed: nothing ends.
  expect(pages.reconcile('disable')).toEqual({ ended: [], released: [] });
  // Disabled: the focused instance gives the keyboard back, closes without keeping its state, and the work ends.
  await runner.setEnabled(false); deny();
  expect(pages.reconcile('disable')).toEqual({ ended: [OWNER], released: ['extension-panel-a'] });
  expect(released).toEqual(['extension-panel-a']);
  expect([panels.instances(OWNER), panels.channel.dormant()]).toEqual([[], 0]);
  expect([runner.noticeSnapshot().notices.length, runner.items.count(OWNER), pages.work.size]).toEqual([0, 0, 0]);
  expect(panels.handle('extension-panel-a', call('s', 3, 'ui.notify', [notice]))).toMatchObject({ ok: false, error: { message: CLOSED } });
  expect(pages.reconcile('disable')).toEqual({ ended: [], released: [] });
  // Enabled again: a fresh instance, nothing kept.
  await runner.setEnabled(true); allow();
  const d = shell();
  const disposeD = pages.mount('extension-panel-d', d.frame, origin);
  expect(value(panels.handle('extension-panel-d', hello('d'))).restored).toBe(false);
  panels.handle('extension-panel-d', { schemaVersion: 1, session: 'd', kind: 'state', value: { strokes: [] } });
  panels.handle('extension-panel-d', call('d', 1, 'ui.notify', [notice]));
  await settle();
  // The panel fails: its mount ends keeping the state for a reload, and the work outlives the document.
  disposeD(true);
  expect([panels.channel.dormant(), runner.noticeSnapshot().notices.length]).toEqual([1, 1]);
  // Safe mode: the failed panel's kept state and the page's work go; there is no keyboard to give back.
  await runner.setSafeMode(true); deny();
  expect(pages.reconcile('safeMode')).toEqual({ ended: [OWNER], released: [] });
  expect([panels.channel.dormant(), runner.noticeSnapshot().notices.length]).toEqual([0, 0]);
  expect(runner.starts).toBe(0);
});

test('extensions panel only: page work ends once per package and the lifecycle reason is read from the snapshot', () => {
  const work = new PageWork();
  expect([work.note(OWNER, '1.0.0'), work.note(OWNER, '1.0.0'), work.note('sample.other', '1.0.0')]).toEqual([true, false, true]);
  expect(work.ended(() => true)).toEqual([]);
  expect(work.ended(owner => owner !== OWNER)).toEqual([OWNER]);
  expect(work.ended(owner => owner !== OWNER)).toEqual([]);
  expect(work.size).toBe(1);
  const item = { manifest: { id: OWNER, version: '1.0.0' }, enabled: true, executable: { trusted: true } };
  expect(lifecycleRefusal({ packages: [item] }, OWNER, '1.0.0')).toBeUndefined();
  expect(lifecycleRefusal({ safeMode: true, packages: [item] }, OWNER, '1.0.0')).toBe('safe-mode');
  expect(lifecycleRefusal({ packages: [{ ...item, enabled: false }] }, OWNER, '1.0.0')).toBe('disabled');
  expect(lifecycleRefusal({ packages: [item] }, OWNER, '1.0.1')).toBe('disabled');
  expect(lifecycleRefusal({ packages: [{ ...item, executable: { trusted: false } }] }, OWNER, '1.0.0')).toBe('untrusted');
});

// ---- browser: the canvas package installed in the app preview ---------------------------------------------------

const scripts = {
  channel: readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8'),
  host: readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../src/extensions/rich-view-client.js', import.meta.url), 'utf8'),
};
function folder(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(join(root, 'canvas'))) files.set(name, readFileSync(join(root, 'canvas', name)));
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
  }, { manifest, enabled: true, icons: {}, executable: { digest: 'preview-panel-only', trusted: true } });
  await page.goto('/?extensions-baseline&rich-assets');
  await expect(page.locator('#prompt')).toBeEnabled();
  for (const permission of ['ui.richViews', 'ui.notify', 'ui.dynamic']) await grant(page, 'grant', permission);
}
const grant = (page: Page, op: 'grant' | 'revoke', permission: string) => page.evaluate(({ op, id, permission }) => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op, id, permission }), { op, id: OWNER, permission });
const slot = (page: Page) => page.locator(`.extension-rich-panel[aria-label="Sketch panel — ${OWNER}"]`);
const sketch = (page: Page): FrameLocator => page.frameLocator(`.extension-rich-panel[aria-label="Sketch panel — ${OWNER}"] iframe`).frameLocator('iframe');
async function open(page: Page) {
  await page.getByRole('button', { name: 'Open sketch', exact: true }).click();
  await expect(sketch(page).locator('#instance')).toHaveText('instance: yes inspector');
}
const host = (page: Page) => page.evaluate(async owner => {
  const pages = (window as any).__panelOnlyPages;
  return { starts: pages.starts(owner) as number, notices: pages.notices(owner) as number, items: pages.items(owner) as number, tracked: pages.tracked() as number, services: await pages.services() as string[] };
}, OWNER);

test('extensions panel only: the canvas package installs, draws, keeps its state and calls the host with no service process', async ({ page }) => {
  await setup(page); await open(page);
  const frame = sketch(page);
  await frame.locator('#stroke').click(); await frame.locator('#stroke').click();
  await expect(frame.locator('#strokes')).toHaveText('strokes: 2');
  // Drawing with the pointer on the canvas.
  const box = (await frame.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + 70); await page.mouse.up();
  await expect(frame.locator('#strokes')).toHaveText('strokes: 3');
  // Reload: the instance and its state come back.
  await slot(page).getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect(frame.locator('#restored')).toHaveText('restored: true');
  await expect(frame.locator('#strokes')).toHaveText('strokes: 3');
  // Calls available in a panel work; messaging and the data directory answer UnsupportedCapability.
  await frame.locator('#notify').click(); await expect(frame.locator('#notified')).toHaveText('notified: ok');
  await frame.locator('#register').click(); await expect(frame.locator('#status')).toHaveText('status: ok');
  await frame.locator('#post').click(); await expect(frame.locator('#message')).toHaveText('message: UnsupportedCapability');
  await frame.locator('#data').click(); await expect(frame.locator('#directory')).toHaveText('directory: UnsupportedCapability');
  const state = await host(page);
  expect(state).toMatchObject({ starts: 0, notices: 1, items: 1, tracked: 1 });
  expect(state.services).not.toContain(OWNER);
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((entry: any) => entry.command));
  expect(calls.filter((command: string) => command.startsWith('extensions_rich_mount_') || command.startsWith('extensions_service_start'))).toEqual([]);
});

test('extensions panel only: disable restores the host, gives the keyboard back to the prompt and ends the page work; safe mode shows nothing', async ({ page }) => {
  await setup(page); await open(page);
  const frame = sketch(page);
  await frame.locator('#notify').click(); await expect(frame.locator('#notified')).toHaveText('notified: ok');
  await page.locator('#prompt').focus();
  await frame.locator('#canvas').click();
  await expect(slot(page).locator('iframe')).toBeFocused();
  await page.evaluate(id => (window as any).__previewDisableExtension(id), OWNER);
  await expect(page.locator('.extension-rich-panel iframe')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open sketch', exact: true })).toHaveCount(0);
  await expect(page.locator('#prompt')).toBeFocused();
  await expect.poll(async () => { const state = await host(page); return [state.notices, state.tracked, state.starts]; }).toEqual([0, 0, 0]);
  await page.goto('/?extensions-baseline&rich-assets&safe-mode');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open sketch', exact: true })).toHaveCount(0);
  await expect(page.locator('.extension-rich-panel')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('extensions panel only: a failed panel gives the keyboard back, and a revoke then ends its work and its kept state', async ({ page }) => {
  await setup(page); await open(page);
  const frame = sketch(page);
  await frame.locator('#stroke').click(); await expect(frame.locator('#strokes')).toHaveText('strokes: 1');
  await frame.locator('#notify').click(); await expect(frame.locator('#notified')).toHaveText('notified: ok');
  await page.locator('#prompt').focus();
  await frame.locator('#fail').click();
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'error');
  await expect(slot(page).locator('iframe')).toHaveCount(0);
  await expect(page.locator('#prompt')).toBeFocused();
  // The work is the package's: it outlives the failed document while the package may show panels.
  expect(await host(page)).toMatchObject({ notices: 1, tracked: 1 });
  await grant(page, 'revoke', 'ui.richViews');
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'PermissionDenied');
  await expect(slot(page).getByRole('button', { name: 'Reload panel', exact: true })).toBeHidden();
  await expect.poll(async () => { const state = await host(page); return [state.notices, state.tracked]; }).toEqual([0, 0]);
  // Granted again: a fresh instance; the failed panel's kept state went with the lifecycle end.
  await grant(page, 'grant', 'ui.richViews');
  await expect(frame.locator('#restored')).toHaveText('restored: false');
  await expect(frame.locator('#strokes')).toHaveText('strokes: 0');
});
