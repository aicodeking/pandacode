// Projects, worktrees, branches, tasks and pull requests for background services, and the project checks
// (`workspace.manage` and `projects.checks.run`, runtime phase R4, slice R0405).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_projects.rs; the first half of this file mirrors them
// with no I/O for the browser preview and the deterministic checks of tests/extensions-runtime-workspace-projects.spec.ts.
// The second half is what the main window runs: the host's own confirmation of an irreversible action, and the reload of the
// project list after a package changed it. Everything here is for predictability and fault isolation, never for trust
// (ADR-0005): a package that holds `workspace.manage` for a project is never asked per action, except for the irreversible
// deletions, which keep the host's confirmation by default and which the user can turn off per package.
import type { Json } from './contracts';

export const MANAGE = 'workspace.manage';
export const CHECKS = 'projects.checks.run';
export const SCHEMA_VERSION = 1;
export const MAX_WAITING = 4;
export const MAX_CHECKS = 2;
export const MAX_PATH = 4096;
export const MAX_NAME = 200;
export const MAX_BRANCH = 120;
export const MAX_REF = 200;
export const MAX_REFERENCE = 512;
export const METHODS = ['squash', 'merge', 'rebase'] as const;

/** The refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries. */
export type Refusal = { code: string; path: string; ids: string[] };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: string; ids: string[] } };
const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (permission: string): Refusal => refuse('PermissionDenied', permission);
export const envelope = (refusal: Refusal): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code: refusal.code, path: refusal.path, ids: refusal.ids } });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

// ---- The calls ---------------------------------------------------------------------------------------------------------

export type Scope = { kind: 'none' } | { kind: 'project'; key: string } | { kind: 'task'; key: string };
export type Spec = { call: string; permission: string; scope: Scope; required: readonly string[]; optional: readonly string[]; confirm: string | null };
const none: Scope = { kind: 'none' };
const project = (key: string): Scope => ({ kind: 'project', key });
const task = (key: string): Scope => ({ kind: 'task', key });
const manage = (call: string, scope: Scope, required: readonly string[], optional: readonly string[] = [], confirm: string | null = null): Spec => ({ call, permission: MANAGE, scope, required, optional, confirm });

/** Every call of the five namespaces and the check, with its keys and the irreversible action it confirms. */
export const SPECS: readonly Spec[] = [
  manage('projects.add', none, ['path']),
  manage('projects.remove', project('projectId'), ['projectId'], [], 'projects.remove'),
  manage('projects.rename', project('projectId'), ['projectId', 'name']),
  manage('projects.relink', project('projectId'), ['projectId', 'path']),
  manage('worktrees.create', task('taskId'), ['taskId', 'branch'], ['base', 'existing']),
  manage('worktrees.remove', task('worktreeId'), ['worktreeId'], ['deleteBranch'], 'worktrees.remove'),
  manage('worktrees.recreate', task('worktreeId'), ['worktreeId']),
  manage('worktrees.merge', task('worktreeId'), ['worktreeId']),
  manage('branches.create', project('projectId'), ['projectId', 'name'], ['taskId', 'from', 'switch']),
  manage('branches.switch', project('projectId'), ['projectId', 'branch'], ['taskId']),
  manage('branches.rename', project('projectId'), ['projectId', 'from', 'to'], ['taskId']),
  manage('branches.remove', project('projectId'), ['projectId', 'branch'], ['taskId', 'force'], 'branches.remove'),
  manage('tasks.remove', task('taskId'), ['taskId'], [], 'tasks.remove'),
  manage('tasks.rename', task('taskId'), ['taskId', 'title']),
  manage('tasks.move', task('taskId'), ['taskId', 'projectId']),
  manage('pulls.link', task('taskId'), ['taskId', 'reference']),
  manage('pulls.unlink', task('taskId'), ['taskId']),
  manage('pulls.check', task('taskId'), ['taskId']),
  manage('pulls.merge', task('taskId'), ['taskId'], ['method'], 'pulls.merge'),
  { call: 'projects.checks.run', permission: CHECKS, scope: task('taskId'), required: ['taskId'], optional: [], confirm: null },
];
const ID_KEYS = ['projectId', 'taskId', 'worktreeId'] as const;
export const specOf = (call: string): Spec | undefined => SPECS.find(spec => spec.call === call);

