import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The Design canvas module under the app's Content Security Policy, mounted on its own
// with the preview mock as its host: artboards render in script-free sandboxed iframes,
// clicking an element pins a comment, comments save and become an agent prompt, and an
// agent write reloads the artboard.
const errors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

async function mount(page: Page): Promise<void> {
  const runtime: string[] = []; errors.set(page, runtime);
  page.on('pageerror', error => runtime.push(error.message));
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) runtime.push(message.text()); });
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp.replace("connect-src ipc: http://ipc.localhost", "connect-src 'self' ws: ipc: http://ipc.localhost");
  await page.route(url => new URL(url).pathname === '/', async route => {
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Design canvas fixture</title></head><body style="margin:0;--bg:#fff"><section id="design-panel" class="design-panel" aria-label="Design" style="position:fixed;inset:0;background:var(--bg,#fff)"></section></body></html>`,
    });
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { mountDesignCanvas } = await import('/src/design-canvas.ts' as string);
    const { createPreviewDesign } = await import('/src/preview-design.ts' as string);
    const mock = createPreviewDesign();
    const w = window as any;
    w.__design = { mock, calls: [] as string[], composed: '' };
    document.body.innerHTML = '<section id="design-panel" class="design-panel" aria-label="Design" style="position:fixed;inset:0;background:var(--bg,#fff)"></section>';
    const call = async (command: string, args: any) => {
      w.__design.calls.push(command);
      if (command === 'design_list') return mock.list();
      if (command === 'design_read') return mock.read(args.name);
      if (command === 'design_comments') return mock.comments();
      if (command === 'design_save_comments') return mock.saveComments(args.comments);
      throw new Error(`Unexpected ${command}`);
    };
    w.__design.panel = mountDesignCanvas(document.querySelector('#design-panel'), {
      call, notify: (text: string) => { throw new Error(text); },
      context: () => ({ projectId: 'project-1', sessionId: 'session-1' }),
      compose: (prompt: string) => { w.__design.composed = prompt; },
    });
    w.__design.panel.show();
  });
}
const panel = (page: Page) => page.getByRole('region', { name: 'Design', exact: true });
const frame = (page: Page, name: string) => page.frameLocator(`iframe[title="${name}"]`);

test('Design canvas renders artboards in sandboxed, script-free frames at their widths', async ({ page }) => {
  await mount(page);
  await expect(frame(page, 'home.html').getByRole('heading', { name: 'Ship calmer releases' })).toBeVisible();
  await expect(frame(page, 'phone.html').getByText('Deploys')).toBeVisible();
  const frames = page.locator('.design-board iframe');
  await expect(frames).toHaveCount(2);
  for (const f of await frames.all()) await expect(f).toHaveAttribute('sandbox', 'allow-same-origin');
  expect(await page.locator('.design-board').nth(1).evaluate(el => el.style.width)).toBe('390px');
  // The sample comment is pinned on its element.
  await expect(page.locator('.design-mark')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: 'Send 1 comment to agent' })).toBeEnabled();
});

test('Design canvas comments on a clicked element, saves it and sends the prompt', async ({ page }) => {
  await mount(page);
  const title = frame(page, 'home.html').getByRole('heading', { name: 'Ship calmer releases' });
  await expect(title).toBeVisible();
  await panel(page).getByRole('button', { name: 'Comment on an element' }).click();
  const box = (await page.locator('iframe[title="home.html"]').evaluate((f: HTMLIFrameElement) => {
    const r = f.getBoundingClientRect(), t = f.contentDocument!.querySelector('h1')!.getBoundingClientRect(), z = r.width / f.offsetWidth;
    return { x: r.x + (t.x + t.width / 2) * z, y: r.y + (t.y + t.height / 2) * z };
  }));
  await page.mouse.click(box.x, box.y);
  const field = panel(page).getByRole('textbox', { name: 'Comment on #hero-title' });
  await expect(field).toBeFocused();
  await field.fill('Make the title shorter');
  await panel(page).getByRole('button', { name: 'Add comment' }).click();
  await expect(panel(page).getByText('Make the title shorter')).toBeVisible();
  const saved = await page.evaluate(() => (window as any).__design.mock.comments());
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ artboard: 'home.html', selector: '#hero-title', status: 'open', text: 'Make the title shorter' });
  expect(saved[1].bbox.width).toBeGreaterThan(100);
  await panel(page).getByRole('button', { name: 'Send 2 comments to agent' }).click();
  const prompt = await page.evaluate(() => (window as any).__design.composed);
  expect(prompt).toContain('pandacode_design_resolve');
  expect(prompt).toContain('`#hero-title`');
  expect(prompt).toContain('Make the title shorter');
  // Resolving drops it from the prompt and the canvas marks.
  await panel(page).getByRole('button', { name: 'Resolve comment' }).first().click();
  await expect(page.locator('.design-mark')).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: 'Send 1 comment to agent' })).toBeEnabled();
});

