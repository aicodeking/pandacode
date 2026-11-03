import { expect, test, type Page } from '@playwright/test';

/** Each thread shows its own scene (src/scenes/: `sceneFor` hashes the thread id), crossfading on a switch. */
const layer = (page: Page) => page.locator('.thread-sky');
const sky = <T>(page: Page, key: string) => page.evaluate(name => (window as any).__sky[name], key) as Promise<T>;
const rows = (page: Page) => page.locator('#navigation .task-item[data-id]');

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/?sky=12:00${query}`);
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#transcript .message').first()).toBeVisible();
  await expect(layer(page)).toHaveAttribute('data-gl', '');
}
/** Opens each listed thread in turn and records the scene it shows. */
async function scenesByThread(page: Page): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const ids = await rows(page).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!));
  for (const id of ids.slice(0, 8)) {
    await page.locator(`#navigation .task-item[data-id="${id}"]`).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.thread-sky')?.getAttribute('data-thread-scene'))).toBeTruthy();
    await page.waitForTimeout(50);
    seen.set(id, (await layer(page).getAttribute('data-thread-scene'))!);
  }
  return seen;
}

test('a thread keeps its scene across switches and reloads, and threads differ', async ({ page }) => {
  await open(page);
  const first = await scenesByThread(page);
  expect(new Set(first.values()).size, JSON.stringify([...first])).toBeGreaterThan(1);
  const again = await scenesByThread(page);
  expect([...again]).toEqual([...first]);
  await page.reload();
  await expect(layer(page)).toHaveAttribute('data-gl', '');
  await expect(rows(page).nth(first.size - 1)).toBeAttached();
  expect([...await scenesByThread(page)]).toEqual([...first]);
});

test('a switch crossfades, first paint does not, and no thread shows the sky', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(400);
  expect(await sky<number>(page, 'fades'), 'no fade on first paint').toBe(0);
  const scenes = await scenesByThread(page);
  const entries = [...scenes];
  const [a, b] = [entries[0], entries.find(([, scene]) => scene !== entries[0][1])!];
  await page.locator(`#navigation .task-item[data-id="${a[0]}"]`).click();
  await expect(layer(page)).not.toHaveAttribute('data-fading');
  const before = await sky<number>(page, 'fades');
  await page.locator(`#navigation .task-item[data-id="${b[0]}"]`).click();
  // The old scene's last frame sits over the new one and fades out (opacity only) in about 300 ms.
  await expect(layer(page)).toHaveAttribute('data-fading', 'true', { timeout: 200 });
  const fade = layer(page).locator('.thread-sky-fade');
  await expect(fade).toBeVisible();
  expect(Number(await fade.evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(1.01);
  await expect(layer(page)).not.toHaveAttribute('data-fading', { timeout: 1000 });
  await expect(fade).toBeHidden();
  expect(await sky<number>(page, 'fades')).toBe(before + 1);
  await expect(layer(page)).toHaveAttribute('data-thread-scene', b[1]);
  // The new-task page has no thread: the sky.
  await page.getByRole('button', { name: /^New task/ }).click();
  await expect(page.locator('.new-task-welcome h1')).toBeVisible();
  await expect(layer(page)).toHaveAttribute('data-thread-scene', 'sky');
});

test('?scene= pins one scene for every thread and the new-task page', async ({ page }) => {
  await open(page, '&scene=aurora');
  await expect(layer(page)).toHaveAttribute('data-thread-scene', 'aurora');
  const scenes = await scenesByThread(page);
  expect(new Set(scenes.values())).toEqual(new Set(['aurora']));
  expect(await sky<number>(page, 'fades')).toBe(0);
  await page.getByRole('button', { name: /^New task/ }).click();
  await expect(page.locator('.new-task-welcome h1')).toBeVisible();
  await expect(layer(page)).toHaveAttribute('data-thread-scene', 'aurora');
});

test('reduced motion switches scenes at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const scenes = [...await scenesByThread(page)];
  const b = scenes.find(([, scene]) => scene !== scenes.at(-1)![1])!;
  await page.locator(`#navigation .task-item[data-id="${b[0]}"]`).click();
  await expect(layer(page)).toHaveAttribute('data-thread-scene', b[1]);
  expect(await sky<number>(page, 'fades')).toBe(0);
  await expect(layer(page)).toHaveAttribute('data-sky-state', 'static');
});

test('every scene paints within the 8 ms GPU budget at 1440×900, and all compile ahead on idle', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const ids = await sky<string[]>(page, 'scenes');
  // The precompile compiles every scene once the app is idle, so a first visit never stalls on a compile.
  await expect.poll(() => sky<string[]>(page, 'compiled').then(list => list.length), { timeout: 10_000 }).toBe(ids.length);
  for (const id of ids) {
    await open(page, `&scene=${id}`);
    // Pointer over the bare scene: full frame rate, so the timer queries come in quickly.
    const before = await sky<number | null>(page, 'gpuMs');
    for (let i = 0; i < 60; i++) await page.mouse.move(700 + (i % 20) * 12, 300 + Math.sin(i / 3) * 30);
    await page.waitForTimeout(300);
    if (await sky<string>(page, 'timing') !== 'gpu') continue; // no EXT_disjoint_timer_query here
    await expect.poll(() => sky<number | null>(page, 'gpuMs'), { timeout: 5000 }).not.toBe(before);
    const ms = await sky<number>(page, 'gpuMs');
    expect(ms, `${id} GPU paint ms`).toBeLessThan(8);
  }
});
