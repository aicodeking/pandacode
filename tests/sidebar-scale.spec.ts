import { expect, test } from '@playwright/test';

test('sidebar task rows keep default-scale heights and do not overlap at --ui-scale 1.6', async ({ page }) => {
  await page.goto('/');
  const taskItem = page.locator('#navigation .task-item:not(.task-oneline)').first();
  await expect(taskItem).toBeVisible({ timeout: 30_000 });

  const measure = () => taskItem.evaluate(el => {
    const row = el.getBoundingClientRect();
    const top = el.querySelector<HTMLElement>('.task-top')!.getBoundingClientRect();
    const head = el.querySelector<HTMLElement>('.task-head')!.getBoundingClientRect();
    const title = el.querySelector<HTMLElement>('.task-title')!.getBoundingClientRect();
    const subtitle = el.querySelector<HTMLElement>('.task-checkout')!.getBoundingClientRect();
    return {
      rowHeight: row.height,
      topHeight: top.height,
      headHeight: head.height,
      topBottom: top.bottom,
      headTop: head.top,
      titleBottom: title.bottom,
      subtitleTop: subtitle.top,
      titleHeight: title.height,
      subtitleHeight: subtitle.height,
    };
  });

  const atDefault = await measure();
  expect(atDefault.topHeight).toBeCloseTo(20, 1);
  expect(atDefault.headHeight).toBeCloseTo(18, 1);
  expect(atDefault.rowHeight).toBeCloseTo(49, 1);
  expect(atDefault.topBottom).toBeLessThanOrEqual(atDefault.headTop + 0.5);

  await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.6'));
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6');

  const atScaled = await measure();
  expect(atScaled.topBottom).toBeLessThanOrEqual(atScaled.headTop + 0.5);
  expect(atScaled.titleBottom).toBeLessThanOrEqual(atScaled.subtitleTop + 0.5);
  expect(atScaled.titleHeight).toBeLessThanOrEqual(atScaled.topHeight + 0.5);
  expect(atScaled.subtitleHeight).toBeLessThanOrEqual(atScaled.headHeight + 0.5);
});

