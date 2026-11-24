import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectToken, expectSharedChevron, corners, expectRadius, expectNestedRadius, openWorkspace, openTaskMenu, expectSelectStates, codeRatio } from './design-roles-helpers';

// Controls: segmented weights, tabs, select chevrons (RTL, forced colours) and inline code.

/** Open the launcher and wait until Vite has injected `overlay.css`: WebKit can otherwise read
 * an unresolved `--ds-control-radius` or the pre-overlay select padding on the dev server. */
async function openLauncher(page: Page): Promise<void> {
  await page.goto('/?view=launcher', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-ready', '', { timeout: 30_000 });
  const project = page.locator('.launcher-project');
  await expect(project.locator('select')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => project.evaluate(el => {
    const cs = getComputedStyle(el), token = cs.getPropertyValue('--ds-control-radius').trim();
    // `.launcher-project` takes its control radius only from overlay.css.
    return token !== '' && parseFloat(cs.borderTopLeftRadius) > 0;
  }), { message: 'overlay.css applied to the launcher', timeout: 30_000 }).toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test(`design role: launcher project select and task radii in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
    await openLauncher(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const project = page.locator('.launcher-project');
    await expectSharedChevron(project.locator('select'));
    expect(await project.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');

    const area = page.locator('.launcher-task-area');
    const tasks = area.locator('.launcher-tasks');
    const task = tasks.locator('.launcher-task[data-task="preview-active"]');
    await expectNestedRadius(tasks, area, '--radius-inner', '--radius-card');
    await expectNestedRadius(task, tasks, '--radius-control', '--radius-inner');
    const highlight = await task.evaluate((el, props) => {
      const row = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      return {
        content: before.content,
        inset: [before.top, before.right, before.bottom, before.left],
        matchesRow: props.every(prop => before[prop] === row[prop]),
      };
    }, corners);
    expect(highlight).toEqual({ content: '""', inset: ['0px', '0px', '0px', '0px'], matchesRow: true });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`design role: single-line selects keep their shared chevron in ${theme} mode`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
    await page.goto('/?ds', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const gallery = page.locator('.ds-gallery');
    const galleryImage = await test.step('Design system gallery', () =>
      expectSelectStates(page, gallery.getByRole('combobox', { name: 'Select', exact: true })));

    await test.step('Generative UI form', async () => {
      await gallery.evaluate(async el => {
        const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
        const probe = document.createElement('div');
        probe.id = 'select-form-probe';
        probe.className = 'markdown';
        const fields = [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'group', label: 'Group', type: 'select', options: ['One', 'Two'] },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ];
        probe.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({ type: 'form', fields, submit: 'Save' }) + '\n```');
        el.append(probe);
      });
      const form = gallery.locator('#select-form-probe .gu-form');
      await expect(form.locator('textarea')).toBeVisible({ timeout: 30_000 });
      const input = form.locator('input');
      const select = form.locator('select');
      await expectRadius(input, '--radius-chip');
      await expect(select).toHaveCSS('border-radius', await input.evaluate(el => getComputedStyle(el).borderRadius));
      await expect(select).toHaveCSS('background-image', galleryImage);
    });

    await openWorkspace(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await test.step('Rename task dialog', async () => {
      await (await openTaskMenu(page)).click();
      const dialog = page.locator('#dialog[open]');
      await expect(dialog.locator('h2')).toHaveText('Rename task', { timeout: 30_000 });
      await dialog.evaluate(el => {
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Dialog select probe');
        select.add(new Option('One'));
        el.append(select);
      });
      const select = dialog.getByRole('combobox', { name: 'Dialog select probe', exact: true });
      await expectRadius(select, '--radius-chip');
      await expectSelectStates(page, select);
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step('Settings Voice', async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Voice', exact: true }).click();
      await expectSelectStates(page, page.locator('#settings-panel-voice select[data-voice-device]'));
    });
  });
}

