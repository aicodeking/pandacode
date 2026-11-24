import { expect, test, type Locator } from '@playwright/test';
import { expectToken, expectRole, expectLeading, expectRadius, expectNestedRadius, openWorkspace, openTaskMenu, openModelPicker } from './design-roles-helpers';

// Core type roles: scale, weights, leading, tracking, 1.6x scaling and page surfaces.

test('design role: radius guard checks every corner', async ({ page }) => {
  await page.setContent('<style>:root{--radius-control:8px}div{width:20px;height:20px;border-radius:var(--radius-control)}</style><div></div>');
  const probe = page.locator('div');
  await expectRadius(probe, '--radius-control');
  for (const prop of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const) {
    await probe.evaluate((el, property) => { (el as HTMLElement).style[property] = '0px'; }, prop);
    await expect(expectRadius(probe, '--radius-control')).rejects.toThrow(prop);
    await probe.evaluate(el => { (el as HTMLElement).style.borderRadius = 'var(--radius-control)'; });
  }
  await expectRadius(probe, '--radius-control');
  await probe.evaluate(el => { (el as HTMLElement).style.borderStartStartRadius = '8px 6px'; });
  await expect(expectRadius(probe, '--radius-control')).rejects.toThrow('elliptical 8px 6px != 8px');
});

test('design role: typography follows the tokens at 160 percent', async ({ page }) => {
  test.setTimeout(120_000);
  await openWorkspace(page, '/?trace');
  await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.6'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6', { timeout: 30_000 });
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Polish the trace view', { timeout: 30_000 });

  const activity = page.locator('#transcript details.turn-activity').first();
  const summary = activity.locator(':scope > summary');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  if (await activity.getAttribute('open') === null) await summary.click();
  await expect(activity).toHaveAttribute('open', '');
  const group = activity.locator('details.tool-group').first();
  const groupSummary = group.locator(':scope > summary:visible');
  if (await groupSummary.count() && await group.getAttribute('open') === null) await groupSummary.click();
  const traceChip = activity.locator('.tool-trace-chip:visible').first();
  await expect(traceChip).toBeVisible({ timeout: 30_000 });
  await expectRole(traceChip, 'meta');

  const rename = await openTaskMenu(page);
  await expectRole(rename.locator('.choice-menu-label'), 'body');
  await rename.press('Escape');
  await expect(rename).toBeHidden();

  const picker = await openModelPicker(page);
  const harness = picker.getByRole('tab', { name: 'Claude Code', exact: true });
  await expect(harness).toHaveAttribute('aria-selected', 'true');
  await expectRole(harness.locator('.model-menu-tab-label'), 'body', '--weight-medium');
  const effort = picker.getByRole('radiogroup', { name: 'Effort', exact: true }).getByRole('radio');
  await expect(effort.first()).toBeVisible({ timeout: 30_000 });
  for (const segment of await effort.all()) await expectRole(segment, 'body');

  const inspectorLabel = page.locator('#inspector .inspector-tab-button.selected .inspector-tab-label');
  await expectRole(inspectorLabel, 'body', '', false, { leading: '--control' });

  await page.evaluate(() => (window as any).__previewEmit('bot-notification', { botId: 'b', text: 'Toast' }));
  const toast = page.locator('.toast').filter({ hasText: /^Toast$/ });
  await expectRole(toast, 'body');

  await page.goto('/tool-trace-gallery.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { await import(/* @vite-ignore */ '/src/ui-size.ts'); });
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6', { timeout: 30_000 });
  const caps = page.locator('#gallery h2').first();
  await expectRole(caps, 'caption', '--weight-strong', false, { tracking: '--tracking-caps' });
  await expect(caps).toHaveCSS('text-transform', 'uppercase');
});

