import { expect, test } from '@playwright/test';
import { expectToken, expectLeading, expectSharedChevron, expectRadius, expectNestedRadius, openWorkspace, openModelPicker } from './design-roles-helpers';

// Concentric radii: dialog step-down, plates, portals and page/dialog nesting depth.

test('design role: nested radii step down for pandacode-ui inside turn-card-reply', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?cards', { waitUntil: 'domcontentloaded' });
  await page.locator('.task-item', { hasText: 'Turn cards' }).click();
  const turnCard = page.locator('.turn-card:not(.is-live)').first();
  const reply = turnCard.locator('.turn-card-reply').first();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(reply, turnCard, '--radius-inner', '--radius-card');
  // Mount a real <pandacode-ui> card inside .turn-card-reply and verify 8px < 10px.
  await reply.evaluate(async el => {
    el.setAttribute('data-open', '');
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const host = document.createElement('div');
    host.className = 'markdown';
    host.dataset.radiusProbe = 'gu';
    const fields = [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'role', label: 'Role', type: 'select', options: ['One', 'Two'] },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ];
    const spec = {
      type: 'card', title: 'Nested', body: 'Inside reply',
      children: [{ type: 'form', title: 'Details', submit: 'Send', prompt: 'Hi', fields }],
    };
    host.innerHTML = await markdownHtml('```ui\n' + JSON.stringify(spec) + '\n```');
    (el.querySelector('.turn-card-reply-body') ?? el).append(host);
  });
  const guCard = reply.locator('[data-radius-probe="gu"] pandacode-ui').locator('.gu-card');
  await expect(guCard).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(guCard, reply, '--radius-control', '--radius-inner');
  const guForm = guCard.locator('.gu-form');
  await expect(guForm).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(guForm, guCard, '--radius-chip', '--radius-control');
  const guButton = guForm.locator('.gu-button');
  const guInput = guForm.locator('input');
  const guSelect = guForm.locator('select');
  const guTextarea = guForm.locator('textarea');
  await expect(guButton).toBeVisible({ timeout: 30_000 });
  await expectToken(guButton, 'fontSize', '--type-body');
  await expectToken(guButton, 'fontWeight', '--weight-medium');
  await expect(guInput).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(guButton, guForm, '--radius-hair', '--radius-chip');
  await expectNestedRadius(guInput, guForm, '--radius-hair', '--radius-chip');
  await expectNestedRadius(guSelect, guForm, '--radius-hair', '--radius-chip');
  await expectNestedRadius(guTextarea, guForm, '--radius-hair', '--radius-chip');
  await expectSharedChevron(guSelect);
});