test('design role: settings sub-form selects use body weight', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('#settings-page');
  await expect(settings).toBeVisible({ timeout: 30_000 });

  const expectSelectWeight = async (selects: Locator, label: string) => {
    await expect(selects.first()).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const count = await selects.count();
      expect(count, `${label} select count`).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const sel = selects.nth(i);
        if (await sel.isVisible()) {
          await expectToken(sel, 'fontWeight', '--type-body-weight');
          const weight = await sel.evaluate(el => getComputedStyle(el).fontWeight);
          expect(weight, `${label} select[${i}] must not inherit 500`).toBe('400');
        }
      }
    }).toPass({ timeout: 30_000 });
  };

  // Agent teams: New team form exposes effort selects inside subheading-weight labels.
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await settings.getByRole('tab', { name: 'Agent teams', exact: true }).click();
  await settings.getByRole('button', { name: 'New team' }).click();
  const teamBoxes = settings.getByRole('group', { name: 'Team models' }).getByRole('checkbox');
  await expect(teamBoxes.first()).toBeVisible({ timeout: 30_000 });
  await teamBoxes.nth(0).check();
  await teamBoxes.nth(1).check();
  await expectSelectWeight(settings.locator('#settings-panel-teams:not([hidden]) select'), 'Agent teams');

  // Schedules: New schedule form exposes thread and interval unit selects.
  await settings.getByRole('tab', { name: 'Schedules', exact: true }).click();
  await settings.locator('#settings-panel-schedules:not([hidden])').getByRole('button', { name: 'New schedule' }).first().click();
  await expectSelectWeight(settings.locator('#settings-panel-schedules:not([hidden]) select'), 'Schedules');

  // Rules & library: wait for async refresh() to settle before inspecting .skills-import selects.
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  await expect(settings.locator('#settings-panel-rules:not([hidden]) .skills-kind').first()).toBeVisible({ timeout: 30_000 });
  await expectSelectWeight(settings.locator('#settings-panel-rules:not([hidden]) .skills-import select'), 'Rules & library');

  // Cloud sandboxes: connected InstaBox card exposes machine image select.
  await settings.getByRole('tab', { name: 'Connections', exact: true }).click();
  const cloud = settings.getByRole('tabpanel', { name: 'Cloud sandboxes' });
  await expect(cloud).toBeVisible({ timeout: 30_000 });
  const more = cloud.locator('.cloud-more > summary');
  if (await more.isVisible()) await more.click();
  const instabox = cloud.locator('.cloud-provider[data-provider="instabox"]');
  await instabox.scrollIntoViewIfNeeded();
  await instabox.getByRole('button', { name: 'Connect instabox' }).click();
  await instabox.locator('input[name="key"]').fill('k');
  await instabox.getByRole('button', { name: 'Connect', exact: true }).click();
  await expectSelectWeight(instabox.locator('select'), 'Cloud sandboxes');
});

test('design role: Agent usage tabs stay regular weight while sidebar actions stay medium', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator('.sidebar .new-task-button')).toHaveCSS('font-weight', '500');
  await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  const inactive = dialog.locator('.usage-tabs > button[aria-selected="false"]');
  await expect(inactive.first()).toBeVisible();
  for (const button of await inactive.all()) await expect(button).toHaveCSS('font-weight', '400');
  await inactive.first().hover();
  await expect(inactive.first()).toHaveCSS('font-weight', '400');
  // Selection is carried by the thumb and colour, never weight (a bolder label widens the tab and shifts its siblings).
  await expect(dialog.locator('.usage-tabs > button[aria-selected="true"]')).toHaveCSS('font-weight', '400');
  for (const button of await dialog.locator('.usage-segmented > button:visible').all()) await expect(button).toHaveCSS('font-weight', '400');
  expect(await dialog.locator('.usage-segmented > button:visible').count()).toBeGreaterThan(0);
});

test('design role: RTL selects keep the shared chevron on the left in page, dialog and generated forms', async ({ page }) => {
  await page.goto('/?ds', { waitUntil: 'domcontentloaded' });
  const gallery = page.locator('.ds-gallery');
  await expect(gallery).toBeVisible();
  await page.evaluate(async () => {
    document.documentElement.dir = 'rtl';
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const host = document.createElement('div');
    host.id = 'design-role-rtl-form';
    host.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({
      type: 'form', fields: [{ name: 'group', label: 'Group', type: 'select', options: ['One', 'Two'] }], submit: 'Save',
    }) + '\n```');
    document.querySelector('.ds-gallery')!.append(host);
  });
  const expectLeftChevron = async (select: Locator) => {
    await expectSharedChevron(select);
    await expect(select).toHaveCSS('direction', 'rtl');
    await expect(select).toHaveCSS('background-position', /^(11px 50%|left 11px center)$/);
  };
  await expectLeftChevron(gallery.getByRole('combobox', { name: 'Select', exact: true }));
  await expectLeftChevron(page.locator('#design-role-rtl-form .gu-form select'));
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'design-role-rtl-dialog';
    dialog.innerHTML = '<div><select aria-label="RTL dialog select"><option>One</option></select></div>';
    document.body.append(dialog);
    dialog.showModal();
  });
  await expectLeftChevron(page.locator('#design-role-rtl-dialog select'));
});

