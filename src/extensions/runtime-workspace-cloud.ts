// Moodboards and already configured cloud machines (`workspace.manage`, runtime phase R4, slice R0406C).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_cloud.rs; the first half of this file mirrors them with
// no I/O for the browser preview and the deterministic checks of tests/extensions-runtime-workspace-cloud.spec.ts. The second
// half is what the main window runs: it shows the host confirmation of the two irreversible removals (a moodboard, a cloud
// machine) with the package's name, in the host's own extension dialog, and answers the round the native side is waiting on.
// A package that holds `workspace.manage` for a project is never asked per action (ADR-0005); the confirmation is the default
// of irreversibility, which the user can turn off per package. Connecting a provider, pairing and remote access stay with the
// user and are not methods; no call takes or returns a credential (ADR-0006).
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'workspace.manage';
export const MOODBOARD_OPS = ['create', 'rename', 'remove', 'addImage', 'removeImage'] as const;
export const CLOUD_OPS = ['provision', 'sync', 'retry', 'open', 'stop', 'remove'] as const;
/** Frozen method to the native seam it adapts. */
export const SEAMS: readonly (readonly [string, string])[] = [
  ['workspace.moodboards.create', 'create_moodboard'], ['workspace.moodboards.rename', 'rename_moodboard'], ['workspace.moodboards.remove', 'delete_moodboard'],
  ['workspace.moodboards.addImage', 'add_moodboard_image'], ['workspace.moodboards.removeImage', 'remove_moodboard_image'],
  ['workspace.cloud.provision', 'cloud_create'], ['workspace.cloud.sync', 'cloud_agent_action'], ['workspace.cloud.retry', 'cloud_agent_action'],
  ['workspace.cloud.open', 'cloud_agent_action'], ['workspace.cloud.stop', 'cloud_agent_action|cloud_power'], ['workspace.cloud.remove', 'cloud_agent_action|cloud_power'],
];
export const MAX_NAME_CHARS = 120;
export const MAX_IMAGE_NAME_CHARS = 255;
export const MAX_DATA_URL_BYTES = 17 * 1024 * 1024;
export const MAX_WAITING = 4;
export const MAX_BOARDS = 24;
export const MAX_IMAGES = 64;
export const ACTIVITY_MAX = 200;
/** The providers a machine id can name (`src-tauri/src/cloud.rs` `PROVIDERS`). */
const PROVIDERS = ['daytona', 'docker', 'digitalocean', 'vultr', 'hetzner', 'runpod', 'cloudflare', 'aws', 'agentcore', 'gcloud', 'e2b', 'modal', 'vercel', 'codesandbox', 'runloop', 'blaxel', 'tensorlake', 'freestyle', 'railway', 'boat', 'instabox'];

export type { Refusal, Reply };
const refuse = (code: string, path = '$'): Refusal => ({ code, path, ids: [] });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);
const only = (map: Record<string, unknown>, allowed: readonly string[]): Refusal | null => Object.keys(map).some(key => !allowed.includes(key)) ? refuse('InvalidShape') : null;

export type Mood =
  | { op: 'create'; projectId: string; name: string } | { op: 'rename'; boardId: string; name: string } | { op: 'remove'; boardId: string }
  | { op: 'addImage'; boardId: string; name: string; dataUrl: string } | { op: 'removeImage'; boardId: string; imageId: string };
export type Cloud =
  | { op: 'provision'; provider: string; name: string } | { op: 'sync' | 'retry' | 'open' | 'stop' | 'remove'; machineId: string };

