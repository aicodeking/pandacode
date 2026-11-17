// Councils, workers and usage-limit pauses for background services (`tasks.control`, runtime phase R4, slice R0404B).
//
// The native rules live in src-tauri/src/extensions/runtime_tasks_flow.rs (and runtime_tasks_flow_workers.rs for one worker of a
// team); the first half of this file mirrors them with no I/O for the browser preview and the deterministic checks of
// tests/extensions-runtime-tasks-flow.spec.ts. The second half is what the main window runs: the rounds only it can answer (the
// Council strip's dismissal and "Keep fixing" follow-up, the banner's "Continue", possibly on another connection). Everything here
// is for predictability and fault isolation, never for trust (ADR-0005): a package that holds `tasks.control` for a project is
// never asked per action, and none of these operations is an irreversible deletion, so no host confirmation stands in the way.
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';
import { ControlLog, codeOf, type Command } from './runtime-tasks-control';

export const PERMISSION = 'tasks.control';
export const ACTIONS = ['council', 'worker', 'limit'] as const;
export const DECISIONS = ['accept', 'dismiss', 'keepFixing'] as const;
export const WORKER_OPS = ['retry', 'resume', 'skip', 'stop'] as const;
export const LIMIT_OPS = ['continue', 'resume', 'dismiss'] as const;
export const KEEP_FIXING_TEXT = 'Keep fixing until every reviewer reaches the target.';
export const CONTINUE_TEXT = 'Continue where you left off.';
export const FLOW_EVENT = 'extensions-runtime-task-flow';
const KEYS = ['action', 'taskId', 'decision', 'workerId', 'op', 'options', 'source'] as const;
const OPTION_KEYS = ['connection', 'harness'] as const;

export type Decision = (typeof DECISIONS)[number];
export type WorkerOp = (typeof WORKER_OPS)[number];
export type LimitOp = (typeof LIMIT_OPS)[number];
export type Action =
  | { kind: 'council'; decision: Decision }
  | { kind: 'worker'; workerId: string; op: WorkerOp }
  | { kind: 'limit'; op: LimitOp; connection?: string; harness?: string };
export type Spec = { taskId: string; projectId: string; action: Action };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
const conflict = (path: string, reason: string): Refusal => refuse('Conflict', path, [reason]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** What the app answers about the world; the spec gives fixed answers. */
export type World = { taskProject: (taskId: string) => string | undefined; granted: (projectId: string) => boolean; holdsAny: () => boolean };

/** Reads a request in the frozen order: the task id and action name, the permission (the task's project), then the rest of the shape. */
export function admit(world: World, raw: unknown): Spec | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  if (!ident(raw.taskId) || !oneOf(ACTIONS, raw.action)) return refuse('InvalidShape');
  const taskId = raw.taskId, name = raw.action;
  const projectId = world.taskProject(taskId);
  if (projectId === undefined) return world.holdsAny() ? refuse('NotFound') : denied();
  if (!world.granted(projectId)) return denied();
  if (Object.keys(raw).some(key => !(KEYS as readonly string[]).includes(key))) return refuse('InvalidShape');
  if (raw.source !== undefined && raw.source !== 'service' && raw.source !== 'hook') return refuse('InvalidShape');
  const extra = (...keys: string[]) => keys.some(key => key in raw);
  if (name === 'council') {
    if (extra('workerId', 'op', 'options')) return refuse('InvalidShape');
    return oneOf(DECISIONS, raw.decision) ? { taskId, projectId, action: { kind: 'council', decision: raw.decision } } : refuse('InvalidShape', 'decision');
  }
  if (name === 'worker') {
    if (extra('decision', 'options')) return refuse('InvalidShape');
    if (!ident(raw.workerId)) return refuse('InvalidShape', 'workerId');
    return oneOf(WORKER_OPS, raw.op) ? { taskId, projectId, action: { kind: 'worker', workerId: raw.workerId, op: raw.op } } : refuse('InvalidShape', 'op');
  }
  if (extra('decision', 'workerId')) return refuse('InvalidShape');
  if (!oneOf(LIMIT_OPS, raw.op)) return refuse('InvalidShape', 'op');
  let connection: string | undefined, harness: string | undefined;
  if ('options' in raw) {
    // Only a continue moves to another connection; the other two answer the pause itself.
    if (!record(raw.options) || raw.op !== 'continue') return refuse('InvalidShape', 'options');
    const unknown = Object.keys(raw.options).find(key => !(OPTION_KEYS as readonly string[]).includes(key));
    if (unknown !== undefined) return refuse('InvalidShape', unknown);
    if ('connection' in raw.options) { if (!ident(raw.options.connection)) return refuse('InvalidShape', 'connection'); connection = raw.options.connection; }
    if ('harness' in raw.options) { if (!ident(raw.options.harness)) return refuse('InvalidShape', 'harness'); harness = raw.options.harness; }
  }
  const action: Action = { kind: 'limit', op: raw.op, ...(connection !== undefined ? { connection } : {}), ...(harness !== undefined ? { harness } : {}) };
  return { taskId, projectId, action };
}

