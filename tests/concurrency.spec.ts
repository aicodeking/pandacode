import { expect, test, type Page } from '@playwright/test';

// Keep the status/filter layout explicit; project-first navigation is covered by sidebar-projects.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { const key = 'pandacode.sidebar.sort'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), group: 'flat' })); });
});

type View = 'conversation' | 'board';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const live = (page: Page) => page.locator('#stream-region .live-text');
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const taskId = (index: number) => `session-${index}`;
const runtimeErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page) ?? []).toEqual([]); });

// A controlled, in-memory harness: real app event handlers/renderers, no external agents.
async function installConcurrency(page: Page, count = 12): Promise<void> {
  const errors: string[] = []; runtimeErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      if (!window.__concurrent) {
        sessions = Array.from({ length: ${count} }, (_, index) => ({
          id: 'session-' + (index + 1), projectId: 'project-1', title: 'Concurrent task ' + (index + 1),
          provider: ['claude', 'codex', 'kimi'][index % 3], model: '', mode: 'ask', status: 'idle',
          createdAt: now - index, updatedAt: now - index, archived: false, worktreePath: null,
          resumeId: null, lastResponseAt: null, taskStage: 'pending', taskDescription: 'Prompt for task ' + (index + 1), completedAt: null
        }));
        for (const s of sessions) messages[s.id] = [];
        window.__concurrent = { tasks: {}, calls: [], holdSends: {}, releaseSends: {}, rejectSends: {}, holdReads: {}, releaseReads: {}, holdInspector: {}, releaseInspector: {}, holdHistory: {}, releaseHistory: {}, holdSnapshot: {}, releaseSnapshot: {}, rejectSnapshot: {}, holdApprovals: {}, releaseApprovals: {} };
      }
      const fixture = window.__concurrent;
      fixture.calls.push({ command, ...args });
      if (command === 'get_messages' && fixture.holdSnapshot[args.sessionId]) {
        const snapshot = { messages: structuredClone(messages[args.sessionId] ?? []), hasOlder: false };
        await new Promise((resolve, reject) => { fixture.releaseSnapshot[args.sessionId] = resolve; fixture.rejectSnapshot[args.sessionId] = () => reject(new Error('An older selection could not load history')); });
        return snapshot;
      }
      if (command === 'get_messages' && fixture.holdHistory[args.sessionId]) {
        await new Promise(resolve => { (fixture.releaseHistory[args.sessionId] ??= []).push(resolve); });
      }
      if (command === 'git_status' && fixture.holdInspector[args.sessionId]) {
        await new Promise(resolve => { fixture.releaseInspector[args.sessionId] = resolve; });
      }
      if (command === 'read_file' && fixture.holdReads[args.sessionId]) {
        await new Promise(resolve => { fixture.releaseReads[args.sessionId] = resolve; });
      }
      if (command === 'send_message') {
        const s = session(args.sessionId);
        if (fixture.tasks[s.id]?.running) throw new Error('Duplicate task start');
        s.status = 'running'; s.taskStage = 'in_progress'; s.updatedAt = Date.now();
        messages[s.id].push({ id: ++id, sessionId: s.id, role: 'user', content: args.text, createdAt: Date.now() });
        let pending = '', sequence = 0;
        const persist = () => { if (pending) messages[s.id].push({ id: ++id, sessionId: s.id, role: 'assistant', content: pending, createdAt: Date.now() }); pending = ''; };
        fixture.tasks[s.id] = {
          running: true,
          push(text) { if (!this.running) return; pending += text; s.lastResponseAt = Date.now(); agent({ sessionId: s.id, kind: 'text', text }); },
          status() { agent({ sessionId: s.id, kind: 'status', text: 'Working on ' + s.title }); },
          tool() { const tool = { id: 'tool-' + s.id, name: 'Bash', input: 'npm test', output: 'Output chunk ' + (++sequence), status: 'running' }; agent({ sessionId: s.id, kind: 'tool', text: 'Bash', tool }); },
          approval() { s.status = 'waiting'; agent({ sessionId: s.id, kind: 'approval', requestId: 'same-request-id', text: 'Approve operation for ' + s.title }); },
          cancelApproval() { agent({ sessionId: s.id, kind: 'approval_cancelled', requestId: 'same-request-id', text: '' }); },
          done(stopped = false) { if (!this.running) return; persist(); this.running = false; finishTiming(s.id); s.status = 'idle'; s.taskStage = stopped ? 'in_progress' : 'review'; agent({ sessionId: s.id, kind: 'done', text: stopped ? 'Stopped' : '' }); },
        };
        agent({ sessionId: s.id, kind: 'status', text: 'Starting agent' });
        if (fixture.holdSends[s.id]) await new Promise((resolve, reject) => { fixture.releaseSends[s.id] = resolve; fixture.rejectSends[s.id] = () => { s.status = 'idle'; s.taskStage = 'pending'; fixture.tasks[s.id].running = false; reject(new Error('Controlled submission failed')); }; });
        return undefined;
      }
      if (command === 'stop_session') { fixture.tasks[args.sessionId].done(true); return undefined; }
      if (command === 'respond_approval') {
        if (fixture.holdApprovals[args.sessionId]) await new Promise(resolve => { fixture.releaseApprovals[args.sessionId] = resolve; });
        return undefined;
      }
      switch (command) {`) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Concurrent task 1');
}

async function selectTask(page: Page, index: number, view: View): Promise<void> {
  if (view === 'board') await page.locator(`[data-action="board-open"][data-id="${taskId(index)}"]`).click();
  else await page.locator(`.task-item[data-id="${taskId(index)}"]`).click();
  await expect(prompt(page)).toBeVisible();
}

async function startTask(page: Page, index: number, view: View): Promise<void> {
  if (view === 'board') await page.locator(`[data-action="board-start"][data-id="${taskId(index)}"]`).click();
  else {
    await selectTask(page, index, view);
    await prompt(page).fill(`Prompt for task ${index}`);
    await prompt(page).press('Enter');
  }
  await expect.poll(() => page.evaluate(id => Boolean((window as any).__concurrent.tasks[id]?.running), taskId(index))).toBe(true);
}

async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function expectCompletedResponse(page: Page, text: string): Promise<void> {
  // turn_changes can materialize the final message before get_messages returns.
  // Verify one readable response without depending on its temporary stream slot.
  const response = transcript(page).locator('.agent-message .message-content').filter({ hasText: text });
  await expect(transcript(page).locator('.agent-message .message-content, .activity-commentary').filter({ hasText: text })).toHaveCount(1);
  await expect(response).toBeVisible();
  await expect(response).toHaveText(text);
  expect(await response.evaluate(element => Boolean(element.closest('.turn-activity')))).toBe(false);
}

test.describe('concurrency', () => {
  for (const view of ['conversation', 'board'] as const) {
    test(`bounds background tool/status work with 500 tasks in ${view}`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await installConcurrency(page, 500);
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      for (let index = 1; index <= 4; index++) await startTask(page, index, view);
      await page.evaluate(() => {
        for (const task of Object.values((window as any).__concurrent.tasks) as any[]) { task.tool(); task.push('Initial response. '); }
      });
      await selectTask(page, 1, view);
      await expect(live(page)).toHaveText('Initial response.');
      await selectTask(page, 5, view);
      await prompt(page).fill('Keep this unsent draft.');
      await page.getByRole('button', { name: 'Filter projects', exact: true }).click();
      await expect(page.locator('.choice-menu')).toBeVisible();
      await settlePaint(page);
      await page.evaluate(() => {
        const metric = (window as any).__concurrencyMetric = { navigationMutations: 0, boardMutations: 0, headerMutations: 0, frames: [] as number[], observers: [] as MutationObserver[] };
        for (const [selector, key] of [['#navigation', 'navigationMutations'], ['#project-board', 'boardMutations'], ['#breadcrumb', 'headerMutations']]) {
          const host = document.querySelector(selector);
          if (!host) continue;
          const observer = new MutationObserver(records => { metric[key] += records.length; });
          observer.observe(host, { subtree: true, childList: true }); metric.observers.push(observer);
        }
        metric.composer = document.querySelector('#composer'); metric.menu = document.querySelector('.choice-menu');
        metric.rows = [...document.querySelectorAll('.choice-menu-option')];
      });
      const measurements = await page.evaluate(async () => {
        const fixture = (window as any).__concurrent, metric = (window as any).__concurrencyMetric;
        const began = performance.now();
        for (let batch = 0; batch < 20; batch++) {
          const frameStart = performance.now();
          for (let index = 2; index <= 4; index++) { const task = fixture.tasks['session-' + index]; task.status(); task.tool(); task.push('token '); }
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          metric.frames.push(performance.now() - frameStart);
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        for (const observer of metric.observers) observer.disconnect();
        const frames = [...metric.frames].sort((a: number, b: number) => a - b);
        return { elapsedMs: performance.now() - began, p95FrameMs: frames[Math.floor(frames.length * .95)], maxFrameMs: frames.at(-1),
          navigationMutations: metric.navigationMutations, boardMutations: metric.boardMutations, headerMutations: metric.headerMutations,
          composerStable: metric.composer === document.querySelector('#composer'), menuStable: metric.menu === document.querySelector('.choice-menu'),
          rowsStable: metric.rows.every((row: Element, index: number) => row === document.querySelectorAll('.choice-menu-option')[index]) };
      });
      console.log('CONCURRENCY_METRICS', view, JSON.stringify(measurements));
      await testInfo.attach(`concurrency-${view}.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
      expect(measurements.composerStable).toBe(true);
      expect(measurements.menuStable).toBe(true);
      expect(measurements.rowsStable).toBe(true);
      expect(measurements.navigationMutations).toBeLessThan(10);
      expect(measurements.headerMutations).toBeLessThan(10);
      expect(measurements.boardMutations).toBeLessThan(25);
      // A generous ceiling catches main-thread starvation, not machine-to-machine timing noise.
      expect(measurements.p95FrameMs).toBeLessThan(250);
      await page.keyboard.press('Escape');
      await expect(prompt(page)).toHaveValue('Keep this unsent draft.');
      await expect(live(page)).toBeHidden();
    });
  }
});