test('Design canvas reloads an artboard the agent rewrote, and pans and zooms', async ({ page }) => {
  await mount(page);
  await expect(frame(page, 'home.html').getByText('Ship calmer releases')).toBeVisible();
  await page.evaluate(() => { const d = (window as any).__design; d.mock.write('home.html', '<h1>Revised</h1>'); d.mock.write('new.html', '<p>Fresh</p>'); return d.panel.refresh(); });
  await expect(frame(page, 'home.html').getByText('Revised')).toBeVisible();
  await expect(frame(page, 'new.html').getByText('Fresh')).toBeVisible();
  const zoom = panel(page).getByRole('button', { name: 'Fit artboards' });
  const before = await zoom.textContent();
  await panel(page).getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText(before!);
  const world = page.locator('.design-world');
  const start = await world.evaluate(el => el.style.transform);
  await page.mouse.move(700, 600); await page.mouse.down(); await page.mouse.move(600, 500, { steps: 4 }); await page.mouse.up();
  expect(await world.evaluate(el => el.style.transform)).not.toBe(start);
  // A hidden canvas makes no calls until it is shown again.
  const calls = await page.evaluate(() => { const d = (window as any).__design; d.panel.hide(); d.panel.refresh(); return d.calls.length; });
  expect(await page.evaluate(() => (window as any).__design.calls.length)).toBe(calls);
});

test('Design canvas Shift-scroll pans horizontally across hit targets and zoom levels', async ({ page }) => {
  await mount(page);
  await expect(frame(page, 'home.html').getByText('Ship calmer releases')).toBeVisible();
  const world = page.locator('.design-world');
  const snapshot = () => world.evaluate(el => {
    const matrix = new DOMMatrix(getComputedStyle(el).transform);
    return { x: matrix.e, y: matrix.f, z: Math.hypot(matrix.a, matrix.b) };
  });
  const wheel = (target: 'background' | 'artboard', deltaX: number, deltaY: number, modifiers: string[] = []) =>
    page.locator(target === 'background' ? '.design-viewport' : '.design-hit').first().dispatchEvent('wheel', {
      deltaX, deltaY, bubbles: true, cancelable: true,
      shiftKey: modifiers.includes('Shift'), ctrlKey: modifiers.includes('Control'), metaKey: modifiers.includes('Meta'),
    });

  const initial = await snapshot();
  await wheel('background', 0, 48, ['Shift']);
  const down = await snapshot();
  expect(down.x).toBe(initial.x - 48);
  expect(down.y).toBe(initial.y);
  expect(down.z).toBe(initial.z);
  await wheel('artboard', 0, -31, ['Shift']);
  const up = await snapshot();
  expect(up.x).toBe(down.x + 31);
  expect(up.y).toBe(initial.y);

  // Existing horizontal deltas are consumed once even when Shift is held.
  await wheel('background', 12, 40, ['Shift']);
  const suppliedX = await snapshot();
  expect(suppliedX.x).toBe(up.x - 12);
  expect(suppliedX.y).toBe(up.y);

  // Ordinary two-axis pan keeps its current behavior.
  await wheel('background', 7, 9);
  const ordinary = await snapshot();
  expect(ordinary.x).toBe(suppliedX.x - 7);
  expect(ordinary.y).toBe(suppliedX.y - 9);

  // Ctrl and Meta zoom work with and without Shift; Shift never diverts these gestures into pan.
  await wheel('background', 0, 30, ['Control', 'Shift']);
  const ctrlShift = await snapshot();
  expect(ctrlShift.z).not.toBeCloseTo(ordinary.z);
  await wheel('background', 0, -24, ['Control']);
  const ctrl = await snapshot();
  expect(ctrl.z).not.toBeCloseTo(ctrlShift.z);
  await wheel('background', 0, 30, ['Meta', 'Shift']);
  const metaShift = await snapshot();
  expect(metaShift.z).not.toBeCloseTo(ctrl.z);
  await wheel('background', 0, -24, ['Meta']);
  expect((await snapshot()).z).not.toBeCloseTo(metaShift.z);

  // Change zoom through the real control, then verify horizontal pan keeps that scale and y.
  const beforeZoomButton = await snapshot();
  await panel(page).getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await snapshot();
  expect(zoomed.z).toBeGreaterThan(beforeZoomButton.z);
  await wheel('artboard', 0, 20, ['Shift']);
  const scaledPan = await snapshot();
  expect(scaledPan.x).toBeCloseTo(zoomed.x - 20, 2);
  expect(scaledPan.y).toBeCloseTo(zoomed.y, 2);
  expect(scaledPan.z).toBeCloseTo(zoomed.z, 5);

  // A wheel outside the mounted canvas cannot change its camera.
  const outside = await snapshot();
  await page.locator('.design-comments').dispatchEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true, shiftKey: true });
  expect(await snapshot()).toEqual(outside);
});