test('design role: forced-colors selects restore native appearance and remove the chevron image', async ({ page, browserName }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/?ds', { waitUntil: 'domcontentloaded' });
  const supported = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
  test.skip(browserName === 'webkit' && !supported, 'WebKit does not emulate forced-colors on this platform');
  expect(supported, 'forced-colors emulation is active').toBe(true);
  const select = page.locator('.ds-gallery').getByRole('combobox', { name: 'Select', exact: true });
  await expect(select).toBeVisible();
  await expect(select).toHaveCSS('background-image', 'none');
  await expect(select).not.toHaveCSS('appearance', 'none');
});

test('design role: Round 5 rich-image steps, segment weights, inline code ratio and sheet gutter', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await Promise.all([
      '/src/github-hub.css', '/src/agent-input.css', '/src/rich-markdown.css', '/src/document-viewer.css',
      '/src/model-routing.css', '/src/office-viewer.css', '/src/settings.css', '/src/provider-settings.css',
    ].map(href => import(/* @vite-ignore */ href)));
    const host = document.createElement('div');
    host.id = 'design-role-r5';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    const image = '<span class="rich-image"><img alt="" style="width:24px;height:24px"></span>';
    host.innerHTML = `
      <label data-r5="agent" class="agent-input-option"><span class="markdown"><blockquote>Quote ${image}</blockquote></span></label>
      <div data-r5="gh" class="gh-job-summary markdown"><blockquote>Quote ${image}</blockquote></div>
      <div class="doc-view-switch"><button type="button" data-r5="doc-seg">Rendered</button><button type="button">Source</button></div>
      <div class="routing-modes"><button type="button" data-r5="routing-seg">Auto</button><button type="button">Manual</button></div>
      <details class="connection-card" open><summary>Card</summary><p>Copy <code data-r5-code="connection-card">CODE</code></p></details>
      <div class="inspector-empty"><p>Empty <code data-r5-code="inspector-empty">CODE</code></p></div>
      <div class="gh-empty"><p>Install <code data-r5-code="gh-empty">brew install gh</code></p></div>
      <div class="settings-provider-details"><span>Location</span><code data-r5-code="settings-provider-details">/usr/bin/claude</code></div>
      <div class="account-pool-confirm"><span>Confirm <code data-r5-code="account-pool-confirm">CODE</code></span></div>
      <div class="account-pool-command"><code data-r5-code="account-pool-command">claude login</code></div>
      <div class="connection-env-var"><code data-r5-code="connection-env-var">ANTHROPIC_API_KEY</code></div>
      <div class="markdown"><p>Prose <code data-r5-code="markdown-inline">CODE</code></p><pre><code data-r5-code="markdown-pre" data-r5-ratio="1">block</code></pre></div>
      <table class="sheet-grid"><thead><tr><th></th><th data-r5="sheet-col">A</th></tr></thead><tbody><tr><th data-r5="sheet-row">1</th><td>x</td></tr></tbody></table>`;
    document.body.append(host);
  });
  const r5 = (key: string) => page.locator(`#design-role-r5 [data-r5="${key}"]`);
  const px = (locator: Locator, prop: 'borderTopLeftRadius' | 'fontSize') => locator.evaluate((el, p) => parseFloat(getComputedStyle(el)[p]), prop);

  for (const context of ['agent', 'gh'] as const) {
    await test.step(`${context}: 8 -> 6 -> 2 rich image`, async () => {
      const outer = r5(context);
      const quote = outer.locator('blockquote');
      const img = quote.locator('.rich-image img');
      await expectRadius(outer, '--radius-control');
      await expectRadius(quote, '--radius-chip');
      await expectRadius(img, '--radius-hair');
      const steps = [await px(outer, 'borderTopLeftRadius'), await px(quote, 'borderTopLeftRadius'), await px(img, 'borderTopLeftRadius')];
      steps.forEach((value, index) => expect(value, `${context} step ${index}`).toBeCloseTo([8, 6, 2][index], 1));
    });
  }

  for (const key of ['doc-seg', 'routing-seg']) {
    await expect(r5(key)).toHaveCSS('font-weight', '400');
    await expectToken(r5(key), 'fontWeight', '--type-body-weight');
  }

  const codes = page.locator('#design-role-r5 [data-r5-code]');
  await expect(codes).toHaveCount(9);
  const ratios = await codes.evaluateAll(nodes => nodes.map(el => ({
    key: (el as HTMLElement).dataset.r5Code,
    want: Number((el as HTMLElement).dataset.r5Ratio ?? '0.9'),
    got: parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(el.parentElement!).fontSize),
  })));
  for (const { key, want, got } of ratios) {
    expect(Math.abs(got - want), `${key} code ratio ${got.toFixed(3)} != ${want.toFixed(3)}`).toBeLessThanOrEqual(0.02);
  }

  const col = r5('sheet-col');
  const row = r5('sheet-row');
  for (const cell of [col, row]) {
    expect(await px(cell, 'fontSize')).toBeCloseTo(11, 1);
    await expect(cell).toHaveCSS('font-weight', '500');
    await expectToken(cell, 'fontSize', '--type-caption');
    await expectToken(cell, 'lineHeight', '--type-caption-leading', true);
  }
});