function label(map: Record<string, unknown>, key: string, max: number): string | Refusal {
  const raw = map[key];
  if (typeof raw !== 'string') return refuse('InvalidShape');
  const text = raw.trim();
  if (text === '' || /\p{Cc}/u.test(text)) return refuse('InvalidShape');
  return [...text].length > max ? refuse('LimitExceeded') : text;
}
function inputOf(map: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> | Refusal {
  const object = map.input;
  if (!record(object)) return refuse('InvalidShape');
  return only(object, allowed) ?? object;
}
const need = (map: Record<string, unknown>, key: string): string | Refusal => (ident(map[key]) ? (map[key] as string) : refuse('InvalidShape'));

/** Reads a moodboard call: `{op, input?, boardId?, imageId?, name?}`. Nothing is looked up here. */
export function readMoodboard(raw: unknown): Mood | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const op = raw.op;
  if (typeof op !== 'string' || !(MOODBOARD_OPS as readonly string[]).includes(op)) return refuse('InvalidShape');
  const extra = only(raw, op === 'create' ? ['op', 'input'] : op === 'rename' ? ['op', 'boardId', 'name'] : op === 'remove' ? ['op', 'boardId'] : op === 'addImage' ? ['op', 'boardId', 'input'] : ['op', 'boardId', 'imageId']);
  if (extra) return extra;
  if (op === 'create') {
    const object = inputOf(raw, ['projectId', 'name']);
    if (isRefusal(object)) return object;
    const projectId = need(object, 'projectId'), name = label(object, 'name', MAX_NAME_CHARS);
    return isRefusal(projectId) ? projectId : isRefusal(name) ? name : { op, projectId, name };
  }
  const boardId = need(raw, 'boardId');
  if (isRefusal(boardId)) return boardId;
  if (op === 'rename') { const name = label(raw, 'name', MAX_NAME_CHARS); return isRefusal(name) ? name : { op, boardId, name }; }
  if (op === 'remove') return { op, boardId };
  if (op === 'addImage') {
    const object = inputOf(raw, ['name', 'dataUrl']);
    if (isRefusal(object)) return object;
    const name = label(object, 'name', MAX_IMAGE_NAME_CHARS);
    if (isRefusal(name)) return name;
    const dataUrl = object.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return refuse('InvalidShape');
    return dataUrl.length > MAX_DATA_URL_BYTES ? refuse('LimitExceeded') : { op, boardId, name, dataUrl };
  }
  const imageId = need(raw, 'imageId');
  return isRefusal(imageId) ? imageId : { op: 'removeImage', boardId, imageId };
}

/** A machine id is `<provider>:<native id>` of a known provider; the native id is a plain name. */
export function validMachineId(id: string): boolean {
  const at = id.indexOf(':');
  if (at < 0) return false;
  const native = id.slice(at + 1);
  return PROVIDERS.includes(id.slice(0, at)) && native.length >= 1 && native.length <= 200 && /^[A-Za-z0-9_.-]+$/.test(native) && !native.startsWith('.') && !native.includes('..');
}

/** Reads a cloud call: `{op, input?, machineId?}`. */
export function readCloud(raw: unknown): Cloud | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const op = raw.op;
  if (typeof op !== 'string' || !(CLOUD_OPS as readonly string[]).includes(op)) return refuse('InvalidShape');
  if (op === 'provision') {
    const extra = only(raw, ['op', 'input']);
    if (extra) return extra;
    const object = inputOf(raw, ['provider', 'name']);
    if (isRefusal(object)) return object;
    const provider = object.provider, name = object.name;
    if (typeof provider !== 'string' || !/^[a-z0-9-]{1,32}$/.test(provider)) return refuse('InvalidShape');
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) return refuse('InvalidShape');
    return name.length > 63 ? refuse('LimitExceeded') : { op, provider, name };
  }
  const extra = only(raw, ['op', 'machineId']);
  if (extra) return extra;
  const machineId = need(raw, 'machineId');
  if (isRefusal(machineId)) return machineId;
  return validMachineId(machineId) ? { op: op as 'sync' | 'retry' | 'open' | 'stop' | 'remove', machineId } : refuse('InvalidShape');
}

