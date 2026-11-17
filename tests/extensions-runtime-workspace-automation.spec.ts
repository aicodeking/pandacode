import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0406 (workspace.bots and workspace.channels). The browser has no service process:
// `extensions_workspace_automation_service` answers a service call exactly as the native `serve` does (same refusal envelope,
// same forms, the same host confirmation of a deletion), and the window half (the confirmation dialog's host and the
// origins) is the real one running against the preview store. The native rules are proven by
// `runtime_workspace_automation::tests` (cargo, feature-less); an installed run with a real service is the native fixture's.
const values = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-workspace-automation/values.json', import.meta.url), 'utf8')) as Record<string, any>;
const OWNER = 'sample.runtime-workspace-automation';
const OTHER = 'sample.other-automation';
test.setTimeout(90_000);

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__workspaceAutomation.call(command, args), [command, args] as const);
const hook = (page: Page, op: string, extra: Record<string, unknown> = {}) => ipc(page, 'extensions_workspace_automation_preview', { op, owner: OWNER, ...extra });
const service = (page: Page, params: Record<string, unknown>, owner = OWNER) => ipc(page, 'extensions_workspace_automation_service', { owner, params }) as Promise<any>;
const state = (page: Page) => hook(page, 'state') as Promise<any>;

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?workspace-automation'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__workspaceAutomation);
  await hook(page, 'install'); await hook(page, 'grant');
}
const bots = {
  create: (page: Page, input: unknown, owner = OWNER) => service(page, { family: 'bots', op: 'create', input }, owner),
  update: (page: Page, id: string, input: unknown, owner = OWNER) => service(page, { family: 'bots', op: 'update', id, input }, owner),
  remove: (page: Page, id: string, owner = OWNER) => service(page, { family: 'bots', op: 'remove', id }, owner),
};
const channels = {
  create: (page: Page, input: unknown, owner = OWNER) => service(page, { family: 'channels', op: 'create', input }, owner),
  update: (page: Page, id: string, input: unknown, owner = OWNER) => service(page, { family: 'channels', op: 'update', id, input }, owner),
  remove: (page: Page, id: string, owner = OWNER) => service(page, { family: 'channels', op: 'remove', id }, owner),
};

test('extensions workspace automation: a granted package creates, changes and removes bots and channels with the same actions as the interface', async ({ page }) => {
  await boot(page);
  const first = await bots.create(page, values.bot);
  expect(first.ok).toBe(true);
  expect(first.value).toMatchObject({ name: 'Scout', role: 'Reviewer', provider: 'claude', mode: 'ask', skills: ['review-code'], mcp: ['files'] });
  const second = await bots.create(page, { ...values.bot, name: 'Scout two' });
  const channel = await channels.create(page, { name: values.channel.name, memberIds: [first.value.id] });
  expect(channel.value).toMatchObject({ name: 'launch', memberIds: [first.value.id], leadBotId: first.value.id, archived: false });
  // The channel's form is a patch: a name alone keeps the members; new members keep the lead only while the lead is one of them.
  const renamed = await channels.update(page, channel.value.id, { name: 'launch-2' });
  expect(renamed.value).toMatchObject({ name: 'launch-2', memberIds: [first.value.id], leadBotId: first.value.id });
  const restaffed = await channels.update(page, channel.value.id, { memberIds: [first.value.id, second.value.id], leadBotId: second.value.id });
  expect(restaffed.value).toMatchObject({ memberIds: [first.value.id, second.value.id], leadBotId: second.value.id });
  const dropped = await channels.update(page, channel.value.id, { memberIds: [first.value.id] });
  expect(dropped.value.leadBotId).toBe(first.value.id);
  // The bot's form is a patch too: what is not named keeps its value.
  const patched = await bots.update(page, first.value.id, values.botPatch);
  expect(patched.value).toMatchObject({ name: 'Scout', role: 'Release captain', heartbeatMinutes: 0, showPlan: true, skills: [], mcp: ['files'], model: 'sonnet' });
  await hook(page, 'confirmDeletions', { value: false });
  expect(await channels.remove(page, channel.value.id)).toEqual({ ok: true, value: null });
  expect(await bots.remove(page, first.value.id)).toEqual({ ok: true, value: null });
  expect(await bots.remove(page, second.value.id)).toEqual({ ok: true, value: null });
  const after = await state(page);
  expect(after.bots).toEqual([]);
  // Removing a channel archives it, as "Delete channel" does: it stays restorable and refuses changes.
  expect(after.channels).toHaveLength(1);
  expect(after.channels[0]).toMatchObject({ archived: true });
  // The same operations the interface's own route runs, one for one, nothing extra.
  expect(after.actions).toEqual(['bot_create', 'bot_create', 'bot_shared_channel_create', 'bot_shared_channel_update', 'bot_shared_channel_update', 'bot_shared_channel_update', 'bot_update', 'bot_shared_channel_archive', 'bot_delete', 'bot_delete']);
});

