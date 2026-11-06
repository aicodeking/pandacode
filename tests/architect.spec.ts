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
  await expect(openWorkers(page)).toBeVisible();
}

async function chooseModel(page: Page, button: string, provider: string, model: string): Promise<void> {
  await setup(page).getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness and model', exact: true }).getByRole('button', { name: `${provider} · ${model}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeHidden();
  await expect(setup(page)).toBeVisible();
  await expect(setup(page).getByRole('button', { name: button, exact: true })).toContainText(model);
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
    await expect(panel(page).locator('.architect-panel-count')).toHaveText('2 tasks');
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

  test('routes worker approvals to the worker session without changing its parent', async ({ page }) => {
    await installArchitect(page, { 'session-2': team('session-2', { status: 'waiting', workers: [worker('build', { status: 'waiting' })] }) });
    await seedHistory(page, 'session-2', 'build');
    await openWorkers(page).click(); await row(page, 'build').click();
    for (const [requestId, decision] of [['approve-build', 'Approve'], ['deny-build', 'Deny']] as const) {
      await page.evaluate(requestId => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId, text: 'Run the worker verification command?' }), requestId);
      const card = panel(page).locator('.architect-worker-approvals .approval-card');
      await expect(card).toContainText('Run the worker verification command?');
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
    await expect(openWorkers(page)).toBeVisible();
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'worker-build', kind: 'approval', requestId: 'ask-build', text: 'Run the worker verification command?' }));
    await expect(page.locator('#toast')).toContainText('A worker needs your input');
    await expect(openWorkers(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  });
});
