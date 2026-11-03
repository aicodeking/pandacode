import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

// A project folder renamed or moved on disk: the Files tab offers "Locate folder…"
// beside Retry, and picking the new folder relinks the project without losing its
// chats, tasks and history (issue #268). Chat folders are never relinkable.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';

async function probe(page: Page, url = '/', selected = 'session-1'): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `
      (window.__relinkCalls ??= []).push({ command, args: structuredClone(args) });
      switch (command) {
    `)) });
  });
  // `window.__filesFail` (preview.ts) makes the folder reads fail like a moved folder.
  await page.addInitScript(() => { (window as any).__filesFail = true; });
  await page.goto(url);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', selected);
}

test('a moved project folder offers Locate folder and relinks the project', async ({ page }) => {
  await probe(page);
  await openInspectorTab(page, 'Files');
  const alert = page.locator('#inspector-content .inspector-empty[role="alert"]');
  await expect(alert).toContainText('Unable to read folder');
  await expect(alert).toContainText('Project folder is unavailable');
  await alert.getByRole('button', { name: 'Locate folder…' }).click();
  // The preview's folder picker returns a fixed path; relinking clears the failure.
  await expect(alert).toHaveCount(0);
  await expect(page.locator('#inspector-content .file-row').first()).toBeVisible();
  const calls: any[] = await page.evaluate(() => (window as any).__relinkCalls ?? []);
  expect(calls.filter(entry => entry.command === 'relink_project')).toEqual([
    { command: 'relink_project', args: { projectId: 'project-1', path: '/Users/you/Projects/new-project' } },
  ]);
});

test('a chat folder is never offered Locate folder', async ({ page }) => {
  await probe(page, '/?sections', 'sections-pinned');
  await page.locator('.task-item', { hasText: 'Explain the borrow checker' }).click();
  await openInspectorTab(page, 'Files');
  const alert = page.locator('#inspector-content .inspector-empty[role="alert"]');
  await expect(alert).toContainText('Unable to read folder');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Locate folder…' })).toHaveCount(0);
});
