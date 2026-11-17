import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { builtinSupport, providerSupport, type Json } from '../src/extensions/runtime-hook-payload';
import { requestCoverage, row, type Harness } from '../src/extensions/runtime-harness-coverage';
import { action, ASK_AT_HOST, ASK_AT_HOST_SOURCE, callCan, DecisionFold, launchAsks, route, type Action, type Outcome } from '../src/extensions/runtime-hook-decisions';
import type { Step } from '../src/extensions/runtime-hook-context';
// Preview column of R0505 (tool.before decisions: approve, deny with a reason, ask, rewrite; scoped ask-at-host in
// full). The browser preview runs no harness, so this spec runs in the test runner's Node: it folds the shared
// scripted returns through the webview twin (src/extensions/runtime-hook-decisions.ts) of the native resolver
// (src-tauri/src/extensions/runtime_hook_decisions.rs, whose tests read the same fixtures), checks `can`, coverage
// and the full-mode launch rule against the shared table, replays the demonstration (identical calls with no hook,
// an observe-only hook, a deciding hook and a revoked hook) and drives the fixture service (main.cjs) through a
// stand-in of the service SDK. No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-hook-decisions/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const decisions = read('decisions.json');
const modes = read('modes.json');
const scenarios = read('scenarios.json');
type Obj = Record<string, any>;

const harness = (id: string): Harness => ({ id, name: id, package: id.includes('/') ? id.split('/')[0] : null, installed: 'Unknown' });
const support = (id: string) => id.includes('/') ? providerSupport(null) : builtinSupport(id);
const coverage = (id: string, mode: string) => { const raw = requestCoverage(harness(id), mode); return raw === 'none' ? 'askedCalls' : raw; };
const outcomeJson = (outcome: Outcome): Obj => {
  if (outcome.kind === 'none') return { kind: 'none' };
  const by = { kind: outcome.kind, by: outcome.by.owner, reason: outcome.by.reason, failed: outcome.by.failed };
  return outcome.kind === 'approve' ? { ...by, input: outcome.input } : by;
};
const actionJson = (taken: Action): Obj => taken.kind === 'prompt'
  ? { kind: 'prompt', note: taken.note }
  : taken.kind === 'deny'
    ? { kind: 'deny', decidedBy: taken.answer.decidedBy ?? null, reason: taken.answer.reason ?? null }
    : { kind: 'approve', decidedBy: taken.answer.decidedBy ?? null, reason: taken.answer.reason ?? null, input: taken.answer.input ?? null };
const paths: Record<string, [boolean, boolean]> = { request: [false, true], askAtHost: [true, true], standing: [true, false] };