// ---- What the interface requires of the task -------------------------------------------------------------------------------

export type WorkerFact = { id: string; status: string; abandoned?: boolean; reviewer?: boolean };
export type TaskFacts = {
  harness: string; remote: boolean; team: boolean; teamActive: boolean; teamResumable: boolean; council: boolean; workers: readonly WorkerFact[];
  running: boolean; limited: boolean; resetKnown: boolean;
};

/** The state the interface needs for the same button: refused before anything changes. */
export function check(spec: Spec, facts: TaskFacts): Refusal | undefined {
  const action = spec.action;
  if (action.kind === 'council') {
    if (facts.remote) return refuse('UnsupportedCapability', 'council');
    if (!facts.team) return conflict('council', 'noTeam');
    if (!facts.council) return conflict('council', 'councilOff');
    if (action.decision === 'keepFixing' && facts.running) return conflict('council', 'running');
    return undefined;
  }
  if (action.kind === 'worker') {
    if (facts.remote) return refuse('UnsupportedCapability', 'worker');
    if (!facts.team) return conflict('worker', 'noTeam');
    const worker = facts.workers.find(entry => entry.id === action.workerId);
    if (!worker) return refuse('NotFound', 'workerId');
    const working = ['queued', 'running', 'waiting', 'parked'].includes(worker.status);
    const allowed = action.op === 'stop' ? working : action.op === 'skip' ? worker.status !== 'completed' && !worker.abandoned
      : action.op === 'retry' ? worker.status === 'failed' && !worker.abandoned : worker.status === 'stopped' && !worker.abandoned;
    if (!allowed) return conflict('op', 'workerState');
    if (action.op === 'retry' || action.op === 'resume') {
      if (worker.reviewer) return conflict('workerId', 'reviewer');
      if (!facts.teamActive && !facts.teamResumable) return conflict('worker', 'teamFinished');
    }
    return undefined;
  }
  if (!facts.limited) return conflict('limit', 'notLimited');
  if (action.op === 'resume' && !facts.resetKnown) return conflict('limit', 'noReset');
  if (action.op === 'continue') {
    if (facts.remote && action.connection !== undefined) return refuse('UnsupportedCapability', 'connection');
    if (action.harness !== undefined && action.harness !== facts.harness) return refuse('UnsupportedCapability', 'harness');
    if (facts.running && !facts.team) return conflict('limit', 'running');
  }
  return undefined;
}

// ---- The operations an action runs -------------------------------------------------------------------------------------------

/** The commands an action runs, with the names and arguments the interface (and the window's own functions) use for the same choice. */
export function plan(spec: Spec, facts: Pick<TaskFacts, 'teamActive' | 'teamResumable'>): Command[] {
  const sessionId = spec.taskId, action = spec.action;
  if (action.kind === 'council') {
    if (action.decision === 'accept') return [{ command: 'architect_council_accept', args: { sessionId } }];
    if (action.decision === 'dismiss') return [{ command: 'council_dismiss', args: { sessionId } }];
    return [{ command: 'send_message', args: { sessionId, text: KEEP_FIXING_TEXT } }];
  }
  if (action.kind === 'worker') {
    // A paused, failed or interrupted team takes the team's own Resume; a running one takes the one worker back.
    if ((action.op === 'retry' || action.op === 'resume') && !facts.teamActive && facts.teamResumable) return [{ command: 'architect_control', args: { sessionId, action: 'resume' } }];
    return [{ command: 'architect_worker_control', args: { sessionId, workerId: action.workerId, action: action.op } }];
  }
  if (action.op === 'continue') return action.connection !== undefined ? [{ command: 'continue_on_connection', args: { sessionId, connectionId: action.connection } }] : [{ command: 'send_message', args: { sessionId, text: CONTINUE_TEXT } }];
  if (action.op === 'resume') return [{ command: 'set_resume_at_reset', args: { sessionId, enabled: true } }];
  return [{ command: 'clear_usage_limit', args: { sessionId } }];
}