test.describe('concurrency isolation', () => {
  for (const view of ['conversation', 'board'] as const) {
    test(`keeps four interleaved responses isolated across ${view} navigation and background completion`, async ({ page }) => {
      await installConcurrency(page);
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      for (let index = 1; index <= 4; index++) await startTask(page, index, view);
      await page.evaluate(() => {
        for (let index = 1; index <= 4; index++) (window as any).__concurrent.tasks['session-' + index].push(`**Task ${index}** first segment. `);
      });
      for (const index of [1, 3, 2, 4]) {
        await selectTask(page, index, view);
        await expect(live(page)).toHaveText(`Task ${index} first segment.`);
        await expect(live(page).locator('strong')).toHaveText(`Task ${index}`);
        await page.evaluate(id => (window as any).__concurrent.tasks[id].push('Second segment. '), taskId(index));
      }
      await selectTask(page, 5, view);
      await prompt(page).fill('An unrelated task draft survives four completions.');
      await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
      const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
      await menu.getByRole('combobox').fill('sol');
      await page.evaluate(() => {
        (window as any).__reloadCountBeforeDone = (window as any).__concurrent.calls.filter((call: any) => call.command === 'list_sessions').length;
        (window as any).__preservedComposer = document.querySelector('#composer');
        (window as any).__preservedMenu = document.querySelector('.model-menu');
        const fixture = (window as any).__concurrent;
        for (const index of [4, 1, 3, 2]) { fixture.tasks['session-' + index].push(`Final ${index}.`); fixture.tasks['session-' + index].done(); }
      });
      await expect(menu).toHaveAttribute('data-popover-state', 'open');
      await expect(menu.getByRole('combobox')).toHaveValue('sol');
      await expect.poll(() => page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => call.command === 'list_sessions').length)).toBeGreaterThan(1);
      await settlePaint(page);
      console.log('CONCURRENT_COMPLETION_RELOADS', view, await page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => call.command === 'list_sessions').length - (window as any).__reloadCountBeforeDone));
      expect(await page.evaluate(() => ({ composer: (window as any).__preservedComposer === document.querySelector('#composer'), menu: (window as any).__preservedMenu === document.querySelector('.model-menu') }))).toEqual({ composer: true, menu: true });
      await page.keyboard.press('Escape');
      await expect(prompt(page)).toHaveValue('An unrelated task draft survives four completions.');
      const otherView: View = view === 'board' ? 'conversation' : 'board';
      await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: otherView === 'board' ? 'Board' : 'Conversation', exact: true }).click();
      for (let index = 1; index <= 4; index++) {
        await selectTask(page, index, otherView);
        await expect(transcript(page).locator('.agent-message')).toHaveCount(1);
        await expect(transcript(page).locator('.agent-message .message-content')).toHaveText(`Task ${index} first segment. Second segment. Final ${index}.`);
        await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
      }
      await selectTask(page, 5, otherView);
      await expect(prompt(page)).toHaveValue('An unrelated task draft survives four completions.');
    });

    test(`isolates approvals, cancellation and a held completion among four ${view} tasks`, async ({ page }) => {
      await installConcurrency(page);
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      for (let index = 1; index <= 4; index++) await startTask(page, index, view);
      await page.evaluate(() => {
        const fixture = (window as any).__concurrent;
        for (let index = 1; index <= 4; index++) fixture.tasks['session-' + index].push(`Response for task ${index}. `);
        fixture.holdApprovals['session-1'] = true;
        fixture.tasks['session-1'].approval(); fixture.tasks['session-2'].approval();
      });
      await selectTask(page, 1, view);
      await expect(page.locator('.approval-bar')).toContainText('Approve operation for Concurrent task 1');
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
      await selectTask(page, 2, view);
      await expect(page.locator('.approval-bar')).toContainText('Approve operation for Concurrent task 2');
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(page.locator('.approval-bar')).toHaveCount(0);
      await page.evaluate(() => (window as any).__concurrent.releaseApprovals['session-1']());
      await selectTask(page, 3, view);
      await page.getByRole('button', { name: 'Stop task', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
      const active = await page.evaluate(() => Object.entries((window as any).__concurrent.tasks).filter(([, task]: any) => task.running).map(([id]) => id));
      expect(active).toEqual(['session-1', 'session-2', 'session-4']);
      await selectTask(page, 4, view);
      await page.evaluate(() => {
        const fixture = (window as any).__concurrent; fixture.holdHistory['session-4'] = true;
        fixture.tasks['session-4'].push('Last chunk is visible before history arrives.'); fixture.tasks['session-4'].done();
      });
      await expect.poll(() => page.evaluate(() => (window as any).__concurrent.releaseHistory['session-4']?.length ?? 0)).toBeGreaterThan(0);
      await expectCompletedResponse(page, 'Response for task 4. Last chunk is visible before history arrives.');
      await selectTask(page, 2, view);
      await page.evaluate(() => {
        const fixture = (window as any).__concurrent; fixture.tasks['session-2'].push('Still working independently.');
        fixture.holdHistory['session-4'] = false; for (const release of fixture.releaseHistory['session-4']) release();
      });
      await expect(live(page)).toHaveText('Response for task 2. Still working independently.');
      await expect(transcript(page)).not.toContainText('Last chunk');
      await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
      const calls = await page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => ['respond_approval', 'stop_session'].includes(call.command)));
      expect(calls).toEqual([
        { command: 'respond_approval', sessionId: 'session-1', requestId: 'same-request-id', approved: true },
        { command: 'respond_approval', sessionId: 'session-2', requestId: 'same-request-id', approved: false },
        { command: 'stop_session', sessionId: 'session-3' },
      ]);
      await selectTask(page, 4, view);
      await expect(transcript(page).locator('.agent-message')).toHaveCount(1);
      await expectCompletedResponse(page, 'Response for task 4. Last chunk is visible before history arrives.');
    });

    test(`accepts another ${view} submission while one is pending and restores a rejected background draft`, async ({ page }) => {
      await installConcurrency(page);
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await selectTask(page, 1, view); }
      await page.evaluate(() => { (window as any).__concurrent.holdSends['session-1'] = true; });
      await prompt(page).fill('Restore this task one draft if submission fails.');
      await prompt(page).press('Enter');
      await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.rejectSends['session-1'])).toBe('function');
      await selectTask(page, 2, view);
      await expect(prompt(page)).toBeEnabled();
      await prompt(page).fill('Task two starts without waiting for task one.');
      await prompt(page).press('Enter');
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__concurrent.tasks['session-2']?.running))).toBe(true);
      await page.evaluate(() => {
        const fixture = (window as any).__concurrent; fixture.tasks['session-2'].push('Task two is responding.'); fixture.rejectSends['session-1']();
      });
      await expect(live(page)).toHaveText('Task two is responding.');
      await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
      await expect(page.locator('#toast')).toContainText('Controlled submission failed');
      await selectTask(page, 1, view);
      await expect(prompt(page)).toHaveValue('Restore this task one draft if submission fails.');
      await expect(prompt(page)).toBeEnabled();
      const sends = await page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => call.command === 'send_message'));
      expect(sends.map((call: any) => call.sessionId)).toEqual(['session-1', 'session-2']);
    });
  }

  test('clears a successfully submitted background draft after a delayed file read without consuming another task draft', async ({ page }) => {
    await installConcurrency(page);
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach package.json', exact: true }).click();
    await expect(page.locator('#attachments')).toContainText('package.json');
    await page.evaluate(() => { (window as any).__concurrent.holdReads['session-1'] = true; });
    await prompt(page).fill('Send with the attached file.');
    await prompt(page).press('Enter');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.releaseReads['session-1'])).toBe('function');
    await selectTask(page, 2, 'conversation');
    await prompt(page).fill('Preserve the second task draft.');
    await page.evaluate(() => (window as any).__concurrent.releaseReads['session-1']());
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__concurrent.tasks['session-1']?.running))).toBe(true);
    await expect(prompt(page)).toHaveValue('Preserve the second task draft.');
    await page.evaluate(() => { const task = (window as any).__concurrent.tasks['session-1']; task.push('Attached file received.'); task.done(); });
    await selectTask(page, 1, 'conversation');
    await expect(transcript(page)).toContainText('Attached file received.');
    await expect(prompt(page)).toHaveValue('');
    await expect(page.locator('#attachments')).toBeEmpty();
    await selectTask(page, 2, 'conversation');
    await expect(prompt(page)).toHaveValue('Preserve the second task draft.');
  });
});

