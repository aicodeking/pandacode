// Harness consoles and command-center actions (`harness.console`, runtime phase R4, slice R0408).
//
// The native rules live in src-tauri/src/extensions/runtime_harness_console.rs; the first half of this file mirrors them with no
// I/O for the browser preview and the deterministic checks of tests/extensions-runtime-harness-console.spec.ts. The second half
// is what the main window runs: it answers the one round of an `open` or a `run` the host sent once it had checked the grant,
// the task, the harness and the command. The window reuses what the user uses: the console is the terminal panel's harness
// console, and a command runs through `resolve_slash_command` and the same action path as a command typed in the composer,
// with the same arguments. Every action says which package took it. A package that holds `harness.console` for a project is
// never asked again per action (ADR-0005).
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'harness.console';
export const COMMAND_CHARS = 128;
export const ARGUMENT_CHARS = 4096;
export const MAX_WAITING = 4;
const WINDOW_CODES = ['NotFound', 'Busy', 'StaleContext', 'InvalidShape', 'HostUnavailable', 'UnsupportedCapability', 'Revoked', 'Timeout'];

export type Open = { taskId: string } | { harness: string; projectId: string };
export type Request = { op: 'open'; open: Open } | { op: 'list'; harness: string } | { op: 'run'; taskId: string; command: string; arguments: string };
export type { Refusal, Reply };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

/** A command is one slash command name, as the catalog lists it (`/compact`); the slash may be left out. */
export function readCommand(text: string): string | Refusal {
  const name = text.startsWith('/') ? text.slice(1) : text;
  if (name === '' || !/^[\p{L}\p{N}_:.-]+$/u.test(name)) return refuse('InvalidShape');
  return [...name].length > COMMAND_CHARS ? refuse('LimitExceeded') : `/${name}`;
}

/** Reads a call: `{op: 'open', taskId | harness + projectId}`, `{op: 'list', harness}` or `{op: 'run', taskId, command, arguments?}`. */
export function readRequest(raw: unknown): Request | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const only = (keys: readonly string[]) => Object.keys(raw).every(key => key === 'op' || keys.includes(key));
  const idOf = (key: string): string | undefined | Refusal => (raw[key] === undefined ? undefined : ident(raw[key]) ? (raw[key] as string) : refuse('InvalidShape'));
  switch (raw.op) {
    case 'open': {
      if (!only(['taskId', 'harness', 'projectId'])) return refuse('InvalidShape');
      const [taskId, harness, projectId] = [idOf('taskId'), idOf('harness'), idOf('projectId')];
      for (const value of [taskId, harness, projectId]) if (isRefusal(value)) return value;
      if (typeof taskId === 'string' && harness === undefined && projectId === undefined) return { op: 'open', open: { taskId } };
      if (taskId === undefined && typeof harness === 'string' && typeof projectId === 'string') return { op: 'open', open: { harness, projectId } };
      return refuse('InvalidShape');
    }
    case 'list': {
      const harness = only(['harness']) ? idOf('harness') : refuse('InvalidShape');
      return typeof harness === 'string' ? { op: 'list', harness } : isRefusal(harness) ? harness : refuse('InvalidShape');
    }
    case 'run': {
      if (!only(['taskId', 'command', 'arguments']) || typeof raw.command !== 'string') return refuse('InvalidShape');
      const command = readCommand(raw.command);
      if (typeof command !== 'string') return command;
      if (raw.arguments !== undefined && raw.arguments !== null && typeof raw.arguments !== 'string') return refuse('InvalidShape');
      const args = typeof raw.arguments === 'string' ? raw.arguments.trim() : '';
      if (/\p{Cc}/u.test(args)) return refuse('InvalidShape');
      if ([...args].length > ARGUMENT_CHARS) return refuse('LimitExceeded');
      const taskId = idOf('taskId');
      return typeof taskId === 'string' ? { op: 'run', taskId, command, arguments: args } : isRefusal(taskId) ? taskId : refuse('InvalidShape');
    }
    default: return refuse('InvalidShape');
  }
}

/** The grant for the project of the target. `holds` is "the package holds this permission for any project": without it the
 * answer is the permission itself whatever the target, so a refusal never says whether a task exists. */