/** What the app answers about the world; the spec gives fixed answers. */
export type World = {
  /** The package holds `permission` for this project now (`null`: for every project; narrowing included). */
  granted: (permission: string, projectId: string | null) => boolean;
  taskProject: (taskId: string) => string | undefined;
  projectExists: (projectId: string) => boolean;
};
export type Admitted = { call: string; permission: string; project: string | null; confirm: string | null; input: Record<string, unknown> };

/** A branch name Git accepts and no option can pose as. */
export const branchOk = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name.length <= MAX_BRANCH && !name.includes('..') && !name.includes('//') && !/^[-/.]/.test(name) && !/[/.]$/.test(name) && !name.endsWith('.lock') && /^[A-Za-z0-9/_.-]+$/.test(name);
/** A start point for a new branch: a branch, tag or commit name. */
export const refOk = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= MAX_REF && !name.includes('..') && !name.startsWith('-') && /^[A-Za-z0-9/_.-]+$/.test(name);

function textIn(input: Record<string, unknown>, key: string, limit: number): Refusal | null {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '' || /\p{Cc}/u.test(value)) return refuse('InvalidShape');
  return [...value].length > limit ? refuse('LimitExceeded') : null;
}
const flagIn = (input: Record<string, unknown>, key: string): Refusal | null => input[key] === undefined || input[key] === null || typeof input[key] === 'boolean' ? null : refuse('InvalidShape');
const branchIn = (input: Record<string, unknown>, key: string): Refusal | null => branchOk(input[key]) ? null : refuse('InvalidShape');
const refIn = (input: Record<string, unknown>, key: string): Refusal | null => input[key] === undefined || input[key] === null || refOk(input[key]) ? null : refuse('InvalidShape');
const first = (...parts: (Refusal | null)[]): Refusal | null => parts.find(part => part !== null) ?? null;

/** The rest of the shape of a call, after the permission. */
function checkValues(call: string, input: Record<string, unknown>): Refusal | null {
  switch (call) {
    case 'projects.add': case 'projects.relink': return textIn(input, 'path', MAX_PATH);
    case 'projects.rename': return textIn(input, 'name', MAX_NAME);
    case 'worktrees.create': return first(branchIn(input, 'branch'), refIn(input, 'base'), flagIn(input, 'existing'));
    case 'worktrees.remove': return flagIn(input, 'deleteBranch');
    case 'branches.create': return first(branchIn(input, 'name'), refIn(input, 'from'), flagIn(input, 'switch'));
    case 'branches.switch': return branchIn(input, 'branch');
    case 'branches.rename': return first(branchIn(input, 'from'), branchIn(input, 'to'), input.from === input.to ? refuse('InvalidShape') : null);
    case 'branches.remove': return first(branchIn(input, 'branch'), flagIn(input, 'force'));
    case 'tasks.rename': return textIn(input, 'title', MAX_NAME);
    case 'pulls.link': return textIn(input, 'reference', MAX_REFERENCE);
    case 'pulls.merge': return input.method === undefined || input.method === null || (METHODS as readonly unknown[]).includes(input.method) ? null : refuse('InvalidShape');
    default: return null;
  }
}

/** Reads a request and checks it, in the frozen order: the id shapes, the permission (for the project the call touches), the
 * rest of the shape, then what must exist. A task or project the package may not touch is `PermissionDenied` before it is
 * ever `NotFound`. */
export function admit(world: World, call: string, raw: unknown): Admitted | Refusal {
  const spec = specOf(call);
  if (!spec) return refuse('UnsupportedCapability');
  if (!record(raw)) return refuse('InvalidShape');
  if (Object.keys(raw).some(key => !spec.required.includes(key) && !spec.optional.includes(key)) || spec.required.some(key => !(key in raw))) return refuse('InvalidShape');
  for (const key of ID_KEYS) if (key in raw && !ident(raw[key])) return refuse('InvalidShape');
  let projectId: string | null = null;
  if (spec.scope.kind === 'project') projectId = raw[spec.scope.key] as string;
  if (spec.scope.kind === 'task') {
    const found = world.taskProject(raw[spec.scope.key] as string);
    if (found === undefined) return world.granted(spec.permission, null) ? refuse('NotFound') : denied(spec.permission);
    projectId = found;
  }
  if (!world.granted(spec.permission, projectId)) return denied(spec.permission);
  const shape = checkValues(call, raw);
  if (shape) return shape;
  if (call === 'tasks.move') {
    const destination = raw.projectId as string;
    if (!world.granted(spec.permission, destination)) return denied(spec.permission);
    if (!world.projectExists(destination)) return refuse('NotFound');
  }
  if (spec.scope.kind === 'project' && projectId !== null && !world.projectExists(projectId)) return refuse('NotFound');
  return { call: spec.call, permission: spec.permission, project: projectId, confirm: spec.confirm, input: raw };
}

