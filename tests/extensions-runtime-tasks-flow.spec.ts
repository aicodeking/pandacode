import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { envelope } from '../src/extensions/runtime-tasks-start';
import { ACTIONS, CONTINUE_TEXT, DECISIONS, FlowController, KEEP_FIXING_TEXT, LIMIT_OPS, PERMISSION, WORKER_OPS, admit, answerRound, check, flowCodeOf, plan, type FlowHost, type PreviewFlowTask, type TaskFacts, type World } from '../src/extensions/runtime-tasks-flow';
import { ControlLog } from '../src/extensions/runtime-tasks-control';

// Preview column of R0404B (councils, workers and usage-limit pauses). The first group runs the deterministic model in
// src/extensions/runtime-tasks-flow.ts, which mirrors src-tauri/src/extensions/runtime_tasks_flow.rs (whose own unit tests are
// `runtime_tasks_flow::tests`, including the same parity recording); the last group drives the main window's half in the preview
// app. The installed service against a real harness is the native/installed column and is not claimed here.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-flow/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-tasks-flow/main.cjs');
const parity = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-flow/parity.json')) as { cases: { name: string; task: { teamActive: boolean; teamResumable: boolean }; request: Record<string, unknown>; commands: unknown[] }[] };
const OWNER = 'sample.runtime-tasks-flow';
const NAME = 'Flow controller';

type Worker = PreviewFlowTask['workers'][number];
const worker = (id: string, status: string, extra: Partial<Worker> = {}): Worker => ({ id, status, attempt: 1, ...extra });
const task = (id: string, projectId: string, extra: Partial<PreviewFlowTask> = {}): PreviewFlowTask => ({
  id, projectId, harness: 'claude', remote: false, running: false, team: true, teamStatus: 'running', council: true,
  workers: [worker('run', 'running'), worker('bad', 'failed'), worker('stop', 'stopped'), worker('done', 'completed'), worker('seat', 'failed', { reviewer: true }), worker('gone', 'stopped', { abandoned: true })],
  limited: true, resetKnown: true, resumeAtReset: false, connection: null, ...extra,
});
function controller(tasks: PreviewFlowTask[] = [task('t1', 'A'), task('t2', 'B'), task('bot-thread', 'A', { limited: true }), task('paused', 'A', { teamStatus: 'paused' }), task('plain', 'A', { team: false, workers: [] }), task('mirror', 'A', { remote: true }), task('idle', 'A', { limited: false })], headless = false) {
  return new FlowController({ tasks, connections: { claude: ['work-account', 'home-account'] }, headless });
}
const checks = (projects: readonly string[] = ['A', 'B']) => ({ granted: (project: string) => projects.includes(project), package: NAME });
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;
const flow = (host: FlowController, raw: Record<string, unknown>, projects?: readonly string[]) => host.flow(OWNER, checks(projects), raw);

test('extensions runtime tasks flow: the fixture package declares the permission and a service and uses the three calls', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.tasks.council', 'panda.tasks.worker', 'panda.tasks.limit', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package never pairs a machine, never asks for remote access and never names a credential.
  expect(fixtureSource).not.toMatch(/pair\b|remoteAccess|credentials\./i);
});

test('extensions runtime tasks flow: every action runs the commands the interface runs, with the same arguments (the parity recording)', () => {
  expect(parity.cases.length).toBeGreaterThanOrEqual(12);
  const world: World = { taskProject: id => (id === 't1' ? 'A' : undefined), granted: () => true, holdsAny: () => true };
  const seen = new Set<string>();
  for (const entry of parity.cases) {
    const spec = admit(world, entry.request);
    expect('code' in spec, entry.name).toBe(false);
    const commands = plan(spec as never, entry.task);
    expect(commands.map(command => ({ command: command.command, args: command.args })), entry.name).toEqual(entry.commands);
    const request = entry.request as { action: string; decision?: string; op?: string };
    seen.add(`${request.action}:${request.decision ?? request.op}`);
  }
  // One recording per decision and per operation.
  for (const decision of DECISIONS) expect(seen, decision).toContain(`council:${decision}`);
  for (const op of WORKER_OPS) expect(seen, op).toContain(`worker:${op}`);
  for (const op of LIMIT_OPS) expect(seen, op).toContain(`limit:${op}`);
  expect(KEEP_FIXING_TEXT).toBe('Keep fixing until every reviewer reaches the target.');
  expect(CONTINUE_TEXT).toBe('Continue where you left off.');
});