test('design role: Round 6 meta-copy inline code keeps the 0.9 ratio', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await Promise.all(['/src/skill-manager.css', '/src/simulator.css', '/src/github-pull.css']
      .map(href => import(/* @vite-ignore */ href)));
    const host = document.createElement('div');
    host.id = 'design-role-r6-meta';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    host.innerHTML = `
      <div class="skill-row-confirm"><span data-r6-meta="skill-row-confirm">Remove <code>skill-a</code></span></div>
      <div class="skill-row-details"><ul class="skill-flags"><li data-r6-meta="skill-flags">Runs <code>curl</code></li></ul></div>
      <div class="skill-row-details"><p data-r6-meta="skill-row-details">Path <code>~/.claude/skills</code></p></div>
      <div class="sim-axe" data-r6-meta="sim-axe">Missing <code>aria-label</code></div>
      <ol class="pull-commits ds-card"><li class="ds-row"><span class="ds-row-main"><span class="pull-commit-meta ds-row-sub" data-r6-meta="pull-commit-meta"><code>abc1234</code> · you</span></span></li></ol>`;
    document.body.append(host);
  });
  const parents = page.locator('#design-role-r6-meta [data-r6-meta]');
  await expect(parents).toHaveCount(5);
  for (const parent of await parents.all()) {
    const key = await parent.getAttribute('data-r6-meta');
    expect(await parent.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), `${key} meta parent`).toBeCloseTo(12, 1);
    const code = parent.locator('code');
    expect(await code.evaluate(el => getComputedStyle(el).getPropertyValue('--code-inline-size').trim()), `${key} token`).toMatch(/^0?\.9em$/);
    const ratio = await codeRatio(code);
    expect(Math.abs(ratio - 0.9), `${key} code ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);
  }
});

test('design role: Round 6 forced-colors Jev run picker keeps the native select arrow', async ({ page, browserName }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openWorkspace(page);
  const supported = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
  test.skip(browserName === 'webkit' && !supported, 'WebKit does not emulate forced-colors on this platform');
  expect(supported, 'forced-colors emulation is active').toBe(true);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/jev-live.css');
    const host = document.createElement('div');
    host.id = 'design-role-r6-jev';
    host.style.cssText = 'position:fixed;inset:20px auto auto 20px;width:300px;z-index:999';
    host.innerHTML = '<div class="jev-live-run-picker"><select aria-label="Jev run"><option>Run 1</option><option>Run 2</option></select></div><select data-r6="plain" aria-label="Plain"><option>A</option></select>';
    document.body.append(host);
  });
  for (const select of [page.locator('#design-role-r6-jev .jev-live-run-picker select'), page.locator('#design-role-r6-jev [data-r6="plain"]')]) {
    await expect(select).toBeVisible();
    await expect(select).toHaveCSS('background-image', 'none');
    await expect(select).not.toHaveCSS('appearance', 'none');
  }
});

test('design role: Round 6 launcher project select uses the control radius', async ({ page }) => {
  await openLauncher(page);
  const select = page.locator('.launcher-project select');
  await expectRadius(select, '--ds-control-radius');
  await expect(select).toHaveCSS('border-radius', '8px');
});

test('design role: launcher project padding and chevron flip between LTR and RTL', async ({ page }) => {
  await openLauncher(page);
  const project = page.locator('.launcher-project');
  const select = project.locator('select');
  const expectSides = async (dir: 'ltr' | 'rtl', chevron: RegExp, selectPad: [string, string], projectPad: [string, string]) => {
    await expect(select).toHaveCSS('direction', dir);
    await expect(select).toHaveCSS('padding-left', selectPad[0]);
    await expect(select).toHaveCSS('padding-right', selectPad[1]);
    await expect(select).toHaveCSS('background-position', chevron);
    await expect(project).toHaveCSS('padding-left', projectPad[0]);
    await expect(project).toHaveCSS('padding-right', projectPad[1]);
  };
  await expect(select).toHaveCSS('padding-inline-start', '0px');
  await expect(select).toHaveCSS('padding-inline-end', '30px');
  await expectSides('ltr', /^(calc\(100% - 11px\) 50%|right 11px center|right 11px top 50%)$/, ['0px', '30px'], ['7px', '0px']);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expectSides('rtl', /^(11px 50%|left 11px center|left 11px top 50%)$/, ['30px', '0px'], ['0px', '7px']);
});

test('design role: Round 7 selected inspector tab and usage fix hint keep regular weight and the 0.9 ratio', async ({ page }) => {
  await openWorkspace(page);
  const selected = page.locator('#inspector .inspector-tab-button.selected').first();
  await expect(selected).toBeVisible({ timeout: 30_000 });
  await expect(selected).toHaveCSS('font-weight', '400');
  await expectToken(selected, 'fontWeight', '--type-body-weight');
  for (const tab of await page.locator('#inspector .inspector-tab-button:not(.selected):visible').all()) {
    await expect(tab).toHaveCSS('font-weight', '400');
  }

  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/agent-usage.css');
    const host = document.createElement('div');
    host.id = 'design-role-r7-usage';
    host.className = 'agent-usage';
    host.style.cssText = 'position:fixed;inset:20px auto auto 20px;width:320px;z-index:999;background:var(--bg)';
    host.innerHTML = '<div class="usage-notice"><p class="usage-fix-hint">Run <code>claude login</code> to sign in.</p></div>';
    document.body.append(host);
  });
  const hint = page.locator('#design-role-r7-usage .usage-fix-hint');
  await expect(hint).toBeVisible();
  const ratio = await codeRatio(hint.locator('code'));
  expect(Math.abs(ratio - 0.9), `usage fix hint code ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);
});