export function gate(holds: boolean, project: string | undefined, granted: (project: string) => boolean): string | Refusal {
  if (!holds) return denied();
  if (project === undefined) return refuse('NotFound');
  return granted(project) ? project : denied();
}

/** The list the command center shows, as `{id, title}`, without the commands that cannot run. */
export function listValue(commands: readonly { name: string; description: string; kind: string }[]): Json {
  return commands.filter(command => command.kind !== 'unsupported').map(command => ({ id: command.name, title: command.description.trim() === '' ? command.name : command.description.trim() }));
}

export function readRefusal(answer: unknown): Refusal {
  const code = record(answer) ? answer.code : undefined;
  return refuse(typeof code === 'string' && WINDOW_CODES.includes(code) ? code : 'InvalidShape');
}
/** The round for the window: `open` of a console or `run` of a command, with the package that asked. */
export function roundPayload(request: Request, taskId: string | undefined, projectId: string, harness: string, owner: string): Record<string, Json> {
  const payload: Record<string, Json> = { op: request.op, projectId, harness, package: owner };
  if (taskId !== undefined) payload.taskId = taskId;
  if (request.op === 'run') { payload.command = request.command; payload.arguments = request.arguments; }
  return payload;
}

// ---- The preview model -----------------------------------------------------------------------------------------------

/** What the world answers for a call: whether the package holds the permission at all, and for which project. */
export type Checks = { holds: boolean; granted: (projectId: string) => boolean };
export type TaskRow = { projectId: string; provider: string; running: boolean };
export type Provider = { console: boolean; commands: { name: string; description: string; kind: string }[] };

/** The deterministic twin of the native `serve` and the window's answer: same order of checks, same refusals, same effects.
 * `consoles` and `ran` hold what actually happened; the spec asserts they stay empty for every refusal. */
export class ConsoleModel {
  readonly tasks = new Map<string, TaskRow>();
  readonly projects = new Set<string>();
  /** Known harnesses: a built-in has a console, a package provider does not. */
  readonly providers = new Map<string, Provider>();
  readonly consoles: { by: string; taskId?: string; harness: string; projectId: string }[] = [];
  readonly ran: { by: string; taskId: string; command: string; arguments: string }[] = [];
  /** What the user's own typing of the same command did, to compare attribution and arguments. */
  readonly userRan: { taskId: string; command: string; arguments: string }[] = [];
  /** Packages a running service has: a stopped service's rounds change nothing. */
  readonly ended = new Set<string>();

  /** The user runs a command the way the composer does. */
  userRun(taskId: string, text: string): void {
    const [command, ...rest] = text.trim().split(/\s+/);
    this.userRan.push({ taskId, command, arguments: rest.join(' ') });
  }

  /** `panda.harnesses.console.*` and `commands.*`. `between` runs after the checks and before the effect (the spec revokes there). */
  call(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    if (!checks.holds) return envelope(denied());
    const request = readRequest(raw);
    if (isRefusal(request)) return envelope(request);
    if (request.op === 'list') {
      const provider = this.providers.get(request.harness);
      if (!provider) return envelope(refuse('NotFound'));
      const mine = [...this.tasks.values()].some(task => task.provider === request.harness && checks.granted(task.projectId));
      return { ok: true, value: mine ? listValue(provider.commands) : [] };
    }
    let row: TaskRow | undefined, project: string | Refusal, harness: string;
    if (request.op === 'open' && 'harness' in request.open) {
      project = gate(checks.holds, this.projects.has(request.open.projectId) ? request.open.projectId : undefined, checks.granted);
      if (isRefusal(project)) return envelope(project);
      harness = request.open.harness;
      const provider = this.providers.get(harness);
      if (!provider) return envelope(refuse('NotFound'));
      if (!provider.console) return envelope(refuse('UnsupportedCapability'));
    } else {
      const taskId = request.op === 'open' ? (request.open as { taskId: string }).taskId : (request as { taskId: string }).taskId;
      row = this.tasks.get(taskId);
      project = gate(checks.holds, row?.projectId, checks.granted);
      if (isRefusal(project)) return envelope(project);
      harness = row!.provider;
      const provider = this.providers.get(harness);
      if (request.op === 'run') {
        const found = provider?.commands.find(command => command.name === request.command);
        if (!found) return envelope(refuse('NotFound'));
        if (found.kind === 'unsupported') return envelope(refuse('UnsupportedCapability'));
      } else {
        if (!provider?.console) return envelope(refuse('UnsupportedCapability'));
        if (row!.running) return envelope(refuse('Busy'));
      }
    }
    between();
    if (!checks.granted(project) || this.ended.has(owner)) return envelope(denied());
    if (request.op === 'run') this.ran.push({ by: owner, taskId: request.taskId, command: request.command, arguments: request.arguments });
    else if (request.op === 'open') this.consoles.push({ by: owner, ...('taskId' in request.open ? { taskId: request.open.taskId } : {}), harness, projectId: project });
    return { ok: true, value: null };
  }
}

