import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function mount(page: import('@playwright/test').Page, handlers: { open?: (body: any) => any } = {}) {
  await page.goto('/?web');
  await page.evaluate(() => { document.cookie = 'pandacode_csrf=fixture-csrf'; });
  await page.route('**/api/pandacode/browser/open', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: handlers.open?.(body) ?? { lease: 'lease-fixture', url: body.url, title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } });
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/pandacode/browser/lease-fixture/status', route => route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }));
  await page.route('**/api/pandacode/browser/lease-fixture/frame', route => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-browser-width': '1', 'x-browser-height': '1', 'x-browser-sequence': '1' }, body: png }));
  await page.route('**/api/pandacode/browser/lease-fixture/input', route => route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }));
  await page.route('**/api/pandacode/browser/lease-fixture', route => route.fulfill({ status: 204 }));
  await page.evaluate(async () => {
    const { mountWebBrowser } = await import('/src/web-browser.ts');
    const host = document.createElement('main'); host.id = 'browser-fixture'; document.body.append(host);
    (window as any).__browser = await mountWebBrowser(host, { task: () => 'task-1', session: () => 'session-1', attach: (task: string, attachment: unknown) => ((window as any).__attachments ??= []).push({ task, attachment }), close: () => { (window as any).__closed = true; } });
  });
}

test('browser adapter sends authenticated finite actions and preserves schemas', async ({ page }) => {
  const requests: any[] = [];
  page.on('request', request => { if (request.url().includes('/browser/lease-fixture/input')) requests.push({ headers: request.headers(), body: request.postDataJSON() }); });
  await mount(page);
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter');
  await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.getByRole('button', { name: 'Scroll down' }).click({ force: true }); await page.getByRole('button', { name: 'Enter' }).click({ force: true });
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  expect(requests.some(r => r.body?.kind === 'scroll' && r.body.deltaY === 720)).toBe(true);
  expect(requests.some(r => r.body?.kind === 'key' && r.body.key === 'Enter')).toBe(true);
  expect(requests.every(r => r.headers['x-csrf-token'] === 'fixture-csrf' && r.headers['x-request-id'])).toBe(true);
});

test('browser adapter types IME text, attaches inspected elements, and revokes frame URLs', async ({ page }) => {
  let revoked = 0;
  await page.addInitScript(() => { const original = URL.revokeObjectURL; (window as any).__revoked = 0; URL.revokeObjectURL = value => { (window as any).__revoked++; original.call(URL, value); }; });
  await page.route('**/api/pandacode/browser/lease-fixture/inspect', route => route.fulfill({ json: { element: { url: 'https://example.com', title: 'Fixture', selector: '#name', tag: 'input', text: '', html: '<input>', bounds: { x: 1, y: 2, width: 3, height: 4 } } } }));
  await mount(page);
  await page.route('**/api/pandacode/files/upload', route => route.fulfill({ json: { grant: 'grant-browser-png', name: 'browser.png' } }));
  await page.route('**/api/pandacode/commands/import_prompt_image', route => route.fulfill({ json: { id: 'registered-image-1', width: 1, height: 1 } }));
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter');
  await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.locator('[data-web-browser-text]').fill('こんにちは'); await page.getByRole('button', { name: 'Send text' }).click(); await page.getByRole('button', { name: 'Attach screenshot' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__attachments?.length ?? 0)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__attachments[0].attachment.id)).toBeTruthy();
  await page.evaluate(() => (window as any).__browser.close());
  revoked = await page.evaluate(() => (window as any).__revoked); expect(revoked).toBe(0);
});