test('design role: concentric radii for gh-job-summary, agent-input-option, and multi-depth pandacode-ui', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?cards', { waitUntil: 'domcontentloaded' });
  await page.locator('.task-item', { hasText: 'Turn cards' }).click();
  const reply = page.locator('.turn-card:not(.is-live) .turn-card-reply').first();
  await expect(reply).toBeVisible({ timeout: 30_000 });

  await reply.evaluate(async el => {
    el.setAttribute('data-open', '');
    await Promise.all([
      import(/* @vite-ignore */ '/src/github-hub.css'),
      import(/* @vite-ignore */ '/src/agent-input.css'),
    ]);
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const body = el.querySelector('.turn-card-reply-body') ?? el;

    // Standalone host outside .turn-card-reply so .gh-job-summary and .agent-input-option match their real DOM parents.
    const host = document.createElement('div');
    host.id = 'design-role-concentric-host';
    (document.querySelector('#transcript') ?? document.body).append(host);

    // 1. .gh-job-summary (8px) -> pre/blockquote (6px) -> <pandacode-code> copy button (2px)
    const gh = document.createElement('div');
    gh.className = 'gh-job-summary markdown';
    gh.dataset.radiusProbe = 'gh-job-summary';
    gh.innerHTML = await markdownHtml('> Summary quote\n\n```ts\nconst x = 1;\n```');
    const ghPending = document.createElement('pandacode-ui');
    ghPending.className = 'pending';
    ghPending.dataset.radiusProbe = 'gh-pending';
    ghPending.innerHTML = '<pre><code class="language-ui">{}</code></pre>';
    gh.append(ghPending);
    host.append(gh);

    // 2. .agent-input-option (8px) -> .markdown pre (6px) -> <pandacode-code> copy button (2px)
    const opt = document.createElement('label');
    opt.className = 'agent-input-option';
    opt.dataset.radiusProbe = 'agent-input-option';
    const optMd = document.createElement('span');
    optMd.className = 'markdown';
    optMd.innerHTML = await markdownHtml('```sh\necho hi\n```');
    opt.append(optMd);
    host.append(opt);

    // 3. Multi-depth <pandacode-ui> inside .turn-card-reply (10px -> 8px .gu-pending; 10px -> 8px .gu-card -> 6px .gu-flow -> 2px .gu-button & .gu-md pre)
    const replyPending = document.createElement('pandacode-ui');
    replyPending.className = 'pending';
    replyPending.dataset.radiusProbe = 'reply-pending';
    replyPending.innerHTML = '<pre><code class="language-ui">{}</code></pre>';
    body.append(replyPending);

    const flowHost = document.createElement('div');
    flowHost.className = 'markdown';
    flowHost.dataset.radiusProbe = 'gu-flow-nested';
    flowHost.innerHTML = await markdownHtml('```ui\n{"type":"card","title":"Outer","children":[{"type":"plan","title":"Steps","summary":"```ts\\nconst y = 2;\\n```","steps":[{"title":"One","status":"done"}],"actions":[{"label":"Run","prompt":"run"}]}]}\n```');
    body.append(flowHost);

    // 4. Light-DOM <kbd> inside monospace context keeps --sans and --type-caption-leading.
    const monoBox = document.createElement('div');
    monoBox.style.fontFamily = 'var(--mono)';
    const kbd = document.createElement('kbd');
    kbd.dataset.radiusProbe = 'kbd';
    kbd.textContent = '⌘K';
    monoBox.append(kbd);
    host.append(monoBox);
  });

  const host = page.locator('#design-role-concentric-host');
  // .gh-job-summary: 8px -> 6px pre & blockquote -> 2px copy button
  const gh = host.locator('[data-radius-probe="gh-job-summary"]');
  const ghPre = gh.locator('pre').first();
  const ghQuote = gh.locator('blockquote').first();
  const ghCopy = gh.locator('pandacode-code button').first();
  await expect(ghPre).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(ghPre, gh, '--radius-chip', '--radius-control');
  await expectNestedRadius(ghQuote, gh, '--radius-chip', '--radius-control');
  await expect(ghCopy).toBeAttached({ timeout: 30_000 });
  await expectToken(ghCopy, 'borderTopLeftRadius', '--radius-hair');

  // .gu-pending inside .gh-job-summary (8px -> 6px) and inside .turn-card-reply (10px -> 8px)
  const ghPendingEl = host.locator('[data-radius-probe="gh-pending"] .gu-pending');
  await expect(ghPendingEl).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(ghPendingEl, gh, '--radius-chip', '--radius-control');
  const replyPendingEl = reply.locator('[data-radius-probe="reply-pending"] .gu-pending');
  await expect(replyPendingEl).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(replyPendingEl, reply, '--radius-control', '--radius-inner');

  // .agent-input-option: 8px -> 6px Markdown pre -> 2px copy button
  const opt = host.locator('[data-radius-probe="agent-input-option"]');
  const optPre = opt.locator('pre').first();
  const optCopy = opt.locator('pandacode-code button').first();
  await expect(optPre).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(optPre, opt, '--radius-chip', '--radius-control');
  await expect(optCopy).toBeAttached({ timeout: 30_000 });
  await expectToken(optCopy, 'borderTopLeftRadius', '--radius-hair');

  // Multi-depth <pandacode-ui> with .gu-flow children inside .turn-card-reply
  const flowUi = reply.locator('[data-radius-probe="gu-flow-nested"] pandacode-ui');
  const outerCard = flowUi.locator('.gu-card').first();
  const innerFlow = outerCard.locator('.gu-flow').first();
  const flowButton = innerFlow.locator('.gu-button').first();
  const flowPre = innerFlow.locator('.gu-md pre').first();
  await expect(innerFlow).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(outerCard, reply, '--radius-control', '--radius-inner');
  await expectNestedRadius(innerFlow, outerCard, '--radius-chip', '--radius-control');
  await expectNestedRadius(flowButton, innerFlow, '--radius-hair', '--radius-chip');
  await expectNestedRadius(flowPre, innerFlow, '--radius-hair', '--radius-chip');

  // Light-DOM <kbd> uses --sans and --type-caption-leading even inside a --mono parent
  const kbd = host.locator('[data-radius-probe="kbd"]');
  await expectToken(kbd, 'fontFamily', '--sans');
  await expectLeading(kbd, '--type-caption-leading');
});