test('design role: weights follow the kind of text at default scale', async ({ page }) => {
  test.setTimeout(120_000);
  await openWorkspace(page, '/?sections&teams');
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1');
  await expectRole(page.locator('.section-count:visible').first(), 'caption');
  const task = page.locator('.sidebar .task-item.selected');
  await expectToken(task.locator('.task-title'), 'fontWeight', '--weight-medium');
  await expectToken(task.locator('.task-checkout'), 'fontWeight', '--weight-regular');
  await expectToken(task.locator('.task-age'), 'fontWeight', '--weight-regular');
  const status = page.locator('.task-item[data-id="sections-approval"] .task-status');
  await expectRole(status, 'caption');

  const inspector = page.locator('#inspector');
  const changes = inspector.getByRole('tab', { name: /^Changes\b/ });
  const changesLabel = changes.locator('.inspector-tab-label');
  const badge = changes.locator('.inspector-tab-count');
  await expect(badge).toHaveText(/^\d+$/, { timeout: 30_000 });
  await expectToken(badge, 'fontSize', '--type-caption');
  await expectToken(badge, 'fontWeight', '--weight-medium');
  await inspector.locator('[data-action="inspector-add-tab"]').click();
  await page.getByRole('menu', { name: 'Open view' }).getByRole('menuitem', { name: 'Files', exact: true }).click();
  await expect(changes).toHaveAttribute('aria-selected', 'false');
  await expectToken(changesLabel, 'fontWeight', '--weight-regular');
  await changes.click();
  await expect(changes).toHaveAttribute('aria-selected', 'true');
  // Selection is shown by the raised fill, never a heavier weight that would shift the tab's width.
  await expectToken(changesLabel, 'fontWeight', '--weight-regular');

  const rename = await openTaskMenu(page);
  await expectToken(rename.locator('.choice-menu-label'), 'fontWeight', '--weight-regular');
  await rename.press('Escape');
  await expect(rename).toBeHidden();
  const picker = await openModelPicker(page);
  await expectToken(picker.locator('.model-menu-option:not(.model-menu-current) .model-menu-name').first(), 'fontWeight', '--weight-regular');
  const teams = picker.getByRole('tab', { name: /^Teams, \d/ });
  const modelCount = teams.locator('.model-menu-count');
  for (const selected of ['false', 'true']) {
    if (selected === 'true') await teams.click();
    await expect(teams).toHaveAttribute('aria-selected', selected);
    await expectRole(modelCount, 'caption');
  }

  await page.goto('/?ds', { waitUntil: 'domcontentloaded' });
  const gallery = page.locator('.ds-gallery');
  await expectRole(gallery.locator('.ds-btn').first(), 'body', '--weight-medium');
  const segments = gallery.locator('.ds-seg').first().locator('button');
  await expect(segments.first()).toBeVisible({ timeout: 30_000 });
  for (const segment of await segments.all()) await expectRole(segment, 'body');
});

test('design role: main window type', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  const task = page.locator('.sidebar .task-item.selected');
  await expectRole(task.locator('.task-title'), 'subheading');
  // The open preview task is a Finished card: checkout is the meta label, age is the caption.
  await expectLeading(task.locator('.task-checkout'), '--type-meta-leading');
  await expectLeading(task.locator('.task-age'), '--type-caption-leading');
  const prose = page.locator('.message-content').first();
  await expect(prose).toBeVisible({ timeout: 30_000 });
  await expectLeading(prose, '--type-prose-leading');
  // The preview reply always includes this phrase. The turn card clips it, so it stays attached rather than visible.
  const strong = page.locator('.markdown strong').filter({ hasText: 'One index per dataset.' });
  await expect(strong).toBeAttached({ timeout: 30_000 });
  await expectToken(strong, 'fontWeight', '--weight-strong');
});

test('design role: composer follows conversation prose in normal and compact mode', async ({ page }) => {
  await openWorkspace(page);
  const prompt = page.locator('#prompt');
  for (const compact of [false, true]) {
    await page.evaluate(value => document.body.classList.toggle('compact', value), compact);
    await expectRole(prompt, 'prose');
    const size = await prompt.evaluate(el => {
      const style = getComputedStyle(el);
      return [parseFloat(style.fontSize), parseFloat(style.lineHeight)];
    });
    expect(size[0]).toBeCloseTo(16, 2);
    expect(size[1]).toBeCloseTo(25.6, 2);
  }
  await page.locator('.conversation-pane').evaluate(el => (el as HTMLElement).style.setProperty('--thread-font', 'var(--type-meta)'));
  await expectToken(prompt, 'fontSize', '--type-meta');
  await expectLeading(prompt, '--type-prose-leading');
  await expectLeading(page.locator('.message-meta time').first(), '--type-caption-leading');
});