test('browser screenshot uploads PNG bytes before importing and attaches the registered id', async ({ page, browserName }) => {
  const uploads: { body: number; purpose: string; name: string }[] = [];
  const imports: any[] = [];
  await mount(page);
  await page.route('**/api/pandacode/files/upload', async route => {
    const request = route.request();
    uploads.push({ body: request.postDataBuffer()?.byteLength ?? request.postData()?.length ?? Number(request.headers()['content-length'] ?? 0), purpose: request.headers()['x-file-purpose'], name: request.headers()['x-file-name'] });
    await route.fulfill({ json: { grant: 'grant-browser-png', name: 'browser.png' } });
  });
  await page.route('**/api/pandacode/commands/import_prompt_image', async route => {
    const body = route.request().postDataJSON(); imports.push(body);
    await route.fulfill({ json: { id: 'registered-image-42', width: 1, height: 1 } });
  });
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.getByRole('button', { name: 'Attach screenshot' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__attachments?.length ?? 0)).toBe(1);
  expect(uploads).toHaveLength(1); if (browserName === 'chromium') expect(uploads[0].body).toBeGreaterThan(32); expect(uploads[0].purpose).toBe('attachment');
  expect(imports).toEqual([{ path: 'grant-browser-png', name: 'browser.png' }]);
  expect(await page.evaluate(() => (window as any).__attachments[0].attachment.id)).toBe('registered-image-42');
});

test('browser screenshot import failure does not attach an unregistered image', async ({ page }) => {
  await mount(page);
  await page.route('**/api/pandacode/files/upload', route => route.fulfill({ json: { grant: 'grant-browser-png', name: 'browser.png' } }));
  await page.route('**/api/pandacode/commands/import_prompt_image', route => route.fulfill({ status: 502, body: 'import failed' }));
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.getByRole('button', { name: 'Attach screenshot' }).click();
  await page.waitForTimeout(250); expect(await page.evaluate(() => (window as any).__attachments?.length ?? 0)).toBe(0);
  await expect(page.locator('[data-web-browser-status]')).toContainText('Gateway request failed (502)');
});

test('IME composition suppresses Enter until compositionend', async ({ page }) => {
  const inputs: any[] = [];
  page.on('request', request => { if (request.url().includes('/browser/lease-fixture/input')) inputs.push(request.postDataJSON()); });
  await mount(page); await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  const input = page.locator('[data-web-browser-text]'); await input.fill('かな');
  await input.dispatchEvent('compositionstart'); await input.press('Enter'); await page.waitForTimeout(50); expect(inputs.some(item => item.kind === 'type' || item.kind === 'key')).toBe(false);
  await input.dispatchEvent('compositionend'); await input.press('Enter'); await expect.poll(() => inputs.some(item => item.kind === 'type' && item.text === 'かな')).toBe(true);
});

test('Jev watch uses the existing live renderer and returns to the remote browser', async ({ page }) => {
  const report = { id: 'jev-run-1', sessionId: 'session-1', url: 'https://example.com', goal: 'Check the page', viewport: 'desktop', status: 'done', verification: 'not_checked', summary: 'Finished', createdAt: Date.now(), durationMs: 100, steps: 1, checks: [], events: [] };
  await page.route('**/api/pandacode/commands/jev_list_runs', route => route.fulfill({ json: [report] }));
  await mount(page);
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.evaluate(() => (window as any).__browser.watchJev('jev-run-1'));
  await expect(page.getByRole('region', { name: 'Jev live browser' })).toBeVisible();
  await expect(page.locator('.web-browser-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Return to browser' }).click();
  await expect(page.getByRole('region', { name: 'Jev live browser' })).toBeHidden(); await expect(page.locator('.web-browser-panel')).toBeVisible();
});

test('browser input is FIFO and waits for the first acknowledgement', async ({ page }) => {
  const sent: any[] = []; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await mount(page); await page.route('**/api/pandacode/browser/lease-fixture/input', async route => { sent.push(route.request().postDataJSON()); if (sent.length === 1) { await held; await route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }); } else await route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }); }); await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.locator('[data-web-browser-text]').fill('first'); await page.getByRole('button', { name: 'Send text' }).click({ force: true }); await page.getByRole('button', { name: 'Enter' }).click({ force: true });
  await page.waitForTimeout(100); expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ kind: 'type', text: 'first' }); release(); await expect.poll(() => sent).toHaveLength(2); expect(sent[1]).toMatchObject({ kind: 'key', key: 'Enter' });
});