/** The frozen code for the text a native seam failed with. Nothing of the text reaches a package. */
export function codeOf(text: string): string {
  const lower = text.toLowerCase();
  const has = (needles: readonly string[]) => needles.some(needle => lower.includes(needle));
  if (has(['wait for the agent', 'stop it first'])) return 'Busy';
  if (has(['24 moodboards', 'up to eight', 'between one and eight', 'too large', 'at most', 'limit', 'under 2,000'])) return 'LimitExceeded';
  if (has(['connect', 'set up', 'sign in', 'not configured', 'no credentials', 'api key', 'token', 'cli is not installed'])) return 'UnsupportedCapability';
  if (has(['between 1 and', 'use a name', 'not an image', 'unsupported image', 'could not decode', 'invalid', 'unknown cloud action'])) return 'InvalidShape';
  if (has(['unavailable', 'not found', 'no such', 'unknown cloud machine', 'no longer', 'does not run on a cloud', 'no cloud machine', 'lost its local checkout'])) return 'NotFound';
  if (has(['already'])) return 'Conflict';
  return 'HostUnavailable';
}

// ---- The preview model -----------------------------------------------------------------------------------------------

/** What the world answers for a call: whether the package holds the permission at all, and for which project (`null`: the
 * grant for every project, which a call that is not about one needs). */
export type Checks = { holds: boolean; granted: (project: string | null) => boolean };
export type Activity = { owner: string; method: string; subject: string; outcome: string };
type Board = { project: string; name: string; images: Map<string, string> };
type Machine = { provider: string; name: string; state: string; task?: { id: string; project: string; busy?: boolean } };

/** The deterministic twin of the native `serve`: same order of checks, same refusals, same effects. */
export class WorkspaceModel {
  /** The projects a board can be created in (the spec fills it). */
  readonly projects = new Set<string>();
  readonly boards = new Map<string, Board>();
  readonly machines = new Map<string, Machine>();
  /** Providers the user already connected (a package cannot connect one). */
  readonly connected = new Set<string>(['daytona']);
  /** Per package: whether an irreversible removal asks the host first (the default). */
  readonly confirmDeletions = new Map<string, boolean>();
  /** What the user answers a host confirmation. */
  decide: (owner: string, what: string) => boolean = () => true;
  readonly confirmations: { owner: string; action: string; what: string }[] = [];
  readonly activity: Activity[] = [];
  readonly opened: string[] = [];
  readonly synced: string[] = [];
  private serial = 0;

  addBoard(id: string, project: string, name: string): void { this.boards.set(id, { project, name, images: new Map() }); }
  addMachine(id: string, state = 'running', task?: { id: string; project: string; busy?: boolean }): void { const at = id.indexOf(':'); this.machines.set(id, { provider: id.slice(0, at), name: id.slice(at + 1), state, ...(task ? { task } : {}) }); }
  private record(owner: string, method: string, subject: string, reply: Reply<Json>): Reply<Json> {
    this.activity.push({ owner, method, subject, outcome: reply.ok ? 'ok' : reply.error.code });
    if (this.activity.length > ACTIVITY_MAX) this.activity.shift();
    return reply;
  }
  private confirm(owner: string, action: string, what: string): Refusal | null {
    if (this.confirmDeletions.get(owner) === false) return null;
    this.confirmations.push({ owner, action, what });
    return this.decide(owner, what) ? null : refuse('Cancelled');
  }