// ---- The window's answers ----------------------------------------------------------------------------------------------

export type Answer = { ok: true } | { ok: false; code: string };
export type Round = { id: string; op: 'open' | 'run'; taskId?: string; projectId: string; harness: string; package: string; command?: string; arguments?: string };
/** What the main window supplies; the spec gives a fake and the app gives the terminal panel and the slash path. */
export type WindowHost = {
  task(taskId: string): { projectId: string; provider: string; running: boolean } | undefined;
  /** Selects the task, as a click in the sidebar does. */
  show(taskId: string): Promise<void>;
  /** The harness console of the task the window shows (`openHarnessConsole`). */
  openTask(taskId: string): Promise<void>;
  /** A console of a harness for a project, with no task named. */
  openHarness(harness: string, projectId: string): Promise<void>;
  /** The command as the user's own typing runs it: `resolve_slash_command`, then its action or a prompt. */
  run(taskId: string, command: string, args: string): Promise<void>;
  /** Says which package acted, in the app's own notice. */
  attribute(packageId: string, text: string): void;
};
const no = (code: string): Answer => ({ ok: false, code });

/** Codes for the text of a failed open or run. Nothing of the text reaches the package. */
export function failureCode(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error);
  if (text.startsWith('UnsupportedCapability')) return 'UnsupportedCapability';
  if (/stop this task/i.test(text)) return 'Busy';
  if (/select a task|not found|no such|unknown/i.test(text)) return 'NotFound';
  return 'HostUnavailable';
}

/** Answers the round the host sent. The window checks again what it can see: a task that is gone or now running refuses. */
export async function answerRound(host: WindowHost, round: Round): Promise<Answer> {
  try {
    if (round.op === 'open' && round.taskId === undefined) {
      await host.openHarness(round.harness, round.projectId);
      host.attribute(round.package, `${round.package} opened the ${round.harness} console.`);
      return { ok: true };
    }
    const task = round.taskId ? host.task(round.taskId) : undefined;
    if (!round.taskId || !task) return no('NotFound');
    if (task.projectId !== round.projectId || task.provider !== round.harness) return no('StaleContext');
    if (round.op === 'open') {
      if (task.running) return no('Busy');
      await host.show(round.taskId);
      await host.openTask(round.taskId);
      host.attribute(round.package, `${round.package} opened the ${round.harness} console.`);
      return { ok: true };
    }
    if (!round.command) return no('InvalidShape');
    await host.show(round.taskId);
    host.attribute(round.package, `${round.package} ran ${round.command}.`);
    await host.run(round.taskId, round.command, round.arguments ?? '');
    return { ok: true };
  } catch (error) { return no(failureCode(error)); }
}

// ---- The app ---------------------------------------------------------------------------------------------------------------

let mounted = false;

/** Mounts the window half: answers every round the host sends. */
export async function mountRuntimeHarnessConsole(host: WindowHost): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, subscribe, preview } = await import('../bridge');
  const answer = async (round: Round) => {
    let reply: Answer;
    try { reply = await answerRound(host, round); } catch { reply = no('HostUnavailable'); }
    try { await call('extensions_runtime_console_answer', { id: round.id, answer: reply }); } catch { /* the call timed out or ended: nothing waits */ }
    return reply;
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeConsole = { round: answer };
  const listen = subscribe as unknown as (name: string, callback: (event: unknown) => void) => Promise<() => void>;
  try { await listen('extensions-runtime-console', event => { void answer(event as Round); }); } catch { /* no events */ }
}

/** Test seam: forget the mounted flag so a spec can mount the window half again. */
export function resetRuntimeHarnessConsole(): void { mounted = false; }