test('design role: dialog type and radius', async ({ page }) => {
  test.setTimeout(120_000);
  await openWorkspace(page);
  await (await openTaskMenu(page)).click();
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('h2')).toHaveText('Rename task', { timeout: 30_000 });
  await expectRole(dialog.locator('h2'), 'title');
  // Cancel in the footer shares data-action="close-dialog" with the heading icon. Name each control.
  await expectRadius(dialog.getByRole('button', { name: 'Close dialog', exact: true }), '--ds-control-radius');
  const plate = page.locator('.dialog-plate');
  await expectRadius(plate, '--radius-card');
  await expectLeading(dialog.getByRole('button', { name: 'Cancel', exact: true }), '--type-body-leading');
  // The same probes inherit different role values when mounted inside the dialog.
  for (const modal of [true, false]) {
    if (!modal) {
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    const parent = modal ? dialog : page.locator('body');
    await parent.evaluate(async el => {
      await import(/* @vite-ignore */ '/src/settings.css');
      const host = document.createElement('div');
      host.dataset.dialogRadiusProbes = '';
      host.className = 'settings-page-root';
      host.innerHTML = `
        <div class="ds-card"><div class="ds-card-inner">Inset card</div></div>
        <div class="ds-row">Row</div>
        <button class="ds-btn">Button</button>
        <input type="text" aria-label="Probe field">
        <div class="ds-seg"><span class="segment-thumb">Thumb</span><button>Segment</button></div>
        <div class="ds-btn-split"><button class="ds-btn">First</button><button class="ds-btn">Second</button></div>
        <div class="settings-group">Settings group</div>
      `;
      el.append(host);
    });
    const probes = parent.locator(':scope > [data-dialog-radius-probes]');
    const card = probes.locator('.ds-card');
    const segment = probes.locator('.ds-seg');
    const control = '--ds-control-radius';
    const inner = '--ds-inner-radius';
    const cardRole = '--ds-card-radius';
    const hair = '--radius-hair';
    await expectNestedRadius(card.locator('.ds-card-inner'), card, inner, cardRole);
    await expectRadius(probes.locator('.settings-group'), cardRole);
    await expectNestedRadius(segment.locator('.segment-thumb'), segment, control, inner);
    for (const selector of [':scope > .ds-btn', '.ds-row', 'input', '.ds-seg button']) {
      await expectRadius(probes.locator(selector), control);
    }
    const halves = probes.locator('.ds-btn-split .ds-btn');
    await expectRadius(halves.nth(0), control, hair, hair, control);
    await expectRadius(halves.nth(1), hair, control, control, hair);
    const resolvedRoles = await probes.evaluate((el, roles) => {
      const style = getComputedStyle(el);
      return roles.map(role => style.getPropertyValue(role).trim());
    }, [cardRole, inner, control]);
    const expectedRoles = await page.locator('html').evaluate((el, tokens) => {
      const style = getComputedStyle(el);
      return tokens.map(token => style.getPropertyValue(token).trim());
    }, modal ? ['--radius-inner', '--radius-control', '--radius-chip'] : ['--radius-card', '--radius-inner', '--radius-control']);
    expect(resolvedRoles).toEqual(expectedRoles);
    await probes.evaluate(el => el.remove());
  }
  // Agent usage dialog cards (.usage-hero, .usage-heatmap) also step down strictly below the 16px sheet.
  await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const usageDialog = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  await expect(usageDialog.locator('.usage-hero').first()).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(usageDialog.locator('.usage-hero').first(), plate, '--radius-inner', '--radius-card');
  const heatmap = usageDialog.locator('.usage-heatmap').first();
  if (await heatmap.isVisible()) {
    await expectNestedRadius(heatmap, plate, '--radius-inner', '--radius-card');
  }
  // Agent usage breakdown <small> ("unpriced" tag inside tbody th) uses 11px caption size and 400 weight.
  const breakdownBody = usageDialog.locator('.usage-breakdown tbody').first();
  await expect(breakdownBody).toBeVisible({ timeout: 30_000 });
  await breakdownBody.evaluate(tbody => {
    if (!tbody.querySelector('th small')) {
      const tr = document.createElement('tr');
      tr.dataset.roleProbe = 'unpriced';
      tr.innerHTML = '<th scope="row"><span>custom-model</span><small>unpriced</small></th><td>—</td><td>0%</td><td>0</td>';
      tbody.append(tr);
    }
  });
  const breakdownSmall = breakdownBody.locator('th small').first();
  await expect(breakdownSmall).toBeVisible();
  expect(parseFloat(await breakdownSmall.evaluate(el => getComputedStyle(el).fontSize))).toBeCloseTo(11, 1);
  await expect(breakdownSmall).toHaveCSS('font-weight', '400');
});

