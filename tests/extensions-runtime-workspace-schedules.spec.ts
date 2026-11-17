import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0406B (recipes and wake-ups). The browser has no service process: `extensions_workspace_schedules_service`
// answers a service call exactly as the native `serve` does (same ids, shapes, refusal envelope, grant scoping, confirmation
// and attribution). The native rules are proven by `runtime_workspace_schedules::tests` (cargo, feature-less); an installed run
// with a real service, the recipe files and the schedules database is the native fixture's and the final qualification's.
const cases = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-workspace-schedules/cases.json', import.meta.url), 'utf8')) as Record<string, any>;
const OWNER = 'sample.runtime-workspace-schedules';
test.setTimeout(90_000);

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__workspaceSchedules.call(command, args), [command, args] as const);
const hook = (page: Page, op: string, extra: Record<string, unknown> = {}) => ipc(page, 'extensions_workspace_schedules_preview', { op, owner: OWNER, ...extra }) as Promise<any>;
const recipes = (page: Page, params: Record<string, unknown>, owner = OWNER) => ipc(page, 'extensions_workspace_schedules_service', { owner, method: 'workspaceRecipes', params }) as Promise<any>;
const wakeups = (page: Page, params: Record<string, unknown>, owner = OWNER) => ipc(page, 'extensions_workspace_schedules_service', { owner, method: 'workspaceWakeups', params }) as Promise<any>;

async function boot(page: Page, grant: Record<string, unknown> = {}) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?workspace-schedules'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__workspaceSchedules);
  await hook(page, 'install', { name: 'Recipes and wake-ups' }); await hook(page, 'grant', grant);
}

test('extensions workspace recipes: save, list, update, run and remove with package attribution', async ({ page }) => {
  await boot(page);
  await hook(page, 'confirm', { confirmDeletions: false });
  const saved = await recipes(page, { op: 'save', recipe: cases.recipe });
  expect(saved).toEqual({ ok: true, value: { id: 'project:project-1:review-diff' } });
  expect((await recipes(page, { op: 'save', recipe: cases.globalRecipe })).value.id).toBe('global:wrap-up');
  const listed = (await recipes(page, { op: 'list', projectId: 'project-1' })).value as any[];
  expect(listed.map(recipe => recipe.id).sort()).toEqual(['global:wrap-up', 'project:project-1:review-diff']);
  expect(listed.every(recipe => recipe.by === 'Recipes and wake-ups')).toBe(true);
  // Saving again under the same name is an update, not a second recipe.
  const updated = { ...cases.recipe, description: 'Changed', steps: [{ kind: 'prompt', text: 'Review again.' }] };
  expect((await recipes(page, { op: 'save', recipe: updated })).ok).toBe(true);
  const again = (await recipes(page, { op: 'list', projectId: 'project-1' })).value as any[];
  expect(again.find(recipe => recipe.id === 'project:project-1:review-diff')).toMatchObject({ description: 'Changed', steps: [{ kind: 'prompt', text: 'Review again.' }] });
  expect(again).toHaveLength(2);
  // Run queues each message as an ordinary one, labelled with the package, and leaves one line in the thread.
  expect((await recipes(page, { op: 'save', recipe: cases.recipe })).ok).toBe(true);
  const run = await recipes(page, { op: 'run', recipeId: 'project:project-1:review-diff', options: { taskId: 'task-1' } });
  expect(run.ok).toBe(true);
  expect(run.value).toMatchObject({ recipeId: 'project:project-1:review-diff', taskId: 'task-1', queued: 3 });
  const state = await hook(page, 'state');
  expect(state.queue['task-1'].map((entry: any) => entry.text)).toEqual(['Review the diff.', '/review', 'Run the project checks and report.']);
  expect(state.queue['task-1'].every((entry: any) => entry.by === 'Recipes and wake-ups')).toBe(true);
  expect(state.transcript.at(-1)).toContain('run by Recipes and wake-ups');
  expect((await ipc(page, 'extensions_workspace_origins') as any).entries['recipe:project:project-1:review-diff']).toMatchObject({ owner: OWNER, package: 'Recipes and wake-ups' });
  // Remove (no confirmation: the user turned it off for this package) forgets the recipe and its attribution.
  expect(await recipes(page, { op: 'remove', recipeId: 'project:project-1:review-diff' })).toEqual({ ok: true, value: null });
  expect((await hook(page, 'state')).recipes).toEqual(['global/wrap-up']);
  expect((await recipes(page, { op: 'remove', recipeId: 'project:project-1:review-diff' })).error).toMatchObject({ code: 'NotFound', path: 'recipeId' });
});

