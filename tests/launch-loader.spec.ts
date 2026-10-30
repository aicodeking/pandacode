import { expect, test, type Page } from '@playwright/test';

test.describe('launch loader', () => {
  test('displays sidebar skeleton and workspace loader before projects resolve, then transitions', async ({ page }) => {
    // Intercept preview invoke to hold list_projects briefly to assert loader presence
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /switch\s*\(command\)\s*\{/;
      const delayCode = `
        if (command === 'list_projects') {
          await new Promise(r => setTimeout(r, 600));
        }
        switch (command) {
      `;
      await route.fulfill({ response, body: source.replace(marker, delayCode) });
    });

    await page.goto('/');

    // While projects are loading, verify skeleton and welcome loader are visible
    const skeleton = page.locator('#navigation .sidebar-skeleton');
    const welcomeLoading = page.locator('#transcript .welcome-loading');

    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('role', 'status');
    await expect(skeleton).toHaveAttribute('aria-label', 'Loading projects and tasks');
    await expect(welcomeLoading).toBeVisible();
    await expect(welcomeLoading).toHaveAttribute('role', 'status');
    await expect(welcomeLoading).toHaveAttribute('aria-label', 'Loading workspace');

    // Neither the premature empty sidebar nor the "Choose a project" screen should be visible
    await expect(page.locator('.sidebar-empty')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Choose a project' })).toHaveCount(0);

    // After list_projects resolves, verify it transitions to the active task
    await expect(page.locator('.task-item.selected')).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await expect(welcomeLoading).toHaveCount(0);
  });

  test('when no projects exist, displays loader first and then reveals genuine empty states', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /switch\s*\(command\)\s*\{/;
      const emptyProjectsCode = `
        if (command === 'list_projects') {
          await new Promise(r => setTimeout(r, 400));
          return [];
        }
        if (command === 'list_sessions') {
          return [];
        }
        switch (command) {
      `;
      await route.fulfill({ response, body: source.replace(marker, emptyProjectsCode) });
    });

    await page.goto('/');

    // Initially displays loaders
    await expect(page.locator('#navigation .sidebar-skeleton')).toBeVisible();
    await expect(page.locator('#transcript .welcome-loading')).toBeVisible();

    // After loading completes with zero projects, reveals empty states
    await expect(page.locator('.sidebar-empty')).toBeVisible();
    await expect(page.locator('.sidebar-empty')).toHaveText('Open a project to get started.');
    await expect(page.getByRole('heading', { name: 'Choose a project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a project' })).toBeVisible();
  });
});