test('design role: settings type and segmented radius', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const navTitle = page.locator('.settings-nav-title');
  await expect(navTitle).toBeVisible({ timeout: 30_000 });
  await expectRole(navTitle, 'title');
  await expectToken(navTitle, 'color', '--ds-title-ink');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  const general = page.locator('#settings-panel-general:not([hidden])');
  const pageTitle = general.locator('.settings-panel-head h2');
  await expectRole(pageTitle, 'title');
  await expectToken(pageTitle, 'color', '--ds-title-ink');
  await expectRole(general.locator('.settings-heading').first(), 'heading');
  await expectLeading(general.locator('.text-size-setting small'), '--type-body-leading');
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  const appearance = page.locator('#settings-panel-appearance:not([hidden])');
  await expectLeading(appearance.locator('.secondary-button').first(), '--type-body-leading');
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const track = page.locator('.settings-subnav:not([hidden]) .ds-seg');
  await expect(track).toBeVisible({ timeout: 30_000 });
  await expectRadius(track, '--radius-inner');
  await expectRadius(track.locator('.segment-thumb'), '--radius-control');
  await track.getByRole('tab', { name: 'Providers', exact: true }).click();
  const providerCard = page.locator('#settings-panel-providers:not([hidden]) details.connection-card', { has: page.locator('code') }).first();
  await expect(providerCard).toBeVisible({ timeout: 30_000 });
  if (await providerCard.evaluate(el => !(el as HTMLDetailsElement).open)) {
    await providerCard.locator('summary').first().click();
  }
  const providerCode = providerCard.locator('code').first();
  await expect(providerCode).toBeVisible({ timeout: 30_000 });
  await expectToken(providerCode, 'fontFamily', '--mono');
  const providerCodeFont = await providerCode.evaluate(el => getComputedStyle(el).fontFamily.trim().toLowerCase());
  expect(providerCodeFont, '.connection-card code must resolve to --mono, not UA monospace').not.toBe('monospace');

  // R19: Settings -> Providers label specificity (.connection-env-global and .connection-renew-row label.ds-row-title).
  const claudeCard = page.locator('#settings-panel-providers:not([hidden]) #claude-connection');
  await expect(claudeCard).toBeVisible({ timeout: 30_000 });
  if (await claudeCard.evaluate(el => !(el as HTMLDetailsElement).open)) {
    await claudeCard.locator('> summary').click();
  }
  const renewLabel = claudeCard.locator('.connection-renew-row label.ds-row-title');
  await expect(renewLabel).toBeVisible({ timeout: 30_000 });
  await expect(renewLabel).toHaveCSS('margin-top', '0px');
  const envDetails = claudeCard.locator('details.connection-env');
  if (await envDetails.evaluate(el => !(el as HTMLDetailsElement).open)) {
    await envDetails.locator('> summary').click();
  }
  const envGlobal = envDetails.locator('label.connection-env-global');
  await expect(envGlobal).toBeVisible({ timeout: 30_000 });
  await expect(envGlobal).toHaveCSS('display', 'flex');
  await expectToken(envGlobal, 'fontSize', '--type-meta');
  expect(parseFloat(await envGlobal.evaluate(el => getComputedStyle(el).fontSize))).toBeCloseTo(12, 1);
  await expect(envGlobal).toHaveCSS('font-weight', '400');
  await page.evaluate(async () => {
    const root = document.querySelector('.settings-page-root');
    if (!root) throw new Error('missing .settings-page-root');
    const host = document.createElement('div');
    host.id = 'design-role-diag-host';
    root.append(host);
    const mod = await import(/* @vite-ignore */ '/src/remote-diagnostics.ts');
    mod.mountRemoteDiagnostics(host);
  });
  const diag = page.locator('#design-role-diag-host');
  await expect(diag.locator('.diag-stages')).toBeVisible({ timeout: 30_000 });
  // Top-level diagnostics cards directly under .settings-page-root stay at --radius-card.
  await expectRadius(diag.locator('.diag-actions'), '--radius-card');
  await expectRadius(diag.locator('.diag-stages'), '--radius-card');
  await expectRadius(diag.locator('.diag-events'), '--radius-card');
  await expectRadius(diag.locator('.diag-routes'), '--radius-card');
  // Nested inside an outer card, diagnostics lists step strictly below their container:
  // 8px (--radius-control) < 10px (.settings-group::before --radius-inner), and 10px (--radius-inner) < 16px (.ds-card --radius-card).
  const diagCard = page.locator('#design-role-diag-card');
  for (const [wrapper, innerToken, outerToken, outerPseudo] of [
    ['settings-group', '--radius-control', '--radius-inner', '::before'],
    ['ds-card', '--radius-inner', '--radius-card', undefined],
  ] as const) {
    await page.evaluate(cls => {
      const host = document.getElementById('design-role-diag-host');
      if (!host?.parentElement) throw new Error('missing #design-role-diag-host');
      let card = document.getElementById('design-role-diag-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'design-role-diag-card';
        host.parentElement.append(card);
        card.append(host);
      }
      card.className = cls;
    }, wrapper);
    for (const selector of ['.diag-actions', '.diag-stages', '.diag-events', '.diag-routes']) {
      await expectNestedRadius(diag.locator(selector), diagCard, innerToken, outerToken, outerPseudo);
    }
  }
});