test('design role: sketch, shared channel, and pull-file-diff nested radii', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);

  // Sketch dialog: the text editor uses the hair radius inside the stepped paper.
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: /Sketch a mockup…/ }).click();
  const sketchDialog = page.locator('#dialog.sketch-dialog');
  await expect(sketchDialog).toBeVisible({ timeout: 30_000 });
  const sketchSelect = sketchDialog.locator('.sketch-select select');
  await expect(sketchSelect).toBeVisible();
  if (browserName === 'webkit') {
    // macOS WebKit RenderThemeCocoa clamps native appearance:auto <select> min-height to 18px;
    // reading with appearance:none verifies sketch.css's 24px wins over motion.css's 30px.
    const cascadedMinHeight = await sketchSelect.evaluate(el => {
      const prev = el.style.appearance;
      el.style.appearance = 'none';
      const value = getComputedStyle(el).minHeight;
      el.style.appearance = prev;
      return value;
    });
    expect(cascadedMinHeight).toBe('24px');
  } else {
    await expect(sketchSelect).toHaveCSS('min-height', '24px');
  }
  await sketchDialog.locator('.sketch-tool[data-tool="text"]').click();
  const sketchPaper = sketchDialog.locator('.sketch-paper');
  await sketchPaper.locator('canvas').click({ position: { x: 80, y: 80 } });
  const textEditor = sketchPaper.locator('.sketch-text-editor');
  await expect(textEditor).toBeVisible({ timeout: 15_000 });
  await expectNestedRadius(textEditor, sketchPaper, '--radius-hair', '--ds-control-radius');
  await expect(textEditor).toHaveCSS('padding-top', '2px');
  await expect(textEditor).toHaveCSS('padding-right', '4px');
  await expect(textEditor).toHaveCSS('padding-bottom', '2px');
  await expect(textEditor).toHaveCSS('padding-left', '4px');
  await textEditor.press('Escape');
  await expect(textEditor).toBeHidden();
  await sketchDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(sketchDialog).toBeHidden();

  // .bc-message-text (10px -> 8px Markdown pre/blockquote and <pandacode-ui> .gu-card)
  // and .pull-file-diff .diff-viewer-layout (8px inside 10px .pull-file-diff).
  await page.evaluate(async () => {
    await Promise.all([
      import(/* @vite-ignore */ '/src/bot-shared-channels.css'),
      import(/* @vite-ignore */ '/src/redesign/bots.css'),
      import(/* @vite-ignore */ '/src/github-pull.css'),
    ]);
    const [{ markdownHtml }, { mountDiffViewer }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/diff-viewer.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-r19-host';
    (document.querySelector('#transcript') ?? document.body).append(host);

    const bc = document.createElement('div');
    bc.className = 'bc-message-text markdown';
    bc.dataset.radiusProbe = 'bc-message-text';
    bc.innerHTML = await markdownHtml('> Channel quote\n\n```ts\nconst c = 1;\n```\n\n```ui\n{"type":"card","title":"Channel card","body":"Inside channel"}\n```');
    host.append(bc);

    const pullDiff = document.createElement('div');
    pullDiff.className = 'pull-file-diff';
    pullDiff.dataset.radiusProbe = 'pull-file-diff';
    host.append(pullDiff);
    mountDiffViewer(pullDiff, {
      patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      path: 'a.ts',
      layout: 'unified',
      truncated: false,
    });
  });

  const host = page.locator('#design-role-r19-host');
  const bc = host.locator('[data-radius-probe="bc-message-text"]');
  const bcPre = bc.locator('pre').first();
  const bcQuote = bc.locator('blockquote').first();
  const bcGuCard = bc.locator('pandacode-ui').locator('.gu-card').first();
  await expect(bcPre).toBeVisible({ timeout: 30_000 });
  await expect(bcQuote).toBeVisible({ timeout: 30_000 });
  await expect(bcGuCard).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(bcPre, bc, '--radius-control', '--radius-inner');
  await expectNestedRadius(bcQuote, bc, '--radius-control', '--radius-inner');
  await expectNestedRadius(bcGuCard, bc, '--radius-control', '--radius-inner');

  const pullDiff = host.locator('[data-radius-probe="pull-file-diff"]');
  const pullLayout = pullDiff.locator('.diff-viewer-layout').first();
  await expect(pullLayout).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(pullLayout, pullDiff, '--radius-control', '--radius-inner');
});

