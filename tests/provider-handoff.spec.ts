import { expect, test, type Page } from '@playwright/test';

async function switchHarness(page: Page) {
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Codex', exact: true }).click();
  await picker.getByRole('option', { name: 'Codex · Default', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator('.transcript .provider-handoff')).toContainText('Conversation carried forward');
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

for (const width of [1440, 760]) {
  test(`centers the harness handoff row in the thread column at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await switchHarness(page);
    const handoff = await box(page, '.transcript .provider-handoff');
    const reply = await box(page, '.transcript .agent-message');
    // The handoff shares the agent reply's column.
    expect(Math.abs(handoff.x - reply.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(handoff.width - reply.width)).toBeLessThanOrEqual(2);
    // Its summary line is centered within that column.
    const summary = await box(page, '.transcript .provider-handoff summary');
    expect(Math.abs((summary.x + summary.width / 2) - (reply.x + reply.width / 2))).toBeLessThanOrEqual(3);
    await page.locator('.transcript .provider-handoff summary').click();
    const note = await box(page, '.transcript .provider-handoff p');
    expect(Math.abs((note.x + note.width / 2) - (reply.x + reply.width / 2))).toBeLessThanOrEqual(3);
  });
}