  /** `panda.workspace.moodboards.*`. `between` runs after admission and before the effect (the spec revokes there). */
  moodboards(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    let subject = '';
    const reply = this.moodboardsInner(owner, checks, raw, between, value => { subject = value; });
    return this.record(owner, 'workspaceMoodboards', subject, reply);
  }
  private moodboardsInner(owner: string, checks: Checks, raw: unknown, between: () => void, about: (subject: string) => void): Reply<Json> {
    if (!checks.holds) return envelope(denied());
    const call = readMoodboard(raw);
    if (isRefusal(call)) return envelope(call);
    const board = 'boardId' in call ? this.boards.get(call.boardId) : undefined;
    about('boardId' in call ? call.boardId : call.projectId);
    if ('boardId' in call && !board) return envelope(refuse('NotFound'));
    const project = call.op === 'create' ? call.projectId : board!.project;
    if (!checks.granted(project)) return envelope(denied());
    if (call.op === 'remove') {
      const declined = this.confirm(owner, 'moodboards.remove', `Delete moodboard ${call.boardId} and its images`);
      if (declined) return envelope(declined);
    }
    between();
    if (!checks.holds || !checks.granted(project)) return envelope(denied());
    switch (call.op) {
      case 'create': {
        if (!this.projects.has(call.projectId)) return envelope(refuse('NotFound'));
        if ([...this.boards.values()].filter(item => item.project === call.projectId).length >= MAX_BOARDS) return envelope(refuse('LimitExceeded'));
        const id = `board-${++this.serial}`;
        this.addBoard(id, call.projectId, call.name);
        return { ok: true, value: { id, projectId: call.projectId, name: call.name, imageCount: 0 } };
      }
      case 'rename': board!.name = call.name; return { ok: true, value: { id: call.boardId, projectId: board!.project, name: call.name, imageCount: board!.images.size } };
      case 'remove': this.boards.delete(call.boardId); return { ok: true, value: null };
      case 'addImage': {
        if (board!.images.size >= MAX_IMAGES) return envelope(refuse('LimitExceeded'));
        board!.images.set(`image-${++this.serial}`, call.name);
        return { ok: true, value: { id: call.boardId, imageCount: board!.images.size, images: [...board!.images].map(([id, name]) => ({ id, name })) } };
      }
      default:
        if (!board!.images.delete(call.imageId)) return envelope(refuse('NotFound'));
        return { ok: true, value: null };
    }
  }
  /** `panda.workspace.cloud.*`. */
  cloud(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    let subject = '';
    const reply = this.cloudInner(owner, checks, raw, between, value => { subject = value; });
    return this.record(owner, 'workspaceCloud', subject, reply);
  }
  private cloudInner(owner: string, checks: Checks, raw: unknown, between: () => void, about: (subject: string) => void): Reply<Json> {
    if (!checks.holds) return envelope(denied());
    const call = readCloud(raw);
    if (isRefusal(call)) return envelope(call);
    about('machineId' in call ? call.machineId : 'provision');
    const machine = 'machineId' in call ? this.machines.get(call.machineId) : undefined;
    // A machine a cloud task owns is gated on that task's project; any other call is not about a project.
    const project = machine?.task?.project ?? null;
    if (!checks.granted(project)) return envelope(denied());
    if (call.op === 'remove') {
      const declined = this.confirm(owner, 'cloud.machines.remove', `Delete cloud machine ${call.machineId}`);
      if (declined) return envelope(declined);
    }
    between();
    if (!checks.holds || !checks.granted(project)) return envelope(denied());
    if (call.op === 'provision') {
      if (!this.connected.has(call.provider)) return envelope(refuse('UnsupportedCapability'));
      const id = `${call.provider}:${call.name}`;
      if (this.machines.has(id)) return envelope(refuse('Conflict'));
      this.addMachine(id, 'starting');
      return { ok: true, value: { id, provider: call.provider, name: call.name, state: 'starting', os: 'linux', desktop: false, detail: '' } };
    }
    const id = call.machineId;
    // Open shows the machine in the machines panel (no task is needed for that).
    if (call.op === 'open') { this.opened.push(id); return { ok: true, value: null }; }
    if (!machine) return envelope(refuse('NotFound'));
    if (call.op === 'sync' || call.op === 'retry') {
      if (!machine.task) return envelope(refuse('NotFound'));
      if (machine.task.busy) return envelope(refuse('Busy'));
      this.synced.push(`${call.op}:${id}`);
      return { ok: true, value: null };
    }
    if (machine.task?.busy) return envelope(refuse('Busy'));
    if (call.op === 'stop') machine.state = 'stopped'; else this.machines.delete(id);
    return { ok: true, value: null };
  }
  /** The activity of one package (or every package), oldest first. */
  activityOf(owner?: string): Activity[] { return this.activity.filter(item => owner === undefined || item.owner === owner); }
}

// ---- The window: the host confirmation ---------------------------------------------------------------------------------

export type Round = { id: string; owner: string; name: string; phase: 'confirm'; action: string; what: string };
type Shown = { id: string; owner: string; close: () => void; hostClosed: boolean };
const queue: Round[] = [];
let active: Shown | undefined;
let started = false;
let retry: ReturnType<typeof setTimeout> | undefined;