test('extensions runtime tasks flow: a council is accepted, dismissed or kept fixing once, and recorded with the package name', () => {
  const host = controller();
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'accept' })).toEqual({ ok: true, value: null });
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'dismiss' }).ok).toBe(true);
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'keepFixing' }).ok).toBe(true);
  expect(host.task('t1')).toMatchObject({ councilAccepted: true, councilDismissed: true });
  expect(host.followUps).toEqual([{ taskId: 't1', text: KEEP_FIXING_TEXT }]);
  expect(host.commands.map(command => command.command)).toEqual(['architect_council_accept', 'council_dismiss', 'send_message']);
  expect(host.log.forTask('t1').map(entry => [entry.action, entry.package, entry.owner])).toEqual([['council', NAME, OWNER], ['council', NAME, OWNER], ['council', NAME, OWNER]]);
  // Keep fixing waits for the lead like the card does; accepting does not.
  host.task('t1')!.running = true;
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'keepFixing' })).toMatchObject({ ok: false, error: { code: 'Conflict', path: 'council', ids: ['running'] } });
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'accept' }).ok).toBe(true);
  // No team, Council off, a task on another computer.
  expect(flow(host, { action: 'council', taskId: 'plain', decision: 'accept' })).toMatchObject({ ok: false, error: { code: 'Conflict', ids: ['noTeam'] } });
  host.task('plain')!.team = true; host.task('plain')!.council = false;
  expect(flow(host, { action: 'council', taskId: 'plain', decision: 'accept' })).toMatchObject({ ok: false, error: { code: 'Conflict', ids: ['councilOff'] } });
  expect(code(flow(host, { action: 'council', taskId: 'mirror', decision: 'accept' }))).toBe('UnsupportedCapability');
});

test('extensions runtime tasks flow: workers are stopped, skipped, retried and resumed by the rules of the lead and the team Resume', () => {
  const host = controller();
  const worker = (taskId: string, workerId: string, op: string) => flow(host, { action: 'worker', taskId, workerId, op });
  const status = (id: string) => host.task('t1')!.workers.find(entry => entry.id === id);
  expect(worker('t1', 'run', 'stop').ok).toBe(true);
  expect(status('run')?.status).toBe('stopped');
  expect(worker('t1', 'run', 'resume').ok).toBe(true);
  expect(status('run')).toMatchObject({ status: 'queued', attempt: 1 });
  // A failure uses one attempt, a stop does not.
  expect(worker('t1', 'bad', 'retry').ok).toBe(true);
  expect(status('bad')).toMatchObject({ status: 'queued', attempt: 2 });
  expect(worker('t1', 'stop', 'skip').ok).toBe(true);
  expect(status('stop')).toMatchObject({ status: 'stopped', abandoned: true });
  expect(host.commands.every(command => command.command === 'architect_worker_control')).toBe(true);
  // The state each operation needs: a completed or skipped worker is settled, a running one is not failed, a stopped one is not retried.
  for (const [id, op] of [['done', 'stop'], ['done', 'skip'], ['gone', 'skip'], ['gone', 'resume'], ['done', 'retry'], ['seat', 'stop']] as const) expect(code(worker('t1', id, op)), `${id} ${op}`).toBe('Conflict');
  // A reviewer is replaced by a fresh one, never retried; an unknown worker is NotFound.
  expect(worker('t1', 'seat', 'retry')).toMatchObject({ ok: false, error: { code: 'Conflict', path: 'workerId', ids: ['reviewer'] } });
  expect(worker('t1', 'ghost', 'stop')).toMatchObject({ ok: false, error: { code: 'NotFound', path: 'workerId' } });
  // No team, a task on another computer.
  expect(code(worker('plain', 'x', 'stop'))).toBe('Conflict');
  expect(code(worker('mirror', 'run', 'stop'))).toBe('UnsupportedCapability');
});

