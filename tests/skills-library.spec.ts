import { expect, test, type Page } from '@playwright/test';

/* Settings → Skills & rules, mounted on its own page over the preview library
 * (src/preview-skills.ts), so it runs whether or not Settings has wired the section yet. */
async function open(page: Page): Promise<void> {
  await page.route('**/skills-library-harness.html', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="host" class="settings-page-root"></main>
      <script type="module">
        import { mountSkillsLibrary } from '/src/skills-library.ts';
        import { createPreviewSkills } from '/src/preview-skills.ts';
        const skills = createPreviewSkills();
        window.__skills = skills;
        const call = async (command, args = {}) => skills.call(command, args);
        mountSkillsLibrary(document.getElementById('host'), { call, projects: () => [{ id: 'orbit', name: 'Orbit' }] });
      </script></body></html>`,
  }));
  await page.goto('/skills-library-harness.html');
  await expect(page.getByRole('list', { name: 'Library' })).toBeVisible();
}
const item = (page: Page, name: string) => page.getByRole('list', { name: 'Library' }).locator('.skills-item', { hasText: name });
const status = (page: Page, row: string, column: number) => page.getByRole('table', { name: 'Skills by harness' }).getByRole('row', { name: new RegExp(row) }).locator('td').nth(column);

test.describe('Skills & rules', () => {
for (const theme of ['light', 'dark']) {
  test(`import controls stay readable and full height in ${theme}`, async ({ page }) => {
    await open(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const form = page.getByRole('form', { name: 'Import a skill or rule' });
    const path = form.getByRole('textbox', { name: 'Folder or file path' });
    expect.soft((await path.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    await expect(form.getByRole('combobox')).toHaveCount(3);
    for (const select of await form.getByRole('combobox').all()) {
      const colors = await select.locator('option').evaluateAll(options => options.map(option => {
        const probe = document.createElement('span');
        probe.style.cssText = 'background:var(--panel);color:var(--text)';
        option.closest('form')!.append(probe);
        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(option);
        const colors = { background: actual.backgroundColor, text: actual.color, panel: expected.backgroundColor, foreground: expected.color };
        probe.remove();
        return colors;
      }));
      for (const color of colors) {
        expect(color.background).toBe(color.panel);
        expect(color.text).toBe(color.foreground);
      }
    }
    await path.fill('/path/to/skill-folder');
    await form.screenshot({ path: `test-results/skills-import-${theme}.png` });
    await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('rule');
    await expect(form.getByRole('combobox', { name: 'Kind', exact: true })).toHaveValue('rule');
    await form.getByRole('combobox', { name: 'Source', exact: true }).selectOption('github');
    for (const input of await form.getByRole('textbox').all()) {
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    }
    await form.getByRole('combobox', { name: 'Project for project scope' }).selectOption('orbit');
    await expect(form.getByRole('combobox', { name: 'Project for project scope' })).toHaveValue('orbit');
  });
}

test('activating a skill for Claude Code and Codex shows in the matrix, and drift is reported', async ({ page }) => {
  await open(page);
  await page.getByRole('checkbox', { name: 'Release notes: Claude Code · User' }).check();
  await expect(page.getByRole('status')).toHaveText('Active for Claude Code.');
  await page.getByRole('checkbox', { name: 'Release notes: Codex · User' }).check();
  await expect(status(page, 'Release notes', 0)).toHaveText('Active');
  await expect(status(page, 'Release notes', 1)).toHaveText('Active');
  await expect(page.locator('.skills-unmanaged')).toContainText('~/.claude/skills/pdf-tools');

  await page.evaluate(() => (window as any).__skills.edit('release-notes', 'claude', 'user'));
  await page.getByRole('combobox', { name: 'Project for project scope' }).selectOption('orbit');
  await expect(status(page, 'Release notes', 0)).toHaveText('Edited on disk');
  await page.getByRole('checkbox', { name: 'Release notes: Claude Code · User' }).uncheck();
  await expect(page.getByRole('status')).toContainText('Left 1 edited file in place');
  await expect(page.getByRole('button', { name: 'Remove Release notes' })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove Release notes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Turn Release notes off everywhere' })).toBeVisible();
});

test('project-scope rules and safety findings need acknowledgement before activation', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Project for project scope' }).selectOption('orbit');
  await page.getByRole('checkbox', { name: 'No force push: Codex · Project' }).check();
  await expect(page.getByRole('status')).toHaveText('Active for Codex.');

  await page.getByRole('textbox', { name: 'Folder or file path' }).fill('/Users/you/skills/setup');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status')).toHaveText('Imported setup. 1 safety finding to review.');
  await expect(page.getByRole('list', { name: 'Safety findings for setup' })).toContainText('Download piped into a shell');
  const toggle = page.getByRole('checkbox', { name: 'setup: Claude Code · User' });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await item(page, 'setup').getByRole('button', { name: 'Activate anyway' }).click();
  await expect(page.getByRole('checkbox', { name: 'setup: Claude Code · User' })).toBeChecked();
});

test('GitHub import validates the repository and records the commit', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Source' }).selectOption('github');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'owner/name' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill('acme/skills');
  await page.getByRole('textbox', { name: 'Path in repository' }).fill('skills/pdf');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(item(page, 'pdf')).toContainText('GitHub · acme/skills/skills/pdf @ a1b2c3d');
  await expect(page.getByRole('textbox', { name: 'Repository', exact: true })).toHaveValue('');
});

test('discovery registers only skill repositories, shows name conflicts, and importing never activates', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__skills.failNext('GitHub\'s rate limit was reached. Try again later.'));
  await page.getByRole('button', { name: 'Find my skill repositories' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'rate limit' })).toBeVisible();

  await page.getByRole('button', { name: 'Find my skill repositories' }).click();
  await expect(page.getByRole('status')).toHaveText('Added you/agent-skills.');
  const sources = page.getByRole('list', { name: 'Catalog sources' });
  await expect(sources.locator('.skills-catalog')).toHaveCount(1);
  await expect(sources).not.toContainText('you/skills-wishlist');
  const source = page.locator('.skills-catalog[data-repo="you/agent-skills"]');
  await expect(source).toContainText('Discovered');
  await expect(source).toContainText('Private');
  await expect(source.locator('.skills-catalog-skill', { hasText: 'Release notes' })).toContainText('Same name in anthropics/skills/release-notes');

  await page.getByRole('checkbox', { name: 'Select Changelog from you/agent-skills' }).check();
  await page.getByRole('button', { name: 'Import selected from you/agent-skills' }).click();
  await expect(page.getByRole('status')).toHaveText('Imported 1 skill. Nothing is active until you turn it on.');
  await expect(item(page, 'Changelog')).toContainText('GitHub · you/agent-skills/skills/changelog @ 5e6f7a8');
  await expect(page.getByRole('checkbox', { name: 'Changelog: Claude Code · User' })).not.toBeChecked();
  await expect(source.locator('.skills-catalog-skill', { hasText: 'Changelog' })).toContainText('In the library');

  await page.getByRole('button', { name: 'Import all from you/agent-skills' }).click();
  await expect(page.getByRole('status')).toContainText('Imported 2 skills. Skipped 1: release-notes is already in the library from anthropics/skills/release-notes.');
  await expect(item(page, 'Release notes')).toContainText('anthropics/skills/release-notes');

  await page.getByRole('button', { name: 'Ignore you/agent-skills' }).click();
  await expect(page.getByRole('list', { name: 'Ignored sources' })).toContainText('you/agent-skills');
  await page.getByRole('button', { name: 'Find my skill repositories' }).click();
  await expect(page.getByRole('status')).toHaveText('No new skill repositories found.');
  await expect(page.getByRole('list', { name: 'Catalog sources' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop ignoring you/agent-skills' }).click();
  await page.getByRole('button', { name: 'Disable you/agent-skills' }).click();
  await expect(source).toContainText('Disabled');
  await expect(page.getByRole('button', { name: 'Import all from you/agent-skills' })).toHaveCount(0);
});

test('a pstack-sized collection is scanned as a catalog and imports past 64 files in total', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Catalog repository' }).fill('acme/nope');
  await page.getByRole('button', { name: 'Scan' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not found, or your GitHub login cannot read it' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Catalog repository' }).fill('https://github.com/acme/pstack');
  await page.getByRole('button', { name: 'Scan' }).click();
  await expect(page.getByRole('status')).toHaveText('Found 40 skills in acme/pstack.');
  await expect(page.getByRole('list', { name: 'Skills in acme/pstack' }).getByRole('listitem')).toHaveCount(40);
  await page.getByRole('button', { name: 'Import all from acme/pstack' }).click();
  await expect(page.getByRole('status')).toHaveText('Imported 40 skills. Nothing is active until you turn it on.');
  await expect(page.getByRole('list', { name: 'Library' }).locator('.skills-item')).toHaveCount(42);
  await page.getByRole('button', { name: 'Refresh acme/pstack' }).click();
  await expect(page.getByRole('status')).toHaveText('Refreshed acme/pstack. Library copies stay as imported.');
});
});

test('OpenAI Compatible skills and rules can be enabled without a CLI', async ({ page }) => {
  await open(page);
  const toggle = page.getByRole('checkbox', { name: 'Release notes: OpenAI Compatible · User', exact: true });
  await expect(toggle).toBeVisible(); await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('status')).toContainText('adds this to its messages');
  await expect(page.getByRole('columnheader', { name: /OpenAI Compatible/ })).toBeVisible();
  await toggle.uncheck(); await expect(toggle).not.toBeChecked();
});
