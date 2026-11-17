// Attributed task start for background services (`tasks.start`, runtime phase R4, slice R0401).
//
// The native rules live in src-tauri/src/extensions/runtime_tasks_start.rs; the first half of this file mirrors them with no
// I/O for the browser preview and the deterministic checks of tests/extensions-runtime-tasks-start.spec.ts. The second half
// is what the main window runs: it answers which harness, model and mode a start uses (the user's own defaults, which only
// the window knows), and it marks every task a package started with the package's name in the sidebar rows (which is the
// history too) and in the thread header. Everything here is for predictability and fault isolation, never for trust
// (ADR-0005): a package that holds `tasks.start` for a project is never asked again per action.
import type { Json } from './contracts';

export const PERMISSION = 'tasks.start';
export const PROMPT_BYTES = 200_000;
export const TITLE_CHARS = 200;
export const MAX_ATTACHMENTS = 16;
export const MAX_WAITING = 4;
export const MAX_ORIGINS = 10_000;
export const MODES = ['ask', 'auto', 'review', 'plan', 'full'] as const;
export type Mode = (typeof MODES)[number];
const KEYS = ['projectId', 'prompt', 'harness', 'model', 'effort', 'mode', 'title', 'worktree', 'target', 'attachments'] as const;

export type Worktree = { kind: 'current' } | { kind: 'new' } | { kind: 'existing'; branch: string };
export type Spec = { projectId: string; prompt: string; title?: string; harness?: string; model?: string; effort?: string; mode?: Mode; worktree: Worktree; target?: string; attachments: string[] };
/** The refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries. */
export type Refusal = { code: string; path: string; ids: string[] };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: string; ids: string[] } };
export type Defaults = { harness: string; model: string; mode: Mode; effort?: string };
export type Started = { id: string; projectId: string; worktree: string | null };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
export const envelope = (refusal: Refusal): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code: refusal.code, path: refusal.path, ids: refusal.ids } });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** What the app answers about the world; the spec gives fixed answers. */
export type World = {
  /** The package holds `tasks.start` for this project now (narrowing included). */
  granted: (projectId: string) => boolean;
  projectExists: (projectId: string) => boolean;
  /** A machine that is already paired and accepts remote control. */
  targetPaired: (target: string) => boolean;
};

function optionalText(raw: Record<string, unknown>, key: string): string | undefined | Refusal {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return ident(value) ? value : refuse('InvalidShape');
}
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string';

/** Reads a request and checks it, in the frozen order: the project id, the permission, the rest of the shape, what must exist. */
export function admit(world: World, raw: unknown): Spec | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  if (!ident(raw.projectId)) return refuse('InvalidShape');
  const projectId = raw.projectId;
  if (!world.granted(projectId)) return denied();
  if (Object.keys(raw).some(key => !(KEYS as readonly string[]).includes(key))) return refuse('InvalidShape');
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') return refuse('InvalidShape');
  if (utf8(raw.prompt) > PROMPT_BYTES) return refuse('LimitExceeded');
  let title: string | undefined;
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string' || /\p{Cc}/u.test(raw.title) || raw.title.trim() === '') return refuse('InvalidShape');
    if ([...raw.title].length > TITLE_CHARS) return refuse('LimitExceeded');
    title = raw.title.trim();
  }
  const harness = optionalText(raw, 'harness'), model = optionalText(raw, 'model'), effort = optionalText(raw, 'effort'), mode = optionalText(raw, 'mode'), target = optionalText(raw, 'target');
  for (const part of [harness, model, effort, mode, target]) if (isRefusal(part)) return part;
  if (mode !== undefined && !(MODES as readonly string[]).includes(mode as string)) return refuse('InvalidShape');
  let worktree: Worktree = { kind: 'current' };
  if (raw.worktree !== undefined && raw.worktree !== null) {
    if (raw.worktree === 'current') worktree = { kind: 'current' };
    else if (raw.worktree === 'new') worktree = { kind: 'new' };
    else if (ident(raw.worktree) && /^[A-Za-z0-9_/.-]+$/.test(raw.worktree) && !raw.worktree.includes('..') && !raw.worktree.startsWith('-')) worktree = { kind: 'existing', branch: raw.worktree };
    else return refuse('InvalidShape');
  }
  let attachments: string[] = [];
  if (raw.attachments !== undefined && raw.attachments !== null) {
    if (!Array.isArray(raw.attachments)) return refuse('InvalidShape');
    if (raw.attachments.length > MAX_ATTACHMENTS) return refuse('LimitExceeded');
    if (!raw.attachments.every(ident)) return refuse('InvalidShape');
    attachments = raw.attachments as string[];
  }
  if (!world.projectExists(projectId)) return refuse('NotFound');
  if (target !== undefined && !world.targetPaired(target as string)) return refuse('NotFound');
  return { projectId, prompt: raw.prompt, ...(title ? { title } : {}), ...(harness ? { harness: harness as string } : {}), ...(model ? { model: model as string } : {}), ...(effort ? { effort: effort as string } : {}), ...(mode ? { mode: mode as Mode } : {}), worktree, ...(target ? { target: target as string } : {}), attachments };
}