test('concurrency approval expiration removes only its owning task and a late expiration cannot revive a finished task', async ({ page }) => {
  await installConcurrency(page);
  for (let index = 1; index <= 2; index++) await startTask(page, index, 'conversation');
  await page.evaluate(() => {
    const fixture = (window as any).__concurrent;
    fixture.tasks['session-1'].approval(); fixture.tasks['session-2'].approval();
    fixture.tasks['session-1'].cancelApproval();
  });
  await expect(page.locator('.approval-bar')).toContainText('Approve operation for Concurrent task 2');
  await selectTask(page, 1, 'conversation');
  await expect(page.locator('.approval-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__concurrent;
    fixture.tasks['session-1'].push('Task one finished.'); fixture.tasks['session-1'].done();
  });
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(transcript(page).locator('.agent-message .message-content')).toHaveText('Task one finished.');
  await page.evaluate(() => (window as any).__concurrent.tasks['session-1'].cancelApproval());
  await settlePaint(page);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(prompt(page)).toBeEnabled();
  await selectTask(page, 2, 'conversation');
  await expect(page.locator('.approval-bar')).toContainText('Approve operation for Concurrent task 2');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
});

for (const edited of [false, true]) {
  test(`concurrency updates the current composer after returning during attachment preparation${edited ? ' and preserves a newer draft' : ''}`, async ({ page }) => {
    await installConcurrency(page);
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach package.json', exact: true }).click();
    await page.evaluate(() => { (window as any).__concurrent.holdReads['session-1'] = true; });
    await prompt(page).fill('Prepare this attached request.');
    await prompt(page).press('Enter');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.releaseReads['session-1'])).toBe('function');
    await selectTask(page, 2, 'conversation');
    if (!edited) await page.evaluate(() => { (window as any).__concurrent.holdSnapshot['session-1'] = true; });
    await selectTask(page, 1, 'conversation');
    if (!edited) await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.releaseSnapshot['session-1'])).toBe('function');
    if (edited) await prompt(page).fill('A newer unsent follow-up.');
    await page.evaluate(() => (window as any).__concurrent.releaseReads['session-1']());
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    // The prompt waits for held history, then stays open during the run so follow-ups can be queued.
    if (!edited) {
      await expect(prompt(page)).toBeDisabled();
      await page.evaluate(() => { const fixture = (window as any).__concurrent; fixture.holdSnapshot['session-1'] = false; fixture.releaseSnapshot['session-1'](); });
      await settlePaint(page);
    }
    await expect(prompt(page)).toBeEnabled();
    await expect(prompt(page)).toHaveAttribute('placeholder', /Queue a follow-up/);
    await expect(transcript(page).locator('.user-message')).toHaveCount(1);
    await expect(transcript(page)).toContainText('Prepare this attached request.');
    await page.evaluate(() => { const task = (window as any).__concurrent.tasks['session-1']; task.push('The prepared task responded.'); task.done(); });
    await expect(prompt(page)).toBeEnabled();
    await expect(prompt(page)).toHaveValue(edited ? 'A newer unsent follow-up.' : '');
    await expect(transcript(page).locator('.agent-message .message-content')).toHaveText('The prepared task responded.');
    await expect(page.locator('#attachments')).toBeEmpty();
  });
}

