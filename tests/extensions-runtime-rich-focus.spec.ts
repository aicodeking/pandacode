import { test, expect, type Frame, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { validateContract } from '../src/extensions/contracts';
import { EVICTED, FOCUS_EVENT, GRACE_MS, RETAINED_LIMIT, Retention, minSize, parseForward, sized, titleSignal } from '../src/extensions/runtime-rich-focus';

// PREVIEW column of R0304. The Node checks drive `src/extensions/runtime-rich-focus.ts` (the twin of the native
// `rich_views::runtime_rich_focus`) over the shared table `tests/fixtures/extensions/runtime-rich-focus/forwarding.json`
// and run the real `rich-view-client.js` in a VM; the browser checks mount the canonical `sample.rich-mount` panel as
// the preview's sandboxed frame. Kept-alive hidden documents, the native tab stop and the shell's own minimum size are
// installed behaviour (`runtime_rich_focus::tests`, installed qualification pending); none of this stands for them.
const table = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-focus/forwarding.json', import.meta.url), 'utf8')) as {
  session: string; cases: { name: string; request: unknown; forward: 'release' | 'key' | null }[];
  titles: { title: string; forward: 'release' | 'key' | null; key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }[];
};
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-focus/extension.json', import.meta.url), 'utf8'));
const scripts = {
  channel: readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../src/extensions/rich-view-client.js', import.meta.url), 'utf8'),
  host: readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8'),
};
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

test('extensions rich focus: the fixture is valid and the twin keeps the native limits', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  const native = readFileSync(new URL('../src-tauri/src/extensions/runtime_rich_focus.rs', import.meta.url), 'utf8');
  expect(native).toContain(`pub const RETAINED_LIMIT: usize = ${RETAINED_LIMIT};`);
  expect(native).toContain(`pub const GRACE: Duration = Duration::from_millis(${GRACE_MS});`);
  expect(native).toContain(`pub const FOCUS_EVENT: &str = "${FOCUS_EVENT}";`);
  expect(native).toContain(`pub const EVICTED: &str = "${EVICTED}";`);
  expect([RETAINED_LIMIT, GRACE_MS]).toEqual([4, 250]);
  // The module is declared once, beside the other panel modules (never in mod.rs too).
  const views = readFileSync(new URL('../src-tauri/src/extensions/rich_views.rs', import.meta.url), 'utf8');
  const hub = readFileSync(new URL('../src-tauri/src/extensions/mod.rs', import.meta.url), 'utf8');
  expect(views).toContain('#[path = "runtime_rich_focus.rs"]');
  expect(hub).not.toContain('runtime_rich_focus');
});