async function send(id: string, answer: Record<string, unknown>): Promise<void> {
  const { call } = await import('../bridge');
  try { await call('extensions_runtime_workspace_cloud_answer', { id, answer }); } catch { /* the call timed out or ended: nothing waits */ }
}

function pump(): void {
  if (active || queue.length === 0) return;
  void open(queue.shift()!);
}

async function open(round: Round): Promise<void> {
  const [{ openExtensionDialog }, { extensionIdentity, onExtensionsChanged }] = await Promise.all([import('./dialogs'), import('./manager')]);
  if (active) { queue.unshift(round); return; }
  const focused = document.activeElement;
  const anchor = focused instanceof HTMLElement && !focused.closest('dialog') ? focused : document.body;
  try {
    // The package's name is on the dialog (its owner line) and in the title: the user sees who asks, and what is removed.
    const title = `${round.name}: ${round.what}`.slice(0, 120);
    const transient = openExtensionDialog({ title, fields: [], confirmLabel: 'Delete', successMessage: 'Deleted.', cancelMessage: 'Kept.' }, {}, round.owner, anchor);
    const shown: Shown = { id: round.id, owner: round.owner, close: transient.close, hostClosed: false };
    active = shown;
    const identity = extensionIdentity(round.owner);
    // Disable, revoke, uninstall and safe mode change the package: its confirmation goes at once and removes nothing.
    const unsubscribe = onExtensionsChanged(() => { if (extensionIdentity(round.owner) !== identity) transient.close(); });
    void transient.result.then(result => {
      unsubscribe(); if (active === shown) active = undefined;
      // Another host dialog is open: ask again shortly instead of answering for the user.
      if (result.kind === 'cancelled' && result.reason === 'busy') { queue.unshift(round); if (retry) clearTimeout(retry); retry = setTimeout(() => { retry = undefined; pump(); }, 400); return; }
      if (!shown.hostClosed) void send(round.id, { accepted: result.kind === 'confirmed' });
      pump();
    });
  } catch { void send(round.id, { accepted: false }); pump(); }
}

/** A confirmation the host announced; a known id is not shown twice. */
export function receiveConfirmation(round: Round): void {
  if (active?.id === round.id || queue.some(entry => entry.id === round.id)) return;
  queue.push(round); pump();
}
/** The service ended: its confirmations leave the window, shown or waiting. The native side already resolved them as revoked. */
export function endOwner(owner: string): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].owner === owner) queue.splice(index, 1);
  if (active?.owner === owner) { active.hostClosed = true; active.close(); }
}

/** Starts listening in the main window. */
export async function mountWorkspaceCloud(): Promise<void> {
  if (started || typeof document === 'undefined') return;
  started = true;
  const { subscribe, preview } = await import('../bridge');
  // The bridge types its events by name; these two belong to this slice.
  const listen = subscribe as unknown as (name: string, callback: (event: unknown) => void) => Promise<() => void>;
  // The browser preview has no service: the spec delivers confirmations through this seam.
  if (preview) (window as unknown as Record<string, unknown>).__runtimeWorkspaceCloud = { receive: receiveConfirmation, end: endOwner };
  try { await listen('extensions-runtime-workspace-cloud', event => receiveConfirmation(event as Round)); } catch { /* no events */ }
  try { await listen('extensions-runtime-workspace-cloud-end', event => endOwner(String((event as { owner?: string }).owner ?? ''))); } catch { /* no events */ }
}

/** Test seam: forget every queued and shown confirmation. */
export function resetWorkspaceCloud(): void { queue.length = 0; active = undefined; if (retry) { clearTimeout(retry); retry = undefined; } started = false; }

/** The preview's IPC for the commands of this slice: the answers are recorded for the spec and the log is empty. */
export function previewWorkspaceCloud(command: string, args: Record<string, unknown>): unknown {
  if (command === 'extensions_runtime_workspace_cloud_answer') { ((window as unknown as { __runtimeWorkspaceCloudAnswers?: unknown[] }).__runtimeWorkspaceCloudAnswers ??= []).push(args); return null; }
  if (command === 'extensions_runtime_workspace_cloud_activity') return [];
  throw new Error('Unsupported extension preview command.');
}
