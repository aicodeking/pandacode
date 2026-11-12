import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TeamConfig, TeamSnapshot, TeamWorker } from '../src/architect-types';
import type { Message } from '../src/types';

type View = 'conversation' | 'board';
const errors = new WeakMap<Page, string[]>();
const setup = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Architect & workers', exact: true }) });
/** The Team button opens No team · Cheap · Balanced · Best; a team on carries `data-on`. */
const trigger = (page: Page) => page.locator('#team-trigger');
async function pickTeam(page: Page, kind: string): Promise<void> {
  await trigger(page).click();
  await page.getByRole('menuitemradio', { name: kind, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: kind, exact: true })).toBeHidden();
}
const panel = (page: Page) => page.getByRole('dialog', { name: 'Workers', exact: true });
// The team's panel opens from the action dock's Agents item.
const openWorkers = (page: Page) => page.locator('#agents-toggle');
const row = (page: Page, id: string) => panel(page).locator(`.architect-worker-row[data-worker-id="${id}"]`);
const live = (page: Page) => panel(page).locator('.architect-worker-live');
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__architectTest.calls.filter((call: any) => call.command === command), command);

const config = (): TeamConfig => ({
  workers: [
    { id: 'builder', name: 'Builder', provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' },
    { id: 'reviewer', name: 'Reviewer', provider: 'claude', model: 'sonnet', reasoningEffort: 'medium' },
  ],
  maxParallel: 2, maxRounds: 4, maxAssignments: 8, workspace: 'shared', summaryLimit: 1800,
});
const worker = (id: string, changes: Partial<TeamWorker> = {}): TeamWorker => ({
  ...config().workers[id === 'build' ? 0 : 1], id, profileId: id === 'build' ? 'builder' : 'reviewer',
  sessionId: `worker-${id}`, status: 'running', assignment: `Complete the ${id} assignment.`,
  summary: '', dependsOn: [], files: [], attempt: 1, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001,
  ...changes,
});
const team = (sessionId: string, changes: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  sessionId, config: config(), status: 'running', round: 1, revision: 1,
  workers: [worker('build'), worker('review')], updatedAt: 1_800_000_000_001, ...changes,
});
const userJson = '{"workers":[{"name":"Keep this user JSON","status":"ready"}]}';
const coordinationHistory = (sessionId: string): Message[] => [
  { id: 601, sessionId, role: 'user', content: userJson, createdAt: 1000 },
  { id: 602, sessionId, role: 'assistant', content: 'I will coordinate the requested work.', createdAt: 2000 },
  { id: 603, sessionId, role: 'coordination', coordinationKind: 'worker_update', content: 'Checking worker updates', createdAt: 3000 },
  { id: 604, sessionId, role: 'assistant', content: 'The worker completed the search implementation.', createdAt: 4000 },
  { id: 605, sessionId, role: 'changes', content: '', createdAt: 4000, turnChanges: { attributed: true, id: 'worker-update-files', files: [{ path: 'src/search.ts', status: 'added', additions: 12, deletions: 0 }], additions: 12, deletions: 0, truncated: false, concurrent: false } },
  { id: 606, sessionId, role: 'coordination', coordinationKind: 'worker_review', content: 'Reviewing worker results', createdAt: 5000 },
  { id: 607, sessionId, role: 'assistant', content: 'The review passed and the task is ready.', createdAt: 6000 },
  { id: 608, sessionId, role: 'changes', content: '', createdAt: 6000, turnChanges: { attributed: true, id: 'worker-review-files', files: [{ path: 'src/search.test.ts', status: 'added', additions: 5, deletions: 0 }], additions: 5, deletions: 0, truncated: false, concurrent: false } },
] as Message[];

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

// Local fixture hooks drive the actual UI event handlers without calling a model.
async function installArchitect(page: Page, snapshots: Record<string, TeamSnapshot> = {}, taskMessages: Record<string, Message[]> = {}): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  // WebKit reports a height change made before paint (a live reply growing) as an error; nothing is lost, the rest arrive next frame.
  page.on('pageerror', error => { if (!error.message.startsWith('ResizeObserver loop')) runtimeErrors.push(error.message); });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      window.__architectTest ??= {
        calls: [], snapshots: ${JSON.stringify(snapshots)}, taskMessages: ${JSON.stringify(taskMessages)}, histories: {}, messages: {}, subagents: {}, hold: {}, release: {}, failures: {},
        publish(snapshot) {
          this.snapshots[snapshot.sessionId] = structuredClone(snapshot);
          emit('architect-event', structuredClone(snapshot));
        },
        event(event) { agent(structuredClone(event)); },
        publishOverlay(target) { emit('overlay-open-task', structuredClone(target)); },
        refresh() { emit('sessions-changed', {}); },
      };
      const fixture = window.__architectTest;
      fixture.calls.push({ command, args: structuredClone(args) });
      if (command === 'turn_change_diff' && fixture.diffs) {
        const diff = fixture.diffs[args.changeId + ':' + args.path];
        if (!diff) throw new Error('No saved diff for this run.');
        return { path: args.path, patch: diff, binary: false, truncated: false };
      }
      if (command === 'get_messages' && fixture.messagesDelay) await new Promise(resolve => setTimeout(resolve, fixture.messagesDelay));
      if (fixture.failures[command]) throw new Error(fixture.failures[command]);
      if (command === 'get_messages' && Object.hasOwn(fixture.taskMessages, args.sessionId)) {
        // With pageSize set, pages work as the app's do: the newest pageSize messages before beforeId.
        const all = fixture.taskMessages[args.sessionId].filter(message => !args.beforeId || message.id < args.beforeId);
        const size = window.__pageSize ?? all.length;
        return { messages: structuredClone(all.slice(-size)), hasOlder: all.length > size };
      }
      if (command === 'architect_get' && Object.hasOwn(fixture.snapshots, args.sessionId)) {
        const value = structuredClone(fixture.snapshots[args.sessionId]);
        if (fixture.hold[args.sessionId]) await new Promise(resolve => { (fixture.release[args.sessionId] ??= []).push(resolve); });
        return value;
      }
      if (command === 'architect_worker_messages' && Object.hasOwn(fixture.histories, args.sessionId + ':' + args.workerId)) {
        const key = args.sessionId + ':' + args.workerId;
        const value = structuredClone(fixture.histories[key]);
        if (value.paginated) {
          const eligible = value.messages.filter(message => !args.beforeId || message.id < args.beforeId);
          value.messages = eligible.slice(-100); value.hasOlder = eligible.length > 100;
        }
        const holdKey = args.beforeId && fixture.hold[key + ':older'] ? key + ':older' : key;
        if (fixture.hold[holdKey]) await new Promise(resolve => { (fixture.release[holdKey] ??= []).push(resolve); });
        return value;
      }
      if (command === 'get_message_content') {
        const message = Object.values(fixture.histories).flatMap(history => history.messages).find(message => message.sessionId === args.sessionId && message.id === args.messageId);
        if (message) return message.content;
      }
      if (command === 'architect_team_messages' && Object.hasOwn(fixture.messages, args.sessionId)) return structuredClone(fixture.messages[args.sessionId]);
      if (command === 'list_subagents' && Object.hasOwn(fixture.subagents, args.sessionId)) return structuredClone(fixture.subagents[args.sessionId]);
    `) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  // The task ID is rendered before its team loads; wait for the final composer
  // so a pending task load cannot replace the popover's anchor during the click.
  await expect(transcript(page).getByText('Loading conversation…', { exact: true })).toBeHidden();
}

async function selectTask(page: Page, id: string, view: View = 'conversation'): Promise<void> {
  await page.locator(view === 'board' ? `[data-action="board-open"][data-id="${id}"]` : `.task-item[data-id="${id}"]`).click();
}

async function publish(page: Page, snapshot: TeamSnapshot): Promise<void> {
  await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), snapshot);
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Team mode is one menu pick: the task's model leads and Panda Router (or the lead) picks worker models. */
async function saveDefaultTeam(page: Page): Promise<void> {
  await pickTeam(page, 'Balanced team');
  await expect(trigger(page)).toHaveAttribute('data-on', '');
  // A cold Vite dev server can take longer than the default 5 s to show the Agents toggle.
  await expect(openWorkers(page)).toBeVisible({ timeout: 15_000 });
}

async function chooseModel(page: Page, button: string, provider: string, model: string): Promise<void> {
  await setup(page).getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness and model', exact: true }).getByRole('button', { name: `${provider} · ${model}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeHidden();
  await expect(setup(page)).toBeVisible();
  await expect(setup(page).getByRole('button', { name: button, exact: true })).toContainText(model);
  // Workers' permissions: full access, approvals granted under the lead; scopes only coordinate edits.
  // Two short lines: scopes once, then access.
  expect(await setup(page).locator('.architect-workspace-line').allTextContents()).toEqual(['Write scopes decide who edits what; overlaps wait.', 'Workers have full access; approvals are automatic (deploy and scheduling go back to the lead).']);
}

async function seedHistory(page: Page, sessionId: string, workerId: string, text = ''): Promise<void> {
  await page.evaluate(({ sessionId, workerId, text }) => {
    (window as any).__architectTest.histories[sessionId + ':' + workerId] = {
      messages: text ? [{ id: 101, sessionId: `worker-${workerId}`, role: 'assistant', content: text, createdAt: 1_800_000_000_001 }] : [], hasOlder: false,
    };
  }, { sessionId, workerId, text });
}

