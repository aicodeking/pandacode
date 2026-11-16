import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S04A2 (upstream sync P4): after the 0.3.128 merge the webview still sends a prompt exactly as upstream does and
 * asks for tool images under upstream's rules, whichever harness, built-in or package, ran the thread. The native
 * halves (send/steer retry memory, start binding, path authorization) read the same fixtures in
 * remote::host and tool_images; see docs/extensions/upstream-semantic-remote-images.md. */
const images = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-semantic-remote-images/tool-images.json', import.meta.url), 'utf8'));
const sends = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-semantic-remote-images/webview-sends.json', import.meta.url), 'utf8'));

type Row = { id: string; path: string; answer: string };
const ROWS: Row[] = images.webview.rows;
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command =>
  ((window as any).__extensionsBaseline?.calls ?? []).filter((entry: any) => entry.command === command).map((entry: any) => entry.args), command);

/** Opens the zero-extension baseline preview on session-1; `provider-history` makes that thread a package
 * harness's (`sample.harness/agent`, not installed here), as a thread kept after its package went away. */
async function open(page: Page, query: string, init: Record<string, unknown> = {}) {
  await page.addInitScript(init => {
    localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null }));
    (window as any).__extensionsBaseline = { version: 1, calls: [], ...init };
  }, init);
  await page.goto(`/?${query}`);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}

for (const provider of images.webview.providers as string[]) {
  test(`upstream semantic images: authorized and denied tool images are asked and shown as upstream does (${provider})`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const at = Date.now() - 20_000;
    const seeded = [
      { id: 90_001, sessionId: 'session-1', role: 'user', content: 'Look at the screenshots.', createdAt: at },
      ...ROWS.map((row, index) => ({ id: 90_002 + index, sessionId: 'session-1', role: 'tool', createdAt: at + (index + 1) * 100,
        content: JSON.stringify({ type: 'tool_activity', version: 1, id: row.id, name: 'Read', status: 'completed', input: JSON.stringify({ file_path: row.path }), output: '[Non-text content omitted]' }) })),
      { id: 90_100, sessionId: 'session-1', role: 'assistant', content: 'Both screenshots show the settings.', createdAt: at + 5_000 },
    ];
    const refusals = Object.fromEntries(ROWS.filter(row => row.answer in images.errors).map(row => [row.path, images.errors[row.answer]]));
    await open(page, provider === 'claude' ? 'extensions-baseline' : 'extensions-baseline&provider-history', { seedMessages: { 'session-1': seeded }, toolImageRefusals: refusals });
    if (provider !== 'claude') await expect(page.locator('[data-provider-recovery]')).toBeVisible();
    const card = page.locator('.turn-card').last();
    await expect(card).toContainText('Both screenshots show the settings.');
    const activity = card.locator('details.turn-activity');
    if (await activity.getAttribute('open') === null) await activity.locator(':scope > summary').click();
    const group = card.locator('details.tool-group').last();
    if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
    const thumb = (row: Row) => card.locator(`.tool-image-thumb[data-tool-image="${row.path}"]`);
    for (const row of ROWS) await expect(thumb(row), row.id).toHaveCount(1);
    for (const row of ROWS) {
      if (row.answer === 'image') await expect(thumb(row)).toHaveClass(/\bis-loaded\b/);
      else await expect(thumb(row)).toHaveClass(/\bis-missing\b/);
    }
    // A permanent refusal keeps its own words; any other failure is the generic missing note.
    await expect(thumb(ROWS.find(row => row.answer === 'elsewhere')!)).toHaveAttribute('title', images.errors.elsewhere);
    await expect(thumb(ROWS.find(row => row.answer === 'never-asked')!)).toHaveAttribute('title', images.errors.network);
    await expect(thumb(ROWS.find(row => row.answer === 'notViewed')!)).toHaveAttribute('title', 'Image no longer available');
    const asked = await calls(page, 'tool_image');
    for (const row of ROWS) {
      const mine = asked.filter(args => args.path === row.path);
      if (row.answer === 'never-asked') expect(mine, row.id).toEqual([]);
      else {
        expect(mine.length, row.id).toBeGreaterThan(0);
        // Every ask names this thread and a thumbnail edge; the thread's harness is never part of the request.
        for (const args of mine) expect(Object.keys(args).sort(), row.id).toEqual(['maxEdge', 'path', 'sessionId']);
        expect(mine.every(args => args.sessionId === 'session-1'), row.id).toBe(true);
      }
    }
    // The permanent refusal is not asked again when the row renders afresh.
    expect(asked.filter(args => args.path === ROWS.find(row => row.answer === 'elsewhere')!.path)).toHaveLength(1);
    // Opening the authorized image asks once for the whole image.
    await thumb(ROWS[0]).click();
    const viewer = page.locator('dialog.tool-image-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
    await expect.poll(async () => (await calls(page, 'tool_image')).filter(args => args.path === ROWS[0].path && args.maxEdge === undefined).length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('upstream semantic sends: a composer send is one upstream-shaped send_message, and a rejected one is sent once on retry', async ({ page }) => {
  await open(page, 'extensions-baseline', { holdRun: true });
  const box = prompt(page);
  await expect(box).toBeEnabled();
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'send_message'; });
  await box.fill(sends.text);
  await box.press('Enter');
  await expect(page.locator('#toast')).toContainText('Baseline rejected send_message');
  // The rejected prompt was not saved and comes back to the composer, as upstream restores it.
  await expect(box).toHaveValue(sends.text);
  expect(await calls(page, 'send_message')).toHaveLength(1);
  await box.press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(2);
  const [rejected, sent] = await calls(page, 'send_message');
  for (const args of [rejected, sent]) {
    expect(Object.keys(args).sort()).toEqual([...sends.argKeys].sort());
    expect(args).toEqual({ ...sends.args, text: sends.text });
  }
  await expect(page.locator('#transcript .user-message', { hasText: sends.text })).toHaveCount(1);
  expect(await calls(page, 'architect_start')).toEqual([]);
});