test('extensions workspace recipes: a blocked step queues nothing, ids and shapes are refused natively', async ({ page }) => {
  await boot(page);
  await recipes(page, { op: 'save', recipe: cases.blockedRecipe });
  const blocked = await recipes(page, { op: 'run', recipeId: 'project:project-1:needs-deploy', options: { taskId: 'task-1' } });
  expect(blocked.error).toMatchObject({ code: 'UnsupportedCapability', path: 'recipeId', ids: ['step-2'] });
  expect((await hook(page, 'state')).queue['task-1']).toBeUndefined();
  // A project recipe of another project is not found from this task; unknown tasks and recipes are NotFound.
  expect((await recipes(page, { op: 'run', recipeId: 'project:project-1:needs-deploy', options: { taskId: 'task-2' } })).error).toMatchObject({ code: 'NotFound', path: 'recipeId' });
  expect((await recipes(page, { op: 'run', recipeId: 'global:ghost', options: { taskId: 'task-1' } })).error).toMatchObject({ code: 'NotFound', path: 'recipeId' });
  expect((await recipes(page, { op: 'run', recipeId: 'global:ghost', options: { taskId: 'task-9' } })).error).toMatchObject({ code: 'NotFound', path: 'taskId' });
  for (const [params, code, path] of [
    [{ op: 'run', recipeId: 'ghost', options: { taskId: 'task-1' } }, 'InvalidShape', 'recipeId'],
    [{ op: 'run', recipeId: 'global:ok', options: { taskId: 'task-1', provider: 'claude' } }, 'InvalidShape', 'options.provider'],
    [{ op: 'run', recipeId: 'global:ok' }, 'InvalidShape', 'options'],
    [{ op: 'save', recipe: { ...cases.recipe, scope: 'user' } }, 'InvalidShape', 'recipe.scope'],
    [{ op: 'save', recipe: { ...cases.recipe, steps: [] } }, 'LimitExceeded', 'recipe'],
    [{ op: 'save', recipe: { ...cases.recipe, name: 'Bad Name' } }, 'InvalidShape', 'recipe'],
    [{ op: 'save', recipe: { ...cases.recipe, steps: [{ kind: 'prompt', text: 'x', secret: 1 }] } }, 'InvalidShape', 'recipe.steps[0]'],
    [{ op: 'save', recipe: cases.recipe, remote: true }, 'InvalidShape', 'remote'],
    [{ op: 'delete', recipeId: 'global:x' }, 'InvalidShape', '$'],
  ] as const) {
    const reply = await recipes(page, params as Record<string, unknown>);
    expect(reply.error, JSON.stringify(params)).toMatchObject({ code, path });
  }
});

test('extensions workspace wake-ups: create, update, list and remove with package attribution and scoped grants', async ({ page }) => {
  await boot(page, { projects: ['project-1'] });
  await hook(page, 'confirm', { confirmDeletions: false });
  const created = await wakeups(page, { op: 'create', input: cases.wakeup });
  expect(created.ok).toBe(true);
  expect(created.value).toMatchObject({ sessionId: 'task-1', title: 'Morning check', kind: 'daily', timeOfDay: '09:30', maxRuns: 5, by: 'Recipes and wake-ups' });
  const id = created.value.id as string;
  expect((await wakeups(page, { op: 'update', wakeupId: id, input: cases.wakeupUpdate })).value).toMatchObject({ id, title: 'Evening check', kind: 'interval', intervalMinutes: 90 });
  expect(((await wakeups(page, { op: 'list' })).value as any[]).map(wakeup => wakeup.id)).toEqual([id]);
  expect(((await wakeups(page, { op: 'list', taskId: 'task-1' })).value as any[]).map(wakeup => wakeup.id)).toEqual([id]);
  expect((await ipc(page, 'extensions_workspace_origins') as any).entries[`wakeup:${id}`]).toMatchObject({ owner: OWNER });
  // A project the grant is narrowed away from answers PermissionDenied on every operation, and changes nothing.
  for (const params of [{ op: 'create', input: cases.foreignWakeup }, { op: 'list', taskId: 'task-2' }]) {
    expect((await wakeups(page, params)).error, JSON.stringify(params)).toMatchObject({ code: 'PermissionDenied', path: 'workspace.manage' });
  }
  expect((await wakeups(page, { op: 'update', wakeupId: id, input: cases.foreignWakeup })).error.code).toBe('PermissionDenied');
  expect((await wakeups(page, { op: 'create', input: { ...cases.wakeup, watchSessionId: 'task-2', kind: 'after' } })).error.code).toBe('PermissionDenied');
  expect((await hook(page, 'state')).wakeups).toEqual([id]);
  // Cadence rules and shapes.
  for (const [input, code, path] of [
    [{ ...cases.wakeup, prompt: '  ' }, 'InvalidShape', 'input'], [{ ...cases.wakeup, kind: 'hourly' }, 'InvalidShape', 'input'], [{ ...cases.wakeup, maxRuns: 5000 }, 'LimitExceeded', 'input'],
    [{ ...cases.wakeup, sessionId: 'task-9' }, 'NotFound', 'input.sessionId'], [{ ...cases.wakeup, createdBy: 'agent' }, 'InvalidShape', 'input.createdBy'], [{ ...cases.wakeup, days: 'mon' }, 'InvalidShape', 'input'],
  ] as const) expect((await wakeups(page, { op: 'create', input })).error, JSON.stringify(input)).toMatchObject({ code, path });
  expect(await wakeups(page, { op: 'remove', wakeupId: id })).toEqual({ ok: true, value: null });
  expect((await wakeups(page, { op: 'remove', wakeupId: id })).error).toMatchObject({ code: 'NotFound', path: 'wakeupId' });
  expect((await hook(page, 'state')).entries[`wakeup:${id}`]).toBeUndefined();
});