async function workerSurface(element: Locator) {
  return element.evaluate(node => {
    const style = getComputedStyle(node);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
    return { color: style.backgroundColor, alpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
      image: style.backgroundImage, blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') };
  });
}

test.describe('architect teams', () => {
  for (const theme of ['light', 'dark'] as const) for (const view of ['conversation', 'board'] as const) {
    test(`workers are one solid surface and keep detail sharp in ${theme} ${view}`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.addInitScript(theme => {
        localStorage.setItem('pandacode.theme', theme);
        localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: true, visibility: 35, pinned: 'mon-morning' }));
      }, theme);
      await installArchitect(page, { 'session-2': team('session-2') });
      await seedHistory(page, 'session-2', 'build', '**Search is ready.** The index now reuses its cached entries.\n\n```ts\nconst index = cachedIndex;\n```');
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await selectTask(page, 'session-2', view); }
      await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-morning');
      await openWorkers(page).click();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page)).toHaveCSS('opacity', '1'); await expect(panel(page)).toHaveCSS('filter', 'none');
      // The Agents flyout around the panel is the app's glass: translucent over a blur, with no gradient or border.
      const material = await workerSurface(page.locator('#agents-flyout'));
      expect(material.alpha).toBeLessThan(1); expect(material.image).toBe('none');
      expect(material.blur).toContain('blur');
      await expect(panel(page)).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      const normalRow = await row(page, 'build').evaluate(node => getComputedStyle(node).backgroundColor);
      await row(page, 'build').hover();
      await expect(row(page, 'build')).not.toHaveCSS('background-color', normalRow);
      await expect(row(page, 'build').locator('strong')).toBeVisible();
      await page.screenshot({ path: `/private/tmp/pandacode-workers-frost-${browserName}-${theme}-${view}-list.png`, animations: 'disabled' });
      await row(page, 'build').click();
      const detail = panel(page).locator('.architect-worker-message > div').first();
      await expect(detail).toContainText('Search is ready.');
      await expect(detail).toHaveCSS('filter', 'none'); await expect(detail).toHaveCSS('opacity', '1');
      expect(await workerSurface(page.locator('#agents-flyout'))).toEqual(material);
      expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `/private/tmp/pandacode-workers-frost-${browserName}-${theme}-${view}-detail.png`, animations: 'disabled' });
      // Both accessibility preferences must remove translucency even while a detail is open.
      const preferences = browserName === 'chromium' ? ['prefers-contrast', 'prefers-reduced-transparency'] : ['prefers-contrast'];
      const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
      for (const name of preferences) {
        if (cdp) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }] });
        else await page.emulateMedia({ contrast: 'more' });
        await expect(page.locator('.workspace')).not.toHaveAttribute('data-wallpaper');
        await expect(panel(page)).toBeVisible(); await expect(detail).toContainText('Search is ready.');
        const accessible = await workerSurface(page.locator('#agents-flyout'));
        expect(accessible.alpha).toBe(1); expect(accessible.blur).toBe('none'); expect(accessible.image).toBe('none');
        if (cdp) await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        else await page.emulateMedia({ contrast: 'no-preference' });
        await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-morning');
        expect(await workerSurface(page.locator('#agents-flyout'))).toEqual(material);
      }
      await cdp?.detach();
    });
  }

  test('a team held for a usage limit reads as limited, not working, until it is lifted', async ({page}) => {
    const heldUntil = Date.now() + 4 * 3_600_000;
    const held = team('session-2', { status: 'waiting', workers: [worker('build', { status: 'completed' })], error: "The lead's turn failed: limit hit PandaCode tries again, and workers keep running.", leadFailure: { error: 'limit hit', heldUntil } });
    await installArchitect(page, {'session-2':held});
    await page.evaluate(until => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'limited', text: 'Usage limit reached', data: { resetsAt: until } }), heldUntil);
    const taskRow = page.locator('#task-row-session-2');
    await expect(taskRow.locator('.task-indicator.limited')).toBeAttached();
    await expect(taskRow.locator('.task-indicator.running')).toHaveCount(0);
    const banner = page.locator('.limit-banner');
    await expect(banner).toContainText('Usage limit reached');
    await expect(banner.locator('.limit-resume-switch')).toHaveCount(0);
    await expect(page.locator('.stop-button')).toBeVisible();
    await openWorkers(page).click();
    await expect(panel(page).locator('.architect-panel-summary')).toContainText('Usage limit, resumes at');
    await expect(panel(page).locator('.architect-panel-error')).toBeHidden();
    await banner.getByRole('button', { name: 'Continue now' }).click();
    await expect.poll(() => calls(page, 'clear_usage_limit').then(list => list.length)).toBe(1);
    await expect(banner).toHaveCount(0);
    await expect(panel(page).locator('.architect-panel-summary')).toHaveText('Architect is working…');
    const error = panel(page).locator('.architect-panel-error');
    await expect(error).toContainText('tries again');
    await expect(error).toHaveClass(/is-notice/);
    await expect(taskRow.locator('.task-indicator.running')).toBeAttached();
  });

  test('a paused team with a future heldUntil never promises a resume', async ({page}) => {
    const heldUntil = Date.now() + 3_600_000;
    await installArchitect(page, {'session-2':team('session-2', { status: 'paused', workers: [worker('build', { status: 'completed' })], error: 'Team paused.', leadFailure: { error: 'limit hit', heldUntil } })});
    await openWorkers(page).click();
    await expect(panel(page).locator('.architect-panel-summary')).toHaveText('Paused');
  });

  test('a worker still running keeps a held team working', async ({page}) => {
    const heldUntil = Date.now() + 3_600_000;
    await installArchitect(page, {'session-2':team('session-2', { status: 'waiting', workers: [worker('build')], leadFailure: { error: 'limit hit', heldUntil } })});
    await page.evaluate(until => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'limited', text: 'Usage limit reached', data: { resetsAt: until } }), heldUntil);
    await expect(page.locator('#task-row-session-2 .task-indicator.running')).toBeAttached();
    await expect(page.locator('.limit-banner')).toHaveCount(0);
  });

  test('worker messages expose forks and copy original saved or streaming Markdown', async ({page}) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (text:string) => { (window as any).__copiedMessage = text; }}});
    });
    await installArchitect(page, {'session-2':team('session-2')});
    const saved = '**Worker result**\n\n```ts\nconst count = 2;\n```';
    await seedHistory(page,'session-2','build',saved);
    await openWorkers(page).click(); await row(page,'build').click();
    const message = panel(page).locator('.architect-worker-message[data-message-id="101"]');
    await expect(message).toContainText('Worker result');
    await expect(message.getByRole('button',{name:'Fork from here'})).toHaveAttribute('data-message-session','worker-build');
    await message.getByRole('button',{name:'Copy message',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedMessage)).toBe(saved);
    expect((await calls(page,'get_message_content')).at(-1).args).toEqual({sessionId:'worker-build',messageId:101});
    await page.evaluate(() => (window as any).__architectTest.event({sessionId:'worker-build',kind:'text',text:'**Still verifying** the worker result.'}));
    await expect(live(page)).toContainText('Still verifying');
    const actions = panel(page).locator('.architect-live-actions');
    await actions.getByRole('button',{name:'Copy message',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedMessage)).toBe('**Still verifying** the worker result.');
    await expect(actions.getByRole('button',{name:'Fork from here'})).toHaveCount(0);
  });

  test('loads A2A messages on demand and keeps coordination separate from worker transcripts', async ({ page }) => {
    const snapshot = team('session-2');
    await installArchitect(page, { 'session-2': snapshot }); await seedHistory(page, 'session-2', 'build');
    await page.evaluate(() => { (window as any).__architectTest.messages['session-2'] = { messages: [
      { id: 1, sender: 'build', recipient: 'review', message: 'Please check <script>unsafe()</script> in the fixture.', createdAt: 1_800_000_000_001 },
    ], nextCursor: 1, hasMore: false }; });
    await openWorkers(page).click();
    expect(await calls(page, 'architect_team_messages')).toHaveLength(0);
    const messages = panel(page).locator('.team-messages');
    await messages.locator('summary').click();
    await expect(messages).toContainText('Builder → Reviewer');
    await expect(messages).toContainText('<script>unsafe()</script>');
    await expect(messages.locator('script')).toHaveCount(0);
    await page.evaluate(() => { (window as any).__messageNode = document.querySelector('[data-team-message-id="1"]'); });
    await row(page, 'build').click(); await expect(messages).toBeHidden();
    await expect(panel(page).locator('.architect-worker-detail')).not.toContainText('unsafe');
    await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click();
    await expect(messages).toBeVisible();
    expect(await calls(page, 'architect_team_messages')).toHaveLength(1);
    snapshot.revision++;
    await page.evaluate(() => { (window as any).__architectTest.messages['session-2'] = { messages: [
      { id: 2, sender: 'review', recipient: 'architect', message: 'Reviewed the fixture; ready to proceed.', createdAt: 1_800_000_001_000 },
    ], nextCursor: 2, hasMore: false }; });
    await publish(page, snapshot);
    await expect(messages).toContainText('Reviewer → Architect');
    await expect(messages.locator('li')).toHaveCount(2);
    expect((await calls(page, 'architect_team_messages')).at(-1).args.afterId).toBe(1);
    expect(await page.evaluate(() => (window as any).__messageNode === document.querySelector('[data-team-message-id="1"]'))).toBe(true);
  });

  test('shows durable worker checkpoints without replacing the expanded detail while progress changes', async ({ page }) => {
    const snapshot = team('session-2');
    snapshot.workers[0].checkpoint = { summary: 'Implemented the search index.', nextSteps: 'Verify keyboard navigation.', blocker: null, updatedAt: 1_800_000_000_001 };
    await installArchitect(page, { 'session-2': snapshot });
    await seedHistory(page, 'session-2', 'build'); await seedHistory(page, 'session-2', 'review');
    await openWorkers(page).click(); await row(page, 'build').click();
    const checkpoint = panel(page).locator('.architect-worker-checkpoint');
    await expect(checkpoint).toBeVisible(); await checkpoint.locator('summary').click();
    await expect(checkpoint).toContainText('Implemented the search index.');
    await expect(checkpoint).toContainText('Verify keyboard navigation.');
    await page.evaluate(() => { (window as any).__checkpointNode = document.querySelector('.architect-worker-checkpoint'); });
    snapshot.revision++; snapshot.workers[0].checkpoint = { summary: 'Keyboard navigation verified.', nextSteps: 'Complete the review.', blocker: 'Waiting for an API key.', updatedAt: 1_800_000_001_000 };
    await publish(page, snapshot);
    await expect(checkpoint).toContainText('Keyboard navigation verified.');
    await expect(checkpoint).toContainText('Waiting for an API key.');
    await expect(checkpoint).toHaveAttribute('open', '');
    expect(await page.evaluate(() => (window as any).__checkpointNode === document.querySelector('.architect-worker-checkpoint'))).toBe(true);
    await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click(); await row(page, 'review').click();
    await expect(checkpoint).toBeHidden();
  });

  test('a parked worker only waits on sub-workers while its team runs', async ({ page }) => {
    const snapshot = team('session-2', { workers: [worker('build', { status: 'parked' }), worker('review', { status: 'running', parentWorker: 'build' })] });
    await installArchitect(page, { 'session-2': snapshot });
    await seedHistory(page, 'session-2', 'build');
    await openWorkers(page).click();
    await expect(row(page, 'build')).toContainText('Waiting on sub-workers');
    for (const status of ['failed', 'paused'] as const) {
      snapshot.revision++; snapshot.status = status; snapshot.workers[1].status = 'failed';
      await publish(page, snapshot);
      await expect(row(page, 'build')).toContainText('Paused');
      await expect(row(page, 'build')).not.toContainText('Waiting on sub-workers');
      await expect(row(page, 'build').locator('.architect-worker-glyph')).toHaveAttribute('data-glyph', 'idle');
      await expect(panel(page).getByRole('button', { name: 'Resume team', exact: true })).toBeVisible();
    }
    await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-meta')).toContainText('Paused');
    await expect(panel(page).locator('.architect-worker-meta')).not.toContainText('Waiting on sub-workers');
  });

  test('explains queued workers and updates the expanded detail without remounting', async ({ page, browserName }) => {
    const snapshot = team('session-2', {
      workers: [worker('build', { files: ['src'] }), worker('review', { status: 'queued', dependsOn: ['build'], files: ['src/review.ts'] })],
    });
    await installArchitect(page, { 'session-2': snapshot });
    await seedHistory(page, 'session-2', 'review');
    await openWorkers(page).click();
    await expect(row(page, 'review')).toContainText('Waiting for a dependency');
    await row(page, 'review').click();
    const detail = panel(page).locator('.architect-worker-detail');
    const reason = detail.locator('.architect-worker-queue');
    await expect(reason).toHaveText('Waiting for a dependency');
    await detail.locator('.architect-assignment summary').click();
    await page.evaluate(() => {
      (window as any).__queueDetail = document.querySelector('.architect-worker-detail');
      (window as any).__queueAssignment = document.querySelector('.architect-assignment');
    });
    snapshot.revision++; snapshot.config.maxParallel = 1; snapshot.workers[1].dependsOn = [];
    await publish(page, snapshot);
    await expect(reason).toHaveText('Waiting for an available worker slot');
    await expect(detail.locator('.architect-assignment')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => (window as any).__queueDetail === document.querySelector('.architect-worker-detail')
      && (window as any).__queueAssignment === document.querySelector('.architect-assignment'))).toBe(true);
    await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click();
    await expect(row(page, 'review')).toContainText('Waiting for an available worker slot');
    snapshot.revision++; snapshot.config.maxParallel = 0;
    await publish(page, snapshot);
    await expect(row(page, 'review')).toContainText('Waiting for Builder to finish editing shared files');
    await row(page, 'review').click();
    await expect(reason).toHaveText('Waiting for Builder to finish editing shared files');
    await expect(reason).toHaveCSS('white-space', 'nowrap');
    await page.screenshot({ path: `/private/tmp/pandacode-worker-queue-${browserName}.png`, animations: 'disabled' });
    snapshot.revision++; snapshot.workers[1].status = 'running'; snapshot.workers[1].readOnly = true;
    await publish(page, snapshot);
    await expect(reason).toBeHidden();
    await expect(detail.locator('.architect-worker-meta')).toContainText('Read only');
    await expect(detail.locator('.architect-worker-meta')).toContainText('Working');
  });

  test('starts a configured team once and pauses, resumes and stops its hidden workers', async ({ page }) => {
    await page.clock.install();
    await installArchitect(page);
    await saveDefaultTeam(page);
    const visibleTasks = await page.locator('.task-item').count();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.locator('#prompt').fill('Build the feature and independently review it.');
    await page.locator('#prompt').press('Enter');
    await expect.poll(() => calls(page, 'architect_start')).toHaveLength(1);
    expect(await calls(page, 'send_message')).toHaveLength(0);
    await openWorkers(page).click();
    await page.clock.runFor(250);
    await expect(panel(page).locator('.architect-worker-row')).toHaveCount(2);
    await expect(panel(page).locator('.architect-panel-count')).toHaveText('2 workers');
    await expect(page.locator('.task-item')).toHaveCount(visibleTasks);
    await expect(panel(page).getByRole('button', { name: 'Pause team', exact: true })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Pause team', exact: true }).click();
    await expect(panel(page).locator('.architect-panel-summary')).toContainText('Paused');
    await expect(panel(page).getByRole('button', { name: 'Resume team', exact: true })).toBeVisible();
    await page.clock.runFor(5000);
    await expect(panel(page).locator('.architect-panel-summary')).toContainText('Paused');
    await panel(page).getByRole('button', { name: 'Resume team', exact: true }).click();
    await expect(panel(page).locator('.architect-panel-summary')).toHaveText('Architect is working…');
    await page.clock.runFor(250);
    await panel(page).getByRole('button', { name: 'Stop team', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Pause team', exact: true })).toBeHidden();
    await expect(panel(page).locator('.architect-panel-summary')).toContainText('Paused');
    await expect(panel(page).locator('.architect-panel-error')).toContainText('Team stopped');
    await expect(panel(page).locator('.architect-worker-row[data-status="stopped"]')).toHaveCount(2);
    await expect(page.locator('#prompt')).toBeEnabled();
    expect((await calls(page, 'architect_control')).map((call: any) => call.args)).toEqual([
      { sessionId: 'session-2', action: 'pause' }, { sessionId: 'session-2', action: 'resume' }, { sessionId: 'session-2', action: 'stop' },
    ]);
    await panel(page).getByRole('button', { name: 'Resume team', exact: true }).click();
    await page.clock.runFor(8000);
    await expect(panel(page).locator('.architect-panel-summary')).toContainText('Ready for review');
    await expect(panel(page).locator('.architect-worker-row[data-status="completed"]')).toHaveCount(2);
    await expect(transcript(page)).toContainText('Sample architect review');
    await expect(page.locator('#prompt')).toBeEnabled();
    await panel(page).getByRole('button', { name: 'Close workers', exact: true }).click();
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await expect(page.locator('[data-action="board-open"]')).toHaveCount(visibleTasks);
  });

  test('turns on an automatic team led by the selected model and explains it in a tooltip', async ({ page }) => {
    await installArchitect(page);
    const picker = page.getByRole('button', { name: /^Model: / });
    const lead = (await picker.textContent())!;
    await trigger(page).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('Team: off.');
    await expect(tip).toContainText('Your model leads');
    await expect(tip).toContainText('Name workers in your prompt');
    await expect(trigger(page)).toHaveAttribute('aria-description', /^Team: off\. Your model leads/);
    await saveDefaultTeam(page);
    await expect(setup(page)).toHaveCount(0);
    const args = (await calls(page, 'architect_configure')).at(-1).args;
    expect(args).toMatchObject({ sessionId: 'session-2', architect: null, profileId: null, config: { auto: true, workspace: 'shared' } });
    // The roster lists installed models the lead may choose from; it is never hand-built.
    expect(args.config.workers.length).toBeGreaterThan(0);
    expect(new Set(args.config.workers.map((worker: any) => worker.id)).size).toBe(args.config.workers.length);
    await expect(page.locator('[data-team-model-label]')).toBeHidden();
    await expect(picker).toHaveText(lead);
    await expect(page.locator('#toast')).toBeHidden();
    // The model picker keeps choosing the lead's own model, not a team setup.
    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeVisible();
    await expect(setup(page)).toHaveCount(0);
  });

  test('turns the team off again and returns the task to its single agent', async ({ page }) => {
    await installArchitect(page);
    await saveDefaultTeam(page);
    await pickTeam(page, 'No team');
    await expect(openWorkers(page)).toBeHidden();
    await expect(trigger(page)).not.toHaveAttribute('data-on');
    await expect(page.locator('[data-team-model-label]')).toBeHidden();
    expect((await calls(page, 'architect_configure')).at(-1).args).toMatchObject({ sessionId: 'session-2', config: null, profileId: null });
    await page.reload(); await selectTask(page, 'session-2');
    await expect(openWorkers(page)).toBeHidden();
    await expect(page.locator('#prompt')).toBeEnabled();
  });


  test('keeps autonomous goals separate from a configured architect team', async ({ page }) => {
    await installArchitect(page); await saveDefaultTeam(page);
    await page.locator('#prompt').fill('/goal '); await page.locator('#prompt').press('Enter');
    const goal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Goal', exact: true }) });
    await expect(goal).toBeVisible();
    await goal.getByRole('textbox', { name: 'Goal objective', exact: true }).fill('This goal must use a separate task.');
    await goal.getByRole('button', { name: 'Start goal', exact: true }).click();
    await expect(goal).toContainText('Goals and architect teams need separate tasks.');
    expect((await calls(page, 'task_goal')).map((call: any) => call.args.request.action)).toEqual(['get', 'set']);
    expect(await calls(page, 'architect_start')).toHaveLength(0);
    expect(await calls(page, 'send_message')).toHaveLength(0);
  });

  test('keeps a live architect turn in order around the worker lines it spawned', async ({ page }) => {
    const done = [worker('build', { status: 'completed' }), worker('review', { status: 'completed' })];
    await installArchitect(page, { 'session-2': team('session-2', { workers: [] }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build search and review it.', createdAt: 2000 },
    ] as Message[] });
    const tool = (id: string, name: string) => page.evaluate(tool => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'tool', text: '', tool }),
      { id, name, status: 'completed', input: '', output: 'Done.' });
    await tool('read-plan', 'Read');
    await tool('dispatch', 'mcp__pandacode_architect__pandacode_dispatch_workers');
    await publish(page, team('session-2', { status: 'completed', workers: done }));
    await tool('verify', 'Bash');
    const order = () => transcript(page).evaluate(root => {
      const all = [...root.querySelectorAll('[data-tool-key], .team-progress-worker')];
      const index = (selector: string) => all.indexOf(root.querySelector(selector)!);
      return ['[data-tool-key="tool:read-plan"]', '[data-tool-key="tool:dispatch"]', '.team-progress-worker[data-worker-id="build"]', '.team-progress-worker[data-worker-id="review"]', '[data-tool-key="tool:verify"]'].map(index);
    });
    await transcript(page).locator('.team-progress-toggle').click();
    await expect(transcript(page).locator('.team-progress-worker[data-worker-id="review"]')).toBeVisible();
    await expect(transcript(page).locator('[data-tool-key="tool:verify"]')).toBeAttached();
    // In order and all present; the sample thread's rows may still sit above them for a moment.
    await expect.poll(async () => {
      const rows = await order();
      return rows[0] >= 0 && rows.every((row, index) => row === rows[0] + index);
    }).toBe(true);
  });

  test('keeps earlier workers above a resumed coordination turn', async ({ page }) => {
    const earlier = [worker('build', { status: 'completed', createdAt: 2500 }), worker('review', { status: 'completed', createdAt: 2500 })];
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: earlier }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build search and review it.', createdAt: 2000 },
      { id: 302, sessionId: 'session-2', role: 'assistant', content: 'Delegated to the workers.', createdAt: 3000 },
    ] as Message[] });
    await expect(transcript(page).locator('.team-progress-worker[data-worker-id="build"]')).toBeAttached();
    // Workers settled; PandaCode resumes the architect before the coordination message loads.
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'tool', text: '', tool: { id: 'review-diff', name: 'Bash', status: 'running', input: 'git diff', output: '' } }));
    const later = transcript(page).locator('[data-tool-key="tool:review-diff"]');
    await expect(later).toBeAttached();
    expect(await transcript(page).locator('.team-progress-worker[data-worker-id="review"]').evaluate((row, tool) => Boolean(row.compareDocumentPosition(tool!) & Node.DOCUMENT_POSITION_FOLLOWING), await later.elementHandle())).toBe(true);
  });

  const wakeThread = (): Message[] => [
    { id: 301, sessionId: 'session-2', role: 'user', content: 'Build search and review it.', createdAt: 2000, turnDurationMs: 5000 },
    { id: 300, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, id: 'spawn', name: 'Read', status: 'completed', input: 'README.md', output: 'Notes' }), createdAt: 2500 },
    { id: 302, sessionId: 'session-2', role: 'assistant', content: 'Delegated to the workers.', createdAt: 3000 },
    { id: 303, sessionId: 'session-2', role: 'changes', content: '', createdAt: 3100, turnChanges: { attributed: true, id: 'first-files', files: [{ path: 'src/a.ts', status: 'added', additions: 1, deletions: 0 }], additions: 1, deletions: 0, truncated: false, concurrent: false } },
  ] as Message[];
  const wakeMessage = { id: 304, sessionId: 'session-2', role: 'coordination', coordinationKind: 'worker_review', content: 'Reviewing worker results', createdAt: 900000 };
  const wakeTool = { id: 'review-diff', name: 'Bash', status: 'running', input: 'git diff', output: '' };

  test('a lead wake stays one card while it streams and after it ends', async ({ page }) => {
    const workers = [worker('build', { status: 'completed', createdAt: 2500 })];
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers }) }, { 'session-2': wakeThread() });
    const cards = transcript(page).locator('.turn-card'), card = cards.first();
    await expect(card.locator('> .turn-card-reply')).toContainText('Delegated to the workers.');
    await expect(cards).toHaveCount(1);
    const key = await card.getAttribute('data-turn-card');
    // The reader's open trace is theirs: it comes back open once the wake hands the card back.
    await card.locator('> details.turn-activity > summary').click();
    await page.evaluate(([wake, tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(wake);
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool });
    }, [wakeMessage, wakeTool] as const);

    const live = transcript(page).locator('.turn-card.is-live');
    await expect(live.locator('.live-earlier .coordination-status[aria-label="Team status"]')).toBeAttached();
    await expect(cards).toHaveCount(1);
    await expect(transcript(page).locator('.user-message')).toHaveCount(1);
    await expect(live.locator('details.turn-activity')).toHaveAttribute('open', '');
    await expect(live.locator('.live-earlier')).toContainText('Delegated to the workers.');
    await expect(live.locator('.turn-card-foot')).toContainText('1 changed file');
    await expect(transcript(page).locator('.team-progress-slot')).toHaveCount(1);
    await expect(live.locator('.team-progress-worker[data-worker-id="build"]')).toBeAttached();
    // The earlier rows come first, outside the host paintLiveActivity manages; the time carries on from their total.
    expect(await live.locator('.turn-activity-body').evaluate(body => [...body.children].map(child => child.className).slice(0, 2))).toEqual(['live-earlier', 'live-tools']);
    await expect(live.locator('.live-tools [data-tool-key="tool:review-diff"]')).toBeAttached();
    await expect(live.locator('.turn-activity-label')).toContainText('Ran');
    await expect(live.locator('.turn-card-time')).toHaveText(/^[5-9]s$/);
    // Until the wake's first text the reply holds its skeleton, and the earlier text is still in the trace.
    await expect(live.locator('.turn-card-reply .live-message')).toBeHidden();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'text', text: 'The review passed.' }));
    await expect(live.locator('.turn-card-reply .live-message')).toContainText('The review passed.');
    await expect(cards).toHaveCount(1);
    await expect(live.locator('.live-earlier')).toContainText('Delegated to the workers.');

    await page.evaluate(([tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(
        { id: 305, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool, status: 'completed' }), createdAt: 900500 },
        { id: 306, sessionId: 'session-2', role: 'assistant', content: 'The review passed.', createdAt: 902000 },
      );
      // Native saves a wake's exact time on its coordination message when the run ends.
      fixture.taskMessages['session-2'].find((message: Message) => message.id === 304).turnDurationMs = 2000;
      fixture.event({ sessionId: 'session-2', kind: 'done', text: '' });
    }, [wakeTool] as const);
    const saved = transcript(page).locator('.turn-card:not(.is-live)');
    await expect(saved).toHaveCount(1);
    await expect(cards).toHaveCount(1);
    await expect(saved).toHaveAttribute('data-turn-card', key!);
    await expect(saved.locator('> .turn-card-reply')).toContainText('The review passed.');
    await expect(saved.locator('> details.turn-activity')).toHaveAttribute('open', '');
    await expect(saved.locator('> details.turn-activity > .turn-activity-body')).toContainText('Delegated to the workers.');
    await expect(saved.locator('.coordination-status')).toHaveCount(1);
    await expect(saved.locator('.turn-card-foot')).toContainText('1 changed file');
    // The work's total, without the 15 minutes spent waiting on workers.
    await expect(saved.locator('.turn-card-time')).toHaveText('7s');
    await expect(transcript(page).locator('.team-progress-slot')).toHaveCount(1);
    await expect(saved.locator('.team-progress-worker[data-worker-id="build"]')).toBeAttached();
  });

  test('a wake hands its live card to the saved one without moving its top, trace folded', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    const finished = { ...wakeTool, status: 'completed', output: 'clean' };
    await page.evaluate(([wake, tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(wake);
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool });
    }, [wakeMessage, finished] as const);
    const live = transcript(page).locator('.turn-card.is-live');
    await expect(live.locator('.live-earlier')).toBeAttached();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'text', text: 'The review passed.' }));
    await expect(live.locator('details.turn-activity')).toHaveAttribute('data-folded', '');
    await expect(live.locator('details.turn-activity')).not.toHaveAttribute('open', '');
    const samples = await page.evaluate(async ([tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(
        { id: 305, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool }), createdAt: 900500 },
        { id: 306, sessionId: 'session-2', role: 'assistant', content: 'The review passed.', createdAt: 902000 },
      );
      const top = () => document.querySelector('#transcript .turn-card')!.getBoundingClientRect().top;
      const seen = [top()];
      fixture.event({ sessionId: 'session-2', kind: 'done', text: '' });
      const until = performance.now() + 700;
      while (performance.now() < until) { await new Promise(requestAnimationFrame); seen.push(top()); }
      return { seen, live: Boolean(document.querySelector('.turn-card.is-live')), cards: document.querySelectorAll('#transcript .turn-card').length };
    }, [finished] as const);
    expect(samples.live).toBe(false);
    expect(samples.cards).toBe(1);
    expect(Math.max(...samples.seen) - Math.min(...samples.seen)).toBeLessThan(2);
    await expect(transcript(page).locator('.turn-card > details.turn-activity')).not.toHaveAttribute('open', '');
  });

  const toolMessage = (id: number, createdAt: number): Message => ({ id, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, id: `step-${id}`, name: 'Read', status: 'completed', input: `src/file-${id}.ts`, output: 'ok' }), createdAt } as Message);
  const startWake = (page: Page) => page.evaluate(([wake, tool]) => {
    const fixture = (window as any).__architectTest;
    fixture.taskMessages['session-2'].push(wake);
    fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool });
  }, [wakeMessage, wakeTool] as const);

  test('a long exchange does not make the card grow at wake start: its rows wait in one closed fold', async ({ page }) => {
    const steps = Array.from({ length: 24 }, (_, index) => toolMessage(1000 + index, 2100 + index));
    const [user, , reply, changes] = wakeThread();
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': [{ ...user, id: 301 }, ...steps, { ...reply, id: 1100 }, { ...changes, id: 1101 }] as Message[] });
    const card = transcript(page).locator('.turn-card').first();
    await expect(card.locator('> .turn-card-reply')).toContainText('Delegated to the workers.');
    const summary = await card.locator('> details.turn-activity .trace-summary-text').textContent();
    const before = await card.evaluate(node => node.getBoundingClientRect().height);
    await startWake(page);
    const live = transcript(page).locator('.turn-card.is-live'), fold = live.locator('details.live-earlier');
    await expect(fold).toBeAttached();
    await expect(transcript(page).locator('.turn-card')).toHaveCount(1);
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(fold.locator('> summary')).toHaveText(summary!);
    const row = fold.locator('[data-tool-key="tool:step-1000"]');
    await expect(row).toBeHidden();
    await expect(fold.getByText('Delegated to the workers.')).toBeHidden();
    await expect(fold.locator('.coordination-status')).toBeHidden();
    const size = await live.evaluate(node => ({
      card: node.getBoundingClientRect().height,
      head: node.querySelector('.turn-activity-summary')!.getBoundingClientRect().height,
      skeleton: node.querySelector('.turn-card-reply')!.getBoundingClientRect().height,
    }));
    expect(size.card - before).toBeLessThanOrEqual(size.head + size.skeleton);
    // Measured: the saved card plus about one line; a flat 24-step trace would add well over 500 px.
    expect(size.card - before).toBeLessThan(120);
    // The earlier reply is one click away and the fold stays as the reader left it across the run.
    await fold.locator('> summary').click();
    await expect(fold.getByText('Delegated to the workers.')).toBeVisible();
    await expect(fold.locator('.coordination-status')).toBeVisible();
    await fold.locator('> summary').click();
    await expect(fold.getByText('Delegated to the workers.')).toBeHidden();
    // The reader has left the trace and the step finished, so the reply folds it as usual.
    await page.evaluate(([tool]) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const fixture = (window as any).__architectTest;
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool: { ...tool, status: 'completed', output: 'clean' } });
      fixture.event({ sessionId: 'session-2', kind: 'text', text: 'The review passed.' });
    }, [wakeTool] as const);
    await expect(live.locator('details.turn-activity')).not.toHaveAttribute('open', '');
    const handoff = await page.evaluate(async ([tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(
        { id: 2000, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool, status: 'completed' }), createdAt: 900500 },
        { id: 2001, sessionId: 'session-2', role: 'assistant', content: 'The review passed.', createdAt: 902000 },
      );
      const top = () => document.querySelector('#transcript .turn-card')!.getBoundingClientRect().top;
      const seen = [top()];
      fixture.event({ sessionId: 'session-2', kind: 'done', text: '' });
      const until = performance.now() + 700;
      while (performance.now() < until) { await new Promise(requestAnimationFrame); seen.push(top()); }
      return { seen, live: document.querySelectorAll('.turn-card.is-live').length, cards: document.querySelectorAll('#transcript .turn-card').length };
    }, [wakeTool] as const);
    expect(handoff.live).toBe(0);
    expect(handoff.cards).toBe(1);
    expect(Math.max(...handoff.seen) - Math.min(...handoff.seen)).toBeLessThan(2);
    await expect(transcript(page).locator('.turn-card > details.turn-activity')).not.toHaveAttribute('open', '');
  });

  test('a fold the reader opens during a wake leaves the saved trace open at the end', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    await startWake(page);
    const fold = transcript(page).locator('.turn-card.is-live details.live-earlier');
    await fold.locator('> summary').click();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'done', text: '' }));
    await expect(transcript(page).locator('.turn-card.is-live')).toHaveCount(0);
    await expect(transcript(page).locator('.turn-card > details.turn-activity')).toHaveAttribute('open', '');
  });

  // Every frame from the run's first event, so a single frame with two cards fails.
  const sampleCards = (page: Page, ms: number) => page.evaluate(async ms => {
    const counts: number[] = [], until = performance.now() + ms;
    const placeholder = () => document.querySelector<HTMLTextAreaElement>('#prompt')?.placeholder ?? '';
    const before = placeholder();
    let composerMoved = false, heldFrames = 0;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const shown = document.querySelectorAll('#transcript .turn-card').length;
      counts.push(shown);
      if (!document.querySelector('.turn-card.is-live')) { heldFrames++; if (placeholder() !== before) composerMoved = true; }
    }
    return { counts, composerMoved, heldFrames };
  }, ms);

  test('a slow page load never shows the saved card beside the live one, and the composer does not wait', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    await page.evaluate(() => { (window as any).__architectTest.messagesDelay = 180; });
    const [frames] = await Promise.all([sampleCards(page, 600), startWake(page)]);
    expect(frames.counts.length).toBeGreaterThan(5);
    expect(Math.max(...frames.counts)).toBe(1);
    expect(Math.min(...frames.counts)).toBe(1);
    expect(frames.heldFrames, 'the saved card stayed while the page loaded').toBeGreaterThan(0);
    expect(frames.composerMoved, 'the composer shows the run while the card waits').toBe(true);
    await expect(transcript(page).locator('.turn-card.is-live details.live-earlier')).toBeAttached();
  });

  test('a load slower than the hold still shows the live card, then joins up', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    await page.evaluate(() => { (window as any).__architectTest.messagesDelay = 2500; });
    await startWake(page);
    const live = transcript(page).locator('.turn-card.is-live');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'text', text: 'Still reaches the reader.' }));
    await expect(live.locator('.live-message')).toContainText('Still reaches the reader.', { timeout: 1500 });
    await expect(live.locator('details.live-earlier')).toBeAttached({ timeout: 5000 });
    await expect(transcript(page).locator('.turn-card')).toHaveCount(1);
    await expect(live.locator('.live-message')).toContainText('Still reaches the reader.');
  });

  test('a failed page load still shows the live card', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    await page.evaluate(() => { (window as any).__architectTest.failures.get_messages = 'disk busy'; });
    await startWake(page);
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'text', text: 'Still reaches the reader.' }));
    await expect(transcript(page).locator('.turn-card.is-live .live-message')).toContainText('Still reaches the reader.', { timeout: 1500 });
  });

  test('a run that is not a wake paints its live card right after the page returns', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply')).toContainText('Delegated to the workers.');
    await page.evaluate(() => { (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'text', text: 'A scheduled run.' }); });
    await expect(transcript(page).locator('.turn-card.is-live .live-message')).toContainText('A scheduled run.', { timeout: 1000 });
    await expect(transcript(page).locator('.turn-card:not(.is-live) > .turn-card-reply')).toContainText('Delegated to the workers.');
  });

  // A wake's first event reloads the newest page. With older history loaded, that must neither drop it nor ask for
  // more: not for a wake (its coordination message is on the newest page), nor for a run that already saved more than a page.
  for (const saved of [0, 105]) test(`a wake keeps the older history the reader loaded and asks for no older page (${saved} saved steps)`, async ({ page }) => {
    const older = Array.from({ length: 120 }, (_, index) => ({ id: 10 + index, sessionId: 'session-2', role: index % 2 ? 'assistant' : 'user', content: `Older message ${index + 1}`, createdAt: 1000 + index })) as Message[];
    const recent = wakeThread().map(message => ({ ...message, id: message.id + 200, createdAt: message.createdAt + 2000 }));
    await page.addInitScript(() => { (window as any).__pageSize = 100; });
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': [...older, ...recent] });
    await expect(transcript(page).locator('.turn-card > .turn-card-reply').last()).toContainText('Delegated to the workers.');
    await expect(transcript(page).getByText('Older message 1', { exact: true })).toHaveCount(0);
    await transcript(page).evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await expect(transcript(page).getByText('Older message 1', { exact: true })).toBeAttached();
    const olderCalls = () => page.evaluate(() => (window as any).__architectTest.calls.filter((call: any) => call.command === 'get_messages' && call.args.beforeId).length);
    const before = await olderCalls();
    await page.evaluate(([wake, tool, saved]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(wake, ...Array.from({ length: saved }, (_, index) => ({ id: 1000 + index, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, id: `saved-${index}`, name: 'Read', status: 'completed', input: `src/${index}.ts`, output: 'ok' }), createdAt: 900001 + index })));
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool });
    }, [wakeMessage, wakeTool, saved] as const);
    await expect(transcript(page).locator('.turn-card.is-live')).toBeAttached();
    if (!saved) {
      await expect(transcript(page).locator('.turn-card.is-live details.live-earlier')).toBeAttached();
      await expect(transcript(page).locator('.turn-card')).toHaveCount(older.length / 2 + 1);
    }
    // Past the hold, whatever the load did is done.
    await page.waitForTimeout(500);
    await expect(transcript(page).getByText('Older message 1', { exact: true })).toBeAttached();
    await expect(transcript(page).getByText('Older message 120', { exact: true })).toBeAttached();
    expect(await olderCalls()).toBe(before);
  });

  const runChanges = (id: string, files: [string, 'added' | 'modified' | 'deleted', number, number][], extra = {}) => ({ attributed: true, id, files: files.map(([path, status, additions, deletions]) => ({ path, status, additions, deletions })), additions: files.reduce((sum, file) => sum + file[2], 0), deletions: files.reduce((sum, file) => sum + file[3], 0), truncated: false, concurrent: false, ...extra });
  const twoRuns = (): Message[] => [
    { id: 701, sessionId: 'session-2', role: 'user', content: 'Build search and review it.', createdAt: 1000, turnDurationMs: 3000 },
    { id: 702, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, id: 'run-a', name: 'Read', status: 'completed', input: 'README.md', output: 'ok' }), createdAt: 1500 },
    { id: 703, sessionId: 'session-2', role: 'assistant', content: 'Delegated to the workers.', createdAt: 2000 },
    { id: 704, sessionId: 'session-2', role: 'changes', content: '', createdAt: 2100, turnChanges: runChanges('run-a', [['src/a.ts', 'modified', 3, 1], ['src/b.ts', 'added', 5, 0]]) },
    { id: 705, sessionId: 'session-2', role: 'coordination', coordinationKind: 'worker_update', content: 'Checking worker updates', createdAt: 5000, turnDurationMs: 1000 },
    { id: 706, sessionId: 'session-2', role: 'assistant', content: 'Merged the worker change.', createdAt: 5500 },
    { id: 707, sessionId: 'session-2', role: 'changes', content: '', createdAt: 5600, turnChanges: runChanges('run-b', [['src/a.ts', 'modified', 2, 2]], { truncated: true }) },
  ] as Message[];
  const diffPatch = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`;

  test('a merged card has one changes footer for every run, and its viewer lists a file changed twice once', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': twoRuns() });
    await page.evaluate(([a, b, c]) => { (window as any).__architectTest.diffs = { 'run-a:src/a.ts': a, 'run-a:src/b.ts': b, 'run-b:src/a.ts': c }; }, [diffPatch('src/a.ts', 'first run'), diffPatch('src/b.ts', 'added'), diffPatch('src/a.ts', 'second run')]);
    const card = transcript(page).locator('.turn-card');
    await expect(card).toHaveCount(1);
    const foot = card.locator('.turn-card-foot');
    await expect(foot).toHaveCount(1);
    await expect(foot.locator('strong')).toHaveText('2 changed files');
    await expect(foot.locator('.turn-card-foot-runs')).toHaveText('across 2 runs');
    await expect(foot.locator('.change-additions')).toHaveText('+10');
    await expect(foot.locator('.change-deletions')).toHaveText('−3');
    await expect(foot.locator('.turn-changes-run')).toHaveCount(1);
    // The truncated run and the summed counts are said, not hidden.
    await expect(foot.locator('.turn-change-notice')).toContainText('Change tracking is limited');
    await expect(foot.locator('.turn-change-notice')).toContainText('added up across runs');
    await foot.locator('.turn-card-foot-open').click();
    const dialog = page.locator('dialog.change-review-dialog');
    const files = dialog.locator('.change-review-files button');
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toHaveAttribute('data-path', 'src/a.ts');
    await expect(files.nth(0)).toContainText('2 runs, summed');
    await expect(files.nth(0).locator('.change-additions')).toHaveText('+5');
    await expect(dialog.locator('.change-review-summary')).toContainText('Across 2 runs');
    const tabs = dialog.locator('.change-review-runs button');
    await expect(tabs).toHaveText(['Run 1 of 2', 'Run 2 of 2']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('.change-review-viewer')).toContainText('first run');
    await tabs.nth(1).click();
    await expect(dialog.locator('.change-review-viewer')).toContainText('second run');
    // A file one run changed has that run alone, and its diff comes from that run's snapshot.
    await files.nth(1).click();
    await expect(tabs).toHaveText(['Run 1 of 2']);
    await expect(dialog.locator('.change-review-viewer')).toContainText('added');
    const asked = await page.evaluate(() => (window as any).__architectTest.calls.filter((call: any) => call.command === 'turn_change_diff').map((call: any) => `${call.args.changeId}:${call.args.path}`));
    expect(asked).toEqual(['run-a:src/a.ts', 'run-b:src/a.ts', 'run-a:src/b.ts']);
  });

  test('a live wake shows the earlier runs as one footer, and the handoff keeps one footer without moving the card', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': twoRuns() });
    await expect(transcript(page).locator('.turn-card-foot')).toHaveCount(1);
    await startWake(page);
    const live = transcript(page).locator('.turn-card.is-live');
    await expect(live.locator('details.live-earlier')).toBeAttached();
    await expect(transcript(page).locator('.turn-card-foot')).toHaveCount(1);
    await expect(live.locator('.turn-card-foot strong')).toHaveText('2 changed files');
    await expect(live.locator('.turn-card-foot .turn-card-foot-runs')).toHaveText('across 2 runs');
    await page.evaluate(([tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool: { ...tool, status: 'completed', output: 'clean' } });
      fixture.event({ sessionId: 'session-2', kind: 'text', text: 'The review passed.' });
    }, [wakeTool] as const);
    await expect(live.locator('details.turn-activity')).not.toHaveAttribute('open', '');
    const handoff = await page.evaluate(async ([tool, changes]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(
        { id: 2000, sessionId: 'session-2', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool, status: 'completed' }), createdAt: 900500 },
        { id: 2001, sessionId: 'session-2', role: 'assistant', content: 'The review passed.', createdAt: 902000 },
        { id: 2002, sessionId: 'session-2', role: 'changes', content: '', createdAt: 902100, turnChanges: changes },
      );
      const read = () => ({ top: document.querySelector('#transcript .turn-card')!.getBoundingClientRect().top, feet: document.querySelectorAll('#transcript .turn-card-foot').length });
      const seen = [read()];
      fixture.event({ sessionId: 'session-2', kind: 'done', text: '' });
      const until = performance.now() + 700;
      while (performance.now() < until) { await new Promise(requestAnimationFrame); seen.push(read()); }
      return { seen, live: document.querySelectorAll('.turn-card.is-live').length };
    }, [wakeTool, runChanges('run-c', [['src/c.ts', 'added', 4, 0]])] as const);
    expect(handoff.live).toBe(0);
    expect(Math.max(...handoff.seen.map(frame => frame.feet))).toBe(1);
    expect(Math.min(...handoff.seen.map(frame => frame.feet))).toBe(1);
    const tops = handoff.seen.map(frame => frame.top);
    expect(Math.max(...tops) - Math.min(...tops), `card top per frame: ${tops.map(Math.round).join(',')}`).toBeLessThan(2);
    const foot = transcript(page).locator('.turn-card-foot');
    await expect(foot.locator('strong')).toHaveText('3 changed files');
    await expect(foot.locator('.turn-card-foot-runs')).toHaveText('across 3 runs');
    await expect(foot.locator('.change-additions')).toHaveText('+14');
  });

  test('a thread tile shows a live wake as one card', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [] }) }, { 'session-2': wakeThread() });
    await page.locator('.task-item[data-id="session-1"]').click({ modifiers: ['Meta'] });
    const tile = page.locator('.thread-tile[data-tile="session-2"] .thread-mirror');
    await expect(tile.locator('.turn-card')).toHaveCount(1);
    await page.evaluate(([wake, tool]) => {
      const fixture = (window as any).__architectTest;
      fixture.taskMessages['session-2'].push(wake);
      fixture.event({ sessionId: 'session-2', kind: 'tool', text: '', tool });
    }, [wakeMessage, wakeTool] as const);
    await expect(tile.locator('.turn-card.is-live .live-earlier .coordination-status')).toBeAttached();
    await expect(tile.locator('.turn-card')).toHaveCount(1);
    await expect(tile.locator('.turn-card.is-live .live-earlier')).toContainText('Delegated to the workers.');
    await expect(tile.locator('.turn-card.is-live .thread-mirror-time .turn-card-time')).toHaveText(/^[5-9]s$/);
  });

  test('workers in the thread have no surface of their own and stay collapsed until opened', async ({ page }) => {
    const workers = [worker('build', { status: 'completed' }), worker('review', { status: 'failed' })];
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build it.', createdAt: 2000 },
    ] as Message[] });
    const list = transcript(page).locator('.team-progress'), toggle = list.locator('.team-progress-toggle');
    const row = list.locator('.team-progress-worker[data-worker-id="build"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row).toBeHidden();
    // Collapsed, the count says what needs the reader.
    await expect(list.locator('.team-progress-count')).toHaveText('1 failed');
    for (const [property, value] of [['background-color', 'rgba(0, 0, 0, 0)'], ['border-top-width', '0px'], ['box-shadow', 'none'], ['padding-left', '0px']] as const) await expect(list).toHaveCSS(property, value);
    // The line starts at the list's left edge, as the rows do.
    expect((await list.locator('.team-progress-label').boundingBox())!.x - (await toggle.boundingBox())!.x).toBeLessThan(30);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toBeVisible();
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await toggle.click();
    await expect(row).toBeHidden();
  });

  test('a long worker line never makes a narrow thread scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const long = worker('build', { status: 'completed', name: 'Attachment chips in sent messages plus drop paths for anything that cannot be attached '.repeat(3) });
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [long] }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build it.', createdAt: 2000 },
    ] as Message[] });
    const row = transcript(page).locator('.team-progress-worker[data-worker-id="build"]');
    await transcript(page).locator('.team-progress-toggle').click();
    await expect(row).toBeVisible();
    const fit = await transcript(page).evaluate(root => {
      const line = root.querySelector('.team-progress-worker')!.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      return { scrolls: root.scrollWidth > root.clientWidth, inside: line.right <= box.right };
    });
    expect(fit).toEqual({ scrolls: false, inside: true });
  });



  for (const view of ['conversation', 'board'] as const) {
    test(`renders internal coordination as neutral Team status and preserves real user JSON in ${view}`, async ({ page }) => {
      await installArchitect(page, { 'session-2': team('session-2') }, { 'session-2': coordinationHistory('session-2') });
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await selectTask(page, 'session-2', view); }
      const verify = async () => {
        // One card for the whole exchange: the labels and earlier replies are rows in its trace.
        await expect(transcript(page).locator('.turn-card')).toHaveCount(1);
        const trace = transcript(page).locator('.turn-card > details.turn-activity');
        if (!await trace.evaluate(node => (node as HTMLDetailsElement).open)) await trace.locator('> summary').click();
        const status = transcript(page).locator('.coordination-status[aria-label="Team status"]');
        await expect(status).toHaveCount(2);
        await expect(status.nth(0)).toBeVisible(); await expect(status.nth(0)).toContainText('Checking worker updates');
        await expect(status.nth(1)).toBeVisible(); await expect(status.nth(1)).toContainText('Reviewing worker results');
        expect(await status.evaluateAll(rows => rows.every(el => !el.closest('.user-message, .agent-message')))).toBe(true);
        await expect(status.locator('.provider-logo, .message-avatar')).toHaveCount(0);
        expect(await status.evaluateAll(rows => rows.every(el => el.parentElement!.classList.contains('turn-activity-body')))).toBe(true);
        await expect(transcript(page).locator('.user-message')).toHaveCount(1);
        await expect(transcript(page).locator('.user-message .message-content')).toHaveText(userJson);
        const responses = transcript(page).locator('.agent-message .message-content');
        await expect(responses).toHaveCount(3);
        await expect(responses.nth(0)).toBeVisible(); await expect(responses.nth(0)).toHaveText('I will coordinate the requested work.');
        await expect(responses.nth(1)).toBeVisible(); await expect(responses.nth(1)).toHaveText('The worker completed the search implementation.');
        await expect(responses.nth(2)).toBeVisible(); await expect(responses.nth(2)).toHaveText('The review passed and the task is ready.');
        const cards = transcript(page).locator('.turn-changes:visible');
        // One footer for the merged card, covering both runs' files.
        await expect(cards).toHaveCount(1); await expect(cards).toContainText('2 changed filesacross 2 runs+17');
      };
      await verify();
      await page.reload();
      await selectTask(page, 'session-2', view);
      await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
      await expect(transcript(page).getByText('Loading conversation…', { exact: true })).toBeHidden();
      await verify();
    });

    test(`replaces an architect's empty file summary with live worker progress in ${view}`, async ({ page }) => {
      const changes = { attributed: true, id: 'architect-handoff', files: [], additions: 0, deletions: 0, truncated: false, concurrent: false };
      const earlier = { ...changes, id: 'earlier-turn', files: [{ path: 'README.md', status: 'modified' as const, additions: 1, deletions: 0 }], additions: 1 };
      const assigned = [worker('build', { name: 'Search indexing' }), worker('review', { name: 'Accessibility audit' })];
      const snapshot = team('session-2', { workers: assigned });
      await installArchitect(page, { 'session-2': snapshot }, { 'session-2': [
        { id: 201, sessionId: 'session-2', role: 'user', content: 'Document the project.', createdAt: 100, turnDurationMs: 1000, turnChanges: earlier },
        { id: 202, sessionId: 'session-2', role: 'assistant', content: 'The project notes are ready.', createdAt: 1100 },
        { id: 301, sessionId: 'session-2', role: 'user', content: 'Build search and review its accessibility.', createdAt: 2000, turnDurationMs: 1000, turnChanges: changes },
        { id: 302, sessionId: 'session-2', role: 'assistant', content: 'Implementation and review are delegated to the workers.', createdAt: 3000 },
      ] });
      await seedHistory(page, 'session-2', 'review', 'Accessibility review is underway.');
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await selectTask(page, 'session-2', view); }
      const progress = transcript(page).locator('.team-progress[aria-label="Team progress"]');
      const builder = progress.locator('.team-progress-worker[data-worker-id="build"]');
      const reviewer = progress.locator('.team-progress-worker[data-worker-id="review"]');
      await expect(progress).toBeVisible();
      await progress.locator('.team-progress-toggle').click();
      // One inline line per spawned worker, no card or team heading.
      await expect(builder).toContainText('Spawned Search indexing'); await expect(reviewer).toContainText('Spawned Accessibility audit');
      await expect(progress.locator('.team-progress-heading')).toHaveCount(0);
      expect(Math.round((await builder.boundingBox())!.height)).toBeLessThanOrEqual(32);
      await expect(builder).toContainText('Search indexing'); await expect(builder).toContainText('Builder');
      // The harness is the logo; the text names role and model once each.
      await expect(builder.locator('.provider-logo[data-provider="codex"]')).toBeAttached(); await expect(builder).toContainText(/working/i);
      await expect(builder.locator('small')).toHaveText('Builder · GPT-6-Astra');
      // A working worker shows a spinning ring in place of the separator dot.
      await expect(builder.locator('.team-progress-spinner')).toBeVisible();
      expect(await builder.locator('.team-progress-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('state-pulse');
      // The line sits in the turn that spawned it, right after what the architect said there.
      expect(await builder.evaluate(row => {
        const slot = row.closest('.team-progress-slot');
        const previous = slot?.previousElementSibling;
        return Boolean(slot) && Boolean(previous?.textContent?.includes('Implementation and review are delegated to the workers.'));
      })).toBe(true);
      await expect(reviewer).toContainText('Accessibility audit'); await expect(reviewer).toContainText('Reviewer');
      await expect(reviewer.locator('.provider-logo[data-provider="claude"]')).toBeAttached(); await expect(reviewer).toContainText(/working/i);
      await expect(transcript(page).getByText('No files changed', { exact: true })).toBeHidden();
      await expect(transcript(page).locator('.turn-changes:visible')).toHaveCount(1);
      // The turn card's footer (`1 changed file`) replaced the per-turn file tree that listed README.md.
      await expect(transcript(page).locator('.turn-changes:visible')).toContainText('1 changed file+1');
      await progress.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/private/tmp/pandacode-team-progress-${view}.png`, animations: 'disabled' });
      await page.evaluate(() => { (window as any).__progressNodes = { host: document.querySelector('.team-progress'), build: document.querySelector('.team-progress-worker[data-worker-id="build"]'), review: document.querySelector('.team-progress-worker[data-worker-id="review"]') }; });
      await publish(page, team('session-3', { workers: [worker('other', { name: 'Unrelated background task' })] }));
      await nextPaint(page);
      await expect(progress).not.toContainText('Unrelated');
      await publish(page, { ...snapshot, status: 'paused', revision: 2 });
      await expect(builder.locator('.team-progress-status')).toHaveText('Paused');
      await expect(reviewer.locator('.team-progress-status')).toHaveText('Paused');
      await expect(builder.locator('.team-progress-spinner')).toBeHidden();
      await expect(progress).not.toContainText(/working/i);
      await publish(page, { ...snapshot, revision: 3, workers: assigned.map(entry => ({ ...entry, status: 'queued' })) });
      await expect(builder.locator('.team-progress-status')).toHaveText('Queued');
      await expect(reviewer.locator('.team-progress-status')).toHaveText('Queued');
      await expect(progress).not.toContainText(/working/i);
      const updated = assigned.map(entry => ({ ...entry, status: entry.id === 'build' ? 'completed' as const : 'waiting' as const }));
      await publish(page, { ...snapshot, status: 'waiting', revision: 4, workers: updated });
      await expect(builder).toContainText(/completed/i); await expect(reviewer).toContainText(/needs attention/i);
      expect(await page.evaluate(() => { const nodes = (window as any).__progressNodes; return nodes.host === document.querySelector('.team-progress') && nodes.build === document.querySelector('.team-progress-worker[data-worker-id="build"]') && nodes.review === document.querySelector('.team-progress-worker[data-worker-id="review"]'); })).toBe(true);
      // A text line does not shrink while pressed (that read as a flicker).
      await reviewer.scrollIntoViewIfNeeded();
      const reviewerBox = (await reviewer.boundingBox())!;
      await page.mouse.move(reviewerBox.x + 20, reviewerBox.y + reviewerBox.height / 2); await page.mouse.down();
      expect(await reviewer.evaluate(el => getComputedStyle(el).scale)).toMatch(/^(1|none)$/);
      await page.mouse.up();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator('.architect-worker-history')).toContainText('Accessibility review is underway.');
      expect((await calls(page, 'architect_worker_messages')).at(-1).args).toMatchObject({ sessionId: 'session-2', workerId: 'review' });
      await panel(page).getByRole('button', { name: 'Close workers', exact: true }).click();
      await publish(page, { ...snapshot, status: 'completed', revision: 5, workers: assigned.map(entry => ({ ...entry, status: 'completed' })) });
      await expect(builder).toContainText(/completed/i); await expect(reviewer).toContainText(/completed/i);
      await expect(transcript(page).locator('.turn-changes:visible')).toHaveCount(1);
      await expect(transcript(page).getByText('No files changed', { exact: true })).toBeHidden();
      await page.evaluate(changes => {
        const fixture = (window as any).__architectTest;
        const completed = { ...changes, id: 'architect-final', files: [{ path: 'src/search.ts', status: 'added', additions: 12, deletions: 0 }], additions: 12 };
        fixture.taskMessages['session-2'].push(
          { id: 303, sessionId: 'session-2', role: 'assistant', content: 'The worker changes are verified.', createdAt: 4000 },
          { id: 304, sessionId: 'session-2', role: 'changes', content: '', createdAt: 4000, turnChanges: completed },
        );
        fixture.event({ sessionId: 'session-2', kind: 'turn_changes', text: '', data: { messageId: 304, turnChanges: completed } });
      }, changes);
      await expect(transcript(page).locator('.turn-changes:visible')).toHaveCount(2);
      await expect(transcript(page).locator('.turn-changes:visible').last()).toContainText('1 changed file');
      await expect(transcript(page).locator('.turn-changes:visible').last()).toContainText('+12');
      await expect(transcript(page).getByText('No files changed', { exact: true })).toBeHidden();
      const queued = Array.from({ length: 6 }, (_, index) => worker('build', { id: `queued-${index}`, sessionId: `worker-queued-${index}`, name: `Queued assignment ${index + 1}`, status: 'queued' }));
      await publish(page, { ...snapshot, revision: 6, workers: [...queued,
        worker('build', { id: 'late-working', name: 'Late implementation' }),
        worker('review', { id: 'late-waiting', name: 'Late review', status: 'waiting' }),
      ] });
      await expect(progress.locator('.team-progress-worker')).toHaveCount(6);
      await expect(progress.locator('[data-worker-id="late-working"]')).toBeVisible();
      await expect(progress.locator('[data-worker-id="late-waiting"]')).toBeVisible();
      await expect(progress.locator('.team-progress-more')).toHaveText('2 more workers');
      await progress.locator('.team-progress-more').click();
      await expect(panel(page)).toBeVisible();
      await panel(page).getByRole('button', { name: 'Close workers', exact: true }).click();
      expect(await progress.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await transcript(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    });

    test(`overlay navigation opens the requested hidden worker and streams its response in ${view}`, async ({ page }) => {
      await installArchitect(page, { 'session-2': team('session-2') });
      await seedHistory(page, 'session-2', 'build', 'Builder saved response.');
      await seedHistory(page, 'session-2', 'review', 'Reviewer saved response.');
      await selectTask(page, 'session-3');
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      await page.evaluate(() => (window as any).__architectTest.publishOverlay({ sessionId: 'session-2', workerId: 'review', workerSessionId: 'worker-review' }));
      await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator('.architect-worker-history')).toContainText('Reviewer saved response.');
      await expect(panel(page)).not.toContainText('Builder saved response.');
      if (view === 'board') await expect(page.getByRole('region', { name: 'Task details', exact: true })).toBeVisible();
      await page.evaluate(() => {
        (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'text', text: 'Reviewer live update.' });
        (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'text', text: 'Unselected worker output.' });
      });
      await expect(live(page)).toHaveText('Reviewer live update.');
      await expect(panel(page)).not.toContainText('Unselected worker output.');
      await page.evaluate(() => (window as any).__architectTest.refresh());
      await nextPaint(page);
      await expect(live(page)).toHaveText('Reviewer live update.');
      await expect(page.locator('.task-item[data-id^="worker-"], [data-action="board-open"][data-id^="worker-"]')).toHaveCount(0);
      expect((await calls(page, 'architect_worker_messages')).at(-1).args).toMatchObject({ sessionId: 'session-2', workerId: 'review' });
      expect(await calls(page, 'architect_start')).toHaveLength(0);
    });

    test(`overlay navigation opens a worker-owned subagent with isolated live work in ${view}`, async ({ page }) => {
      await installArchitect(page, { 'session-2': team('session-2') });
      await page.evaluate(() => {
        const fixture = (window as any).__architectTest;
        const child = { id: 'shared-child', parentId: null, name: 'Worker reviewer', prompt: 'Review the worker change.', status: 'running', response: 'Saved worker child response.', tools: [], startedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001 };
        fixture.subagents['worker-build'] = [child];
        fixture.subagents['session-2'] = [{ ...child, name: 'Parent reviewer', response: 'Parent child must stay separate.' }];
      });
      await selectTask(page, 'session-3');
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
      await page.evaluate(() => (window as any).__architectTest.publishOverlay({ sessionId: 'session-2', workerId: 'build', workerSessionId: 'worker-build', subagentId: 'shared-child' }));
      const childPanel = page.locator('#worker-subagents-panel');
      await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
      await expect(childPanel).toBeVisible();
      await expect(childPanel.locator('.subagent-detail-name')).toHaveText('Worker reviewer');
      await expect(childPanel.locator('.subagent-response')).toHaveText('Saved worker child response.');
      await expect(page.locator('#subagents-panel')).toHaveCount(0);
      await expect(panel(page)).toBeHidden();
      if (view === 'board') await expect(page.getByRole('region', { name: 'Task details', exact: true })).toBeVisible();
      await page.evaluate(() => {
        const fixture = (window as any).__architectTest;
        (window as any).__overlayWorkerChildNode = document.querySelector('#worker-subagents-panel');
        const child = { ...fixture.subagents['worker-build'][0], response: 'Live worker child response.', updatedAt: 1_800_000_000_002 };
        fixture.subagents['worker-build'] = [child];
        fixture.event({ sessionId: 'worker-build', kind: 'subagent', text: '', data: child });
        fixture.event({ sessionId: 'session-2', kind: 'subagent', text: '', data: { ...child, response: 'Parent child live update.' } });
        fixture.refresh();
      });
      await expect(childPanel.locator('.subagent-response')).toHaveText('Live worker child response.');
      await nextPaint(page);
      expect(await page.evaluate(() => (window as any).__overlayWorkerChildNode === document.querySelector('#worker-subagents-panel'))).toBe(true);
      await expect(transcript(page)).not.toContainText('Live worker child response.');
      await expect(childPanel).not.toContainText('Parent child live update.');
      expect((await calls(page, 'list_subagents')).some((call: any) => call.args.sessionId === 'worker-build')).toBe(true);
    });

    test(`streams two workers independently with stable controls in ${view}`, async ({ page }) => {
      await installArchitect(page, { 'session-2': team('session-2') });
      await seedHistory(page, 'session-2', 'build'); await seedHistory(page, 'session-2', 'review');
      if (view === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await selectTask(page, 'session-2', view); }
      await openWorkers(page).click();
      await expect(row(page, 'build')).toContainText('Builder'); await expect(row(page, 'review')).toContainText('Reviewer');
      await row(page, 'build').click();
      await page.evaluate(() => {
        const fixture = (window as any).__architectTest;
        fixture.event({ sessionId: 'worker-build', kind: 'text', text: '**Builder output.** ' });
        fixture.event({ sessionId: 'worker-review', kind: 'text', text: '**Reviewer output.** ' });
        (window as any).__architectNodes = {
          panel: document.querySelector('.architect-panel'), back: document.querySelector('.architect-back'),
          live: document.querySelector('.architect-worker-live'), pause: document.querySelector('[data-team-control="pause"]'),
        };
      });
      await expect(live(page)).toHaveText('Builder output.');
      await expect(live(page).locator('strong')).toHaveText('Builder output.');
      await page.evaluate(async () => {
        for (let index = 1; index <= 25; index++) {
          (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'text', text: `word${index} ` });
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      });
      await expect(live(page)).toContainText('word25');
      expect(await page.evaluate(() => {
        const nodes = (window as any).__architectNodes;
        return nodes.panel === document.querySelector('.architect-panel') && nodes.back === document.querySelector('.architect-back')
          && nodes.live === document.querySelector('.architect-worker-live') && nodes.pause === document.querySelector('[data-team-control="pause"]');
      })).toBe(true);
      await expect(transcript(page)).not.toContainText('Builder output');
      await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click();
      await row(page, 'review').click();
      await expect(live(page)).toHaveText('Reviewer output.');
      await expect(panel(page).locator('.architect-worker-empty')).not.toContainText('Loading');
      await expect(live(page)).not.toContainText('word25');
      await expect(page.locator('.task-item[data-id^="worker-"]')).toHaveCount(0);
      await page.screenshot({ path: `/private/tmp/pandacode-architect-${view}-worker.png`, animations: 'disabled' });
    });
  }

  test('renders internal coordination neutrally in worker history without changing assignments or saved files', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2') });
    await page.evaluate(messages => {
      (window as any).__architectTest.histories['session-2:build'] = { messages, hasOlder: false };
    }, coordinationHistory('worker-build'));
    await openWorkers(page).click(); await row(page, 'build').click();
    const history = panel(page).locator('.architect-worker-history');
    const status = history.locator('.coordination-status[aria-label="Team status"]');
    await expect(status).toHaveCount(2);
    await expect(status.nth(0)).toBeVisible(); await expect(status.nth(0)).toContainText('Checking worker updates');
    await expect(status.nth(1)).toBeVisible(); await expect(status.nth(1)).toContainText('Reviewing worker results');
    await expect(status.locator('.provider-logo')).toHaveCount(0);
    await expect(history.locator('[data-message-id="601"]')).toContainText(userJson);
    await expect(history.locator('[data-message-id="601"] > small')).toHaveText('Assignment');
    for (const id of [602, 604, 607]) await expect(history.locator(`[data-message-id="${id}"] > small`)).toHaveText('Builder');
    await expect(history.locator('.turn-changes')).toHaveCount(2);
    await expect(history.locator('.turn-changes').first()).toContainText('search.ts');
    await expect(history.locator('.turn-changes').last()).toContainText('search.test.ts');
  });

  test('isolates worker histories and background updates while switching tasks', async ({ page }) => {
    await installArchitect(page, {
      'session-2': team('session-2'),
      'session-3': team('session-3', { workers: [worker('build', { sessionId: 'third-build', name: 'Third task builder' })] }),
    });
    await seedHistory(page, 'session-2', 'build', 'Second task saved response.');
    await seedHistory(page, 'session-3', 'build', 'Third task saved response.');
    await openWorkers(page).click(); await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-history')).toContainText('Second task saved response.');
    await selectTask(page, 'session-3');
    await openWorkers(page).click(); await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-history')).toContainText('Third task saved response.');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'text', text: 'Second task background output.' }));
    await publish(page, team('session-2', { revision: 2, summary: 'Second task update.' }));
    await nextPaint(page);
    await expect(panel(page)).not.toContainText('Second task');
    await selectTask(page, 'session-2');
    await openWorkers(page).click(); await row(page, 'build').click();
    await expect(live(page)).toHaveText('Second task background output.');
    await expect(panel(page)).not.toContainText('Third task saved response.');
  });

  test('ignores a stale worker history after opening a different worker', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2') });
    await seedHistory(page, 'session-2', 'build', 'Do not leak delayed builder history.');
    await seedHistory(page, 'session-2', 'review', 'Reviewer history belongs here.');
    await page.evaluate(() => { (window as any).__architectTest.hold['session-2:build'] = true; });
    await openWorkers(page).click(); await row(page, 'build').click();
    await expect.poll(() => page.evaluate(() => (window as any).__architectTest.release['session-2:build']?.length ?? 0)).toBeGreaterThan(0);
    await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click();
    await row(page, 'review').click();
    await expect(panel(page).locator('.architect-worker-history')).toContainText('Reviewer history belongs here.');
    await page.evaluate(() => {
      const fixture = (window as any).__architectTest;
      fixture.hold['session-2:build'] = false;
      for (const release of fixture.release['session-2:build']) release();
    });
    await nextPaint(page);
    await expect(panel(page)).not.toContainText('Do not leak');
    await expect(panel(page).locator('.architect-worker-history')).toContainText('Reviewer history belongs here.');
  });

  test('loads worker history while scrolling up within a bounded window and returns to the newest after completion', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2') });
    await page.evaluate(() => {
      (window as any).__architectTest.histories['session-2:build'] = { paginated: true, messages: Array.from({ length: 350 }, (_, i) => ({
        id: i + 1, sessionId: 'worker-build', role: i % 2 ? 'assistant' : 'user', content: `Worker history ${i + 1}.\n\n**Keep the requirements visible.**`, createdAt: i + 1,
      })) };
    });
    await openWorkers(page).click(); await row(page, 'build').click();
    const history = panel(page).locator('.architect-worker-history'), scroll = panel(page).locator('.architect-panel-scroll');
    await expect(history.locator('[data-message-id]')).toHaveCount(100);
    await expect(panel(page).getByRole('button', { name: 'Earlier worker messages', exact: true })).toHaveCount(0);
    // The transcript keeps a 200-message window: paging back drops the newest messages.
    for (const count of [200, 200, 200]) {
      await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
      await expect(history.locator('[data-message-id]')).toHaveCount(count);
    }
    await expect(history.locator('[data-message-id="1"]')).toHaveCount(1);
    await expect(history.locator('[data-message-id="350"]')).toHaveCount(0);
    await page.evaluate(() => {
      const fixture = (window as any).__architectTest;
      fixture.histories['session-2:build'].messages.push(...Array.from({ length: 180 }, (_, i) => ({ id: 351 + i, sessionId: 'worker-build', role: 'assistant', content: `The worker finished successfully. ${i}`, createdAt: 351 + i })));
      fixture.event({ sessionId: 'worker-build', kind: 'done', text: '' });
    });
    // Scrolling back to the bottom reloads the newest window.
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
    await expect(history.locator('[data-message-id="530"]')).toHaveCount(1);
    await expect(history.locator('[data-message-id="1"]')).toHaveCount(0);
    // The newest page reloads; older pages come back on scroll as before.
    await expect(history.locator('[data-message-id]')).toHaveCount(100);
    await expect(history).toContainText('The worker finished successfully.');
  });

  test('keeps worker scroll position and rejects delayed history after switching workers', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2') });
    await page.evaluate(() => {
      const fixture = (window as any).__architectTest;
      fixture.histories['session-2:build'] = { paginated: true, messages: Array.from({ length: 250 }, (_, i) => ({
        id: i + 1, sessionId: 'worker-build', role: 'assistant', content: `Saved builder ${i + 1}.`, createdAt: i + 1,
      })) };
      fixture.hold['session-2:build:older'] = true;
    });
    await seedHistory(page, 'session-2', 'review', 'Reviewer history belongs here.');
    await openWorkers(page).click(); await row(page, 'build').click();
    const scroll = panel(page).locator('.architect-panel-scroll');
    await expect(panel(page).locator('[data-message-id="151"]')).toHaveCount(1);
    await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => page.evaluate(() => (window as any).__architectTest.release['session-2:build:older']?.length ?? 0)).toBe(1);
    await page.evaluate(() => {
      const fixture = (window as any).__architectTest;
      fixture.event({ sessionId: 'worker-build', kind: 'text', text: 'Still working while reading history.' });
      fixture.hold['session-2:build:older'] = false;
      fixture.release['session-2:build:older'].shift()();
    });
    await expect(panel(page).locator('[data-message-id="51"]')).toHaveCount(1);
    await expect(live(page)).toContainText('Still working while reading history.');
    expect(await scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(1000);
    await page.evaluate(() => { (window as any).__architectTest.hold['session-2:build:older'] = true; });
    await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => page.evaluate(() => (window as any).__architectTest.release['session-2:build:older']?.length ?? 0)).toBe(1);
    await panel(page).getByRole('button', { name: 'Back to workers', exact: true }).click(); await row(page, 'review').click();
    await expect(panel(page).locator('.architect-worker-history')).toContainText('Reviewer history belongs here.');
    await page.evaluate(() => { (window as any).__architectTest.release['session-2:build:older'].shift()(); });
    await nextPaint(page);
    await expect(panel(page).locator('.architect-worker-history')).not.toContainText('Saved builder');
  });

  test('renders worker text safely while allowing the next team setup to change', async ({ page }) => {
    const malicious = '<img src=x onerror="window.__architectXss=1">';
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { name: malicious, assignment: '<script>window.__architectXss=2</script>' })] }) });
    await seedHistory(page, 'session-2', 'build', '**Saved result.** <script>window.__architectXss=3</script> [bad](javascript:alert(1))');
    await openWorkers(page).click();
    await expect(row(page, 'build')).toContainText(malicious); await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-history strong')).toHaveText('Saved result.');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'text', text: '**Live result.** <img src=x onerror="window.__architectXss=4">' }));
    await expect(live(page).locator('strong')).toHaveText('Live result.');
    await expect(panel(page).locator('script, img[onerror], a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__architectXss)).toBeUndefined();
    await panel(page).getByRole('button', { name: 'View team setup', exact: true }).click();
    await expect(setup(page).getByRole('button', { name: 'Apply setup', exact: true })).toBeEnabled();
    await expect(setup(page).getByRole('button', { name: 'Choose architect model', exact: true })).toBeEnabled();
    await expect(setup(page).getByRole('button', { name: 'Add worker profile', exact: true })).toBeEnabled();
    await expect(setup(page).getByRole('button', { name: 'Use a single agent', exact: true })).toHaveCount(0);
    expect(await calls(page, 'architect_configure')).toHaveLength(0);
  });

  test('shows a persisted tool once when the same tool also has a live update', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2') });
    await page.evaluate(() => {
      const fixture = (window as any).__architectTest;
      const tool = { id: 'read-file', name: 'Read', status: 'completed', input: 'src/search.ts', output: 'Saved file contents.' };
      fixture.histories['session-2:build'] = { messages: [{ id: 105, sessionId: 'worker-build', role: 'tool', content: JSON.stringify({ type: 'tool_activity', version: 1, ...tool }), createdAt: 1_800_000_000_001 }], hasOlder: false };
      fixture.event({ sessionId: 'worker-build', kind: 'tool', text: '', tool: { ...tool, status: 'running', output: '' } });
    });
    await openWorkers(page).click(); await row(page, 'build').click();
    const tools = panel(page).locator('.architect-worker-detail .tool-activity');
    await expect(tools).toHaveCount(1);
    await expect(tools).toHaveAttribute('data-tool-status', 'completed');
    await tools.locator(':scope > summary').click();
    await expect(tools).toContainText('Saved file contents.');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'tool', text: '', tool: { id: 'read-file', name: 'Read', status: 'completed', input: 'src/search.ts', output: 'Saved file contents.' } }));
    await nextPaint(page); await expect(tools).toHaveCount(1);
    await expect(tools).toHaveAttribute('open', '');
  });

  test('a worker approval reaches the panel only when auto-approval failed, and is the user\'s', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'running', workers: [worker('review', { status: 'queued' }), worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    await expect(panel(page).locator('.architect-worker-row').first()).toHaveAttribute('data-worker-id', 'build');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval', requestId: 'failed-review', text: 'Run the worker verification command?' }));
    // It needs the user: warn tone, first in the list, and counted in the tally and the trigger.
    const state = row(page, 'review').locator('.architect-worker-state');
    // A short word on the row; the full state is its title and what screen readers hear.
    await expect(state.locator('[aria-hidden="true"]')).toHaveText('Approve?');
    await expect(state).toHaveAttribute('title', 'Needs you: approval');
    await expect(state.locator('.sr-only')).toHaveText('Needs you: approval');
    // The tone is a class on the word; data-state-tone is only on the leading icon.
    await expect(state).toHaveClass(/architect-worker-state-attention/);
    // Plain text, not a tone: the warn tone stays on the leading glyph.
    expect(await state.evaluate(element => getComputedStyle(element).color === getComputedStyle(document.body).color)).toBe(true);
    await expect(state).not.toHaveAttribute('data-tone');
    await expect(row(page, 'review').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'near');
    // The same alert mark as the tally and the request, not the waiting dots.
    await expect(row(page, 'review').locator('.architect-worker-glyph')).toHaveAttribute('data-glyph', 'alert');
    await expect(panel(page).locator('.architect-worker-row').first()).toHaveAttribute('data-worker-id', 'review');
    // Read once: the "needs you" button says it, so the readable copy leaves it out.
    await expect(panel(page).locator('.architect-panel-tally-text').getByRole('button', { name: '1 needs you' })).toBeVisible();
    await expect(panel(page).locator('.architect-panel-tally-readable')).toHaveText('1 working');
    // The row only says so; it never carries the decision. Enter opens the transcript with the request focused.
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="review"] .architect-worker-more')).toBeHidden();
    await expect(panel(page).locator('.architect-worker-list').getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await row(page, 'review').focus();
    await page.keyboard.press('Enter');
    const card = panel(page).locator('.architect-worker-approvals .approval-card');
    await expect(card).toBeFocused();
    await expect(card).toHaveRole('group');
    await expect(card).toHaveAccessibleName(/^Reviewer needs you: approval: Run the worker verification command\?$/);
    await expect(card).toContainText('Automatic approval didn’t apply; your decision is needed.');
    await card.getByRole('button', { name: 'Approve', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0);
    // Focus moves to the transcript's back button, never to the page.
    await expect(panel(page).getByRole('button', { name: 'Back to workers' })).toBeFocused();
    expect((await calls(page, 'respond_approval')).map((call: any) => call.args)).toEqual([{ sessionId: 'worker-review', requestId: 'failed-review', approved: true }]);
    await panel(page).getByRole('button', { name: 'Back to workers' }).click();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval', requestId: 'failed-review', text: 'Run the worker verification command?' }));
    await expect(state.locator('[aria-hidden="true"]')).toHaveText('Approve?');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval_cancelled', requestId: 'failed-review', text: '' }));
    // Queued with a reason: no word on screen (the reason says it); the full status stays for screen readers.
    await expect(statusOf(row(page, 'review'))).toHaveText('Queued');
    await expect(state).not.toHaveClass(/architect-worker-state-attention/);
    await expect(row(page, 'review').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'worker-idle');
  });
  test('routes worker approvals to the worker session without changing its parent', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'waiting', workers: [worker('build', { status: 'waiting' })] }) });
    await seedHistory(page, 'session-2', 'build');
    await openWorkers(page).click(); await row(page, 'build').click();
    for (const [requestId, decision] of [['approve-build', 'Approve'], ['deny-build', 'Deny']] as const) {
      await page.evaluate(requestId => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId, text: 'Run the worker verification command?' }), requestId);
      // Only a failed auto-approval arrives here: its decision is in view, not behind a disclosure.
      const card = panel(page).locator('.architect-worker-approvals .approval-card');
      await expect(card).toContainText('Needs approval');
      await expect(card).toContainText('Run the worker verification command?');
      await expect(card.getByRole('button', { name: decision, exact: true })).toBeVisible();
      await expect(transcript(page)).not.toContainText('Run the worker verification command?');
      await card.getByRole('button', { name: decision, exact: true }).click();
      await expect(card).toHaveCount(0);
    }
    expect((await calls(page, 'respond_approval')).map((call: any) => call.args)).toEqual([
      { sessionId: 'worker-build', requestId: 'approve-build', approved: true },
      { sessionId: 'worker-build', requestId: 'deny-build', approved: false },
    ]);
    expect(await calls(page, 'architect_control')).toHaveLength(0);
  });
  test('tells the user when a worker needs input while the panel is closed', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'running', workers: [worker('build', { status: 'running' })] }) });
    // A cold Vite dev server can take longer than the default 5 s to show the Agents toggle.
    await expect(openWorkers(page)).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'ask-build', text: 'Run the worker verification command?' }));
    await expect(page.locator('#toast')).toContainText('A worker needs your approval');
    await expect(openWorkers(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  });
});


/* The Workers panel lists one dense line per worker, those that need the reader first, under a
 * one-line tally and a thin progress bar; each line unfolds its assignment and summary. The
 * `?workers` preview (src/preview-architect.ts) seeds a running team with a worker in every state. */

/** The tally as drawn, in words: the "needs you" button, each glyph count's title and the "+N" label. */
const visibleTally = (tally: Locator) => tally.evaluate(element => [...element.children].map(child => child.classList.contains('architect-tally-count') ? child.getAttribute('title')
  : child.classList.contains('architect-tally-more') ? child.getAttribute('aria-label')!.replace(/^(Show|Hide) /, '') : child.textContent));
/** Waits for the panel's open spring to settle: the tally's box holds still across two frames. */
const panelSettled = (page: Page) => expect.poll(() => panel(page).locator('.architect-panel-tally').evaluate(element => new Promise(resolve => {
  const before = JSON.stringify(element.getBoundingClientRect());
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(before === JSON.stringify(element.getBoundingClientRect()))));
}))).toBe(true);
/** An element's text as drawn: screen-reader-only text left out. */
const drawnText = (locator: Locator) => locator.evaluate(element => { const copy = element.cloneNode(true) as HTMLElement; copy.querySelectorAll('.sr-only').forEach(node => node.remove()); return copy.textContent!.trim(); });
const tallySum = (parts: (string | null)[]) => parts.reduce((sum, part) => sum + Number(/^\d+/.exec(part ?? '')?.[0] ?? 0), 0);
/** A row's full status, as screen readers hear it (Working and Done have no visible word). */
const statusOf = (row: Locator) => row.locator('.architect-worker-state.sr-only, .architect-worker-state > .sr-only');
const compactItem = (page: Page, id: string) => panel(page).locator(`.architect-worker-item[data-worker-id="${id}"]`);

async function openShowcase(page: Page): Promise<void> {
  await page.goto('/?workers');
  await page.locator('#navigation .task-item').first().waitFor();
  const toggle = page.locator('#agents-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel(page)).toBeVisible();
  // The showcase's failed auto-approval arrives just after the team.
  await expect(compactItem(page, 'styles').locator('.architect-worker-state')).toHaveAttribute('title', 'Needs you: approval');
}

test.describe('compact workers list', () => {
test('workers are dense rows ordered by status, with effort and attempt chips', async ({ page }) => {
  await openShowcase(page);
  const rows = panel(page).locator('.architect-worker-row');
  await expect(rows).toHaveCount(6);
  // Needs the user first, then failed, working, queued, stopped, and finished work last.
  await expect.poll(() => rows.evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.workerId))).toEqual(['styles', 'index', 'search', 'docs', 'audit', 'tests']);
  // Every row is one 38px line, a failed one too (its reason is cut, never wrapped).
  for (const height of await rows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))) {
    expect(height).toBeGreaterThanOrEqual(36); expect(height).toBeLessThanOrEqual(38);
  }
  // Effort and attempt sit on the meta line, so the name keeps the first line; status and elapsed share a column.
  const meta = compactItem(page, 'styles').locator('.architect-worker-meta-line');
  await expect(meta).toContainText('x-high');
  await expect(meta).toContainText('×2');
  // Visible status words share one right edge; Working and Done show none (the glyph says it), only reader text.
  const edges = await rows.evaluateAll(rows => rows.flatMap(row => [...row.querySelectorAll('.architect-worker-state:not(.sr-only)')].map(word => word.getBoundingClientRect().right)));
  // Approve? and Stopped: a queued row with a reason ("Waiting for a dependency") shows no word beside it.
  expect(edges.length).toBe(2);
  await expect(compactItem(page, 'docs').locator('.architect-worker-state:not(.sr-only)')).toHaveCount(0);
  await expect(statusOf(compactItem(page, 'docs'))).toHaveText('Queued');
  expect(new Set(edges.map(Math.round)).size).toBe(1);
  await expect(compactItem(page, 'search').locator('.architect-worker-state:not(.sr-only)')).toHaveCount(0);
  await expect(statusOf(compactItem(page, 'search'))).toHaveText('Working');
  await expect(statusOf(compactItem(page, 'tests'))).toHaveText('Done');
  await expect(compactItem(page, 'docs').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'worker-idle');
  // Stopped has a mark of its own (ring and square), still muted, unlike queued's waiting dots.
  await expect(compactItem(page, 'audit').locator('.architect-worker-glyph')).toHaveAttribute('data-glyph', 'stopped');
  await expect(compactItem(page, 'audit').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'worker-idle');
  await expect(compactItem(page, 'docs').locator('.architect-worker-glyph')).toHaveAttribute('data-glyph', 'pending');
  expect(await compactItem(page, 'audit').locator('.architect-worker-glyph').innerHTML()).not.toBe(await compactItem(page, 'docs').locator('.architect-worker-glyph').innerHTML());
  // Every status word fits its column untruncated.
  expect(await panel(page).locator('.architect-worker-state:not(.sr-only)').evaluateAll(words => words.every(word => word.scrollWidth <= word.clientWidth + 1))).toBe(true);
  // Elapsed time is spoken in full.
  await expect(compactItem(page, 'search').locator('.architect-worker-row')).toHaveAccessibleName(/^Make search results stream as they arrive, Working, running \d+ minutes? — open transcript$/);
  // Long runs stay compact: over an hour and over a day, each fitting the column, in full in the title.
  // 75 minutes reads "75m" (minutes up to 90m), never a floored "1h".
  await expect(compactItem(page, 'tests').locator('.architect-worker-elapsed')).toHaveText('75m');
  // A finished row's time says "ran" (a faint prefix), so it never reads like "1h ago"; a running one does not.
  await expect(compactItem(page, 'tests').locator('.architect-worker-elapsed')).toHaveAttribute('data-ran', '');
  expect(await compactItem(page, 'tests').locator('.architect-worker-elapsed').evaluate(cell => getComputedStyle(cell, '::before').content)).toMatch(/^"ran\s"/);
  await expect(compactItem(page, 'search').locator('.architect-worker-elapsed')).not.toHaveAttribute('data-ran');
  expect(await compactItem(page, 'search').locator('.architect-worker-elapsed').evaluate(cell => getComputedStyle(cell, '::before').content)).toBe('none');
  await expect(compactItem(page, 'tests').locator('.architect-worker-elapsed')).toHaveAttribute('title', 'ran 1 hour 15 minutes');
  await expect(compactItem(page, 'audit').locator('.architect-worker-elapsed')).toHaveText('1d');
  await expect(compactItem(page, 'audit').locator('.architect-worker-row')).toHaveAccessibleName('Audit search accessibility, Stopped, ran 1 day 2 hours — open transcript');
  expect(await panel(page).locator('.architect-worker-elapsed').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1))).toBe(true);
  // The meta line uses the full width, under the elapsed column too (no reserve).
  const metaRight = await compactItem(page, 'search').locator('.architect-worker-meta-line').evaluate(meta => ({ right: meta.getBoundingClientRect().right, pad: getComputedStyle(meta).paddingInlineEnd }));
  const elapsedRight = await compactItem(page, 'search').locator('.architect-worker-elapsed').evaluate(cell => cell.getBoundingClientRect().right);
  expect(metaRight.pad).toBe('0px');
  expect(Math.abs(metaRight.right - elapsedRight)).toBeLessThanOrEqual(1);
  // A queued row has no time and no status word: its elapsed column takes no width, and the name runs to the edge.
  const docsElapsed = compactItem(page, 'docs').locator('.architect-worker-elapsed');
  await expect(docsElapsed).toHaveText('');
  await expect(docsElapsed).toHaveCSS('display', 'none');
  const docsLine = await compactItem(page, 'docs').locator('.architect-worker-copy > .architect-worker-line').first().evaluate(line => ({ right: line.getBoundingClientRect().right, name: line.querySelector('strong')!.getBoundingClientRect().right }));
  expect(Math.abs(docsLine.right - docsLine.name)).toBeLessThanOrEqual(1);
  await expect(compactItem(page, 'search').locator('.architect-worker-effort [aria-hidden="true"]')).toHaveText('high');
  await expect(compactItem(page, 'search').locator('.architect-worker-effort .sr-only')).toHaveText('reasoning effort high');
  await expect(compactItem(page, 'styles').locator('.architect-worker-effort [aria-hidden="true"]')).toHaveText('x-high');
  await expect(compactItem(page, 'docs').locator('.architect-worker-effort')).toHaveCount(0);
  await expect(compactItem(page, 'index').locator('.architect-worker-attempt [aria-hidden="true"]')).toHaveText('×2');
  await expect(compactItem(page, 'index').locator('.architect-worker-attempt .sr-only')).toHaveText('attempt 2');
  await expect(compactItem(page, 'search').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'team');
  // Failed reads as failed: the danger tone, never the amber of "needs you".
  await expect(compactItem(page, 'index').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'danger');
  const toneOf = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).color);
  expect(await page.evaluate(() => document.querySelectorAll('[data-state-tone="failed"]').length)).toBe(0);
  expect(await toneOf(compactItem(page, 'index').locator('.architect-worker-glyph'))).not.toBe(await toneOf(panel(page).locator('.architect-panel-tally-text .architect-tally-icon')));
  await expect(compactItem(page, 'tests').locator('.architect-worker-glyph')).toHaveAttribute('data-state-tone', 'ready');
  await expect(compactItem(page, 'search').locator('.architect-worker-elapsed')).toHaveText(/^\d+m$/);
  // A long name is cut to one line and keeps its full text in a title.
  const name = compactItem(page, 'search').locator('.architect-worker-copy strong');
  await expect(name).toHaveAttribute('title', 'Make search results stream as they arrive');
  // The tally fits the panel: the minor buckets move to its title when space is short.
  const tally = panel(page).locator('.architect-panel-tally-text');
  await expect(tally.locator('.architect-tally-asking')).toHaveText('1 needs you');
  await expect(tally.locator('.architect-tally-icon')).toHaveAttribute('data-state-tone', 'near');
  // Counted in the rows' order; a shortened line keeps a visible "+N more" so its counts add up to the workers.
  await expect(tally).toHaveAttribute('title', '1 needs you · 1 failed · 1 working · 1 queued · 1 stopped · 1 done');
  // Words first, glyphs as the fallback: at the default width the minor buckets (queued, stopped) fold into "+2 more"
  // while failed, working and done keep their words. "needs you" keeps its words: it is a button.
  await expect.poll(() => drawnText(tally)).toBe('1 needs you1 failed1 working1 done+2 more');
  // A dot separates the worded counts on screen: drawn out of flow in the gap (the line is no wider) with no content,
  // so screen readers skip it.
  for (const count of await tally.locator('.architect-tally-count[data-worded], .architect-tally-more').all()) {
    expect(await count.evaluate(element => { const dot = getComputedStyle(element, '::before'); return [dot.content, dot.position, dot.borderTopWidth]; })).toEqual(['""', 'absolute', '2px']);
  }
  for (const count of await tally.locator('.architect-tally-count').all()) { expect(await count.textContent()).toBe(await count.getAttribute('title')); await expect(count).toHaveAttribute('data-worded', ''); }
  // Wide enough, every bucket reads its words.
  await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '600px'; });
  await expect.poll(() => drawnText(tally)).toBe('1 needs you1 failed1 working1 queued1 stopped1 done');
  for (const count of await tally.locator('.architect-tally-count').all()) { expect(await count.textContent()).toBe(await count.getAttribute('title')); await expect(count).toHaveAttribute('data-worded', ''); }
  // Narrower, the kept buckets go compact: the glyph (in its tone) and the number, the word in the title.
  await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '340px'; });
  await expect.poll(() => drawnText(tally)).toBe('1 needs you111+2 more');
  await expect(tally.locator('.architect-tally-count').first().locator('.architect-tally-glyph')).toHaveAttribute('data-state-tone', 'danger');
  for (const count of await tally.locator('.architect-tally-count').all()) expect(await count.textContent()).toBe((await count.getAttribute('title'))!.split(' ')[0]);
  await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '760px'; });
  await expect.poll(() => visibleTally(tally)).toEqual(['1 needs you', '1 failed', '1 working', '1 queued', '1 stopped', '1 done']);
  await expect(tally.locator('.architect-tally-more')).toHaveCount(0);
  await expect(panel(page).locator('.architect-panel-tally-readable')).toHaveText('1 failed · 1 working · 1 queued · 1 stopped · 1 done');
  // Read once: the visible line is hidden from screen readers except its button; the live copy speaks it.
  expect(await tally.evaluate(element => [...element.children].every(child => child.tagName === 'BUTTON' || child.classList.contains('architect-tally-more') || child.getAttribute('aria-hidden') === 'true'))).toBe(true);
  expect(await tally.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  // The tally counts the workers, so the header's task count steps aside.
  await expect(panel(page).locator('.architect-panel-count')).toBeHidden();
  const bar = panel(page).getByRole('progressbar', { name: 'Workers done' });
  // Only done counts as progress: the failed and stopped workers do not.
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await expect(bar).toHaveAttribute('aria-valuemax', '6');
  // Every row stays folded, the one that needs the user too: its row says so, and its transcript holds the request.
  await expect(panel(page).locator('.architect-worker-more:visible')).toHaveCount(0);
  await expect(statusOf(compactItem(page, 'styles'))).toHaveText('Needs you: approval');
  if (process.env.PANDACODE_SHOT) await panel(page).screenshot({ path: process.env.PANDACODE_SHOT });
});

test('a row unfolds its assignment and summary by click and keyboard, and opens its transcript', async ({ page }) => {
  await openShowcase(page);
  const failed = compactItem(page, 'index'), expand = failed.locator('.architect-worker-expand'), more = failed.locator('.architect-worker-more');
  const rowButton = failed.locator('.architect-worker-row');
  // The row only opens the transcript (no expanded state); the caret is the disclosure, and the row's
  // description says whether the details are shown.
  await expect(rowButton).not.toHaveAttribute('aria-expanded');
  await expect(rowButton).toHaveAccessibleName(/^Rebuild the index on change, Failed, ran \d+ minutes? — open transcript$/);
  await expect(rowButton).toHaveAccessibleDescription(/Details hidden/);
  await expect(expand).not.toHaveAttribute('aria-hidden');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(expand).toHaveAttribute('aria-controls', /^architect-worker-more-/);
  // A neutral name; aria-expanded carries the state (the tooltip may say Show or Hide).
  await expect(expand).toHaveAccessibleName('Details for Rebuild the index on change');
  await expand.click();
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await expect(rowButton).toHaveAccessibleDescription(/Details shown/);
  await expect(more).toBeVisible();
  await expect(more).toContainText('The sample build step failed');
  await expect(more).toContainText('Rebuild the index on change: sample assignment.');
  // The adjusted-effort note is in the details too (not only the meta line's title), below the error.
  await expect(more.locator('.architect-worker-error + .architect-worker-more-quiet')).toHaveText('Asked for high effort; this model ran at medium.');
  // The footer is the write scope only; model and effort are already on the row.
  await expect(more.locator('.architect-worker-more-foot small')).toHaveText('Write scope: src/index.ts');
  await expand.click();
  await expect(more).toBeHidden();

  // Keyboard: arrows walk the rows, right unfolds and left folds.
  const row = failed.locator('.architect-worker-row');
  await row.focus();
  await page.keyboard.press('ArrowRight');
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await expect(rowButton).toHaveAccessibleDescription(/Details shown/);
  await page.keyboard.press('ArrowLeft');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(rowButton).toHaveAccessibleDescription(/Details hidden/);
  await page.keyboard.press('ArrowDown');
  await expect(compactItem(page, 'search').locator('.architect-worker-row')).toBeFocused();

  // Enter on the current row opens its transcript; a failed auto-approval there is brought into view and focused.
  await compactItem(page, 'styles').locator('.architect-worker-row').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).locator('.architect-worker-approvals .approval-card')).toBeFocused();
  await expect(panel(page).locator('.architect-worker-approvals .approval-card')).toBeInViewport();
  // The worker's header (name and model) stays in view above it, whole.
  await expect(panel(page).locator('.architect-worker-meta')).toBeInViewport({ ratio: 1 });
  expect(await panel(page).locator('.architect-worker-meta').evaluate(meta => meta.getBoundingClientRect().top >= meta.closest('.architect-panel-scroll')!.getBoundingClientRect().top - 0.5)).toBe(true);
  // Deny and Approve sit apart from the request and from each other.
  const actions = panel(page).locator('.architect-worker-approvals .approval-card > div');
  expect(await actions.evaluate(row => {
    const [deny, approve] = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    const request = row.parentElement!.querySelector('.architect-worker-request')!.getBoundingClientRect();
    return { gap: approve.left - deny.right >= 8, below: deny.top - request.bottom >= 8 };
  })).toEqual({ gap: true, below: true });
  await panel(page).getByRole('button', { name: 'Back to workers' }).click();

  // A finished worker shows its summary; its transcript is one click away.
  const done = compactItem(page, 'tests');
  await done.locator('.architect-worker-expand').click();
  await expect(done.locator('.architect-worker-more')).toContainText('Added three cases');
  await done.getByRole('button', { name: 'Open transcript', exact: true }).click();
  await expect(panel(page).locator('.architect-worker-detail')).toBeVisible();
  await expect(panel(page).locator('.architect-panel-tally')).toBeHidden();
  await panel(page).getByRole('button', { name: 'Back to workers' }).click();
  await expect(panel(page).locator('.architect-panel-tally')).toBeVisible();
});
});

test.describe('compact workers keyboard', () => {
  test('the list is one Tab stop: arrows move the current row, the caret is not a stop', async ({ page }) => {
    await openShowcase(page);
    const rows = panel(page).locator('.architect-worker-row');
    await expect(rows).toHaveCount(6);
    await expect(panel(page).locator('.architect-worker-row[tabindex="0"]')).toHaveCount(1);
    await expect(panel(page).locator('.architect-worker-expand:not([tabindex="-1"])')).toHaveCount(0);
    // The row opens the transcript; its description (meta line, details state, the one hint) tells it unfolds.
    const first = rows.first();
    await expect(first).not.toHaveAttribute('aria-expanded');
    await expect(first).not.toHaveAttribute('aria-controls');
    await expect(first).toHaveAttribute('aria-keyshortcuts', 'ArrowRight ArrowLeft Enter');
    await expect(first).not.toHaveAttribute('aria-description');
    // Each row: only its short details state and "Right arrow shows details"; the full hint is said once, by the list.
    // Each row: its meta line and its details state only; the keyboard hint is said once, by the list.
    await expect(first).toHaveAccessibleDescription(/GPT-6-Astra.*reasoning effort x-high.*attempt 2 Details hidden$/);
    await expect(panel(page).locator('.architect-worker-list')).toHaveAccessibleDescription(/Home and End jump to the first and last\. Right arrow shows details, left arrow hides them, Enter opens the transcript/);
    // A note is information, not an error.
    const docs = compactItem(page, 'docs');
    await docs.locator('.architect-worker-row').focus();
    await page.keyboard.press('ArrowRight');
    await expect(docs.locator('.architect-worker-more-quiet')).toContainText('has no reasoning effort setting');
    await expect(docs.locator('.architect-worker-error')).toHaveCount(0);
    // The queue reason is on the meta line (cut when short of room) and whole in the details.
    await expect(docs.locator('.architect-worker-meta-line')).toContainText('Waiting for a dependency');
    await expect(docs.locator('.architect-worker-more-queue')).toHaveText('Waiting for a dependency');
    await page.keyboard.press('ArrowLeft');
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute('tabindex', '0');
    await expect(rows.first()).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('End');
    await expect(rows.last()).toBeFocused();
    // Tab leaves the list rather than walking every row and caret.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('.architect-worker-item') === null || !!document.activeElement?.closest('.architect-worker-more'))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(rows.last()).toBeFocused();
  });
});

test.describe('compact workers tally', () => {
  test('"needs you" jumps to the worker, and the full tally returns when the panel widens', async ({ page }) => {
    await openShowcase(page);
    const tally = panel(page).locator('.architect-panel-tally-text');
    await tally.getByRole('button', { name: '1 needs you' }).click();
    await expect(compactItem(page, 'styles').locator('.architect-worker-row')).toBeFocused();
    const full = '1 needs you · 1 failed · 1 working · 1 queued · 1 stopped · 1 done';
    await expect(tally).toHaveAttribute('title', full);
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '320px'; });
    // Narrow, it ends with a "+N" button that names what it hides; the visible counts still add up.
    await expect.poll(async () => (await visibleTally(tally)).at(-1)).toMatch(/^\d+ more: /);
    expect(tallySum(await visibleTally(tally))).toBe(6);
    const more = tally.locator('.architect-tally-more');
    // A real button: keyboard focus and Enter unfold the hidden counts on a line of their own, and fold them again.
    await expect(panel(page).locator('.architect-panel-tally-readable')).toHaveText(full.replace('1 needs you · ', ''));
    await expect(more).toHaveAttribute('title', /stopped/);
    // On screen it says "+N more"; its accessible name still lists what it hides.
    await expect(more).toHaveText(/^\+\d more$/);
    await expect(more).toHaveAccessibleName(/^Show \d more: /);
    const hidden = panel(page).locator('#architect-tally-hidden');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveAttribute('aria-controls', 'architect-tally-hidden');
    await expect(hidden).toBeHidden();
    await more.focus();
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(hidden).toBeVisible();
    // Open, the button says "Hide" (its name still starts with what it says), and the unfolded line uses the same
    // compact glyph counts, each saying its word to screen readers.
    await expect(more).toHaveText('Hide');
    await expect(more).toHaveAccessibleName(/^Hide \d more: /);
    await expect(hidden.locator('.architect-tally-count[title="1 stopped"] .architect-tally-glyph svg')).toHaveCount(1);
    await expect(hidden.locator('.architect-tally-count[title="1 stopped"] .sr-only')).toHaveText('1 stopped');
    expect(await drawnText(hidden)).toMatch(/^1+$/);
    // The shown counts plus the unfolded ones add up to every worker.
    expect(tallySum((await visibleTally(tally)).slice(0, -1)) + tallySum(await visibleTally(hidden))).toBe(6);
    expect(await tally.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveText(/^\+\d more$/);
    await expect(more).toHaveAccessibleName(/^Show \d more: /);
    await expect(hidden).toBeHidden();
    // Its one focus ring is inset and inside the tally's clip box.
    await page.keyboard.press('Shift');
    await tally.getByRole('button', { name: '1 needs you' }).focus();
    const ring = await tally.getByRole('button', { name: '1 needs you' }).evaluate(button => {
      const style = getComputedStyle(button), box = button.getBoundingClientRect(), clip = button.parentElement!.getBoundingClientRect();
      return { visible: button.matches(':focus-visible'), style: style.outlineStyle, offset: style.outlineOffset, inside: box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5 && box.left >= clip.left - 0.5 };
    });
    expect(ring).toEqual({ visible: true, style: 'solid', offset: '-2px', inside: true });
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '760px'; });
    await expect.poll(() => visibleTally(tally)).toEqual(full.split(' · '));
  });
});

test.describe('worker approval card reveal', () => {
  test('a short window keeps the sticky worker header in view over the revealed card, which names its worker', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await openShowcase(page);
    await compactItem(page, 'styles').locator('.architect-worker-row').focus();
    await page.keyboard.press('Enter');
    const card = panel(page).locator('.architect-worker-approvals .approval-card');
    await expect(card).toBeFocused();
    await expect(card).toHaveAccessibleName(/ needs you: approval: /);
    const name = await panel(page).locator('.architect-worker-meta strong').textContent();
    expect((await card.getAttribute('aria-label'))!.startsWith(`${name} needs you: approval: `)).toBe(true);
    const meta = panel(page).locator('.architect-worker-meta');
    await expect(meta).toHaveCSS('position', 'sticky');
    // The pinned band runs edge to edge of the scroller (inside any scrollbar gutter).
    expect(await meta.evaluate(element => {
      const scroller = element.closest('.architect-panel-scroll')!, box = element.getBoundingClientRect(), outer = scroller.getBoundingClientRect();
      return Math.abs(box.left - outer.left - scroller.clientLeft) <= 0.5 && Math.abs(box.right - (outer.left + scroller.clientLeft + scroller.clientWidth)) <= 0.5;
    })).toBe(true);
    // Whole and inside the scroller, and the card's top is not under it.
    await expect.poll(() => meta.evaluate(element => {
      const box = element.getBoundingClientRect(), scroller = element.closest('.architect-panel-scroll')!.getBoundingClientRect();
      const card = document.querySelector('.architect-worker-approvals .approval-card')!.getBoundingClientRect();
      return box.top >= scroller.top - 0.5 && box.bottom <= scroller.bottom + 0.5 && card.top >= box.bottom - 0.5;
    })).toBe(true);
    await expect(meta).toBeInViewport({ ratio: 1 });
    await expect(card).toBeInViewport();
  });
});

test.describe('compact workers tally announcements', () => {
  test('a repaint with unchanged counts leaves the tally untouched, and its live region holds plain text', async ({ page }) => {
    const start = team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued' })] });
    await installArchitect(page, { 'session-2': start });
    await openWorkers(page).click();
    const live = panel(page).locator('.architect-panel-live');
    // Opening the panel announces nothing.
    await expect(panel(page).locator('.architect-panel-tally-readable')).toHaveText('1 working · 1 queued');
    await expect(live).toHaveText('');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live.locator('button')).toHaveCount(0);
    await expect(panel(page).locator('.architect-panel-tally-text')).not.toHaveAttribute('aria-live');
    await page.evaluate(() => {
      const tally = document.querySelector('.architect-panel-tally')!;
      (window as any).__tallyMutations = 0;
      new MutationObserver(records => { (window as any).__tallyMutations += records.length; }).observe(tally, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    // A summary changes (a repaint) but no count does.
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 2, workers: [worker('build', { status: 'running', summary: 'Half done.' }), worker('review', { status: 'queued' })] });
    await panel(page).locator('.architect-worker-item[data-worker-id="build"] .architect-worker-expand').click();
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="build"] .architect-worker-more')).toContainText('Half done.');
    expect(await page.evaluate(() => (window as any).__tallyMutations)).toBe(0);
    // Working → done is not announced; a failure is.
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 3, workers: [worker('build', { status: 'completed' }), worker('review', { status: 'queued' })] });
    await expect(panel(page).locator('.architect-panel-tally-text')).toHaveAttribute('title', '1 queued · 1 done');
    await expect(live).toHaveText('');
    // What a screen reader finds on the tally is current, though nothing was announced.
    const readable = panel(page).locator('.architect-panel-tally-readable');
    await expect(readable).toHaveText('1 queued · 1 done');
    await expect(readable).not.toHaveAttribute('aria-live');
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 4, workers: [worker('build', { status: 'completed' }), worker('review', { status: 'failed' })] });
    await expect(live).toHaveText('1 failed · 1 done');
  });
});

test.describe('compact workers states', () => {
  test('an empty team is a sentence, not a list; a queued worker shows its reason without an effort', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'running', workers: [] }) });
    await openWorkers(page).click();
    const list = panel(page).locator('.architect-worker-list');
    await expect(list).toContainText('The architect is planning its first assignments.');
    await expect(list).not.toHaveAttribute('role');
    await expect(list).not.toHaveAttribute('aria-label');
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), team('session-2', { revision: 2, workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued', dependsOn: ['build'] })] }));
    await expect(list).toHaveAttribute('role', 'list');
    await expect(list).toHaveAttribute('aria-label', 'Workers');
    const meta = panel(page).locator('.architect-worker-item[data-worker-id="review"] .architect-worker-meta-line');
    // Queued: only the reason on the meta line (the model is in the details); the effort is its own label, never cut.
    await expect(meta.locator('small')).toHaveAttribute('title', /^Waiting for .+$/);
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '220px'; });
    const effort = meta.locator('.architect-worker-effort');
    await expect(effort.locator('[aria-hidden="true"]')).toHaveText('medium');
    await expect(effort).toBeVisible();
    expect(await effort.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().width > 0)).toBe(true);
    expect(await meta.locator('small').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = ''; });
    // The whole reason is in the row's title and in its unfolded details.
    const queued = panel(page).locator('.architect-worker-item[data-worker-id="review"]');
    await expect(queued.locator('.architect-worker-row')).toHaveAttribute('title', /^Reviewer · Waiting for .+$/);
    await queued.locator('.architect-worker-expand').click();
    await expect(queued.locator('.architect-worker-more-queue')).toHaveText(/^Waiting for .+$/);
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="build"] .architect-worker-effort [aria-hidden="true"]')).toHaveText('high');
  });
  test('a long request scrolls in a labelled region with a hint, above Approve', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    await row(page, 'build').click();
    const command = Array.from({ length: 60 }, (_, line) => `rm -rf ./build/output-${line} && echo "cleaned ${line}" # step ${line} of a long cleanup`).join('\n');
    await page.evaluate(text => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'long-build', text }), command);
    // The one legacy path: the transcript's card.
    const card = panel(page).locator('.architect-worker-approvals .approval-card');
    const request = card.locator('.architect-worker-request');
    await expect(request).toHaveText(command);
    await expect(card.locator('.architect-worker-more-label')).toHaveText('Request');
    const layout = await card.evaluate(element => {
      const request = element.querySelector<HTMLElement>('.architect-worker-request')!, approve = [...element.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === 'Approve')!;
      const line = parseFloat(getComputedStyle(request).lineHeight);
      return { scrolls: request.scrollHeight > request.clientHeight + 1, lines: Math.round((request.clientHeight - 12) / line), font: getComputedStyle(request).fontFamily, below: approve.getBoundingClientRect().top >= request.getBoundingClientRect().bottom };
    });
    // Capped at twelve lines; the rest scrolls, and Approve stays below.
    expect(layout).toMatchObject({ scrolls: true, lines: 12, below: true });
    expect(layout.font).toMatch(/mono/i);
    await expect(request).toHaveRole('region');
    await expect(request).toHaveAccessibleName('Request (scroll for more)');
    await expect(request).toHaveAttribute('tabindex', '0');
    await expect(card.locator('.architect-worker-request-hint')).toBeVisible();
    await expect(card.locator('.architect-worker-request-hint')).toHaveText('Scroll to read the full request');
    await request.focus();
    await expect(request).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => request.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    // A short request needs neither: no Tab stop, no hint.
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval_cancelled', requestId: 'long-build', text: '' }));
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'short-build', text: 'Run the tests?' }));
    await expect(request).toHaveText('Run the tests?');
    await expect(request).not.toHaveAttribute('tabindex');
    await expect(card.locator('.architect-worker-request-hint')).toBeHidden();
  });
  test('an open row still shows hover, and the keyboard row lights its caret', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued' })] }) });
    await openWorkers(page).click();
    const item = panel(page).locator('.architect-worker-item[data-worker-id="build"]');
    await item.locator('.architect-worker-expand').click();
    await page.mouse.move(2, 2);
    const fill = () => item.evaluate(element => getComputedStyle(element).backgroundColor);
    const rowFill = () => item.locator('.architect-worker-row').evaluate(element => getComputedStyle(element).backgroundColor);
    // Fills fade (~180 ms): read each only once it has settled (two reads a fade apart agree).
    const settled = async (read: () => Promise<string>) => {
      let value = '';
      await expect.poll(async () => { const first = await read(); await page.waitForTimeout(250); value = await read(); return first === value; }, { timeout: 5000 }).toBe(true);
      return value;
    };
    const open = await settled(fill), rowOpen = await settled(rowFill);
    // Open is its own, persistent look (card fill and hairline), not the hover fill of a closed row.
    const closed = panel(page).locator('.architect-worker-item[data-worker-id="review"]');
    await closed.locator('.architect-worker-row').hover();
    const hovered = await settled(() => closed.evaluate(element => getComputedStyle(element).backgroundColor));
    expect(hovered).not.toBe(open);
    expect(await item.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await page.mouse.move(2, 2);
    // The open card keeps its single fill under the pointer (no second tint on its header); the caret brightens.
    const caretColor = () => item.locator('.architect-worker-expand').evaluate(element => getComputedStyle(element).color);
    const caretIdle = await settled(caretColor);
    await item.locator('.architect-worker-row').hover();
    await expect.poll(caretColor).not.toBe(caretIdle);
    expect(await settled(rowFill)).toBe(rowOpen);
    expect(await settled(fill)).toBe(open);
    await item.locator('.architect-worker-more').hover({ position: { x: 40, y: 10 } });
    expect(await settled(fill)).toBe(open);
    // Buttons inside a hovered item add no second fill.
    await item.getByRole('button', { name: 'Open transcript', exact: true }).hover();
    expect(await item.getByRole('button', { name: 'Open transcript', exact: true }).evaluate(button => getComputedStyle(button).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await page.mouse.move(2, 2);
    await page.keyboard.press('Shift');
    await panel(page).locator('.architect-worker-item[data-worker-id="review"] .architect-worker-row').focus();
    const caret = panel(page).locator('.architect-worker-item[data-worker-id="review"] .architect-worker-expand');
    // One focus indicator: the row's ring; the caret only brightens (no ring of its own).
    const idle = await panel(page).locator('.architect-worker-item[data-worker-id="build"] .architect-worker-expand').evaluate(element => getComputedStyle(element).color);
    await expect.poll(() => caret.evaluate(element => getComputedStyle(element).color)).not.toBe(idle);
    expect(await caret.evaluate(element => getComputedStyle(element).boxShadow)).toBe('none');
  });
});