test('extensions rich focus: only Escape and command chords the page left alone are forwarded, as closed shapes', () => {
  for (const item of table.cases) {
    if (item.forward === null) expect(() => parseForward(item.request, table.session), item.name).toThrow('InvalidShape');
    else expect(parseForward(item.request, table.session).kind, item.name).toBe(item.forward);
  }
  expect(parseForward(table.cases[3].request, table.session)).toEqual({ kind: 'key', key: 'b', code: 'KeyB', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
  for (const item of table.titles) {
    const parsed = titleSignal(item.title);
    if (item.forward === null) { expect(parsed, item.title).toBeUndefined(); continue; }
    expect(parsed?.[1].kind, item.title).toBe(item.forward);
    if (item.forward === 'key') expect(parsed?.[1], item.title).toEqual({ kind: 'key', key: item.key, code: item.code, ctrlKey: item.ctrlKey, metaKey: item.metaKey, shiftKey: item.shiftKey, altKey: item.altKey });
  }
});

test('extensions rich focus: five hidden instances keep four alive and close the least recently shown', () => {
  const views: string[] = manifest.contributes.views.map((view: { id: string }) => view.id);
  expect(views).toHaveLength(5);
  const retention = new Retention();
  const evicted = views.flatMap((view, index) => retention.park(`extension-panel-${index}`, `main:${view}`));
  expect(evicted).toEqual(['extension-panel-0']);
  expect(retention.parked).toEqual(['extension-panel-1', 'extension-panel-2', 'extension-panel-3', 'extension-panel-4']);
  // Shown again: visible panels are not counted; the evicted one comes back as a fresh document restored from state.
  expect([retention.resume('extension-panel-2'), retention.isParked('extension-panel-2'), retention.resume('extension-panel-0')]).toEqual([true, false, false]);
  expect(retention.park('extension-panel-5', `main:${views[0]}`)).toEqual([]);
  // A second mount of one slot replaces its older park.
  expect(retention.park('extension-panel-6', `main:${views[0]}`)).toEqual(['extension-panel-5']);
  expect(retention.parked.length).toBeLessThanOrEqual(RETAINED_LIMIT);
});

test('extensions rich focus: rich.minSize reaches the shell with the inspector defaults and the schema bounds', () => {
  expect(manifest.contributes.views.map((view: { rich: Parameters<typeof minSize>[0] }) => minSize(view.rich))).toEqual([
    { width: 320, height: 240 }, { width: 2000, height: 160 }, { width: 160, height: 240 }, { width: 480, height: 360 }, { width: 160, height: 200 },
  ]);
  expect(minSize({ minSize: { width: 9000, height: 24 } })).toEqual({ width: 2000, height: 160 });
  expect(sized('data:text/html;base64,AAAA#old', { width: 320, height: 240 })).toBe('data:text/html;base64,AAAA#panda-min=320x240');
  // The shell reads that fragment, keeps the frame's minimum and scrolls; nothing animates.
  expect(scripts.host).toContain('panda-min=');
  expect(scripts.host).not.toMatch(/transition|animate\(/);
});

/** The real client in a VM: what it sends its shell for each key-down, after the page's own listeners. */
function client(platform = 'Win32') {
  const listeners = new Map<string, (event: any) => void>(), sent: any[] = [];
  const parent = { postMessage: (message: any) => sent.push(message) };
  const context: Record<string, any> = {
    TextEncoder, URL, setTimeout, navigator: { platform, userAgent: '' },
    parent, addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback), removeEventListener() {},
    document: { getElementById: () => null, currentScript: { dataset: { pandaSession: 's' }, src: 'http://pandapanel.p00000000000000000000000000000000.localhost/~panda/client.js' }, documentElement: { dataset: {} }, activeElement: null },
  };
  context.window = context;
  runInNewContext(`${scripts.channel}\n${scripts.client}`, context);
  /** A key-down; `page` runs as the page's own listener after the client's (it may call preventDefault). */
  const key = (init: Record<string, unknown>, page?: (event: any) => void) => {
    const event: any = { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    listeners.get('keydown')!(event); page?.(event);
  };
  return { view: context.pandaView, sent: () => sent.filter(message => message.kind === 'key' || message.kind === 'release'), key };
}

test('extensions rich focus: the client forwards what the page left alone, never IME keys, and releaseFocus asks the host', async () => {
  const { view, sent, key } = client();
  key({ key: 'b', code: 'KeyB', ctrlKey: true });
  key({ key: 's', code: 'KeyS', ctrlKey: true }, event => event.preventDefault());
  key({ key: 'Escape', code: 'Escape' });
  key({ key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true });
  key({ key: 'Enter', code: 'Enter', keyCode: 229, ctrlKey: true });
  key({ key: 'Escape', code: 'Escape', isComposing: true });
  key({ key: 'a', code: 'KeyA' });
  key({ key: 'ArrowDown', code: 'ArrowDown' });
  key({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
  key({ key: 'b', code: 'KeyB', metaKey: true });
  await settle();
  expect(sent()).toEqual([
    { schemaVersion: 1, session: 's', kind: 'key', key: 'b', code: 'KeyB', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
    { schemaVersion: 1, session: 's', kind: 'key', key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
  ]);
  // Every forwarded request is a shape the host accepts.
  for (const request of sent()) expect(() => parseForward(request, 's')).not.toThrow();
  expect(typeof view.releaseFocus).toBe('function');
  view.releaseFocus();
  expect(sent().at(-1)).toEqual({ schemaVersion: 1, session: 's', kind: 'release' });
  // On macOS the command modifier is Cmd.
  const mac = client('MacIntel');
  mac.key({ key: 'b', code: 'KeyB', ctrlKey: true });
  mac.key({ key: 'b', code: 'KeyB', metaKey: true });
  await settle();
  expect(mac.sent().map(request => [request.ctrlKey, request.metaKey])).toEqual([[false, true]]);
});

// ---- browser: the canonical mounted panel as the preview's frame -------------------------------------------------

const rich = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-mount/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page) {
  await page.addInitScript(seed => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([seed]));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, { manifest: rich, enabled: true, icons: {}, executable: { digest: 'preview-rich-mount', trusted: true } });
  await page.goto('/?extensions-baseline&rich-mount');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(() => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op: 'grant', id: 'sample.rich-mount', permission: 'ui.richViews' }));
}
const slot = (page: Page) => page.locator('.extension-rich-panel');
const board = (page: Page) => page.frameLocator('.extension-rich-panel iframe').frameLocator('iframe').locator('#board');
async function openBoard(page: Page) {
  await page.getByRole('button', { name: 'Open mounted board', exact: true }).click();
  await expect(board(page)).toHaveText('sample.rich-mount 1.0.0: Mounted board');
}
/** The package's document (the frame inside the shell). */
const inner = (page: Page): Frame => page.frames().find(frame => frame.parentFrame() !== null && frame.parentFrame()!.parentFrame() === page.mainFrame())!;
const panelFocused = (page: Page) => expect(slot(page).locator('iframe')).toBeFocused();

test('extensions rich focus: keyboard enters and leaves the panel; Escape and releaseFocus restore the control that had focus', async ({ page }) => {
  await setup(page); await openBoard(page);
  // Tab from the control before the panel enters it (a preview frame is one tab stop); Escape returns there.
  const before = page.locator('.extension-inspector-view').getByRole('button', { name: 'Open isolated extension window', exact: true });
  await before.focus();
  await page.keyboard.press('Tab');
  await panelFocused(page);
  await page.keyboard.press('Escape');
  await expect(before).toBeFocused();
  // Clicking the panel gives it focus; Escape gives it back to the prompt that had it.
  await page.locator('#prompt').focus();
  await board(page).click();
  await panelFocused(page);
  // Arrow keys and printable keys stay in the page.
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('a');
  await panelFocused(page);
  await expect(page.locator('#prompt')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#prompt')).toBeFocused();
  // An Escape of an input-method composition stays in the page; a plain one is forwarded.
  await board(page).click();
  await inner(page).evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(150);
  await panelFocused(page);
  await inner(page).evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
  await expect(page.locator('#prompt')).toBeFocused();
  // releaseFocus from the page's code.
  await board(page).click();
  await panelFocused(page);
  await inner(page).evaluate(() => (window as any).pandaView.releaseFocus());
  await expect(page.locator('#prompt')).toBeFocused();
  await expect(page.locator('#prompt')).toHaveValue('');
});

test('extensions rich focus: an unhandled host chord still works from the panel and a handled one stays in the page', async ({ page }) => {
  await setup(page); await openBoard(page);
  const collapsed = () => page.evaluate(() => localStorage.getItem('pandacode.sidebarCollapsed'));
  const start = await collapsed();
  await board(page).click();
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(collapsed).not.toBe(start);
  const toggled = await collapsed();
  // The page keeps a chord it handles.
  await inner(page).evaluate(() => addEventListener('keydown', event => { if (event.code === 'KeyB') event.preventDefault(); }));
  await board(page).click();
  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(200);
  expect(await collapsed()).toBe(toggled);
  // A chord of an input-method composition is never pressed in the app.
  await inner(page).evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true, isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(150);
  await panelFocused(page);
});

test('extensions rich focus: the panel keeps rich.minSize in a smaller slot by scrolling, and nothing animates layout', async ({ page }) => {
  await setup(page); await openBoard(page);
  const frame = slot(page).locator('iframe');
  const sizes = async () => { const box = await frame.boundingBox(); return [Math.round(box!.width), Math.round(box!.height)]; };
  const [width, height] = await sizes();
  expect(width).toBeGreaterThanOrEqual(320); expect(height).toBeGreaterThanOrEqual(240);
  await page.setViewportSize({ width: 640, height: 420 });
  const [narrow, low] = await sizes();
  expect(narrow).toBeGreaterThanOrEqual(320); expect(low).toBeGreaterThanOrEqual(240);
  const styles = await slot(page).evaluate(element => [element, element.querySelector('.extension-rich-panel-surface')!, element.querySelector('iframe')!].map(node => {
    const style = getComputedStyle(node); return { duration: style.transitionDuration, property: style.transitionProperty, overflow: style.overflow, animation: style.animationName };
  }));
  expect(styles[0].overflow).toBe('auto');
  for (const style of styles) {
    expect(style.animation).toBe('none');
    if (style.duration.split(',').some(value => parseFloat(value) > 0)) expect(style.property).not.toMatch(/all|width|height|top|left|inset|grid/);
  }
});

test('extensions rich focus: a hidden preview panel leaves no frame behind and comes back mounted after five switches', async ({ page }) => {
  await setup(page); await openBoard(page);
  const other = page.locator('.inspector-tab:not([hidden]):not([data-view="sample.rich-mount/board"]) > .inspector-tab-button').first();
  for (let round = 0; round < 5; round += 1) {
    await other.click();
    await expect(page.locator('.extension-rich-panel iframe')).toHaveCount(0);
    await openBoard(page);
    await expect(page.locator('iframe')).toHaveCount(1);
  }
  // Focus survives what the host keeps: after the switches the panel still enters and leaves by keyboard.
  await page.locator('#prompt').focus();
  await board(page).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#prompt')).toBeFocused();
});
