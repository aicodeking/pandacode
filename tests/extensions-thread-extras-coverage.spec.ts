import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with session-1's seeded attachments, saved turn changes,
// usage limit and a second named connection. No real harness runs; installed WebView qualification is separate and
// not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/thread-extras/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.thread-extras/timeline';
const BASE = '/?extensions-baseline&thread-extras&replacement';
const props = (page: Page) => page.evaluate(() => (window as any).__previewThreadExtras());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const transcript = (page: Page) => page.locator('#transcript');
const chips = (page: Page) => transcript(page).locator('.message-attachments > .prompt-chip');
const kinds = (page: Page) => chips(page).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.attachmentKind));
const changes = (page: Page) => transcript(page).locator('.turn-changes').first();
const openDiff = (page: Page) => changes(page).locator('.turn-card-foot-open, .turn-changes-open');
const runButton = (page: Page) => changes(page).locator('.turn-changes-run');
const banner = (page: Page) => page.getByRole('region', { name: 'Usage limit', exact: true });
const bar = (page: Page) => page.getByRole('search');
const findInput = (page: Page) => page.getByRole('searchbox', { name: 'Find in thread', exact: true });
const findOrder = (page: Page) => bar(page).locator('[data-find-control]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.findControl));
const limitOrder = (page: Page) => banner(page).locator(':scope > .limit-resume, :scope > button').evaluateAll(nodes => nodes.map(node => node.classList.contains('limit-resume') ? 'resume' : (node as HTMLElement).dataset.action));
const changesOrder = (page: Page) => changes(page).locator('.turn-card-foot-open, .turn-changes-open, .turn-changes-run').evaluateAll(nodes => nodes.map(node => node.classList.contains('turn-changes-run') ? 'run' : 'open'));
const contributed = (page: Page, id: string) => page.locator(`[data-extension-contribution="sample.thread-extras/${id}"]`);
const choice = (page: Page, name: string | RegExp) => page.getByRole('menuitemradio', { name: typeof name === 'string' ? `Continue: ${name}` : name });
const changeId = (page: Page) => changes(page).evaluate(node => JSON.parse((node as HTMLElement).dataset.changes!).id as string);
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    // A held synthetic run keeps a new turn streaming; the checkout has a run script.
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true, runScript: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load. */
async function load(page: Page, url = BASE) {
  await page.goto(url); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await expect(chips(page)).toHaveCount(2); await expect(openDiff(page)).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(id); await back(page); await expect(transcript(page)).toHaveAttribute('data-component-provider', id); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewThreadExtras(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewThreadExtrasAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, region: ReturnType<Page['locator']>, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
async function openFind(page: Page, query = '') {
  await prompt(page).focus(); await page.keyboard.press('ControlOrMeta+f');
  await expect(findInput(page)).toBeFocused();
  if (query) await findInput(page).fill(query);
}
/** Opens a contributed action's dialog, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, id: string, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await contributed(page, id).click();
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}
const noEffects = async (page: Page) => { for (const command of ['reveal_path', 'open_external_url', 'clear_usage_limit', 'connection_assign', 'set_resume_at_reset']) expect(await calls(page, command), command).toEqual([]); };

test('Thread extras extension: zero extensions keep find (Enter, Escape, IME, highlights), attachment open, Open diff and usage-limit actions', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  expect(await kinds(page)).toEqual(['file', 'folder']);
  await expect(page.locator('#transcript [data-thread-extras], #transcript [data-layout-hidden], .limit-banner [data-thread-extras]')).toHaveCount(0);
  expect(await props(page)).toMatchObject({ visible: true, busy: false, safeMode: false, attachments: 2, find: false, limited: true });
  expect(await act(page, 'attachment-open')).toEqual({ ok: false, reason: 'Revoked' });
  // Find: typing highlights matches, Enter steps, an IME Enter does not, Escape closes and gives focus back.
  await openFind(page, 'search');
  await expect(bar(page).locator('.thread-find-count')).toHaveText(/^1 of \d+$/);
  expect(await page.evaluate(() => (CSS as any).highlights?.has('thread-find') ?? true)).toBe(true);
  expect(await findOrder(page)).toEqual(['count', 'previous', 'next', 'close']);
  await expect(bar(page).locator('.extension-action-slot')).toHaveCount(0);
  await findInput(page).press('Enter');
  await expect(bar(page).locator('.thread-find-count')).toHaveText(/^2 of \d+$/);
  await findInput(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await expect(bar(page).locator('.thread-find-count')).toHaveText(/^2 of \d+$/);
  // Closing keeps the reader where find left them.
  const top = await transcript(page).evaluate(node => node.scrollTop);
  await findInput(page).press('Escape');
  await expect(bar(page)).toHaveCount(0); await expect(prompt(page)).toBeFocused();
  expect(await page.evaluate(() => (CSS as any).highlights?.has('thread-find') ?? false)).toBe(false);
  expect(Math.abs(await transcript(page).evaluate(node => node.scrollTop) - top)).toBeLessThanOrEqual(1);
  // A folder chip reveals its path; Open diff opens the saved diff.
  await chips(page).nth(1).click();
  await expect.poll(async () => (await calls(page, 'reveal_path')).map((call: any) => call.args.path)).toEqual(['/Users/you/Projects/orbit-design']);
  await openDiff(page).click();
  await expect(page.getByRole('dialog', { name: 'Changed files' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Changed files' })).toHaveCount(0);
  // The usage-limit card keeps its controls; Dismiss clears the limit once.
  expect(await limitOrder(page)).toEqual(['resume', 'limit-continue', 'limit-switch', 'limit-dismiss']);
  await expect(banner(page).getByRole('button', { name: 'Continue on Work account', exact: true })).toBeVisible();
  await banner(page).getByRole('button', { name: 'Dismiss usage limit', exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  expect((await calls(page, 'clear_usage_limit')).length).toBe(1);
  expect(await kinds(page)).toEqual(['file', 'folder']);
});

test('Thread extras extension: an installed package adds attachment, find, turn and usage-limit actions that receive the captured target', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.thread-extras', exact: true }).click();
  await expect(region.getByLabel('Transcript presentation')).toHaveValue('');
  await back(page);
  // Usage-limit card: the contributed action sits before Dismiss and captures the limited harness.
  await expect(banner(page).locator('[data-extension-contribution="sample.thread-extras/limit"]')).toBeVisible();
  const limit = await captured(page, 'limit', 'Limit tags');
  expect(limit).toMatchObject({ surfaceId: 'panda.thread.usage-limit.actions', projectId: 'project-1', sessionId: 'session-1', selection: { kind: 'usage-limit', ids: ['claude'] } });
  expect(JSON.stringify(limit)).not.toMatch(/Work account|conn-work|Resets/);
  // Attachment chips: the action follows the chips and captures the message's attachment handles, not their contents.
  await expect(transcript(page).locator('.message-attachments [data-extension-contribution="sample.thread-extras/attachments"]')).toBeVisible();
  const attached = await captured(page, 'attachments', 'Attachment tags');
  expect(attached).toMatchObject({ surfaceId: 'panda.thread.attachments.actions', sessionId: 'session-1', selection: { kind: 'message-attachment', ids: ['1:0', '1:1'] } });
  expect(JSON.stringify(attached)).not.toMatch(/search\.ts|orbit-design|export const/);
  // Turn changes: the action captures the turn and its changed paths.
  const turn = await changeId(page);
  const first = await captured(page, 'changes', 'Turn tags');
  expect(first.surfaceId).toBe('panda.thread.changes.actions'); expect(first.selection.kind).toBe('turn-changes');
  expect(first.selection.ids[0]).toBe(turn); expect(first.selection.ids.length).toBeGreaterThan(1);
  // Find: the slot mounts after the field without taking its focus; the query never crosses.
  await openFind(page, 'keyboard');
  await expect(bar(page).locator('[data-extension-contribution="sample.thread-extras/find"]')).toBeVisible();
  await expect(findInput(page)).toBeFocused();
  const found = await captured(page, 'find', 'Find tags');
  expect(found).toMatchObject({ surfaceId: 'panda.thread.find.actions', sessionId: 'session-1', selection: { kind: 'find', ids: ['session-1'] } });
  expect(JSON.stringify(found)).not.toMatch(/keyboard/);
  await expect(bar(page)).toBeVisible(); await expect(findInput(page)).toHaveValue('keyboard');
  await findInput(page).focus(); await findInput(page).press('Escape'); await expect(bar(page)).toHaveCount(0);
  // A new turn streams: the earlier turn's action still names the earlier turn.
  await prompt(page).fill('Another change'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'A new turn is streaming.' }));
  await expect(page.locator('#stream-region')).toContainText('A new turn is streaming.');
  const again = await captured(page, 'changes', 'Turn tags');
  expect(again.selection.ids[0]).toBe(turn);
  await noEffects(page);
  expect(await kinds(page)).toEqual(['file', 'folder']);
});

test('Thread extras extension: captured attachment, find, turn and usage-limit actions run original handlers; protected, stale and forged requests fail', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]); await select(page);
  // A package never reads attachment contents, sets the find text, reads a diff or assigns a connection or provider.
  for (const controlId of ['attachment-read', 'attachment-reveal', 'find-set-query', 'find-read-matches', 'changes-read-diff', 'limit-set', 'limit-assign-connection', 'limit-switch-provider']) expect(await act(page, 'changes-open', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'changes-open', { path: '/etc/passwd' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'changes-open', { selector: '#transcript' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'changes-open', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'changes-open', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await noEffects(page);
  // Open diff opens the original viewer for the captured turn.
  expect(await act(page, 'changes-open')).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Changed files' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Changed files' })).toHaveCount(0);
  // Run asks first; Escape declines it; Continue runs the original Run once.
  await expect(runButton(page)).toBeVisible();
  const scripts = (await calls(page, 'get_run_script')).length;
  expect(await act(page, 'changes-run')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  await expect(choice(page, 'Run the project (pandacode-run.sh)')).toBeVisible();
  expect(await act(page, 'changes-open')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice(page, 'Run the project (pandacode-run.sh)')).toHaveCount(0);
  expect((await calls(page, 'get_run_script')).length).toBe(scripts);
  expect(await act(page, 'changes-run')).toEqual({ ok: true }); await choice(page, 'Run the project (pandacode-run.sh)').click();
  await expect.poll(async () => (await calls(page, 'get_run_script')).length).toBe(scripts + 1);
  await expect(runButton(page)).toHaveAttribute('aria-busy', 'false');
  // An attachment opens only after the fresh choice, through the chip's own handler.
  expect(await act(page, 'attachment-open', {}, 1)).toEqual({ ok: true });
  await expect(choice(page, 'Open orbit-design/')).toBeVisible(); await noEffects(page);
  await choice(page, 'Open orbit-design/').click();
  await expect.poll(async () => (await calls(page, 'reveal_path')).map((call: any) => call.args.path)).toEqual(['/Users/you/Projects/orbit-design']);
  // Find: Next steps the original bar without moving focus; another query is another target; Close closes it.
  await openFind(page, 'search');
  await expect(bar(page).locator('.thread-find-count')).toHaveText(/^1 of \d+$/);
  expect(await act(page, 'find-next')).toEqual({ ok: true });
  await expect(bar(page).locator('.thread-find-count')).toHaveText(/^2 of \d+$/);
  await expect(findInput(page)).toBeFocused(); await expect(findInput(page)).toHaveValue('search');
  const before = await action(page, 'find-previous');
  await findInput(page).fill('keyboard');
  expect(await send(page, before)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'find-close')).toEqual({ ok: true }); await expect(bar(page)).toHaveCount(0);
  // Usage limit: Continue on <connection> asks first and nothing moves on Escape; Dismiss runs once after Continue.
  expect(await act(page, 'limit-switch')).toEqual({ ok: true });
  await expect(choice(page, 'Continue on Work account')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(choice(page, 'Continue on Work account')).toHaveCount(0);
  expect(await calls(page, 'connection_assign')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
  const dismiss = await action(page, 'limit-dismiss');
  expect(await send(page, dismiss)).toEqual({ ok: true }); await choice(page, 'Dismiss the usage limit').click();
  await expect(banner(page)).toHaveCount(0);
  expect((await calls(page, 'clear_usage_limit')).length).toBe(1);
  expect(await send(page, { ...dismiss, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  // A request captured before a new turn streams still names the earlier turn: it opens that turn's saved diff.
  const earlier = await action(page, 'changes-open');
  await prompt(page).fill('Another change'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'A new turn is streaming.' }));
  await expect(page.locator('#stream-region')).toContainText('A new turn is streaming.');
  expect((await props(page)).controls.filter((item: any) => item.controlId === 'changes-open').map((item: any) => item.resource)).toEqual([earlier.resource]);
  expect(await send(page, earlier)).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Changed files' })).toBeVisible();
  expect((await calls(page, 'turn_change_diff')).every((call: any) => call.args.sessionId === 'session-1')).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Changed files' })).toHaveCount(0);
  // Switching task changes the captured task.
  const elsewhere = await action(page, 'changes-open');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await calls(page, 'clear_usage_limit')).length).toBe(1); expect((await calls(page, 'reveal_path')).length).toBe(1);
});

test('Thread extras extension: attachment, find, turn and usage-limit order and hiding persist across a reload and never touch pinned controls', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]);
  await proposal(page, 'panda.thread.attachments.controls', 'Folder chips before Project file chips'); await back(page);
  await proposal(page, 'panda.thread.find.controls', 'Next match before Previous match'); await back(page);
  await proposal(page, 'panda.thread.changes.controls', 'Open diff before Run'); await back(page);
  await proposal(page, 'panda.thread.usage-limit.controls', 'Continue now before Resume at reset'); await back(page);
  const region = await explorer(page);
  await hide(page, region, 'panda.thread.attachments.controls', 'Project file chips');
  await hide(page, region, 'panda.thread.find.controls', 'Match count');
  await hide(page, region, 'panda.thread.changes.controls', 'Run project');
  await hide(page, region, 'panda.thread.usage-limit.controls', 'Resume at reset');
  await expect(region.getByRole('button', { name: /^Hide Close find/ })).toHaveCount(0);
  await back(page);
  const check = async () => {
    await expect.poll(() => kinds(page)).toEqual(['folder', 'file']);
    await expect(chips(page).nth(1)).toBeHidden(); await expect(chips(page).nth(0)).toBeVisible();
    await expect.poll(() => changesOrder(page)).toEqual(['open', 'run']);
    await expect(runButton(page)).toHaveAttribute('data-layout-hidden', '');
    await expect.poll(() => limitOrder(page)).toEqual(['limit-continue', 'resume', 'limit-switch', 'limit-dismiss']);
    await expect(banner(page).locator('.limit-resume')).toBeHidden();
    await openFind(page, 'search');
    await expect.poll(async () => { const order = await findOrder(page); return order.indexOf('next') < order.indexOf('previous'); }).toBe(true);
    await expect(bar(page).locator('[data-find-control="count"]')).toBeHidden();
    await expect(findInput(page)).toBeFocused();
    await findInput(page).press('Escape'); await expect(bar(page)).toHaveCount(0);
  };
  await check();
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await check();
  // A forged overlay cannot hide Close, Open diff, Continue now or Dismiss.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.thread.find.controls/close': false, 'panda.thread.changes.controls/open': false, 'panda.thread.usage-limit.controls/continue': false, 'panda.thread.usage-limit.controls/dismiss': false, 'panda.thread.extras.protected/find-input': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(openDiff(page)).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Continue now', exact: true })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Dismiss usage limit', exact: true })).toBeVisible();
  await openFind(page); await expect(bar(page).getByRole('button', { name: 'Close find', exact: true })).toBeVisible();
  await findInput(page).press('Escape');
  await noEffects(page);
});

test('Thread extras extension: the transcript, scroll position, draft and focus survive conflict, fault, disable and safe mode with no duplicate action', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.thread-extras'; other.permissions = ['ui.contribute', 'tasks.transcript.read', 'tasks.tools.read']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.thread-extras/timeline' }], commands: [{ id: 'other.thread-extras/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.thread-extras/attachments', command: 'other.thread-extras/notes', location: 'panda.thread.attachments.actions', presentation: 'button', text: 'Other notes' }] };
  await setup(page, [manifest, other]);
  // Two compatible providers: neither is selected automatically.
  await explorer(page); await expect(page.getByLabel('Transcript presentation', { exact: true })).toHaveValue(''); await back(page);
  await expect(transcript(page)).not.toHaveAttribute('data-component-provider');
  await select(page, 'other.thread-extras/timeline');
  // Both packages contribute after the chips; neither displaces a chip.
  await expect(transcript(page).locator('.message-attachments [data-extension-contribution]')).toHaveCount(2);
  const messages = await transcript(page).locator('article.message').count();
  await transcript(page).evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2); });
  const top = await transcript(page).evaluate(node => node.scrollTop);
  await prompt(page).fill('Keep this draft'); await prompt(page).focus();
  const check = async () => {
    await expect(prompt(page)).toHaveValue('Keep this draft'); await expect(prompt(page)).toBeFocused();
    await expect(transcript(page).locator('article.message')).toHaveCount(messages);
    expect(Math.abs(await transcript(page).evaluate(node => node.scrollTop) - top)).toBeLessThanOrEqual(2);
    expect(await kinds(page)).toEqual(['file', 'folder']);
    await expect(contributed(page, 'attachments')).toHaveCount(1); await expect(banner(page)).toBeVisible();
    await noEffects(page); expect(await calls(page, 'send_message')).toEqual([]);
  };
  await check();
  // A faulting transcript recipe falls back to the built-in transcript: captured actions stop; the slots stay.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('controlled fault'); }); });
  await expect(transcript(page)).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'changes-open')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.thread-extras'));
  await expect(transcript(page).locator('.message-attachments [data-extension-contribution]')).toHaveCount(1);
  await prompt(page).focus(); await check();
  await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(transcript(page)).toHaveAttribute('data-component-provider', PROVIDER);
  await transcript(page).evaluate((node, top) => { node.scrollTop = top; }, top);
  await prompt(page).focus(); await check();
  // A captured Dismiss asks first; Escape declines it and the card stays.
  expect(await act(page, 'limit-dismiss')).toEqual({ ok: true });
  await expect(choice(page, 'Dismiss the usage limit')).toBeVisible(); await page.keyboard.press('Escape'); await expect(choice(page, 'Dismiss the usage limit')).toHaveCount(0);
  await prompt(page).focus(); await check();
  // Safe mode restores the built-in rows: no contributed actions or markers, nothing captured; everything else stays.
  await page.evaluate(() => (window as any).__previewThreadExtrasSafeMode());
  await expect.poll(async () => (await props(page)).safeMode).toBe(true);
  expect(await act(page, 'changes-open')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('[data-thread-extras], #transcript [data-layout-hidden], [data-extension-contribution^="sample.thread-extras/"]')).toHaveCount(0);
  await prompt(page).focus();
  await expect(prompt(page)).toHaveValue('Keep this draft'); await expect(prompt(page)).toBeFocused();
  await expect(transcript(page).locator('article.message')).toHaveCount(messages);
  expect(Math.abs(await transcript(page).evaluate(node => node.scrollTop) - top)).toBeLessThanOrEqual(2);
  // The host still dismisses the limit: once.
  await banner(page).getByRole('button', { name: 'Dismiss usage limit', exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  expect((await calls(page, 'clear_usage_limit')).length).toBe(1);
  await expect(prompt(page)).toHaveValue('Keep this draft');
});
