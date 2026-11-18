import { expect, test, type Page } from '@playwright/test';

// Settings → Tools → Agent-made tools, against the seeded preview store (src/preview-custom-tools.ts).
// Preview projects: orbit (no tools) and pandacode.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const group = (page: Page, name: string) => settings(page).getByRole('region', { name, exact: true });
const row = (page: Page, list: string, tool: string) => group(page, list).locator(`.custom-tool[data-name="${tool}"]`);
const moreFor = (page: Page, list: string, tool: string) => row(page, list, tool).getByRole('button', { name: `More for ${tool}` });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function openTools(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Tools', exact: true }).click();
}
async function more(page: Page, list: string, tool: string): Promise<void> {
  await expect(group(page, 'Global')).toBeVisible();
  await moreFor(page, list, tool).click();
}
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return { label: el?.getAttribute('aria-label'), list: el?.closest<HTMLElement>('.custom-tools-group')?.getAttribute('aria-label'), section: el?.classList.contains('custom-tools-group') ?? false };
});

test('lists Global then each project, with usage', async ({ page }) => {
  await openTools(page);
  await expect(group(page, 'Global').getByText('Every project')).toBeVisible();
  await expect(row(page, 'Global', 'git-recent-branches')).toBeVisible();
  await expect(row(page, 'pandacode', 'run-e2e-subset')).toContainText('Before finishing a UI change');
  await expect(row(page, 'pandacode', 'run-e2e-subset').locator('.custom-tool-usage')).toHaveText('Used 12× by 4 tasks · last 2 d ago');
  await expect(row(page, 'pandacode', 'regen-accents').locator('.custom-tool-usage')).toHaveText('Never used');
  await expect(row(page, 'pandacode', 'regen-accents').locator('[data-never]')).toHaveCount(1);
  await expect(row(page, 'pandacode', 'git-recent-branches').locator('.custom-tool-usage')).toHaveText('Used 1× by 1 task · last 1 h ago');
  const order = await settings(page).locator('.custom-tools-group').evaluateAll(groups => groups.map(g => g.getAttribute('aria-label')));
  expect(order).toEqual(['Global', 'pandacode']);
});

test('dragging a project tool onto Global makes it global', async ({ page }) => {
  await openTools(page);
  await expect(group(page, 'Global')).toBeVisible();
  await row(page, 'pandacode', 'run-e2e-subset').dragTo(group(page, 'Global').locator('.custom-tools-list'));
  await expect(row(page, 'Global', 'run-e2e-subset')).toBeVisible();
  await expect(row(page, 'pandacode', 'run-e2e-subset')).toHaveCount(0);
  await expect(group(page, 'Global').locator('[data-over]')).toHaveCount(0);
});

test('Make global from the keyboard keeps focus on the moved row', async ({ page }) => {
  await openTools(page);
  await expect(group(page, 'Global')).toBeVisible();
  await moreFor(page, 'pandacode', 'regen-accents').focus();
  await page.keyboard.press('Enter');
  await expect(menuItem(page, 'Make global')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'Global', 'regen-accents')).toBeVisible();
  await expect.poll(() => focused(page)).toEqual({ label: 'More for regen-accents', list: 'Global', section: false });
});

test('Move to lists every user project, including one without tools', async ({ page }) => {
  await openTools(page);
  await more(page, 'Global', 'git-recent-branches');
  const moves = await page.getByRole('menuitem').filter({ hasText: /^Move to / }).allTextContents();
  expect(moves.map(text => text.trim())).toEqual(['Move to orbit', 'Move to pandacode']);
  await menuItem(page, 'Move to orbit').click();
  await expect(row(page, 'orbit', 'git-recent-branches')).toBeVisible();
  await expect(row(page, 'Global', 'git-recent-branches')).toHaveCount(0);
  await expect.poll(() => focused(page)).toEqual({ label: 'More for git-recent-branches', list: 'orbit', section: false });
});

test('a name already in Global shows the conflict', async ({ page }) => {
  await openTools(page);
  await more(page, 'pandacode', 'git-recent-branches');
  await menuItem(page, 'Make global').click();
  await expect(settings(page).getByRole('alert')).toHaveText('A tool named git-recent-branches already exists there.');
  await expect(row(page, 'pandacode', 'git-recent-branches')).toBeVisible();
  await expect.poll(() => focused(page)).toEqual({ label: 'More for git-recent-branches', list: 'pandacode', section: false });
});

test('disable and enable a tool, keeping focus on it', async ({ page }) => {
  await openTools(page);
  await more(page, 'pandacode', 'run-e2e-subset');
  await menuItem(page, 'Disable').click();
  await expect(row(page, 'pandacode', 'run-e2e-subset')).toHaveAttribute('data-disabled', 'true');
  await expect(row(page, 'pandacode', 'run-e2e-subset').getByText('Disabled', { exact: true })).toBeVisible();
  await expect(moreFor(page, 'pandacode', 'run-e2e-subset')).toBeFocused();
  await more(page, 'pandacode', 'run-e2e-subset');
  await menuItem(page, 'Enable').click();
  await expect(row(page, 'pandacode', 'run-e2e-subset')).toHaveAttribute('data-disabled', 'false');
  await expect(moreFor(page, 'pandacode', 'run-e2e-subset')).toBeFocused();
});