test('design role: Round 7 forced-colors Council segmented selection stays regular weight', async ({ page, browserName }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openWorkspace(page);
  const supported = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
  test.skip(browserName === 'webkit' && !supported, 'WebKit does not emulate forced-colors on this platform');
  expect(supported, 'forced-colors emulation is active').toBe(true);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/council.css');
    const host = document.createElement('div');
    host.id = 'design-role-r7-council';
    host.className = 'floating-menu council-panel';
    host.style.cssText = 'position:fixed;inset:20px auto auto 20px;width:320px;z-index:999';
    host.innerHTML = '<div class="council-field"><span id="r7-council-label">Reviewers</span><div class="ds-seg" role="group" aria-labelledby="r7-council-label"><button type="button" aria-pressed="true">Auto</button><button type="button" aria-pressed="false">2</button></div></div>';
    document.body.append(host);
  });
  const pressed = page.locator('#design-role-r7-council .ds-seg > button[aria-pressed="true"]');
  await expect(pressed).toBeVisible();
  await expect(pressed).toHaveCSS('font-weight', '400');
  await expect(page.locator('#design-role-r7-council .ds-seg > button[aria-pressed="false"]')).toHaveCSS('font-weight', '400');
});

type TabBox = { label: string; x: number; width: number; weight: string };

/** Every tab's label, x, width and weight in one frame; x is within the strip's scroll content, since clicks may scroll a strip. */
const tabBoxes = (tabs: Locator): Promise<TabBox[]> => tabs.evaluateAll(nodes => nodes.map(el => {
  const rect = el.getBoundingClientRect();
  const strip = el.parentElement!;
  const x = rect.x - strip.getBoundingClientRect().x + strip.scrollLeft;
  return { label: (el.textContent ?? '').trim(), x, width: rect.width, weight: getComputedStyle(el).fontWeight };
}));

