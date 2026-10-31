import { expect, test, type Page } from '@playwright/test';

// Sent messages are captured; the preview never runs an agent for them.
const sent = (page: Page): Promise<string[]> => page.evaluate(() => ((window as any).__saverSent ?? []).map((entry: any) => entry.text));
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const saver = (page: Page) => page.locator('.composer-saver-button');

async function open(page: Page, contextUsage = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    // The preview module arrives vite-transformed: double quotes, exponential numbers.
    let body = source.replace(/switch\s*\(command\)\s*\{/, `
      if (command === 'send_message') (window.__saverSent ??= []).push(structuredClone(args));
      if (command === 'token_saver_install') window.__saverInstalls = (window.__saverInstalls ?? 0) + 1;
      switch (command) {
    `);
    if (contextUsage) body = body.replace('resumeId: "preview-session"', `resumeId: "preview-session", contextUsage: { ${contextUsage} }`);
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
}
async function send(page: Page, text: string): Promise<void> {
  // The preview's sample agent answers each message; the next one waits for it to finish.
  await expect(page.locator('.send-button:not(.stop-button)')).toBeVisible({ timeout: 20000 });
  const before = (await sent(page)).length;
  await prompt(page).fill(text);
  await prompt(page).press('Enter');
  await expect.poll(async () => (await sent(page)).length).toBe(before + 1);
}

test('packs ride along once, fold in the transcript, and the switch-off is said once', async ({ page }) => {
  await open(page);
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'false');
  await saver(page).click();
  const panel = page.getByRole('dialog', { name: 'Token saver' });
  await expect(panel).toBeVisible();
  await panel.getByRole('switch', { name: /Caveman/ }).click();
  await expect(panel.getByRole('radio', { name: 'Full' })).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('radio', { name: 'Ultra' }).click();
  await panel.getByRole('switch', { name: /Lean code/ }).click();
  await expect(panel.locator('.saver-total')).toHaveText(/−\d+%/);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(saver(page).locator('b')).toHaveText('2');

  await send(page, 'Fix the flaky search test');
  const first = (await sent(page)).at(-1)!;
  expect(first.startsWith('Fix the flaky search test\n\nResponse style (PandaCode token saver')).toBe(true);
  expect(first).toContain('Telegraphic.');
  expect(first).toContain('least code that fully solves');
  // A style note, not an attachment: it stays out of the transcript.
  const message = page.locator('.user-message').filter({ hasText: 'Fix the flaky search test' }).last();
  await expect(message.locator('.message-content')).toHaveText('Fix the flaky search test');
  await expect(message.locator('.message-attachments')).toHaveCount(0);

  await send(page, 'And the docs');
  expect((await sent(page)).at(-1)).toBe('And the docs');

  await saver(page).click();
  await panel.getByRole('button', { name: 'Turn all off' }).click();
  await page.keyboard.press('Escape');
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'false');
  await send(page, 'Back to normal');
  expect((await sent(page)).at(-1)).toContain('): off. Answer in your normal style again.');
  await send(page, 'Thanks');
  expect((await sent(page)).at(-1)).toBe('Thanks');
});

test('turning on a missing tool installs it, and a thread can become the default', async ({ page }) => {
  await open(page);
  await saver(page).click();
  const panel = page.getByRole('dialog', { name: 'Token saver' });
  const rtk = panel.getByRole('switch', { name: /RTK compression/ });
  await expect(rtk).toHaveAttribute('aria-checked', 'false');
  await expect(panel.locator('#saver-rtk')).toHaveAttribute('data-tip', /turning it on installs it \(brew install rtk\)/);
  await rtk.click();
  await expect(panel.getByRole('status')).toHaveText('Installing…');
  await expect(rtk).toHaveAttribute('aria-busy', 'true');
  await expect(rtk).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#toast')).toContainText('RTK 1.0.1 installed and on');
  await expect(panel.locator('#saver-rtk')).toHaveAttribute('data-tip', /rtk 1\.0\.1 installed/);
  expect((await page.evaluate(() => ((window as any).__saverInstalls ?? 0)))).toBe(1);

  await panel.getByRole('switch', { name: /Quiet tools/ }).click();
  await panel.getByRole('checkbox', { name: 'Start new threads like this' }).check();
  await expect(page.locator('#toast')).toContainText('New threads start with these savers');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.tokenSaver')!).defaults.packs)).toEqual(['quiet-tools', 'rtk']);
  await page.keyboard.press('Escape');
  await send(page, 'Run the tests');
  const block = (await sent(page)).at(-1)!;
  expect(block).toContain('Prefix shell commands with rtk');
  expect(block).toContain('rg -n pattern path');
});

test('a nearly full context offers one-click tightening in the panel', async ({ page }) => {
  // The preview thread reports a mostly full context window, like a long real thread.
  await open(page, 'usedTokens: 820000, contextWindow: 1000000');
  await saver(page).click();
  const panel = page.getByRole('dialog', { name: 'Token saver' });
  const hint = panel.locator('.saver-hint');
  await expect(hint).toContainText('Context 82% full');
  await hint.getByRole('button', { name: /Tighten the saver/ }).click();
  await expect(panel.locator('.saver-hint')).toHaveCount(0);
  await expect(panel.getByRole('switch', { name: /Caveman/ })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('radio', { name: 'Ultra' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('switch', { name: /Quiet tools/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await send(page, 'Run the checks');
  const block = (await sent(page)).at(-1)!;
  expect(block).toContain('Telegraphic.');
  expect(block).toContain('rg -n pattern path');
});

test('the panel shows measured usage since the packs changed', async ({ page }) => {
  await open(page);
  await saver(page).click();
  const panel = page.getByRole('dialog', { name: 'Token saver' });
  await panel.getByRole('switch', { name: /Caveman/ }).click();
  await expect(panel.locator('.saver-measured')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await send(page, 'Trim the replies');
  await saver(page).click();
  const measured = panel.locator('.saver-measured');
  await expect(measured).toContainText('Since the packs changed');
  await expect(measured).toContainText('91.2K in');
  await expect(measured).toContainText('152.3K out');
  await expect(measured).toContainText('cache reads');
  // A configuration that has not gone out yet has no window to measure.
  await panel.getByRole('switch', { name: /Quiet tools/ }).click();
  await expect(measured).toHaveCount(0);
  await page.keyboard.press('Escape');
});