test('extensions runtime tasks flow: a paused team retries and resumes through its own Resume, and a finished team refuses', () => {
  const host = controller();
  const paused = host.task('paused')!;
  expect(flow(host, { action: 'worker', taskId: 'paused', workerId: 'bad', op: 'retry' }).ok).toBe(true);
  // The team's own Resume queues every stopped or failed worker, as the Resume button does.
  expect(host.commands.map(command => command.command)).toEqual(['architect_control']);
  expect(paused.teamStatus).toBe('running');
  expect(paused.workers.filter(entry => entry.status === 'queued').map(entry => entry.id).sort()).toEqual(['bad', 'seat', 'stop']);
  expect(paused.workers.find(entry => entry.id === 'bad')?.attempt).toBe(2);
  expect(paused.workers.find(entry => entry.id === 'gone')?.status).toBe('stopped');
  host.task('t1')!.teamStatus = 'completed';
  expect(flow(host, { action: 'worker', taskId: 't1', workerId: 'bad', op: 'retry' })).toMatchObject({ ok: false, error: { code: 'Conflict', path: 'worker', ids: ['teamFinished'] } });
  // Stopping still reaches the one worker of a paused team.
  host.task('paused')!.teamStatus = 'paused';
  host.task('paused')!.workers.find(entry => entry.id === 'bad')!.status = 'running';
  expect(flow(host, { action: 'worker', taskId: 'paused', workerId: 'bad', op: 'stop' }).ok).toBe(true);
  expect(host.commands.at(-1)?.command).toBe('architect_worker_control');
});

test('extensions runtime tasks flow: a usage-limit pause is continued, resumed at its reset or dismissed', () => {
  const host = controller();
  expect(flow(host, { action: 'limit', taskId: 'bot-thread', op: 'resume' }).ok).toBe(true);
  expect(host.task('bot-thread')).toMatchObject({ resumeAtReset: true, limited: true });
  expect(flow(host, { action: 'limit', taskId: 'bot-thread', op: 'continue' }).ok).toBe(true);
  expect(host.task('bot-thread')).toMatchObject({ limited: false, resumeAtReset: false });
  expect(host.followUps).toEqual([{ taskId: 'bot-thread', text: CONTINUE_TEXT }]);
  expect(flow(host, { action: 'limit', taskId: 't1', op: 'continue', options: { connection: 'work-account', harness: 'claude' } }).ok).toBe(true);
  expect(host.task('t1')).toMatchObject({ connection: 'work-account', limited: false });
  expect(flow(host, { action: 'limit', taskId: 'paused', op: 'dismiss' }).ok).toBe(true);
  expect(host.task('paused')?.limited).toBe(false);
  expect(host.commands.map(command => command.command)).toEqual(['set_resume_at_reset', 'send_message', 'continue_on_connection', 'clear_usage_limit']);
  // A task that is not limited has nothing to answer; a connection that is not an alternative, another harness and a mirror are refused.
  expect(flow(host, { action: 'limit', taskId: 'idle', op: 'dismiss' })).toMatchObject({ ok: false, error: { code: 'Conflict', path: 'limit', ids: ['notLimited'] } });
  const other = controller();
  expect(flow(other, { action: 'limit', taskId: 't1', op: 'continue', options: { connection: 'ghost' } })).toMatchObject({ ok: false, error: { code: 'NotFound' } });
  expect(flow(other, { action: 'limit', taskId: 't1', op: 'continue', options: { harness: 'codex' } })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'harness' } });
  expect(flow(other, { action: 'limit', taskId: 'mirror', op: 'continue', options: { connection: 'work-account' } })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'connection' } });
  other.task('t1')!.resetKnown = false;
  expect(flow(other, { action: 'limit', taskId: 't1', op: 'resume' })).toMatchObject({ ok: false, error: { code: 'Conflict', ids: ['noReset'] } });
  expect(other.commands).toEqual([]);
});