/** Switching selection keeps every tab at 400 with no width or position jitter (<= 0.25px). */
async function expectStableTabs(tabs: Locator, name: string, state: 'aria-selected' | 'aria-checked' = 'aria-selected'): Promise<void> {
  await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
  const count = await tabs.count();
  expect(count, `${name} has tabs to switch`).toBeGreaterThan(1);
  // Read at rest: an opening popover or a press `scale` briefly changes the rects without moving the layout.
  const settled = (a: TabBox[], b: TabBox[]) => a.every((box, i) => Math.abs(box.width - b[i].width) <= 0.25 && Math.abs(box.x - b[i].x) <= 0.25);
  let before = await tabBoxes(tabs);
  await expect(async () => {
    const again = await tabBoxes(tabs);
    const same = settled(again, before);
    before = again;
    expect(same, `${name} at rest`).toBe(true);
  }).toPass({ timeout: 15_000 });
  for (const box of before) expect(box.weight, `${name} ${box.label} at rest`).toBe('400');
  const unselected = tabs.locator(`xpath=self::*[not(@${state}="true")]`);
  const order = [...Array(count).keys()];
  for (const index of [...order.slice(1), 0]) {
    const target = tabs.nth(index);
    await target.click();
    await expect(target).toHaveAttribute(state, 'true');
    await expect(target).toHaveCSS('font-weight', '400');
    for (const other of await unselected.all()) await expect(other).toHaveCSS('font-weight', '400');
    await expect(async () => {
      const after = await tabBoxes(tabs);
      for (const [i, box] of after.entries()) {
        expect(Math.abs(box.width - before[i].width), `${name} ${box.label} width after selecting #${index}`).toBeLessThanOrEqual(0.25);
        expect(Math.abs(box.x - before[i].x), `${name} ${box.label} x after selecting #${index}`).toBeLessThanOrEqual(0.25);
      }
    }).toPass({ timeout: 15_000 });
  }
}

test('design role: Round 8 GitHub and Agent usage tab bars stay regular weight without width or position jitter', async ({ page }) => {
  test.setTimeout(90_000);
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  await expectStableTabs(usage.locator('.usage-tabs > button'), '.usage-tabs');
  await page.keyboard.press('Escape');
  await expect(usage).toBeHidden();

  await page.getByRole('button', { name: /^Workspace view: / }).click();
  await page.getByRole('menuitemradio', { name: 'GitHub', exact: true }).click();
  const hub = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(hub).toBeVisible({ timeout: 30_000 });
  await expectStableTabs(hub.locator('.gh-tabs > button'), '.gh-tabs');
});

test('design role: multi-line selects grow past the control height and keep symmetric settings padding', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await Promise.all(['/src/settings.css', '/src/cloud-settings.css', '/src/remote-settings.css', '/src/skills-library.css']
      .map(href => import(/* @vite-ignore */ href)));
    const options = '<option>One</option><option>Two</option><option>Three</option><option>Four</option>';
    const sized = document.createElement('select');
    sized.id = 'design-role-select-size';
    sized.size = 4;
    sized.innerHTML = options;
    const root = document.createElement('div');
    root.className = 'settings-page-root';
    root.innerHTML = `<select id="design-role-select-multiple" multiple>${options}</select>`
      + `<select id="design-role-select-root-size" size="4">${options}</select>`
      + `<div id="design-role-select-root-hosts">${['cloud-image', 'remote-device-actions', 'skills-import'].map(name =>
        `<div class="${name}"><select data-sized size="4">${options}</select></div>`).join('')}</div>`;
    const hosts = document.createElement('div');
    hosts.id = 'design-role-select-hosts';
    hosts.innerHTML = ['cloud-image', 'remote-device-actions', 'skills-import'].map(name =>
      `<div class="${name}"><select data-single>${options}</select><select data-multiple multiple>${options}</select></div>`).join('');
    document.body.append(sized, root, hosts);
  });
  const sized = page.locator('#design-role-select-size');
  const multiple = page.locator('#design-role-select-multiple');
  for (const select of [sized, multiple]) {
    await expect(select).toBeVisible();
    await expect.poll(() => select.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(40);
    expect(await select.evaluate(el => getComputedStyle(el).height), 'not clipped to the control height').not.toBe('32px');
  }
  await expect(multiple).toHaveCSS('padding-inline-start', '10px');
  await expect(multiple).toHaveCSS('padding-inline-end', '10px');

  // Component selects: single-line ones hold the 32px control row; [multiple] ones grow with symmetric padding.
  for (const host of ['.cloud-image', '.remote-device-actions', '.skills-import']) {
    const single = page.locator(`#design-role-select-hosts ${host} > select[data-single]`);
    const many = page.locator(`#design-role-select-hosts ${host} > select[data-multiple]`);
    await expect.poll(() => single.evaluate(el => el.getBoundingClientRect().height), `${host} single height`).toBeGreaterThanOrEqual(31);
    expect(await single.evaluate(el => el.getBoundingClientRect().height), `${host} single height`).toBeLessThanOrEqual(33);
    expect(await single.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineEnd)), `${host} chevron room`).toBeGreaterThanOrEqual(30);
    await expect.poll(() => many.evaluate(el => el.getBoundingClientRect().height), `${host} multiple height`).toBeGreaterThan(48);
    const pad = await many.evaluate(el => [getComputedStyle(el).paddingInlineStart, getComputedStyle(el).paddingInlineEnd]);
    expect(pad[1], `${host} multiple symmetric padding`).toBe(pad[0]);
    const block = await many.evaluate(el => [parseFloat(getComputedStyle(el).paddingTop), parseFloat(getComputedStyle(el).paddingBottom)]);
    expect(block[0], `${host} multiple top padding`).toBeGreaterThanOrEqual(4);
    expect(block[1], `${host} multiple bottom padding`).toBeGreaterThanOrEqual(4);
  }

  // [size="4"] listboxes inside Settings read like [multiple] ones: 4px block padding, symmetric inline padding.
  const sizedInSettings = ['#design-role-select-root-size', ...['.cloud-image', '.remote-device-actions', '.skills-import']
    .map(host => `#design-role-select-root-hosts ${host} > select[data-sized]`)];
  for (const selector of sizedInSettings) {
    const listbox = page.locator(selector);
    await expect(listbox).toBeVisible();
    await expect.poll(() => listbox.evaluate(el => el.getBoundingClientRect().height), `${selector} height`).toBeGreaterThan(48);
    const box = await listbox.evaluate(el => {
      const style = getComputedStyle(el);
      return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom), start: style.paddingInlineStart, end: style.paddingInlineEnd };
    });
    expect(box.top, `${selector} top padding`).toBeGreaterThanOrEqual(4);
    expect(box.bottom, `${selector} bottom padding`).toBeGreaterThanOrEqual(4);
    expect(box.end, `${selector} symmetric padding`).toBe(box.start);
  }
});