test('design role: bots dialog concentric radii and architect flyout embeds', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);

  await page.evaluate(async () => {
    await Promise.all([
      import(/* @vite-ignore */ '/src/bots.css'),
      import(/* @vite-ignore */ '/src/bots-settings.css'),
      import(/* @vite-ignore */ '/src/redesign/bots.css'),
      import(/* @vite-ignore */ '/src/architect.css'),
      import(/* @vite-ignore */ '/src/turn-changes.css'),
      import(/* @vite-ignore */ '/src/agent-input.css'),
    ]);

    const dlg = document.createElement('dialog');
    dlg.id = 'design-role-bots-dialog';
    dlg.className = 'bot-settings-dialog';
    dlg.innerHTML = `
      <div class="bots bots-single">
        <div class="bots-detail">
          <div class="bots-panel">
            <section class="bs-card">
              <div class="bs-group">
                <ol class="bp-backups">
                  <li><span>Backup model</span><button type="button" class="icon-button" aria-label="Remove">x</button></li>
                </ol>
                <div class="bp-rule-options" role="radiogroup">
                  <button type="button" aria-checked="true"><strong>Ask</strong><small>Always ask</small></button>
                </div>
                <p class="bots-error bots-soul-error" role="alert">Soul error</p>
              </div>
            </section>
            <ul class="bots-items">
              <li class="bots-channel">
                <p class="bots-warning">Channel warning</p>
              </li>
            </ul>
            <form class="bots-connect">
              <div class="bots-check ok">Works</div>
            </form>
          </div>
        </div>
      </div>
    `;
    document.body.append(dlg);
    dlg.showModal();
  });

  const dlg = page.locator('#design-role-bots-dialog');
  await expect(dlg).toBeVisible();
  for (const dialogClass of ['bot-settings-dialog', 'bots-dialog'] as const) {
    await dlg.evaluate((el, cls) => { (el as HTMLElement).className = cls; }, dialogClass);
    const bsCard = dlg.locator('.bs-card');
    const bsGroup = dlg.locator('.bs-group');
    const bpBackups = dlg.locator('.bp-backups');
    const bpBackupLi = bpBackups.locator('li');
    const bpBackupBtn = bpBackups.locator('.icon-button');
    const bpRules = dlg.locator('.bp-rule-options');
    const bpRuleBtn = bpRules.locator('> button');
    const soulError = dlg.locator('.bots-soul-error');
    const channel = dlg.locator('li.bots-channel');
    const warning = channel.locator('.bots-warning');
    const connect = dlg.locator('.bots-connect');
    const check = connect.locator('.bots-check');

    await expectNestedRadius(bsGroup, bsCard, '--radius-control', '--radius-inner');
    await expectNestedRadius(bpBackups, bsGroup, '--radius-chip', '--radius-control');
    await expectNestedRadius(bpRules, bsGroup, '--radius-chip', '--radius-control');
    await expectNestedRadius(soulError, bsGroup, '--radius-chip', '--radius-control');
    await expectNestedRadius(bpBackupLi, bpBackups, '--radius-hair', '--radius-chip');
    await expectNestedRadius(bpBackupBtn, bpBackups, '--radius-hair', '--radius-chip');
    await expectNestedRadius(bpRuleBtn, bpRules, '--radius-hair', '--radius-chip');
    await expectNestedRadius(warning, channel, '--radius-hair', '--ds-control-radius');
    await expectNestedRadius(check, connect, '--radius-control', '--radius-inner');
  }
  await dlg.evaluate(el => { (el as HTMLDialogElement).close(); el.remove(); });

  // Architect flyout embeds: .architect-panel .turn-changes and .architect-panel .agent-input step down to 10px inside 16px .agents-flyout.
  await page.evaluate(() => {
    const flyout = document.createElement('div');
    flyout.id = 'design-role-agents-flyout';
    flyout.className = 'agents-flyout';
    flyout.style.cssText = 'position:fixed;top:24px;left:24px;width:360px;z-index:999';
    flyout.innerHTML = `
      <div class="architect-host">
        <div class="architect-panel">
          <div class="turn-changes">Changes</div>
          <div class="agent-input">Question</div>
        </div>
      </div>
    `;
    document.body.append(flyout);
  });
  const flyout = page.locator('#design-role-agents-flyout');
  await expectNestedRadius(flyout.locator('.architect-panel .turn-changes'), flyout, '--radius-inner', '--radius-card');
  await expectNestedRadius(flyout.locator('.architect-panel .agent-input'), flyout, '--radius-inner', '--radius-card');
});

