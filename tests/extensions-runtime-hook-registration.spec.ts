import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { HookPayloads, BARE, type Json } from '../src/extensions/runtime-hook-payload';
import {
  checkHookDeclarations, DELIVERED, extensionOf, HookRegistry, kindOfInput, matches, shell, toolKind, type Declaration, type RunFacts,
} from '../src/extensions/runtime-hook-registration';
// Preview column of R0503 (hooks declared in the manifest, attached by the service, observed inside grants and
// filters). The browser preview runs no harness, so this spec runs in the test runner's Node: it checks the webview
// twin (src/extensions/runtime-hook-registration.ts) of the native rules
// (src-tauri/src/extensions/runtime_hook_registration.rs) against the shared fixtures, which the native tests read
// too, and drives the fixture service (main.cjs) through a stand-in of the service SDK. No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-hook-registration/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const cases = read('declarations.json');
const script = read('replay.json');
const OWNER = 'sample.hook-observer';
type Obj = Record<string, any>;

function declarations(): Declaration[] {
  const checked = checkHookDeclarations(manifest);
  if (!checked.ok) throw new Error(checked.refusal.code);
  return checked.declarations;
}
function hub(projects: string[] | null) {
  const registry = new HookRegistry();
  registry.setGate((_owner, _version, permission, project) => permission === 'harness.hooks.observe' && (project === null || projects === null || projects.includes(project)));
  const seen: { owner: string; frame: Obj }[] = [];
  registry.setDeliver((owner, frame) => { seen.push({ owner, frame }); return null; });
  return { registry, seen };
}
function attachAll(registry: HookRegistry): Declaration[] {
  const declared = declarations();
  for (const declaration of declared) expect(typeof registry.register(OWNER, '1.0.0', declared, declaration.event)).toBe('object');
  return declared;
}
function facts(task: string, project: string, harness: string, run: string, text: string): RunFacts {
  return { taskId: task, projectId: project, projectRoot: `/work/${project}`, cwd: `/work/${project}`, harness, model: 'fake-model', mode: 'ask', run: { kind: run }, index: 1, text, attachments: [], startedBy: 'user', transcriptCursor: 0 };
}
function replay(registry: HookRegistry, book: HookPayloads): void {
  const runs = new Map<string, Obj>(script.runs.map((run: Obj) => [run.task, run]));
  const payload = (base: Obj, callId: string) => book.hookCall(base as any, callId) as any;
  for (const step of script.steps as Obj[]) {
    const run = runs.get(step.task)!;
    if (step.op === 'turn') registry.turnStarted(facts(step.task, run.project, run.harness, run.run, step.text ?? ''));
    else if (step.op === 'approval') {
      const { callId } = book.record(step.task, run.project, step.call, step.input);
      book.openApproval(step.task, step.request, step.call, BARE);
      registry.toolBefore(step.task, callId, callId, step.tool, step.request, payload);
    } else if (step.op === 'tool') {
      const { callId } = book.record(step.task, run.project, step.call, step.input);
      registry.toolAfter(step.task, callId, callId, step.tool, step.status, step.output ?? '', payload);
    } else if (step.op === 'compaction') registry.compaction(step.task);
    else if (step.op === 'end') registry.turnEnded(step.task, step.successful === true, step.error ?? null);
    else throw new Error(`unknown step ${step.op}`);
  }
}

test('extensions hook registration: declarations fail the same way in the schema, the check and the native contract', () => {
  for (const entry of cases.cases as Obj[]) {
    const candidate = structuredClone(cases.base);
    Object.assign(candidate, entry.patch ?? {});
    for (const key of entry.remove ?? []) delete candidate[key];
    candidate.contributes.hooks = entry.hooks;
    const result = validateContract('packages', [candidate]) as any;
    if (entry.expect === null) {
      expect(result.ok, `${entry.id}: ${JSON.stringify(result.error)}`).toBe(true);
      expect(checkHookDeclarations(candidate).ok, entry.id).toBe(true);
      // The validated package keeps its hooks (the schema declares them; nothing is dropped as unknown).
      expect(result.value.packages[0].contributes.hooks.length, entry.id).toBe(entry.hooks.length);
      continue;
    }
    expect(result.ok, entry.id).toBe(false);
    expect(result.error.code, entry.id).toBe(entry.expect.code);
    expect(result.error.path, entry.id).toBe(`$/0${entry.expect.path}`);
    if (entry.expect.ids) expect(result.error.ids, entry.id).toEqual(entry.expect.ids);
    if (entry.expect.source === 'check') {
      const checked = checkHookDeclarations(candidate);
      expect(checked.ok, entry.id).toBe(false);
      if (!checked.ok) expect(checked.refusal.code, entry.id).toBe(entry.expect.code);
    }
  }
  const declared = declarations();
  expect(new Set(declared.map(declaration => declaration.event))).toEqual(new Set(DELIVERED));
  expect((validateContract('packages', [manifest]) as any).ok).toBe(true);
});

