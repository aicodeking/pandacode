import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import type { Json } from '../src/extensions/runtime-hook-payload';
import { checkHookDeclarations, HookRegistry, OBSERVE, type Declaration } from '../src/extensions/runtime-hook-registration';
import { action, DecisionFold } from '../src/extensions/runtime-hook-decisions';
import { DECIDE } from '../src/extensions/runtime-hook-context';
import {
  EVENTS, occurrenceOf, PendingBook, replay, snapshotFor, SNAPSHOT_BYTES, type Change, type Facts, type Reach, type Request,
} from '../src/extensions/runtime-pending-requests';
// Preview column of R0507 (pending approvals and questions as durable, observe-only events). The browser preview runs
// no harness, so this spec runs in the test runner's Node: it replays the shared script through the webview twin
// (src/extensions/runtime-pending-requests.ts) of the native book (src-tauri/src/extensions/runtime_pending_requests.rs,
// whose tests replay the same scenarios), checks delivery against the observe grant and the `match` filter, and
// drives the inbox fixture service (inbox/main.cjs) through a stand-in of the service SDK across a lost-event gap.
// No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-pending-requests/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const script = read('scenarios.json');
const manifest = read('inbox/extension.json');
const OWNER = 'sample.pending-inbox';
type Obj = Record<string, any>;
const root = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function declarations(): Declaration[] {
  const checked = checkHookDeclarations(manifest);
  if (!checked.ok) throw new Error(checked.refusal.code);
  return checked.declarations;
}
/** A registry with the inbox's hooks attached; its observe grant reaches `projects` while `granted()` holds. */
function hub(projects: string[], granted: () => boolean = () => true, attach = true) {
  const registry = new HookRegistry();
  registry.setGate((owner, _version, permission, project) => owner === OWNER && permission === OBSERVE && granted() && (project === null || projects.includes(project)));
  const declared = declarations();
  if (attach) for (const event of [...EVENTS, 'task.idle']) expect(typeof registry.register(OWNER, '1.0.0', declared, event)).toBe('object');
  const reach = (events: string[]): Reach[] => declared.filter(declaration => events.includes(declaration.event))
    .map(declaration => ({ match: declaration.match, granted: (project: string) => granted() && projects.includes(project) }));
  return { registry, approvals: reach(['approval.pending', 'approval.resolved']), questions: reach(['question.pending', 'question.resolved']) };
}
const facts = (project: string, run = 'task'): Facts => ({ project, harness: 'claude', mode: 'ask', run });
const approval = (task: string, request: string, extra: Partial<Request> = {}): Request => ({ task, request, text: 'Allow Bash?', data: { name: 'Bash' }, call: null, input: undefined, askAtHost: false, at: script.at, ...extra });
const question = (task: string, request: string): Request => ({
  task, request, text: '', call: null, input: undefined, askAtHost: false, at: script.at,
  data: { kind: 'questions', questions: [{ id: 'db', header: '', question: 'Which database?', isOther: false, isSecret: false, options: [{ label: 'Postgres', description: '' }] }] },
});

