import { expect, test, type Page } from '@playwright/test';

const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const review = (page: Page) => page.locator('.change-review-dialog');
const errors = new WeakMap<Page, string[]>();
const summary = (id = 'fixture-change') => ({ attributed: true, id, files: [
  { path: 'src/feature.ts', status: 'modified', additions: 1, deletions: 1 },
], additions: 1, deletions: 1, truncated: false, concurrent: false });
const patch = (path = 'src/feature.ts', text = 'updated') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${text}\n`;

async function install(page: Page, config: { messages?: any[]; details?: Record<string, any> } = {}): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      window.__turnChangesTest ??= { calls: [], messages: ${JSON.stringify(config.messages ?? null)}, details: ${JSON.stringify(config.details ?? {})}, hold: {}, release: {}, invoke, emit: event => agent(event) };
      const fixture = window.__turnChangesTest;
      fixture.calls.push({ command, args: structuredClone(args) });
      if (command === 'get_messages' && args.sessionId === 'session-2' && fixture.messages) {
        const saved = structuredClone(fixture.messages);
        if (fixture.holdHistory) { fixture.holdHistory = false; await new Promise(resolve => { fixture.releaseHistory = resolve; }); }
        return { messages: saved, hasOlder: false };
      }
      if (command === 'turn_change_diff' && Object.hasOwn(fixture.details, args.changeId + ':' + args.path)) {
        const key = args.changeId + ':' + args.path;
        const result = structuredClone(fixture.details[key]);
        if (fixture.hold[key]) await new Promise(resolve => { fixture.release[key] = resolve; });
        return result;
      }
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__turnChangesTest))).toBe(true);
}
const history = (changes: any, role = 'user') => role === 'user' ? [
  { id: 201, sessionId: 'session-2', role, content: 'Change the feature.', createdAt: 100, turnDurationMs: 1000, turnChanges: changes },
  { id: 202, sessionId: 'session-2', role: 'assistant', content: 'The change is ready.', createdAt: 1100 },
] : [
  { id: 302, sessionId: 'session-2', role: 'assistant', content: 'The goal turn is ready.', createdAt: 1100 },
  { id: 303, sessionId: 'session-2', role, content: '', createdAt: 1100, turnChanges: changes },
];
async function selectFixture(page: Page): Promise<void> {
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}
async function expand(card: ReturnType<Page['locator']>): Promise<void> {
  const list = card.locator('.turn-change-list');
  if (await list.getAttribute('open') === null) await list.locator(':scope > summary').click();
  const folders = card.locator('.turn-change-folder');
  for (let index = 0; index < await folders.count(); index++) {
    const folder = folders.nth(index);
    if (await folder.getAttribute('open') === null) await folder.locator(':scope > summary').click();
  }
}

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

test.describe('turn changes', () => {
  for (const view of ['conversation', 'board']) test(`shows one compact completed-turn card after streaming in ${view}`, async ({ page }) => {
    await page.clock.install(); await install(page);
    if (view === 'board') {
      await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
      await page.getByRole('region', { name: 'Project board', exact: true }).getByRole('button', { name: 'Add task', exact: true }).click();
      await page.getByRole('textbox', { name: 'Task title', exact: true }).fill('Sample change with a saved diff');
      await page.getByRole('button', { name: 'Add to pending', exact: true }).click();
      await page.getByRole('region', { name: 'Task details', exact: true }).getByRole('button', { name: 'Start task', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
      await expect(page.locator('#prompt')).toBeEnabled();
      await page.locator('#prompt').fill('Sample change with a saved diff'); await page.locator('#prompt').press('Enter');
    }
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await page.clock.runFor(400);
    await expect(page.locator('#stream-region .live-text')).not.toBeEmpty();
    await expect(transcript(page).locator('.turn-changes')).toHaveCount(0);
    await page.clock.runFor(2000);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
    const card = transcript(page).locator('.turn-changes');
    await expect(card).toHaveCount(1); await expect(card).toContainText('3 changed files');
    await expect(card).toContainText('+6'); await expect(card).toContainText('−2');
    await expect(card.locator('.turn-change-folder[open]')).toHaveCount(0);
    await expect(transcript(page).locator('.agent-message .message-content')).toContainText('browser preview');
  });

  test('preserves a full live response and earlier history across goal boundaries and delayed task loading', async ({ page }) => {
    const older = [
      { id: 201, sessionId: 'session-2', role: 'user', content: 'Earlier request', createdAt: 100 },
      { id: 202, sessionId: 'session-2', role: 'assistant', content: 'Earlier history stays readable.', createdAt: 200 },
      // An empty earlier snapshot renders no card; only the live turn's card is counted below.
      { id: 203, sessionId: 'session-2', role: 'changes', content: '', createdAt: 200, turnChanges: { ...summary('earlier'), files: [], additions: 0, deletions: 0 } },
      { id: 301, sessionId: 'session-2', role: 'user', content: 'Continue the goal', createdAt: 300 },
    ];
    await install(page, { messages: older });
    await page.evaluate(() => { (window as any).__turnChangesTest.holdHistory = true; });
    await page.locator('.task-item[data-id="session-2"]').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__turnChangesTest.releaseHistory)).toBe('function');
    const response = 'Full response begins. ' + 'Detailed result. '.repeat(1200) + 'FULL_RESPONSE_TAIL';
    const changes = summary('live-boundary');
    await page.evaluate(({ response, changes, older }) => {
      const fixture = (window as any).__turnChangesTest;
      fixture.emit({ sessionId: 'session-2', kind: 'text', text: response });
      fixture.messages = [...older,
        { id: 302, sessionId: 'session-2', role: 'assistant', content: response, createdAt: 400 },
        { id: 303, sessionId: 'session-2', role: 'changes', content: '', createdAt: 400, turnChanges: changes },
      ];
      fixture.emit({ sessionId: 'session-2', kind: 'turn_complete', text: '' });
      fixture.emit({ sessionId: 'session-2', kind: 'turn_changes', text: '', data: { messageId: 303, turnChanges: changes } });
    }, { response, changes, older });
    await expect(transcript(page)).toContainText('FULL_RESPONSE_TAIL');
    await expect(transcript(page)).toContainText('Earlier history stays readable.');
    await expect(transcript(page).locator('.turn-changes')).toHaveCount(1);
    const final = transcript(page).locator('.agent-message .message-content').filter({ hasText: 'FULL_RESPONSE_TAIL' });
    expect((await final.textContent())!.length).toBeGreaterThan(19000);
    await page.evaluate(() => {
      const fixture = (window as any).__turnChangesTest;
      fixture.emit({ sessionId: 'session-2', kind: 'text', text: 'Next goal turn is still streaming.' });
      fixture.releaseHistory();
    });
    await expect(page.locator('#stream-region .live-text')).toContainText('Next goal turn is still streaming.');
    await expect(transcript(page)).toContainText('FULL_RESPONSE_TAIL');
    await expect(transcript(page)).toContainText('Earlier history stays readable.');
    await expect(transcript(page).locator('.turn-changes')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  });

  test('groups nested files and opens an immutable syntax-rendered diff with layout and theme controls', async ({ page }) => {
    await install(page);
    const card = transcript(page).locator('.turn-changes');
    await expect(card).toContainText('3 changed files');
    await expand(card);
    await expect(card.locator('.turn-change-file')).toHaveCount(3);
    await expect(card.locator('.turn-change-folder')).not.toHaveCount(0);
    await card.screenshot({ path: '/private/tmp/pandacode-turn-changes-card.png', animations: 'disabled' });
    await card.locator('.turn-change-file').filter({ hasText: 'search.ts' }).click();
    await expect(review(page)).toBeVisible();
    await expect(review(page)).toContainText('src/components/search.ts');
    await expect(review(page).getByText('normalized', { exact: true }).first()).toBeVisible();
    await review(page).getByRole('button', { name: 'Split diff', exact: true }).click();
    await expect(review(page).getByRole('button', { name: 'Split diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await review(page).getByRole('button', { name: 'Unified diff', exact: true }).click();
    await expect(review(page).getByRole('button', { name: 'Unified diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: '/private/tmp/pandacode-turn-changes-dark.png', animations: 'disabled' });
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await expect(review(page).getByText('normalized', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: '/private/tmp/pandacode-turn-changes-light.png', animations: 'disabled' });
    const before = await page.evaluate(() => (window as any).__turnChangesTest.calls.filter((call: any) => call.command === 'turn_change_diff').at(-1).args);
    await review(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.reload();
    await expand(transcript(page).locator('.turn-changes'));
    await transcript(page).locator('.turn-change-file').filter({ hasText: 'search.ts' }).click();
    await expect(review(page).getByText('normalized', { exact: true }).first()).toBeVisible();
    const after = await page.evaluate(() => (window as any).__turnChangesTest.calls.filter((call: any) => call.command === 'turn_change_diff').at(-1).args);
    expect(after).toEqual(before);
    await expect(review(page).getByText('normalized', { exact: true }).first()).toBeVisible();
    await review(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await transcript(page).getByRole('button', { name: 'Open diff', exact: true }).click();
    await expect(review(page)).toBeVisible();
  });

  test('a turn without changes renders no card while goal turn summaries still do', async ({ page }) => {
    const unchanged = history({ ...summary(), files: [], additions: 0, deletions: 0 }, 'changes').map((message, index) => ({ ...message, id: 201 + index }));
    await install(page, { messages: [...unchanged, ...history(summary('goal-change'), 'changes')] });
    await selectFixture(page);
    // The reply already says nothing changed; an empty card would only repeat it.
    await expect(transcript(page).locator('.turn-changes')).toHaveCount(1);
    // No empty row is left behind either (the team-progress host is the only other row).
    await expect(transcript(page).locator('.turn-changes-row:not(#team-progress-host)')).toHaveCount(1);
    await expect(transcript(page)).not.toContainText('No files changed');
    await expect(transcript(page).locator('.turn-changes')).toContainText('1 changed file');
    await expect(transcript(page)).toContainText('The goal turn is ready');
  });

  for (const attributed of [undefined, false]) test(`hides legacy changes when task attribution is ${attributed === undefined ? 'missing' : 'false'}`, async ({ page }) => {
    await install(page, { messages: history({ ...summary('legacy-change'), attributed }) });
    await selectFixture(page);
    await expect(transcript(page)).toContainText('The change is ready.');
    await expect(transcript(page).locator('.turn-changes')).toHaveCount(0);
    await expect(transcript(page).locator('.turn-changes-row:not(#team-progress-host)')).toHaveCount(0);
  });

  test('a tracking limit does not add an unavailable-changes card to a successful reply', async ({ page }) => {
    const unavailable = history({ ...summary(), files: [], additions: null, deletions: null, truncated: true, error: 'Snapshot time limit reached; some files were not inspected.' }, 'changes');
    await install(page, { messages: unavailable });
    await selectFixture(page);
    const card = transcript(page).locator('.turn-changes');
    await expect(transcript(page)).toContainText('The goal turn is ready.');
    await expect(card).toHaveCount(0);
    await expect(transcript(page)).not.toContainText('Changes unavailable');
    await expect(transcript(page)).not.toContainText('Snapshot time limit');
  });

  test('observed changes still explain a partial capture without presenting an agent failure', async ({ page }) => {
    await install(page, { messages: history({ ...summary(), truncated: true, error: 'Some files were not inspected.' }, 'changes') });
    await selectFixture(page);
    await expect(transcript(page)).toContainText('The goal turn is ready.');
    const card = transcript(page).locator('.turn-changes');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('1 changed file');
    await expect(card.locator('.turn-change-notice')).toContainText('Change tracking is limited');
    await expect(card.locator('.turn-change-notice')).toContainText('Some files were not inspected.');
    await expect(card.locator('.turn-change-list > summary .info-mark')).toHaveAttribute('data-tip', /Change tracking is limited/);
  });

  test('keeps the newest selected file when an older detail request resolves late', async ({ page }) => {
    const changes = { ...summary(), files: [...summary().files, { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 }], additions: 2 };
    await install(page, { messages: history(changes), details: {
      'fixture-change:src/feature.ts': { path: 'src/feature.ts', patch: patch(), binary: false, truncated: false },
      'fixture-change:src/new.ts': { path: 'src/new.ts', patch: patch('src/new.ts', 'newestSelection'), binary: false, truncated: false },
    } });
    await selectFixture(page);
    await page.evaluate(() => { (window as any).__turnChangesTest.hold['fixture-change:src/feature.ts'] = true; });
    await expand(transcript(page).locator('.turn-changes'));
    await transcript(page).locator('.turn-change-file').filter({ hasText: 'feature.ts' }).click();
    await expect(review(page)).toBeVisible();
    await review(page).getByRole('button', { name: /src\/new.ts/ }).click();
    await expect(review(page).getByText('newestSelection', { exact: true }).first()).toBeVisible();
    await page.evaluate(() => (window as any).__turnChangesTest.release['fixture-change:src/feature.ts']());
    await expect(review(page).getByText('newestSelection', { exact: true }).first()).toBeVisible();
    await expect(review(page).getByText('updated', { exact: true })).toHaveCount(0);
  });

  test('shows binary truncated and unavailable states without inventing line counts or executing markup', async ({ page }) => {
    const malicious = '<img src=x onerror=window.__diffXss=1>';
    const changes = { ...summary(), concurrent: true, truncated: true, files: [
      { path: 'assets/logo.png', status: 'modified', additions: null, deletions: null, binary: true },
      { path: 'src/large.ts', status: 'modified', additions: 1, deletions: 1, truncated: true },
      { path: 'src/error.ts', status: 'modified', additions: null, deletions: null },
    ] };
    await install(page, { messages: history(changes), details: {
      'fixture-change:assets/logo.png': { path: 'assets/logo.png', patch: '', binary: true, truncated: false },
      'fixture-change:src/large.ts': { path: 'src/large.ts', patch: patch('src/large.ts', malicious), binary: false, truncated: true },
      'fixture-change:src/error.ts': { path: 'src/error.ts', patch: '', binary: false, truncated: false, error: 'Saved content is unavailable.' },
    } });
    await selectFixture(page); const card = transcript(page).locator('.turn-changes'); await expand(card);
    await expect(card).toContainText(/concurrent|overlap|shared/i);
    await card.locator('.turn-change-file').filter({ hasText: 'logo.png' }).click();
    await expect(review(page)).toContainText(/binary/i);
    await review(page).getByRole('button', { name: /src\/large.ts/ }).click();
    await expect(review(page)).toContainText(/truncated|partial|limited|shortened/i);
    await expect(review(page).getByText(malicious, { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__diffXss)).toBeUndefined();
    await expect(review(page).locator('img')).toHaveCount(0);
    await review(page).getByRole('button', { name: /src\/error.ts/ }).click();
    await expect(review(page)).toContainText('Saved content is unavailable.');
  });

  test('uses the same read-only viewer for current working-tree changes', async ({ page }) => {
    await install(page);
    await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
    // The Changes tab shows each file's diff inline in the same read-only viewer, one load per file.
    const files = page.locator('#inspector-content .changes-view .cv-file');
    const current = files.first();
    await expect(current.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
    await expect(current.locator('.diff-viewer')).toHaveAttribute('data-diff-layout', 'unified');
    await expect(current.getByText('createSearchIndex', { exact: true }).first()).toBeVisible();
    await expect(files.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(await files.count());
    expect(await page.evaluate(() => (window as any).__turnChangesTest.calls.filter((call: any) => call.command === 'git_diff').length)).toBe(await files.count());
  });

  test('completed worker conversations show their own changed files and request their snapshot', async ({ page }) => {
    await page.clock.install(); await install(page); await selectFixture(page);
    await page.locator('#team-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
    await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
    await page.locator('#prompt').fill('Demonstrate the worker change review'); await page.locator('#prompt').press('Enter');
    await page.locator('#agents-toggle').click();
    await page.clock.runFor(8000);
    const workers = page.getByRole('dialog', { name: 'Workers', exact: true });
    await workers.locator('.architect-worker-row').first().click();
    const card = workers.locator('.turn-changes'); await expect(card).toHaveCount(1); await expand(card);
    await card.locator('.turn-change-file').filter({ hasText: 'search.ts' }).click();
    await expect(review(page).getByText('normalized', { exact: true }).first()).toBeVisible();
    const request = await page.evaluate(() => (window as any).__turnChangesTest.calls.filter((call: any) => call.command === 'turn_change_diff').at(-1).args);
    expect(request.sessionId).not.toBe('session-2');
  });
});