/** Maps the text of a failed host operation to the frozen code; nothing of the text reaches the package. */
export function codeOf(error: string): string {
  const text = error.toLowerCase();
  if (text.includes('runs on')) return 'UnsupportedCapability';
  if (['already exists', 'already checked out', 'already uses', 'another project', 'stop this', 'stop the agent', 'stop it', 'wait for', 'finish before', 'agents first', 'teams first', 'already started', 'own worktree', 'is used by', 'checked out', 'not fully merged', 'uncommitted', 'commit or stash', 'would be overwritten', 'pause this', 'close this', 'conflict', 'destination'].some(part => text.includes(part))) return 'Conflict';
  if (['does not exist', 'not found', 'no local branch', 'unknown', 'no linked', 'uses the main checkout', 'not a valid', 'no github remote', 'no such'].some(part => text.includes(part))) return 'NotFound';
  if (['choose squash', 'enter a pull', 'invalid', 'use a branch name', 'too long', '1–200', 'must be', 'choose a folder', 'cannot open folder'].some(part => text.includes(part))) return 'InvalidShape';
  return 'HostUnavailable';
}

// ---- Confirmations and running checks ------------------------------------------------------------------------------------

/** The irreversible actions that wait for the user's answer in the main window: four per package, answered once, ended with the service. */
export class ConfirmSlots {
  private waiting = new Map<string, { owner: string; settle: (accepted: boolean) => void }>();
  private serial = 0;
  count(owner: string) { return [...this.waiting.values()].filter(entry => entry.owner === owner).length; }
  begin(owner: string): Reply<{ id: string; answer: Promise<boolean> }> {
    if (this.count(owner) >= MAX_WAITING) return envelope(refuse('LimitExceeded'));
    const id = `${owner}#confirm-${++this.serial}`;
    let settle!: (accepted: boolean) => void;
    const answer = new Promise<boolean>(resolve => { settle = resolve; });
    this.waiting.set(id, { owner, settle });
    return { ok: true, value: { id, answer } };
  }
  answer(id: string, accepted: boolean): Reply<null> {
    const entry = this.waiting.get(id);
    if (!entry) return envelope(refuse('NotFound'));
    this.waiting.delete(id); entry.settle(accepted);
    return { ok: true, value: null };
  }
  cancelOwner(owner: string): string[] {
    const ids = [...this.waiting].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
    for (const id of ids) { const entry = this.waiting.get(id)!; this.waiting.delete(id); entry.settle(false); }
    return ids;
  }
  forget(id: string) { return this.waiting.delete(id); }
}

/** Checks running per package: two at once. */
export class CheckGate {
  private running = new Map<string, number>();
  enter(owner: string): Refusal | null {
    const count = this.running.get(owner) ?? 0;
    if (count >= MAX_CHECKS) return refuse('LimitExceeded');
    this.running.set(owner, count + 1);
    return null;
  }
  leave(owner: string) { const count = (this.running.get(owner) ?? 0) - 1; if (count > 0) this.running.set(owner, count); else this.running.delete(owner); }
  count(owner: string) { return this.running.get(owner) ?? 0; }
}

// ---- The preview manager -------------------------------------------------------------------------------------------------

export type PreviewTask = { id: string; projectId: string; title: string; running?: boolean; remote?: boolean; cloud?: boolean; worktreeBranch?: string | null; pull?: { number: number; url: string; title: string; state: string } | null };
export type PreviewProject = { id: string; name: string; path: string };
export type WorkspaceWorld = {
  projects: PreviewProject[];
  tasks: PreviewTask[];
  /** Local branches per project and the one checked out. */
  branches: Record<string, { current: string; list: string[] }>;
  /** Pull requests a reference can name, by reference. */
  pulls: Record<string, { number: number; url: string; title: string; state: string }>;
  /** The report of a project's check script; absent: no plan. */
  checks: Record<string, Json>;
  /** Folders that exist and may be added or linked. */
  folders: string[];
  /** The harness refuses the call with this text (the spec uses it to model a host failure). */
  fail?: (call: string, input: Record<string, unknown>) => string | null;
};
export type Checks = { granted: (permission: string, projectId: string | null) => boolean; package: string; confirms: boolean; answer: (action: string, what: string) => boolean | Promise<boolean> };

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** The deterministic twin of the native `serve` + `execute`: same order of checks, same refusals, same confirmations. */
export class WorkspaceManager {
  readonly confirms = new ConfirmSlots();
  readonly gate = new CheckGate();
  readonly events: Json[] = [];
  readonly asked: { action: string; what: string; package: string }[] = [];
  private serial = 0;
  constructor(readonly world: WorkspaceWorld) {}