test('extensions runtime tasks flow: an action that needs the window is UnsupportedCapability in headless mode and changes nothing', () => {
  const host = controller(undefined, true);
  for (const raw of [{ action: 'council', taskId: 't1', decision: 'dismiss' }, { action: 'council', taskId: 't1', decision: 'keepFixing' }, { action: 'limit', taskId: 't1', op: 'continue' }]) expect(code(flow(host, raw)), JSON.stringify(raw)).toBe('UnsupportedCapability');
  expect(host.followUps).toEqual([]);
  expect(host.log.size).toBe(0);
  // What the host does by itself still works.
  expect(flow(host, { action: 'council', taskId: 't1', decision: 'accept' }).ok).toBe(true);
  expect(flow(host, { action: 'limit', taskId: 't1', op: 'dismiss' }).ok).toBe(true);
});

test('extensions runtime tasks flow: every shape is refused with its reason', () => {
  const world: World = { taskProject: () => 'A', granted: () => true, holdsAny: () => true };
  const bad: [unknown, string, string?][] = [
    ['text', 'InvalidShape'], [{ action: 'council' }, 'InvalidShape'], [{ taskId: 't1' }, 'InvalidShape'], [{ action: 'stop', taskId: 't1' }, 'InvalidShape'], [{ action: 'council', taskId: '' }, 'InvalidShape'],
    [{ action: 'council', taskId: 't1' }, 'InvalidShape', 'decision'], [{ action: 'council', taskId: 't1', decision: 'yes' }, 'InvalidShape', 'decision'], [{ action: 'council', taskId: 't1', decision: 'accept', op: 'stop' }, 'InvalidShape'],
    [{ action: 'worker', taskId: 't1', op: 'stop' }, 'InvalidShape', 'workerId'], [{ action: 'worker', taskId: 't1', workerId: 'w', op: 'kill' }, 'InvalidShape', 'op'], [{ action: 'worker', taskId: 't1', workerId: 'w', op: 'stop', decision: 'accept' }, 'InvalidShape'],
    [{ action: 'limit', taskId: 't1' }, 'InvalidShape', 'op'], [{ action: 'limit', taskId: 't1', op: 'wait' }, 'InvalidShape', 'op'], [{ action: 'limit', taskId: 't1', op: 'dismiss', options: {} }, 'InvalidShape', 'options'],
    [{ action: 'limit', taskId: 't1', op: 'continue', options: 'c1' }, 'InvalidShape', 'options'], [{ action: 'limit', taskId: 't1', op: 'continue', options: { model: 'm' } }, 'InvalidShape', 'model'],
    [{ action: 'limit', taskId: 't1', op: 'continue', options: { connection: null } }, 'InvalidShape', 'connection'], [{ action: 'limit', taskId: 't1', op: 'dismiss', source: 'other' }, 'InvalidShape'],
  ];
  for (const [raw, expected, path] of bad) {
    const refusal = envelope(admit(world, raw) as never).error;
    expect([refusal.code, path === undefined ? undefined : refusal.path], JSON.stringify(raw)).toEqual([expected, path]);
  }
  expect(ACTIONS).toEqual(['council', 'worker', 'limit']);
});

