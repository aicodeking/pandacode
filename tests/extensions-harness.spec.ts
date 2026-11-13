import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
async function selectHarness(page: Page) {
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Recorded harness', exact: true }).click();
  await picker.getByRole('option', { name: 'Recorded harness · Recorded model', exact: true }).click();
  await expect(picker).toBeHidden();
  await page.locator('#model-picker-trigger').click();
  await picker.getByRole('radio', { name: 'medium', exact: true }).click();
  await page.keyboard.press('Escape');
}
async function seed(page: Page) {
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic-recording', trusted: true } }])); }, manifest);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled(); await selectHarness(page);
}
test('extensions harness: install requires executable review and exposes catalog/settings without core switch entries', async ({ page }) => {
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.fake-harness', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  await page.getByRole('button', { name: 'Review executable trust sample.fake-harness', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  await expect(review).toContainText('not an OS sandbox');
  await review.getByRole('button', { name: 'Review full authority', exact: true }).click(); await review.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.fake-harness', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await selectHarness(page); await expect(page.locator('[data-provider-recovery]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click(); await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.locator('[data-extension-provider="sample.fake-harness/recorded"]')).toContainText('trusted extension');
});
for (const approved of [false, true]) test(`extensions harness: ${approved ? 'approve' : 'reject'}, question, usage, trace, resume and history use current UI`, async ({ page }) => {
  await seed(page);
  for (let turn = 0; turn < 2; turn++) {
    await page.locator('#prompt').fill(`Recorded prompt ${turn}`); await page.locator('#prompt').press('Enter');
    const approval = page.getByRole('region', { name: 'Approval needed', exact: true }); await expect(approval).toContainText('recorded operation');
    await approval.getByRole('button', { name: approved ? 'Approve' : 'Deny', exact: true }).click();
    const input = page.locator('.agent-input'); await expect(input).toContainText('Which recorded result?');
    await input.getByRole('radio', { name: 'Finish Complete this recording', exact: true }).check();
    await input.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect(input).toBeHidden();
    await expect(page.locator('#transcript')).toContainText('Recorded conversation complete.');
    await expect.poll(() => page.evaluate(() => (window as any).__extensionHarness.task().status)).toBe('idle');
  }
  const task = await page.evaluate(() => (window as any).__extensionHarness.task());
  expect(task.provider).toBe('sample.fake-harness/recorded'); expect(task.model).toBe('recorded-model'); expect(task.reasoningEffort).toBe('medium'); expect(task.resumeId).toBe('recorded-conversation');
  expect(task.contextUsage).toMatchObject({ usedTokens: 1234, contextWindow: 32000 });
  const history = await page.evaluate(() => (window as any).__extensionHarness.messages());
  expect(history.filter((message: any) => message.role === 'assistant').at(-1).content).toContain('Resumed recorded harness');
  expect(history.some((message: any) => message.role === 'tool' && message.content.includes('Recorded file content'))).toBe(true);
});
test('extensions harness: disable cancels only its active run and preserves readable transcript and recovery', async ({ page }) => {
  await seed(page); await page.locator('#prompt').fill('Cancel recorded operation'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__extensionHarness.call('extensions_enable', { id: 'sample.fake-harness', enabled: false }));
  await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeHidden();
  await expect(page.locator('[data-provider-recovery]')).toBeVisible();
  await expect(page.locator('#transcript')).toContainText('Cancel recorded operation');
  const task = await page.evaluate(() => (window as any).__extensionHarness.task()); expect(task.resumeId).toBe('recorded-conversation'); expect(task.status).toBe('idle');
  const error = await page.evaluate(async () => { try { await (window as any).__extensionHarness.call('send_message', { sessionId: 'session-1', text: 'Blocked future admission' }); } catch (error) { return String(error); } });
  expect(error).toContain('History is preserved');
});