  private describe(admitted: Admitted): string {
    const text = (key: string) => String(admitted.input[key] ?? '');
    const title = (id: string) => this.world.tasks.find(entry => entry.id === id)?.title ?? id;
    switch (admitted.call) {
      case 'projects.remove': return `Remove the project ${this.world.projects.find(entry => entry.id === text('projectId'))?.name ?? text('projectId')} from PandaCode (its folder stays)`;
      case 'tasks.remove': return `Delete the task ${title(text('taskId'))} and its history`;
      case 'worktrees.remove': return `Remove the worktree of the task ${title(text('worktreeId'))}`;
      case 'branches.remove': return `Delete the branch ${text('branch')}`;
      case 'pulls.merge': return `Merge the pull request linked to the task ${title(text('taskId'))} (${typeof admitted.input.method === 'string' ? admitted.input.method : 'merge'})`;
      default: return admitted.call;
    }
  }

  /** `panda.workspace.<family>.<call>` and `panda.projects.checks.run`. A refusal changes nothing. */
  async call(owner: string, checks: Checks, call: string, raw: unknown, between: () => void = () => undefined): Promise<Reply<Json>> {
    const world: World = { granted: checks.granted, taskProject: id => this.world.tasks.find(entry => entry.id === id)?.projectId, projectExists: id => this.world.projects.some(entry => entry.id === id) };
    const admitted = admit(world, call, raw);
    if (isRefusal(admitted)) return envelope(admitted);
    const running = admitted.call === CHECKS;
    if (running) { const full = this.gate.enter(owner); if (full) return envelope(full); }
    try {
      if (admitted.confirm && checks.confirms) {
        const what = this.describe(admitted);
        const begun = this.confirms.begin(owner);
        if (!begun.ok) return begun;
        this.asked.push({ action: admitted.confirm, what, package: checks.package });
        const accepted = await checks.answer(admitted.confirm, what);
        this.confirms.answer(begun.value.id, accepted);
        if (!await begun.value.answer) return envelope(refuse('Cancelled'));
      }
      between();
      // The permission is read again just before anything changes: a revoke or a narrowing in between changes nothing.
      if (!checks.granted(admitted.permission, admitted.project)) return envelope(denied(admitted.permission));
      if (admitted.call === 'tasks.move' && !checks.granted(admitted.permission, admitted.input.projectId as string)) return envelope(denied(admitted.permission));
      const failed = this.world.fail?.(admitted.call, admitted.input);
      if (failed) return envelope(refuse(codeOf(failed)));
      const outcome = this.perform(admitted);
      if (isRefusal(outcome)) return envelope(outcome);
      if (running && !checks.granted(CHECKS, admitted.project)) return envelope(denied(CHECKS));
      if (admitted.call !== CHECKS && admitted.call !== 'pulls.check') this.events.push({ call: admitted.call, projects: admitted.call.startsWith('projects.') });
      return { ok: true, value: outcome };
    } finally { if (running) this.gate.leave(owner); }
  }

  private branches(projectId: string) { return this.world.branches[projectId] ?? (this.world.branches[projectId] = { current: 'main', list: ['main'] }); }
  private branchList(projectId: string): Json { const { current, list } = this.branches(projectId); return { current, branches: [...list], defaultBranch: list.includes('main') ? 'main' : (list[0] ?? '') }; }