/** Reads the window's answer: `{ok: true, harness, model, mode, effort?}`, or `{ok: false, code, state?}`. */
export function readDefaults(answer: unknown): Defaults | Refusal {
  if (record(answer) && answer.ok === true) {
    const { harness, model, mode, effort } = answer;
    if (!ident(harness) || !ident(model) || !ident(mode) || !(MODES as readonly string[]).includes(mode)) return refuse('InvalidShape');
    return { harness, model, mode: mode as Mode, ...(ident(effort) ? { effort } : {}) };
  }
  const code = record(answer) ? answer.code : undefined;
  if (code === 'HostUnavailable') return refuse('HostUnavailable', '$', [record(answer) && answer.state === 'signedOut' ? 'signedOut' : 'unavailable']);
  return refuse(code === 'NotFound' ? 'NotFound' : 'InvalidShape');
}

/** The branch a `worktree: 'new'` start makes: from the title or the prompt, with a short suffix of the task id. */
export function branchName(seed: string, taskId: string): string {
  let slug = '';
  for (const word of seed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (slug && slug.length + 1 + word.length > 40) break;
    slug = slug ? `${slug}-${word}` : word.slice(0, 40);
  }
  const suffix = taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  const name = [slug, suffix].filter(Boolean).join('-');
  return `pandacode/${name || 'task'}`;
}

/** Maps the text of a failed host operation to the frozen code; nothing of the text reaches the package. */
export function codeOf(error: string): string {
  const text = error.toLowerCase();
  if (/already exists|already checked out|destination/.test(text)) return 'Conflict';
  if (/permission mode|too long|effort/.test(text)) return 'InvalidShape';
  if (/does not exist|not found|unknown/.test(text)) return 'NotFound';
  return 'HostUnavailable';
}

// ---- Attribution ---------------------------------------------------------------------------------------------------

export type Origin = { owner: string; package: string; projectId: string; at: number };
export type OriginSnapshot = { revision: number; origins: Record<string, { owner: string; package: string; projectId: string }> };

/** Every task a package started, with its label (the native ledger is file-backed; this one is in memory). */
export class TaskOrigins {
  private entries = new Map<string, Origin>();
  private revision_ = 0;
  /** Labels a task; a second record of the same task keeps the first. */
  record(taskId: string, origin: Origin): void {
    if (this.entries.has(taskId)) return;
    this.entries.set(taskId, origin);
    while (this.entries.size > MAX_ORIGINS) this.entries.delete(this.entries.keys().next().value as string);
    this.revision_ += 1;
  }
  forget(taskId: string): boolean { const gone = this.entries.delete(taskId); if (gone) this.revision_ += 1; return gone; }
  get(taskId: string): Origin | undefined { return this.entries.get(taskId); }
  get size() { return this.entries.size; }
  revision() { return this.revision_; }
  snapshot(): OriginSnapshot {
    return { revision: this.revision_, origins: Object.fromEntries([...this.entries].map(([id, origin]) => [id, { owner: origin.owner, package: origin.package, projectId: origin.projectId }])) };
  }
}