test.describe('compact workers order', () => {
  const ids = (page: Page) => panel(page).locator('.architect-worker-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.workerId));
  test('rows hold still under the pointer and keyboard focus, and reorder once the reader leaves', async ({ page }) => {
    const start = team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued' })] });
    await installArchitect(page, { 'session-2': start });
    await openWorkers(page).click();
    await expect.poll(() => ids(page)).toEqual(['build', 'review']);
    // The pointer rests on the list: build finishing does not move it under the pointer.
    await row(page, 'review').hover();
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 2, workers: [worker('build', { status: 'completed' }), worker('review', { status: 'queued' })] });
    await expect(statusOf(row(page, 'build'))).toHaveText('Done');
    expect(await ids(page)).toEqual(['build', 'review']);
    await page.mouse.move(2, 2);
    await expect.poll(() => ids(page)).toEqual(['review', 'build']);
    // Keyboard focus holds the order too, and keeps its row.
    await row(page, 'build').focus();
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 3, workers: [worker('build', { status: 'completed' }), worker('review', { status: 'failed' })] });
    await expect(statusOf(row(page, 'review'))).toHaveText('Failed');
    // Build works again and review stops: working now comes before stopped, but the focused order holds.
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 4, workers: [worker('build', { status: 'running' }), worker('review', { status: 'stopped' })] });
    await expect(statusOf(row(page, 'build'))).toHaveText('Working');
    expect(await ids(page)).toEqual(['review', 'build']);
    await expect(row(page, 'build')).toBeFocused();
    await panel(page).locator('.architect-close').focus();
    await expect.poll(() => ids(page)).toEqual(['build', 'review']);
    // A sub-worker arriving while the order is held joins its parent, not the end (unheld, review would lead).
    await row(page, 'review').hover();
    const child = { ...worker('build', { status: 'running' }), id: 'build-child', name: 'Build helper', sessionId: 'worker-build-child', parentWorker: 'build' };
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 5, workers: [worker('build', { status: 'completed' }), worker('review', { status: 'failed' }), child] });
    await expect(row(page, 'build-child')).toBeAttached();
    expect(await ids(page)).toEqual(['build', 'build-child', 'review']);
  });
});