test('extensions runtime tasks flow: no grant, a narrowed project or a foreign task is PermissionDenied naming the permission, and nothing leaks', () => {
  const host = controller();
  const calls = [{ action: 'council', taskId: 't1', decision: 'accept' }, { action: 'worker', taskId: 't1', workerId: 'run', op: 'stop' }, { action: 'limit', taskId: 't1', op: 'dismiss' }];
  for (const projects of [[], ['B']]) for (const raw of calls) expect(flow(host, raw, projects), JSON.stringify(raw)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  // A cross-task id (a task of a project outside the grant) is the same refusal; a package with no grant is not told a task exists.
  expect(code(flow(host, { action: 'limit', taskId: 't2', op: 'dismiss' }, ['A']))).toBe('PermissionDenied');
  expect(code(flow(host, { action: 'limit', taskId: 'ghost', op: 'dismiss' }, []))).toBe('PermissionDenied');
  expect(code(flow(host, { action: 'limit', taskId: 'ghost', op: 'dismiss' }, ['A']))).toBe('NotFound');
  expect([host.commands.length, host.log.size]).toEqual([0, 0]);
  // The grant is read again before anything changes: a revoke between admission and the first command changes nothing, and another task still works.
  let projects = ['A'];
  const racing = host.flow(OWNER, { granted: project => projects.includes(project), package: NAME }, { action: 'council', taskId: 't1', decision: 'accept' }, () => { projects = []; });
  expect(racing).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  expect([host.task('t1')?.councilAccepted, host.commands.length, host.log.size]).toEqual([undefined, 0, 0]);
  expect(flow(host, { action: 'limit', taskId: 'bot-thread', op: 'dismiss' }, ['A']).ok).toBe(true);
});

test('extensions runtime tasks flow: the host text mapping, the ledger and the labels are the frozen ones', () => {
  for (const [text, expected] of [['The team is already working.', 'Conflict'], ['This worker is not running.', 'Conflict'], ['Resume the team first.', 'Conflict'], ['This task has no team.', 'Conflict'],
    ['This task has no usage limit with a known reset time.', 'Conflict'], ['Worker does not belong to this team.', 'NotFound'], ['This task is gone.', 'NotFound'], ["This task's team runs on Studio.", 'UnsupportedCapability'],
    ['Stop the agent before changing its connection.', 'Conflict'], ['disk on fire', 'HostUnavailable']]) expect(flowCodeOf(text), text).toBe(expected);
  const host = controller();
  flow(host, { action: 'council', taskId: 't1', decision: 'accept' });
  flow(host, { action: 'worker', taskId: 't1', workerId: 'run', op: 'stop' });
  expect(host.log.snapshot().controls.t1).toMatchObject({ action: 'worker', detail: { call: { workerId: 'run', op: 'stop' }, commands: ['architect_worker_control'] }, package: NAME, owner: OWNER });
  expect(host.log instanceof ControlLog).toBe(true);
  const facts: TaskFacts = { harness: 'claude', remote: false, team: true, teamActive: true, teamResumable: false, council: true, workers: [], running: false, limited: true, resetKnown: true };
  expect(check({ taskId: 't1', projectId: 'A', action: { kind: 'council', decision: 'accept' } }, facts)).toBeUndefined();
});

test('extensions runtime tasks flow: the host wires the three calls, the request, the window round and the registrations', () => {
  const host = read('src-tauri/src/extensions/node-host.cjs');
  expect(host).toContain("rpc('tasksFlow'");
  for (const call of ['council:', 'worker:', 'limit:']) expect(host, call).toContain(call);
  const lifetime = read('src-tauri/src/extensions/runtime_service_lifetime.rs');
  expect(lifetime).toContain('runtime_tasks_flow::serve');
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_tasks_flow');
  expect(read('src-tauri/src/architect.rs')).toContain('runtime_tasks_flow_workers.rs');
  const rust = read('src-tauri/src/extensions/runtime_tasks_flow.rs');
  for (const name of ['architect_council_accept', 'architect_worker_control', 'clear_usage_limit', 'set_resume_at_reset', 'extensions-runtime-task-flow']) expect(rust, name).toContain(name);
  const sdk = read('src/extensions/sdk/index.d.ts');
  for (const call of ['council(taskId', 'worker(taskId', 'limit(taskId']) expect(sdk, call).toContain(call);
  const tasksApi = sdk.indexOf('interface TasksApi');
  expect(sdk.slice(tasksApi, sdk.indexOf('\n}', tasksApi))).not.toMatch(/pair|remoteAccess/i);
  expect(read('src/main.ts')).toContain('startRuntimeTaskFlow');
  expect(read('src/bridge.ts')).toContain("'extensions-runtime-task-flow'");
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-tasks-flow.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

test('extensions runtime tasks flow: the window answers each round it owns, and a task it does not know is NotFound', async () => {
  const calls: string[] = [];
  const host: FlowHost = {
    councilKeepFixing: async taskId => { calls.push(`keep:${taskId}`); if (taskId === 'gone') throw new Error('This task is gone.'); if (taskId === 'busy') throw new Error('The team is already working.'); if (taskId === 'odd') throw new Error('disk on fire'); },
    councilDismiss: taskId => { calls.push(`dismiss:${taskId}`); return taskId === 'gone' ? 'NotFound' : 'ok'; },
    limitContinue: async (taskId, connection) => { calls.push(`continue:${taskId}:${connection}`); return taskId === 'gone' ? 'NotFound' : taskId === 'busy' ? 'Conflict' : 'ok'; },
  };
  expect(await answerRound(host, { id: 'a', taskId: 't1', kind: 'councilKeepFixing' })).toEqual({ ok: true });
  expect(await answerRound(host, { id: 'b', taskId: 'gone', kind: 'councilKeepFixing' })).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, { id: 'c', taskId: 'busy', kind: 'councilKeepFixing' })).toEqual({ ok: false, code: 'Conflict' });
  expect(await answerRound(host, { id: 'd', taskId: 'odd', kind: 'councilKeepFixing' })).toEqual({ ok: false, code: 'HostUnavailable' });
  expect(await answerRound(host, { id: 'e', taskId: 't1', kind: 'councilDismiss' })).toEqual({ ok: true });
  expect(await answerRound(host, { id: 'f', taskId: 'gone', kind: 'councilDismiss' })).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, { id: 'g', taskId: 't1', kind: 'limitContinue', connection: 'work-account' })).toEqual({ ok: true });
  expect(await answerRound(host, { id: 'h', taskId: 'busy', kind: 'limitContinue' })).toEqual({ ok: false, code: 'Conflict' });
  expect(calls).toContain('continue:t1:work-account');
  expect(calls).toContain('continue:busy:null');
});

type Seams = { __runtimeTaskFlow?: { answer(round: unknown): Promise<void> }; __runtimeTaskDefaultsAnswers?: { id: string; answer: Record<string, unknown> }[] };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeTaskFlow))).toBe(true);
}

test('extensions runtime tasks flow: the main window refuses a round for a task it does not hold, with the frozen code', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const flow = (window as unknown as Seams).__runtimeTaskFlow!;
    await flow.answer({ id: 'r1', taskId: 'no-such-task', kind: 'councilDismiss' });
    await flow.answer({ id: 'r2', taskId: 'no-such-task', kind: 'councilKeepFixing' });
    await flow.answer({ id: 'r3', taskId: 'no-such-task', kind: 'limitContinue', connection: null });
  });
  const answers = await page.evaluate(() => (window as unknown as Seams).__runtimeTaskDefaultsAnswers ?? []);
  expect(answers.map(entry => entry.id)).toEqual(['r1', 'r2', 'r3']);
  for (const entry of answers) expect(entry.answer, entry.id).toMatchObject({ ok: false, code: 'NotFound' });
});