test('scaled sidebar, model picker, settings and inspector controls do not vertically clip at --ui-scale 1.6', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?bots=sample');
  const taskItem = page.locator('#navigation .task-item').first();
  await expect(taskItem).toBeVisible({ timeout: 30_000 });
  const changesCount = page.locator('#changes-count');
  await expect(changesCount).toHaveText(/^\d+$/);

  const chooseProjectFilter = async (name: string | RegExp) => {
    const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
    await expect(async () => {
      if (!await menu.isVisible()) await page.getByRole('button', { name: 'Filter projects', exact: true }).click();
      await menu.getByRole('menuitemradio', { name }).first().click({ timeout: 2_000 });
    }).toPass();
  };

  // Filter to a single project so .task-oneline rows render, and verify default-scale 32px height.
  await chooseProjectFilter(/^orbit\b/);
  const onelineItem = page.locator('#navigation .task-item.task-oneline').first();
  await expect(onelineItem).toBeVisible();
  expect(await onelineItem.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(32, 1);

  await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.6'));
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6');

  const noVerticalClip = async (locator: ReturnType<typeof page.locator>, label: string) => {
    const metrics = await locator.evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(metrics.clientHeight, `${label} clientHeight`).toBeGreaterThan(0);
    expect(metrics.scrollHeight, `${label} vertical clip`).toBeLessThanOrEqual(metrics.clientHeight + 1);
  };

  // .sidebar-projects / .project-filter must not clip or overlap .sidebar-search at 1.6x.
  const sidebarProjects = page.locator('.sidebar .sidebar-projects');
  const projectFilter = page.locator('.sidebar .project-filter');
  const sidebarSearch = page.locator('.sidebar .sidebar-search');
  await expect(sidebarProjects).toBeVisible();
  await expect(projectFilter).toBeVisible();
  await expect(sidebarSearch).toBeVisible();
  await noVerticalClip(sidebarProjects, '.sidebar-projects');
  await noVerticalClip(projectFilter, '.project-filter');
  const sidebarHeaderGeometry = await page.evaluate(() => {
    const projects = document.querySelector<HTMLElement>('.sidebar .sidebar-projects')!.getBoundingClientRect();
    const filter = document.querySelector<HTMLElement>('.sidebar .project-filter')!.getBoundingClientRect();
    const search = document.querySelector<HTMLElement>('.sidebar .sidebar-search')!.getBoundingClientRect();
    return { projectsBottom: projects.bottom, filterBottom: filter.bottom, searchTop: search.top };
  });
  expect(sidebarHeaderGeometry.projectsBottom, '.sidebar-projects overlaps .sidebar-search').toBeLessThanOrEqual(sidebarHeaderGeometry.searchTop + 0.5);
  expect(sidebarHeaderGeometry.filterBottom, '.project-filter overlaps .sidebar-search').toBeLessThanOrEqual(sidebarHeaderGeometry.searchTop + 0.5);

  // Check one-line rows and group headings at 1.6x.
  const onelineItems = page.locator('#navigation .task-item.task-oneline');
  const onelineCount = await onelineItems.count();
  expect(onelineCount).toBeGreaterThan(0);
  for (let i = 0; i < onelineCount; i++) {
    if (await onelineItems.nth(i).isVisible()) {
      await noVerticalClip(onelineItems.nth(i), `.task-item.task-oneline[${i}]`);
    }
  }

  // Switch back to All projects to also verify two-line task rows, group headings and dock badge at 1.6x.
  await chooseProjectFilter('All projects');
  const taskItems = page.locator('#navigation .task-item');
  await expect(taskItems.first()).toBeVisible();
  const activeTaskId = await page.locator('#navigation .task-item.selected').first().getAttribute('data-id');
  expect(activeTaskId).toBeTruthy();
  await page.evaluate(id => {
    (window as unknown as { __previewSubagent?: (session: string, data: { id: string; name: string; status: string }) => void })
      .__previewSubagent?.(id, { id: 'scale-a', name: 'Agent scale', status: 'running' });
  }, activeTaskId!);
  const dockBadge = page.locator('.action-dock .dock-badge');
  await expect(dockBadge).toBeVisible();
  await noVerticalClip(dockBadge, '.action-dock .dock-badge');
  const taskCount = await taskItems.count();
  expect(taskCount).toBeGreaterThan(0);
  for (let i = 0; i < taskCount; i++) {
    if (await taskItems.nth(i).isVisible()) {
      await noVerticalClip(taskItems.nth(i), `.task-item[${i}]`);
    }
  }

  const groupHeadings = page.locator('#navigation .group-heading');
  const headingCount = await groupHeadings.count();
  expect(headingCount).toBeGreaterThan(0);
  for (let i = 0; i < headingCount; i++) {
    if (await groupHeadings.nth(i).isVisible()) {
      await noVerticalClip(groupHeadings.nth(i), `.group-heading[${i}]`);
    }
  }

  await noVerticalClip(changesCount, '.inspector-tab-count');

  // Model picker rows, headings, tabs and effort buttons must not clip at 1.6x.
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(async () => {
    if (!await picker.isVisible()) await page.locator('#model-picker-trigger').click();
    await expect(picker).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await noVerticalClip(picker.locator('.model-menu-tab').first(), '.model-menu-tab');
  await noVerticalClip(picker.locator('.model-menu-group-heading').first(), '.model-menu-group-heading');
  await noVerticalClip(picker.locator('.model-menu-option').first(), '.model-menu-option');
  const effortButtons = picker.locator('.model-menu-effort > button');
  const effortCount = await effortButtons.count();
  expect(effortCount).toBeGreaterThan(0);
  for (let i = 0; i < effortCount; i++) {
    await noVerticalClip(effortButtons.nth(i), `.model-menu-effort > button[${i}]`);
  }
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  const botsBar = page.locator('.sidebar-bots-bar');
  await expect(botsBar).toBeVisible();
  await noVerticalClip(botsBar, '.sidebar-bots-bar');
  await botsBar.click();

  const botRows = page.locator('.bot-row-open');
  await expect(botRows.first()).toBeVisible({ timeout: 10_000 });
  const botCount = await botRows.count();
  expect(botCount).toBeGreaterThan(0);
  for (let i = 0; i < botCount; i++) {
    await noVerticalClip(botRows.nth(i), `.bot-row-open[${i}]`);
  }
  const botAdd = page.locator('.bot-row-add');
  if (await botAdd.count() > 0 && await botAdd.first().isVisible()) {
    await noVerticalClip(botAdd.first(), '.bot-row-add');
  }

  // Settings select controls must not clip at 1.6x.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const settingsSelects = page.locator('#settings-page [role="tabpanel"]:not([hidden]) .settings-select');
  await expect(settingsSelects.first()).toBeVisible({ timeout: 10_000 });
  const selectCount = await settingsSelects.count();
  expect(selectCount).toBeGreaterThan(0);
  for (let i = 0; i < selectCount; i++) {
    if (await settingsSelects.nth(i).isVisible()) {
      await noVerticalClip(settingsSelects.nth(i), `.settings-select[${i}]`);
    }
  }
});

test('scaled chips and buttons do not vertically clip at --ui-scale 1.6', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner: 'tl' }));
  });
  await page.goto('/?progress');
  await expect(page.locator('#navigation .task-item').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.6'));
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6');

  const noVerticalClip = async (locator: ReturnType<typeof page.locator>, label: string, state: 'visible' | 'attached' = 'visible') => {
    await locator.waitFor({ state, timeout: 30_000 });
    const metrics = await locator.evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(metrics.clientHeight, `${label} clientHeight`).toBeGreaterThan(0);
    expect(metrics.scrollHeight, `${label} vertical clip`).toBeLessThanOrEqual(metrics.clientHeight + 1);
  };

  // Progress PiP badges (.pp-badge), annotation chip (.pp-card .pp-chip), and Idea tag (.pp-tag).
  const pip = page.locator('#progress-pip .pp-card');
  const pill = page.locator('#progress-pip .pp-pill');
  await expect(page.locator('#progress-pip .pp-card, #progress-pip .pp-pill').first()).toBeVisible({ timeout: 15_000 });
  if (!await pip.isVisible() && await pill.isVisible()) {
    await pill.click();
  }
  await expect(pip).toBeVisible({ timeout: 15_000 });
  const liveLayer = pip.locator('.pp-layer:not(.is-leaving)');
  await noVerticalClip(liveLayer.locator('.pp-badge').first(), '.pp-badge');
  // The inactive chip is laid out with the same dimensions. progress-pip.spec.ts covers hover activation.
  const annotationChip = liveLayer.locator('.pp-chip').filter({ hasText: 'Keyboard hint' });
  await noVerticalClip(annotationChip, '.pp-card .pp-chip', 'attached');
  await pip.getByRole('button', { name: /^Iteration 3: Idea/ }).click();
  await noVerticalClip(pip.locator('.pp-tag').first(), '.pp-tag');

  // Thread find input (.thread-find input) must not clip at 1.6x.
  await page.keyboard.press('Meta+f');
  const findInput = page.locator('.thread-find input');
  await expect(findInput).toBeVisible({ timeout: 15_000 });
  await findInput.fill('progress');
  await noVerticalClip(findInput, '.thread-find input');
  await findInput.press('Escape');
  await expect(page.locator('.thread-find')).toBeHidden({ timeout: 30_000 });

  // Inspector Changes commit bar (#inspector .cv-commit-input / .cv-commit-submit) must not clip at 1.6x.
  const inspector = page.locator('#inspector');
  const changesTab = inspector.getByRole('tab', { name: /^Changes\b/ });
  if (await changesTab.isVisible()) await changesTab.click();
  const moreActions = inspector.locator('[data-cv-action="menu"]');
  await expect(moreActions).toBeVisible({ timeout: 15_000 });
  const commitItem = page.getByRole('menuitem', { name: 'Commit…', exact: true });
  await expect(async () => {
    if (!await commitItem.isVisible()) await moreActions.click();
    await commitItem.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const commitInput = inspector.locator('.cv-commit-input');
  const commitSubmit = inspector.locator('.cv-commit-submit');
  await expect(commitInput).toBeVisible({ timeout: 15_000 });
  await commitInput.fill('Scale check');
  await noVerticalClip(commitInput, '#inspector .cv-commit-input');
  await noVerticalClip(commitSubmit, '#inspector .cv-commit-submit');

  // Tiled thread title (.thread-tile-title) must not clip at 1.6x.
  const otherTask = page.locator('#navigation .task-item:not(.selected)').first();
  await expect(otherTask).toBeVisible({ timeout: 15_000 });
  await otherTask.click({ modifiers: ['Meta'] });
  const tileTitles = page.locator('.thread-tile-title');
  await expect(tileTitles.first()).toBeVisible({ timeout: 15_000 });
  const tileTitleCount = await tileTitles.count();
  expect(tileTitleCount).toBeGreaterThan(0);
  for (let i = 0; i < tileTitleCount; i += 1) {
    if (await tileTitles.nth(i).isVisible()) {
      await noVerticalClip(tileTitles.nth(i), `.thread-tile-title[${i}]`);
    }
  }

  // Sketch dialog option buttons (.sketch-option).
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: /Sketch a mockup…/ }).click();
  const sketchDialog = page.locator('#dialog.sketch-dialog');
  await expect(sketchDialog).toBeVisible({ timeout: 15_000 });
  const sketchOptions = sketchDialog.locator('.sketch-option');
  const sketchOptionCount = await sketchOptions.count();
  expect(sketchOptionCount).toBeGreaterThan(0);
  for (let i = 0; i < sketchOptionCount; i += 1) {
    if (await sketchOptions.nth(i).isVisible()) {
      await noVerticalClip(sketchOptions.nth(i), `.sketch-option[${i}]`);
    }
  }
  await sketchDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(sketchDialog).toBeHidden();

  // Settings chips & buttons: Skills scope (.skill-manager-scope > button), Rules & library (.skills-kind) and Remote access (.remote-badge).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('#settings-page');
  await expect(settings).toBeVisible({ timeout: 15_000 });

  await settings.getByRole('tab', { name: 'Tools', exact: true }).click();
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  const scopeButtons = settings.locator('#settings-panel-skills:not([hidden]) .skill-manager-scope > button');
  await expect(scopeButtons.first()).toBeVisible({ timeout: 15_000 });
  const scopeCount = await scopeButtons.count();
  expect(scopeCount).toBeGreaterThan(0);
  for (let i = 0; i < scopeCount; i += 1) {
    if (await scopeButtons.nth(i).isVisible()) {
      await noVerticalClip(scopeButtons.nth(i), `.skill-manager-scope > button[${i}]`);
    }
  }

  await settings.getByRole('tab', { name: 'Rules & library', exact: true }).click();
  await noVerticalClip(settings.locator('#settings-panel-rules:not([hidden]) .skills-kind').first(), '.skills-kind');

  await settings.getByRole('tab', { name: 'Connections', exact: true }).click();
  await settings.getByRole('tab', { name: 'Remote access', exact: true }).click();
  const remotePanel = settings.getByRole('tabpanel', { name: 'Remote access' });
  await remotePanel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await noVerticalClip(remotePanel.locator('.remote-badge').first(), '.remote-badge');

  // Verify remaining scaled chips/buttons (.queue-count, .queue-resume, .schedule-manual, .scheduled-tag, .bots-chip, .bot-chip) under their real stylesheets.
  await page.evaluate(async () => {
    await Promise.all([
      import(/* @vite-ignore */ '/src/message-queue.css'),
      import(/* @vite-ignore */ '/src/schedules.css'),
      import(/* @vite-ignore */ '/src/schedules-settings.css'),
      import(/* @vite-ignore */ '/src/sidebar-bots.css'),
      import(/* @vite-ignore */ '/src/redesign/bots.css'),
    ]);
    const host = document.createElement('div');
    host.id = 'scale-chip-probes';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9999;display:flex;gap:8px;align-items:center;padding:8px;background:var(--bg)';
    host.innerHTML = `
      <span class="queue-count">12</span>
      <button type="button" class="queue-resume">Resume now</button>
      <span class="schedule-manual">Run now</span>
      <span class="scheduled-tag">Daily</span>
      <span class="bots-chip">Allow</span>
      <span class="bot-chip waiting">Waiting</span>
    `;
    document.body.append(host);
  });
  const probes = page.locator('#scale-chip-probes');
  await noVerticalClip(probes.locator('.queue-count'), '.queue-count');
  await noVerticalClip(probes.locator('.queue-resume'), '.queue-resume');
  await noVerticalClip(probes.locator('.schedule-manual'), '.schedule-manual');
  await noVerticalClip(probes.locator('.scheduled-tag'), '.scheduled-tag');
  await noVerticalClip(probes.locator('.bots-chip'), '.bots-chip');
  await noVerticalClip(probes.locator('.bot-chip'), '.bot-chip');
});

