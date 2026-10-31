import type { Page } from '@playwright/test';

// The inspector opens with only a Changes tab; other views are added from the
// strip's "+" menu. Specs call this before clicking a view's tab.
const VIEWS: Record<string, { view: string; label: string }> = {
  'tab-files': { view: 'files', label: 'Files' }, Files: { view: 'files', label: 'Files' },
  'tab-search': { view: 'search', label: 'Search' }, Search: { view: 'search', label: 'Search' },
  'tab-changes': { view: 'changes', label: 'Changes' }, Changes: { view: 'changes', label: 'Changes' },
  browser: { view: 'browser', label: 'Browser' }, Browser: { view: 'browser', label: 'Browser' },
  'tab-pull': { view: 'pull', label: 'Pull request' }, 'Pull request': { view: 'pull', label: 'Pull request' },
  'tab-simulator': { view: 'simulator', label: 'Simulators' }, Simulators: { view: 'simulator', label: 'Simulators' },
  'tab-vm': { view: 'vm', label: 'Virtual machines' }, 'Virtual machines': { view: 'vm', label: 'Virtual machines' },
  'tab-design': { view: 'design', label: 'Design' }, Design: { view: 'design', label: 'Design' },
};

/** Opens a view's tab (by label or tab data-action) through the "+" menu when it isn't open; an open tab is left as it is. */
export async function openInspectorTab(page: Page, name: string): Promise<void> {
  const { view, label } = VIEWS[name] ?? { view: name, label: name };
  await page.locator('#inspector .inspector-strip').waitFor({ state: 'attached' });
  if (await page.locator(`#inspector .inspector-tab[data-view="${view}"]`).isVisible()) return;
  await page.locator('#inspector [data-action="inspector-add-tab"]').click();
  await page.getByRole('menu', { name: 'Open view' }).getByRole('menuitem', { name: label, exact: true }).click();
}
