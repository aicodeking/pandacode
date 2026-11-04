import { expect, test, type Page } from '@playwright/test';

test('main window opens provider and Markdown web links in the system browser', async ({ page }) => {
  await recordWindowOpens(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Agents', exact: true }).click(); await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click(); await page.locator('#settings-panel-providers details.connection-card').first().waitFor(); for (const s of await page.locator('#settings-panel-providers details.connection-card>summary').all()) await s.click();
  await page.getByRole('link', { name: /Get the official ACP server/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__externalUrlOpens)).toEqual(['https://antigravity.google/docs/ide/extensions']);

  await page.evaluate(async () => {
    const { markdown } = await import('/src/dom.ts');
    const target = document.createElement('div');
    target.id = 'external-markdown-probe'; target.className = 'markdown';
    document.body.append(target);
    await markdown(target, '[Open guide](https://example.com/transcript)');
  });
  await page.locator('#external-markdown-probe a').click();
  await expect.poll(() => page.evaluate(() => (window as any).__externalUrlOpens)).toEqual([
    'https://antigravity.google/docs/ide/extensions',
    'https://example.com/transcript',
  ]);

  await page.evaluate(() => {
    const anchor = document.createElement('a');
    anchor.id = 'internal-link-probe'; anchor.href = '#external-markdown-probe'; anchor.textContent = 'Jump within the app';
    document.body.append(anchor);
  });
  await page.locator('#internal-link-probe').click();
  await expect.poll(() => page.evaluate(() => (window as any).__externalUrlOpens)).toHaveLength(2);
});

test('launcher thread Markdown links use the system browser too', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 510 });
  await recordWindowOpens(page);
  await instrumentLauncher(page, `if (command === 'overlay_thread') return {
    provider:'codex', status:'idle', hasOlder:false, liveText:'', messages:[
      {id:1,sessionId:args.sessionId,role:'user',content:'[Open launcher guide](https://example.com/launcher)',createdAt:1},
    ]};`);
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const link = page.locator('.launcher-thread-user a');
  await expect(link).toHaveText('Open launcher guide');
  await link.click();
  await expect.poll(() => page.evaluate(() => (window as any).__overlayCalls.filter((call:any) => call.command === 'open_external_url').map((call:any) => call.args))).toEqual([
    { url: 'https://example.com/launcher' },
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).__externalUrlOpens)).toEqual(['https://example.com/launcher']);
  await expect(page).toHaveURL(/view=launcher/);
});

async function recordWindowOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__externalUrlOpens = [];
    window.open = ((url?: string | URL | undefined) => {
      (window as any).__externalUrlOpens.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  });
}

async function instrumentLauncher(page: Page, intercept = ''): Promise<void> {
  await page.route('**/src/overlay-client.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /if \(command === ["']overlay_preferences["']\)/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__overlayCalls ??= []).push({command,args:structuredClone(args)});
      ${intercept}
      $&`) });
  });
}
