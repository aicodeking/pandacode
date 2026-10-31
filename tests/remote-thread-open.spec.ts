import { expect, test } from '@playwright/test';

/* A long thread on another computer opens on its newest page (remote/mirror.rs copies the
 * host's tail first); older pages copied behind it prepend without moving the reader. */

test('a long mirror thread shows its newest messages first and older ones prepend in place', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => (window as any).__previewMirrorThread(400, 30));
  await page.locator('#navigation .task-item').filter({ hasText: 'Long remote thread' }).click();
  const transcript = page.locator('#transcript');
  const message = (n: number) => transcript.getByText(`Message ${String(n).padStart(3, '0')}`, { exact: true });
  await expect(message(399)).toBeVisible();
  await expect(message(370)).toHaveCount(1);
  await expect(message(369)).toHaveCount(0);
  // The reader scrolled up a little; an older page arriving must not move what they read.
  await page.waitForTimeout(300);
  await transcript.evaluate(node => { node.scrollTop -= 300; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 })); });
  const reading = async () => (await message(385).boundingBox())!.y;
  const before = await reading();

  await page.evaluate(() => (window as any).__previewMirrorBackfill(200));
  await expect(message(270)).toHaveCount(1);
  await expect(message(269)).toHaveCount(0);
  expect(Math.abs((await reading()) - before)).toBeLessThanOrEqual(1);

  // The rest waits for the reader: scrolling up loads it as in any thread.
  await page.evaluate(() => (window as any).__previewMirrorBackfill(200));
  await expect(message(269)).toHaveCount(0);
  for (let i = 0; i < 20 && !(await message(170).count()); i++) {
    await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(100);
  }
  await expect(message(170)).toHaveCount(1);
});
