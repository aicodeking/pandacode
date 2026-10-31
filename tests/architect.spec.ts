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
  page.on('pageerror', error => runtimeErrors.push(error.message));
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
      if (fixture.failures[command]) throw new Error(fixture.failures[command]);
      if (command === 'get_messages' && Object.hasOwn(fixture.taskMessages, args.sessionId)) return { messages: structuredClone(fixture.taskMessages[args.sessionId]), hasOlder: false };
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
        localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ enabled: true, visibility: 35, pinned: 'mon-morning' }));
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
    const picker = page.getByRole('button', { name: 'Choose harness and model', exact: true });
    const lead = (await picker.textContent())!;
    await trigger(page).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('your selected model becomes the lead');
    await expect(tip).toContainText('picks a model for each worker on its own');
    await expect(tip).toContainText('use Sonnet 5.5 workers');
    await expect(trigger(page)).toHaveAttribute('aria-description', /picks a model for each worker/);
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
    await expect(transcript(page).locator('.team-progress-worker[data-worker-id="review"]')).toBeVisible();
    await expect(transcript(page).locator('[data-tool-key="tool:verify"]')).toBeAttached();
    expect(await order()).toEqual([0, 1, 2, 3, 4]);
  });

  test('keeps earlier workers above a resumed coordination turn', async ({ page }) => {
    const earlier = [worker('build', { status: 'completed', createdAt: 2500 }), worker('review', { status: 'completed', createdAt: 2500 })];
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: earlier }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build search and review it.', createdAt: 2000 },
      { id: 302, sessionId: 'session-2', role: 'assistant', content: 'Delegated to the workers.', createdAt: 3000 },
    ] as Message[] });
    await expect(transcript(page).locator('.team-progress-worker[data-worker-id="build"]')).toBeVisible();
    // Workers settled; PandaCode resumes the architect before the coordination message loads.
    await page.evaluate(() => (window as any).__architectTest.event({ sessionId: 'session-2', kind: 'tool', text: '', tool: { id: 'review-diff', name: 'Bash', status: 'running', input: 'git diff', output: '' } }));
    const later = transcript(page).locator('[data-tool-key="tool:review-diff"]');
    await expect(later).toBeAttached();
    expect(await transcript(page).locator('.team-progress-worker[data-worker-id="review"]').evaluate((row, tool) => Boolean(row.compareDocumentPosition(tool!) & Node.DOCUMENT_POSITION_FOLLOWING), await later.elementHandle())).toBe(true);
  });

  test('a long worker line never makes a narrow thread scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const long = worker('build', { status: 'completed', name: 'Attachment chips in sent messages plus drop paths for anything that cannot be attached '.repeat(3) });
    await installArchitect(page, { 'session-2': team('session-2', { status: 'completed', workers: [long] }) }, { 'session-2': [
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Build it.', createdAt: 2000 },
    ] as Message[] });
    const row = transcript(page).locator('.team-progress-worker[data-worker-id="build"]');
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
        const status = transcript(page).locator('.coordination-status[aria-label="Team status"]');
        await expect(status).toHaveCount(2);
        await expect(status.nth(0)).toBeVisible(); await expect(status.nth(0)).toContainText('Checking worker updates');
        await expect(status.nth(1)).toBeVisible(); await expect(status.nth(1)).toContainText('Reviewing worker results');
        expect(await status.evaluateAll(rows => rows.every(el => !el.closest('.user-message, .agent-message')))).toBe(true);
        await expect(status.locator('.provider-logo, .message-avatar')).toHaveCount(0);
        // The status sits in the conversation column, aligned with the replies.
        if (view === 'conversation') {
          const [line, reply] = [(await status.nth(0).boundingBox())!, (await transcript(page).locator('.agent-message .message-content').first().boundingBox())!];
          expect(Math.abs(line.x - reply.x)).toBeLessThan(2);
        }
        await expect(transcript(page).locator('.user-message')).toHaveCount(1);
        await expect(transcript(page).locator('.user-message .message-content')).toHaveText(userJson);
        const responses = transcript(page).locator('.agent-message .message-content');
        await expect(responses).toHaveCount(3);
        await expect(responses.nth(0)).toBeVisible(); await expect(responses.nth(0)).toHaveText('I will coordinate the requested work.');
        await expect(responses.nth(1)).toBeVisible(); await expect(responses.nth(1)).toHaveText('The worker completed the search implementation.');
        await expect(responses.nth(2)).toBeVisible(); await expect(responses.nth(2)).toHaveText('The review passed and the task is ready.');
        const cards = transcript(page).locator('.turn-changes:visible');
        await expect(cards).toHaveCount(2); await expect(cards.nth(0)).toContainText('search.ts'); await expect(cards.nth(1)).toContainText('search.test.ts');
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
      expect(await builder.locator('.team-progress-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('team-progress-spin');
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
      await expect(transcript(page).locator('.turn-changes:visible')).toContainText('README.md');
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