test.describe('workers full access note', () => {
  // Workers always run with full access and auto-approval; the panel says so while the lead is in another mode.
  async function pickMode(page: Page, name: string): Promise<void> {
    await page.locator('#mode-picker-trigger').click();
    await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name, exact: true }).click();
    await expect(page.locator('#mode-picker-trigger')).toHaveText(name);
    if (!(await panel(page).isVisible())) await page.locator('#agents-toggle').click();
    await expect(panel(page)).toBeVisible();
  }
  test('shows one quiet line for a lead in Standard (ask), and none in Full access', async ({ page }) => {
    await openShowcase(page);
    await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'ask');
    const note = panel(page).locator('.architect-panel-access');
    // While an (older host's) approval waits on the user, the line would contradict it: hidden until it is answered.
    await expect(statusOf(compactItem(page, 'styles'))).toHaveText('Needs you: approval');
    await expect(note).toBeHidden();
    // Answered in the worker's transcript (the one place for it), the line comes back.
    await compactItem(page, 'styles').locator('.architect-worker-row').click();
    await panel(page).locator('.architect-worker-approvals .approval-card').getByRole('button', { name: 'Approve', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Back to workers' }).click();
    await expect(note).toBeVisible();
    // One visible line; the deploy and scheduling exception is the tip and accessible name of its leading info button
    // (shown on hover and keyboard focus; also on the setup screen).
    const text = note.locator('.architect-panel-access-text');
    expect(await text.evaluate(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''))).toBe('Workers have full access; only the lead needs approval.');
    const exception = "Approvals are granted under the lead's authority, whatever its own mode. Deploy and scheduling tools are the exception: they are declined, and the worker hands them back to the lead.";
    const mark = note.getByRole('button', { name: `Deploy and scheduling exception: ${exception}`, exact: true });
    await expect(mark).toHaveAttribute('data-tip', exception);
    await mark.hover();
    await expect(page.locator('.tip-bubble')).toHaveText(exception);
    await expect(note).not.toHaveAttribute('title', /.+/);
    await expect(mark).toHaveClass(/architect-panel-access-icon/);
    await expect(mark).toHaveAttribute('data-state-tone', 'worker-idle');
    // One line at the default width (two would be ~38px with the note's bottom padding).
    expect(await text.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(20);
    // In a narrow panel it wraps rather than being cut.
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '220px'; });
    expect(await text.evaluate(span => getComputedStyle(span).textOverflow !== 'ellipsis' && span.scrollWidth <= span.clientWidth + 1)).toBe(true);
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = ''; });
  });
  test('follows the lead\'s mode: hidden in Full access, back in Standard', async ({ page }) => {
    // A settled team, so the lead's mode picker is free to change.
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [worker('build', { status: 'completed' })] }) });
    await openWorkers(page).click();
    const note = panel(page).locator('.architect-panel-access');
    await pickMode(page, 'Full access');
    await expect(note).toBeHidden();
    // A Plan (Codex: Read only) or Standard lead cannot edit freely itself: the note says its workers still can.
    await pickMode(page, 'Read only');
    await expect(note.locator('.architect-panel-access-text')).toContainText('Workers can edit files, though this lead is read-only.');
    expect(await note.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(28);
    await pickMode(page, 'Standard');
    await expect(note).toBeVisible();
    await expect(note.locator('.architect-panel-access-text')).toContainText('Workers have full access; only the lead needs approval.');
    // Like the tally, it belongs to the list: hidden while a worker's transcript is open.
    await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-detail')).toBeVisible();
    await expect(note).toBeHidden();
    // The transcript's sticky header is matched by scroll padding, so a control focused at the top is not hidden under it.
    await expect.poll(() => panel(page).locator('.architect-panel-scroll').evaluate(element => {
      const meta = element.querySelector<HTMLElement>('.architect-worker-meta')!;
      return meta.offsetHeight > 0 && parseFloat(getComputedStyle(element).scrollPaddingTop) === meta.offsetHeight;
    })).toBe(true);
    await panel(page).getByRole('button', { name: 'Back to workers' }).click();
    await expect(note).toBeVisible();
    // Dismissed, it stays away for this team for the session (reopening the panel too).
    const dismiss = note.getByRole('button', { name: 'Dismiss the full-access note' });
    expect(await dismiss.evaluate(element => { const box = element.getBoundingClientRect(); return box.width >= 24 && box.height >= 24; })).toBe(true);
    await dismiss.click();
    await expect(note).toBeHidden();
    // Focus moves on to the first worker row, not up to Close.
    await expect(row(page, 'build')).toBeFocused();
    await panel(page).getByRole('button', { name: 'Close workers' }).click();
    await openWorkers(page).click();
    await expect(panel(page).locator('.architect-panel-access')).toBeHidden();
  });
});