  /** The checks a native `execute` makes against the store, then the change. */
  private perform(admitted: Admitted): Json | Refusal {
    const input = admitted.input;
    const text = (key: string) => String(input[key] ?? '');
    const taskOf = (id: string) => this.world.tasks.find(entry => entry.id === id);
    const projectOf = (id: string) => this.world.projects.find(entry => entry.id === id);
    switch (admitted.call) {
      case 'projects.add': {
        const path = text('path');
        if (!this.world.folders.includes(path)) return refuse(codeOf('Cannot open folder'));
        const existing = this.world.projects.find(entry => entry.path === path);
        if (existing) return { projectId: existing.id, name: existing.name };
        const added = { id: `project-${++this.serial}`, name: folderName(path), path };
        this.world.projects.push(added);
        return { projectId: added.id, name: added.name };
      }
      case 'projects.remove': {
        if (this.world.tasks.some(entry => entry.projectId === text('projectId') && entry.running)) return refuse(codeOf("Stop this project's agents first."));
        this.world.projects.splice(this.world.projects.findIndex(entry => entry.id === text('projectId')), 1);
        this.world.tasks = this.world.tasks.filter(entry => entry.projectId !== text('projectId'));
        return null;
      }
      case 'projects.rename': { const found = projectOf(text('projectId'))!; found.name = text('name').trim(); return { projectId: found.id, name: found.name }; }
      case 'projects.relink': {
        const path = text('path');
        if (!this.world.folders.includes(path)) return refuse(codeOf('Cannot open folder'));
        if (this.world.projects.some(entry => entry.path === path && entry.id !== text('projectId'))) return refuse(codeOf('Another project already uses this folder.'));
        const found = projectOf(text('projectId'))!; found.path = path; found.name = folderName(path);
        return { projectId: found.id, name: found.name };
      }
      case 'worktrees.create': {
        const source = taskOf(text('taskId'))!;
        const branch = /^(pandacode|kingcode|codex)\//.test(text('branch')) ? text('branch') : `pandacode/${text('branch')}`;
        const list = this.branches(source.projectId).list;
        if (input.existing === true ? !list.includes(branch) : list.includes(branch)) return refuse(input.existing === true ? 'NotFound' : 'Conflict');
        if (input.existing !== true) list.push(branch);
        const created: PreviewTask = { id: `task-${++this.serial}`, projectId: source.projectId, title: 'New conversation', worktreeBranch: branch };
        this.world.tasks.push(created);
        return { worktreeId: created.id, taskId: created.id, projectId: created.projectId, branch };
      }
      case 'worktrees.remove': {
        const found = taskOf(text('worktreeId'))!;
        if (found.remote) return refuse(codeOf('This task runs on Studio.'));
        if (found.running) return refuse(codeOf('Stop the agent before removing its worktree.'));
        if (!found.worktreeBranch) return refuse(codeOf('This task uses the main checkout.'));
        const branch = found.worktreeBranch;
        found.worktreeBranch = null;
        const deleted = input.deleteBranch === true;
        if (deleted) { const list = this.branches(found.projectId).list; list.splice(list.indexOf(branch), 1); }
        return { removed: true, branch, branchDeleted: deleted, note: '' };
      }
      case 'worktrees.recreate': {
        const found = taskOf(text('worktreeId'))!;
        if (!found.worktreeBranch) return refuse(codeOf('This task uses the main checkout.'));
        return { worktreeId: found.id, branch: found.worktreeBranch };
      }
      case 'worktrees.merge': {
        const found = taskOf(text('worktreeId'))!;
        if (found.running) return refuse(codeOf('Wait for the agent to finish before merging its worktree.'));
        if (!found.worktreeBranch) return refuse(codeOf('This task uses the main checkout.'));
        const { current } = this.branches(found.projectId);
        return { branch: found.worktreeBranch, target: current, commits: 1, switchedFrom: null };
      }
      case 'branches.create': {
        const entry = this.branches(text('projectId'));
        if (entry.list.includes(text('name'))) return refuse(codeOf(`A branch named ${text('name')} already exists.`));
        if (typeof input.from === 'string' && !entry.list.includes(input.from)) return refuse(codeOf('fatal: not a valid object name'));
        entry.list.push(text('name'));
        if (input.switch === true) entry.current = text('name');
        return this.branchList(text('projectId'));
      }
      case 'branches.switch': {
        const entry = this.branches(text('projectId'));
        if (!entry.list.includes(text('branch'))) return refuse(codeOf(`There is no local branch named ${text('branch')}.`));
        const holder = typeof input.taskId === 'string' ? taskOf(input.taskId) : undefined;
        if (holder?.worktreeBranch) return refuse(codeOf('This task works in its own worktree; its branch stays as it is.'));
        entry.current = text('branch');
        return this.branchList(text('projectId'));
      }
      case 'branches.rename': {
        const entry = this.branches(text('projectId'));
        if (!entry.list.includes(text('from'))) return refuse(codeOf(`There is no local branch named ${text('from')}.`));
        if (entry.list.includes(text('to'))) return refuse(codeOf(`A branch named ${text('to')} already exists.`));
        if (this.world.tasks.some(entry => entry.projectId === text('projectId') && entry.worktreeBranch === text('from'))) return refuse(codeOf(`The branch ${text('from')} is used by a task's worktree.`));
        entry.list[entry.list.indexOf(text('from'))] = text('to');
        if (entry.current === text('from')) entry.current = text('to');
        return this.branchList(text('projectId'));
      }
      case 'branches.remove': {
        const entry = this.branches(text('projectId'));
        if (!entry.list.includes(text('branch'))) return refuse(codeOf(`There is no local branch named ${text('branch')}.`));
        if (entry.current === text('branch')) return refuse(codeOf(`The branch ${text('branch')} is checked out.`));
        if (this.world.tasks.some(item => item.projectId === text('projectId') && item.worktreeBranch === text('branch'))) return refuse(codeOf(`The branch ${text('branch')} is used by a task's worktree.`));
        entry.list.splice(entry.list.indexOf(text('branch')), 1);
        return this.branchList(text('projectId'));
      }
      case 'tasks.remove': {
        const found = taskOf(text('taskId'))!;
        if (found.running) return refuse(codeOf('Stop this task and wait for its agents to finish before deleting it.'));
        this.world.tasks = this.world.tasks.filter(entry => entry.id !== found.id);
        return { taskIds: [found.id] };
      }
      case 'tasks.rename': { taskOf(text('taskId'))!.title = text('title').trim(); return null; }
      case 'tasks.move': {
        const found = taskOf(text('taskId'))!;
        if (found.projectId === text('projectId')) return { taskId: found.id, projectId: found.projectId };
        if (found.running) return refuse(codeOf('Stop this task before moving it to another project.'));
        if (found.remote) return refuse(codeOf('This task runs on another computer.'));
        if (found.cloud) return refuse(codeOf('This task runs in the cloud and keeps its project.'));
        if (found.worktreeBranch) return refuse(codeOf('This task works in its own worktree; it stays in its project.'));
        found.projectId = text('projectId');
        return { taskId: found.id, projectId: found.projectId };
      }
      case 'pulls.link': {
        const pull = this.world.pulls[text('reference')];
        if (!pull) return refuse(codeOf('The pull request does not exist.'));
        taskOf(text('taskId'))!.pull = { ...pull };
        return { ...pull };
      }
      case 'pulls.unlink': { taskOf(text('taskId'))!.pull = null; return null; }
      case 'pulls.check': {
        const pull = taskOf(text('taskId'))!.pull;
        if (!pull) return refuse(codeOf('This task has no linked pull request.'));
        return { number: pull.number, title: pull.title, state: pull.state, url: pull.url, base: 'main', head: 'topic', mergeable: 'MERGEABLE', reviewDecision: '', mergedAt: '', checks: [] };
      }
      case 'pulls.merge': {
        const found = taskOf(text('taskId'))!;
        if (!found.pull) return refuse(codeOf('This task has no linked pull request.'));
        found.pull = { ...found.pull, state: 'merged' };
        return { ...found.pull };
      }
      case CHECKS: {
        const found = taskOf(text('taskId'))!;
        const report = this.world.checks[found.projectId];
        return { schemaVersion: SCHEMA_VERSION, report: report ?? { checked: false, reason: 'No check script is declared for this project.' } };
      }
      default: return refuse('UnsupportedCapability');
    }
  }
}

