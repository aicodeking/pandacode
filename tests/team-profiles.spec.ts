import { expect, test, type Page } from '@playwright/test';

/** The Team button opens No team · Cheap · Balanced · Best; a team on carries `data-on`. */
const trigger = (page: Page) => page.locator('#team-trigger');
async function pickTeam(page: Page, kind: string): Promise<void> {
  await trigger(page).click();
  await page.getByRole('menuitemradio', { name: kind, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: kind, exact: true })).toBeHidden();
}
const errors = new WeakMap<Page, string[]>();
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__teamProfiles.calls.filter((call: any) => call.command === command), command);
const read = (page: Page, command: string, args: Record<string, unknown> = {}): Promise<any> => page.evaluate(({ command, args }) => (window as any).__teamProfiles.invoke(command, args), { command, args });
const library = (page: Page) => read(page, 'architect_profiles');
const currentId = (page: Page) => page.locator('#prompt').getAttribute('data-session-id');

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

async function install(page: Page): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      window.__teamProfiles ??= { calls: [], failures: {}, holdConfigure: false, configureReplies: [], invoke };
      const fixture = window.__teamProfiles;
      fixture.calls.push({ command, args: structuredClone(args) });
      if (fixture.failures[command]) throw new Error(fixture.failures[command]);
      const result = await invokePreview(command, args);
      if (command === 'architect_configure' && fixture.holdConfigure) {
        await new Promise(resolve => fixture.configureReplies.push({ snapshot: structuredClone(result), release: resolve }));
      }
      return result;
    }
    async function invokePreview(command, args) {
    `) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}

async function newConversation(page: Page): Promise<string> {
  await expect(page.locator('.task-item.selected')).toBeVisible();
  const previous = await currentId(page);
  await page.locator('.new-task-button').click();
  if (previous) await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', previous);
  // A New task draft opens without a sidebar row until its first prompt.
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  return (await currentId(page))!;
}

/** Turning Team on remembers an automatic team for new tasks; the menu pick is the whole setup. */
async function turnOn(page: Page): Promise<void> {
  await pickTeam(page, 'Balanced team');
  await expect(trigger(page)).toHaveAttribute('data-on', '');
}

async function assertAutoDefault(page: Page, id: string, lead: { provider: string; model: string }): Promise<void> {
  const task = await read(page, 'get_task', { sessionId: id });
  const team = await read(page, 'architect_get', { sessionId: id });
  // The new task keeps the model it was created with; that model leads.
  expect(task).toMatchObject({ provider: lead.provider, model: lead.model, status: 'idle' });
  expect(team).toMatchObject({ sessionId: id, status: 'ready', config: { auto: true }, workers: [] });
  expect(team.round).toBe(0);
}

test.describe('team inheritance', () => {
  test('an automatic team is remembered and new conversations are led by their own model', async ({ page }) => {
    await install(page); await turnOn(page);
    const saved = await library(page);
    expect(saved.enabled).toBe(true);
    expect(saved.lastSetup.config.auto).toBe(true);
    expect(await calls(page, 'configure_session')).toHaveLength(0);
    await page.reload();
    const id = await newConversation(page);
    expect(id).not.toBe('session-2');
    await expect(trigger(page)).toHaveAttribute('data-on', '');
    await expect(trigger(page)).toHaveAccessibleName('Balanced team');
    const fresh = await read(page, 'get_task', { sessionId: id });
    await assertAutoDefault(page, id, fresh);
    expect(await calls(page, 'architect_start')).toHaveLength(0);
    expect(await calls(page, 'send_message')).toHaveLength(0);
  });

  test('board tasks and worktrees inherit the automatic team without adding worker tasks', async ({ page }) => {
    await install(page); await turnOn(page);
    const before = await read(page, 'list_sessions');
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    const board = page.getByRole('region', { name: 'Project board', exact: true });
    await board.getByRole('button', { name: 'Add task', exact: true }).click();
    const form = page.locator('#dialog');
    await form.getByRole('textbox', { name: 'Task title', exact: true }).fill('Inherited board team');
    await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
    const card = board.getByRole('button', { name: 'Open task: Inherited board team', exact: true });
    await expect(card).toBeVisible();
    const boardId = (await card.getAttribute('data-id'))!;
    await assertAutoDefault(page, boardId, await read(page, 'get_task', { sessionId: boardId }));
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
    // A started conversation spawns a sibling worktree task; an unstarted one would convert in place.
    await page.locator('.task-item[data-id="session-1"]').click();
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
    await page.locator('#branch-chip').click();
    await page.getByRole('dialog', { name: 'Branch and worktree', exact: true }).getByRole('menuitem', { name: /New task in a worktree/ }).click();
    await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('codex/team-default-test');
    await page.locator('#dialog').getByRole('button', { name: 'Create worktree task', exact: true }).click();
    await expect(page.locator('#dialog')).toBeHidden();
    const worktreeId = (await currentId(page))!;
    expect(worktreeId).not.toBe('session-2');
    await assertAutoDefault(page, worktreeId, await read(page, 'get_task', { sessionId: worktreeId }));
    const after = await read(page, 'list_sessions');
    expect(after).toHaveLength(before.length + 2);
    expect(await calls(page, 'architect_start')).toHaveLength(0);
  });

  test('turning Team off disables inheritance for future tasks', async ({ page }) => {
    await install(page); await turnOn(page);
    await pickTeam(page, 'No team');
    await expect(trigger(page)).not.toHaveAttribute('data-on');
    expect((await library(page)).enabled).toBe(false);
    await page.reload(); await newConversation(page);
    await expect(trigger(page)).not.toHaveAttribute('data-on');
    expect(await read(page, 'architect_get', { sessionId: await currentId(page) })).toBeNull();
  });
});
