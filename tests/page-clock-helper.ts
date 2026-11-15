import type { Page } from '@playwright/test';

/** Pauses the page clock at `at` and gives the page real frames back. Playwright's clock also fakes
 * requestAnimationFrame, so while paused no frame-scheduled paint (a live row, a tile) would ever run; frames come from
 * the document timeline instead (Web Animations, which the clock leaves alone) and carry the paused clock's time, so
 * painting never moves it. Callbacks the fake queued before the switch run when pauseAt reaches `at`. Pass a fixed
 * instant (never `Date.now() + n`): pauseAt cannot go back. */
export async function pauseClock(page: Page, at: number): Promise<void> {
  await page.evaluate(() => {
    const frames = new Map<number, Animation>();
    let next = 0;
    window.requestAnimationFrame = callback => {
      const id = ++next, frame = document.documentElement.animate(null, { duration: 1 });
      frames.set(id, frame);
      frame.onfinish = () => { frames.delete(id); callback(performance.now()); };
      return id;
    };
    window.cancelAnimationFrame = id => { frames.get(id)?.cancel(); frames.delete(id); };
  });
  await page.clock.pauseAt(at);
}