test.describe('compact workers focus on filled buttons', () => {
  test('a row\'s inset focus ring clears its elapsed time', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    const target = row(page, 'build');
    await page.keyboard.press('Shift');
    await target.focus();
    const box = await target.evaluate(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const elapsed = element.querySelector('.architect-worker-elapsed')!.getBoundingClientRect();
      // The ring is drawn inside the row: its inner edge sits offset + width in from the row's right edge.
      const ringInner = rect.right + parseFloat(style.outlineOffset) - parseFloat(style.outlineWidth);
      return { visible: element.matches(':focus-visible'), height: (element as HTMLElement).offsetHeight, clear: elapsed.width === 0 || elapsed.right <= ringInner };
    });
    expect(box).toEqual({ visible: true, height: 38, clear: true });
  });
  test('the progress track keeps an outline in forced colors', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowcase(page);
    expect(await panel(page).locator('.architect-progress').evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }))).toEqual({ style: 'solid', width: '1px' });
  });
  test('Approve (a filled button) gets an outer focus ring', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    await row(page, 'build').click();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'ring-build', text: 'Run the worker verification command?' }));
    const card = panel(page).locator('.architect-worker-approvals .approval-card');
    const approve = card.getByRole('button', { name: 'Approve', exact: true });
    await page.keyboard.press('Shift');
    await approve.focus();
    expect(await approve.evaluate(button => ({ visible: button.matches(':focus-visible'), offset: getComputedStyle(button).outlineOffset, style: getComputedStyle(button).outlineStyle }))).toEqual({ visible: true, offset: '2px', style: 'solid' });
    const deny = card.getByRole('button', { name: 'Deny', exact: true });
    await deny.focus();
    expect(await deny.evaluate(button => getComputedStyle(button).outlineOffset)).toBe('-2px');
  });
});