test('design role: interactive chrome concentric radii', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?bots=sample', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#navigation .task-item').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#changes-count')).toHaveText(/^\d+$/, { timeout: 30_000 });

  // 1. Inspector tab close button (.inspector-tab 8px -> .inspector-tab-close 6px, right inset 2px)
  //    and framed search field (.search-field 8px -> .search-toggle 6px).
  const searchMenuItem = page.getByRole('menu', { name: 'Open view' }).getByRole('menuitem', { name: 'Search', exact: true });
  await expect(async () => {
    if (!await searchMenuItem.isVisible()) await page.locator('#inspector [data-action="inspector-add-tab"]').click();
    await searchMenuItem.click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const searchTab = page.locator('#inspector .inspector-tab[data-view="search"]');
  await expect(searchTab).toBeVisible({ timeout: 30_000 });
  await searchTab.hover();
  const searchTabClose = searchTab.locator('.inspector-tab-close');
  await expect(searchTabClose).toBeVisible();
  await expectNestedRadius(searchTabClose, searchTab, '--radius-chip', '--radius-control');
  const inspectorTabGeom = await searchTab.evaluate(el => {
    const outer = el.getBoundingClientRect();
    const innerEl = el.querySelector<HTMLElement>('.inspector-tab-close')!;
    const inner = innerEl.getBoundingClientRect();
    const pad = Math.min(outer.right - inner.right, inner.top - outer.top, outer.bottom - inner.bottom);
    return {
      outerRadius: parseFloat(getComputedStyle(el).borderTopRightRadius),
      innerRadius: parseFloat(getComputedStyle(innerEl).borderTopRightRadius),
      pad,
    };
  });
  expect(inspectorTabGeom.innerRadius).toBeLessThanOrEqual(inspectorTabGeom.outerRadius - inspectorTabGeom.pad + 0.5);

  const searchField = page.locator('#inspector-content .search-field');
  const searchToggle = searchField.locator('.search-toggle').first();
  await expect(searchToggle).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(searchToggle, searchField, '--radius-chip', '--radius-control');

  // 2. Terminal tab close button (.terminal-tab 8px -> .icon-button 6px, right inset 2px).
  await page.locator('.workspace-header [data-action="terminal"]').click();
  const terminalTab = page.locator('#terminal-drawer .terminal-tab').first();
  const terminalClose = terminalTab.locator('> .icon-button');
  await expect(terminalClose).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(terminalClose, terminalTab, '--radius-chip', '--radius-control');
  const terminalTabGeom = await terminalTab.evaluate(el => {
    const outer = el.getBoundingClientRect();
    const innerEl = el.querySelector<HTMLElement>(':scope > .icon-button')!;
    const inner = innerEl.getBoundingClientRect();
    const pad = Math.min(outer.right - inner.right, inner.top - outer.top, outer.bottom - inner.bottom);
    return {
      outerRadius: parseFloat(getComputedStyle(el).borderTopRightRadius),
      innerRadius: parseFloat(getComputedStyle(innerEl).borderTopRightRadius),
      pad,
    };
  });
  expect(terminalTabGeom.innerRadius).toBeLessThanOrEqual(terminalTabGeom.outerRadius - terminalTabGeom.pad + 0.5);
  await page.locator('#terminal-drawer').getByRole('button', { name: 'Minimize terminal', exact: true }).click();
  await expect(page.locator('#terminal-drawer')).toBeHidden();

  // 3. Framed sidebar search field (.sidebar-search 8px -> .sidebar-search-clear 6px).
  const sidebarSearch = page.locator('.sidebar .sidebar-search');
  const sidebarSearchInput = sidebarSearch.locator('input');
  await sidebarSearchInput.fill('a');
  const sidebarSearchClear = sidebarSearch.locator('.sidebar-search-clear');
  await expect(sidebarSearchClear).toBeVisible();
  await expectNestedRadius(sidebarSearchClear, sidebarSearch, '--radius-chip', '--radius-control');
  await sidebarSearchInput.fill('');

  // 4. Sidebar row actions (.task-item 8px -> .task-action 6px).
  const taskRow = page.locator('.sidebar .task-row').first();
  await expect(taskRow).toBeVisible();
  await taskRow.hover();
  const taskItem = taskRow.locator('> .task-item');
  const taskAction = taskRow.locator('.task-action').first();
  await expect(taskAction).toBeVisible();
  await expectNestedRadius(taskAction, taskItem, '--radius-chip', '--radius-control');

  // 5. Queue rows (.queue-row 8px -> .queue-now 6px & .queue-actions .icon-button 6px).
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/message-queue.css');
    const host = document.createElement('div');
    host.id = 'design-role-queue-probe';
    host.style.cssText = 'position:fixed;top:12px;right:12px;width:480px;z-index:999;background:var(--bg);padding:8px';
    host.innerHTML = `
      <div class="queue-panel">
        <ul class="queue-list">
          <li class="queue-row">
            <span class="queue-index">1</span>
            <span class="queue-text">Queued follow-up</span>
            <button type="button" class="queue-now"><span>Send now</span></button>
            <span class="queue-actions"><button type="button" class="icon-button" aria-label="Remove">x</button></span>
          </li>
        </ul>
      </div>
    `;
    document.body.append(host);
  });
  const queueProbe = page.locator('#design-role-queue-probe');
  const queueRow = queueProbe.locator('.queue-row');
  await expectNestedRadius(queueRow.locator('.queue-now'), queueRow, '--radius-chip', '--radius-control');
  await expectNestedRadius(queueRow.locator('.queue-actions .icon-button'), queueRow, '--radius-chip', '--radius-control');
  await queueProbe.evaluate(el => el.remove());

  // 6. Inline bot reassign panel (.bc-reassign-menu 10px with 4px pad -> button 6px, 6 <= 10 - 4).
  const botsBar = page.locator('.sidebar-bots-bar');
  if (await botsBar.getAttribute('aria-pressed') !== 'true') await botsBar.click();
  const botsRegion = page.getByRole('region', { name: 'Bots', exact: true });
  await expect(botsRegion).toBeVisible({ timeout: 30_000 });
  await botsRegion.getByRole('button', { name: '#launch' }).click();
  const channelInput = page.getByRole('textbox', { name: 'Message channel' });
  await expect(channelInput).toBeVisible({ timeout: 30_000 });
  await channelInput.fill('@Writer draft the post.');
  await channelInput.press('Enter');
  const actions = page.locator('#composer-area .bc-channel-actions');
  await expect(actions.getByRole('button', { name: 'Stop Writer' })).toBeVisible({ timeout: 30_000 });
  await actions.getByRole('button', { name: 'Stop Writer' }).click();
  await actions.getByRole('button', { name: /Reassign/ }).click();
  const reassignMenu = page.locator('#composer-area .bc-reassign-menu');
  const reassignBtn = reassignMenu.locator('button').first();
  await expect(reassignBtn).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(reassignBtn, reassignMenu, '--radius-chip', '--radius-inner');
  const reassignGeom = await reassignMenu.evaluate(el => {
    const outerCs = getComputedStyle(el);
    const innerCs = getComputedStyle(el.querySelector('button')!);
    const pad = Math.min(parseFloat(outerCs.paddingTop), parseFloat(outerCs.paddingRight), parseFloat(outerCs.paddingBottom), parseFloat(outerCs.paddingLeft));
    return { outerRadius: parseFloat(outerCs.borderTopLeftRadius), innerRadius: parseFloat(innerCs.borderTopLeftRadius), pad };
  });
  expect(reassignGeom.innerRadius).toBeLessThanOrEqual(reassignGeom.outerRadius - reassignGeom.pad + 0.1);
});

