import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { DecisionFold, type Outcome } from '../src/extensions/runtime-hook-decisions';
import { PromptFold, blockedMessage } from '../src/extensions/runtime-hook-context';
import {
  changeOrder, effectiveBudget, effectiveOrder, emptyOrderFile, FailureStreaks, noticeText, orderProjection, parseOrderFile,
  resolveHookOrder, simulateChain, syncOrder, type ChainMember, type OrderChange, type OrderFile, type OrderSnapshot,
} from '../src/extensions/runtime-hook-resolution';
// Preview column of R0506 (hook chains across packages: the user's order in _hooks.json, the frozen first-enabled
// default, budgets, late answers, failure policies and their notice). The browser preview runs no service, so most of
// this spec runs in the test runner's Node: it reads the shared fixtures through the webview twin
// (src/extensions/runtime-hook-resolution.ts) of the native module (src-tauri/src/extensions/runtime_hook_resolution.rs,
// whose tests read the same fixtures with a paused clock and the real member runner), drives the two fixture packages
// (alpha/ and beta/ main.cjs) through a stand-in of the service SDK, and mounts the Settings -> Extensions control in
// the page against the synthetic store. No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-hook-resolution/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const order = read('order.json');
const chains = read('chains.json');
const streaks = read('streaks.json');
type Obj = Record<string, any>;

const outcomeJson = (outcome: Outcome): Obj => {
  if (outcome.kind === 'none') return { kind: 'none' };
  if (outcome.kind === 'approve') return { kind: 'approve', by: outcome.by.owner, failed: outcome.by.failed, input: outcome.input };
  return { kind: outcome.kind, by: outcome.by.owner, failed: outcome.by.failed, reason: outcome.by.reason };
};

