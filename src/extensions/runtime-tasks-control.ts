// Attributed task control for background services (`tasks.control`, runtime phase R4, slice R0404).
//
// The native rules live in src-tauri/src/extensions/runtime_tasks_control.rs; the first half of this file mirrors them with no
// I/O for the browser preview and the deterministic checks of tests/extensions-runtime-tasks-control.spec.ts. The second half
// is what the main window runs: it applies the "Run on" choice of a new conversation (which only the window holds) and marks
// every task a package last controlled with the package's name in the thread header. Everything here is for predictability and
// fault isolation, never for trust (ADR-0005): a package that holds `tasks.control` for a project is never asked per action.
// Councils, workers and usage-limit pauses are R0404B and have no call here.
import type { Json } from './contracts';
import { MODES, envelope, type Mode, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'tasks.control';
export const STAGES = ['active', 'completed'] as const;
export const ACTIONS = ['stop', 'setMode', 'configure', 'compact'] as const;
export const LOCAL = 'local';
export const CONFIGURE_KEYS = ['harness', 'model', 'effort', 'team', 'connection', 'bot', 'target', 'stage'] as const;
export const MAX_LOG = 1_000;
export const COMPACT_COMMAND = '/compact';
const KEYS = ['action', 'taskId', 'mode', 'change', 'source'] as const;

export type Action = (typeof ACTIONS)[number];
export type Source = 'service' | 'hook';
/** Nullable fields: `null` clears, `undefined` leaves alone. */
export type Change = { harness?: string; model?: string; effort?: string | null; team?: string | null; connection?: string | null; bot?: string | null; target?: string; stage?: (typeof STAGES)[number] };
export type Spec = { taskId: string; projectId: string; action: Action; mode?: Mode; change?: Change };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

/** What the app answers about the world; the spec gives fixed answers. */
export type World = {
  taskProject: (taskId: string) => string | undefined;
  granted: (projectId: string) => boolean;
  holdsAny: () => boolean;
  targetPaired: (target: string) => boolean;
};

function text(raw: Record<string, unknown>, key: string): string | undefined | Refusal {
  if (!(key in raw)) return undefined;
  return ident(raw[key]) ? (raw[key] as string) : refuse('InvalidShape', key);
}
/** `undefined` (absent), `null` (clear) or a text. */
function nullable(raw: Record<string, unknown>, key: string): string | null | undefined | Refusal {
  if (!(key in raw)) return undefined;
  if (raw[key] === null) return null;
  return ident(raw[key]) ? (raw[key] as string) : refuse('InvalidShape', key);
}

function readChange(world: World, raw: unknown): Change | Refusal {
  if (!record(raw) || Object.keys(raw).length === 0) return refuse('InvalidShape', 'change');
  const unknown = Object.keys(raw).find(key => !(CONFIGURE_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) return refuse('InvalidShape', unknown);
  const harness = text(raw, 'harness'), model = text(raw, 'model'), target = text(raw, 'target'), stage = text(raw, 'stage');
  for (const part of [harness, model, target, stage]) if (isRefusal(part)) return part;
  if (harness !== undefined && model === undefined) return refuse('InvalidShape', 'model');
  const effort = nullable(raw, 'effort'), team = nullable(raw, 'team'), connection = nullable(raw, 'connection'), bot = nullable(raw, 'bot');
  for (const part of [effort, team, connection, bot]) if (isRefusal(part)) return part;
  if (stage !== undefined && !(STAGES as readonly string[]).includes(stage as string)) return refuse('InvalidShape', 'stage');
  if (target !== undefined && target !== LOCAL && !world.targetPaired(target as string)) return refuse('NotFound', 'target');
  const change: Change = {};
  if (harness !== undefined) change.harness = harness as string;
  if (model !== undefined) change.model = model as string;
  if (effort !== undefined) change.effort = effort as string | null;
  if (team !== undefined) change.team = team as string | null;
  if (connection !== undefined) change.connection = connection as string | null;
  if (bot !== undefined) change.bot = bot as string | null;
  if (target !== undefined) change.target = target as string;
  if (stage !== undefined) change.stage = stage as (typeof STAGES)[number];
  return change;
}

/** Reads a request in the frozen order: the task id and action name, the permission (the task's project), the rest of the shape, then what must exist. */
export function admit(world: World, raw: unknown): Spec | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  if (!ident(raw.taskId) || typeof raw.action !== 'string' || !(ACTIONS as readonly string[]).includes(raw.action)) return refuse('InvalidShape');
  const taskId = raw.taskId, action = raw.action as Action;
  const projectId = world.taskProject(taskId);
  if (projectId === undefined) return world.holdsAny() ? refuse('NotFound') : denied();
  if (!world.granted(projectId)) return denied();
  if (Object.keys(raw).some(key => !(KEYS as readonly string[]).includes(key))) return refuse('InvalidShape');
  if (raw.source !== undefined && raw.source !== 'service' && raw.source !== 'hook') return refuse('InvalidShape');
  const source: Source = raw.source === 'hook' ? 'hook' : 'service';
  if (action === 'stop' || action === 'compact') {
    if ('mode' in raw || 'change' in raw) return refuse('InvalidShape');
    return { taskId, projectId, action };
  }
  if (action === 'setMode') {
    if ('change' in raw) return refuse('InvalidShape');
    if (typeof raw.mode !== 'string' || !(MODES as readonly string[]).includes(raw.mode)) return refuse('InvalidShape', 'mode');
    // A hook decides about a call; it never moves the task to another mode behind the user's back.
    if (source === 'hook') return refuse('PermissionDenied', 'setMode', ['hook']);
    return { taskId, projectId, action, mode: raw.mode as Mode };
  }
  if ('mode' in raw) return refuse('InvalidShape');
  const change = readChange(world, raw.change);
  return isRefusal(change) ? change : { taskId, projectId, action, change };
}

// ---- The harness catalog -------------------------------------------------------------------------------------------------

/** What the checks need of one harness: the catalog row the model picker reads. */
export type ProviderView = {
  id: string; installed: boolean; readiness?: 'ready' | 'signedOut' | 'unavailable';
  models: readonly { id: string; efforts: readonly string[] }[]; modes: readonly string[]; compacts: boolean;
};
const unavailable = (provider: ProviderView): Refusal | undefined => {
  if (!provider.installed) return refuse('HostUnavailable', '$', ['unavailable']);
  if (provider.readiness === undefined || provider.readiness === 'ready') return undefined;
  return refuse('HostUnavailable', '$', [provider.readiness === 'signedOut' ? 'signedOut' : 'unavailable']);
};

export function checkChoice(catalog: readonly ProviderView[], current: string, change: Change): Refusal | undefined {
  const provider = catalog.find(entry => entry.id === (change.harness ?? current));
  if (!provider) return refuse('NotFound', 'harness');
  if (change.harness !== undefined || change.model !== undefined) { const blocked = unavailable(provider); if (blocked) return blocked; }
  if (change.model !== undefined && provider.models.length > 0 && !provider.models.some(model => model.id === change.model)) return refuse('NotFound', 'model');
  if (typeof change.effort === 'string' && change.model !== undefined) {
    const offered = provider.models.find(model => model.id === change.model)?.efforts;
    if (offered && offered.length > 0 && !offered.includes(change.effort)) return refuse('InvalidShape', 'effort');
  }
  return undefined;
}
export function checkMode(catalog: readonly ProviderView[], harness: string, mode: string): Refusal | undefined {
  const provider = catalog.find(entry => entry.id === harness);
  return provider && provider.modes.length > 0 && !provider.modes.includes(mode) ? refuse('UnsupportedCapability', 'mode') : undefined;
}
export function checkCompact(catalog: readonly ProviderView[], harness: string): Refusal | undefined {
  const provider = catalog.find(entry => entry.id === harness);
  if (!provider) return refuse('NotFound', 'harness');
  return provider.compacts ? undefined : refuse('UnsupportedCapability', 'compact');
}

// ---- The native operations an action runs ----------------------------------------------------------------------------------

export type TaskFacts = { harness: string; model: string; team: boolean; remote: boolean };
export type Command = { command: string; args: Record<string, Json> };

/** The commands an action runs, in order: the same ones, with the same arguments, the interface runs for the same choice. */
export function plan(spec: Spec, facts: TaskFacts): Command[] {
  const sessionId = spec.taskId;
  if (spec.action === 'stop') return [facts.team && !facts.remote ? { command: 'architect_control', args: { sessionId, action: 'stop' } } : { command: 'stop_session', args: { sessionId } }];
  if (spec.action === 'setMode') return [{ command: 'update_session', args: { sessionId, mode: spec.mode as string, warm: true } }];
  if (spec.action === 'compact') return [{ command: 'send_message', args: { sessionId, text: COMPACT_COMMAND } }];
  const change = spec.change ?? {};
  const commands: Command[] = [];
  if (change.model !== undefined) commands.push({ command: 'configure_session', args: { sessionId, provider: change.harness ?? facts.harness, model: change.model, projectId: null, warm: true } });
  if (change.effort !== undefined) commands.push({ command: 'set_reasoning_effort', args: { sessionId, reasoningEffort: change.effort, warm: true } });
  // A team profile brings its own setup (the team menu passes the profile's config and architect); `null` removes the team.
  if (change.team !== undefined) { const setup = change.team === null ? null : { fromProfile: change.team }; commands.push({ command: 'architect_configure', args: { sessionId, config: setup, architect: setup, profileId: change.team } }); }
  if (change.connection !== undefined) commands.push({ command: 'connection_assign', args: { sessionId, connectionId: change.connection } });
  if (change.bot !== undefined) commands.push({ command: 'bot_assign_task', args: { sessionId, botId: change.bot } });
  if (change.target !== undefined) commands.push({ command: 'run_on', args: { sessionId, target: change.target } });
  if (change.stage !== undefined) commands.push({ command: 'set_task_stage', args: { sessionId, stage: change.stage } });
  return commands;
}

/** Maps the text of a failed host operation to the frozen code; nothing of the text reaches the package. */
export function codeOf(error: string): string {
  const lower = error.toLowerCase();
  if (/stop the agent|start a conversation|already running|is running/.test(lower)) return 'Conflict';
  if (/already exists|already checked out|destination/.test(lower)) return 'Conflict';
  if (/permission mode|too long|effort/.test(lower)) return 'InvalidShape';
  if (/does not exist|not found|unknown/.test(lower)) return 'NotFound';
  return 'HostUnavailable';
}

// ---- Attribution ------------------------------------------------------------------------------------------------------------

export type Entry = { taskId: string; action: string; detail: Json; owner: string; package: string; at: number };
export type ControlSnapshot = { revision: number; controls: Record<string, { action: string; detail: Json; owner: string; package: string; at: number }> };

/** Every control a package made, newest last, bounded (the native ledger is the same, in memory). */
export class ControlLog {
  private entries: Entry[] = [];
  private revision_ = 0;
  record(entry: Entry): number { this.entries.push(entry); while (this.entries.length > MAX_LOG) this.entries.shift(); return ++this.revision_; }
  forget(taskId: string): boolean { const before = this.entries.length; this.entries = this.entries.filter(entry => entry.taskId !== taskId); if (this.entries.length === before) return false; this.revision_ += 1; return true; }
  forTask(taskId: string): Entry[] { return this.entries.filter(entry => entry.taskId === taskId); }
  get size() { return this.entries.length; }
  revision() { return this.revision_; }
  snapshot(): ControlSnapshot {
    const controls: ControlSnapshot['controls'] = {};
    for (const entry of this.entries) controls[entry.taskId] = { action: entry.action, detail: entry.detail, owner: entry.owner, package: entry.package, at: entry.at };
    return { revision: this.revision_, controls };
  }
}

// ---- The preview controller ----------------------------------------------------------------------------------------------------

/** One task of the preview world: what the native store row holds. */
export type PreviewTask = {
  id: string; projectId: string; harness: string; model: string; mode: string; effort: string | null; team: string | null; connection: string | null;
  bot: string | null; stage: 'active' | 'completed'; running: boolean; remote: boolean; target: string; resumeId: string | null; archived?: boolean;
};
export type ControlWorld = {
  tasks: PreviewTask[]; catalog: readonly ProviderView[]; targets: readonly string[];
  /** Harnesses whose `/compact` command resolves; the others answer `UnsupportedCapability` when the request runs. */
  compactCommands: readonly string[];
  /** Teams, connections and bots that exist. */
  teams: readonly string[]; connections: readonly string[]; bots: readonly string[];
  /** A command that fails with this host text (the spec models "Stop the agent before…" this way). */
  failCommand?: (command: Command, task: PreviewTask) => string | null;
};
export type Checks = { granted: (projectId: string) => boolean; holdsAny?: () => boolean; package: string };

/** The deterministic twin of the native `serve` + `apply`: same order of checks, same commands, same refusals, same labels. */
export class TaskController {
  readonly log = new ControlLog();
  /** Every command a control ran, in order: the parity recording an action is compared with. */
  readonly commands: Command[] = [];
  /** Who stopped each task last, as the `task.stopped` event labels it. */
  readonly stoppedBy = new Map<string, string>();
  readonly events: Json[] = [];
  private clock = 0;
  private world: ControlWorld;
  constructor(world: ControlWorld) { this.world = world; }

  task(id: string): PreviewTask | undefined { return this.world.tasks.find(entry => entry.id === id); }

  control(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<null> {
    const world: World = {
      taskProject: id => this.task(id)?.projectId, granted: checks.granted,
      holdsAny: checks.holdsAny ?? (() => this.world.tasks.some(entry => checks.granted(entry.projectId))), targetPaired: target => this.world.targets.includes(target),
    };
    const spec = admit(world, raw);
    if (isRefusal(spec)) return envelope(spec);
    const task = this.task(spec.taskId) as PreviewTask;
    const facts: TaskFacts = { harness: task.harness, model: task.model, team: task.team !== null, remote: task.remote };
    if (!task.remote) {
      const checked = spec.action === 'configure' ? checkChoice(this.world.catalog, task.harness, spec.change as Change)
        : spec.action === 'setMode' ? checkMode(this.world.catalog, task.harness, spec.mode as string)
        : spec.action === 'compact' ? checkCompact(this.world.catalog, task.harness) : undefined;
      if (checked) return envelope(checked);
    }
    between();
    if (!checks.granted(spec.projectId)) return envelope(denied());
    const done: string[] = [];
    for (const command of plan(spec, facts)) {
      const failure = this.run(command, spec, task, owner);
      if (failure) return envelope(refuse(failure.code, '$', done));
      if (this.commands.at(-1) === command) done.push(command.command);
    }
    // Stopping an idle task changes nothing, so nothing is recorded.
    if (done.length === 0 && spec.action === 'stop') return { ok: true, value: null };
    this.log.record({ taskId: task.id, action: spec.action, detail: { commands: done }, owner, package: checks.package, at: ++this.clock });
    return { ok: true, value: null };
  }

  private run(command: Command, spec: Spec, task: PreviewTask, owner: string): { code: string } | null {
    const failed = this.world.failCommand?.(command, task);
    if (failed) return { code: failed === 'UnsupportedCapability' ? failed : codeOf(failed) };
    switch (command.command) {
      case 'stop_session': case 'architect_control':
        // Stop is for a run: an idle local task has nothing to stop and is left exactly as it is.
        if (!(task.running || task.remote || task.team !== null)) return null;
        this.commands.push(command); this.stoppedBy.set(task.id, owner); task.running = false;
        this.events.push({ kind: 'task.stopped', taskId: task.id, projectId: task.projectId, by: { package: owner } });
        return null;
      case 'update_session':
        if (task.running) return { code: 'Conflict' };
        this.commands.push(command); task.mode = spec.mode as string; return null;
      case 'configure_session':
        if (task.running) return { code: 'Conflict' };
        this.commands.push(command); task.harness = spec.change?.harness ?? task.harness; task.model = spec.change?.model ?? task.model; return null;
      case 'set_reasoning_effort':
        if (task.running) return { code: 'Conflict' };
        this.commands.push(command); task.effort = spec.change?.effort ?? null; return null;
      case 'architect_configure':
        if (spec.change?.team !== null && spec.change?.team !== undefined && !this.world.teams.includes(spec.change.team)) return { code: 'NotFound' };
        this.commands.push(command); task.team = spec.change?.team ?? null; return null;
      case 'connection_assign':
        if (task.running) return { code: 'Conflict' };
        if (spec.change?.connection && !this.world.connections.includes(spec.change.connection)) return { code: 'NotFound' };
        this.commands.push(command); task.connection = spec.change?.connection ?? null; return null;
      case 'bot_assign_task':
        if (spec.change?.bot && !this.world.bots.includes(spec.change.bot)) return { code: 'NotFound' };
        this.commands.push(command); task.bot = spec.change?.bot ?? null; return null;
      case 'run_on':
        // Only a conversation that has not started yet can choose where it runs.
        if (task.running || task.resumeId !== null) return { code: 'Conflict' };
        this.commands.push(command); task.target = spec.change?.target ?? LOCAL; return null;
      case 'set_task_stage':
        if (task.running) return { code: 'Conflict' };
        this.commands.push(command); task.stage = spec.change?.stage ?? task.stage; if (task.stage === 'active') task.archived = false; return null;
      case 'send_message':
        if (task.running) return { code: 'Conflict' };
        if (!task.remote && !this.world.compactCommands.includes(task.harness)) return { code: 'UnsupportedCapability' };
        this.commands.push(command); this.events.push({ kind: 'task.compacted', taskId: task.id, projectId: task.projectId }); return null;
      default: return { code: 'UnsupportedCapability' };
    }
  }
}

// ---- The main window -------------------------------------------------------------------------------------------------------------

/** What the main window supplies: the Run on choice, which only it holds. */
export type MainHost = { chooseTarget: (taskId: string, target: string) => 'ok' | 'NotFound' | 'Conflict' };
let started = false;

/** Answers the Run on choice a control waits for (the answer travels the same channel a start's defaults do). */
export async function startRuntimeTaskControl(host: MainHost): Promise<void> {
  if (started) return;
  started = true;
  const { call, subscribe, preview } = await import('../bridge');
  const answer = async (event: { id: string; taskId: string; target: string }) => {
    let reply: Json;
    try { const result = host.chooseTarget(event.taskId, event.target); reply = result === 'ok' ? { ok: true } : { ok: false, code: result }; } catch { reply = { ok: false, code: 'HostUnavailable' }; }
    try { await call('extensions_runtime_task_defaults_answer', { id: event.id, answer: reply }); } catch { /* the control timed out or ended: nothing waits */ }
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeTaskTarget = { answer };
  try { await subscribe('extensions-runtime-task-target', event => { void answer(event); }); } catch { /* no events */ }
}

/** Test seam: forget the started flags so a spec can start the window half again. */
export function resetRuntimeTaskControl(): void { started = false; mounted = false; }

/** The label of a control as the thread header words it. */
export function label(control: { action: string; detail: Json; package: string }): string {
  const verbs: Record<string, string> = { stop: 'Stopped', setMode: 'Mode set', configure: 'Configured', compact: 'Compaction requested' };
  return `${verbs[control.action] ?? 'Controlled'} by ${control.package}`;
}

/** Puts the package name of the latest control on the thread header of the open task. Idempotent: it only touches a chip that is
 * missing or out of date, so the header's own redraws never loop with it. */
export function decorate(root: ParentNode, controls: ControlSnapshot['controls'], currentTaskId: string | null): number {
  const crumb = root.querySelector<HTMLElement>('#breadcrumb');
  if (!crumb?.parentElement) return 0;
  const control = currentTaskId ? controls[currentTaskId] : undefined;
  let chip = crumb.parentElement.querySelector<HTMLElement>(':scope > .runtime-task-control');
  if (!control) { if (chip) { chip.remove(); return 1; } return 0; }
  const wanted = label(control);
  if (chip && chip.textContent === wanted && chip.dataset.taskControl === control.owner) return 0;
  chip?.remove();
  chip = crumb.ownerDocument.createElement('span');
  // The chip wears the started-by chip's look (runtime-tasks-start.css), so it is styled from an always-loaded sheet.
  chip.className = 'runtime-task-control runtime-task-origin-header'; chip.dataset.taskControl = control.owner; chip.textContent = wanted;
  crumb.after(chip);
  return 1;
}

let mounted = false;
/** Keeps the header label equal to the host's ledger: read now, whenever the native side says it moved, and whenever the open thread redraws. */
export async function mountTaskControls(): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, subscribe, preview } = await import('../bridge');
  let controls: ControlSnapshot['controls'] = {};
  const current = () => document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? null;
  const paint = () => { decorate(document, controls, current()); };
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; paint(); }); };
  const observer = new MutationObserver(schedule);
  for (const selector of ['.conversation-pane', '#composer-area']) { const node = document.querySelector(selector); if (node) observer.observe(node, { childList: true, subtree: true }); }
  const read = async () => {
    try { controls = (await call<ControlSnapshot>('extensions_runtime_task_controls')).controls; } catch { return; }
    paint();
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeTaskControls = { set: (next: ControlSnapshot['controls']) => { controls = next; paint(); } };
  try { await subscribe('extensions-runtime-task-controls', () => { void read(); }); } catch { /* read once below */ }
  await read();
}
