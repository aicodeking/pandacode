import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__toolReplies ??= [];
      window.__toolCalls ??= [];
      window.__toolEmit ??= event => { for (const callback of listeners.get('agent-ui-action') ?? []) callback(event); };
      window.__toolCalls.push({command,args});
      if(command === 'resolve_agent_ui_action') { window.__toolReplies.push(args); return; }
      if(command === 'agent_ui_request_active') {
        window.__toolActiveChecks = (window.__toolActiveChecks || 0) + 1;
        if(window.__toolHoldSecondCheck && window.__toolActiveChecks === 2) await new Promise(resolve => window.__toolRelease = resolve);
        return !window.__toolExpired;
      }
      switch(command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
});

test('agent tools inventory is lazy, distinguishes sample data and keeps task catalog limits visible', async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__toolCalls.some((c: any) => c.command === 'list_agent_integrations'))).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Tools & add-ons', exact: true }).click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tools & integrations' })).toBeVisible();
  await expect(page.getByText('Browser preview · integration status is sample data.')).toBeVisible();
  await page.locator('summary').filter({ hasText: 'PandaCode tools' }).click();
  await expect(page.getByText(/Older tasks keep their original catalog/)).toBeVisible();
  await expect(page.getByText(/When enabled, Jev joins new and resumed tasks across connected harnesses/)).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Preview documentation' }).click();
  await expect(page.getByText('search_docs', { exact: true })).toBeVisible();
});

test('agent tools open browser and return screenshot paths without sending image data through tool replies', async ({ page }) => {
  const emit = async (requestId: string, action: string, args = {}) => {
    await page.evaluate(event => (window as any).__toolEmit(event), { requestId, action, args, sessionId: 'session-1' });
    await expect.poll(() => page.evaluate(id => (window as any).__toolReplies.find((r: any) => r.requestId === id), requestId)).toBeTruthy();
  };
  await emit('open', 'open_browser', { url: 'http://localhost:3000' });
  await expect(page.getByRole('textbox', { name: 'Browser URL' })).toHaveValue('http://localhost:3000/');
  await emit('read', 'read_browser');
  await emit('capture', 'capture_browser');
  const replies = await page.evaluate(() => (window as any).__toolReplies);
  expect(replies.find((r: any) => r.requestId === 'read').result.text).toContain('sample page');
  expect(replies.find((r: any) => r.requestId === 'capture').result).toMatchObject({ path: '/sample/browser-capture.png' });
  expect(replies.find((r: any) => r.requestId === 'capture').result.dataUrl).toBeUndefined();
});

test('agent tools cannot redirect the browser from a hidden task or execute an expired request', async ({ page }) => {
  await page.evaluate(() => (window as any).__toolEmit({ requestId: 'other', sessionId: 'session-2', action: 'open_browser', args: { url: 'https://example.com' } }));
  await expect.poll(() => page.evaluate(() => (window as any).__toolReplies.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__toolReplies[0].error)).toContain('Open this task');
  expect(await page.evaluate(() => (window as any).__toolCalls.some((c: any) => c.command === 'browser_open'))).toBe(false);
  await page.evaluate(() => { (window as any).__toolExpired = true; (window as any).__toolEmit({ requestId: 'old', sessionId: 'session-1', action: 'open_browser', args: { url: 'https://example.com' } }); });
  await expect.poll(() => page.evaluate(() => (window as any).__toolCalls.filter((c: any) => c.command === 'agent_ui_request_active').length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__toolCalls.some((c: any) => c.command === 'browser_open'))).toBe(false);
});

test('agent tools browser script reads bounded page content and performs only the requested interaction', async ({ page }) => {
  const script = readFileSync('src-tauri/src/browser_agent.js', 'utf8');
  await page.setContent('<h1>Example app</h1><p id="long"></p><button id="test:button">Press here</button><input id="name"><input id="secret" type="password" value="private-value"><input id="file" type="file"><input id="locked" readonly>');
  await page.locator('#long').evaluate(el => { el.textContent = 'a'.repeat(30000); });
  await page.evaluate(() => {
    let parent: HTMLElement = document.body;
    for (let i = 0; i < 12; i++) { const node = document.createElement('div'); parent.append(node); parent = node; }
    const button = document.createElement('button'); button.textContent = 'Deeply nested'; parent.append(button);
  });
  const run = (args: object) => page.evaluate(source => JSON.parse(window.eval(source)), script.replace('__PANDACODE_ARGS__', JSON.stringify(args)));
  const snapshot = await run({ action: 'read' });
  expect(snapshot.text.length).toBe(24000);
  expect(JSON.stringify(snapshot)).not.toContain('private-value');
  await expect(page.locator(snapshot.elements.find((entry: any) => entry.label === 'Deeply nested').selector)).toHaveText('Deeply nested');
  const selector = snapshot.elements.find((entry: any) => entry.label === 'Press here').selector;
  await page.evaluate(() => { (window as any).__pressed = 0; document.querySelector('button')!.addEventListener('click', () => (window as any).__pressed++); });
  expect(await run({ action: 'click', selector })).toEqual({ clicked: true });
  expect(await page.evaluate(() => (window as any).__pressed)).toBe(1);
  const text = 'literal "text" with `code` and \\slashes';
  expect(await run({ action: 'type', selector: '#name', text })).toEqual({ typed: true });
  await expect(page.locator('#name')).toHaveValue(text);
  expect((await run({ action: 'type', selector: '#file', text: '/private/path' })).error).toContain('text input');
  expect((await run({ action: 'type', selector: '#locked', text: 'no' })).error).toContain('read only');
});

test('agent tools recheck the visible task after awaiting native approval state', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__toolHoldSecondCheck = true;
    (window as any).__toolEmit({ requestId: 'switching', sessionId: 'session-1', action: 'open_browser', args: { url: 'https://example.com' } });
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__toolRelease))).toBe(true);
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.evaluate(() => (window as any).__toolRelease());
  await expect.poll(() => page.evaluate(() => (window as any).__toolReplies.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__toolReplies[0].error)).toContain('visible task');
  expect(await page.evaluate(() => (window as any).__toolCalls.some((c: any) => c.command === 'browser_open'))).toBe(false);
});

test('agent tools do not take over the board when the task panel is closed', async ({ page }) => {
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.evaluate(() => (window as any).__toolEmit({ requestId: 'board', sessionId: 'session-1', action: 'open_browser', args: { url: 'https://example.com' } }));
  await expect.poll(() => page.evaluate(() => (window as any).__toolReplies.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__toolReplies[0].error)).toContain('Open this task');
  expect(await page.evaluate(() => (window as any).__toolCalls.some((c: any) => c.command === 'browser_open'))).toBe(false);
});