test.describe('R0505 tool.before decisions', () => {
  test('extensions hook decisions: the fixture package is valid and declares a deciding tool.before hook', () => {
    const result = validateContract('packages', [manifest]) as Obj;
    expect(result.ok).toBe(true);
    expect(manifest.contributes.hooks).toEqual([{ id: 'sample.hook-guard/before', event: 'tool.before', onFailure: 'ask', budgetMs: 2000 }]);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['harness.hooks.observe', 'harness.hooks.decide']));
  });

  for (const scripted of decisions.cases as Obj[]) {
    test(`extensions hook decisions: scripted returns: ${scripted.id}`, () => {
      const fold = new DecisionFold(scripted.can);
      const seen: Json[] = [];
      let asked = 0;
      for (const step of scripted.steps as Step[]) {
        if (fold.stopped()) break;
        seen.push(fold.payload(scripted.payload).input);
        fold.step(step);
        asked += 1;
      }
      const expected = scripted.expect;
      expect(outcomeJson(fold.outcome())).toEqual(expected.outcome);
      expect(asked).toBe(expected.asked);
      expect(fold.settled()).toEqual(expected.receipts);
      expect(fold.notes).toEqual(expected.notes);
      if (expected.seen) expect(seen).toEqual(expected.seen);
      for (const [path, wanted] of Object.entries(expected.actions as Obj)) {
        const [askAtHost, auto] = paths[path];
        expect(actionJson(action(fold.outcome(), askAtHost, auto))).toEqual(wanted);
      }
    });
  }

  test('extensions hook decisions: can, coverage and the full-mode launch follow the shared table', () => {
    for (const call of modes.calls as Obj[]) {
      expect(callCan(support(call.harness), call.source, call.harness, call.mode, call.kind, call.lasting), JSON.stringify(call)).toEqual(call.can);
      const reported = call.source === ASK_AT_HOST_SOURCE ? 'askedCalls' : coverage(call.harness, call.mode);
      expect(reported, JSON.stringify(call)).toBe(call.coverage);
      // Sandbox escalations and permission requests are never reported as every-call coverage.
      expect(reported).not.toBe('everyCall');
    }
    for (const launch of modes.launches as Obj[]) expect(launchAsks(launch.mode, launch.harness) && launch.held, JSON.stringify(launch)).toBe(launch.asks);
    expect([route(1, false, true), route(0, false, true), route(0, true, true), route(0, true, false)]).toEqual(['chain', 'pass', 'approve', 'pass']);
    // The capability report's feasible ask-at-host cells are exactly the harnesses launched that way, and its `can`
    // is the delivered one (no approve where the sandbox holds the request).
    for (const id of ['claude', 'codex', 'opencode', 'kilo', 'cline', 'kimi', 'grok', 'commandcode', 'github-copilot', 'hermes', 'zcode', 'deepseek', 'devin', 'antigravity']) {
      const capabilities = row(harness(id)) as Obj;
      const feasible = (capabilities.hooks.toolBefore.full.feasible as Obj[]).some(entry => entry.source === ASK_AT_HOST_SOURCE);
      expect(feasible, id).toBe((ASK_AT_HOST as readonly string[]).includes(id));
    }
    const native = readFileSync(new URL('../src-tauri/src/extensions/runtime_hook_decisions.rs', import.meta.url), 'utf8');
    const listed = native.match(/pub const ASK_AT_HOST: \[&str; \d+\] = \[([^\]]+)\]/)![1].match(/"([^"]+)"/g)!.map(item => item.slice(1, -1));
    expect(listed).toEqual([...ASK_AT_HOST]);
    expect((row(harness('codex')) as Obj).hooks.toolBefore.ask.can).toEqual(['deny', 'ask']);
    expect((row(harness('claude')) as Obj).hooks.toolBefore.ask.can).toEqual(['approve', 'deny', 'ask', 'rewriteInput']);
  });

  test('extensions hook decisions: identical calls with no hook, an observer, a decider and a revoked hook', async () => {
    const require = createRequire(import.meta.url);
    const main = require(fileURLToPath(new URL('main.cjs', fixtures)));
    const slot: { handler: ((call: Obj) => unknown) | null } = { handler: null };
    await main.service({
      hooks: { on: (_event: string, attached: (call: Obj) => unknown) => { slot.handler = attached; return { ready: Promise.resolve(), dispose: () => { slot.handler = null; } }; }, onApplied: () => ({ dispose: () => undefined }) },
      commands: { register: () => ({ dispose: () => undefined }) },
    }, { onStop: () => undefined });
    for (const scenario of scenarios.cases as Obj[]) {
      const expected = scenario.expect;
      const decider = scenario.hook === 'decider';
      const observer = scenario.hook === 'observer';
      const askAtHost = launchAsks(scenario.mode, scenario.harness) && decider;
      const launchMode = askAtHost ? 'ask' : scenario.mode;
      expect(launchMode, scenario.id).toBe(expected.launchMode);
      const arrives = requestCoverage(harness(scenario.harness), launchMode) !== 'none';
      expect(arrives, scenario.id).toBe(expected.request);
      if (!arrives) continue;
      const taken = route(decider ? 1 : 0, askAtHost, true);
      expect(taken, scenario.id).toBe(expected.route);
      let awaited = 0;
      let result: Action = action({ kind: 'none' }, askAtHost, true);
      if (taken === 'chain') {
        const source = askAtHost ? ASK_AT_HOST_SOURCE : 'permissionRequest';
        const can = callCan(support(scenario.harness), source, scenario.harness, scenario.mode, 'shell', false);
        const fold = new DecisionFold(can);
        const payload = fold.payload({ tool: { kind: 'shell', name: scenario.tool }, input: scenario.input, inputComplete: true, source, coverage: askAtHost ? 'askedCalls' : coverage(scenario.harness, scenario.mode) });
        const value = await slot.handler!(payload);
        awaited += 1;
        fold.step({ owner: 'sample.hook-guard', name: 'Guard', onFailure: 'ask', grants: ['harness.hooks.decide', 'ui.presentation'], answer: { value: (value ?? null) as Json } });
        result = action(fold.outcome(), askAtHost, true);
      }
      expect(result.kind, scenario.id).toBe(expected.action);
      expect(awaited, scenario.id).toBe(expected.awaited);
      // An observer receives the call one way on the normal prompt path; a revoked hook receives nothing.
      expect(observer && taken === 'pass' ? 1 : 0, scenario.id).toBe(expected.oneWay);
    }
  });

  test('extensions hook decisions: the fixture service decides through the SDK stand-in and records receipts', async () => {
    const require = createRequire(import.meta.url);
    const main = require(fileURLToPath(new URL('main.cjs', fixtures)));
    const handlers = new Map<string, (payload: Obj) => unknown>();
    const applied: ((receipt: Obj) => void)[] = [];
    const commands = new Map<string, (context: Obj) => Promise<unknown>>();
    await main.service({
      hooks: {
        on: (event: string, handler: (payload: Obj) => unknown) => { handlers.set(event, handler); return { ready: Promise.resolve(), dispose: () => handlers.delete(event) }; },
        onApplied: (handler: (receipt: Obj) => void) => { applied.push(handler); return { dispose: () => applied.splice(applied.indexOf(handler), 1) }; },
      },
      commands: { register: (id: string, handler: (context: Obj) => Promise<unknown>) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; } },
    }, { onStop: () => undefined });
    const decide = async (can: string[], call: Obj) => {
      const fold = new DecisionFold(can);
      let answer: Step['answer'];
      try { answer = { value: ((await handlers.get('tool.before')!(fold.payload(call))) ?? null) as Json }; } catch (error) { answer = { error: (error as Error).message }; }
      fold.step({ owner: 'sample.hook-guard', name: 'Guard', onFailure: 'ask', grants: ['harness.hooks.decide', 'ui.presentation'], answer });
      for (const receipt of fold.settled()) for (const handler of applied) handler({ schemaVersion: 1, hookId: 'sample.hook-guard/before', event: 'tool.before', taskId: 't', ...receipt });
      return fold;
    };
    const shell = (command: string) => ({ callId: `call-${command}`, tool: { kind: 'shell', name: 'Bash' }, input: { command }, inputComplete: true, source: 'permissionRequest', coverage: 'askedCalls' });
    const claude = callCan(builtinSupport('claude'), 'permissionRequest', 'claude', 'ask', 'shell', false);
    const codex = callCan(builtinSupport('codex'), 'permissionRequest', 'codex', 'ask', 'shell', false);

    const denied = await decide(claude, shell('rm -rf build'));
    expect(actionJson(action(denied.outcome(), false, true))).toEqual({ kind: 'deny', decidedBy: 'sample.hook-guard', reason: 'rm -rf outside the project' });
    const read = await decide(claude, { callId: 'call-read', tool: { kind: 'read', name: 'Read' }, input: { file_path: 'src/app.ts' }, inputComplete: true });
    expect(actionJson(action(read.outcome(), false, true))).toEqual({ kind: 'approve', decidedBy: 'sample.hook-guard', reason: null, input: null });
    expect(read.notes).toEqual([['Guard', 'Reads are safe']]);
    const curl = await decide(claude, shell('curl https://example.com'));
    expect(actionJson(action(curl.outcome(), false, true))).toEqual({ kind: 'prompt', note: 'Guard asks you to decide: network access' });
    const rewritten = await decide(claude, shell('npm test'));
    expect(actionJson(action(rewritten.outcome(), false, true))).toEqual({ kind: 'approve', decidedBy: 'sample.hook-guard', reason: null, input: { command: 'pnpm test' } });
    // Codex cannot run new arguments and its sandbox holds the request: the rewrite is refused and the prompt stays.
    const refused = await decide(codex, shell('npm test'));
    expect(actionJson(action(refused.outcome(), false, true))).toEqual({ kind: 'prompt', note: null });
    expect(refused.settled()).toEqual([{ owner: 'sample.hook-guard', applied: false, code: 'UnsupportedCapability', refused: { decision: 'UnsupportedCapability' } }]);
    // A throw follows onFailure: ask; it never approves.
    const exploded = await decide(claude, shell('explode'));
    expect(actionJson(action(exploded.outcome(), true, true))).toEqual({ kind: 'prompt', note: 'Guard did not answer (InvalidShape). Decide yourself.' });

    const received = await commands.get('sample.hook-guard/control')!({ args: { op: 'received' } }) as Obj;
    expect(received.received.map((entry: Obj) => entry.command)).toEqual(['rm -rf build', '', 'curl https://example.com', 'npm test', 'npm test', 'explode']);
    expect(received.received[0].can).toEqual(['approve', 'deny', 'ask', 'rewriteInput']);
    expect(received.received[4].can).toEqual(['deny', 'ask']);
    expect(received.receipts.map((receipt: Obj) => receipt.applied)).toEqual([true, true, true, true, false]);
    expect(received.receipts[4].code).toBe('UnsupportedCapability');
  });
});