/** The starts that wait for the window's defaults: four per package, answered once, ended with the service. */
export class StartSlots {
  private waiting = new Map<string, { owner: string; settle: (answer: unknown) => void }>();
  private serial = 0;
  count(owner: string) { return [...this.waiting.values()].filter(entry => entry.owner === owner).length; }
  begin(owner: string): Reply<{ id: string; answer: Promise<unknown> }> {
    if (this.count(owner) >= MAX_WAITING) return envelope(refuse('LimitExceeded'));
    const id = `${owner}#start-${++this.serial}`;
    let settle!: (answer: unknown) => void;
    const answer = new Promise<unknown>(resolve => { settle = resolve; });
    this.waiting.set(id, { owner, settle });
    return { ok: true, value: { id, answer } };
  }
  answer(id: string, answer: unknown): Reply<null> {
    const entry = this.waiting.get(id);
    if (!entry) return envelope(refuse('NotFound'));
    this.waiting.delete(id); entry.settle(answer);
    return { ok: true, value: null };
  }
  cancelOwner(owner: string): number {
    const ids = [...this.waiting].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
    for (const id of ids) { const entry = this.waiting.get(id)!; this.waiting.delete(id); entry.settle({ ok: false, code: 'Revoked' }); }
    return ids.length;
  }
}

// ---- The user's defaults ---------------------------------------------------------------------------------------------

/** What the window knows of a harness: the catalog row the model picker reads. */
export type CatalogProvider = { id: string; installed: boolean; models?: readonly { id: string }[]; metadata?: { modes: readonly string[]; readiness: { state: 'ready' | 'signedOut' | 'unavailable' } } };
/** Choices a bot or channel project pins for its tasks; they sit between the request's own options and the user's defaults. */
export type Pinned = { harness?: string; model?: string; mode?: Mode; effort?: string; bot?: string; channel?: string };
export type Catalog = {
  providers: readonly CatalogProvider[];
  defaultProvider: string;
  rememberedModel: (harness: string) => string;
  initialMode: (harness: string) => Mode;
  pinned?: (projectId: string) => Pinned | undefined;
};

/** The window's answer for a start: the request's choices, then what the project pins, then the user's own defaults. A harness
 * that is unknown is `NotFound`, one that is not installed or is signed out `HostUnavailable` with its readiness state. */
export function resolveDefaults(catalog: Catalog, spec: Pick<Spec, 'projectId' | 'harness' | 'model' | 'effort' | 'mode'>): { ok: true; harness: string; model: string; mode: Mode; effort?: string } | { ok: false; code: string; state?: string } {
  const pinned = catalog.pinned?.(spec.projectId);
  const wanted = spec.harness ?? pinned?.harness;
  const provider = wanted
    ? catalog.providers.find(entry => entry.id === wanted)
    : catalog.providers.find(entry => entry.id === catalog.defaultProvider && entry.installed) ?? catalog.providers.find(entry => entry.installed) ?? catalog.providers[0];
  if (!provider) return { ok: false, code: 'NotFound' };
  if (!provider.installed) return { ok: false, code: 'HostUnavailable', state: 'unavailable' };
  const readiness = provider.metadata?.readiness.state;
  if (readiness && readiness !== 'ready') return { ok: false, code: 'HostUnavailable', state: readiness };
  // What a project pins belongs to the pinned harness: another harness chosen by the request takes none of it.
  const pins = pinned !== undefined && (pinned.harness === undefined || pinned.harness === provider.id) ? pinned : undefined;
  const model = spec.model ?? pins?.model ?? catalog.rememberedModel(provider.id);
  if (spec.model !== undefined && provider.metadata && provider.models && !provider.models.some(entry => entry.id === model)) return { ok: false, code: 'NotFound' };
  const mode = spec.mode ?? pins?.mode ?? catalog.initialMode(provider.id);
  if (provider.metadata && !provider.metadata.modes.includes(mode)) return { ok: false, code: 'InvalidShape' };
  const effort = spec.effort ?? pins?.effort;
  return { ok: true, harness: provider.id, model, mode, ...(effort ? { effort } : {}) };
}

