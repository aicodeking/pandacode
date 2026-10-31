import { expect, test, type Locator, type Page } from '@playwright/test';

type View = 'conversation' | 'board';
type Subagent = {
  id: string; parentId: string | null; name: string; prompt: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'; response: string;
  tools: { id: string; name: string; status: string; input: string; output: string }[];
  startedAt: number; updatedAt: number;
};
// Subagents open from the action dock's Agents item, named with the running count.
const trigger = (page: Page) => page.locator('#agents-toggle');
const panel = (page: Page) => page.getByRole('region', { name: 'Subagents', exact: true });
const response = (page: Page) => panel(page).locator('.subagent-response');
const row = (page: Page, id: string) => panel(page).locator(`button[data-subagent-id="${id}"]`);
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const errors = new WeakMap<Page, string[]>();
const child = (id: string, name: string, changes: Partial<Subagent> = {}): Subagent => ({
  id, parentId: null, name, prompt: `Work assigned to ${name}.`, status: 'running', response: '', tools: [],
  startedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001, ...changes,
});
test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

// Exercises the real UI/event handlers with deterministic provider snapshots, without running agents.
async function installSubagents(page: Page, seeds: Record<string, Subagent[]> = {}): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const original = await route.fetch();
    const source = await original.text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    const fixture = `
      if (!window.__subagents) {
        sessions = Array.from({ length: 3 }, (_, index) => ({
          id: 'session-' + (index + 1), projectId: 'project-1', title: 'Delegated task ' + (index + 1),
          provider: ['claude', 'codex', 'kimi'][index], model: '', mode: 'ask', status: 'running',
          createdAt: now - index, updatedAt: now - index, archived: false, worktreePath: null,
          resumeId: null, lastResponseAt: now - index, taskStage: 'in_progress', taskDescription: '', completedAt: null
        }));
        for (const s of sessions) messages[s.id] = [
          { id: ++id, sessionId: s.id, role: 'user', content: 'Parent request for ' + s.title, createdAt: now - 2000 },
          { id: ++id, sessionId: s.id, role: 'assistant', content: 'Parent response for ' + s.title, createdAt: now - 1000 }
        ];
        window.__subagents = {
          snapshots: ${JSON.stringify(seeds)}, calls: [], hold: {}, release: {}, reject: {},
          upsert(sessionId, data) {
            const list = this.snapshots[sessionId] ??= [];
            const index = list.findIndex(item => item.id === data.id);
            if (index < 0) list.push(structuredClone(data)); else list[index] = structuredClone(data);
            agent({ sessionId, kind: 'subagent', text: '', data: structuredClone(data) });
          },
          parentText(sessionId, text) { agent({ sessionId, kind: 'text', text }); },
          publishOverlay(target) { emit('overlay-open-task', structuredClone(target)); },
          refresh() { emit('sessions-changed', {}); },
        };
      }
      const fixture = window.__subagents;
      fixture.calls.push({ command, ...args });
      if (command === 'list_subagents') {
        const snapshot = structuredClone(fixture.snapshots[args.sessionId] ?? []);
        if (fixture.hold[args.sessionId]) await new Promise((resolve, reject) => {
          (fixture.release[args.sessionId] ??= []).push(resolve);
          (fixture.reject[args.sessionId] ??= []).push(() => reject(new Error('Subagent history temporarily unavailable')));
        });
        return snapshot;
      }
      switch (command) {`;
    await route.fulfill({ response: original, body: source.replace(marker, fixture) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Delegated task 1');
  await expect(transcript(page)).toContainText('Parent response for Delegated task 1');
}

async function upsert(page: Page, agents: Subagent[], sessionId = 'session-1'): Promise<void> {
  await page.evaluate(({ agents, sessionId }) => {
    for (const agent of agents) (window as any).__subagents.upsert(sessionId, agent);
  }, { agents, sessionId });
}

async function selectTask(page: Page, index: number, view: View): Promise<void> {
  if (view === 'board') await page.locator(`[data-action="board-open"][data-id="session-${index}"]`).click();
  else await page.locator(`.task-item[data-id="session-${index}"]`).click();
  await expect(transcript(page)).toContainText(`Parent response for Delegated task ${index}`);
}

async function useView(page: Page, view: View): Promise<void> {
  if (view === 'board') {
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await selectTask(page, 1, view);
  }
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function subagentSurface(element: Locator) {
  return element.evaluate(node => {
    const style = getComputedStyle(node);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
    return { color: style.backgroundColor, alpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
      image: style.backgroundImage, blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') };
  });
}

test.describe('subagents', () => {
  for (const theme of ['light', 'dark'] as const) for (const view of ['conversation', 'board'] as const) {
    test(`subagents are one solid surface and keep detail sharp in ${theme} ${view}`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.addInitScript(theme => {
        localStorage.setItem('pandacode.theme', theme);
        localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ enabled: true, visibility: 35, pinned: 'mon-morning' }));
      }, theme);
      await installSubagents(page, { 'session-1': [child('reader', 'Reader', {
        response: '**Search is ready.** The index now reuses its cached entries.\n\n```ts\nconst index = cachedIndex;\n```',
      }), child('reviewer', 'Reviewer')] });
      await useView(page, view);
      await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-morning');
      await trigger(page).click(); await expect(panel(page)).toBeVisible();
      await expect(panel(page)).toHaveCSS('opacity', '1'); await expect(panel(page)).toHaveCSS('filter', 'none');
      // The Agents flyout around the panel is the app's glass: translucent over a blur, with no gradient or border.
      const material = await subagentSurface(page.locator('#agents-flyout'));
      expect(material.alpha).toBeLessThan(1); expect(material.image).toBe('none');
      expect(material.blur).toContain('blur');
      await expect(panel(page)).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      const normalRow = await row(page, 'reader').evaluate(node => getComputedStyle(node).backgroundColor);
      await row(page, 'reader').hover();
      await expect(row(page, 'reader')).not.toHaveCSS('background-color', normalRow);
      await expect(row(page, 'reader').locator('strong')).toBeVisible();
      await page.screenshot({ path: `/private/tmp/pandacode-subagents-frost-${browserName}-${theme}-${view}-list.png`, animations: 'disabled' });
      await row(page, 'reader').click();
      await expect(response(page)).toContainText('Search is ready.');
      await expect(response(page)).toHaveCSS('filter', 'none'); await expect(response(page)).toHaveCSS('opacity', '1');
      expect(await subagentSurface(page.locator('#agents-flyout'))).toEqual(material);
      expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `/private/tmp/pandacode-subagents-frost-${browserName}-${theme}-${view}-detail.png`, animations: 'disabled' });
      const preferences = browserName === 'chromium' ? ['prefers-contrast', 'prefers-reduced-transparency'] : ['prefers-contrast'];
      const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
      for (const name of preferences) {
        if (cdp) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }] });
        else await page.emulateMedia({ contrast: 'more' });
        await expect(page.locator('.workspace')).not.toHaveAttribute('data-wallpaper');
        await expect(panel(page)).toBeVisible(); await expect(response(page)).toContainText('Search is ready.');
        const accessible = await subagentSurface(page.locator('#agents-flyout'));
        expect(accessible.alpha).toBe(1); expect(accessible.blur).toBe('none'); expect(accessible.image).toBe('none');
        if (cdp) await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        else await page.emulateMedia({ contrast: 'no-preference' });
        await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-morning');
        expect(await subagentSurface(page.locator('#agents-flyout'))).toEqual(material);
      }
      await cdp?.detach();
    });
  }

  test('copies a subagent assignment and current response without exposing a synthetic fork', async ({page}) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (text:string) => { (window as any).__copiedMessage = text; }}});
    });
    const agent = child('reader','Reader',{response:'**Found it.**\n\n`src/search.ts`'});
    await installSubagents(page,{'session-1':[agent]});
    await trigger(page).click(); await row(page,'reader').click();
    await panel(page).getByText('Assignment',{exact:true}).click();
    await panel(page).locator('.subagent-assignment-actions').getByRole('button',{name:'Copy message',exact:true}).click();
    expect(await page.evaluate(() => (window as any).__copiedMessage)).toBe(agent.prompt);
    await panel(page).locator('.subagent-response-actions').getByRole('button',{name:'Copy message',exact:true}).click();
    expect(await page.evaluate(() => (window as any).__copiedMessage)).toBe(agent.response);
    await expect(panel(page).getByRole('button',{name:'Fork from here'})).toHaveCount(0);
    await upsert(page,[{...agent,response:'Updated **result**.'}]);
    await expect(response(page)).toContainText('Updated result.');
    await panel(page).locator('.subagent-response-actions button').click();
    expect(await page.evaluate(() => (window as any).__copiedMessage)).toBe('Updated **result**.');
  });

  for (const view of ['conversation', 'board'] as const) {
    test(`overlay navigation opens the requested subagent and preserves its live detail in ${view}`, async ({ page }) => {
      await installSubagents(page, {
        'session-1': [child('shared', 'First task child', { response: 'Do not show the previous task child.' })],
        'session-2': [child('other', 'Other child', { response: 'Unselected child response.' }), child('shared', 'Selected reviewer', { response: 'Saved target child response.' })],
      });
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      await page.evaluate(() => (window as any).__subagents.publishOverlay({ sessionId: 'session-2', subagentId: 'shared' }));
      await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Selected reviewer');
      await expect(response(page)).toHaveText('Saved target child response.');
      await expect(panel(page)).not.toContainText('Do not show the previous task child.');
      if (view === 'board') await expect(page.getByRole('region', { name: 'Task details', exact: true })).toBeVisible();
      await page.evaluate(() => { (window as any).__overlayChildPanel = document.querySelector('#subagents-panel'); });
      await upsert(page, [child('shared', 'Selected reviewer', { response: 'Live target child response.', updatedAt: 1_800_000_000_010 })], 'session-2');
      await upsert(page, [child('shared', 'First task child', { response: 'Background child belongs to the first task.', updatedAt: 1_800_000_000_020 })]);
      await page.evaluate(() => (window as any).__subagents.refresh());
      await expect(response(page)).toHaveText('Live target child response.');
      await nextPaint(page);
      expect(await page.evaluate(() => (window as any).__overlayChildPanel === document.querySelector('#subagents-panel'))).toBe(true);
      await expect(transcript(page)).not.toContainText('Live target child response.');
      await expect(panel(page)).not.toContainText('Background child belongs to the first task.');
      await upsert(page, [child('shared', 'Selected reviewer', { status: 'completed', response: 'Completed target child response.', updatedAt: 1_800_000_000_030 })], 'session-2');
      await expect(response(page)).toHaveText('Completed target child response.');
      await expect(panel(page).locator('.subagent-detail-status')).toHaveText('Completed');
    });

    test(`shows live child counts, nested work and completed responses in ${view}`, async ({ page }) => {
      await installSubagents(page);
      await useView(page, view);
      await expect(trigger(page)).toBeHidden();
      await upsert(page, [child('reader', 'Reader'), child('reviewer', 'Reviewer')]);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
      await trigger(page).click();
      await expect(panel(page)).toBeVisible();
      await expect(row(page, 'reader')).toContainText('Reader');
      await expect(row(page, 'reviewer')).toContainText('Reviewer');
      await upsert(page, [child('tests', 'Test runner', { parentId: 'reader' })]);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Agents: 3 running');
      await expect(row(page, 'tests')).toContainText('Test runner');
      await expect(row(page, 'tests')).toContainText('Reader');
      await page.screenshot({ path: `/private/tmp/pandacode-subagents-${view}-list.png`, animations: 'disabled' });
      await row(page, 'reader').click();
      await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Reader');
      await expect(panel(page)).toContainText('Work assigned to Reader.');
      await upsert(page, [child('reader', 'Reader', {
        response: '**Found the issue.** The search index rebuilds on each key.',
        tools: [{ id: 'read-1', name: 'Read', status: 'completed', input: 'src/search.ts', output: 'const index = buildIndex(items);' }],
        updatedAt: 1_800_000_000_002,
      })]);
      await expect(response(page)).toContainText('Found the issue.');
      await expect(response(page).locator('strong')).toHaveText('Found the issue.');
      await expect(panel(page).locator('.subagent-tools')).toContainText('Read');
      await panel(page).locator('.subagent-tools details.tool-activity > summary').click();
      // The card names the file by basename; its chip carries the full path.
      await expect(panel(page).locator('.subagent-tools')).toContainText('search.ts');
      await expect(panel(page).locator('.subagent-tools .tool-trace-chip').first()).toHaveAttribute('title', 'src/search.ts');
      await expect(panel(page).locator('.subagent-tools')).toContainText('const index = buildIndex(items);');
      await page.screenshot({ path: `/private/tmp/pandacode-subagents-${view}-detail.png`, animations: 'disabled' });
      await upsert(page, [child('reader', 'Reader', { status: 'completed', response: 'Index reuse fixed.', updatedAt: 1_800_000_000_003 })]);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
      await expect(response(page)).toHaveText('Index reuse fixed.');
      await expect(transcript(page)).not.toContainText('Index reuse fixed.');
      await panel(page).getByRole('button', { name: 'Back to Subagents', exact: true }).click();
      await expect(row(page, 'reader')).toContainText(/completed/i);
      await upsert(page, [child('reviewer', 'Reviewer', { status: 'failed' }), child('tests', 'Test runner', { parentId: 'reader', status: 'stopped' })]);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Agents');
      await expect(row(page, 'reviewer')).toContainText(/failed/i);
      await expect(row(page, 'tests')).toContainText(/stopped/i);
    });

    test(`isolates shared child IDs while switching ${view} tasks and returning to saved work`, async ({ page }) => {
      await installSubagents(page, {
        'session-1': [child('shared', 'Task one reviewer', { status: 'completed', response: 'Saved review for task one.' })],
        'session-2': [child('shared', 'Task two reviewer', { response: 'Working on task two.' })],
      });
      await useView(page, view);
      await trigger(page).click();
      await row(page, 'shared').click();
      await expect(response(page)).toHaveText('Saved review for task one.');
      await selectTask(page, 2, view);
      if (!await panel(page).isVisible()) await trigger(page).click();
      if (await row(page, 'shared').isVisible()) await row(page, 'shared').click();
      await expect(response(page)).toHaveText('Working on task two.');
      await upsert(page, [child('shared', 'Task one reviewer', { status: 'completed', response: 'Background revision belongs to task one.', updatedAt: 1_800_000_000_100 })]);
      await expect(response(page)).toHaveText('Working on task two.');
      await expect(transcript(page)).not.toContainText('Background revision');
      await selectTask(page, 1, view);
      if (!await panel(page).isVisible()) await trigger(page).click();
      if (await row(page, 'shared').isVisible()) await row(page, 'shared').click();
      await expect(response(page)).toHaveText('Background revision belongs to task one.');
      await expect(panel(page)).not.toContainText('Working on task two.');
    });

    test(`streams selected child work without remounting controls in ${view}`, async ({ page }) => {
      await installSubagents(page, { 'session-1': [child('writer', 'Writer', { response: 'Beginning. ' }), child('checker', 'Checker')] });
      await useView(page, view);
      await trigger(page).click();
      await row(page, 'writer').click();
      await expect(response(page)).toHaveText('Beginning.');
      await page.evaluate(() => {
        (window as any).__subagentNodes = {
          panel: document.querySelector('#subagents-panel'), response: document.querySelector('.subagent-response'),
          back: document.querySelector('[aria-label="Back to Subagents"]'), composer: document.querySelector('#composer'),
        };
      });
      await page.evaluate(async () => {
        const fixture = (window as any).__subagents;
        for (let index = 1; index <= 35; index++) {
          const saved = fixture.snapshots['session-1'].find((agent: any) => agent.id === 'writer');
          fixture.upsert('session-1', { ...saved, response: saved.response + `word${index} `, updatedAt: saved.updatedAt + 1 });
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      });
      await expect(response(page)).toContainText('word35');
      expect(await page.evaluate(() => {
        const nodes = (window as any).__subagentNodes;
        return { panel: nodes.panel === document.querySelector('#subagents-panel'), response: nodes.response === document.querySelector('.subagent-response'),
          back: nodes.back === document.querySelector('[aria-label="Back to Subagents"]'), composer: nodes.composer === document.querySelector('#composer') };
      })).toEqual({ panel: true, response: true, back: true, composer: true });
      await expect(transcript(page)).not.toContainText('word35');
    });
  }

  test('merges an older history request with newer live child snapshots', async ({ page }) => {
    await installSubagents(page, { 'session-2': [child('old', 'Existing child', { response: 'Stale response.' })] });
    await page.evaluate(() => { (window as any).__subagents.hold['session-2'] = true; });
    await selectTask(page, 2, 'conversation');
    await expect.poll(() => page.evaluate(() => (window as any).__subagents.release['session-2']?.length ?? 0)).toBeGreaterThan(0);
    await upsert(page, [child('old', 'Existing child', { status: 'completed', response: 'New live final response.', updatedAt: 1_800_000_000_020 }), child('new', 'New child')], 'session-2');
    await trigger(page).click();
    await row(page, 'old').click();
    await expect(response(page)).toHaveText('New live final response.');
    await page.evaluate(() => {
      const fixture = (window as any).__subagents;
      fixture.hold['session-2'] = false;
      for (const resolve of fixture.release['session-2']) resolve();
    });
    await nextPaint(page);
    await expect(response(page)).toHaveText('New live final response.');
    await panel(page).getByRole('button', { name: 'Back to Subagents', exact: true }).click();
    await expect(row(page, 'old')).toContainText(/completed/i);
    await expect(row(page, 'new')).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  });

  test('does not display a previous task when its delayed subagent history resolves', async ({ page }) => {
    await installSubagents(page, {
      'session-2': [child('second', 'Second task child', { response: 'Do not leak this delayed response.' })],
      'session-3': [child('third', 'Third task child', { response: 'Selected task response.' })],
    });
    await page.evaluate(() => { (window as any).__subagents.hold['session-2'] = true; });
    await selectTask(page, 2, 'conversation');
    await expect.poll(() => page.evaluate(() => (window as any).__subagents.release['session-2']?.length ?? 0)).toBeGreaterThan(0);
    await selectTask(page, 3, 'conversation');
    await trigger(page).click();
    await row(page, 'third').click();
    await expect(response(page)).toHaveText('Selected task response.');
    await page.evaluate(() => {
      const fixture = (window as any).__subagents;
      fixture.hold['session-2'] = false;
      for (const resolve of fixture.release['session-2']) resolve();
    });
    await nextPaint(page);
    await expect(response(page)).toHaveText('Selected task response.');
    await expect(panel(page)).not.toContainText('Do not leak');
  });

  test('renders untrusted names, prompts, tool output and response safely', async ({ page }) => {
    const malicious = '<img src=x onerror="window.__subagentXss=1">';
    await installSubagents(page, { 'session-1': [child('unsafe', malicious, {
      prompt: '<svg onload="window.__subagentXss=2">Prompt</svg>',
      response: '**Visible answer.** <script>window.__subagentXss=3</script> [bad](javascript:window.__subagentXss=4)',
      tools: [{ id: 'tool', name: '<iframe srcdoc="bad">', status: 'completed', input: malicious, output: '<script>window.__subagentXss=5</script>' }],
    })] });
    await trigger(page).click();
    await expect(row(page, 'unsafe')).toContainText(malicious);
    await row(page, 'unsafe').click();
    await expect(response(page)).toContainText('Visible answer.');
    await expect(response(page).locator('strong')).toHaveText('Visible answer.');
    await panel(page).locator('.subagent-tools details.tool-activity > summary').click();
    await expect(panel(page).locator('.subagent-tools')).toContainText(malicious);
    await expect(panel(page).locator('script, iframe, img[onerror], svg[onload], a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__subagentXss)).toBeUndefined();
  });

  test('restores the same response when revisiting a child or opening a sibling with identical text', async ({ page }) => {
    const sharedResponse = '**Shared result.** Both reviewers reached the same conclusion.';
    await installSubagents(page, { 'session-1': [
      child('first', 'First reviewer', { response: sharedResponse, status: 'completed' }),
      child('second', 'Second reviewer', { response: sharedResponse, status: 'completed' }),
    ] });
    await trigger(page).click();
    for (const id of ['first', 'first', 'second', 'first']) {
      await row(page, id).click();
      await expect(response(page)).toHaveText('Shared result. Both reviewers reached the same conclusion.');
      await expect(response(page).locator('strong')).toHaveText('Shared result.');
      await panel(page).getByRole('button', { name: 'Back to Subagents', exact: true }).click();
    }
  });

  test('keeps distinct long tool IDs and both disclosures intact across live updates', async ({ page }) => {
    const prefix = 'run:' + 'x'.repeat(508);
    const tools = [
      { id: prefix + 'a'.repeat(38), name: 'First tool', status: 'running', input: 'read first.ts', output: 'First partial output.' },
      { id: prefix + 'b'.repeat(38), name: 'Second tool', status: 'running', input: 'read second.ts', output: 'Second partial output.' },
    ];
    await installSubagents(page, { 'session-1': [child('long-tools', 'Long tool reviewer', { tools })] });
    await trigger(page).click();
    await row(page, 'long-tools').click();
    const disclosures = panel(page).locator('.subagent-tools details.tool-activity');
    await expect(disclosures).toHaveCount(2);
    await disclosures.nth(0).locator(':scope > summary').click();
    await disclosures.nth(1).locator(':scope > summary').click();
    await upsert(page, [child('long-tools', 'Long tool reviewer', {
      tools: tools.map((tool, index) => ({ ...tool, status: 'completed', output: `${index === 0 ? 'First' : 'Second'} complete output.` })),
      updatedAt: 1_800_000_000_020,
    })]);
    await expect(disclosures).toHaveCount(2);
    await expect(disclosures.nth(0)).toHaveAttribute('open', '');
    await expect(disclosures.nth(1)).toHaveAttribute('open', '');
    await expect(disclosures.nth(0)).toContainText('First complete output.');
    await expect(disclosures.nth(1)).toContainText('Second complete output.');
    expect(await disclosures.evaluateAll(elements => elements.map(element => element.getAttribute('data-tool-key'))))
      .toEqual(tools.map(tool => `subagent-tool:${tool.id}`));
  });

  test('preserves keyboard output reading focus and scroll when a child tool streams an update', async ({ page }) => {
    const tool = { id: 'reading', name: 'Read log', status: 'running', input: 'tail build.log',
      output: Array.from({ length: 45 }, (_, index) => `Output line ${index}: useful build details.`).join('\n') };
    await installSubagents(page, { 'session-1': [child('reader', 'Log reviewer', { tools: [tool] })] });
    await trigger(page).click();
    await row(page, 'reader').click();
    await panel(page).locator('.subagent-tools details.tool-activity > summary').click();
    await panel(page).locator('.subagent-tools .tool-trace-raw > summary').click();
    const output = panel(page).locator('.subagent-tools pre[aria-label="Tool output"]');
    await output.focus();
    await output.evaluate(element => { element.scrollTop = 120; });
    await expect(output).toBeFocused();
    expect(await output.evaluate(element => element.scrollTop)).toBe(120);
    await upsert(page, [child('reader', 'Log reviewer', {
      tools: [{ ...tool, output: tool.output + '\nMore streamed output arrives while reading.' }], updatedAt: 1_800_000_000_020,
    })]);
    await expect(output).toContainText('More streamed output arrives while reading.');
    await expect(output).toBeFocused();
    expect(await output.evaluate(element => element.scrollTop)).toBe(120);
  });

  test('retries failed history while retaining newer live updates', async ({ page }) => {
    await installSubagents(page, { 'session-2': [child('saved', 'Saved reviewer', { response: 'Older saved work.', status: 'completed' })] });
    await page.evaluate(() => { (window as any).__subagents.hold['session-2'] = true; });
    await selectTask(page, 2, 'conversation');
    await expect.poll(() => page.evaluate(() => (window as any).__subagents.reject['session-2']?.length ?? 0)).toBe(1);
    await page.evaluate(() => (window as any).__subagents.reject['session-2'][0]());
    await trigger(page).click();
    await expect(panel(page)).toContainText('Couldn’t load saved subagents.');
    await upsert(page, [child('live', 'Live reviewer', { response: 'Still working despite history failure.' })], 'session-2');
    await expect(row(page, 'live')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Retry loading subagents', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__subagents.release['session-2']?.length ?? 0)).toBe(2);
    await upsert(page, [child('live', 'Live reviewer', { response: 'Completed during retry.', status: 'completed', updatedAt: 1_800_000_000_030 })], 'session-2');
    await row(page, 'live').click();
    await expect(response(page)).toHaveText('Completed during retry.');
    await page.evaluate(() => {
      const fixture = (window as any).__subagents;
      fixture.hold['session-2'] = false;
      fixture.release['session-2'][1]();
    });
    await nextPaint(page);
    await expect(response(page)).toHaveText('Completed during retry.');
    await panel(page).getByRole('button', { name: 'Back to Subagents', exact: true }).click();
    await expect(row(page, 'saved')).toBeVisible();
    await expect(row(page, 'live')).toContainText(/completed/i);
    await expect(panel(page).getByRole('button', { name: 'Retry loading subagents', exact: true })).toBeHidden();
  });

  test('closes with Escape and supports keyboard drilldown without stopping the parent', async ({ page }) => {
    await installSubagents(page, { 'session-1': [child('keyboard', 'Keyboard reviewer', { response: 'Keyboard-accessible details.' })] });
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await row(page, 'keyboard').focus();
    await page.keyboard.press('Enter');
    await expect(response(page)).toHaveText('Keyboard-accessible details.');
    await panel(page).getByRole('button', { name: 'Back to Subagents', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(row(page, 'keyboard')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await panel(page).getByRole('button', { name: 'Close subagents', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    expect(await page.evaluate(() => (window as any).__subagents.calls.filter((call: any) => call.command === 'stop_session'))).toEqual([]);
  });

  test('gives a foreground project picker Escape priority over the subagent panel', async ({ page }) => {
    await installSubagents(page, { 'session-1': [child('keyboard', 'Keyboard reviewer')] });
    await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    const projects = page.getByRole('button', { name: 'Filter projects', exact: true });
    await projects.click();
    const picker = page.getByRole('dialog', { name: 'Filter projects', exact: true });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(projects).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(await page.evaluate(() => (window as any).__subagents.calls.filter((call: any) => call.command === 'stop_session'))).toEqual([]);
  });

  test('avoids rendering hidden child responses and keeps background events out of the parent transcript', async ({ page }) => {
    await installSubagents(page, { 'session-1': [child('hidden', 'Background reader')] });
    await expect(trigger(page)).toBeVisible();
    await nextPaint(page);
    await page.evaluate(() => {
      const metric = (window as any).__subagentMetric = { mutations: 0, observer: null as MutationObserver | null };
      metric.observer = new MutationObserver(records => { metric.mutations += records.length; });
      metric.observer.observe(document.querySelector('#transcript')!, { childList: true, subtree: true, characterData: true });
    });
    await page.evaluate(async () => {
      const fixture = (window as any).__subagents;
      for (let index = 0; index < 40; index++) {
        const saved = fixture.snapshots['session-1'][0];
        fixture.upsert('session-1', { ...saved, response: `# Hidden child result\n\n${'Detailed hidden work. '.repeat(1000)} ${index}`, updatedAt: saved.updatedAt + 1 });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    });
    await nextPaint(page);
    const mutations = await page.evaluate(() => { const metric = (window as any).__subagentMetric; metric.observer.disconnect(); return metric.mutations; });
    expect(mutations).toBe(0);
    await expect(page.locator('.subagent-response')).toHaveCount(0);
    await expect(transcript(page)).not.toContainText('Hidden child result');
    await trigger(page).click();
    await row(page, 'hidden').click();
    await expect(response(page)).toContainText('Hidden child result');
    await expect(response(page)).toContainText('39');
  });

  test('keeps the floating subagent panel inside a narrow thread and supports the light theme', async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 700 });
    await page.addInitScript(() => { localStorage.setItem('pandacode.theme', 'light'); });
    await installSubagents(page, { 'session-1': [child('long', 'A reviewer with a long name that must not overflow the panel', {
      response: 'A compact response with `a_long_unbroken_identifier_that_should_stay_inside_the_details_panel_without_overflowing`.',
    })] });
    await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    await row(page, 'long').click();
    const bounds = await panel(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(921);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(701);
    expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: '/private/tmp/pandacode-subagents-light.png', animations: 'disabled' });
  });
});
