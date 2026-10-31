import { expect, test, type Page } from '@playwright/test';

/* A task running on another computer (a mirror) shows the subagents and architect workers its
 * host runs: subagents from the host's events (saved, so they survive missed frames and a reopen)
 * and the team read from the host (`remote_team`, `remote_worker_messages` in src/preview.ts). */

const child = (id: string, name: string, status = 'running', response = '') => ({ id, parentId: null, name, prompt: `Work for ${name}.`, status, response, tools: [], startedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001 });

async function openMirror(page: Page, before?: () => Promise<void>) {
  await page.addInitScript(() => {
    (window as any).__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__clipboardWrites.push(text); } } });
  });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => (window as any).__previewMirrorTeam());
  await before?.();
  await page.locator('#navigation .task-item').filter({ hasText: 'Remote team task' }).click();
}

test('a mirror shows its host subagents, live and from the saved snapshot', async ({ page }) => {
  // Sent while another task was open: only the saved snapshot can show it.
  await openMirror(page, () => page.evaluate(c => (window as any).__mirrorSubagent(c), child('run:a', 'Explorer')));
  const trigger = page.locator('#agents-toggle');
  await expect(trigger).toBeVisible();
  await page.evaluate(c => (window as any).__mirrorSubagent(c), child('run:b', 'Reviewer', 'completed', 'Looks good.'));
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Subagents', exact: true });
  await expect(panel.locator('button[data-subagent-id="run:a"]')).toContainText('Explorer');
  await expect(panel.locator('button[data-subagent-id="run:b"]')).toContainText('Reviewer');
});

test('a mirror shows the host team read-only, with worker transcripts and live row changes', async ({ page }) => {
  await openMirror(page);
  const trigger = page.locator('#agents-toggle');
  await expect(trigger).toHaveAttribute('aria-label', 'Agents: 1 running');
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Workers', exact: true });
  await expect(panel.locator('.architect-worker-row')).toHaveCount(2);
  await expect(panel.locator('.architect-panel-controls')).toBeHidden();
  await expect(panel.locator('.team-messages')).toHaveCount(0);

  await panel.locator('.architect-worker-row[data-worker-id="w1"]').click();
  const history = panel.locator('.architect-worker-history');
  await expect(history).toContainText('Intro written on the host.');
  // The worker's messages are on the host: no local Fork, and Copy uses the loaded text.
  await expect(history.locator('[data-message-action="fork"]')).toHaveCount(0);
  await history.locator('[data-message-action="copy"]').last().click();
  await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe('Intro written on the host.');
  await panel.getByRole('button', { name: 'Back to workers' }).click();

  // The host's `team` event: worker 2 finished; the mirror rereads its team.
  await page.evaluate(() => (window as any).__mirrorTeamWorker({ id: 'w2', status: 'completed', summary: 'Wrote the guide' }));
  await expect(trigger).toHaveAttribute('aria-label', 'Agents');
  await expect(panel.locator('.architect-worker-row[data-worker-id="w2"]')).toContainText('Done');
});

test('a long host worker transcript loads its older pages when scrolled back', async ({ page }) => {
  await openMirror(page);
  await page.evaluate(() => (window as any).__previewMirrorLongWorker(130));
  await page.locator('#agents-toggle').click();
  const panel = page.getByRole('dialog', { name: 'Workers', exact: true });
  await panel.locator('.architect-worker-row[data-worker-id="w1"]').click();
  const history = panel.locator('.architect-worker-history');
  await expect(history).toContainText('Worker line 130');
  const scroll = panel.locator('.architect-panel-scroll');
  await expect.poll(async () => {
    await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    return history.locator('[data-message-id]').count();
  }).toBe(130);
  await expect(history.locator('[data-message-id]').first()).toContainText('Worker line 1');
  // Each older page was asked before the oldest row shown, never again from the tail.
  expect((await page.evaluate(() => (window as any).__remoteWorkerPages as (number | null)[])).filter(id => id !== null)).toEqual([91, 51, 11]);
});