/** The text of a failed host operation, as the frozen code (the window's and the team's messages included). */
export function flowCodeOf(error: string): string {
  const lower = error.toLowerCase();
  if (['stop the agent', 'already working', 'wait for', 'not running', 'already settled', 'resume the team', 'not waiting', 'skipped', 'no usage limit', 'has no team', 'team is unavailable', 'council is off'].some(part => lower.includes(part))) return 'Conflict';
  if (lower.includes('does not belong') || lower.includes('this task is gone')) return 'NotFound';
  if (lower.includes('team runs on')) return 'UnsupportedCapability';
  return codeOf(error);
}

// ---- The preview controller --------------------------------------------------------------------------------------------------

export type TeamStatus = 'running' | 'waiting' | 'paused' | 'failed' | 'interrupted' | 'completed';
/** One task of the preview world: what the native store and team rows hold. */
export type PreviewFlowTask = {
  id: string; projectId: string; harness: string; remote: boolean; running: boolean;
  team: boolean; teamStatus: TeamStatus; council: boolean; workers: { id: string; status: string; abandoned?: boolean; reviewer?: boolean; attempt: number }[];
  limited: boolean; resetKnown: boolean; resumeAtReset: boolean; connection: string | null;
  councilAccepted?: boolean; councilDismissed?: boolean;
};
export type FlowWorld = {
  tasks: PreviewFlowTask[];
  /** Other connections of a harness a limited task can continue on. */
  connections: Record<string, readonly string[]>;
  /** The window cannot answer (headless): its rounds are `UnsupportedCapability`. */
  headless?: boolean;
};
export type FlowChecks = { granted: (projectId: string) => boolean; holdsAny?: () => boolean; package: string };

/** The deterministic twin of the native `serve` + `apply`: same order of checks, same commands, same refusals, same labels. */
export class FlowController {
  readonly log = new ControlLog();
  /** Every command a flow ran, in order: the parity recording an action is compared with. */
  readonly commands: Command[] = [];
  /** What the window did for the rounds only it can run (follow-ups sent, strips dismissed). */
  readonly followUps: { taskId: string; text: string }[] = [];
  private clock = 0;
  private world: FlowWorld;
  constructor(world: FlowWorld) { this.world = world; }

  task(id: string): PreviewFlowTask | undefined { return this.world.tasks.find(entry => entry.id === id); }

  private facts(task: PreviewFlowTask): TaskFacts {
    return {
      harness: task.harness, remote: task.remote, team: task.team, teamActive: task.team && ['running', 'waiting'].includes(task.teamStatus), teamResumable: task.team && ['paused', 'failed', 'interrupted'].includes(task.teamStatus),
      council: task.team && task.council, workers: task.workers, running: task.running, limited: task.limited, resetKnown: task.resetKnown,
    };
  }

  flow(owner: string, checks: FlowChecks, raw: unknown, between: () => void = () => undefined): Reply<null> {
    const world: World = { taskProject: id => this.task(id)?.projectId, granted: checks.granted, holdsAny: checks.holdsAny ?? (() => this.world.tasks.some(entry => checks.granted(entry.projectId))) };
    const spec = admit(world, raw);
    if (isRefusal(spec)) return envelope(spec);
    const task = this.task(spec.taskId) as PreviewFlowTask;
    const facts = this.facts(task);
    const refused = check(spec, facts);
    if (refused) return envelope(refused);
    between();
    if (!checks.granted(spec.projectId)) return envelope(denied());
    const commands = plan(spec, facts);
    for (const command of commands) {
      const code = this.run(command, spec, task);
      if (code) return envelope(refuse(code));
      this.commands.push(command);
    }
    this.log.record({ taskId: task.id, action: spec.action.kind, detail: { call: callOf(spec.action), commands: commands.map(command => command.command) }, owner, package: checks.package, at: ++this.clock });
    return { ok: true, value: null };
  }