test('extensions workspace schedules: irreversible removals ask the host by default and a refusal is Cancelled', async ({ page }) => {
  await boot(page);
  await recipes(page, { op: 'save', recipe: cases.globalRecipe });
  const wake = (await wakeups(page, { op: 'create', input: cases.wakeup })).value.id as string;
  // Default: the host asks, naming the package and what is destroyed; a refusal keeps everything.
  await hook(page, 'confirm', { answer: 'cancel' });
  expect((await recipes(page, { op: 'remove', recipeId: 'global:wrap-up' })).error.code).toBe('Cancelled');
  expect((await wakeups(page, { op: 'remove', wakeupId: wake })).error.code).toBe('Cancelled');
  let state = await hook(page, 'state');
  expect(state.recipes).toEqual(['global/wrap-up']);
  expect(state.wakeups).toEqual([wake]);
  expect(state.dialogs.map((dialog: any) => dialog.title)).toEqual(['Recipes and wake-ups wants to remove recipe “wrap-up”', 'Recipes and wake-ups wants to remove wake-up “Morning check”']);
  // Accepting removes; the user turning the confirmation off for the package removes without asking, and the asking is per package.
  await hook(page, 'confirm', { answer: 'accept' });
  expect((await recipes(page, { op: 'remove', recipeId: 'global:wrap-up' })).ok).toBe(true);
  await hook(page, 'confirm', { confirmDeletions: false });
  const asked = (await hook(page, 'state')).dialogs.length;
  expect((await wakeups(page, { op: 'remove', wakeupId: wake })).ok).toBe(true);
  state = await hook(page, 'state');
  expect([state.recipes, state.wakeups, state.dialogs.length]).toEqual([[], [], asked]);
});

test('extensions workspace schedules: revoke, uninstall and a foreign package preserve unrelated work; a revoke mid-run stops the queue', async ({ page }) => {
  await boot(page);
  await hook(page, 'confirm', { confirmDeletions: false });
  await recipes(page, { op: 'save', recipe: cases.recipe });
  const wake = (await wakeups(page, { op: 'create', input: cases.wakeup })).value.id as string;
  // A revoke between two messages of a run leaves what was queued, queues no more and names the queued entries.
  await hook(page, 'revokeAfterQueued', { count: 1 });
  const cut = await recipes(page, { op: 'run', recipeId: 'project:project-1:review-diff', options: { taskId: 'task-1' } });
  expect(cut.error).toMatchObject({ code: 'PermissionDenied', path: 'workspace.manage' });
  expect(cut.error.ids).toHaveLength(1);
  expect((await hook(page, 'state')).queue['task-1']).toHaveLength(1);
  // Without the grant (revoked, never granted, package not installed) every call is PermissionDenied and nothing changes.
  const checks: [string, Record<string, unknown>][] = [
    ['recipes', { op: 'list', projectId: 'project-1' }], ['recipes', { op: 'save', recipe: cases.recipe }], ['recipes', { op: 'remove', recipeId: 'project:project-1:review-diff' }],
    ['recipes', { op: 'run', recipeId: 'project:project-1:review-diff', options: { taskId: 'task-1' } }],
    ['wakeups', { op: 'list' }], ['wakeups', { op: 'create', input: cases.wakeup }], ['wakeups', { op: 'update', wakeupId: wake, input: cases.wakeupUpdate }], ['wakeups', { op: 'remove', wakeupId: wake }],
  ];
  const as = (kind: string, params: Record<string, unknown>, owner: string) => (kind === 'recipes' ? recipes(page, params, owner) : wakeups(page, params, owner));
  for (const owner of [OWNER, 'other.package']) for (const [kind, params] of checks) expect((await as(kind, params, owner)).error, `${owner} ${JSON.stringify(params)}`).toMatchObject({ code: 'PermissionDenied', path: 'workspace.manage' });
  const after = await hook(page, 'state');
  expect([after.recipes, after.wakeups, after.queue['task-1'].length]).toEqual([['project-1/review-diff'], [wake], 1]);
  // Granting again restores access to the same unrelated work; uninstalling removes the package's authority without touching it.
  await hook(page, 'grant');
  expect(((await wakeups(page, { op: 'list' })).value as any[]).map(wakeup => wakeup.id)).toEqual([wake]);
  await hook(page, 'uninstall');
  expect((await wakeups(page, { op: 'list' })).error.code).toBe('PermissionDenied');
  expect((await hook(page, 'state')).wakeups).toEqual([wake]);
});