test.describe('R0507 pending approvals and questions', () => {
  test('extensions pending requests: the inbox fixture is valid and observes the four events', () => {
    const result = validateContract('packages', [manifest]) as Obj;
    expect(result.ok).toBe(true);
    expect(declarations().map(declaration => declaration.event)).toEqual([...EVENTS, 'task.idle']);
    expect(manifest.permissions).toContain('harness.hooks.observe');
    expect(manifest.permissions).not.toContain('harness.hooks.decide');
  });

  for (const scenario of script.scenarios as Obj[]) {
    test(`extensions pending requests: shared script: ${scenario.id}`, () => {
      const { events, snapshots, results } = replay(script.tasks, script.at, scenario.steps);
      expect(events).toEqual(scenario.expect.events);
      expect(snapshots).toEqual(scenario.expect.snapshots ?? []);
      expect(results).toEqual(scenario.expect.results ?? []);
    });
  }

  test('extensions pending requests: deliveries follow the observe grant and the match filter', () => {
    let granted = true;
    const { registry } = hub(['A'], () => granted);
    const seen: Obj[] = [];
    registry.setDeliver((_owner, frame) => { seen.push(frame); return null; });
    const book = new PendingBook();
    const publish = (change: Change | null) => change ? registry.publish(occurrenceOf(change)) : null;
    expect(publish(book.openRequest('approval', approval('t1', 'r:1'), facts('A')))).toEqual({ delivered: 1, filtered: 0, failed: 0 });
    expect(publish(book.openRequest('approval', approval('t2', 'r:2'), facts('B')))).toEqual({ delivered: 0, filtered: 1, failed: 0 });
    // The inbox's approval hooks leave team workers out (`match.runs`); its question hooks take every run.
    expect(publish(book.openRequest('approval', approval('t3', 'r:3'), facts('A', 'worker')))?.filtered).toBe(1);
    expect(publish(book.openRequest('question', question('t3', 'r:q3'), facts('A', 'worker')))?.delivered).toBe(1);
    granted = false;
    expect(publish(book.end('t1', 'r:1', { kind: 'answered', approved: true, response: undefined }))?.filtered).toBe(1);
    expect(seen.map(frame => [frame.event, frame.observeOnly, frame.payload.requestId])).toEqual([['approval.pending', true, 'r:1'], ['question.pending', true, 'r:q3']]);
  });

  test('extensions pending requests: a prompt left by a timed-out hook stays pending with no time limit', () => {
    // The guard did not answer inside its budget and declared onFailure "ask": the normal prompt appears (R0505/R0506).
    const fold = new DecisionFold(['approve', 'deny', 'ask']);
    fold.step({ owner: 'sample.guard', name: 'Guard', onFailure: 'ask', grants: [DECIDE], answer: { error: 'Timeout' } });
    const outcome = fold.outcome();
    const taken = action(outcome, false, true);
    expect(taken).toEqual({ kind: 'prompt', note: 'Guard did not answer (Timeout). Decide yourself.' });
    expect(outcome.kind).toBe('ask');
    const book = new PendingBook();
    if (outcome.kind === 'ask') book.askedBy('t', '7', outcome.by.owner);
    const pending = book.openRequest('approval', approval('t', 'run-1:7', { text: `Allow Bash?\n${taken.kind === 'prompt' ? taken.note : ''}`, call: 'call-1', input: { command: 'rm -rf build' } }), facts('A'))!.payload;
    expect(pending.askedBy).toEqual({ package: 'sample.guard' });
    expect([pending.callId, pending.tool, pending.input]).toEqual(['call-1', { kind: 'shell', name: 'Bash' }, { command: 'rm -rf build' }]);
    // Nothing in the book expires: the request is listed, frozen, until something ends it, and it ends once.
    expect(book.snapshot(() => true).approvals).toEqual([pending]);
    expect(book.end('t', 'run-1:7', { kind: 'answered', approved: true, response: undefined })?.payload).toEqual({ requestId: 'run-1:7', callId: 'call-1', taskId: 't', approved: true, by: 'user' });
    expect(book.end('t', 'run-1:7', { kind: 'answered', approved: true, response: undefined })).toBeNull();
  });

  test('extensions pending requests: the inbox service rebuilds its list after lost events and never sees a resolved question again', async () => {
    let online = true;
    // The service attaches its own hooks below.
    const { registry, approvals, questions } = hub(['A'], () => true, false);
    const book = new PendingBook();
    const handlers = new Map<string, Set<(payload: Json) => unknown>>();
    registry.setDeliver((_owner, frame) => {
      if (!online) return 'HostUnavailable';
      void (async () => { for (const handler of [...(handlers.get(frame.event as string) ?? [])]) await handler(frame.payload as Json); })();
      return null;
    });
    let control: ((context: Obj) => Promise<any>) | null = null;
    const declared = declarations();
    const panda = {
      hooks: {
        on(event: string, handler: (payload: Json) => unknown) {
          const set = handlers.get(event) ?? new Set(); handlers.set(event, set); set.add(handler);
          const answer = registry.register(OWNER, '1.0.0', declared, event);
          const ready = typeof answer === 'string' ? Promise.reject(Object.assign(new Error(answer), { code: answer })) : Promise.resolve();
          ready.catch(() => set.delete(handler));
          return { ready, dispose: () => { if (set.delete(handler)) registry.unregister(OWNER, event); } };
        },
        pending: async () => {
          const snapshot = snapshotFor(book, approvals, questions);
          if (typeof snapshot === 'string') throw Object.assign(new Error(snapshot), { code: snapshot });
          return snapshot;
        },
      },
      commands: { register: (_id: string, handler: (context: Obj) => Promise<any>) => { control = handler; return { dispose() {} }; } },
    };
    const publish = (change: Change | null) => { if (change) registry.publish(occurrenceOf(change)); };
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    // A request was already waiting before the service started: its first resync finds it.
    publish(book.openRequest('approval', approval('t1', 'r1:0'), facts('A')));
    const stops: (() => void)[] = [];
    const service = createRequire(import.meta.url)(fileURLToPath(new URL('inbox/main.cjs', fixtures)));
    await service.service(panda, { onStop: (handler: () => void) => { stops.push(handler); return { dispose() {} }; } });
    const list = async () => await control!({ args: { op: 'list' } });
    expect((await list()).approvals).toEqual(['r1:0']);
    // The scripted harness pauses at an approval and a question.
    publish(book.openRequest('approval', approval('t1', 'r1:1'), facts('A')));
    publish(book.openRequest('question', question('t1', 'r1:q1'), facts('A')));
    await settle();
    expect([(await list()).approvals, (await list()).questions]).toEqual([['r1:0', 'r1:1'], ['r1:q1']]);
    // The service stops hearing (a restart, a full queue): the question is answered, another approval appears, a
    // duplicate frame of the first one arrives, and one outside the grant opens in project B.
    online = false;
    publish(book.end('t1', 'r1:q1', { kind: 'answered', approved: null, response: { answers: { db: { answers: ['Postgres'] } } } }));
    publish(book.openRequest('approval', approval('t1', 'r1:2'), facts('A')));
    expect(book.openRequest('approval', approval('t1', 'r1:1'), facts('A'))).toBeNull();
    publish(book.openRequest('approval', approval('t2', 'r2:1'), facts('B')));
    online = true;
    await settle();
    expect((await list()).questions).toEqual(['r1:q1']);
    // The inbox rebuilds from the host's open set: the answered question is gone, the missed approval is there,
    // project B is outside its grant, and a late frame of the answered question opens nothing.
    const rebuilt = await control!({ args: { op: 'resync' } });
    expect([rebuilt.approvals, rebuilt.questions]).toEqual([['r1:0', 'r1:1', 'r1:2'], []]);
    expect(book.openRequest('question', question('t1', 'r1:q1'), facts('A'))).toBeNull();
    // Each open request resolves exactly once: the user, a mode change and the run's end.
    publish(book.end('t1', 'r1:0', { kind: 'answered', approved: true, response: undefined }));
    publish(book.end('t1', 'r1:1', { kind: 'withdrawn', currentMode: 'full' }));
    book.endRun('t1', 'r1').forEach(publish);
    publish(book.end('t1', 'r1:2', { kind: 'gone' }));
    await settle();
    const after = await list();
    expect([after.approvals, after.questions]).toEqual([[], []]);
    const resolvedSeen = (after.seen as Obj[]).filter(entry => entry.event === 'approval.resolved');
    expect(resolvedSeen).toEqual([
      { event: 'approval.resolved', requestId: 'r1:0', by: 'user' },
      { event: 'approval.resolved', requestId: 'r1:1', by: 'mode' },
      { event: 'approval.resolved', requestId: 'r1:2', by: 'cancelled' },
    ]);
    stops.forEach(stop => stop());
    expect(registry.listeners(OWNER)).toEqual([]);
  });

  test('extensions pending requests: a package with no approval or question hook cannot list, and a snapshot stays inside the frame', () => {
    const book = new PendingBook();
    expect(snapshotFor(book, [], [])).toBe('UnknownReference');
    for (let index = 0; index < 4; index += 1) book.openRequest('approval', approval('t', `r:${index}`, { text: 'Allow Write?', data: {}, input: { content: 'x'.repeat(900 << 10) } }), facts('A'));
    const snapshot = book.snapshot(() => true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(SNAPSHOT_BYTES + 256);
    expect(snapshot.approvals).toHaveLength(4);
    expect((snapshot.approvals as Obj[]).some(item => !('input' in item))).toBe(true);
    expect(snapshot.truncated).toBe(false);
  });

  test('extensions pending requests: the app wires the book into every place a request opens, ends or is listed', () => {
    const lib = root('src-tauri/src/lib.rs');
    for (const call of ['runtime_pending_requests::agent_event(', 'runtime_pending_requests::approval_answered(', 'runtime_pending_requests::question_answered(', 'runtime_pending_requests::run_ended(', 'runtime_pending_requests::task_removed(']) expect(lib, call).toContain(call);
    expect(root('src-tauri/src/extensions/mod.rs')).toContain('pub mod runtime_pending_requests;');
    expect(root('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain('"hooksPending"');
    expect(root('src-tauri/src/extensions/node-host.cjs')).toContain("rpc('hooksPending'");
    expect(root('src-tauri/src/extensions/runtime_hook_decisions.rs')).toContain('runtime_pending_requests::asked_by(');
    expect(root('src-tauri/src/extensions/runtime_harness_coverage.rs')).toContain('runtime_pending_requests::mirror_events(');
    expect(root('src-tauri/src/extensions/runtime_hook_registration.rs')).toContain('runtime_pending_requests::counts(');
    expect(root('src/extensions/sdk/index.d.ts')).toContain('pending(): Promise<PendingSnapshot>');
  });
});
