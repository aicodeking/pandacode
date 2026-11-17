import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import type { Json } from '../src/extensions/runtime-hook-payload';
import {
  admit, ANSWERS_BYTES, approvalEnding, codeOf, DECIDE, formOf, line, METHOD, parseRespond, Refused, replay, responseFor, Responses,
  type Open, type World,
} from '../src/extensions/runtime-late-responses';
// Preview column of R0508 (`panda.tasks.respond`, answering open requests after the hook budget). The browser preview
// runs no harness, so this spec runs in the test runner's Node: it replays the shared script through the webview twin
// (src/extensions/runtime-late-responses.ts) of the native module (src-tauri/src/extensions/runtime_late_responses.rs,
// whose tests replay the same scenarios), checks parsing, answer shaping, admission and the one-winner claims, drives
// the responder fixture service (responder/main.cjs) through a stand-in of the service SDK past its 2 s delay, and
// checks the app's wiring in the sources. No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-late-responses/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const script = read('scenarios.json');
const manifest = read('responder/extension.json');
type Obj = Record<string, any>;
const root = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const refusalOf = (work: () => unknown) => { try { work(); return null; } catch (error) { if (error instanceof Refused) return error.refusal; throw error; } };

test.describe('R0508 late responses', () => {
  test('extensions late responses: the responder fixture is valid, observes the pending events and holds decide', () => {
    const result = validateContract('packages', [manifest]) as Obj;
    expect(result.ok).toBe(true);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['harness.hooks.observe', DECIDE]));
    expect(manifest.contributes.hooks.map((hook: Obj) => hook.event)).toEqual(['approval.pending', 'question.pending', 'approval.resolved', 'question.resolved']);
    expect(script._fixture.provenance).toBe('synthetic');
  });

  for (const scenario of script.scenarios as Obj[]) {
    test(`extensions late responses: shared script: ${scenario.id}`, () => {
      const { events, results, inputs } = replay(script, scenario.steps);
      expect(events).toEqual(scenario.expect.events);
      expect(results).toEqual(scenario.expect.results);
      expect(inputs).toEqual(scenario.expect.inputs);
    });
  }

  test('extensions late responses: parsing is strict and answers become the response the window would send', () => {
    const answer = (value: Json) => () => parseRespond({ taskId: 't', requestId: 'r:1', answer: value });
    expect(answer({ approved: false, reason: 'no' })()).toEqual({ task: 't', request: 'r:1', reply: { kind: 'approval', approved: false, reason: 'no' } });
    expect(refusalOf(answer({ approved: true, input: {} }))?.code).toBe('InvalidShape');
    expect(refusalOf(answer({ approved: 'yes' }))?.path).toBe('$.answer.approved');
    expect(refusalOf(answer({ approved: false, reason: 'x'.repeat(4_097) }))?.code).toBe('LimitExceeded');
    expect(refusalOf(answer({ answers: { a: 'x'.repeat(ANSWERS_BYTES) } }))?.code).toBe('LimitExceeded');
    expect(refusalOf(() => parseRespond({ taskId: 't', requestId: 'r', answer: { approved: true }, extra: 1 }))?.code).toBe('InvalidShape');
    const questions = [{ id: 'db' }, { id: 'name' }];
    expect(responseFor('questions', questions, { db: 'Postgres', name: ['atlas'] })).toEqual({ answers: { db: ['Postgres'], name: ['atlas'] } });
    expect(responseFor('questions', questions, {})).toEqual({ answers: {} });
    expect(refusalOf(() => responseFor('questions', questions, { db: 'Postgres' }))?.code).toBe('InvalidShape');
    expect(responseFor('fields', questions, { db: 'Postgres' })).toEqual({ action: 'accept', content: { db: 'Postgres' } });
    expect(responseFor('url', [{ id: 'url' }], { url: false })).toEqual({ action: 'decline' });
    expect(refusalOf(() => responseFor('other', [{ id: 'q0' }], { q0: 'x' }))?.code).toBe('UnsupportedCapability');
    expect(formOf({ kind: 'form' })).toBe('fields');
    expect(codeOf('This approval belongs to an earlier run.')).toBe('StaleContext');
    expect(line('approval', 'Bash', 'Late responder', false, 'Outside.')).toBe('Bash denied through Late responder. Outside.');
  });

  test('extensions late responses: admission checks the open request, the grant narrowing and the mode', () => {
    const open: Open = { kind: 'approval', project: 'A', harness: 'claude', mode: 'plan', tool: 'Bash', toolKind: 'shell', questions: [] };
    const world = (over: Partial<World> = {}): World => ({
      open: () => open, issued: () => null, known: () => true, holdsAny: () => true, granted: (_project, kind) => kind === 'shell',
      mode: () => null, support: () => ({ denyReason: 'answer', rewriteInput: true }), ...over,
    });
    const respond = (approved: boolean) => ({ task: 't', request: 'r:1', reply: { kind: 'approval' as const, approved, reason: null } });
    // Plan mode holds a shell call: a package can deny it, never approve it.
    expect(refusalOf(() => admit(world(), respond(true)))).toEqual({ code: 'UnsupportedCapability', path: '$.answer.approved' });
    expect(admit(world(), respond(false)).plan.kind).toBe('approval');
    // The narrowing is checked per tool kind; no grant at all is refused before anything is looked up.
    expect(refusalOf(() => admit(world({ granted: (_project, kind) => kind === 'read' }), respond(false)))).toEqual({ code: 'PermissionDenied', path: DECIDE });
    expect(refusalOf(() => admit(world({ holdsAny: () => false, open: () => { throw new Error('looked up'); } }), respond(false)))?.code).toBe('PermissionDenied');
    expect(refusalOf(() => admit(world({ open: () => null }), respond(false)))?.code).toBe('StaleContext');
    expect(refusalOf(() => admit(world({ open: () => null, known: () => false }), respond(false)))?.code).toBe('NotFound');
  });

  test('extensions late responses: one answer is in flight per request and only an armed one is its withdrawal', () => {
    const ledger = new Responses();
    const first = ledger.claim('t', 'r:1', approvalEnding(false))!;
    expect(ledger.claim('t', 'r:1', approvalEnding(true))).toBeNull();
    expect(ledger.withdrawn('t', 'r:1')).toBeNull();
    first.arm();
    expect(ledger.withdrawn('t', 'r:1')).toEqual(approvalEnding(false));
    first.release();
    expect(ledger.claim('t', 'r:1', approvalEnding(true))).not.toBeNull();
  });

  test('extensions late responses: the responder service answers after its delay and records refusals', async () => {
    const handlers = new Map<string, (payload: Obj) => unknown>();
    const commands = new Map<string, (context: Obj) => Promise<any>>();
    const answered: Obj[] = [];
    let open = new Set(['r1:7', 'r1:q1']);
    const panda = {
      hooks: { on(event: string, handler: (payload: Obj) => unknown) { handlers.set(event, handler); return { ready: Promise.resolve(), dispose: () => handlers.delete(event) }; } },
      tasks: {
        async respond(taskId: string, requestId: string, answer: Obj) {
          if (!open.has(requestId)) throw Object.assign(new Error('StaleContext'), { code: 'StaleContext' });
          open.delete(requestId);
          answered.push({ taskId, requestId, answer });
          return null;
        },
      },
      commands: { register: (id: string, handler: (context: Obj) => Promise<any>) => { commands.set(id, handler); return { dispose() {} }; } },
    };
    const stops: (() => void)[] = [];
    const service = createRequire(import.meta.url)(fileURLToPath(new URL('responder/main.cjs', fixtures)));
    await service.service(panda, { onStop: (handler: () => void) => { stops.push(handler); return { dispose() {} }; } });
    const control = commands.get('sample.late-responder/control')!;
    await control({ args: { op: 'configure', delayMs: 2000, answers: { db: 'Postgres', name: 'atlas' } } });
    const started = Date.now();
    handlers.get('approval.pending')!({ taskId: 't1', requestId: 'r1:7', tool: { kind: 'shell', name: 'Bash' }, input: { command: 'rm -rf /tmp/x' } });
    handlers.get('question.pending')!({ taskId: 't1', requestId: 'r1:q1', questions: [{ id: 'db' }, { id: 'name' }] });
    // A request the user answered first: the late answer is refused and recorded, never retried.
    handlers.get('approval.pending')!({ taskId: 't1', requestId: 'r1:8', tool: { kind: 'shell', name: 'Bash' }, input: { command: 'rm -rf /tmp/y' } });
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(answered).toEqual(expect.arrayContaining([
      { taskId: 't1', requestId: 'r1:7', answer: { approved: false, reason: 'Outside the project.' } },
      { taskId: 't1', requestId: 'r1:q1', answer: { answers: { db: 'Postgres', name: 'atlas' } } },
    ]));
    const state = await control({ args: { op: 'list' } });
    expect(state.outcomes).toEqual(expect.arrayContaining([{ requestId: 'r1:8', ok: false, code: 'StaleContext' }]));
    // The fixture action answers one request now.
    open = new Set(['r1:9']);
    expect(await commands.get('sample.late-responder/respond')!({ args: { taskId: 't1', requestId: 'r1:9', answer: { approved: false, reason: 'From the action.' } } })).toEqual({ requestId: 'r1:9', ok: true });
    stops.forEach(stop => stop());
  });

  test('extensions late responses: the app wires the answer path, the claims and the SDK', () => {
    const lib = root('src-tauri/src/lib.rs');
    for (const call of ['runtime_late_responses::agent_event(', 'fn respond_approval_with(', 'fn respond_approval_for_extension(', 'fn answer_user_input<', 'runtime_late_responses::responses().claim(']) expect(lib, call).toContain(call);
    expect(lib.indexOf('runtime_late_responses::agent_event(')).toBeLessThan(lib.indexOf('runtime_pending_requests::agent_event('));
    expect(root('src-tauri/src/extensions/mod.rs')).toContain('pub mod runtime_late_responses;');
    expect(root('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain(`"${METHOD}"`);
    expect(root('src-tauri/src/extensions/node-host.cjs')).toContain(`rpc('${METHOD}'`);
    expect(root('src/extensions/sdk/index.d.ts')).toContain('respond(taskId: string, requestId: string, answer:');
  });
});