  private run(command: Command, spec: Spec, task: PreviewFlowTask): string | null {
    const action = spec.action;
    switch (command.command) {
      case 'architect_council_accept': task.councilAccepted = true; return null;
      case 'council_dismiss': if (this.world.headless) return 'UnsupportedCapability'; task.councilDismissed = true; return null;
      case 'send_message':
        if (this.world.headless) return 'UnsupportedCapability';
        if (task.running && !task.team) return 'Conflict';
        this.followUps.push({ taskId: task.id, text: String(command.args.text) });
        if (action.kind === 'limit') { task.limited = false; task.resumeAtReset = false; }
        return null;
      case 'continue_on_connection': {
        if (this.world.headless) return 'UnsupportedCapability';
        const wanted = String(command.args.connectionId);
        if (!(this.world.connections[task.harness] ?? []).includes(wanted) || task.connection === wanted) return 'NotFound';
        task.connection = wanted; task.limited = false; task.resumeAtReset = false;
        this.followUps.push({ taskId: task.id, text: CONTINUE_TEXT });
        return null;
      }
      case 'set_resume_at_reset': task.resumeAtReset = true; return null;
      case 'clear_usage_limit': task.limited = false; task.resumeAtReset = false; return null;
      case 'architect_control': {
        // The team's own Resume: every stopped worker is queued, every failed one queued with an attempt used.
        task.teamStatus = 'running';
        for (const worker of task.workers) {
          if (worker.abandoned) continue;
          if (worker.status === 'stopped') worker.status = 'queued';
          else if (worker.status === 'failed') { worker.status = 'queued'; worker.attempt += 1; }
        }
        return null;
      }
      case 'architect_worker_control': {
        if (action.kind !== 'worker') return 'InvalidShape';
        const worker = task.workers.find(entry => entry.id === action.workerId);
        if (!worker) return 'NotFound';
        if (action.op === 'stop') worker.status = 'stopped';
        else if (action.op === 'skip') { worker.status = ['queued', 'running', 'waiting', 'parked'].includes(worker.status) ? 'stopped' : worker.status; worker.abandoned = true; }
        else { if (worker.status === 'failed') worker.attempt += 1; worker.status = 'queued'; }
        return null;
      }
      default: return 'UnsupportedCapability';
    }
  }
}
const callOf = (action: Action): Json => action.kind === 'council' ? { decision: action.decision } : action.kind === 'worker' ? { workerId: action.workerId, op: action.op } : { op: action.op, connection: action.connection ?? null };

// ---- The main window -------------------------------------------------------------------------------------------------------------

export type RoundKind = 'councilDismiss' | 'councilKeepFixing' | 'limitContinue';
export type Round = { id: string; owner?: string; taskId: string; kind: RoundKind; connection?: string | null };
/** What the main window supplies: the three rounds only it can run. Each answers whether it could. */
export type FlowHost = {
  /** Sends the strip's "Keep fixing" follow-up (it throws with the reason when it cannot go). */
  councilKeepFixing: (taskId: string) => Promise<void>;
  /** The strip's close button. */
  councilDismiss: (taskId: string) => 'ok' | 'NotFound';
  /** The banner's Continue, on another connection when one is named. */
  limitContinue: (taskId: string, connection: string | null) => Promise<'ok' | 'NotFound' | 'Conflict'>;
};
let started = false;

/** The answer the window gives a round: `{ ok: true }` or `{ ok: false, code }`. */
export async function answerRound(host: FlowHost, round: Round): Promise<Json> {
  try {
    if (round.kind === 'councilDismiss') { const result = host.councilDismiss(round.taskId); return result === 'ok' ? { ok: true } : { ok: false, code: result }; }
    if (round.kind === 'limitContinue') { const result = await host.limitContinue(round.taskId, round.connection ?? null); return result === 'ok' ? { ok: true } : { ok: false, code: result }; }
    await host.councilKeepFixing(round.taskId);
    return { ok: true };
  } catch (error) {
    const code = flowCodeOf(error instanceof Error ? error.message : String(error));
    return { ok: false, code: code === 'Conflict' || code === 'NotFound' ? code : 'HostUnavailable' };
  }
}

/** Answers the rounds a flow waits for (the answer travels the same channel a start's defaults do). */
export async function startRuntimeTaskFlow(host: FlowHost): Promise<void> {
  if (started) return;
  started = true;
  const { call, subscribe, preview } = await import('../bridge');
  const answer = async (round: Round) => {
    const reply = await answerRound(host, round);
    try { await call('extensions_runtime_task_defaults_answer', { id: round.id, answer: reply }); } catch { /* the flow timed out or ended: nothing waits */ }
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeTaskFlow = { answer };
  try { await subscribe(FLOW_EVENT, event => { void answer(event); }); } catch { /* no events */ }
}

/** Test seam: forget the started flag so a spec can start the window half again. */
export function resetRuntimeTaskFlow(): void { started = false; }