test.describe('compact workers round 9', () => {
  test('needs-you and failed changes are announced with a transcript open', async ({ page }) => {
    const start = team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'running' })] });
    await installArchitect(page, { 'session-2': start });
    await openWorkers(page).click();
    await row(page, 'build').click();
    await expect(panel(page).locator('.architect-worker-detail')).toBeVisible();
    await expect(panel(page).locator('.architect-panel-tally')).toBeHidden();
    const live = panel(page).locator('.architect-panel-live');
    // The live region sits outside anything a transcript hides.
    expect(await live.evaluate(element => !element.closest('[hidden]') && element.parentElement!.classList.contains('architect-panel'))).toBe(true);
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 2, workers: [worker('build', { status: 'running' }), worker('review', { status: 'failed' })] });
    await expect(live).toHaveText('1 failed · 1 working');
  });
  test('a failed answer shows a plain sentence and logs the details', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    const logged: string[] = [];
    page.on('console', message => { if (message.type() === 'error') logged.push(message.text()); });
    await page.evaluate(() => { (window as any).__architectTest.failures.respond_approval = 'worker run not found'; });
    await row(page, 'build').click();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'gone-build', text: 'Run the worker verification command?' }));
    const approval = panel(page).locator('.architect-worker-approvals .approval-card');
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(approval.locator('small[role="alert"]')).toHaveText('Couldn’t send your answer. The worker may have stopped.');
    await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await expect.poll(() => logged.some(text => text.includes('Could not answer the worker approval'))).toBe(true);
  });
  test('a sub-worker keeps its indent outside its hover fill', async ({ page }) => {
    const child = { ...worker('build', { status: 'running' }), id: 'build-child', name: 'Build helper', sessionId: 'worker-build-child', parentWorker: 'build' };
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' }), child] }) });
    await openWorkers(page).click();
    const parent = panel(page).locator('.architect-worker-item[data-worker-id="build"]'), sub = panel(page).locator('.architect-worker-item[data-worker-id="build-child"]');
    await sub.hover();
    const [parentLeft, subLeft] = await Promise.all([parent.evaluate(element => element.getBoundingClientRect().left), sub.evaluate(element => element.getBoundingClientRect().left)]);
    expect(Math.round(subLeft - parentLeft)).toBe(22);
  });
  test('a worker approval notifies only while that worker\'s run is active', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'completed' }), worker('review', { status: 'running' })] }) });
    // A cold Vite dev server can take longer than the default 5 s to show the Agents toggle.
    await expect(openWorkers(page)).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'late-build', text: 'Run the worker verification command?' }));
    await page.waitForTimeout(300);
    await expect(page.locator('#toast')).not.toContainText('A worker needs your approval');
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval', requestId: 'live-review', text: 'Run the worker verification command?' }));
    await expect(page.locator('#toast')).toContainText('A worker needs your approval');
  });
  test('notifications share the panel\'s definition of an active worker (queued counts; unknown counts)', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued' })] }) });
    // A cold Vite dev server can take longer than the default 5 s to show the Agents toggle.
    await expect(openWorkers(page)).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval', requestId: 'queued-review', text: 'Run the worker verification command?' }));
    await expect(page.locator('#toast')).toContainText('A worker needs your approval');
  });
});

