import { test, expect, type Page } from '@playwright/test';

// Project scope of enablement (T60 use case 2): an installed package scoped to selected projects contributes
// only while one of them is active. Native tests own persistence and admission; this proves the real
// Settings control and the header/sidebar presentation switching without a reload, in both engines.
const owner = 'sample.project-helper';
const header = (page: Page) => page.locator(`[data-extension-contribution="${owner}/header"]`);
const sidebar = (page: Page) => page.locator(`[data-extension-contribution="${owner}/sidebar"]`);
const scope = (page: Page) => page.getByRole('group', { name: `Projects for ${owner}`, exact: true });
const selected = (page: Page) => page.getByRole('group', { name: `Selected projects for ${owner}`, exact: true });

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); });
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeVisible();
}
async function activate(page: Page, session: 'session-1' | 'session-4') {
  await page.locator(`.task-item[data-id="${session}"]`).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', session);
}
async function manager(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install local package' })).toBeVisible();
}
async function back(page: Page) { await page.getByRole('button', { name: 'Back to the workspace' }).click(); }
async function messages(page: Page) { return page.evaluate(() => (window as any).__scopeMessages as number); }
async function countMessages(page: Page) {
  await page.evaluate(() => {
    (window as any).__scopeMessages = 0;
    new MutationObserver(records => {
      for (const record of records) if (record.type === 'childList' && (record.target as Element).id === 'toast' && record.target.textContent === 'Extension installed successfully') (window as any).__scopeMessages++;
    }).observe(document.querySelector('#toast')!, { childList: true });
  });
}

test.describe.serial('extensions project scope', () => {
let page: Page;
test.beforeAll(async ({ browser, baseURL }) => { page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 940 } }); });
test.afterAll(async () => { await page?.context().close(); });

test('extensions project scope: only project A shows and runs the package; B withholds it without a reload', async () => {
  await open(page);
  await activate(page, 'session-1');
  await manager(page);
  await page.getByRole('button', { name: 'Install local package' }).click();
  await page.getByRole('button', { name: `Enable ${owner}`, exact: true }).click();
  // Default: All projects, the behaviour of every package record written before scopes existed.
  await expect(scope(page).getByRole('radio', { name: 'All projects', exact: true })).toBeChecked();
  await expect(selected(page)).toHaveCount(0);
  await expect(page.getByText('Projects: all projects')).toBeVisible();
  // Keyboard: Space on "Only selected projects" scopes the package to the active project (orbit = project-1).
  await scope(page).getByRole('radio', { name: 'Only selected projects', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(scope(page).getByRole('radio', { name: 'Only selected projects', exact: true })).toBeChecked();
  await expect(scope(page).getByRole('radio', { name: 'Only selected projects', exact: true })).toBeFocused();
  await expect(selected(page).getByRole('checkbox', { name: 'orbit', exact: true })).toBeChecked();
  await expect(selected(page).getByRole('checkbox', { name: 'pandacode', exact: true })).not.toBeChecked();
  await expect(page.getByText('Projects: orbit')).toBeVisible();
  await back(page);
  await page.evaluate(() => { (window as any).__scopeMarker = 'same document'; });
  await countMessages(page);
  // Project A: the header and sidebar contributions render and are clicked.
  await expect(header(page)).toBeVisible(); await expect(sidebar(page)).toBeVisible();
  await header(page).click();
  await expect.poll(() => messages(page)).toBe(1);
  // Project B: withheld, no reload.
  await activate(page, 'session-4');
  await expect(header(page)).toHaveCount(0); await expect(sidebar(page)).toHaveCount(0);
  // Back to A: present and runnable again, still the same document.
  await activate(page, 'session-1');
  await expect(header(page)).toBeVisible();
  await sidebar(page).click();
  await expect.poll(() => messages(page)).toBe(2);
  expect(await page.evaluate(() => (window as any).__scopeMarker)).toBe('same document');
});

test('extensions project scope: the Extensions page stays manageable from B and the scope survives disable, restart and safe mode', async () => {
  await activate(page, 'session-4');
  await manager(page);
  // Management surface: listed with its scope and controls while B is active.
  await expect(page.getByText('Projects: orbit')).toBeVisible();
  await page.getByRole('button', { name: `Disable ${owner}`, exact: true }).click();
  await page.getByRole('button', { name: `Enable ${owner}`, exact: true }).click();
  await expect(selected(page).getByRole('checkbox', { name: 'orbit', exact: true })).toBeChecked();
  // Safe mode for this launch loads no package; the next launch (reload) restores the same scope.
  await page.getByRole('button', { name: 'Disable extensions for this launch' }).click();
  await expect(scope(page)).toHaveCount(0);
  await page.reload(); await expect(page.locator('#prompt')).toBeVisible();
  await activate(page, 'session-4');
  await expect(header(page)).toHaveCount(0);
  await activate(page, 'session-1');
  await expect(header(page)).toBeVisible();
  await manager(page);
  await expect(selected(page).getByRole('checkbox', { name: 'orbit', exact: true })).toBeChecked();
  await expect(selected(page).getByRole('checkbox', { name: 'pandacode', exact: true })).not.toBeChecked();
});

test('extensions project scope: selecting, deselecting and All projects are keyboard operable and keep at least one project', async () => {
  // Add pandacode with Space, then remove orbit: only B shows the package.
  await selected(page).getByRole('checkbox', { name: 'pandacode', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(selected(page).getByRole('checkbox', { name: 'pandacode', exact: true })).toBeChecked();
  await expect(selected(page).getByRole('checkbox', { name: 'pandacode', exact: true })).toBeFocused();
  await selected(page).getByRole('checkbox', { name: 'orbit', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(selected(page).getByRole('checkbox', { name: 'orbit', exact: true })).not.toBeChecked();
  await expect(page.getByText('Projects: pandacode')).toBeVisible();
  // The last selected project cannot be cleared; nothing is persisted and the reason is announced.
  await selected(page).getByRole('checkbox', { name: 'pandacode', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('alert').filter({ hasText: 'Keep at least one project, or choose All projects.' })).toBeVisible();
  await expect(selected(page).getByRole('checkbox', { name: 'pandacode', exact: true })).toBeChecked();
  await back(page);
  await expect(header(page)).toHaveCount(0);
  await activate(page, 'session-4');
  await expect(header(page)).toBeVisible();
  await countMessages(page);
  await header(page).click();
  await expect.poll(() => messages(page)).toBe(1);
  // All projects: both projects show it again.
  await manager(page);
  await scope(page).getByRole('radio', { name: 'All projects', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(selected(page)).toHaveCount(0);
  await expect(page.getByText('Projects: all projects')).toBeVisible();
  await back(page);
  await expect(header(page)).toBeVisible();
  await activate(page, 'session-1');
  await expect(header(page)).toBeVisible();
});
});