test('failed browser input closes the delivery chain without replaying queued input', async ({ page }) => {
  const sent: any[] = []; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await mount(page); await page.route('**/api/pandacode/browser/lease-fixture/input', async route => { sent.push(route.request().postDataJSON()); if (sent.length === 1) { await held; await route.fulfill({ status: 504, body: 'timeout' }); } else await route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }); }); await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.locator('[data-web-browser-text]').fill('uncertain'); await page.getByRole('button', { name: 'Send text' }).click({ force: true }); await page.getByRole('button', { name: 'Enter' }).click({ force: true }); await page.waitForTimeout(100); expect(sent).toHaveLength(1); release(); await expect(page.locator('[data-web-browser-status]')).toContainText('uncertain'); await page.waitForTimeout(100); expect(sent).toHaveLength(1);
});

test('delayed navigation followed by close does not leak a stale lease', async ({ page }) => {
  let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; }); let deletes = 0;
  await page.route('**/api/pandacode/browser/open', async route => { await delayed; await route.fulfill({ json: { lease: 'late-lease', url: 'https://example.com', title: '', loading: false, canGoBack: false, canGoForward: false, picking: false } }); });
  await page.route('**/api/pandacode/browser/late-lease', async route => { if (route.request().method() === 'DELETE') deletes++; await route.fulfill({ status: 204 }); });
  await page.goto('/?web'); await page.evaluate(() => { document.cookie = 'pandacode_csrf=fixture-csrf'; });
  await page.evaluate(async () => { const { mountWebBrowser } = await import('/src/web-browser.ts'); const host = document.createElement('main'); document.body.append(host); (window as any).__browser = await mountWebBrowser(host, { task: () => 'task', attach: () => {}, close: () => {} }); });
  const pending = page.evaluate(() => (window as any).__browser.navigate('https://example.com').catch(() => {})); await page.evaluate(() => (window as any).__browser.close()); release(); await pending; await expect.poll(() => deletes).toBe(1);
});

test('oversized and stalled frames fail closed', async ({ page }) => {
  await mount(page);
  await page.route('**/api/pandacode/browser/lease-fixture/frame', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(8 * 1024 * 1024 + 1) }));
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter');
  await expect(page.locator('[data-web-browser-status]')).toContainText('exceeds limit');
});

test('wheel, touch, and coordinate picker use bounded input contracts', async ({ page }) => {
  const requests: any[] = [];
  let picked: any;
  await page.route('**/api/pandacode/browser/lease-fixture/input', async route => { await route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }); });
  page.on('request', request => { if (request.url().includes('/browser/lease-fixture/input')) requests.push(request.postDataJSON()); });
  await page.route('**/api/pandacode/browser/lease-fixture/pick', route => route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', selector: '#picked', tag: 'button', text: 'Pick', html: '<button>Pick</button>', bounds: { x: 1, y: 2, width: 3, height: 4 } } }));
  page.on('request', request => { if (request.url().includes('/browser/lease-fixture/pick')) picked = request.postDataJSON(); });
  await mount(page); await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter');
  await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  await page.locator('[data-web-browser-frame]').dispatchEvent('wheel', { deltaX: 0, deltaY: 10000 }); await page.waitForTimeout(75);
  await page.getByRole('button', { name: 'Pick element' }).click({ force: true }); await page.locator('[data-web-browser-frame]').dispatchEvent('click', { clientX: 20, clientY: 20 });
  await expect.poll(() => requests.some(item => item.kind === 'scroll' && Math.abs(item.deltaY) <= 2000)).toBe(true);
  await expect.poll(() => picked).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  expect(picked.x).toBeGreaterThanOrEqual(0); expect(picked.x).toBeLessThanOrEqual(1); expect(picked.y).toBeGreaterThanOrEqual(0); expect(picked.y).toBeLessThanOrEqual(1);
});