test('extensions workspace automation: shapes, values and unknown ids are refused with their reason and change nothing', async ({ page }) => {
  await boot(page);
  for (const row of values.badBots as { input: unknown; code: string; path: string }[]) {
    const reply = await bots.create(page, row.input);
    expect(reply.ok, JSON.stringify(row.input)).toBe(false);
    expect(reply.error, JSON.stringify(row.input)).toMatchObject({ code: row.code, path: row.path });
  }
  for (const row of values.badChannels as { input: unknown; code: string; path: string }[]) {
    const reply = await channels.create(page, row.input);
    expect(reply.error, JSON.stringify(row.input)).toMatchObject({ code: row.code, path: row.path });
  }
  expect((await state(page)).bots).toEqual([]);
  expect((await state(page)).channels).toEqual([]);
  // Unknown bots and channels; ids and calls the form does not take.
  expect((await bots.update(page, 'ghost', { role: 'x' })).error.code).toBe('NotFound');
  expect((await bots.remove(page, 'ghost')).error.code).toBe('NotFound');
  expect((await channels.update(page, 'ghost', { name: 'x' })).error).toMatchObject({ code: 'NotFound', path: 'channelId' });
  expect((await channels.remove(page, 'ghost')).error.code).toBe('NotFound');
  for (const [params, path] of [
    [{ family: 'bots', op: 'update', input: {} }, 'botId'], [{ family: 'channels', op: 'remove' }, 'channelId'], [{ family: 'bots', op: 'create', id: 'x', input: { name: 'A' } }, 'id'],
    [{ family: 'bots', op: 'remove', id: 'b', input: { name: 'A' } }, 'input'], [{ family: 'recipes', op: 'create' }, 'family'], [{ family: 'bots', op: 'archive', id: 'b' }, 'op'],
    [{ family: 'bots', op: 'remove', id: 'b', confirmed: true }, 'confirmed'],
  ] as const) {
    expect((await service(page, params as Record<string, unknown>)).error, JSON.stringify(params)).toMatchObject({ code: 'InvalidShape', path });
  }
  // A removed channel is stale for changes.
  const first = await bots.create(page, values.bot);
  const channel = await channels.create(page, { name: 'ops', memberIds: [first.value.id] });
  await hook(page, 'confirmDeletions', { value: false });
  expect((await channels.remove(page, channel.value.id)).ok).toBe(true);
  expect((await channels.update(page, channel.value.id, { name: 'ops-2' })).error.code).toBe('StaleContext');
});

test('extensions workspace automation: no grant, a revoked grant, a package that is not installed and another package are refused natively', async ({ page }) => {
  await boot(page);
  const made = await bots.create(page, values.bot);
  await hook(page, 'revoke');
  for (const reply of [await bots.create(page, values.bot), await bots.update(page, made.value.id, { role: 'x' }), await bots.remove(page, made.value.id), await channels.create(page, { name: 'x', memberIds: [] }), await channels.remove(page, 'c1')]) {
    expect(reply.error).toMatchObject({ code: 'PermissionDenied', path: 'workspace.manage' });
  }
  expect((await state(page)).bots).toHaveLength(1);
  await hook(page, 'grant');
  expect((await bots.update(page, made.value.id, { role: 'x' })).ok).toBe(true);
  await hook(page, 'uninstall');
  expect((await bots.update(page, made.value.id, { role: 'y' })).error.code).toBe('PermissionDenied');
  expect((await bots.create(page, values.bot, OTHER)).error).toMatchObject({ code: 'PermissionDenied', path: 'workspace.manage' });
  expect((await state(page)).bots[0].role).toBe('x');
});