test('extensions hook registration: an observer receives every event only inside its grant and match filters', () => {
  const { registry, seen } = hub(['A']);
  attachAll(registry);
  replay(registry, new HookPayloads());
  expect(seen.map(({ frame }) => [frame.event, frame.payload.taskId])).toEqual(script.expect.map((entry: Obj) => [entry.event, entry.task]));
  expect(new Set(seen.map(({ frame }) => frame.event))).toEqual(new Set(DELIVERED));
  expect(seen.every(({ owner, frame }) => owner === OWNER && frame.payload.projectId === 'A' && frame.observeOnly === true && frame.schemaVersion === 1)).toBe(true);
  const first = (event: string) => seen.find(({ frame }) => frame.event === event)!.frame.payload;
  expect(first('prompt.submit').text).toBe('list the files');
  expect(first('turn.start').sinceCompaction).toBe(0);
  const before = first('tool.before');
  expect([before.inputComplete, before.input.command, before.shell.command, before.tool.kind]).toEqual([true, 'ls -la', 'ls -la', 'shell']);
  expect([before.source, before.coverage, before.can, before.requestId]).toEqual(['permissionRequest', 'askedCalls', [], 'r1']);
  const after = first('tool.after');
  expect([after.tool.kind, after.writePaths, after.status, after.source, after.coverage]).toEqual(['edit', ['src/app.ts'], 'completed', 'activity', 'afterOnly']);
  expect(first('compaction')).toEqual({ taskId: 't-a1', projectId: 'A', harness: 'fake-agent', phase: 'after', can: [] });
  expect([first('turn.finish').toolCalls, first('turn.finish').transcript.cursor]).toEqual([3, 0]);
  expect(first('turn.fail').error.message).toBe('fake agent crashed');
  expect(first('task.idle').pending).toEqual({ approvals: 0, questions: 0 });
  expect(registry.counters.filtered).toBeGreaterThan(0);
});

test('extensions hook registration: undeclared and ungranted registrations are refused', () => {
  const { registry } = hub(null);
  const declared = declarations();
  expect(registry.register(OWNER, '1.0.0', declared, 'save.before')).toBe('UnknownReference');
  expect(registry.register(OWNER, '1.0.0', declared, 'approval.pending')).toBe('UnknownReference');
  expect(registry.register(OWNER, '1.0.0', declared, 'tool.during')).toBe('InvalidShape');
  expect([registry.listeners(OWNER), registry.active()]).toEqual([[], false]);
  const ungranted = new HookRegistry();
  expect(ungranted.register(OWNER, '1.0.0', declared, 'turn.start')).toBe('PermissionDenied');
  ungranted.setGate(() => false);
  expect(ungranted.register(OWNER, '1.0.0', declared, 'turn.start')).toBe('PermissionDenied');
  const answer = registry.register(OWNER, '1.0.0', declared, 'tool.before') as Obj;
  expect([answer.onFailure, answer.budgetMs, answer.observeOnly]).toEqual(['ask', 2000, true]);
  expect(registry.active()).toBe(true);
});

test('extensions hook registration: observe-only deliveries never decide, and removal leaves the normal path', () => {
  const book = new HookPayloads();
  const payload = (base: Obj, callId: string) => book.hookCall(base as any, callId) as any;
  let granted = true;
  const registry = new HookRegistry();
  registry.setGate(() => granted);
  const seen: Obj[] = [];
  registry.setDeliver((_owner, frame) => { seen.push(frame); return null; });
  const declared = attachAll(registry);
  registry.turnStarted(facts('t-o', 'A', 'fake-agent', 'task', ''));
  const { callId } = book.record('t-o', 'A', 'tool-1', { command: 'rm -rf build' });
  book.openApproval('t-o', 'req-1', 'tool-1', BARE);
  expect(registry.toolBefore('t-o', callId, callId, 'Bash', 'req-1', payload).delivered).toBe(1);
  const delivered = seen.find(frame => frame.event === 'tool.before')!;
  expect([delivered.observeOnly, delivered.payload.can]).toEqual([true, []]);
  // Nothing the handler could return reaches the request: it stays open for the user, who answers it plainly.
  expect(book.support('t-o', 'req-1')).toEqual(BARE);
  expect(book.take('t-o', 'req-1', false)).toEqual({ approved: false });

  const turn = (task: string) => registry.turnStarted(facts(task, 'A', 'fake-agent', 'task', 'hello'));
  seen.length = 0;
  expect(turn('t1').delivered).toBe(2);
  registry.register(OWNER, '1.0.0', declared, 'turn.start');
  registry.unregister(OWNER, 'turn.start');
  expect(registry.listeners(OWNER)).toContain('turn.start');
  registry.unregister(OWNER, 'turn.start');
  expect(registry.listeners(OWNER)).not.toContain('turn.start');
  expect(turn('t2').delivered).toBe(1);
  granted = false;
  expect(turn('t3')).toEqual({ delivered: 0, filtered: 1, failed: 0 });
  granted = true;
  registry.setDeliver(() => 'HostUnavailable');
  expect(turn('t4')).toEqual({ delivered: 0, filtered: 0, failed: 1 });
  expect(registry.turnEnded('t4', true, null).failed).toBeGreaterThan(0);
  expect(registry.removeOwner(OWNER)).toBe(7);
  expect([registry.listeners(OWNER), registry.active()]).toEqual([[], false]);
  expect(turn('t5')).toEqual({ delivered: 0, filtered: 0, failed: 0 });
  expect(registry.run('t5')).toBeNull();
  expect(seen.length).toBe(3);
});