// ---- The main window -----------------------------------------------------------------------------------------------------

/** What the main window supplies: the project list reload. */
export type MainHost = { reloadProjects: () => Promise<void> | void };
export type ConfirmEvent = { id: string; owner: string; package: string; action: string; what: string };

type Shown = { id: string; close: () => void; hostClosed: boolean };
const queue: ConfirmEvent[] = [];
let active: Shown | undefined, retry: ReturnType<typeof setTimeout> | undefined;
let started = false;
const CONTEXT = { schemaVersion: 1 as const, windowId: 'main', surfaceId: 'panda.runtime.workspace-confirm', revision: 0 };

async function send(id: string, accepted: boolean): Promise<void> {
  try { const { call } = await import('../bridge'); await call('extensions_runtime_workspace_confirm_answer', { id, accepted }); } catch { /* the confirmation is gone natively: nothing waits for it */ }
}

/** The host's own confirmation: the package's name, what goes, and a Cancel that changes nothing. */
export function confirmation(event: ConfirmEvent): { title: string; fields: []; confirmLabel: string; confirmation: string; successMessage: string; cancelMessage: string } {
  return { title: `${event.package} wants to continue`, fields: [], confirmLabel: 'Continue', confirmation: `${event.what}. This cannot be undone.`, successMessage: 'Confirmed', cancelMessage: 'Cancelled' };
}