test('delete asks first, then focuses the next row or the section', async ({ page }) => {
  await openTools(page);
  await more(page, 'pandacode', 'regen-accents');
  await menuItem(page, 'Delete…').click();
  await row(page, 'pandacode', 'regen-accents').getByRole('button', { name: 'Keep regen-accents' }).click();
  await expect(row(page, 'pandacode', 'regen-accents')).toBeVisible();
  await more(page, 'pandacode', 'regen-accents');
  await menuItem(page, 'Delete…').click();
  await row(page, 'pandacode', 'regen-accents').getByRole('button', { name: 'Delete regen-accents' }).click();
  await expect(row(page, 'pandacode', 'regen-accents')).toHaveCount(0);
  await expect(moreFor(page, 'pandacode', 'git-recent-branches')).toBeFocused();
  // The last global tool: the Global section takes focus.
  await more(page, 'Global', 'git-recent-branches');
  await menuItem(page, 'Delete…').click();
  await row(page, 'Global', 'git-recent-branches').getByRole('button', { name: 'Delete git-recent-branches' }).click();
  await expect(row(page, 'Global', 'git-recent-branches')).toHaveCount(0);
  await expect.poll(() => focused(page)).toEqual({ label: 'Global', list: 'Global', section: true });
});

test('view script shows it read-only', async ({ page }) => {
  await openTools(page);
  await more(page, 'pandacode', 'run-e2e-subset');
  await menuItem(page, 'View script').click();
  const script = row(page, 'pandacode', 'run-e2e-subset').getByLabel('Script of run-e2e-subset');
  await expect(script).toHaveText('npx playwright test "$PC_FILE" --reporter=line');
  await expect(script).toHaveJSProperty('tagName', 'PRE');
  await more(page, 'pandacode', 'run-e2e-subset');
  await menuItem(page, 'Hide script').click();
  await expect(script).toHaveCount(0);
});

test('a failed first load offers Retry', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__customToolsFail = 1; });
  await openTools(page);
  await expect(settings(page).getByRole('alert')).toContainText('The tool folder could not be read.');
  await expect(settings(page).getByText('Loading…')).toHaveCount(0);
  await settings(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(row(page, 'pandacode', 'run-e2e-subset')).toBeVisible();
  await expect(settings(page).getByRole('alert')).toHaveCount(0);
});

test('with no tools anywhere, it says tools are opt-in and how they appear', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__customToolsEmpty = true; });
  await openTools(page);
  await expect(settings(page).locator('.custom-tools-empty')).toHaveText('No tools yet. Agent-made tools are off unless the Agent-made tools switch is on; then agents can save repeated work here for other agents in the project to reuse.');
  await expect(settings(page).locator('.custom-tools-group')).toHaveCount(0);
  await expect(settings(page).getByRole('alert')).toHaveCount(0);
});

// The opt-in switch (`custom-tools-on` marker in app data): off by default, saved natively.
const optIn = (page: Page) => settings(page).getByRole('checkbox', { name: 'Agent-made tools', exact: true });

test('agent-made tools are off by default, and the switch saves', async ({ page }) => {
  await openTools(page);
  await expect(optIn(page)).toBeEnabled();
  await expect(optIn(page)).not.toBeChecked();
  await expect(settings(page).getByText('Agents save and run project scripts. Off by default: no measured gain.')).toBeVisible();
  await optIn(page).click();
  await expect(optIn(page)).toBeChecked();
  // Reopened, Settings reads the saved value back.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(optIn(page)).toBeChecked();
});

test('an agent-made tools switch that cannot be read stays off and cannot be flipped', async ({ page }) => {
  await openTools(page, '/?custom-tools-fail');
  await expect(settings(page).getByText('Couldn’t read this setting.')).toBeVisible();
  await expect(optIn(page)).toBeDisabled();
  await expect(optIn(page)).not.toBeChecked();
});

test('agent-made tools saves stay ordered when Settings reopens during a save', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `$&
      if (command === 'set_custom_tools_enabled') {
        (window.__settingsSaves ??= []).push(args.enabled);
        await new Promise(resolve => { window.__releaseSettingsSave = resolve; });
      }
    `) });
  });
  await openTools(page);
  await expect(optIn(page)).toBeEnabled();
  await optIn(page).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__settingsSaves)).toEqual([true]);
  await expect(optIn(page)).toBeDisabled();
  await expect(optIn(page)).toHaveAttribute('aria-busy', 'true');

  // The new mount must not read the old value and allow a competing write.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(optIn(page)).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseSettingsSave());
  await expect(optIn(page)).toBeEnabled();
  await expect(optIn(page)).toBeChecked();

  await optIn(page).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__settingsSaves)).toEqual([true, false]);
  await expect(optIn(page)).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseSettingsSave());
  await expect(optIn(page)).toBeEnabled();
  await expect(optIn(page)).not.toBeChecked();
  await expect(optIn(page)).toBeFocused();
  await expect(optIn(page)).not.toHaveAttribute('aria-busy');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(optIn(page)).toBeEnabled();
  await expect(optIn(page)).not.toBeChecked();
});