test('design role: dialog glass plates keep card radii while contents step down', async ({ page }) => {
  await page.setViewportSize({ width: 1760, height: 960 });
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner: 'tl' })));
  await openWorkspace(page, '/?progress');
  await page.locator('#progress-pip .pp-card').getByRole('button', { name: 'Open large view' }).click();
  const lightbox = page.locator('dialog.pp-lightbox');
  await expectRadius(lightbox.locator('.pp-lb-plate'), '--radius-card');
  for (const button of await lightbox.locator('.pp-lb-button').all()) await expectRadius(button, '--radius-chip');
  await lightbox.getByRole('button', { name: 'Close large view' }).click();

  for (const launcher of [false, true]) {
    if (launcher) {
      await page.goto('/?view=launcher');
      await expect(page.locator('#launcher-prompt')).toBeVisible();
      await page.locator('.launcher-task[data-task="preview-active"]').click();
      await expect(page.locator('.launcher-thread-response')).toBeVisible();
    }
    await page.evaluate(async launcher => {
      const { openToolImage } = await import(/* @vite-ignore */ '/src/tool-image-viewer.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      const button = document.createElement('button');
      button.dataset.toolImage = 'radius-probe.png';
      const image = document.createElement('img');
      image.src = canvas.toDataURL('image/png');
      button.append(image);
      document.body.append(button);
      openToolImage(button, { launcher });
    }, launcher);
    const viewer = page.locator('dialog.tool-image-viewer');
    await expectRadius(viewer.locator('.tool-image-viewer-plate'), '--radius-card');
    await expectRadius(viewer.locator('.tool-image-viewer-close'), '--radius-chip');
    await expectRadius(viewer.locator('.tool-image-viewer-image'), '--radius-control');
    await viewer.getByRole('button', { name: 'Close image', exact: true }).click();
  }
});

test('design role: portaled choice and model menus keep page radii inside an open dialog', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  for (const modal of [false, true]) {
    await page.evaluate(async isModal => {
      const [{ openChoiceMenu }, { openModelPicker }] = await Promise.all([
        import(/* @vite-ignore */ '/src/choice-menu.ts'),
        import(/* @vite-ignore */ '/src/model-picker.ts'),
      ]);
      const host = document.createElement(isModal ? 'dialog' : 'div');
      host.id = 'design-role-menu-host';
      host.style.cssText = 'position:fixed;inset:80px auto auto 80px;width:600px;z-index:999';
      // The anchor inherits modal content roles; its portaled menu must inherit page roles.
      host.innerHTML = '<div class="ds-card"><button data-open-choice>Choice probe</button><button data-open-model>Model probe</button></div>';
      document.body.append(host);
      if (host instanceof HTMLDialogElement) host.showModal();
      const choice = host.querySelector<HTMLButtonElement>('[data-open-choice]')!;
      choice.addEventListener('click', () => {
        openChoiceMenu({ anchor: choice, title: 'Choice probe', items: [{ id: 'one', label: 'One' }], onSelect: () => {}, onClose: () => {} });
      });
      const model = host.querySelector<HTMLButtonElement>('[data-open-model]')!;
      model.addEventListener('click', () => {
        openModelPicker({
          anchor: model,
          providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: null, version: '', models: [{ id: 'probe', name: 'Probe model', description: 'Radius probe' }] }],
          current: { provider: 'claude', model: 'probe' }, canSwitchProvider: true, onSelect: async () => {},
        });
      });
    }, modal);
    const host = page.locator('#design-role-menu-host');
    const portal = modal ? '#design-role-menu-host' : 'body';
    if (modal) await expect(host).toHaveAttribute('open', '');
    await host.getByRole('button', { name: 'Choice probe', exact: true }).click();
    const choice = page.locator(`${portal} > .choice-menu.floating-menu`);
    await expect(choice).toBeVisible();
    await expectRadius(choice.locator('.choice-menu-option'), '--radius-control');
    await page.keyboard.press('Escape');
    await expect(choice).toHaveCount(0);
    await host.getByRole('button', { name: 'Model probe', exact: true }).click();
    const model = page.locator(`${portal} > .model-menu.floating-menu`);
    await expectRadius(model, '--radius-card');
    await expectRadius(model.locator('.model-menu-list'), '--radius-inner');
    await expect(model.locator('.model-menu-option')).toHaveCount(2);
    for (const option of await model.locator('.model-menu-option').all()) await expectRadius(option, '--radius-control');
    await page.keyboard.press('Escape');
    await expect(model).toHaveCount(0);
    await host.evaluate(el => { if (el instanceof HTMLDialogElement) el.close(); el.remove(); });
  }
});