test('design role: chip image thumbnail radius', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: /Attach files…/ }).click();
  const promptChip = page.locator('#attachments .prompt-chip-image').first();
  const promptThumb = promptChip.locator('img').first();
  await expect(promptThumb).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(promptThumb, promptChip, '--radius-hair', '--radius-chip');
  await expectNestedRadius(promptChip.locator('button').first(), promptChip, '--radius-hair', '--radius-chip');
});

test('design role: tray leading', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?view=tray', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.tray')).toBeVisible({ timeout: 30_000 });
  await expectToken(page.locator('html'), 'lineHeight', '--type-body-leading', true);
  const sub = page.locator('.tray-sub').first();
  await expect(sub).toBeVisible({ timeout: 30_000 });
  await expectLeading(sub, '--type-meta-leading');

  // .tray-row::before computes 6px (--radius-chip) inside 8px (--radius-control) .tray-row.
  const firstRow = page.locator('.tray-section h2 + .tray-row').first();
  const lastRow = page.locator('.tray-section .tray-row:last-child').first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  await expect(lastRow).toBeVisible({ timeout: 30_000 });
  await expectToken(firstRow, 'borderTopLeftRadius', '--radius-control');
  await expectToken(firstRow, 'borderTopRightRadius', '--radius-control');
  await expectToken(lastRow, 'borderBottomLeftRadius', '--radius-control');
  await expectToken(lastRow, 'borderBottomRightRadius', '--radius-control');
  const beforeRadii = await firstRow.evaluate(el => {
    const cs = getComputedStyle(el, '::before');
    return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat);
  });
  for (const r of beforeRadii) {
    expect(r, '.tray-row::before radius must be 6px (--radius-chip)').toBeCloseTo(6, 1);
  }

  // None of the six canonical tokens.css surface and fill tokens may resolve to IACVT / empty / transparent on :root.
  const canonicalTokens = ['--surface-1', '--surface-2', '--surface-3', '--surface-sunken', '--fill-hover', '--fill-active'] as const;
  const resolved = await page.evaluate(tokens => {
    const rootStyle = getComputedStyle(document.documentElement);
    return tokens.map(token => {
      const raw = rootStyle.getPropertyValue(token).trim();
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
      probe.style.backgroundColor = `var(${token})`;
      document.body.append(probe);
      const computed = getComputedStyle(probe).backgroundColor.trim();
      probe.remove();
      return { token, raw, computed };
    });
  }, canonicalTokens);
  for (const entry of resolved) {
    expect(entry.raw, `${entry.token} must be defined on :root`).not.toBe('');
    expect(entry.computed, `${entry.token} must not resolve to IACVT/transparent`).not.toBe('');
    expect(entry.computed, `${entry.token} must not resolve to rgba(0, 0, 0, 0)`).not.toBe('rgba(0, 0, 0, 0)');
    expect(entry.computed, `${entry.token} must not resolve to transparent`).not.toBe('transparent');
  }
});