test('extensions hook registration: the fixture service attaches its hooks, hears of the undeclared one and decides nothing', async () => {
  // A stand-in of the service SDK with the node host's semantics: hooks.on answers { ready, dispose } synchronously,
  // `ready` rejects with the host's code, deliveries are one-way and handlers run one after another.
  const { registry } = hub(['A']);
  const declared = declarations();
  const handlers = new Map<string, Set<(payload: Json) => unknown>>();
  const returned: unknown[] = [];
  registry.setDeliver((_owner, frame) => {
    void (async () => { for (const handler of [...(handlers.get(frame.event as string) ?? [])]) returned.push(await handler(frame.payload)); })();
    return null;
  });
  let control: ((context: Obj) => Promise<any>) | null = null;
  const panda = {
    hooks: {
      on(event: string, handler: (payload: Json) => unknown) {
        const set = handlers.get(event) ?? new Set(); handlers.set(event, set); set.add(handler);
        const answer = registry.register(OWNER, '1.0.0', declared, event);
        const ready = typeof answer === 'string' ? Promise.reject(Object.assign(new Error(answer), { code: answer })) : Promise.resolve();
        ready.catch(() => set.delete(handler));
        return { ready, dispose: () => { if (set.delete(handler)) registry.unregister(OWNER, event); } };
      },
      input: async () => null,
    },
    commands: { register: (_id: string, handler: (context: Obj) => Promise<any>) => { control = handler; return { dispose() {} }; } },
  };
  const stops: (() => void)[] = [];
  const service = createRequire(import.meta.url)(fileURLToPath(new URL('main.cjs', fixtures)));
  await service.service(panda, { onStop: (handler: () => void) => { stops.push(handler); return { dispose() {} }; } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const state = await control!({ args: { op: 'received' } });
  expect(state.refused).toEqual({ 'save.before': 'UnknownReference' });
  expect(new Set(registry.listeners(OWNER))).toEqual(new Set(DELIVERED));
  replay(registry, new HookPayloads());
  await new Promise(resolve => setTimeout(resolve, 10));
  const received = (await control!({ args: { op: 'received' } })).received as Obj[];
  expect(received.map(entry => [entry.event, entry.payload.taskId])).toEqual(script.expect.map((entry: Obj) => [entry.event, entry.task]));
  // The service returned a decision from tool.before; it went nowhere (the delivery is one-way).
  expect(returned.filter(value => value !== undefined)).toEqual([{ decision: 'approve', reason: 'an observer cannot approve' }, { decision: 'approve', reason: 'an observer cannot approve' }]);
  expect((await control!({ args: { op: 'state' } })).overlap).toBe(1);
  // Stopping the service disposes every handler: nothing stays attached.
  stops.forEach(stop => stop());
  expect(registry.listeners(OWNER)).toEqual([]);
});

test('extensions hook registration: normalization tables match the native ones', () => {
  for (const [name, kind] of [['Bash', 'shell'], ['mcp__pandacode__exec_command', 'shell'], ['Read', 'read'], ['Write', 'write'], ['MultiEdit', 'edit'], ['apply_patch', 'edit'], ['Grep', 'search'], ['WebFetch', 'fetch'], ['deepseek_tool', 'other']]) expect(toolKind(name), name).toBe(kind);
  expect(kindOfInput({ command: ['ls', '-la'] })).toBe('shell');
  expect(kindOfInput({ file_path: 'a', content: 'b' })).toBe('write');
  expect(shell('Bash', { command: ['ls', '-la'] })).toEqual({ dialect: 'posix', command: 'ls -la' });
  expect([extensionOf('src/App.TS'), extensionOf('.gitignore'), extensionOf('C:\\work\\Makefile')]).toEqual(['.ts', null, null]);
  const occurrence = { event: 'tool.after' as const, project: 'A', harness: 'h', run: 'task', toolKind: 'edit', paths: ['x.md'], payload: {} };
  expect(matches({ extensions: new Set(['.ts']) }, occurrence)).toBe(false);
  expect(matches({ extensions: new Set(['.ts']) }, { ...occurrence, paths: ['x.md', 'y.TS'] })).toBe(true);
});
