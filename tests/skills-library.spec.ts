import { expect, test, type Page } from '@playwright/test';

/** The app's first boot under a loaded machine (4 workers, cold Vite): only the first readiness check waits this long. */
const BOOT_TIMEOUT = 20_000;

/* Settings → Tools → Rules & library, mounted on its own page over the preview library
 * (src/preview-skills.ts); the first test opens it through the real Settings navigation. */
async function open(page: Page): Promise<void> {
  await page.route('**/skills-library-harness.html', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="host" class="settings-page-root"></main>
      <script type="module">
        import { mountSkillsLibrary } from '/src/skills-library.ts';
        import { createPreviewSkills } from '/src/preview-skills.ts';
        const skills = createPreviewSkills();
        window.__skills = skills;
        window.__adds = [];
        window.addEventListener('pandacode:skill-manager-add', async () => {
          const { takeAddSkillRequest } = await import('/src/skill-manager-model.ts');
          window.__adds.push(takeAddSkillRequest());
        });
        window.__seen = [];
        const call = async (command, args = {}) => { window.__seen.push(command); return skills.call(command, args); };
        mountSkillsLibrary(document.getElementById('host'), { call, projects: () => [{ id: 'orbit', name: 'Orbit' }] });
      </script></body></html>`,
  }));
  await page.goto('/skills-library-harness.html');
  await expect(page.getByRole('list', { name: 'Bot library' })).toBeVisible({ timeout: BOOT_TIMEOUT });
}
/** A rule (list 'Rules') or a bot library skill (list 'Bot library'). */
const item = (page: Page, name: string) => page.locator('.skills-list .skills-item', { hasText: name });
const status = (page: Page, row: string, column: number) => page.getByRole('table', { name: 'Rules by harness' }).getByRole('row', { name: new RegExp(row) }).locator('td').nth(column);

test.describe('Rules & library', () => {
test('opens through real Settings navigation and agrees with the Skills page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: BOOT_TIMEOUT });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Rules & library', exact: true })).toBeVisible();
  const library = settings.getByRole('list', { name: 'Bot library' });
  await expect(library).toBeVisible();
  const notes = library.locator('.skills-item', { hasText: 'Release notes' });
  await expect(notes.getByRole('button', { name: /in Settings → Tools → Skills/ })).toHaveCount(0);

  // Its cross-link opens the Skills page; switching a skill off there tags it here.
  await settings.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  // Skills opens on the active thread's project (orbit); this check is about All projects.
  await expect(settings.getByRole('radio', { name: 'orbit', exact: true })).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('radio', { name: 'All projects', exact: true }).click();
  await settings.getByRole('switch', { name: 'release-notes in all projects', exact: true }).uncheck();
  await expect(settings.getByRole('switch', { name: 'release-notes in all projects', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  const tag = notes.getByRole('button', { name: 'Release notes is off in all projects in Settings → Tools → Skills' });
  await expect(tag).toHaveText('Off in Skills');
  // Off is blocked or asked depending on the agent: the tooltip never claims only 'asked'.
  await expect(tag).toHaveAttribute('title', 'Off in all projects in Settings → Tools → Skills: blocked or asked, per agent.');
  // One link to Skills, at the top, saying what the page holds; the rule import card has no second pointer.
  await expect(settings.locator('.skills-crosslink')).toHaveText('Import rules and turn them on per agent. The bot library holds skills for bots only. To add or switch skills, use Skills.');
  // Skills are added in one place: no catalogs here (Add skill takes repositories, URLs and folders).
  await expect(settings.getByRole('heading', { name: 'Catalogs' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Find my skill repositories' })).toHaveCount(0);
  await expect(settings.getByRole('textbox', { name: 'Catalog repository' })).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: 'Bot library' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Skills → Add skill' })).toHaveCount(0);
  await expect(settings.getByRole('form', { name: 'Import a rule' })).not.toContainText('Add skills');
  const add = page.getByRole('dialog', { name: 'Add skill' });
  // A library skill is read-only here: Install for agents… opens Add skill on the library's copy and finds it at once.
  await expect(notes.getByRole('checkbox')).toHaveCount(0);
  await notes.getByRole('button', { name: 'Install Release notes for agents…', exact: true }).click();
  await expect(add.getByRole('textbox', { name: 'Source' })).toHaveValue(/\/PandaCode\/skills\/release-notes$/);
  await expect(add.getByRole('checkbox', { name: /^release-notes/ })).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
  await add.getByRole('button', { name: 'Cancel' }).click();
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  await tag.click();
  await expect(settings.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`import controls stay readable and full height in ${theme}`, async ({ page }) => {
    await open(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const form = page.getByRole('form', { name: 'Import a rule' });
    const path = form.getByRole('textbox', { name: 'File path' });
    expect.soft((await path.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    // Rules only: skills are added in Skills → Add skill.
    await expect(form.getByRole('combobox')).toHaveCount(2);
    await expect(form.getByRole('combobox', { name: 'Kind' })).toHaveCount(0);
    // Rules are single files; both selects carry a visible label.
    await expect(form.getByRole('combobox', { name: 'Source', exact: true }).locator('option')).toHaveText(['Local file', 'GitHub repository']);
    for (const label of ['Source', 'Project scope']) await expect(form.locator('.skills-field > span', { hasText: label })).toBeVisible();
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
    await path.fill('/path/to/rule.md');
    await page.locator('.skills-library').screenshot({ path: `test-results/skills-import-${theme}.png` });
    await form.getByRole('combobox', { name: 'Source', exact: true }).selectOption('github');
    for (const input of await form.getByRole('textbox').all()) {
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    }
    await form.getByRole('combobox', { name: 'Project scope' }).selectOption('orbit');
    await expect(form.getByRole('combobox', { name: 'Project scope' })).toHaveValue('orbit');
  });
}

test('at 820px a long monospace source wraps after its separators, never mid-name', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  // Real Settings: the page's styles come with Settings (skill-manager.css), as in the app.
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: BOOT_TIMEOUT });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  const form = settings.getByRole('form', { name: 'Import a rule' });
  const path = '/Users/you/Documents/engineering-handbook/team-conventions/code-review/pull-request-review-checklist.md';
  await form.getByRole('textbox', { name: 'File path' }).fill(path);
  await form.getByRole('button', { name: 'Import' }).click();
  const source = item(page, 'pull-request-review-checklist').locator('.skills-source');
  await expect(source).toHaveText(path);
  // Each line ends at a separator: group the characters by their line and look at the last one of every line but the last.
  const ends = await source.evaluate(el => {
    const text = el.textContent ?? '', range = document.createRange(), tops: number[] = [];
    let offset = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent!.length; i++, offset++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        tops[offset] = Math.round(range.getBoundingClientRect().top);
      }
    }
    return tops.flatMap((top, i) => i + 1 < tops.length && tops[i + 1] > top ? [text[i]] : []);
  });
  expect(ends.length).toBeGreaterThan(0);
  for (const end of ends) expect(end).toBe('/');
  expect(await source.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(source).toHaveAttribute('title', path);
  await item(page, 'pull-request-review-checklist').screenshot({ path: 'test-results/skills-library-source-820.png' });
});

test('at 820px in dark a bot library source breaks only after a slash or before its commit', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.addInitScript(() => localStorage.setItem('pandacode.theme', 'dark'));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: BOOT_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  const source = settings.getByRole('list', { name: 'Bot library' }).locator('.skills-item', { hasText: 'Release notes' }).locator('.skills-source');
  await expect(source).toHaveText('GitHub · anthropics/skills/release-notes @ 9f3c2a1');
  await expect(source).toHaveAttribute('title', 'GitHub · anthropics/skills/release-notes @ 9f3c2a1');
  // The last character on every line but the last, and the first on every line but the first.
  const breaks = await source.evaluate(el => {
    const parts = [...el.querySelectorAll('.skills-source-part')].map(p => ({ text: p.textContent ?? '', top: Math.round(p.getBoundingClientRect().top) }));
    return parts.flatMap((p, i) => i + 1 < parts.length && parts[i + 1].top > p.top ? [[p.text, parts[i + 1].text]] : []);
  });
  expect(breaks.length).toBeGreaterThan(0);
  for (const [before, after] of breaks) expect(before.endsWith('/') || after.startsWith('@ ')).toBe(true);
  expect(await source.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await source.locator('xpath=ancestor::li[1]').screenshot({ path: 'test-results/skills-library-bot-source-820-dark.png' });
});

test('the import takes rules only; library skills are read-only with Install for agents…', async ({ page }) => {
  await open(page);
  const form = page.getByRole('form', { name: 'Import a rule' });
  // Skills are added on the Skills page; the one link there is the note at the top.
  await expect(page.getByRole('button', { name: 'Skills → Add skill', exact: true })).toHaveCount(0);
  await expect(page.locator('.skills-crosslink').getByRole('button', { name: 'Skills', exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Enter the rule file’s path.' })).toBeVisible();
  await form.getByRole('textbox', { name: 'File path' }).fill('/Users/you/rules/review-checklist.md');
  await form.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status')).toHaveText('Imported review-checklist.');
  await expect(item(page, 'review-checklist').locator('.skills-kind').first()).toHaveText('Rule');
  await expect(item(page, 'review-checklist').getByRole('checkbox', { name: 'review-checklist: Claude Code · User' })).toBeVisible();
  // A library skill has no per-agent boxes; Install for agents… asks the Skills page for Add skill on the library's copy.
  const notes = item(page, 'Release notes');
  await expect(notes.getByRole('checkbox')).toHaveCount(0);
  await notes.getByRole('button', { name: 'Install Release notes for agents…', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__adds)).toEqual([{ source: '/Users/you/Library/Application Support/PandaCode/skills/release-notes' }]);
  // One activated by an older build stays where it is: it says where it is in use and can't be removed here.
  await page.evaluate(() => (window as any).__skills.activate('release-notes', 'claude', 'user', null, false));
  await page.getByRole('combobox', { name: 'Project scope' }).selectOption('orbit');
  await expect(notes.locator('.skills-note')).toHaveText('In use by Claude Code. Switch it in Skills, or turn it off everywhere to remove it.');
  await expect(notes.getByRole('button', { name: 'Remove Release notes' })).toHaveCount(0);
  // Turn off everywhere asks first; Cancel leaves it in use.
  await notes.getByRole('button', { name: 'Turn Release notes off everywhere…' }).click();
  const confirm = notes.getByRole('group', { name: 'Turn Release notes off everywhere' });
  await expect(confirm).toContainText('Turn Release notes off for Claude Code in every scope?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(notes.locator('.skills-note')).toBeVisible();
  await notes.getByRole('button', { name: 'Turn Release notes off everywhere…' }).click();
  await notes.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Release notes is off everywhere. You can remove it now.');
  await expect(notes.locator('.skills-note')).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Remove Release notes' })).toBeVisible();
  // Installed skills are listed once, in Skills: the by-harness table and the on-disk card hold rules only.
  await expect(page.getByRole('table', { name: 'Rules by harness' }).getByRole('row', { name: /Release notes/ })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Rules found on disk' })).not.toContainText('pdf-tools');
  await expect(page.getByRole('list', { name: 'Rules found on disk' })).toContainText('~/.claude/rules/house-style.md');
  // Rules and bot library skills are listed apart.
  await expect(page.getByRole('list', { name: 'Rules' }).locator('.skills-item', { hasText: 'review-checklist' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Bot library' }).locator('.skills-item', { hasText: 'review-checklist' })).toHaveCount(0);
});

test('activating a rule for Claude Code and Codex shows in the matrix, and drift is reported', async ({ page }) => {
  await open(page);
  await page.getByRole('checkbox', { name: 'No force push: Claude Code · User' }).check();
  await expect(page.getByRole('status')).toHaveText('Active for Claude Code.');
  await page.getByRole('checkbox', { name: 'No force push: Codex · User' }).check();
  await expect(status(page, 'No force push', 0)).toHaveText('Active');
  await expect(status(page, 'No force push', 1)).toHaveText('Active');
  await expect(page.getByRole('list', { name: 'Rules found on disk' })).toContainText('~/.claude/rules/house-style.md');
  await expect(page.getByRole('list', { name: 'Rules found on disk' })).not.toContainText('pdf-tools');

  await page.evaluate(() => (window as any).__skills.edit('no-force-push', 'claude', 'user'));
  await page.getByRole('combobox', { name: 'Project scope' }).selectOption('orbit');
  await expect(status(page, 'No force push', 0)).toHaveText('Edited on disk');
  await page.getByRole('checkbox', { name: 'No force push: Claude Code · User' }).uncheck();
  await expect(page.getByRole('status')).toContainText('Left 1 edited file in place');
  await expect(page.getByRole('button', { name: 'Remove No force push' })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove No force push' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Turn No force push off everywhere' })).toBeVisible();
});

test('project-scope rules and safety findings need acknowledgement before activation', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Project scope' }).selectOption('orbit');
  await page.getByRole('checkbox', { name: 'No force push: Codex · Project' }).check();
  await expect(page.getByRole('status')).toHaveText('Active for Codex.');

  await page.getByRole('textbox', { name: 'File path' }).fill('/Users/you/rules/setup.md');
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

test('no catalogs: the page never reads them, and an empty bot library leaves its heading and intro line out', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('list', { name: 'Catalog sources' })).toHaveCount(0);
  await expect(page.locator('.skills-catalog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();
  // Removing the library's only skill takes the Bot library section and its intro sentence with it.
  await item(page, 'Release notes').getByRole('button', { name: 'Remove Release notes' }).click();
  await expect(page.getByRole('status')).toHaveText('Removed.');
  await expect(page.getByRole('list', { name: 'Bot library' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Bot library' })).toHaveCount(0);
  await expect(page.locator('.skills-crosslink')).toHaveText('Import rules and turn them on per agent. To add or switch skills, use Skills.');
  await expect(page.getByRole('list', { name: 'Rules' }).locator('.skills-item', { hasText: 'No force push' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__seen)).not.toContain('skills_catalogs');
});

test('Skills → Add skill → Bot library lands in the library here, for bots only', async ({ page }) => {
  // 'Bot library' is offered only to someone with a bot: the sample bots.
  await page.goto('/?bots=sample');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: BOOT_TIMEOUT });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await settings.locator('.skill-manager-bar').getByRole('button', { name: 'Add skill' }).click();
  const add = page.getByRole('dialog', { name: 'Add skill' });
  await add.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
  await add.getByRole('textbox', { name: 'Source' }).press('Enter');
  await add.getByRole('combobox', { name: 'Install to' }).selectOption({ label: 'Bot library' });
  await expect(add.locator('#skill-add-target-hint')).toHaveText('For bots; agents won’t see it.');
  await add.getByRole('button', { name: 'Install 2 skills' }).click();
  await expect(add).toBeHidden();
  await expect(settings.locator('.skill-manager-summary')).toContainText('Added 2 skills to the bot library.');
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  const library = settings.getByRole('list', { name: 'Bot library' });
  await expect(library.locator('.skills-item', { hasText: 'xlsx' })).toContainText('anthropics/skills');
  await expect(library.locator('.skills-item', { hasText: 'pptx' })).toBeVisible();
});
});