test.describe('compact workers round 13', () => {
  test('working and failed rows give their name the room a status word would take', async ({ page }) => {
    const name = 'Rewrite the search index loader so it streams partial results quickly';
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', name }), worker('review', { status: 'stopped', name }), { ...worker('review', { status: 'failed', name }), id: 'fix', sessionId: 'worker-fix' }] }) });
    await openWorkers(page).click();
    const width = (id: string) => panel(page).locator(`.architect-worker-item[data-worker-id="${id}"] .architect-worker-copy strong`).evaluate(element => element.clientWidth);
    // Same name: working and failed rows have no status word (the glyph says it), so they show clearly more of the
    // name than the stopped one.
    expect(await width('build')).toBeGreaterThan(await width('review') + 20);
    expect(await width('fix')).toBeGreaterThan(await width('review') + 20);
    await expect(statusOf(row(page, 'build'))).toHaveText('Working');
    await expect(statusOf(row(page, 'fix'))).toHaveText('Failed');
    await expect(row(page, 'fix').locator('.architect-worker-state:not(.sr-only)')).toHaveCount(0);
    await expect(row(page, 'review').locator('.architect-worker-state:not(.sr-only) [aria-hidden="true"]')).toHaveText('Stopped');
  });
  test('done and failed marks are cut out of the disc, not painted in the panel colour', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'completed' }), worker('review', { status: 'failed' })] }) });
    await openWorkers(page).click();
    for (const id of ['build', 'review']) {
      const glyph = row(page, id).locator('.architect-worker-glyph');
      expect(await glyph.innerHTML()).not.toContain('var(--panel)');
      await expect(glyph.locator('path[fill-rule="evenodd"]')).toHaveCount(1);
    }
  });
  test('a settled or skipped worker never shows a request', async ({ page }) => {
    const start = team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'completed' })] });
    await installArchitect(page, { 'session-2': start });
    await openWorkers(page).click();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-review', kind: 'approval', requestId: 'stale-review', text: 'Run the worker verification command?' }));
    await expect(statusOf(row(page, 'review'))).toHaveText('Done');
    await expect(panel(page).locator('.architect-panel-tally-readable')).toHaveText('1 working · 1 done');
    await row(page, 'review').click();
    await expect(panel(page).locator('.architect-worker-detail')).toBeVisible();
    await expect(panel(page).locator('.architect-worker-approvals .approval-card')).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Back to workers' }).click();
    // Skipped (abandoned) too, even while its status still says running.
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 2, workers: [worker('build', { status: 'running', abandoned: true }), worker('review', { status: 'completed' })] });
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'skipped-build', text: 'Run the worker verification command?' }));
    await expect(statusOf(row(page, 'build'))).toHaveText('Skipped');
    await expect(panel(page).locator('.architect-tally-asking')).toHaveCount(0);
  });
});

test.describe('compact workers round 14', () => {
  test('an adjusted effort is marked, with its note in the title and "adjusted" for screen readers', async ({ page }) => {
    await openShowcase(page);
    const adjusted = compactItem(page, 'index').locator('.architect-worker-effort');
    await expect(adjusted).toHaveAttribute('data-adjusted', '');
    await expect(adjusted).toHaveAttribute('title', 'Reasoning effort: medium. Asked for high effort; this model ran at medium.');
    await expect(adjusted.locator('.sr-only')).toHaveText('reasoning effort medium, adjusted');
    // On a failed row the reason wins the space: the effort label is off screen (kept for screen readers) and the
    // title and details say it instead. Rows that did not fail say it in words (round 18).
    await expect(adjusted.locator('[aria-hidden="true"]')).toHaveText('medium');
    expect(await adjusted.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(compactItem(page, 'index').locator('.architect-worker-adjusted')).toBeHidden();
    const plain = compactItem(page, 'search').locator('.architect-worker-effort');
    await expect(plain).not.toHaveAttribute('data-adjusted');
    await expect(plain.locator('.sr-only')).toHaveText('reasoning effort high');
  });
  test('tally buttons are at least 24px tall, and the progress bar is legible', async ({ page }) => {
    await openShowcase(page);
    // Measured once the panel's open spring has settled (it scales the bar while it runs).
    await panelSettled(page);
    // Narrow enough that the line ends with "+N more" (at the default width every count fits).
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '300px'; });
    const tally = panel(page).locator('.architect-panel-tally-text');
    for (const button of [tally.locator('.architect-tally-asking'), tally.locator('.architect-tally-more')]) {
      await expect(button).toBeVisible();
      // 24px in CSS; the drawn box may be a hair under while the panel's open spring settles.
      expect(await button.evaluate(element => parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(24);
      expect(Math.round(await button.evaluate(element => element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(24);
    }
    const bar = await panel(page).locator('.architect-progress').evaluate(element => element.getBoundingClientRect());
    expect(bar.width).toBeGreaterThanOrEqual(40); expect(bar.height).toBeGreaterThanOrEqual(4);
    expect(await tally.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
});

test.describe('compact workers round 17', () => {
  test('the row\'s computed description brings back its meta line: model, adjusted effort, failure reason', async ({ page }) => {
    await openShowcase(page);
    // The aria-label names the row; the description (computed, not just DOM) carries what the label replaces.
    await expect(compactItem(page, 'search').locator('.architect-worker-row')).toHaveAccessibleDescription(/^GPT-6-Astra reasoning effort high Details hidden$/);
    const failed = compactItem(page, 'index').locator('.architect-worker-row');
    await expect(failed).toHaveAccessibleDescription(/^The sample build step failed: index\.ts has a type error\. reasoning effort medium, adjusted attempt 2 Details hidden/);
    // At the default width the reason wins the space on its one line: no harness logo beside it, and its effort and
    // attempt labels are off screen (still in the description above, the title and the details below).
    const reason = compactItem(page, 'index').locator('.architect-worker-meta-line small');
    const lines = await reason.evaluate(element => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)));
    expect(lines).toBe(1);
    expect(await compactItem(page, 'index').locator('.architect-worker-row').evaluate(row => row.getBoundingClientRect().height)).toBeLessThanOrEqual(38);
    await expect(compactItem(page, 'index').locator('.architect-worker-meta-line .architect-worker-logo')).toHaveCount(0);
    // The attempt and effort labels are off screen: a bare effort word after the error would read like a severity.
    for (const label of ['attempt', 'effort']) expect(await compactItem(page, 'index').locator(`.architect-worker-meta-line .architect-worker-${label}`).evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(compactItem(page, 'index').locator('.architect-worker-row')).toHaveAttribute('title', /Effort: medium \(adjusted\) · Attempt 2$/);
    // Meaningful text shows: at least 30 characters are visible.
    const visible = await reason.evaluate(element => {
      const text = element.firstChild!, box = element.getBoundingClientRect(), range = document.createRange();
      let count = 0;
      for (let at = 0; at < text.textContent!.length; at++) { range.setStart(text, at); range.setEnd(text, at + 1); const rect = range.getBoundingClientRect(); if (rect.bottom <= box.bottom + 1 && rect.right <= box.right + 1) count++; }
      return count;
    });
    expect(visible).toBeGreaterThanOrEqual(30);
    // Open, the meta line trades the cut reason (now whole in the details) for the model, effort and attempt.
    await compactItem(page, 'index').locator('.architect-worker-expand').click();
    // The same words as the closed row's labels: "(adjusted)" and "×2", with "attempt 2" for screen readers.
    await expect.poll(() => drawnText(compactItem(page, 'index').locator('.architect-worker-meta-line small'))).toMatch(/^Claude Sonnet .* · medium \(adjusted\) · ×2$/);
    await expect(compactItem(page, 'index').locator('.architect-worker-meta-line small .sr-only')).toHaveText('attempt 2');
    await expect(compactItem(page, 'index').locator('.architect-worker-more .architect-worker-error')).toContainText('The sample build step failed');
    // The facts already say the effort and attempt: no labels repeat them after the meta.
    await expect(compactItem(page, 'index').locator('.architect-worker-meta-line :is(.architect-worker-effort, .architect-worker-attempt)')).toHaveCount(0);
    // Rows that did not fail keep the words.
    await expect(compactItem(page, 'styles').locator('.architect-worker-effort [aria-hidden="true"]')).toHaveText('x-high');
  });
  test('a failed row says why on its meta line; its full error is in the title and details', async ({ page }) => {
    const error = 'The build step failed: index.ts has a type error.\nSee the full log for the stack trace.';
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'failed', error })] }) });
    await openWorkers(page).click();
    const item = panel(page).locator('.architect-worker-item[data-worker-id="review"]');
    const reason = item.locator('.architect-worker-meta-line small');
    await expect(reason).toHaveText('The build step failed: index.ts has a type error.');
    await expect(reason).toHaveAttribute('title', error);
    await item.locator('.architect-worker-expand').click();
    const details = item.locator('.architect-worker-error');
    await expect(details).toContainText('See the full log for the stack trace.');
    // The live region announces failures; the error paragraph is not a status region of its own.
    await expect(details).not.toHaveAttribute('role');
    // Opened, the sticky header says why in the danger tone, wrapped and clamped to three lines, full text in its title.
    await item.locator('.architect-worker-row').click();
    const head = panel(page).locator('.architect-worker-meta .architect-worker-error');
    await expect(head).toHaveText(error);
    await expect(head).toHaveAttribute('title', error);
    const style = await head.evaluate(element => { const css = getComputedStyle(element); const probe = document.createElement('i'); probe.style.color = 'var(--ds-danger)'; element.append(probe); const danger = getComputedStyle(probe).color; probe.remove(); return { color: css.color, danger, wrap: css.whiteSpace, clamp: css.webkitLineClamp, lineHeight: parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2, height: element.getBoundingClientRect().height }; });
    expect(style.color).toBe(style.danger);
    expect(style.wrap).toBe('normal');
    expect(style.clamp).toBe('3');
    expect(style.height).toBeGreaterThan(style.lineHeight * 1.5);
  });
  test('the panel error uses the contrast-adjusted danger tone', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'failed', error: 'The lead could not start.', workers: [worker('build', { status: 'running' })] }) });
    await openWorkers(page).click();
    await expect(panel(page).locator('.architect-panel-error')).toHaveText('The lead could not start.');
    const tones = await panel(page).locator('.architect-panel-error').evaluate(element => { const probe = document.createElement('i'); probe.style.color = 'var(--ds-danger)'; element.parentElement!.append(probe); const danger = getComputedStyle(probe).color; probe.remove(); return { color: getComputedStyle(element).color, danger }; });
    expect(tones.color).toBe(tones.danger);
  });
  test('a finished worker\'s elapsed time stays put when it is updated later', async ({ page }) => {
    const start = team('session-2', { workers: [worker('build', { status: 'completed', createdAt: 1_800_000_000_000, updatedAt: 1_800_006_300_000 })] });
    await installArchitect(page, { 'session-2': start });
    await openWorkers(page).click();
    const elapsed = row(page, 'build').locator('.architect-worker-elapsed');
    await expect(elapsed).toHaveText('2h');
    await expect(elapsed).toHaveAttribute('title', 'ran 1 hour 45 minutes');
    // A later snapshot (a summary arriving hours afterwards) does not make the run look longer.
    await page.evaluate(snapshot => (window as any).__architectTest.publish(snapshot), { ...start, revision: 2, workers: [worker('build', { status: 'completed', summary: 'All done.', createdAt: 1_800_000_000_000, updatedAt: 1_800_014_400_000 })] });
    await row(page, 'build').locator('xpath=..').locator('.architect-worker-expand').click();
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="build"] .architect-worker-more')).toContainText('All done.');
    await expect(elapsed).toHaveText('2h');
    await expect(elapsed).toHaveAttribute('title', 'ran 1 hour 45 minutes');
  });
});