test('design role: a narrow sidebar keeps the unread dot and folds read indicators away', async ({ page }) => {
  await page.goto('/?sections', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#navigation .task-item.unread').first()).toBeVisible({ timeout: 30_000 });
  // 200px is inside `@container sidebar (max-width:219px)`.
  await page.locator('.workspace > .sidebar').evaluate(el => {
    (el as HTMLElement).style.cssText += ';width:200px;min-width:200px;max-width:200px;flex:none';
  });
  await expect.poll(() => page.locator('.workspace > .sidebar').evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(219);
  const unread = page.locator('#navigation .task-item.unread:not(.task-oneline) > .task-head > .task-indicator.unread').first();
  await expect(unread).toHaveCSS('width', '6px');
  expect(await unread.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const read = page.locator('#navigation .task-item:not(.task-oneline):not(.unread) > .task-head > .task-indicator:not(.unread)').first();
  await expect(read).toHaveCSS('width', '0px');
});

/** Body size, regular weight and body leading, resolved from the tokens. */
async function expectBodySegment(button: Locator, leading = true): Promise<void> {
  await expect(button).toHaveCSS('font-weight', '400');
  await expectToken(button, 'fontWeight', '--type-body-weight');
  if (!leading) return;
  await expectToken(button, 'fontSize', '--type-body');
  await expectToken(button, 'lineHeight', '--type-body-leading', true);
}

test('design role: Token saver intensity segments stay regular body weight and leading without jitter', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.locator('[data-action="token-saver"]').first().click();
  const panel = page.locator('.saver-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const caveman = panel.locator('.saver-switch[data-pack="caveman"]');
  if (await caveman.getAttribute('aria-checked') !== 'true') await caveman.click();
  await expect(caveman).toHaveAttribute('aria-checked', 'true');
  const levels = panel.locator('.saver-levels');
  await expect(levels).toHaveAttribute('data-segmented', '');
  await expect(levels.locator('.segment-thumb')).toHaveCount(1);
  const buttons = levels.locator(':scope > button');
  await expect(buttons.locator('xpath=self::*[@aria-checked="true"]')).toHaveCount(1);
  await expect(buttons.locator('xpath=self::*[@aria-checked="false"]').first()).toBeVisible();
  for (const button of await buttons.all()) {
    await expect(button).toHaveAttribute('role', 'radio');
    await expectBodySegment(button);
  }
  await expectStableTabs(buttons, '.saver-levels', 'aria-checked');
});

test('design role: import, document, routing, choice-menu and horizontal bot segments stay regular weight', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await Promise.all(['/src/conversation-import.css', '/src/document-viewer.css', '/src/model-routing.css', '/src/sidebar-tree.css', '/src/bots-settings.css']
      .map(href => import(/* @vite-ignore */ href)));
    const host = document.createElement('div');
    host.id = 'design-role-r13-seg';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    host.innerHTML = `
      <div class="import-sources" role="group" aria-label="Import from"><button type="button" aria-pressed="true"><span>Claude</span></button><button type="button" aria-pressed="false"><span>Codex</span></button></div>
      <div class="doc-view-switch"><button type="button" aria-pressed="true">Rendered</button><button type="button" aria-pressed="false">Source</button></div>
      <div class="routing-modes"><button type="button" class="selected">Auto</button><button type="button">Manual</button></div>
      <div class="floating-menu choice-menu"><div class="choice-menu-segments" role="group" aria-label="Columns"><span class="choice-menu-label" aria-hidden="true">Columns</span><span class="choice-menu-segment-list"><button type="button" class="choice-menu-option choice-menu-segment selected" role="menuitemradio" aria-checked="true">1</button><button type="button" class="choice-menu-option choice-menu-segment" role="menuitemradio" aria-checked="false">2</button></span></div></div>
      <div class="bots"><div class="bs-body"><div class="bs-nav" role="tablist" aria-label="Bot settings"><button type="button" role="tab" aria-selected="true"><span>General</span></button><button type="button" role="tab" aria-selected="false"><span>Rules</span></button></div></div></div>`;
    document.body.append(host);
  });
  const host = page.locator('#design-role-r13-seg');
  const groups: [string, number, boolean][] = [
    ['.import-sources > button', 2, true],
    ['.doc-view-switch > button', 2, true],
    ['.routing-modes > button', 2, true],
    ['.choice-menu-segment-list > .choice-menu-segment', 2, false],
  ];
  for (const [selector, count, leading] of groups) {
    const buttons = host.locator(selector);
    await expect(buttons, selector).toHaveCount(count);
    for (const button of await buttons.all()) await expectBodySegment(button, leading);
  }
  await expect(host.locator('.import-sources > button[aria-pressed="true"]')).toHaveCSS('font-weight', '400');
  await expect(host.locator('.choice-menu-segment[aria-checked="true"]')).toHaveCSS('font-weight', '400');
  const nav = host.locator('.bots:not(.bots-single) .bs-nav');
  await expect(nav).toHaveCSS('display', 'flex');
  await expect(nav).toHaveCSS('flex-direction', 'row');
  await expect(nav).toHaveCSS('padding-top', '2px');
  await expect(nav.locator(':scope > button[aria-selected="true"]')).toHaveCSS('font-weight', '400');
  await expect(nav.locator(':scope > button[aria-selected="false"]')).toHaveCSS('font-weight', '400');

  // Structural reset: a segmented track inside a bold ancestor still renders regular-weight options.
  await page.evaluate(() => {
    const bold = document.createElement('div');
    bold.id = 'design-role-bold-seg';
    bold.style.fontWeight = '600';
    bold.innerHTML = `
      <div class="ds-seg" role="group" aria-label="Plain"><button type="button" aria-pressed="true">One</button><button type="button" aria-pressed="false">Two</button></div>
      <div data-segmented="" role="group" aria-label="Tagged"><button type="button" aria-pressed="true">One</button><button type="button" aria-pressed="false">Two</button></div>`;
    document.body.append(bold);
  });
  const boldHost = page.locator('#design-role-bold-seg');
  await expect(boldHost).toHaveCSS('font-weight', '600');
  for (const track of ['.ds-seg', '[data-segmented]']) {
    const buttons = boldHost.locator(`${track} > button`);
    await expect(buttons, track).toHaveCount(2);
    for (const button of await buttons.all()) await expect(button, track).toHaveCSS('font-weight', '400');
  }
});

test('design role: forced-colors launcher project select keeps the shared 8px inline-end padding', async ({ page, browserName }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openLauncher(page);
  const supported = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
  test.skip(browserName === 'webkit' && !supported, 'WebKit does not emulate forced-colors on this platform');
  expect(supported, 'forced-colors emulation is active').toBe(true);
  const select = page.locator('.launcher-project select');
  await expect(select).toHaveCSS('background-image', 'none');
  await expect(select).not.toHaveCSS('appearance', 'none');
  // WebKit's native menulist theme owns select padding (an authored 8px computes to 0px there), so only Chromium
  // can show the shared rule's exact 8px; both must drop the 30px chevron reservation.
  if (browserName !== 'webkit') await expect(select).toHaveCSS('padding-inline-end', '8px');
  expect(await select.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineEnd)), 'no chevron reservation').toBeLessThanOrEqual(8);
});