test('concurrency restores a failed submission after returning to its task before admission resolves', async ({ page }) => {
  await installConcurrency(page);
  await page.evaluate(() => { (window as any).__concurrent.holdSends['session-1'] = true; });
  await prompt(page).fill('Restore after leaving and returning.');
  await prompt(page).press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.rejectSends['session-1'])).toBe('function');
  await selectTask(page, 2, 'conversation');
  await selectTask(page, 1, 'conversation');
  await page.evaluate(() => (window as any).__concurrent.rejectSends['session-1']());
  await expect(prompt(page)).toBeEnabled();
  await expect(prompt(page)).toHaveValue('Restore after leaving and returning.');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Controlled submission failed');
});

test('concurrency rejects a duplicate composer send while Board Start is waiting for workspace preparation', async ({ page }) => {
  await installConcurrency(page);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.evaluate(() => { (window as any).__concurrent.holdInspector['session-2'] = true; });
  await page.locator('[data-action="board-start"][data-id="session-2"]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.releaseInspector['session-2'])).toBe('function');
  await prompt(page).fill('This duplicate must not start another run.');
  await prompt(page).press('Enter');
  await settlePaint(page);
  expect(await page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => call.command === 'send_message' || call.command === 'start_task'))).toEqual([]);
  await page.evaluate(() => (window as any).__concurrent.releaseInspector['session-2']());
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__concurrent.calls.filter((call: any) => call.command === 'send_message'));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ sessionId: 'session-2', text: 'Prompt for task 2' });
});