test('extensions workspace automation: a deletion asks the host first by default, a refusal removes nothing and the preference is per package', async ({ page }) => {
  await boot(page);
  await hook(page, 'install', { owner: OTHER }); await hook(page, 'grant', { owner: OTHER });
  const made = await bots.create(page, values.bot);
  const channel = await channels.create(page, { name: 'ops', memberIds: [made.value.id] });
  // The user says no: Cancelled, nothing changes, and the ask names the package and the thing.
  await hook(page, 'answerNext', { accepted: false });
  expect((await bots.remove(page, made.value.id)).error).toMatchObject({ code: 'Cancelled', path: 'confirmation' });
  expect((await state(page)).bots).toHaveLength(1);
  expect((await state(page)).asked[0]).toMatchObject({ owner: OWNER, action: 'bots.remove' });
  expect((await state(page)).asked[0].what).toContain('Scout');
  // The user says yes (the default answer).
  expect((await channels.remove(page, channel.value.id)).ok).toBe(true);
  expect((await state(page)).asked[1]).toMatchObject({ action: 'channels.remove' });
  // Turning the confirmation off is per package: only this package deletes without asking.
  await hook(page, 'confirmDeletions', { value: false });
  const asked = (await state(page)).asked.length;
  expect((await bots.remove(page, made.value.id)).ok).toBe(true);
  expect((await state(page)).asked).toHaveLength(asked);
  const another = await bots.create(page, values.bot, OTHER);
  await hook(page, 'answerNext', { accepted: false });
  expect((await bots.remove(page, another.value.id, OTHER)).error.code).toBe('Cancelled');
  expect((await state(page)).asked).toHaveLength(asked + 1);
  // Turning it on again asks again.
  await hook(page, 'confirmDeletions', { value: true });
  const third = await bots.create(page, values.bot);
  expect((await bots.remove(page, third.value.id)).ok).toBe(true);
  expect((await state(page)).asked).toHaveLength(asked + 2);
});

test('extensions workspace automation: the window shows the host confirmation, answers it and every change is attributed to its package', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const seen: unknown[] = []; (window as any).__confirms = seen;
    return (window as any).__workspaceAutomation.start(async (options: unknown) => { seen.push(options); return true; });
  });
  const made = await bots.create(page, values.bot);
  expect((await bots.remove(page, made.value.id)).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__confirms.length), { timeout: 15_000 }).toBe(1);
  const options = await page.evaluate(() => (window as any).__confirms[0]);
  expect(options).toMatchObject({ title: 'Delete this bot?', button: 'Delete bot' });
  expect(options.text).toContain(OWNER);
  expect(options.text).toContain('Scout');
  expect(options.text).toContain('workspace folder stays on disk');
  // Attribution: the ledger keeps the newest origin per bot and channel, naming the package, after the thing is gone.
  const channelMade = await channels.create(page, { name: 'ops', memberIds: [] });
  await hook(page, 'confirmDeletions', { value: false });
  await channels.remove(page, channelMade.value.id);
  const origins = (await ipc(page, 'extensions_workspace_automation_origins')) as { origins: Record<string, { package: string; action: string }> };
  expect(origins.origins[`bot:${made.value.id}`]).toMatchObject({ package: OWNER, action: 'removed' });
  expect(origins.origins[`channel:${channelMade.value.id}`]).toMatchObject({ package: OWNER, action: 'removed' });
  const kept = await bots.create(page, values.bot);
  const bot = (await state(page)).bots.find((entry: any) => entry.id === kept.value.id);
  expect(bot.activity).toEqual([`Created by extension ${OWNER}`]);
  await bots.update(page, kept.value.id, { role: 'x' });
  expect((await state(page)).bots.find((entry: any) => entry.id === kept.value.id).activity).toEqual([`Created by extension ${OWNER}`, `Settings changed by extension ${OWNER}`]);
});