test.describe('R0506 hook chains and failure policy', () => {
  test('extensions hook resolution: the order corpus resolves like the native module', () => {
    for (const scripted of order.resolve as Obj[]) expect(resolveHookOrder(scripted.user, scripted.firstEnabled, scripted.ids), scripted.id).toEqual(scripted.expect);
  });

  test('extensions hook resolution: the order file lives through the script (restart, disable, reinstall, collision, safe mode, damage)', () => {
    // The same model as HookOrder: one file on disk, the state in memory, a damaged file kept until the user's change.
    let disk: string | null = null, file: OrderFile = emptyOrderFile(), corrupt = false;
    const reopen = () => {
      if (disk === null) { file = emptyOrderFile(); corrupt = false; return; }
      let parsed: OrderFile | null = null;
      try { parsed = parseOrderFile(JSON.parse(disk)); } catch { parsed = null; }
      file = parsed ?? emptyOrderFile(); corrupt = parsed === null;
    };
    for (const step of order.script as Obj[]) {
      if (step.do === 'sync') { if (syncOrder(file, step.snapshot as OrderSnapshot) && !corrupt) disk = JSON.stringify(file); }
      else if (step.do === 'change') {
        const next: OrderFile = structuredClone(file);
        let error: string | null = null;
        try { syncOrder(next, step.snapshot); changeOrder(next, step.request as OrderChange, step.snapshot); file = next; corrupt = false; disk = JSON.stringify(file); }
        catch (failure) { error = (failure as Error).message; }
        expect(error, step.id).toBe(step.error ?? null);
      } else if (step.do === 'restart') reopen();
      else if (step.do === 'damage') { disk = '{ not json'; reopen(); }
      if ('order' in step) expect(file.order, `${step.id}: order`).toEqual(step.order);
      if ('firstEnabled' in step) expect(file.firstEnabled, `${step.id}: firstEnabled`).toEqual(step.firstEnabled);
      if ('effective' in step) expect(effectiveOrder(file), `${step.id}: effective`).toEqual(step.effective);
      if ('available' in step) expect(!corrupt, `${step.id}: available`).toBe(step.available);
      if ('shown' in step) expect(orderProjection(file, step.snapshot, new FailureStreaks(), corrupt).packages.map(item => [item.id, item.placed]), `${step.id}: shown`).toEqual(step.shown);
      if (!corrupt && disk !== null) { const stored = JSON.parse(disk); expect(stored.schema).toBe(1); expect(stored.order).toEqual(file.order); }
    }
  });

  test('extensions hook resolution: budgets keep the event ceiling and the 60 s chain', () => {
    expect(effectiveBudget('tool.before', 45_000, 0)).toBe(30_000);
    expect(effectiveBudget('prompt.submit', 45_000, 0)).toBe(10_000);
    expect(effectiveBudget('compaction', 120_000, 0)).toBe(60_000);
    expect(effectiveBudget('tool.before', 50, 0)).toBe(100);
    expect(effectiveBudget('tool.before', 2_000, 59_000)).toBe(1_000);
    expect(effectiveBudget('tool.before', 2_000, 60_000)).toBe(0);
  });

  test('extensions hook resolution: three failures in a row give one notice', () => {
    for (const scripted of streaks.cases as Obj[]) {
      const counter = new FailureStreaks();
      expect((scripted.steps as (string | null)[]).map(step => counter.record('sample.hook-a', 'tool.before', step)), scripted.id).toEqual(scripted.notices);
    }
    expect(noticeText('Alpha', 'tool.before', 'Timeout', 'deny')).toBe("Alpha's tool.before hook failed 3 times in a row (Timeout). As it declared, tool calls are denied while it fails. Check it in Settings > Extensions.");
    const native = readFileSync(new URL('../src-tauri/src/extensions/runtime_hook_resolution.rs', import.meta.url), 'utf8');
    expect(native).toContain('As it declared, {meanwhile}. Check it in Settings > Extensions.');
    expect(native).toContain('pub const NOTICE_AFTER: u32 = 3;');
  });

  for (const scripted of chains.cases as Obj[]) {
    test(`extensions hook resolution: chain on a controlled clock: ${scripted.id}`, () => {
      const members = scripted.members as ChainMember[];
      const ordered = resolveHookOrder(scripted.order.user, scripted.order.firstEnabled, members.map(member => member.owner)).map(owner => members.find(member => member.owner === owner)!);
      const expected = scripted.expect;
      if (scripted.event === 'tool.before') {
        const fold = new DecisionFold(scripted.can);
        const run = simulateChain('tool.before', ordered, fold, scripted.payload);
        expect({ asked: run.asked, removed: run.removed, failures: run.failures, late: run.late, elapsedMs: run.elapsedMs }).toEqual({ asked: expected.asked, removed: expected.removed, failures: expected.failures, late: expected.late, elapsedMs: expected.elapsedMs });
        expect(outcomeJson(fold.outcome())).toEqual(expected.outcome);
        expect(fold.settled().map(receipt => ({ owner: receipt.owner, applied: receipt.applied, code: receipt.code ?? null, overriddenBy: receipt.overriddenBy ?? null }))).toEqual(expected.receipts);
        // A failure never approves: a failed member is never the one that approved.
        const outcome = fold.outcome();
        if (outcome.kind === 'approve') expect(outcome.by.failed).toBe(false);
        // Each shown decision names its owner (the line and tool.after's decidedBy come from `by`).
        if (outcome.kind !== 'none') expect(members.some(member => member.owner === outcome.by.owner)).toBe(true);
      } else {
        const fold = new PromptFold(scripted.payload.text);
        const run = simulateChain('prompt.submit', ordered, fold, scripted.payload);
        expect({ asked: run.asked, removed: run.removed, failures: run.failures, late: run.late, elapsedMs: run.elapsedMs }).toEqual({ asked: expected.asked, removed: expected.removed, failures: expected.failures, late: expected.late, elapsedMs: expected.elapsedMs });
        expect({ text: fold.text, blocked: fold.blocked && { by: fold.blocked.by, failed: fold.blocked.failed, message: blockedMessage(fold.blocked) } }).toEqual(expected.prompt);
      }
    });
  }

  test('extensions hook resolution: the two fixture packages are valid and their rewrites follow the order', async () => {
    const require = createRequire(import.meta.url);
    const packages: Obj[] = [];
    const handlers = new Map<string, (call: Obj) => unknown>();
    for (const name of ['alpha', 'beta']) {
      const manifest = read(`${name}/extension.json`);
      packages.push(manifest);
      const main = require(fileURLToPath(new URL(`${name}/main.cjs`, fixtures)));
      await main.service({
        hooks: { on: (_event: string, handler: (call: Obj) => unknown) => { handlers.set(manifest.id, handler); return { ready: Promise.resolve(), dispose: () => handlers.delete(manifest.id) }; }, onApplied: () => ({ dispose: () => undefined }) },
        commands: { register: () => ({ dispose: () => undefined }) },
      }, { onStop: () => undefined });
    }
    expect((validateContract('packages', packages) as Obj).ok).toBe(true);
    expect(packages.map(item => item.contributes.hooks[0])).toEqual([
      { id: 'sample.hook-alpha/before', event: 'tool.before', onFailure: 'deny', budgetMs: 1000 },
      { id: 'sample.hook-beta/before', event: 'tool.before', onFailure: 'ask', budgetMs: 2000 },
    ]);
    const names: Record<string, string> = { 'sample.hook-alpha': 'Alpha', 'sample.hook-beta': 'Beta' };
    const run = async (owners: string[], command: string) => {
      const fold = new DecisionFold(['approve', 'deny', 'ask', 'rewriteInput']);
      for (const owner of owners) {
        if (fold.stopped()) break;
        const payload = fold.payload({ callId: 'c1', tool: { kind: 'shell', name: 'Bash' }, input: { command }, inputComplete: true });
        let answer: { value: any } | { error: string };
        try { answer = { value: (await handlers.get(owner)!(payload)) ?? null }; } catch (error) { answer = { error: (error as Error).message }; }
        fold.step({ owner, name: names[owner], onFailure: owner === 'sample.hook-alpha' ? 'deny' : 'ask', grants: ['harness.hooks.decide'], answer });
      }
      return fold;
    };
    const byDefault = resolveHookOrder([], ['sample.hook-alpha', 'sample.hook-beta'], Object.keys(names));
    const byUser = resolveHookOrder(['sample.hook-beta'], ['sample.hook-alpha', 'sample.hook-beta'], Object.keys(names));
    expect(outcomeJson((await run(byDefault, 'npm test')).outcome())).toEqual({ kind: 'approve', by: 'sample.hook-beta', failed: false, input: { command: 'yarn test' } });
    expect(outcomeJson((await run(byUser, 'npm test')).outcome())).toEqual({ kind: 'approve', by: 'sample.hook-alpha', failed: false, input: { command: 'pnpm test' } });
    // A deny wins in either order; a throw under onFailure deny denies and names the package.
    for (const owners of [byDefault, byUser]) expect(outcomeJson((await run(owners, 'rm -rf build')).outcome())).toEqual({ kind: 'deny', by: 'sample.hook-beta', failed: false, reason: 'rm -rf is not allowed' });
    expect(outcomeJson((await run(byDefault, 'explode')).outcome())).toEqual({ kind: 'deny', by: 'sample.hook-alpha', failed: true, reason: 'Alpha did not answer (Boom).' });
    expect(outcomeJson((await run(byDefault, 'bad')).outcome())).toEqual({ kind: 'deny', by: 'sample.hook-alpha', failed: true, reason: 'Alpha did not answer (InvalidShape).' });
  });

  test('extensions hook resolution: both chains, the registry and the preview use the one native order', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const registration = source('../src-tauri/src/extensions/runtime_hook_registration.rs');
    // Both chain loops ask through the shared member runner; the registry sorts attached hooks by the order.
    expect(source('../src-tauri/src/extensions/runtime_hook_context.rs')).toContain('runtime_hook_resolution::ask_member(');
    expect(source('../src-tauri/src/extensions/runtime_hook_decisions.rs')).toContain('runtime_hook_resolution::ask_member(');
    expect(registration).toContain('pub fn set_order(');
    expect(registration).toContain('runtime_hook_resolution::service_ended(');
    // The settings control and the preview read and write the native store's commands, never a webview-only order.
    expect(source('../src/extensions/settings.ts')).toContain('mountHookOrder(');
    const preview = source('../src/extensions/preview.ts');
    expect(preview).toContain("'extensions_hook_order'");
    expect(preview).toContain("'extensions_hook_order_change'");
    const lib = source('../src-tauri/src/lib.rs');
    expect(lib).toContain('runtime_hook_resolution::extensions_hook_order,');
    expect(lib).toContain('runtime_hook_resolution::extensions_hook_order_change,');
    expect(lib).toContain('runtime_hook_resolution::HookOrder::open(&dir)');
  });

  test('extensions hook resolution: the settings control moves a package through the store and keeps keyboard focus', async ({ page }) => {
    await page.route(url => new URL(url).pathname === '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Hook order fixture</title></head><body><section id="host" aria-label="Hook order"></section></body></html>' }));
    await page.goto('/');
    await page.evaluate(async () => {
      const module = await import('/src/extensions/runtime-hook-resolution.ts' as string);
      const values = new Map<string, string>();
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
      const snapshot = { safeMode: false, packages: [
        { manifest: { id: 'sample.hook-alpha', name: 'Alpha', contributes: { hooks: [{ event: 'tool.before' }] } }, enabled: true },
        { manifest: { id: 'sample.hook-beta', name: 'Beta', contributes: { hooks: [{ event: 'tool.before' }] } }, enabled: true },
        { manifest: { id: 'sample.hook-gamma', name: 'Gamma', contributes: { hooks: [{ event: 'prompt.submit' }] } }, enabled: false },
      ] };
      const store = module.createHookOrderPreview(storage, 'hooks');
      const w = window as any;
      w.__hooks = { values, store };
      module.mountHookOrder(document.querySelector('#host')!, {
        load: async () => store.call('extensions_hook_order', {}, snapshot),
        change: async (request: unknown) => store.call('extensions_hook_order_change', { request }, snapshot),
      });
    });
    const rows = page.locator('[data-hook-order-row]');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('strong')).toHaveText(['1. Alpha', '2. Beta', '3. Gamma']);
    await expect(rows.nth(2)).toContainText('Disabled');
    await page.getByRole('button', { name: 'Move Beta up' }).focus();
    await page.keyboard.press('Enter');
    await expect(rows.locator('strong')).toHaveText(['1. Beta', '2. Alpha', '3. Gamma']);
    // Focus follows the moved package; at the top its Move up is disabled, so focus lands on its Move down.
    await expect(page.getByRole('button', { name: 'Move Beta down' })).toBeFocused();
    await expect(rows.first()).toContainText('Placed by you');
    // What the control shows is what the store holds: _hooks.json's shape with the user's order.
    const stored = await page.evaluate(() => JSON.parse((window as any).__hooks.values.get('hooks')));
    expect(stored).toEqual({ schema: 1, order: ['sample.hook-beta', 'sample.hook-alpha', 'sample.hook-gamma'], firstEnabled: ['sample.hook-alpha', 'sample.hook-beta'] });
    await page.getByRole('button', { name: 'Reset to the default order' }).click();
    await expect(rows.locator('strong')).toHaveText(['1. Alpha', '2. Beta', '3. Gamma']);
    await expect(page.getByRole('button', { name: 'Reset to the default order' })).toHaveCount(0);
  });
});