test('concurrency keeps a completed response visible when an older task-selection snapshot arrives during the final history handoff', async ({ page }) => {
  await installConcurrency(page);
  await startTask(page, 1, 'conversation');
  await page.evaluate(() => (window as any).__concurrent.tasks['session-1'].push('The answer begins. '));
  await expect(live(page)).toHaveText('The answer begins.');
  await selectTask(page, 2, 'conversation');
  await page.evaluate(() => { (window as any).__concurrent.holdSnapshot['session-1'] = true; });
  await selectTask(page, 1, 'conversation');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.releaseSnapshot['session-1'])).toBe('function');
  await page.evaluate(() => {
    const fixture = (window as any).__concurrent;
    fixture.holdSnapshot['session-1'] = false;
    fixture.holdHistory['session-1'] = true;
    fixture.tasks['session-1'].push('The final answer stays visible.');
    fixture.tasks['session-1'].done();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__concurrent.releaseHistory['session-1']?.length ?? 0)).toBeGreaterThan(0);
  await expectCompletedResponse(page, 'The answer begins. The final answer stays visible.');
  await page.evaluate(() => (window as any).__concurrent.releaseSnapshot['session-1']());
  await settlePaint(page);
  await expectCompletedResponse(page, 'The answer begins. The final answer stays visible.');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(page.locator('.streaming-label')).toBeHidden();
  await page.evaluate(() => {
    const fixture = (window as any).__concurrent;
    fixture.holdHistory['session-1'] = false;
    for (const release of fixture.releaseHistory['session-1']) release();
  });
  await expect(prompt(page)).toBeEnabled();
  await expect(transcript(page).locator('.agent-message')).toHaveCount(1);
  await expectCompletedResponse(page, 'The answer begins. The final answer stays visible.');
});

