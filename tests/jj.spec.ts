import { expect, test, type Page } from '@playwright/test';

// The Jujutsu panel (src/jj.ts) against the preview mock (src/preview-jj.ts), mounted on
// its own so it runs whether or not the Changes tab wiring is in place.
async function mount(page: Page): Promise<void> {
  await page.goto('/');
  // The inspector opens on Changes; let its first load finish before the mock turns
  // the preview project into a jj repo, so the app's own panel doesn't share the log cache.
  await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  await page.evaluate(async () => {
    const jj = await import('/src/jj.ts' as string);
    const mock = await import('/src/preview-jj.ts' as string);
    const host = Object.assign(document.createElement('div'), { id: 'jj-host' });
    host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Jujutsu');
    document.body.append(host);
    const w = window as any; w.__jjEvents = []; w.__previewJj = true;
    const call = async (command: string, args: any) => { w.__jjEvents.push({ command, args }); return mock.invokeJj(command, args); };
    jj.showJjPanel(host, await call('jj_status', { projectId: 'p' }), {
      call, context: () => ({ projectId: 'p', sessionId: 's' }),
      openDiff: (path: string, patch: string) => w.__jjEvents.push({ diff: path, patch }),
      notify: (message: string) => w.__jjEvents.push({ notify: message }),
    });
  });
}
const panel = (page: Page) => page.getByRole('region', { name: 'Jujutsu' });
const events = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__jjEvents);

test('shows the working-copy change, its files and the log', async ({ page }) => {
  await mount(page);
  await expect(panel(page).locator('.branch-card')).toContainText('kntqzsqt Speed up search');
  await expect(panel(page).getByText('2 changed files')).toBeVisible();
  await expect(panel(page).locator('.jj-log-row')).toHaveCount(3);
  await expect(panel(page).locator('.jj-log-row').nth(1)).toContainText('main');
  await panel(page).getByRole('button', { name: /search-index\.ts/ }).click();
  await expect.poll(async () => (await events(page)).find(e => e.diff)?.diff).toBe('src/lib/search-index.ts');
  // A redraw of the same change reuses the log instead of running `jj log` again.
  await page.evaluate(async () => {
    const jj = await import('/src/jj.ts' as string), mock = await import('/src/preview-jj.ts' as string);
    const w = window as any, host = document.getElementById('jj-host')!;
    jj.showJjPanel(host, mock.invokeJj('jj_status', {}), { call: async (command: string, args: any) => { w.__jjEvents.push({ command, args }); return mock.invokeJj(command, args); }, context: () => ({ projectId: 'p', sessionId: 's' }), openDiff() {}, notify() {} });
  });
  await expect(panel(page).locator('.jj-log-row')).toHaveCount(3);
  expect((await events(page)).filter(e => e.command === 'jj_log')).toHaveLength(1);
});

test('describe, commit and new update the change and the log', async ({ page }) => {
  await mount(page);
  const message = panel(page).getByRole('textbox', { name: 'Change description' });
  await message.fill('Debounce search input');
  await panel(page).getByRole('button', { name: 'Describe' }).click();
  await expect(panel(page).locator('.branch-card')).toContainText('Debounce search input');

  await message.fill('');
  await panel(page).getByRole('button', { name: 'Commit' }).click();
  await expect.poll(async () => (await events(page)).some(e => e.notify === 'Write a description before committing.')).toBe(true);

  await message.fill('-r root() Ship it');
  await panel(page).getByRole('button', { name: 'Commit' }).click();
  await expect(panel(page).getByText('No changes in this change')).toBeVisible();
  await expect(message).toHaveValue('');
  await expect(panel(page).locator('.jj-log-row').nth(1)).toContainText('-r root() Ship it');
  const commit = (await events(page)).find(e => e.command === 'jj_commit');
  expect(commit.args).toEqual({ projectId: 'p', sessionId: 's', message: '-r root() Ship it' });

  await panel(page).getByRole('button', { name: 'New' }).click();
  await expect(panel(page).locator('.jj-log-row')).toHaveCount(5);
});

test('the chip names the change for colocated repos', async ({ page }) => {
  await page.goto('/');
  const html = await page.evaluate(async () => {
    const jj = await import('/src/jj.ts' as string);
    return [jj.jjChip({ isRepo: false, colocated: false, change: null, files: [] }), jj.jjChip({ isRepo: true, colocated: true, files: [], change: { changeId: 'abcdefghijkl', commitId: '', description: '<b>x</b>', bookmarks: [], author: '', when: '', conflict: true, empty: false, current: true } })];
  });
  expect(html[0]).toBe('');
  expect(html[1]).toContain('jj abcdefgh · conflict');
  expect(html[1]).not.toContain('<b>');
});
