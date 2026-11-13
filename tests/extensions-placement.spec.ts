import { test, expect, type Page } from '@playwright/test';
import manifest from './fixtures/extensions/data-panel/extension.json' with { type: 'json' };
const key = 'pandacode.extensions.placement.v1';
async function open(page: Page, extension = false, running = false) {
  await page.addInitScript(({ manifest, extension, running }) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: running };
    if (extension) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
    for (const type of ['dragover', 'drop']) window.addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
  }, { manifest, extension, running });
  await page.goto('/?extensions-baseline&data-panel'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  const region = page.getByRole('region', { name: 'Surface explorer' }); await expect(region.getByRole('button', { name: 'Move Composer to Inspector', exact: true })).toBeVisible(); return region;
}
async function back(page: Page) { await page.getByRole('button', { name: 'Back to the workspace' }).click(); }
test('extensions placement: keyboard and pointer use identical persisted placement with native drag discarded', async ({ page }) => {
  await open(page); const region = await explorer(page);
  await region.getByRole('button', { name: 'Restore built-in view placement' }).click();
  await region.getByRole('button', { name: 'Move Composer to Inspector', exact: true }).focus(); await page.keyboard.press('Enter');
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  await expect(page.locator('#inspector #composer-area')).toHaveCount(1);
  await region.getByRole('button', { name: 'Restore built-in view placement' }).click();
  const source = region.locator('[data-placement-view="panda.views/composer"]');
  const target = region.locator('[data-placement-target="panda.containers/inspector"]');
  await source.scrollIntoViewIfNeeded(); const a = (await source.boundingBox())!;
  await target.scrollIntoViewIfNeeded(); await source.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + 15, a.y + 10); await page.mouse.down(); await page.mouse.move(a.x + 65, a.y + 12, { steps: 5 });
  await expect(target).toHaveAttribute('data-compatible', '');
  await page.mouse.move(b.x + 15, b.y + 10, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('#inspector #composer-area')).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(saved);
  await page.reload(); await expect(page.locator('#inspector #composer-area')).toHaveCount(1);
});
test('extensions placement: E17 same running PTY, draft undo, attachments, queue and active stream survive move/hide/restore', async ({ page }) => {
  await open(page, false, true);
  await page.locator('#prompt').fill('Start held run'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.locator('#prompt').fill('Queued follow-up'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('.queue-text')).toHaveText('Queued follow-up');
  await page.getByRole('button', { name: 'Attach files for context' }).click(); await page.getByRole('menuitem', { name: /Attach files…/ }).click();
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
  await page.locator('#prompt').pressSequentially('Live undo draft');
  await page.locator('#prompt').press('ControlOrMeta+z'); await expect(page.locator('#prompt')).not.toHaveValue('Live undo draft');
  await page.locator('#prompt').press('ControlOrMeta+Shift+z'); await expect(page.locator('#prompt')).toHaveValue('Live undo draft');
  await page.locator('#terminal-toggle').click(); await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  const prompt = await page.locator('#prompt').elementHandle(), terminal = await page.locator('#terminal-host .xterm-screen').elementHandle();
  let region = await explorer(page);
  for (const view of ['Composer', 'Terminal']) {
    await region.getByRole('button', { name: `Move ${view} to Inspector`, exact: true }).click();
  }
  await back(page);
  await expect(page.locator('#inspector #prompt')).toBeVisible(); await expect(page.locator('#inspector #terminal-host .xterm-screen')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Live undo draft');
  region = await explorer(page);
  for (const view of ['Composer', 'Terminal']) {
    await region.getByRole('button', { name: `Hide ${view}`, exact: true }).click();
  }
  await back(page); await expect(page.locator('#prompt')).toBeHidden(); await expect(page.locator('#terminal-host')).toBeHidden();
  // A hidden presentation still receives the same core event stream.
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'text', text: 'Streaming while moved.' }));
  await expect(page.locator('#transcript')).toContainText('Streaming while moved.');
  region = await explorer(page);
  await region.getByRole('button', { name: 'Restore built-in view placement' }).click(); await back(page);
  await expect(page.locator('#prompt')).toHaveValue('Live undo draft');
  expect(await prompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await terminal!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  await page.locator('#prompt').press('ControlOrMeta+z'); await expect(page.locator('#prompt')).not.toHaveValue('Live undo draft');
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2); await expect(page.locator('.queue-text')).toHaveText('Queued follow-up');
  await page.locator('#terminal-host .xterm-helper-textarea').pressSequentially('echo alive');
  // xterm delivers input asynchronously; keyboard completion is not transport completion.
  // Keep the exact once-only payload assertion, waiting for the observable host call.
  await expect.poll(() => page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === 'write_terminal').map((call: any) => call.args.data).join(''))).toBe('echo alive');
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.filter((call: any) => call.command === 'start_terminal')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'send_message')).toHaveLength(1);
  expect(calls.filter((call: any) => ['close_terminal', 'cancel_session', 'delete_session'].includes(call.command))).toEqual([]);
  expect(calls.filter((call: any) => call.command === 'write_terminal').map((call: any) => call.args.data).join('')).toBe('echo alive');
});
test('extensions placement: removed owner/destination recovers home and focus without erasing dormant intent; corruption retains last valid', async ({ page }) => {
  await open(page, true);
  await page.getByRole('button', { name: 'Open data panel', exact: true }).click();
  await expect(page.locator('.inspector-tab[data-view="sample.data-panel/overview"] [role="tab"]')).toHaveAttribute('aria-selected', 'true');
  const region = await explorer(page);
  await region.getByRole('button', { name: 'Move Composer to Data panel (sample.data-panel)', exact: true }).click(); await back(page);
  await page.locator('#prompt').fill('Retain on owner disable'); await page.locator('#prompt').focus();
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  await page.evaluate(async () => (window as any).__previewDisableExtension('sample.data-panel'));
  await expect(page.locator('.conversation-pane > #composer-area')).toHaveCount(1); await expect(page.locator('#prompt')).toBeFocused();
  await expect(page.locator('.inspector-tab[data-view="changes"] [role="tab"]')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(saved);
  await page.evaluate(async () => (window as any).__previewEnableExtension('sample.data-panel'));
  await expect(page.locator('#inspector #composer-area')).toHaveCount(1);
  await page.evaluate(key => { localStorage.setItem(key, '{broken'); dispatchEvent(new StorageEvent('storage', { key })); }, key);
  await expect(page.locator('#inspector #composer-area')).toHaveCount(1);
  await expect(page.locator('#prompt')).toHaveValue('Retain on owner disable');
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('.conversation-pane > #composer-area')).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('{broken');
});
test('extensions placement: hiding focused input hands focus to a surviving host control and excludes hidden tab stops', async ({ page }) => {
  await open(page); await explorer(page); await back(page); await page.locator('#prompt').focus();
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, placements: { 'panda.views/composer': { container: 'panda.containers/main', hidden: true } } }));
    dispatchEvent(new StorageEvent('storage', { key }));
  }, key);
  await expect(page.locator('#prompt')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.checkVisibility())).toBe(true);
  await page.locator('#prompt').evaluate((node: HTMLElement) => node.focus()); await expect(page.locator('#prompt')).not.toBeFocused();
  const region = await explorer(page); await region.getByRole('button', { name: 'Restore built-in view placement' }).click(); await back(page);
  await expect(page.locator('#prompt')).toBeVisible();
});
test('extensions placement: hiding a terminal dismisses anchored close consent without closing its running PTY', async ({ page }) => {
  await open(page); await explorer(page); await back(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.terminalRunning = true; });
  await page.locator('#terminal-toggle').click(); await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  await page.locator('#terminal-drawer').getByRole('button', { name: 'Close terminal', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Close terminal?', exact: true })).toBeVisible();
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, placements: { 'panda.views/terminal': { container: 'panda.containers/main', hidden: true } } }));
    dispatchEvent(new StorageEvent('storage', { key }));
  }, key);
  await expect(page.getByRole('dialog', { name: 'Close terminal?', exact: true })).toHaveCount(0);
  await expect(page.locator('#terminal-host')).toBeHidden();
  await expect(page.locator('#terminal-toggle')).toBeFocused();
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === 'close_terminal'))).toEqual([]);
});