test('scaled avatars, provider tiles, and queue/retry buttons do not overflow at --ui-scale 1.6', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.locator('#navigation .task-item').first()).toBeVisible({ timeout: 30_000 });

  const noOverflow = async (locator: ReturnType<typeof page.locator>, label: string) => {
    await expect(locator).toBeVisible({ timeout: 15_000 });
    const metrics = await locator.evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(metrics.clientHeight, `${label} clientHeight`).toBeGreaterThan(0);
    expect(metrics.clientWidth, `${label} clientWidth`).toBeGreaterThan(0);
    expect(metrics.scrollHeight, `${label} vertical overflow`).toBeLessThanOrEqual(metrics.clientHeight + 1);
    expect(metrics.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(metrics.clientWidth + 1);
  };

  await page.evaluate(async () => {
    await Promise.all([
      import(/* @vite-ignore */ '/src/machine-orchestration.css'),
      import(/* @vite-ignore */ '/src/message-queue.css'),
      import(/* @vite-ignore */ '/src/model-routing.css'),
      import(/* @vite-ignore */ '/src/model-tiers.css'),
      import(/* @vite-ignore */ '/src/model-picker.css'),
      import(/* @vite-ignore */ '/src/architect.css'),
      import(/* @vite-ignore */ '/src/skill-manager.css'),
      import(/* @vite-ignore */ '/src/github-pull.css'),
      import(/* @vite-ignore */ '/src/bots.css'),
      import(/* @vite-ignore */ '/src/bot-shared-channels.css'),
      import(/* @vite-ignore */ '/src/redesign/bots.css'),
      import(/* @vite-ignore */ '/src/tool-cards.css'),
      import(/* @vite-ignore */ '/src/tool-trace.css'),
    ]);
    const host = document.createElement('div');
    host.id = 'scale-r20-probes';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9999;display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--bg);width:840px';
    host.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="lineage-face">CL</span>
        <span class="lineage-faces"><span>CL</span><span>OA</span></span>
        <button type="button" class="remote-start-retry">Retry</button>
        <span class="routing-logo provider-logo-tile">P</span>
        <span class="tier-logos"><span class="tier-logo provider-logo-tile">W</span></span>
        <span class="model-menu-tab"><span class="provider-logo provider-logo-tile">W</span></span>
        <span class="model-menu-group-heading"><span class="provider-logo provider-logo-tile">W</span></span>
        <span class="model-menu-option"><span class="provider-logo provider-logo-tile">W</span></span>
        <span class="model-menu-stack"><span class="provider-logo provider-logo-tile">W</span></span>
        <span class="architect-worker-logo"><span class="provider-logo-tile">W</span></span>
        <span class="skill-chip"><span class="provider-logo-tile">C</span></span>
        <span class="pull-comment-meta"><span class="pull-avatar">K</span></span>
        <span class="bot-avatar bot-collab-avatar">B</span>
        <span class="bot-thread"><span class="message-avatar"><span class="bot-avatar">B</span></span></span>
        <span class="bot-avatar" data-probe="bot-avatar">B</span>
        <span class="bc-faces"><span class="bot-avatar bc-face" data-probe="bc-face">W</span><span class="bc-face-count" data-probe="bc-face-count">+12</span></span>
        <span class="bots-group-channels"><span class="channel-row"><span class="bc-faces"><span class="bot-avatar bc-face">W</span><span class="bc-face-count">+12</span></span></span></span>
        <span class="bc-working-faces"><span class="bot-avatar bc-face">W</span></span>
        <span class="tc-mark tc-letter">W</span>
        <span class="trace-mark is-avatar">W</span>
      </div>
      <div style="width:800px;container-name:composer;container-type:inline-size">
        <div class="queue-panel">
          <div class="queue-row">
            <span class="queue-index">12</span>
            <button type="button" class="queue-now" data-probe="steer"><span>Steer</span></button>
            <button type="button" class="queue-now" data-probe="send-now"><span>Send now</span></button>
          </div>
        </div>
      </div>
    `;
    document.body.append(host);
  });

  const probes = page.locator('#scale-r20-probes');

  // Verify 2 uppercase chars in .lineage-face and .lineage-faces span at 1x first.
  await noOverflow(probes.locator('.lineage-face'), '.lineage-face (1x)');
  await noOverflow(probes.locator('.lineage-faces span').first(), '.lineage-faces span (1x)');

  // Now scale to --ui-scale: 1.6 and verify every surface avoids both vertical and horizontal overflow.
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.6'));
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.6');

  await noOverflow(probes.locator('.lineage-face'), '.lineage-face (1.6x)');
  await noOverflow(probes.locator('.lineage-faces span').first(), '.lineage-faces span (1.6x)');
  await noOverflow(probes.locator('.remote-start-retry'), '.remote-start-retry (1.6x)');

  const queueSteer = probes.locator('.queue-panel .queue-now[data-probe="steer"]');
  const queueSendNow = probes.locator('.queue-panel .queue-now[data-probe="send-now"]');
  await expect(queueSteer.locator('span')).toBeVisible();
  await expect(queueSendNow.locator('span')).toBeVisible();
  await noOverflow(queueSteer, '.queue-panel .queue-now Steer (1.6x)');
  await noOverflow(queueSendNow, '.queue-panel .queue-now Send now (1.6x)');

  await noOverflow(probes.locator('.routing-logo.provider-logo-tile'), '.routing-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.tier-logo.provider-logo-tile'), '.tier-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.model-menu-tab > .provider-logo.provider-logo-tile'), '.model-menu-tab .provider-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.model-menu-group-heading > .provider-logo.provider-logo-tile'), '.model-menu-group-heading .provider-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.model-menu-option > .provider-logo.provider-logo-tile'), '.model-menu-option .provider-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.model-menu-stack > .provider-logo.provider-logo-tile'), '.model-menu-stack .provider-logo.provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.architect-worker-logo .provider-logo-tile'), '.architect-worker-logo .provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.skill-chip .provider-logo-tile'), '.skill-chip .provider-logo-tile (1.6x)');
  await noOverflow(probes.locator('.pull-comment-meta .pull-avatar'), '.pull-comment-meta .pull-avatar (1.6x)');
  await noOverflow(probes.locator('.bot-collab-avatar'), '.bot-collab-avatar (1.6x)');
  await noOverflow(probes.locator('.bot-thread .message-avatar .bot-avatar'), '.bot-thread .message-avatar .bot-avatar (1.6x)');
  await noOverflow(probes.locator('[data-probe="bot-avatar"]'), '.bot-avatar (1.6x)');
  await noOverflow(probes.locator('[data-probe="bc-face"]'), '.bc-face (1.6x)');
  await noOverflow(probes.locator('[data-probe="bc-face-count"]'), '.bc-face-count (+12) (1.6x)');
  await noOverflow(probes.locator('.bots-group-channels .channel-row .bc-faces .bc-face'), '.bots-group-channels .channel-row .bc-faces .bc-face (1.6x)');
  await noOverflow(probes.locator('.bots-group-channels .channel-row .bc-faces .bc-face-count'), '.bots-group-channels .channel-row .bc-faces .bc-face-count (+12) (1.6x)');
  await noOverflow(probes.locator('.bc-working-faces .bc-face'), '.bc-working-faces .bc-face (1.6x)');
  await noOverflow(probes.locator('.tc-letter'), '.tc-letter (1.6x)');
  await noOverflow(probes.locator('.trace-mark.is-avatar'), '.trace-mark.is-avatar (1.6x)');
  await noOverflow(probes.locator('.queue-panel .queue-row .queue-index'), '.queue-index (12) (1.6x)');
});


test('design role provider letter tiles match image logos at default scale', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#navigation .task-item').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveCSS('--ui-scale', '1');

  const measurements = await page.evaluate(async () => {
    await Promise.all([
      import(/* @vite-ignore */ '/src/model-tiers.css'),
      import(/* @vite-ignore */ '/src/model-picker.css'),
      import(/* @vite-ignore */ '/src/architect.css'),
      import(/* @vite-ignore */ '/src/skill-manager.css'),
    ]);
    const host = document.createElement('div');
    host.id = 'provider-logo-parity-probes';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9999;display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--bg)';
    host.innerHTML = `
      <span class="tier-logos" data-context="tier"><span class="tier-logo provider-logo-tile">W</span><img class="tier-logo" alt=""></span>
      ${['tab', 'group-heading', 'option', 'stack'].map(context => `
        <span class="model-menu-${context}" data-context="picker-${context}"><span class="provider-logo provider-logo-tile">W</span><img class="provider-logo" alt=""></span>
      `).join('')}
      <span data-context="architect"><span class="architect-worker-logo"><span class="provider-logo-tile">W</span></span><span class="architect-worker-logo"><img class="provider-logo" alt=""></span></span>
      <span class="skill-chip" data-context="skill"><span class="provider-logo provider-logo-tile">C</span><img class="provider-logo" alt=""></span>
    `;
    document.body.append(host);
    const dimensions = (element: Element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    };
    const measurements = Array.from(host.querySelectorAll<HTMLElement>('[data-context]'), context => ({
      context: context.dataset.context!,
      tile: dimensions(context.querySelector('.provider-logo-tile')!),
      image: dimensions(context.querySelector('img')!),
    }));
    host.remove();
    return measurements;
  });

  expect(measurements).toHaveLength(7);
  for (const { context, tile, image } of measurements) {
    // Measure the styled image sibling so icon tokens resolve to runtime pixels.
    expect(image.width, `${context} image width`).toBeGreaterThan(0);
    expect(image.height, `${context} image height`).toBeGreaterThan(0);
    expect(tile.width, `${context} width parity`).toBe(image.width);
    expect(tile.height, `${context} height parity`).toBe(image.height);
  }
});