test('design role: dialog nesting steps from control to chip to hair across JSON, shadow roots and Markdown', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const dialog = document.createElement('dialog');
    dialog.id = 'design-role-gu-dialog';
    const fence = (spec: unknown) => '```ui\n' + JSON.stringify(spec) + '\n```';
    const deepFence = fence({ type: 'card', title: 'Deep shadow', body: 'Deep' });
    const nestedFence = fence({ type: 'card', title: 'Inner shadow', body: deepFence });
    for (const [name, spec] of [
      ['json', { type: 'card', title: 'Outer JSON', children: [{ type: 'card', title: 'Inner JSON', children: [{ type: 'card', title: 'Deep JSON', body: 'Deep' }] }] }],
      ['shadow', { type: 'card', title: 'Outer shadow', body: nestedFence }],
    ] as const) {
      const wrap = document.createElement('div');
      wrap.dataset.nesting = name;
      wrap.innerHTML = await markdownHtml(fence(spec));
      dialog.append(wrap);
    }
    const markdown = document.createElement('div');
    markdown.className = 'markdown';
    markdown.innerHTML = '<blockquote data-nesting="quote-ui"></blockquote><blockquote data-nesting="quotes">Outer quote<blockquote>Inner quote<blockquote>Deep quote</blockquote><pre><code>Deep code</code></pre></blockquote></blockquote>';
    markdown.querySelector('[data-nesting="quote-ui"]')!.innerHTML = await markdownHtml(fence({
      type: 'card', title: 'Card inside quote', children: [{ type: 'card', title: 'Deep card inside quote', body: 'Deep' }],
    }));
    dialog.append(markdown);
    document.body.append(dialog);
    dialog.showModal();
  });
  const dialog = page.locator('#design-role-gu-dialog');
  const jsonCards = dialog.locator('[data-nesting="json"] > pandacode-ui').locator('.gu-card');
  await expect(jsonCards).toHaveCount(3);
  await expectNestedRadius(jsonCards.nth(1), jsonCards.first(), '--radius-chip', '--radius-control');
  await expectNestedRadius(jsonCards.nth(2), jsonCards.nth(1), '--radius-hair', '--radius-chip');
  const outer = dialog.locator('[data-nesting="shadow"] > pandacode-ui').locator('.gu-card').first();
  const inner = outer.locator('pandacode-ui').locator('.gu-card').first();
  const deep = inner.locator('pandacode-ui').locator('.gu-card').first();
  await expectNestedRadius(inner, outer, '--radius-chip', '--radius-control');
  await expectNestedRadius(deep, inner, '--radius-hair', '--radius-chip');
  const quote = dialog.locator('[data-nesting="quote-ui"]');
  const quoteCards = quote.locator('pandacode-ui').locator('.gu-card');
  await expect(quoteCards).toHaveCount(2);
  await expectNestedRadius(quoteCards.first(), quote, '--radius-chip', '--radius-control');
  await expectNestedRadius(quoteCards.nth(1), quoteCards.first(), '--radius-hair', '--radius-chip');
  const outerQuote = dialog.locator('[data-nesting="quotes"]');
  const innerQuote = outerQuote.locator(':scope > blockquote');
  await expectNestedRadius(innerQuote, outerQuote, '--radius-chip', '--radius-control');
  await expectNestedRadius(innerQuote.locator(':scope > blockquote'), innerQuote, '--radius-hair', '--radius-chip');
  await expectNestedRadius(innerQuote.locator(':scope > pre'), innerQuote, '--radius-hair', '--radius-chip');
});