test('design role: launcher leading and chip tracking', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?view=launcher', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.launcher')).toBeVisible({ timeout: 30_000 });
  await expectToken(page.locator('html'), 'lineHeight', '--type-body-leading', true);
  const chip = page.locator('.launcher-list-heading h2 .launcher-count');
  await expect(chip).toBeAttached({ timeout: 30_000 });
  await expectToken(chip, 'letterSpacing', '--tracking-none', true, true);
  const closeKbd = page.locator('.launcher-close kbd').first();
  await expect(closeKbd).toBeVisible({ timeout: 30_000 });
  const closeKbdTracking = await closeKbd.evaluate(el => getComputedStyle(el).letterSpacing);
  expect(['normal', '0px'], `.launcher-close kbd letterSpacing must not inherit --tracking-tight (got ${closeKbdTracking})`).toContain(closeKbdTracking);
  await expectToken(closeKbd, 'letterSpacing', '--tracking-none', true, true);
  for (const key of await page.locator('.launcher-footer kbd, .launcher-close kbd').all()) {
    await expectLeading(key, '--type-caption-leading');
    await expectToken(key, 'letterSpacing', '--tracking-none', true, true);
  }
});

test('design role: gallery type and control radii', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?ds', { waitUntil: 'domcontentloaded' });
  const gallery = page.locator('.ds-gallery');
  await expect(gallery.locator('h1.ds-title')).toBeVisible({ timeout: 30_000 });
  await expectRole(gallery.locator('.ds-row-title').first(), 'subheading');
  await expectRole(gallery.locator('.ds-row-sub').first(), 'meta');
  await expectRadius(gallery.locator('.secondary-button').first(), '--radius-control');
  await expectRadius(gallery.locator('.icon-button').first(), '--radius-control');
  await expectRadius(gallery.locator('input[aria-label="Text field"]'), '--radius-control');
  await expectRadius(gallery.locator('.ds-chip').first(), '--radius-chip');
  await expectRadius(gallery.locator('.ds-card').first(), '--radius-card');
  await expectRadius(gallery.locator('.ds-seg').first(), '--radius-inner');
  await expectRadius(gallery.locator('.ds-seg .segment-thumb').first(), '--radius-control');
  const hint = gallery.locator('.info-mark').first();
  await hint.scrollIntoViewIfNeeded();
  await hint.hover();
  await expectRadius(page.locator('[role="tooltip"].tip-visible'), '--radius-popover');
  await gallery.locator('[data-ds-menu]').first().click();
  await expectRadius(page.locator('.choice-menu.floating-menu'), '--radius-popover');
});