test.describe('compact workers round 18', () => {
  test('a working row with an adjusted effort says it in words', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', note: 'Asked for x-high; this model ran at high.' })] }) });
    await openWorkers(page).click();
    const adjusted = row(page, 'build').locator('.architect-worker-effort');
    await expect(adjusted.locator('[aria-hidden="true"]')).toHaveText('high');
    await expect(row(page, 'build').locator('.architect-worker-adjusted')).toHaveText('(adjusted)');
    await expect(row(page, 'build').locator('.architect-worker-adjusted')).toHaveAttribute('title', 'Reasoning effort: high. Asked for x-high; this model ran at high.');
    await expect(row(page, 'build')).toHaveAccessibleDescription(/reasoning effort high, adjusted/);
  });
  test('a narrow row cuts "(adjusted)" before the model name', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', model: 'claude-sonnet-4-5', reasoningEffort: 'high', note: 'Asked for x-high; this model ran at high.' })] }) });
    await openWorkers(page).click();
    const meta = row(page, 'build').locator('.architect-worker-meta-line');
    const widths = () => meta.evaluate(line => {
      const model = line.querySelector('small')!, marker = line.querySelector('.architect-worker-adjusted') as HTMLElement;
      return { modelCut: model.scrollWidth > model.clientWidth, marker: marker.getBoundingClientRect().width, markerCut: marker.scrollWidth > marker.clientWidth };
    });
    // Wide: both whole.
    await expect.poll(widths).toEqual({ modelCut: false, marker: expect.any(Number), markerCut: false });
    // Narrower: the marker ellipsizes while the model name is still whole.
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '290px'; });
    await expect.poll(async () => { const now = await widths(); return !now.modelCut && now.markerCut && now.marker > 0; }).toBe(true);
    // Narrowest: the marker is gone before the name gives way; the effort word stays.
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '220px'; });
    await expect.poll(async () => { const now = await widths(); return now.modelCut && now.marker === 0; }).toBe(true);
    await expect(row(page, 'build').locator('.architect-worker-effort [aria-hidden="true"]')).toBeVisible();
  });
});

test.describe('compact workers round 19', () => {
  test('a long assignment scrolls in a labelled region with a hint, by keyboard too', async ({ page }) => {
    const assignment = Array.from({ length: 30 }, (_, line) => `Step ${line + 1}: check the search index, then report what changed.`).join('\n');
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', assignment }), worker('review', { status: 'running' })] }) });
    await openWorkers(page).click();
    const item = panel(page).locator('.architect-worker-item[data-worker-id="build"]');
    await item.locator('.architect-worker-expand').click();
    const box = item.locator('.architect-worker-more-text[data-scroll-label="Assignment"]');
    await expect(box).toHaveRole('region');
    await expect(box).toHaveAccessibleName('Assignment (scroll for more)');
    await expect(box).toHaveAttribute('tabindex', '0');
    await expect(item.locator('.architect-worker-scroll-hint')).toBeVisible();
    await expect(item.locator('.architect-worker-scroll-hint')).toHaveText('Scroll for more');
    await box.focus();
    await page.keyboard.press('End');
    await expect.poll(() => box.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    // A short one is plain text: no region, no Tab stop, no hint.
    const other = panel(page).locator('.architect-worker-item[data-worker-id="review"]');
    await other.locator('.architect-worker-expand').click();
    const short = other.locator('.architect-worker-more-text[data-scroll-label="Assignment"]');
    await expect(short).not.toHaveAttribute('role');
    await expect(short).not.toHaveAttribute('tabindex');
    await expect(other.locator('.architect-worker-scroll-hint')).toBeHidden();
  });
});

test.describe('compact workers round 22', () => {
  test('the setup note\'s info mark stays inline with its text', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [worker('build', { status: 'completed' })] }) });
    await openWorkers(page).click();
    await panel(page).getByRole('button', { name: 'View team setup' }).click();
    const note = setup(page).locator('.architect-workspace-note', { hasText: 'Next architect turn' });
    await expect(note).toBeVisible();
    const layout = await note.evaluate(element => {
      const mark = element.querySelector('.info-mark') as HTMLElement, box = element.getBoundingClientRect(), markBox = mark.getBoundingClientRect();
      return { display: getComputedStyle(mark).display, sameLine: markBox.top < box.top + parseFloat(getComputedStyle(element).lineHeight) };
    });
    expect(layout).toEqual({ display: 'inline-flex', sameLine: true });
  });
  test('a follow-up run measures its elapsed time from its own start', async ({ page }) => {
    const now = Date.now();
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', createdAt: now - 2 * 3_600_000, startedAt: now - 5 * 60_000 })] }) });
    await openWorkers(page).click();
    await expect(row(page, 'build').locator('.architect-worker-elapsed')).toHaveText(/^[56]m$/);
  });
  test('row keys show only while a row has keyboard focus; queued and failed rows drop the logo', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running' }), worker('review', { status: 'queued', dependsOn: ['build'] }), { ...worker('review', { status: 'failed', error: 'The build step failed.' }), id: 'fix', sessionId: 'worker-fix' }] }) });
    await openWorkers(page).click();
    const hint = panel(page).locator('.architect-worker-keyhint');
    await expect(hint).toBeHidden();
    // Pointer focus: no hint.
    await panel(page).locator('.architect-panel-summary').click();
    await row(page, 'build').focus();
    await expect(hint).toBeHidden();
    // Keyboard focus: the hint shows.
    await page.keyboard.press('ArrowDown');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('↑↓ move · → shows details · ← hides · Enter opens');
    // It fits the default 400px panel without being cut.
    expect(await hint.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(hint).toHaveAttribute('aria-hidden', 'true');
    // A queue reason and a failure reason stand without the harness logo.
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="review"] .architect-worker-logo')).toHaveCount(0);
    await expect(panel(page).locator('.architect-worker-item[data-worker-id="fix"] .architect-worker-logo')).toHaveCount(0);
    const color = (id: string) => panel(page).locator(`.architect-worker-item[data-worker-id="${id}"] .architect-worker-meta-line small`).evaluate(element => getComputedStyle(element).color);
    // One tone for the whole meta line (state tones stay on the leading icon).
    expect(await color('fix')).toBe(await color('build'));
  });
});

test.describe('compact workers round 23', () => {
  test('a council reviewer that finished below target has its own mark, not the queued ring or the done check', async ({ page }) => {
    const seat = (id: string, lens: string, score: number, createdAt: number) => ({ ...worker('review', { status: 'completed', council: { round: 1, lens, score } }), id, sessionId: `worker-${id}`, createdAt });
    await installArchitect(page, { 'session-2': team('session-2', {
      config: { ...config(), council: { target: 9.5, maxRounds: 3, reviewers: 2 } },
      // An earlier cycle's reviewers are rows (the current cycle's sit in the Council scorecard).
      councilSince: 1_800_000_000_010, councilStatus: { state: 'waiting', round: 0, lowest: null, target: 9.5, stale: false },
      workers: [seat('low', 'Correctness', 8, 1_800_000_000_000), seat('high', 'Security', 9.5, 1_800_000_000_002), worker('build', { status: 'queued' })],
    }) });
    await openWorkers(page).click();
    const glyph = (id: string) => compactItem(page, id).locator('.architect-worker-glyph');
    await expect(compactItem(page, 'low').locator('.architect-worker-state:not(.sr-only) > [aria-hidden="true"]')).toHaveText('Below');
    // A verdict, not a request: muted and regular, unlike the needs-you words.
    await expect(compactItem(page, 'low').locator('.architect-worker-state:not(.sr-only)')).not.toHaveClass(/architect-worker-state-attention/);
    await expect(glyph('low')).toHaveAttribute('data-glyph', 'below');
    await expect(glyph('low')).toHaveAttribute('data-state-tone', 'worker-idle');
    await expect(glyph('high')).toHaveAttribute('data-glyph', 'completed');
    // Unlike the dashed ring of work that has not started, and the green check of a passing reviewer.
    const markup = (id: string) => glyph(id).innerHTML();
    expect(await markup('low')).not.toBe(await markup('build'));
    expect(await markup('low')).not.toBe(await markup('high'));
  });
  test('a long assignment fades until scrolled to its end, ends on text, and keeps its hint right under it', async ({ page }) => {
    const assignment = Array.from({ length: 30 }, (_, line) => `Step ${line + 1}: check the search index.`).join('\n') + '\n\n\n';
    await installArchitect(page, { 'session-2': team('session-2', { workers: [worker('build', { status: 'running', assignment })] }) });
    await openWorkers(page).click();
    const item = panel(page).locator('.architect-worker-item[data-worker-id="build"]');
    await item.locator('.architect-worker-expand').click();
    const box = item.locator('.architect-worker-more-text[data-scroll-label="Assignment"]');
    expect(await box.evaluate(element => element.textContent!.endsWith('Step 30: check the search index.'))).toBe(true);
    await expect(box).toHaveAttribute('data-overflowing', '');
    expect(await box.evaluate(element => getComputedStyle(element).maskImage || getComputedStyle(element).webkitMaskImage)).not.toBe('none');
    const gap = await item.evaluate(element => element.querySelector('.architect-worker-scroll-hint')!.getBoundingClientRect().top - element.querySelector('.architect-worker-more-text')!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0); expect(gap).toBeLessThanOrEqual(6);
    await box.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(box).toHaveAttribute('data-at-end', '');
    expect(await box.evaluate(element => getComputedStyle(element).maskImage || getComputedStyle(element).webkitMaskImage)).toBe('none');
  });
  test('an open failed row stays compact, and its transcript header uses the row\'s words with the effort', async ({ page }) => {
    await openShowcase(page);
    const failed = compactItem(page, 'index');
    await failed.locator('.architect-worker-expand').click();
    // Open, its meta line shows model · effort · attempt (no empty line), the full error is below, and the facts are
    // not repeated in the details.
    const metaLine = failed.locator('.architect-worker-meta-line small');
    await expect(metaLine).toBeVisible();
    // The whole meta line, as drawn: the effort once, the attempt not cut.
    await expect.poll(() => drawnText(failed.locator('.architect-worker-meta-line'))).toMatch(/^Claude Sonnet [^·]* · medium \(adjusted\) · ×2$/);
    expect(await metaLine.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(metaLine).toHaveAttribute('title', /^Claude Sonnet .* · medium \(adjusted\) · attempt 2\. Asked for high effort; this model ran at medium\.$/);
    await expect(failed.locator('.architect-worker-more .architect-worker-more-model')).toHaveCount(0);
    await expect(failed.locator('.architect-worker-more .architect-worker-error')).toBeVisible();
    // Folded again, the reason returns.
    await failed.locator('.architect-worker-expand').click();
    await expect(metaLine).toHaveText(/^The sample build step failed/);
    await failed.locator('.architect-worker-expand').click();
    // Bounded: the row, the full error (two lines here), the assignment capped at three lines, the footer.
    expect(await failed.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(250);
    // Its transcript header: model, effort (adjusted) and the row's own status word.
    await failed.locator('.architect-worker-row').click();
    await expect(panel(page).locator('.architect-worker-meta small').first()).toHaveText(/^Claude Sonnet .* · medium \(adjusted\) · Failed$/);
  });
  test('a narrow tally never cuts its "+N more" button', async ({ page }) => {
    await openShowcase(page);
    await panelSettled(page);
    const tally = panel(page).locator('.architect-panel-tally-text');
    // Swept across widths (300, 376, 436 and 515px once cut it): whenever the button is there it is whole, and the
    // line is never ellipsized.
    test.setTimeout(60_000);
    // The once-bad widths plus a coarse sweep (a 2px sweep took longer than the default timeout under load).
    const widths = [...new Set([300, 376, 436, 515, ...Array.from({ length: 28 }, (_, index) => 250 + index * 10)])];
    for (const width of widths) {
      await page.evaluate(px => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = `${px}px`; }, width);
      await expect.poll(() => tally.evaluate(element => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const button = element.querySelector('.architect-tally-more')?.getBoundingClientRect(), box = element.getBoundingClientRect();
        resolve(element.scrollWidth <= element.clientWidth && (!button || (button.width > 0 && button.left >= box.left && button.right <= box.right)));
      })))), { message: `width ${width}px` }).toBe(true);
      expect(tallySum(await visibleTally(tally)), `width ${width}px`).toBe(6);
    }
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '300px'; });
    await expect(tally.locator('.architect-tally-more')).toBeVisible();
    // Words first, glyphs as the fallback: a wide panel shows every bucket in words; narrower (the default 400px), the
    // minor buckets (queued, stopped) fold into "+N more" while failed, working and done keep their words; narrower
    // still, those go compact ("needs you" keeps its words), then are cut.
    const shape = () => tally.evaluate(element => ({ worded: element.querySelectorAll('.architect-tally-count[data-worded]').length, counts: element.querySelectorAll('.architect-tally-count').length, more: Boolean(element.querySelector('.architect-tally-more')) }));
    await page.evaluate(() => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = '400px'; });
    await expect.poll(shape).toEqual({ worded: 3, counts: 3, more: true });
    expect(await visibleTally(tally)).toEqual(['1 needs you', '1 failed', '1 working', '1 done', '2 more: 1 queued, 1 stopped']);
    const seen = new Set<string>();
    for (const width of [...widths, 560, 600, 640]) {
      await page.evaluate(px => { (document.querySelector('.agents-flyout') as HTMLElement).style.width = `${px}px`; }, width);
      await tally.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const now = await shape();
      seen.add(`${now.worded ? 'worded' : 'compact'}${now.more ? '+more' : ''}`);
      // Never a mix: the shown counts are all worded or all compact.
      expect(now.worded === 0 || now.worded === now.counts, `width ${width}px`).toBe(true);
      if (now.worded && !now.more) expect(now, `width ${width}px`).toEqual({ worded: 5, counts: 5, more: false });
    }
    expect([...seen].sort()).toEqual(['compact+more', 'worded', 'worded+more']);
    await expect(tally.locator('.architect-tally-asking')).toHaveText('1 needs you');
  });
  test('the keyboard hint sits after the rows, in view for a lower row, and never hides the tally', async ({ page }) => {
    await openShowcase(page);
    const hint = panel(page).locator('.architect-worker-keyhint');
    const tally = panel(page).locator('.architect-panel-tally-text');
    // Directly after the rows (before Team messages), not over the tally line.
    expect(await hint.evaluate(element => element.closest('.architect-panel-scroll') !== null && element.previousElementSibling?.matches('.architect-worker-list') && (element.nextElementSibling?.matches('.team-messages') ?? true))).toBe(true);
    await expect(panel(page).locator('.architect-worker-keyhint + .team-messages')).toHaveCount(1);
    // Hidden, it takes no space.
    await expect(hint).toHaveCSS('display', 'none');
    // Measure once the panel's open spring has settled.
    await panelSettled(page);
    const tallyBox = await panel(page).locator('.architect-panel-tally').boundingBox();
    const listTop = await panel(page).locator('.architect-worker-list').boundingBox();
    await page.keyboard.press('Shift');
    await compactItem(page, 'styles').locator('.architect-worker-row').focus();
    await page.keyboard.press('End');
    await expect(compactItem(page, 'tests').locator('.architect-worker-row')).toBeFocused();
    await expect(hint).toBeVisible();
    await expect(hint).toBeInViewport();
    // The tally keeps every count (and "needs you") in view, and nothing above the hint moves.
    await expect(tally).toHaveCSS('visibility', 'visible');
    await expect(tally.locator('.architect-tally-asking')).toBeVisible();
    const tallyNow = (await panel(page).locator('.architect-panel-tally').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(tallyNow[key] - tallyBox![key])).toBeLessThanOrEqual(1);
    expect(Math.abs((await panel(page).locator('.architect-worker-list').boundingBox())!.y - listTop!.y)).toBeLessThanOrEqual(1);
    const lastRow = (await compactItem(page, 'tests').boundingBox())!, hintBox = (await hint.boundingBox())!;
    expect(hintBox.y).toBeGreaterThanOrEqual(lastRow.y + lastRow.height - 1);
  });
});