test('design role: Markdown radii keep shrinking through tight hosts and four page levels', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.evaluate(async () => {
    await Promise.all([import(/* @vite-ignore */ '/src/github-hub.css'), import(/* @vite-ignore */ '/src/agent-input.css')]);
    const host = document.createElement('div');
    host.id = 'design-role-deep-markdown';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    const quotes = (levels: number): string => levels === 1
      ? '<blockquote>Deep quote</blockquote><pre><code>Deep code</code></pre>'
      : `<blockquote>Level ${levels}${quotes(levels - 1)}</blockquote>`;
    host.innerHTML = `<div data-context="gh" class="gh-job-summary markdown">${quotes(2)}</div>
      <label data-context="agent" class="agent-input-option"><span class="markdown">${quotes(2)}</span></label>
      <div data-context="reply" class="turn-card-reply ds-card-inner" data-open><div class="markdown">${quotes(3)}</div></div>
      <div data-context="page" class="markdown">${quotes(4)}</div>`;
    document.body.append(host);
  });
  for (const [context, tokens] of [
    ['gh', ['--radius-chip', '--radius-hair']],
    ['agent', ['--radius-chip', '--radius-hair']],
    ['reply', ['--radius-control', '--radius-chip', '--radius-hair']],
    ['page', ['--radius-inner', '--radius-control', '--radius-chip', '--radius-hair']],
  ] as const) {
    await test.step(context, async () => {
      const host = page.locator(`#design-role-deep-markdown [data-context="${context}"]`);
      if (context !== 'page') await expectRadius(host, context === 'reply' ? '--radius-inner' : '--radius-control');
      const markdown = context === 'agent' || context === 'reply' ? host.locator('.markdown') : host;
      let parent = markdown;
      for (const token of tokens) {
        const quote = parent.locator(':scope > blockquote');
        await expectRadius(quote, token);
        if (parent !== markdown) {
          const outer = await parent.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
          const inner = await quote.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
          expect(inner, `${context}: each quote must be tighter than its parent`).toBeLessThan(outer);
        }
        if (token === '--radius-hair') await expectRadius(parent.locator(':scope > pre'), token);
        parent = quote;
      }
    });
  }
});

test('design role: slash, file-mention and tooltip portals keep page radii inside a dialog', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    const [{ mountSlashCommands }, { mountFileMentions }, { infoMark }] = await Promise.all([
      import(/* @vite-ignore */ '/src/slash-commands.ts'),
      import(/* @vite-ignore */ '/src/file-mentions.ts'),
      import(/* @vite-ignore */ '/src/tooltip.ts'),
    ]);
    const dialog = document.createElement('dialog');
    dialog.id = 'design-role-completion-dialog';
    dialog.style.cssText = 'position:fixed;inset:400px auto auto 80px;width:600px';
    dialog.innerHTML = '<div><textarea aria-label="Slash probe"></textarea><textarea aria-label="File probe"></textarea>' + infoMark('Tooltip radius probe') + '</div>';
    document.body.append(dialog);
    dialog.showModal();
    mountSlashCommands(dialog.querySelector<HTMLTextAreaElement>('[aria-label="Slash probe"]')!, {
      contextKey: () => 'radius-probe',
      load: async () => ({ commands: [{ id: 'probe', name: '/probe', description: 'Probe', kind: 'prompt', source: 'Project' }], warnings: [] }),
      select: () => {},
    });
    mountFileMentions(dialog.querySelector<HTMLTextAreaElement>('[aria-label="File probe"]')!, {
      contextKey: () => 'radius-probe', search: async () => [{ path: 'src/probe.ts', name: 'probe.ts', isDir: false }],
    });
  });
  const dialog = page.locator('#design-role-completion-dialog');
  for (const [field, text, menuClass, rowClass] of [
    ['Slash probe', '/', 'slash-menu', 'slash-menu-option'],
    ['File probe', '@', 'file-mention-menu', 'file-mention-option'],
  ] as const) {
    await dialog.getByLabel(field, { exact: true }).fill(text);
    const menu = dialog.locator(`:scope > .${menuClass}.floating-menu`);
    await expectRadius(menu, '--radius-popover');
    await expect(menu).toHaveCSS('border-radius', '12px');
    const option = menu.locator(`.${rowClass}`);
    await expectRadius(option, '--radius-control');
    await expect(option).toHaveCSS('border-radius', '8px');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
  await dialog.locator('.info-mark').hover();
  const tooltip = dialog.locator(':scope > .tip-bubble');
  await expectRadius(tooltip, '--radius-popover');
  await expect(tooltip).toHaveCSS('border-radius', '12px');
});

test('design role: Round 8 bot reaction menu wraps its control buttons concentrically', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/message-actions.css');
    const host = document.createElement('div');
    host.id = 'design-role-r8-react';
    host.className = 'message-actions';
    host.style.cssText = 'position:fixed;inset:40px auto auto 40px;z-index:999;opacity:1';
    host.innerHTML = '<span class="bot-react-menu" role="group" aria-label="Reactions"><button type="button">A</button><button type="button">B</button></span>';
    document.body.append(host);
  });
  const menu = page.locator('#design-role-r8-react .bot-react-menu');
  const button = menu.locator('button').first();
  await expectNestedRadius(button, menu, '--ds-control-radius', '--ds-inner-radius');
  await expect(menu).toHaveCSS('border-radius', '10px');
  await expect(menu).toHaveCSS('padding-top', '2px');
  await expect(button).toHaveCSS('border-radius', '8px');
  const [outer, inner, pad] = await menu.evaluate(el => {
    const cs = getComputedStyle(el);
    return [parseFloat(cs.borderTopLeftRadius), parseFloat(getComputedStyle(el.querySelector('button')!).borderTopLeftRadius), parseFloat(cs.paddingTop)];
  });
  expect(outer, 'outer radius = inner radius + padding').toBeCloseTo(inner + pad, 1);
});