test('design role: launcher thread nested cards and tool status', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/src/overlay-client.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /if \(command === ["']overlay_preferences["']\)/;
    expect(source).toMatch(marker);
    await route.fulfill({
      response,
      body: source.replace(marker, `if (command === 'overlay_thread') return {
        provider: 'claude', status: 'running', hasOlder: false, liveText: '', messages: [
          { id: 1, sessionId: args.sessionId, role: 'user', content: 'Inspect nested card', createdAt: 1 },
          ...[
            { id: 'read', name: 'Read', status: 'completed', input: JSON.stringify({ file_path: 'src/overlay.css' }), output: 'Read' },
            { id: 'check', name: 'Bash', status: 'failed', input: JSON.stringify({ command: 'npx tsc --noEmit' }), output: 'Exit code: 2' },
          ].map((tool, index) => ({ id: 2 + index, sessionId: args.sessionId, role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool }), createdAt: 2 + index })),
        ],
      };
      $&`),
    });
  });

  await page.goto('/?view=launcher', { waitUntil: 'domcontentloaded' });
  const task = page.locator('.launcher-task[data-task="preview-active"]');
  await expect(task).toBeVisible({ timeout: 30_000 });
  await task.click();

  const userMsg = page.locator('.launcher-thread-user').first();
  await expect(userMsg).toBeVisible({ timeout: 30_000 });
  await userMsg.evaluate(async el => {
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const wrap = document.createElement('div');
    wrap.className = 'markdown';
    wrap.dataset.radiusProbe = 'launcher-user-gu';
    wrap.innerHTML = await markdownHtml('```ui\n{"type":"card","title":"Nested","body":"Inside launcher user card"}\n```');
    el.append(wrap);
  });

  const userGuCard = userMsg.locator('[data-radius-probe="launcher-user-gu"] pandacode-ui').locator('.gu-card').first();
  await expect(userGuCard).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(userGuCard, userMsg, '--radius-control', '--radius-inner');

  const toolStatus = page.locator('.launcher-thread-activity .tool-group-status').first();
  await expect(toolStatus).toBeVisible({ timeout: 30_000 });
  await expectToken(toolStatus, 'fontSize', '--thread-font');
  expect(parseFloat(await toolStatus.evaluate(el => getComputedStyle(el).fontSize))).toBeCloseTo(16, 1);
  await expectLeading(toolStatus, '--type-prose-leading');

  // Quick Launcher body > .tool-trace-tip[data-open] computes non-transparent glass background, 1px border, and non-none boxShadow (zero IACVT).
  const tipStyles = await page.evaluate(() => {
    const tip = document.createElement('div');
    tip.className = 'tool-trace-tip';
    tip.setAttribute('data-open', '');
    tip.innerHTML = '<span class="tool-trace-tip-line"><span class="tool-trace-tip-reason">Destructive</span><code>rm -rf</code></span>';
    document.body.append(tip);
    const cs = getComputedStyle(tip);
    const out = {
      backgroundColor: cs.backgroundColor.trim(),
      borderTopWidth: cs.borderTopWidth.trim(),
      boxShadow: cs.boxShadow.trim(),
    };
    tip.remove();
    return out;
  });
  expect(tipStyles.backgroundColor, '.tool-trace-tip backgroundColor must not be empty').not.toBe('');
  expect(tipStyles.backgroundColor, '.tool-trace-tip backgroundColor must not be transparent').not.toBe('rgba(0, 0, 0, 0)');
  expect(tipStyles.backgroundColor, '.tool-trace-tip backgroundColor must not be transparent keyword').not.toBe('transparent');
  expect(tipStyles.borderTopWidth).toBe('1px');
  expect(tipStyles.boxShadow, '.tool-trace-tip boxShadow must not be none').not.toBe('none');
  expect(tipStyles.boxShadow, '.tool-trace-tip boxShadow must not be empty').not.toBe('');

  // Quick Launcher undo banner (.launcher-thread-undo 10px with 3px pad -> button 6px, 6 <= 10 - 3).
  const undoBanner = page.locator('.launcher-thread-undo');
  await expect(undoBanner).toBeAttached();
  await undoBanner.evaluate(el => { (el as HTMLElement).hidden = false; });
  const undoButton = undoBanner.locator('button').first();
  await expect(undoButton).toBeVisible();
  await expectNestedRadius(undoButton, undoBanner, '--radius-chip', '--radius-inner');
  const undoGeometry = await undoBanner.evaluate(el => {
    const outerCs = getComputedStyle(el);
    const innerCs = getComputedStyle(el.querySelector('button')!);
    const pad = Math.min(parseFloat(outerCs.paddingTop), parseFloat(outerCs.paddingRight), parseFloat(outerCs.paddingBottom));
    return { outerRadius: parseFloat(outerCs.borderTopRightRadius), innerRadius: parseFloat(innerCs.borderTopRightRadius), pad };
  });
  expect(undoGeometry.innerRadius).toBeLessThanOrEqual(undoGeometry.outerRadius - undoGeometry.pad + 0.1);
});

