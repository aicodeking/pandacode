import { expect, test } from '@playwright/test';

/* A worker's card shows the token saver packs the lead gave it (`tokenSaver` on the mirror
 * team's workers in src/preview.ts); workers never inherit one. */

test('worker cards show their token saver packs as chips', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => (window as any).__previewMirrorTeam());
  await page.locator('#navigation .task-item').filter({ hasText: 'Remote team task' }).click();
  await page.locator('#agents-toggle').click();
  const panel = page.getByRole('dialog', { name: 'Workers', exact: true });

  await panel.locator('.architect-worker-row[data-worker-id="w1"]').click();
  const saver = panel.locator('.architect-worker-meta .architect-saver');
  await expect(saver.locator('.architect-saver-chip')).toHaveText(['Caveman lite', 'Quiet tools']);
  await expect(saver).toHaveAttribute('aria-label', 'Token saver: Caveman lite · Quiet tools');
  // The full label is the shared tip bubble (AGENTS.md), never a native `title`.
  await expect(saver).not.toHaveAttribute('title');
  await saver.hover();
  await expect(page.locator('.tip-bubble')).toHaveText('Token saver: Caveman lite · Quiet tools');

  await panel.getByRole('button', { name: 'Back to workers' }).click();
  await panel.locator('.architect-worker-row[data-worker-id="w2"]').click();
  await expect(saver.locator('.architect-saver-chip')).toHaveText(['Lean code', 'Quiet tools']);

  // A worker without a saver shows no chips.
  await page.evaluate(() => (window as any).__mirrorTeamWorker({ id: 'w2', tokenSaver: null }));
  await expect(saver).toHaveCount(0);
});