// ---- The preview starter ---------------------------------------------------------------------------------------------

/** One task a preview start made: what the native launch would receive, and who started it. */
export type StartedTask = {
  id: string; projectId: string; title: string; harness: string; model: string; mode: Mode; effort: string | null;
  worktree: string | null; prompt: string; attachments: string[]; target: string | null;
  bot: string | null; channel: string | null; startedBy: { package: string; owner: string };
};
export type StartWorld = {
  projects: readonly string[]; catalog: Catalog;
  /** Branches that already have a worktree, and the machines that are paired. */
  worktrees: readonly string[]; targets: readonly string[];
  /** Extra check at creation time (the spec uses it to model a worktree that cannot be made). */
  failCreate?: (spec: Spec) => string | null;
};
export type Checks = { granted: (projectId: string) => boolean; package: string };

/** The deterministic twin of the native `serve` + `launch`: same order of checks, same refusals, same labels. */
export class TaskStarter {
  readonly origins = new TaskOrigins();
  readonly tasks: StartedTask[] = [];
  readonly events: Json[] = [];
  private serial = 0;
  private world: StartWorld;
  constructor(world: StartWorld) { this.world = world; }

  /** `panda.tasks.start`. A refusal creates no task; the recheck of the grant sits between the defaults and the creation. */
  start(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Started> {
    const world: World = { granted: checks.granted, projectExists: id => this.world.projects.includes(id), targetPaired: target => this.world.targets.includes(target) };
    const spec = admit(world, raw);
    if (isRefusal(spec)) return envelope(spec);
    const resolved = resolveDefaults(this.world.catalog, spec);
    if (!resolved.ok) return envelope(resolved.code === 'HostUnavailable' ? refuse('HostUnavailable', '$', [resolved.state === 'signedOut' ? 'signedOut' : 'unavailable']) : refuse(resolved.code));
    const defaults = readDefaults(resolved);
    if (isRefusal(defaults)) return envelope(defaults);
    between();
    if (!checks.granted(spec.projectId)) return envelope(denied());
    const id = `task-${++this.serial}`;
    let branch: string | null = null;
    if (spec.worktree.kind === 'new') branch = branchName(spec.title ?? spec.prompt, id);
    if (spec.worktree.kind === 'existing') {
      if (!this.world.worktrees.includes(spec.worktree.branch)) return envelope(refuse('NotFound'));
      branch = spec.worktree.branch;
    }
    const failed = this.world.failCreate?.(spec);
    if (failed) return envelope(refuse(codeOf(failed)));
    const pinned = this.world.catalog.pinned?.(spec.projectId);
    const task: StartedTask = {
      id, projectId: spec.projectId, title: spec.title ?? 'New conversation', harness: defaults.harness, model: defaults.model, mode: defaults.mode, effort: defaults.effort ?? null,
      worktree: branch, prompt: spec.prompt, attachments: spec.attachments, target: spec.target ?? null, bot: pinned?.bot ?? null, channel: pinned?.channel ?? null,
      startedBy: { package: checks.package, owner },
    };
    this.tasks.push(task);
    this.origins.record(id, { owner, package: checks.package, projectId: spec.projectId, at: this.tasks.length });
    this.events.push({ kind: 'task.created', taskId: id, projectId: spec.projectId, harness: defaults.harness, startedBy: { package: owner } });
    return { ok: true, value: { id, projectId: spec.projectId, worktree: branch } };
  }

  /** The row the sidebar and the thread header draw for a task: the title and the package that started it, when one did. */
  row(taskId: string): { id: string; title: string; startedBy: string | null } | undefined {
    const task = this.tasks.find(entry => entry.id === taskId);
    return task ? { id: task.id, title: task.title, startedBy: this.origins.get(taskId)?.package ?? null } : undefined;
  }
}

// ---- The main window -----------------------------------------------------------------------------------------------

/** What the main window supplies: the catalog and the user's defaults it already holds. */
export type MainHost = { catalog: () => Catalog };
let started = false;

/** Answers the defaults a start waits for, with the user's own choices. */
export async function startRuntimeTaskStart(host: MainHost): Promise<void> {
  if (started) return;
  started = true;
  const { call, subscribe, preview } = await import('../bridge');
  const answer = async (event: { id: string; projectId: string; harness?: string; model?: string; effort?: string; mode?: Mode }) => {
    let reply: unknown;
    try { reply = resolveDefaults(host.catalog(), event); } catch { reply = { ok: false, code: 'HostUnavailable', state: 'unavailable' }; }
    try { await call('extensions_runtime_task_defaults_answer', { id: event.id, answer: reply }); } catch { /* the start timed out or ended: nothing waits */ }
  };
  // The browser preview has no service: the spec delivers a start through this seam and reads what the mock recorded.
  if (preview) (window as unknown as Record<string, unknown>).__runtimeTaskStart = { answer };
  try { await subscribe('extensions-runtime-task-defaults', event => { void answer(event); }); } catch { /* no events */ }
}

/** Test seam: forget the started flag so a spec can start the window half again. */
export function resetRuntimeTaskStart(): void { started = false; mounted = false; }

// ---- The package label on tasks ----------------------------------------------------------------------------------------

/** Puts the package name on every sidebar row and on the thread header of a task a package started. Idempotent: it only
 * touches a row whose label is missing or out of date, so the sidebar's own redraws never loop with it. */
export function decorate(root: ParentNode, origins: OriginSnapshot['origins'], currentTaskId: string | null): number {
  let changed = 0;
  for (const row of root.querySelectorAll<HTMLElement>('.task-item[data-id]')) {
    const origin = origins[row.dataset.id ?? ''];
    const existing = row.querySelector<HTMLElement>('.runtime-task-origin');
    if (!origin) { if (existing) { existing.remove(); changed += 1; } continue; }
    if (existing && existing.dataset.taskOrigin === origin.owner && existing.textContent === origin.package) continue;
    existing?.remove();
    const chip = row.ownerDocument.createElement('span');
    chip.className = 'runtime-task-origin'; chip.dataset.taskOrigin = origin.owner; chip.textContent = origin.package;
    chip.title = `Started by ${origin.package}`;
    (row.querySelector('.task-title') ?? row).after(chip);
    changed += 1;
  }
  const crumb = root.querySelector<HTMLElement>('#breadcrumb');
  if (crumb?.parentElement) {
    const origin = currentTaskId ? origins[currentTaskId] : undefined;
    let chip = crumb.parentElement.querySelector<HTMLElement>(':scope > .runtime-task-origin-header');
    if (!origin) { if (chip) { chip.remove(); changed += 1; } }
    else if (!chip || chip.textContent !== `Started by ${origin.package}` || chip.dataset.taskOrigin !== origin.owner) {
      chip?.remove();
      chip = crumb.ownerDocument.createElement('span');
      chip.className = 'runtime-task-origin-header'; chip.dataset.taskOrigin = origin.owner; chip.textContent = `Started by ${origin.package}`;
      crumb.after(chip);
      changed += 1;
    }
  }
  return changed;
}

let mounted = false;
/** Keeps the labels equal to the host's ledger: read now, whenever the native side says it moved, and whenever the sidebar
 * or the open thread redraws. A preview window has no service, so its ledger stays empty unless the spec fills it. */
export async function mountTaskOrigins(): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, subscribe, preview } = await import('../bridge');
  await import('./runtime-tasks-start.css');
  let origins: OriginSnapshot['origins'] = {};
  const current = () => document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? null;
  const paint = () => { decorate(document, origins, current()); };
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; paint(); }); };
  const observer = new MutationObserver(schedule);
  for (const selector of ['.sidebar', '#composer-area', '.conversation-pane']) { const node = document.querySelector(selector); if (node) observer.observe(node, { childList: true, subtree: true }); }
  const read = async () => {
    try { origins = (await call<OriginSnapshot>('extensions_runtime_task_origins')).origins; } catch { return; }
    paint();
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeTaskOrigins = { set: (next: OriginSnapshot['origins']) => { origins = next; paint(); } };
  try { await subscribe('extensions-runtime-task-origins', () => { void read(); }); } catch { /* read once below */ }
  await read();
}