test('design role: progress-pip SVG pin numerals follow caption scale live and match legend digits', async ({ page }) => {
  await page.setViewportSize({ width: 1760, height: 960 });
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner: 'tl' })));
  await openWorkspace(page, '/?progress');
  const card = page.locator('#progress-pip .pp-card');
  await card.getByRole('button', { name: /^Iteration 3: Idea/ }).click();
  const pin = card.locator('.pp-layer:not(.is-leaving) .pp-pin-n').first();
  const legend = card.locator('.pp-num').first();
  const screenFont = () => pin.evaluate(el => {
    const text = el as SVGTextElement;
    const matrix = text.getScreenCTM()!;
    return parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b);
  });
  await expect(pin).toBeVisible();
  const sizes: number[] = [];
  for (const scale of [1, 1.6]) {
    await page.evaluate(scale => {
      document.documentElement.style.setProperty('--ui-scale', String(scale));
      window.dispatchEvent(new CustomEvent('pandacode-ui-scale-change'));
    }, scale);
    // The legend's computed size ignores the card's entrance spring, so settle it first and
    // then poll the pin's screen size tightly against it: a loose ±0.5px poll can pass
    // mid-spring (card scale ≈ 0.96) and skew the 1.6 ratio below.
    await expectToken(legend, 'fontSize', '--type-caption');
    const legendSize = await legend.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(legendSize).toBeCloseTo(11 * scale, 0);
    await expect.poll(async () => Math.abs((await screenFont()) - legendSize)).toBeLessThan(0.15);
    const pinSize = await screenFont();
    expect(Math.abs(pinSize - legendSize)).toBeLessThan(0.15);
    sizes.push(pinSize);
  }
  expect(sizes[1] / sizes[0]).toBeCloseTo(1.6, 1);
});

test('design role: progress-pip SVG boxes step from card control to lightbox chip screen radius', async ({ page }) => {
  await page.setViewportSize({ width: 1760, height: 960 });
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner: 'tl' })));
  await openWorkspace(page, '/?progress');
  const card = page.locator('#progress-pip .pp-card');
  // Iteration 4 has both a highlight and a box; iteration 3 only has pins and an arrow.
  await card.getByRole('button', { name: /^Iteration 4: Filters/ }).click();
  const expectScreenRadius = async (host: Locator, radius: number) => {
    const rects = host.locator('.pp-layer:not(.is-leaving) rect.pp-stroke');
    await expect(rects).toHaveCount(2);
    for (const rect of await rects.all()) {
      await expect(rect).toBeVisible();
      const screenRx = () => rect.evaluate(el => {
        const rect = el as SVGRectElement;
        const matrix = rect.getScreenCTM()!;
        return rect.rx.baseVal.value * Math.hypot(matrix.a, matrix.b);
      });
      await expect.poll(screenRx).toBeCloseTo(radius, 0);
      expect(Math.abs(await screenRx() - radius), `screen rx within 0.6px of ${radius}`).toBeLessThanOrEqual(0.6);
    }
  };
  await expectScreenRadius(card, 8);
  await card.getByRole('button', { name: 'Open large view' }).click();
  const lightbox = page.locator('dialog.pp-lightbox');
  await expect(lightbox).toBeVisible();
  await expectScreenRadius(lightbox, 6);
  // A smaller window rescales the marks in place: the chip radius stays 6px on screen, not ~3.2px.
  // Tag the live SVG first: the same node must survive the resize (no rebuild, no replayed entrance).
  const liveMarks = lightbox.locator('.pp-layer:not(.is-leaving) svg.pp-marks');
  await expect(liveMarks).toHaveCount(1);
  await liveMarks.evaluate(el => { (el as SVGSVGElement).dataset.resizeProbe = 'same'; });
  await page.setViewportSize({ width: 1000, height: 640 });
  await expectScreenRadius(lightbox, 6);
  await expect(liveMarks, 'rescaleMarks() updates the live SVG in place').toHaveCount(1);
  await expect(liveMarks, 'rescaleMarks() keeps the same SVG node').toHaveAttribute('data-resize-probe', 'same');
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
  await expectScreenRadius(card, 8);
});