test('concurrency ignores a rejected old selection request after the completed response has loaded', async ({ page }) => {
  await installConcurrency(page);
  await startTask(page, 1, 'conversation');
  await page.evaluate(() => (window as any).__concurrent.tasks['session-1'].push('A completed answer must remain readable.'));
  await selectTask(page, 2, 'conversation');
  await page.evaluate(() => { (window as any).__concurrent.holdSnapshot['session-1'] = true; });
  await selectTask(page, 1, 'conversation');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__concurrent.rejectSnapshot['session-1'])).toBe('function');
  await page.evaluate(() => {
    const fixture = (window as any).__concurrent;
    fixture.holdSnapshot['session-1'] = false;
    fixture.tasks['session-1'].done();
  });
  await expect(prompt(page)).toBeEnabled();
  await expect(transcript(page).locator('.agent-message .message-content')).toHaveText('A completed answer must remain readable.');
  await page.evaluate(() => (window as any).__concurrent.rejectSnapshot['session-1']());
  await settlePaint(page);
  await expect(prompt(page)).toBeEnabled();
  await expect(transcript(page).locator('.agent-message .message-content')).toHaveText('A completed answer must remain readable.');
  await expect(transcript(page)).not.toContainText('Unable to load this task');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
});

test('concurrency sidebar timers update for background and pinned tasks and reset on a new run', async ({ page }) => {
  await installConcurrency(page, 3);
  await page.clock.install();
  await startTask(page, 1, 'conversation');
  await startTask(page, 2, 'conversation');
  const row = (index: number) => page.locator(`.task-item[data-id="${taskId(index)}"]`);
  const timer = (index: number) => row(index).locator('.task-runtime');
  await row(2).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await expect(row(2)).toHaveAttribute('data-pinned', 'true');
  await selectTask(page, 3, 'conversation');
  await prompt(page).fill('Keep this draft while clocks update.');
  await expect(timer(1)).toBeVisible();
  await expect(timer(2)).toBeVisible();
  await expect(timer(3)).toHaveCount(0);
  await page.clock.fastForward(125000);
  await expect(timer(1)).toHaveText(/^2m \d+s$/);
  await expect(timer(2)).toHaveText(/^2m \d+s$/);
  const elapsed = await timer(1).textContent();
  await page.clock.fastForward(1000);
  await expect(timer(1)).not.toHaveText(elapsed!);
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('Keep this draft while clocks update.');
  await row(1).click({ button: 'right' });
  await page.clock.fastForward(1000);
  await expect(page.getByRole('dialog', { name: 'Task actions', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const task = (window as any).__concurrent.tasks['session-1']; task.push('Finished.'); task.done(); });
  await expect(timer(1)).toHaveCount(0);
  // While the row is hovered or focused its actions cover the age slot (Escape returned focus to the row).
  await page.mouse.move(700, 500);
  await prompt(page).focus();
  await expect(row(1).locator('.task-age')).toBeVisible();
  await startTask(page, 1, 'conversation');
  await expect(timer(1)).toHaveText(/^\d+s$/);
});

test('concurrency sidebar timer restores a running task from its saved prompt timestamp', async ({ page }) => {
  await page.clock.install();
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /const providers\s*=/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, "sessions[0].status = 'running'; sessions[0].lastPromptAt = now - 125000; const providers =") });
  });
  await page.goto('/');
  const timer = page.locator('.task-item[data-id="session-1"] .task-runtime');
  await expect(timer).toHaveText(/^2m \d+s$/);
  const elapsed = await timer.textContent();
  await page.clock.fastForward(1000);
  await expect(timer).not.toHaveText(elapsed!);
});