function pump(): void {
  if (retry) { clearTimeout(retry); retry = undefined; }
  if (active || !queue.length) return;
  if (document.querySelector<HTMLDialogElement>('#dialog')?.open || document.querySelector('#extension-nested-dialog[open]')) { retry = setTimeout(pump, 150); return; }
  void open(queue.shift()!);
}

async function open(item: ConfirmEvent): Promise<void> {
  const { openExtensionDialog } = await import('./dialogs');
  if (active) { queue.unshift(item); return; }
  const focused = document.activeElement;
  const anchor = focused instanceof HTMLElement && !focused.closest('dialog') ? focused : document.body;
  try {
    const transient = openExtensionDialog(confirmation(item), { ...CONTEXT }, item.owner, anchor);
    const shown: Shown = { id: item.id, close: transient.close, hostClosed: false };
    active = shown;
    void transient.result.then(result => {
      if (active === shown) active = undefined;
      if (result.kind === 'cancelled' && result.reason === 'busy') { queue.unshift(item); pump(); return; }
      if (!shown.hostClosed) void send(item.id, result.kind === 'confirmed');
      pump();
    });
  } catch { void send(item.id, false); pump(); }
}

/** The service ended: its confirmation leaves the window, shown or waiting. */
export function closeConfirmation(id: string): void {
  const waiting = queue.findIndex(item => item.id === id);
  if (waiting >= 0) queue.splice(waiting, 1);
  if (active?.id === id) { active.hostClosed = true; active.close(); }
}

/** Takes a confirmation the host announced; a known id is not shown twice. */
export function receiveConfirmation(item: ConfirmEvent): void {
  if (active?.id === item.id || queue.some(entry => entry.id === item.id)) return;
  queue.push(item); pump();
}

/** Starts listening in the main window: confirmations to show and the project list to reload. */
export async function startRuntimeWorkspaceProjects(host: MainHost): Promise<void> {
  if (started) return;
  started = true;
  const { subscribe, preview } = await import('../bridge');
  // The bridge types its events by name; these three belong to this slice.
  const listen = subscribe as unknown as (name: string, callback: (event: unknown) => void) => Promise<() => void>;
  // The browser preview has no service: the spec delivers a confirmation through this seam and reads what the mock recorded.
  if (preview) (window as unknown as Record<string, unknown>).__runtimeWorkspaceProjects = { receive: receiveConfirmation, close: closeConfirmation, changed: () => host.reloadProjects() };
  try { await listen('extensions-runtime-workspace-confirm', event => receiveConfirmation(event as ConfirmEvent)); } catch { /* no events */ }
  try { await listen('extensions-runtime-workspace-confirm-close', event => closeConfirmation(String((event as { id?: string }).id ?? ''))); } catch { /* idem */ }
  try { await listen('extensions-runtime-workspace-changed', event => { if ((event as { projects?: boolean }).projects) void host.reloadProjects(); }); } catch { /* idem */ }
}

/** The preview's IPC for the command of this slice: the answers are recorded for the spec. */
export function previewWorkspaceProjects(command: string, args: Record<string, unknown>): unknown {
  if (command === 'extensions_runtime_workspace_confirm_answer') { ((window as unknown as { __runtimeWorkspaceAnswers?: unknown[] }).__runtimeWorkspaceAnswers ??= []).push({ id: args.id, accepted: args.accepted }); return null; }
  throw new Error('Unsupported extension preview command.');
}

/** Test seam: forget every queued and shown confirmation (the spec starts each case from nothing). */
export function resetRuntimeWorkspaceProjects(): void { queue.length = 0; active = undefined; if (retry) { clearTimeout(retry); retry = undefined; } started = false; }
