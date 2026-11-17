// Recipes and wake-ups for background services (`workspace.recipes`, `workspace.wakeups`, runtime phase R4, slice R0406B).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_schedules.rs; this file mirrors them with no I/O for
// the browser preview and the deterministic checks of tests/extensions-runtime-workspace-schedules.spec.ts. It is a
// labelled stand-in: it proves the protocol (ids, shapes, refusal envelope, grant scoping, confirmation, mid-operation
// revoke, attribution), never a service process, the recipe files, the schedules database or the harness queue.
// Everything here is for predictability and fault isolation, never for trust (ADR-0005): a package that holds
// `workspace.manage` is never asked per action; only the irreversible `remove` asks the host first, unless the user turned
// that off for the package. Pairing, cloud sign-in and access approval stay with the user and have no call here.
import { call } from '../bridge';
import type { Json } from './contracts';

export const PERMISSION = 'workspace.manage';
export const WAKEUP_FIELDS = ['sessionId', 'title', 'prompt', 'kind', 'intervalMinutes', 'timeOfDay', 'days', 'runAt', 'watchSessionId', 'onlyOnSuccess', 'maxRuns', 'workflowId', 'chainFromId'] as const;
const RECIPE_FIELDS = ['scope', 'projectId', 'name', 'description', 'steps'], STEP_FIELDS = ['kind', 'text', 'command', 'requires'];
const STEP_KINDS = ['prompt', 'slash', 'check', 'approval'], WAKEUP_KINDS = ['once', 'interval', 'daily', 'weekdays', 'weekly', 'after'];
export const MAX_LIST = 1024, MAX_ORIGINS = 4096, MAX_STEPS_SEEN = 1000, MAX_STEPS = 50;

export type Code = 'NotFound' | 'InvalidShape' | 'LimitExceeded' | 'PermissionDenied' | 'UnsupportedCapability' | 'HostUnavailable' | 'Cancelled' | 'Conflict';
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: Code; path: string; ids: string[] } };
class Refusal extends Error { readonly code: Code; readonly path: string; readonly ids: string[]; constructor(code: Code, path = '$', ids: string[] = []) { super(code); this.code = code; this.path = path; this.ids = ids; } }
const fail = (refusal: Refusal): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code: refusal.code, path: refusal.path, ids: refusal.ids } });
const denied = () => new Refusal('PermissionDenied', PERMISSION);

const ident = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && [...text].length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, allowed: readonly string[]) => {
  if (!isObject(value)) throw new Refusal('InvalidShape');
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra !== undefined) throw new Refusal('InvalidShape', extra);
};
const nested = (prefix: string, run: () => void) => { try { run(); } catch (error) { if (error instanceof Refusal) throw new Refusal(error.code, error.path === '$' ? prefix : `${prefix}.${error.path}`); throw error; } };
const requiredIdent = (value: Record<string, unknown>, key: string): string => { const text = value[key]; if (!ident(text)) throw new Refusal('InvalidShape', key); return text; };
const optionalIdent = (value: Record<string, unknown>, key: string): string | null => { const text = value[key]; if (text === undefined || text === null) return null; if (!ident(text)) throw new Refusal('InvalidShape', key); return text; };

/** The refusal code of a native operation's message (mirror of `code_of_text`). */
export function codeOfText(error: string): Code {
  const text = error.toLowerCase();
  if (text.includes('no longer exists') || text.includes('not found') || text.includes('does not exist')) return 'NotFound';
  if (text.includes('unknown harness')) return 'UnsupportedCapability';
  if (text.includes('too ') || text.includes('under ') || text.includes(' 1 to ') || text.includes('max runs')) return 'LimitExceeded';
  return 'InvalidShape';
}

// ---- Ids and shapes ----------------------------------------------------------------------------------------------------