test('touch pan does not synthesize a tap after scrolling', async ({ page }) => {
  const inputs: any[] = [];
  await mount(page); await page.route('**/api/pandacode/browser/lease-fixture/input', async route => { const body = route.request().postDataJSON(); inputs.push(body); await route.fulfill({ json: { url: 'https://example.com', title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, picking: false } }); });
  await page.locator('[data-web-browser-address] input').fill('example.com'); await page.locator('[data-web-browser-address]').press('Enter'); await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
  const frame = page.locator('[data-web-browser-frame]');
  await frame.evaluate(element => {
    // Exercise the same TouchList fields on engines that lack a desktop Touch constructor.
    for (const [type, touches] of [
      ['touchstart', [{ identifier: 1, clientX: 100, clientY: 100 }]],
      ['touchmove', [{ identifier: 1, clientX: 100, clientY: 40 }]],
      ['touchend', []],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      element.dispatchEvent(event);
    }
  });
  await frame.dispatchEvent('click', { clientX: 20, clientY: 20 });
  await expect.poll(() => inputs.some(input => input.kind === 'scroll')).toBe(true);
  expect(inputs.some(input => input.kind === 'tap')).toBe(false);
  await page.waitForTimeout(850);
  await frame.dispatchEvent('click', { clientX: 20, clientY: 20 }); await expect.poll(() => inputs.some(input => input.kind === 'tap')).toBe(true);
});

test('browser panel remains usable at iPad and narrow mobile widths', async ({ page }) => {
  for (const viewport of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await mount(page);
    await page.route('**/api/pandacode/files/upload', route => route.fulfill({ json: { grant: 'grant-browser-png', name: 'browser.png' } }));
    await page.route('**/api/pandacode/commands/import_prompt_image', route => route.fulfill({ json: { id: `registered-${viewport.width}`, width: 1, height: 1 } }));
    const address = page.locator('[data-web-browser-address] input');
    await address.fill('example.com');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('[data-web-browser-frame]')).toBeVisible();
    const frame = page.locator('[data-web-browser-frame]');
    const frameBox = await frame.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(Math.abs((frameBox!.width / frameBox!.height) - 1)).toBeLessThan(0.05);
    await page.locator('[data-web-browser-text]').fill('mobile text');
    await page.getByRole('button', { name: 'Send text' }).click();
    await page.getByRole('button', { name: 'Scroll down' }).click();
    await page.getByRole('button', { name: 'Attach screenshot' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__attachments?.length ?? 0)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => (window as any).__browser.close());
  }
});

test('native browser script deletes emoji without leaving an invalid UTF-16 value', async ({ page }) => {
  const inputScript = await readFile(new URL('../src-tauri/src/browser/remote_agent.js', import.meta.url), 'utf8');
  const inspectScript = await readFile(new URL('../src-tauri/src/browser_agent.js', import.meta.url), 'utf8');
  const run = async (args: Record<string, unknown>) => {
    const result = await page.evaluate(inputScript.replace('__PANDACODE_ARGS__', JSON.stringify(args)));
    expect(JSON.parse(String(result))).toEqual({ ok: true });
  };
  const read = async () => JSON.parse(String(await page.evaluate(inspectScript.replace('__PANDACODE_ARGS__', JSON.stringify({ action: 'read', selector: '', text: '' })))));

  await page.setContent('<!doctype html><meta charset="utf-8"><input id="name"><output id="echo"></output>');
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#name')!;
    input.addEventListener('input', () => { document.querySelector<HTMLOutputElement>('#echo')!.textContent = `Value: ${input.value}`; });
    // Reproduce the WebKitGTK fault that positioned the caret between the two
    // UTF-16 code units after setRangeText inserted a supplementary character.
    const native = HTMLInputElement.prototype.setRangeText;
    HTMLInputElement.prototype.setRangeText = function (...args) {
      native.apply(this, args as Parameters<HTMLInputElement['setRangeText']>);
      if (args[0] === '🐼') this.setSelectionRange(this.value.length - 1, this.value.length - 1);
    };
    input.focus();
  });

  await run({ kind: 'type', text: 'alpha beta' });
  await run({ kind: 'key', key: 'End', shift: false });
  await run({ kind: 'key', key: 'Backspace', shift: false });
  await run({ kind: 'type', text: '🐼' });
  expect((await read()).text).toContain('alpha bet🐼');
  await run({ kind: 'key', key: 'Backspace', shift: false });
  await run({ kind: 'type', text: 'a' });

  const state = await page.evaluate(() => {
    const value = document.querySelector<HTMLInputElement>('#name')!.value;
    let paired = true;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const following = value.charCodeAt(++i);
        if (!(following >= 0xdc00 && following <= 0xdfff)) paired = false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) paired = false;
    }
    return { value, paired };
  });
  expect(state).toEqual({ value: 'alpha beta', paired: true });
  expect((await read()).text).toContain('Value: alpha beta');
});