export type RecipeScope = { scope: 'global' } | { scope: 'project'; projectId: string };
export const validName = (name: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
export const recipeId = (scope: RecipeScope, name: string) => scope.scope === 'global' ? `global:${name}` : `project:${scope.projectId}:${name}`;
export function parseRecipeId(id: string): { scope: RecipeScope; name: string } {
  const bad = () => new Refusal('InvalidShape', 'recipeId');
  if (id.startsWith('global:')) { const name = id.slice(7); if (!validName(name)) throw bad(); return { scope: { scope: 'global' }, name }; }
  if (!id.startsWith('project:')) throw bad();
  const rest = id.slice(8), cut = rest.lastIndexOf(':');
  if (cut < 0) throw bad();
  const projectId = rest.slice(0, cut), name = rest.slice(cut + 1);
  if (!ident(projectId) || !validName(name)) throw bad();
  return { scope: { scope: 'project', projectId }, name };
}

export type Step = { kind: string; text?: string; command?: string; requires?: string[] };
export type Recipe = { name: string; description: string; steps: Step[] };

/** Mirror of `recipes::validate` (the interface's own rules). */
function validateRecipe(recipe: Recipe) {
  const fail = (message: string): never => { throw new Refusal(codeOfText(message), 'recipe'); };
  if (!validName(recipe.name)) fail('Recipe names use lowercase letters, digits, - and _ (up to 64).');
  if ([...recipe.description].length > 500) fail('The description is too long.');
  if (recipe.steps.length < 1 || recipe.steps.length > MAX_STEPS) fail(`A recipe has 1 to ${MAX_STEPS} steps.`);
  recipe.steps.forEach((step, index) => {
    const text = (step.text ?? '').trim(), command = (step.command ?? '').trim();
    if (!STEP_KINDS.includes(step.kind)) fail(`Step ${index + 1}: unknown kind.`);
    if ([...text].length > 4000 || [...command].length > 4000) fail(`Step ${index + 1} is too long.`);
    if (step.kind === 'slash' && (!command.startsWith('/') || command.length < 2)) fail(`Step ${index + 1}: a slash step needs a command like /review.`);
    if ((step.kind === 'prompt' || step.kind === 'check') && !text) fail(`Step ${index + 1}: add the text to send.`);
    for (const need of step.requires ?? []) if (!(need === 'mcp' || need === 'steer' || (need.startsWith('slash:') && need.slice(6).trim())) || need.length > 160) fail(`Step ${index + 1}: unknown requirement.`);
  });
}

/** A recipe save, as `admit_recipe_save` admits it. */
export function admitRecipeSave(raw: unknown): { scope: RecipeScope; recipe: Recipe } {
  nested('recipe', () => exact(raw, RECIPE_FIELDS));
  const map = raw as Record<string, unknown>;
  let scope: RecipeScope;
  if (map.scope === 'global') { if (map.projectId !== undefined && map.projectId !== null) throw new Refusal('InvalidShape', 'recipe.projectId'); scope = { scope: 'global' }; }
  else if (map.scope === 'project') { if (!ident(map.projectId)) throw new Refusal('InvalidShape', 'recipe.projectId'); scope = { scope: 'project', projectId: map.projectId }; }
  else throw new Refusal('InvalidShape', 'recipe.scope');
  if (typeof map.name !== 'string') throw new Refusal('InvalidShape', 'recipe.name');
  if (map.description !== undefined && map.description !== null && typeof map.description !== 'string') throw new Refusal('InvalidShape', 'recipe.description');
  if (!Array.isArray(map.steps)) throw new Refusal('InvalidShape', 'recipe.steps');
  if (map.steps.length > MAX_STEPS_SEEN) throw new Refusal('LimitExceeded', 'recipe.steps');
  const steps = map.steps.map((step, index) => {
    try { exact(step, STEP_FIELDS); } catch { throw new Refusal('InvalidShape', `recipe.steps[${index}]`); }
    const body = step as Record<string, unknown>;
    if (typeof body.kind !== 'string' || ['text', 'command'].some(key => body[key] !== undefined && typeof body[key] !== 'string') || (body.requires !== undefined && !(Array.isArray(body.requires) && body.requires.every(need => typeof need === 'string')))) throw new Refusal('InvalidShape', `recipe.steps[${index}]`);
    return body as unknown as Step;
  });
  const recipe: Recipe = { name: map.name, description: typeof map.description === 'string' ? map.description : '', steps };
  validateRecipe(recipe);
  return { scope, recipe };
}

/** A wake-up input, as `admit_wakeup` admits it (the native cadence rules answer when it is written). */
export function admitWakeup(raw: unknown): Record<string, Json> {
  nested('input', () => exact(raw, WAKEUP_FIELDS));
  const map = raw as Record<string, Json>;
  if (!ident(map.sessionId)) throw new Refusal('InvalidShape', 'input.sessionId');
  const typed: [string, (value: unknown) => boolean][] = [
    ['title', value => typeof value === 'string'], ['prompt', value => typeof value === 'string'], ['kind', value => typeof value === 'string'], ['timeOfDay', value => value === null || typeof value === 'string'],
    ['intervalMinutes', value => value === null || Number.isInteger(value)], ['runAt', value => value === null || Number.isInteger(value)], ['maxRuns', value => value === null || Number.isInteger(value)],
    ['days', value => Array.isArray(value) && value.every(day => Number.isInteger(day))], ['watchSessionId', value => value === null || typeof value === 'string'], ['onlyOnSuccess', value => typeof value === 'boolean'],
    ['workflowId', value => value === null || typeof value === 'string'], ['chainFromId', value => value === null || typeof value === 'string'],
  ];
  for (const [key, check] of typed) if (key in map && !check(map[key])) throw new Refusal('InvalidShape', 'input');
  return map;
}

// ---- The preview world (a stand-in for the store, the recipe folders and the queue) ------------------------------------------

type Origin = { owner: string; package: string; at: number };
type Task = { id: string; projectId: string; provider: string; slash: string[] };
type Wakeup = { id: string; sessionId: string; projectId: string; title: string; prompt: string; kind: string; intervalMinutes: number | null; timeOfDay: string | null; days: number[]; runAt: number | null; watchSessionId: string | null; onlyOnSuccess: boolean; maxRuns: number | null; workflowId: string | null; chainFromId: string | null; enabled: boolean };
export type Grant = { projects: string[] | null };
export type Dialog = { owner: string; title: string; confirmLabel: string };

export class SchedulesWorld {
  tasks = new Map<string, Task>([
    ['task-1', { id: 'task-1', projectId: 'project-1', provider: 'claude', slash: ['/review'] }],
    ['task-2', { id: 'task-2', projectId: 'project-2', provider: 'claude', slash: [] }],
  ]);
  projects = new Set(['project-1', 'project-2']);
  recipes = new Map<string, Recipe>();
  wakeups = new Map<string, Wakeup>();
  queue = new Map<string, { id: string; text: string; by: string }[]>();
  transcript: string[] = [];
  origins = new Map<string, Origin>();
  installed = new Map<string, string>();
  grants = new Map<string, Grant>();
  confirmDeletions = new Map<string, boolean>();
  answer: 'accept' | 'cancel' = 'accept';
  dialogs: Dialog[] = [];
  /** Test hook: revoke the grant after this many messages of a recipe run were queued. */
  revokeAfterQueued: number | null = null;
  private serial = 0;
  readonly id = (prefix: string) => `${prefix}-${++this.serial}`;

  held(owner: string, project: string | null): boolean {
    const grant = this.grants.get(owner);
    if (!this.installed.has(owner) || !grant) return false;
    return grant.projects === null || (project !== null && grant.projects.includes(project));
  }
  require(owner: string, project: string | null) { if (!this.held(owner, project)) throw denied(); }
  private by(owner: string): string { return this.installed.get(owner) ?? owner; }
  private record(key: string, owner: string) {
    this.origins.set(key, { owner, package: this.by(owner), at: this.origins.size });
    while (this.origins.size > MAX_ORIGINS) this.origins.delete(this.origins.keys().next().value as string);
  }
  private stored(scope: RecipeScope) { return scope.scope === 'global' ? 'global' : scope.projectId; }
  private key(scope: RecipeScope, name: string) { return `${this.stored(scope)}/${name}`; }
  private view(scope: RecipeScope, name: string, recipe: Recipe): Json {
    return { id: recipeId(scope, name), scope: scope.scope, projectId: scope.scope === 'project' ? scope.projectId : null, name, description: recipe.description, steps: recipe.steps as unknown as Json, by: this.origins.get(`recipe:${recipeId(scope, name)}`)?.package ?? null };
  }
  private wakeupView(wakeup: Wakeup): Json { return { ...wakeup, by: this.origins.get(`wakeup:${wakeup.id}`)?.package ?? null } as unknown as Json; }

  /** The host confirmation of an irreversible removal (`FamilyConsents::delete` and the dialog). */
  private confirm(owner: string, what: string) {
    if (this.confirmDeletions.get(owner) === false) return;
    this.dialogs.push({ owner, title: `${this.by(owner)} wants to remove ${what}`, confirmLabel: 'Remove' });
    if (this.answer !== 'accept') throw new Refusal('Cancelled');
  }

  // Recipes ---------------------------------------------------------------------------------------------------------
  recipesCall(owner: string, params: Record<string, unknown>): Json {
    switch (params.op) {
      case 'list': {
        exact(params, ['op', 'projectId']);
        const project = optionalIdent(params, 'projectId');
        const out: Json[] = [];
        if (project !== null) {
          this.require(owner, project);
          if (!this.projects.has(project)) throw new Refusal('NotFound', 'projectId');
          for (const [key, recipe] of this.recipes) if (key.startsWith(`${project}/`)) out.push(this.view({ scope: 'project', projectId: project }, key.slice(project.length + 1), recipe));
        }
        // A global recipe is shown to a package whose grant is not narrowed to chosen projects.
        if (this.held(owner, null)) { for (const [key, recipe] of this.recipes) if (key.startsWith('global/')) out.push(this.view({ scope: 'global' }, key.slice(7), recipe)); }
        else if (project === null) throw denied();
        return out.slice(0, MAX_LIST);
      }
      case 'save': {
        exact(params, ['op', 'recipe']);
        const { scope, recipe } = admitRecipeSave(params.recipe);
        this.require(owner, scope.scope === 'project' ? scope.projectId : null);
        if (scope.scope === 'project' && !this.projects.has(scope.projectId)) throw new Refusal('NotFound', 'projectId');
        if (!this.recipes.has(this.key(scope, recipe.name)) && [...this.recipes.keys()].filter(key => key.startsWith(`${this.stored(scope)}/`)).length >= 200) throw new Refusal('LimitExceeded', 'recipe');
        this.recipes.set(this.key(scope, recipe.name), recipe);
        const id = recipeId(scope, recipe.name);
        this.record(`recipe:${id}`, owner);
        return { id };
      }
      case 'remove': {
        exact(params, ['op', 'recipeId']);
        const { scope, name } = parseRecipeId(requiredIdent(params, 'recipeId'));
        this.require(owner, scope.scope === 'project' ? scope.projectId : null);
        if (!this.recipes.has(this.key(scope, name))) throw new Refusal('NotFound', 'recipeId');
        this.confirm(owner, `recipe “${name}”`);
        this.require(owner, scope.scope === 'project' ? scope.projectId : null);
        this.recipes.delete(this.key(scope, name));
        this.origins.delete(`recipe:${recipeId(scope, name)}`);
        return null;
      }
      case 'run': return this.runRecipe(owner, params);
      default: throw new Refusal('InvalidShape');
    }
  }
  private runRecipe(owner: string, params: Record<string, unknown>): Json {
    exact(params, ['op', 'recipeId', 'options']);
    const { scope, name } = parseRecipeId(requiredIdent(params, 'recipeId'));
    nested('options', () => exact(params.options, ['taskId']));
    const taskId = (() => { try { return requiredIdent(params.options as Record<string, unknown>, 'taskId'); } catch { throw new Refusal('InvalidShape', 'options.taskId'); } })();
    const task = this.tasks.get(taskId);
    if (!task) throw new Refusal('NotFound', 'taskId');
    this.require(owner, task.projectId);
    if (scope.scope === 'project' && scope.projectId !== task.projectId) throw new Refusal('NotFound', 'recipeId');
    const recipe = this.recipes.get(this.key(scope, name));
    if (!recipe) throw new Refusal('NotFound', 'recipeId');
    const has = (command: string) => task.slash.some(known => known.replace(/^\//, '') === command.replace(/^\//, ''));
    const messages: string[] = [], blocked: string[] = [];
    const steps = recipe.steps.map((step, index) => {
      let status = 'supported', reason = 'Sent as a message.';
      let send = (step.text ?? '').trim();
      if (step.kind === 'slash') {
        const command = (step.command ?? '').trim(), word = command.split(/\s+/)[0];
        if (has(word)) send = command; else if (send) { status = 'fallback'; reason = `${word} is not offered by ${task.provider}; the step's own text is sent instead.`; } else { status = 'blocked'; reason = `${word} is not offered by ${task.provider} and the step has no fallback text.`; }
      }
      for (const need of step.requires ?? []) if (need.startsWith('slash:') && !has(need.slice(6))) { status = 'blocked'; reason = `Requires /${need.slice(6).replace(/^\//, '')} which ${task.provider} does not offer.`; }
      if (step.kind === 'approval') { status = status === 'blocked' ? status : 'manual'; reason = 'Waits for you to confirm before the next step.'; send = send || 'Continue'; }
      if (status === 'blocked') blocked.push(`step-${index + 1}`); else messages.push(send);
      return { index, status, reason };
    });
    if (blocked.length) throw new Refusal('UnsupportedCapability', 'recipeId', blocked);
    const queued: string[] = [];
    for (const text of messages) {
      try { this.require(owner, task.projectId); } catch (error) { if (error instanceof Refusal) throw new Refusal(error.code, error.path, queued); throw error; }
      const entry = { id: this.id('entry'), text, by: this.by(owner) };
      this.queue.set(taskId, [...(this.queue.get(taskId) ?? []), entry]);
      queued.push(entry.id);
      if (this.revokeAfterQueued !== null && queued.length === this.revokeAfterQueued) { this.grants.delete(owner); this.revokeAfterQueued = null; }
    }
    this.transcript.push(`Recipe “${name}” run by ${this.by(owner)}: ${queued.length} queued`);
    return { recipeId: recipeId(scope, name), taskId, queued: queued.length, entries: queued, steps };
  }

  // Wake-ups --------------------------------------------------------------------------------------------------------
  private projectsOf(input: Record<string, Json>): string[] {
    const task = this.tasks.get(input.sessionId as string);
    if (!task) throw new Refusal('NotFound', 'input.sessionId');
    const projects = [task.projectId];
    if (typeof input.watchSessionId === 'string' && input.watchSessionId) {
      const watched = this.tasks.get(input.watchSessionId);
      if (!watched) throw new Refusal('NotFound', 'input.watchSessionId');
      if (!projects.includes(watched.projectId)) projects.push(watched.projectId);
    }
    return projects;
  }
  /** Mirror of the cadence rules `schedules::validate` enforces (the native ones answer in the app). */
  private validateWakeup(input: Record<string, Json>) {
    const fail = (message: string): never => { throw new Refusal(codeOfText(message), 'input'); };
    if (!String(input.prompt ?? '').trim()) fail('Write the message the thread should be sent.');
    if ([...String(input.title ?? '').trim()].length > 120) fail('Keep the title under 120 characters.');
    if (!WAKEUP_KINDS.includes(String(input.kind))) fail('Choose once, interval, daily, weekdays, weekly or after.');
    if (typeof input.maxRuns === 'number' && (input.maxRuns < 1 || input.maxRuns > 1000)) fail('Max runs must be 1 to 1000, or empty to run until removed.');
    if (['daily', 'weekdays', 'weekly'].includes(String(input.kind)) && !/^\d{1,2}:\d{2}$/.test(String(input.timeOfDay ?? ''))) fail('Use a 24-hour local time like 09:30.');
  }
  private build(id: string, input: Record<string, Json>, projectId: string, enabled = true): Wakeup {
    const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : null);
    const number = (key: string) => (typeof input[key] === 'number' ? (input[key] as number) : null);
    const prompt = String(input.prompt).trim();
    return {
      id, sessionId: input.sessionId as string, projectId, prompt, title: String(input.title ?? '').trim() || prompt.split('\n')[0].slice(0, 60), kind: String(input.kind), intervalMinutes: number('intervalMinutes'),
      timeOfDay: text('timeOfDay'), days: Array.isArray(input.days) ? (input.days as number[]) : [], runAt: number('runAt'), watchSessionId: text('watchSessionId'), onlyOnSuccess: input.onlyOnSuccess === true,
      maxRuns: number('maxRuns'), workflowId: text('workflowId'), chainFromId: text('chainFromId'), enabled,
    };
  }
  wakeupsCall(owner: string, params: Record<string, unknown>): Json {
    switch (params.op) {
      case 'list': {
        exact(params, ['op', 'taskId']);
        const taskId = optionalIdent(params, 'taskId');
        if (taskId !== null) {
          const task = this.tasks.get(taskId);
          if (!task) throw new Refusal('NotFound', 'taskId');
          this.require(owner, task.projectId);
          return [...this.wakeups.values()].filter(wakeup => wakeup.sessionId === taskId).map(wakeup => this.wakeupView(wakeup));
        }
        const visible = [...this.projects].filter(project => this.held(owner, project));
        if (!visible.length && !this.held(owner, null)) throw denied();
        return [...this.wakeups.values()].filter(wakeup => visible.includes(wakeup.projectId)).slice(0, MAX_LIST).map(wakeup => this.wakeupView(wakeup));
      }
      case 'create': {
        exact(params, ['op', 'input']);
        const input = admitWakeup(params.input);
        const projects = this.projectsOf(input);
        for (const project of projects) this.require(owner, project);
        this.validateWakeup(input);
        const wakeup = this.build(this.id('wakeup'), input, projects[0]);
        this.wakeups.set(wakeup.id, wakeup);
        this.record(`wakeup:${wakeup.id}`, owner);
        return this.wakeupView(wakeup);
      }
      case 'update': {
        exact(params, ['op', 'wakeupId', 'input']);
        const id = requiredIdent(params, 'wakeupId');
        const input = admitWakeup(params.input);
        const before = this.wakeups.get(id);
        if (!before) throw new Refusal('NotFound', 'wakeupId');
        const projects = [before.projectId, ...this.projectsOf(input).filter(project => project !== before.projectId)];
        for (const project of projects) this.require(owner, project);
        this.validateWakeup(input);
        if (typeof input.maxRuns === 'number' && input.maxRuns <= 0) throw new Refusal('LimitExceeded', 'input');
        const wakeup = this.build(id, input, this.projectsOf(input)[0], before.enabled);
        this.wakeups.set(id, wakeup);
        return this.wakeupView(wakeup);
      }
      case 'remove': {
        exact(params, ['op', 'wakeupId']);
        const id = requiredIdent(params, 'wakeupId');
        const wakeup = this.wakeups.get(id);
        if (!wakeup) throw new Refusal('NotFound', 'wakeupId');
        this.require(owner, wakeup.projectId);
        this.confirm(owner, `wake-up “${wakeup.title}”`);
        this.require(owner, wakeup.projectId);
        this.wakeups.delete(id);
        this.origins.delete(`wakeup:${id}`);
        return null;
      }
      default: throw new Refusal('InvalidShape');
    }
  }

  /** The service call as the host answers it: `{ok, value}` or the refusal envelope. */
  serve(owner: string, method: string, params: Record<string, unknown>): Reply {
    try {
      if (!this.installed.has(owner)) throw denied();
      const value = method === 'workspaceRecipes' ? this.recipesCall(owner, params) : method === 'workspaceWakeups' ? this.wakeupsCall(owner, params) : (() => { throw new Refusal('UnsupportedCapability'); })();
      return { ok: true, value };
    } catch (error) { return error instanceof Refusal ? fail(error) : fail(new Refusal('HostUnavailable')); }
  }
  snapshot() {
    return {
      schemaVersion: 1, entries: Object.fromEntries([...this.origins].map(([key, origin]) => [key, origin])),
      recipes: [...this.recipes.keys()].sort(), wakeups: [...this.wakeups.keys()].sort(), queue: Object.fromEntries(this.queue), transcript: this.transcript, dialogs: this.dialogs,
    };
  }
}

// ---- Preview stand-in --------------------------------------------------------------------------------------------------------

let world: SchedulesWorld | undefined;
const worldOf = () => world ??= new SchedulesWorld();

/**
 * The preview's IPC for the commands of this slice. `extensions_workspace_schedules_service` is the service call as the host
 * answers it; `extensions_workspace_schedules_preview` is the test hook; `extensions_workspace_origins` is the window's read of
 * the attribution ledger (as the native command answers it).
 */
export function previewWorkspaceSchedules(command: string, args: Record<string, unknown>): unknown {
  const state = worldOf();
  switch (command) {
    case 'extensions_workspace_origins': return state.snapshot();
    case 'extensions_workspace_schedules_service': return state.serve(String(args.owner ?? ''), String(args.method ?? ''), (args.params ?? {}) as Record<string, unknown>);
    case 'extensions_workspace_schedules_preview': {
      const owner = String(args.owner ?? '');
      switch (args.op) {
        case 'install': state.installed.set(owner, String(args.name ?? owner)); return null;
        case 'uninstall': state.installed.delete(owner); return null;
        case 'grant': state.grants.set(owner, { projects: Array.isArray(args.projects) ? (args.projects as string[]) : null }); return null;
        case 'revoke': state.grants.delete(owner); return null;
        case 'confirm': if (typeof args.confirmDeletions === 'boolean') state.confirmDeletions.set(owner, args.confirmDeletions); if (args.answer === 'accept' || args.answer === 'cancel') state.answer = args.answer; return null;
        case 'revokeAfterQueued': state.revokeAfterQueued = Number(args.count); return null;
        case 'state': return state.snapshot();
        default: throw new Error('InvalidArguments');
      }
    }
    default: throw new Error('Unsupported extension preview command.');
  }
}

/** The shared preview store (the spec resets it between tests by reloading). */
export const previewSchedulesWorld = (): SchedulesWorld => worldOf();

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('workspace-schedules')) {
  (globalThis as { __workspaceSchedules?: unknown }).__workspaceSchedules = { call: (command: string, args?: Record<string, unknown>) => call(command, args ?? {}) };
}
