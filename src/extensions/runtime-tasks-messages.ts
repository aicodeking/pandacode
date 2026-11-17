// Messages, notes and the revisioned queue for background services (`tasks.message`, runtime phase R4, slice R0402).
//
// The native rules live in src-tauri/src/extensions/runtime_tasks_messages.rs; the first half of this file mirrors them with
// no I/O for the browser preview and the deterministic checks of tests/extensions-runtime-tasks-messages.spec.ts. The second
// half is what the main window runs: it resumes a held queue when a package asks (the hold is window state) and marks every
// queued message a package added with the package's name. Everything here is for predictability and fault isolation, never for
// trust (ADR-0005): a package that holds `tasks.message` for a project is never asked again per action.
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'tasks.message';
export const CONTEXT_PERMISSION = 'harness.hooks.context';
export const TEXT_BYTES = 200_000;
export const NOTE_BYTES = 16_000;
export const MAX_ATTACHMENTS = 16;
export const MAX_NOTES_PER_TASK = 20;
export const MAX_LEDGER = 5_000;
export const VIEW_CHARS = 20_000;
const MESSAGE_KEYS = ['text', 'attachments', 'delivery'];
const OPS = ['list', 'update', 'remove', 'reorder', 'sendNow', 'resume'];

export type Delivery = 'auto' | 'queue' | 'steer';
export type Message = { taskId: string; projectId: string; text: string; attachments: string[]; delivery: Delivery };
export type Note = { taskId: string; projectId: string; text: string; forModel: boolean };
export type QueueOp =
  | { kind: 'list' } | { kind: 'resume' } | { kind: 'remove'; entry: string } | { kind: 'sendNow'; entry: string }
  | { kind: 'update'; entry: string; text: string; revision?: number } | { kind: 'reorder'; entries: string[] };
export type Queue = { taskId: string; projectId: string; op: QueueOp };
export type Plan = 'send' | 'queue' | 'steer';

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (permission: string): Refusal => refuse('PermissionDenied', permission);
const invalid = (): Refusal => refuse('InvalidShape');
const unsupported = (path: string): Refusal => refuse('UnsupportedCapability', path);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

/** What the app answers about the world; the spec gives fixed answers. */
export type World = {
  /** The project a task belongs to (`undefined`: no such task). */
  projectOf: (taskId: string) => string | undefined;
  /** The package holds `permission` for `projectId` now (narrowing included). */
  granted: (permission: string, projectId: string) => boolean;
  /** The package holds `permission` for at least one project (so an unknown task may answer `NotFound`). */
  holdsAny: (permission: string) => boolean;
};

/** The grant answers first: the task id's shape, the project the task is in, then the permission for that project. */
function scope(world: World, raw: Record<string, unknown>, permission: string): { taskId: string; projectId: string } | Refusal {
  if (!ident(raw.taskId)) return invalid();
  const taskId = raw.taskId;
  const projectId = world.projectOf(taskId);
  if (projectId === undefined) return world.holdsAny(permission) ? refuse('NotFound') : denied(permission);
  return world.granted(permission, projectId) ? { taskId, projectId } : denied(permission);
}
const onlyKeys = (object: Record<string, unknown>, allowed: readonly string[]): Refusal | null => Object.keys(object).some(key => !allowed.includes(key)) ? invalid() : null;

/** `{taskId, message: {text, attachments?, delivery?}}`. */
export function admitMessage(world: World, raw: unknown): Message | Refusal {
  if (!record(raw)) return invalid();
  const where = scope(world, raw, PERMISSION);
  if (isRefusal(where)) return where;
  const extra = onlyKeys(raw, ['taskId', 'message']);
  if (extra) return extra;
  if (!record(raw.message)) return invalid();
  const message = raw.message;
  const stray = onlyKeys(message, MESSAGE_KEYS);
  if (stray) return stray;
  if (message.text !== undefined && message.text !== null && typeof message.text !== 'string') return invalid();
  const text = typeof message.text === 'string' ? message.text : '';
  if (utf8(text) > TEXT_BYTES) return refuse('LimitExceeded');
  let attachments: string[] = [];
  if (message.attachments !== undefined && message.attachments !== null) {
    if (!Array.isArray(message.attachments)) return invalid();
    if (message.attachments.length > MAX_ATTACHMENTS) return refuse('LimitExceeded');
    if (!message.attachments.every(ident)) return invalid();
    attachments = message.attachments as string[];
  }
  if (text.trim() === '' && attachments.length === 0) return invalid();
  let delivery: Delivery = 'auto';
  if (message.delivery !== undefined && message.delivery !== null) {
    if (message.delivery === 'queue' || message.delivery === 'steer') delivery = message.delivery;
    else return invalid();
  }
  return { ...where, text, attachments, delivery };
}

/** `{taskId, note: {text, forModel?}}`; a `forModel` note also needs `harness.hooks.context`, checked before the rest of the shape. */
export function admitNote(world: World, raw: unknown): Note | Refusal {
  if (!record(raw)) return invalid();
  const where = scope(world, raw, PERMISSION);
  if (isRefusal(where)) return where;
  const wantsContext = record(raw.note) && raw.note.forModel === true;
  if (wantsContext && !world.granted(CONTEXT_PERMISSION, where.projectId)) return denied(CONTEXT_PERMISSION);
  const extra = onlyKeys(raw, ['taskId', 'note']);
  if (extra) return extra;
  if (!record(raw.note)) return invalid();
  const stray = onlyKeys(raw.note, ['text', 'forModel']);
  if (stray) return stray;
  const text = raw.note.text;
  if (typeof text !== 'string' || text.trim() === '') return invalid();
  if (utf8(text) > NOTE_BYTES) return refuse('LimitExceeded');
  if (raw.note.forModel !== undefined && raw.note.forModel !== null && typeof raw.note.forModel !== 'boolean') return invalid();
  return { ...where, text, forModel: raw.note.forModel === true };
}

/** `{op, taskId, entryId?, change?, entryIds?}`. */
export function admitQueue(world: World, raw: unknown): Queue | Refusal {
  if (!record(raw)) return invalid();
  const where = scope(world, raw, PERMISSION);
  if (isRefusal(where)) return where;
  const extra = onlyKeys(raw, ['op', 'taskId', 'entryId', 'change', 'entryIds']);
  if (extra) return extra;
  if (typeof raw.op !== 'string' || !OPS.includes(raw.op)) return invalid();
  const entry = ident(raw.entryId) ? raw.entryId : undefined;
  switch (raw.op) {
    case 'list': return { ...where, op: { kind: 'list' } };
    case 'resume': return { ...where, op: { kind: 'resume' } };
    case 'remove': return entry ? { ...where, op: { kind: 'remove', entry } } : invalid();
    case 'sendNow': return entry ? { ...where, op: { kind: 'sendNow', entry } } : invalid();
    case 'update': {
      if (!entry || !record(raw.change)) return invalid();
      const stray = onlyKeys(raw.change, ['text', 'revision']);
      if (stray) return stray;
      const { text, revision } = raw.change;
      if (typeof text !== 'string' || text.trim() === '') return invalid();
      if (utf8(text) > TEXT_BYTES) return refuse('LimitExceeded');
      if (revision !== undefined && revision !== null && !(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) return invalid();
      return { ...where, op: { kind: 'update', entry, text, ...(typeof revision === 'number' ? { revision } : {}) } };
    }
    default: {
      if (!Array.isArray(raw.entryIds) || !raw.entryIds.every(ident)) return invalid();
      const entries = raw.entryIds as string[];
      return new Set(entries).size === entries.length ? { ...where, op: { kind: 'reorder', entries } } : invalid();
    }
  }
}

/** Idle: a new turn (a steer with nothing to steer is a plain send; an explicit `queue` queues). Busy: queue, or steer where
 * the harness takes it; a steer that cannot be taken is `UnsupportedCapability` and never silently becomes a queue entry. */
export function plan(busy: boolean, delivery: Delivery, steerable: boolean, attachments: boolean): Plan | Refusal {
  if (!busy) return delivery === 'queue' ? 'queue' : 'send';
  if (delivery !== 'steer') return 'queue';
  if (!steerable) return unsupported('delivery');
  if (attachments) return unsupported('attachments');
  return 'steer';
}

export type SteerFailure = 'idle' | Refusal;
export function steerFailure(error: string): SteerFailure {
  const text = error.toLowerCase();
  if (text.includes('is not running')) return 'idle';
  if (text.includes('cannot be steered')) return unsupported('delivery');
  if (text.includes('skill')) return invalid();
  if (text.includes('under 16 mib')) return refuse('LimitExceeded');
  return refuse('HostUnavailable');
}

/** Maps the text of a failed queue operation to the frozen code; nothing of the text reaches the package. */
export function queueCode(error: string): string {
  const text = error.toLowerCase();
  if (text.includes('queue changed')) return 'StaleContext';
  if (/already sent or removed|not found|does not exist/.test(text)) return 'NotFound';
  if (/up to|too large|under 16 mib/.test(text)) return 'LimitExceeded';
  if (/write a message|invalid|skill|switched off/.test(text)) return 'InvalidShape';
  if (/already exists|already checked out|destination/.test(text)) return 'Conflict';
  if (/permission mode|too long|effort/.test(text)) return 'InvalidShape';
  return 'HostUnavailable';
}

// ---- Queue revision ------------------------------------------------------------------------------------------------

export type QueueRow = { id: string; position: number; text: string; attachments: number; createdAt: number; updatedAt: number };

/** The revision of a task's queue: FNV-1a over the ids, order, texts, attachment counts and edit times, masked to 53 bits.
 * Byte for byte the native `revision`, so a preview and the app agree. */
export function revision(entries: readonly QueueRow[]): number {
  const encoder = new TextEncoder();
  let hash = 0xcbf29ce484222325n;
  const feed = (bytes: Uint8Array) => { for (const byte of bytes) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); } };
  for (const entry of entries) {
    feed(encoder.encode(`${entry.id}\u001f${entry.position}\u001f${entry.attachments}\u001f${entry.updatedAt}\u001f`));
    feed(encoder.encode(entry.text));
    feed(Uint8Array.of(0x1e));
  }
  return Number(BigInt.asUintN(53, hash));
}

// ---- Notes for the model ---------------------------------------------------------------------------------------------

export type PendingNote = { id: string; owner: string; package: string; text: string; at: number };
export function renderContext(notes: readonly PendingNote[]): string {
  return ['Notes added by extensions for this message (not written by the user):', ...notes.map(note => `- [${note.package}] ${note.text.trim().replace(/\n/g, '\n  ')}`)].join('\n');
}
/** A typed slash command is the harness's own syntax: it never gets a block in front of it. */
export const carriesContext = (text: string): boolean => !text.trimStart().startsWith('/');

export type EntryOrigin = { taskId: string; owner: string; package: string; at: number; changedBy?: string };
export type OriginSnapshot = { revision: number; entries: Record<string, { taskId: string; owner: string; package: string; changedBy?: string | null }> };

/** Attribution of queue entries and the next-send notes (the native one is file-backed; this one is in memory). */
export class TaskMessages {
  private entries = new Map<string, EntryOrigin>();
  private notes = new Map<string, PendingNote[]>();
  private revision_ = 0;
  private serial = 0;
  recordEntry(entry: string, origin: EntryOrigin): void {
    if (this.entries.has(entry)) return;
    this.entries.set(entry, origin);
    while (this.entries.size > MAX_LEDGER) this.entries.delete(this.entries.keys().next().value as string);
    this.revision_ += 1;
  }
  changedEntry(entry: string, pkg: string): void {
    const origin = this.entries.get(entry);
    if (!origin || origin.package === pkg) return;
    origin.changedBy = pkg; this.revision_ += 1;
  }
  forgetEntry(entry: string): boolean { const gone = this.entries.delete(entry); if (gone) this.revision_ += 1; return gone; }
  entry(entry: string): EntryOrigin | undefined { return this.entries.get(entry); }
  ledgerRevision() { return this.revision_; }
  snapshot(): OriginSnapshot {
    return { revision: this.revision_, entries: Object.fromEntries([...this.entries].map(([id, origin]) => [id, { taskId: origin.taskId, owner: origin.owner, package: origin.package, changedBy: origin.changedBy ?? null }])) };
  }
  addNote(task: string, owner: string, pkg: string, text: string, at: number): Reply<string> {
    const rows = this.notes.get(task) ?? [];
    if (rows.length >= MAX_NOTES_PER_TASK) return envelope(refuse('LimitExceeded'));
    const id = `note-${++this.serial}`;
    this.notes.set(task, [...rows, { id, owner, package: pkg, text, at }]);
    return { ok: true, value: id };
  }
  /** The one reader: removes and returns the task's waiting notes, oldest first. */
  takeNotes(task: string): PendingNote[] { const taken = this.notes.get(task) ?? []; this.notes.delete(task); return taken; }
  restoreNotes(task: string, taken: PendingNote[]): void {
    if (!taken.length) return;
    this.notes.set(task, [...taken, ...(this.notes.get(task) ?? [])].slice(0, MAX_NOTES_PER_TASK));
  }
  pendingNotes(task: string): number { return this.notes.get(task)?.length ?? 0; }
  forgetTask(task: string): void {
    for (const [id, origin] of [...this.entries]) if (origin.taskId === task) { this.entries.delete(id); this.revision_ += 1; }
    this.notes.delete(task);
  }
}

// ---- The preview messenger -------------------------------------------------------------------------------------------

export type PreviewTask = { id: string; projectId: string; running: boolean; team?: boolean; steerable?: boolean };
export type MessengerWorld = {
  tasks: PreviewTask[];
  /** Makes a send fail (the text of a host failure), to prove the notes and the entry come back. */
  failSend?: (taskId: string, text: string) => string | null;
};
export type Checks = { granted: (permission: string, projectId: string) => boolean; package: string };
export type Sent = { taskId: string; text: string; attachments: string[]; notes: string[] };

/** The deterministic twin of the native `serve`: same order of checks, same refusals, same labels, same effects. */
export class TaskMessenger {
  readonly ledger = new TaskMessages();
  readonly sent: Sent[] = [];
  readonly steered: { taskId: string; text: string }[] = [];
  readonly transcript: { taskId: string; text: string }[] = [];
  readonly resumed: string[] = [];
  private queues = new Map<string, (QueueRow & { raw: string[] })[]>();
  private serial = 0;
  private clock = 0;
  constructor(private world: MessengerWorld) {}

  private task(id: string) { return this.world.tasks.find(task => task.id === id); }
  private worldFor(owner: string, checks: Checks): World {
    void owner;
    const projects = [...new Set(this.world.tasks.map(task => task.projectId))];
    return { projectOf: id => this.task(id)?.projectId, granted: (permission, project) => checks.granted(permission, project), holdsAny: permission => projects.some(project => checks.granted(permission, project)) };
  }
  private rows(taskId: string) { return this.queues.get(taskId) ?? []; }
  private view(taskId: string) {
    const rows = this.rows(taskId);
    return { revision: revision(rows), entries: rows.map((row, index) => {
      const origin = this.ledger.entry(row.id);
      const truncated = [...row.text].length > VIEW_CHARS;
      return { id: row.id, position: index, text: truncated ? [...row.text].slice(0, VIEW_CHARS).join('') : row.text, truncated, attachments: row.attachments, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(origin ? { package: origin.package } : {}), ...(origin?.changedBy ? { changedBy: origin.changedBy } : {}) };
    }) };
  }
  queueOf(taskId: string): QueueRow[] { return this.rows(taskId).map(({ raw: _raw, ...row }) => row); }
  /** The run ended: the queue's own delivery sends the first entry, once (the window's drain, or the headless one). */
  endRun(taskId: string): void {
    const task = this.task(taskId);
    if (!task) return;
    task.running = false;
    const first = this.rows(taskId)[0];
    if (!first) return;
    this.queues.set(taskId, this.rows(taskId).slice(1));
    this.deliver(taskId, first.text, first.raw);
  }
  /** A turn started by anyone but a package (the user's own send, or a drain). */
  private deliver(taskId: string, text: string, attachments: string[]): number {
    const task = this.task(taskId)!;
    const notes = carriesContext(text) ? this.ledger.takeNotes(taskId) : [];
    this.sent.push({ taskId, text: notes.length ? `${renderContext(notes)}\n\n${text}` : text, attachments, notes: notes.map(note => note.text) });
    task.running = true;
    return this.sent.length;
  }
  private recheck(checks: Checks, projectId: string, permissions: string[]): Refusal | null {
    return permissions.every(permission => checks.granted(permission, projectId)) ? null : denied(permissions[0]);
  }

  /** `panda.tasks.message`. `between` runs after admission and before the recheck (a revoke in between sends nothing). */
  message(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<{ id: string; delivery: 'sent' | 'queued' | 'steered' }> {
    const spec = admitMessage(this.worldFor(owner, checks), raw);
    if (isRefusal(spec)) return envelope(spec);
    between();
    const lost = this.recheck(checks, spec.projectId, [PERMISSION]);
    if (lost) return envelope(lost);
    const task = this.task(spec.taskId)!;
    const chosen = plan(task.running, spec.delivery, !task.team, spec.attachments.length > 0);
    if (isRefusal(chosen)) return envelope(chosen);
    const queue = (): Reply<{ id: string; delivery: 'queued' }> => {
      const rows = this.rows(spec.taskId);
      if (rows.length >= 50) return envelope(refuse('LimitExceeded'));
      this.clock += 1;
      const row = { id: `entry-${++this.serial}`, position: rows.length ? Math.max(...rows.map(entry => entry.position)) + 1 : 0, text: spec.text, attachments: spec.attachments.length, createdAt: this.clock, updatedAt: this.clock, raw: spec.attachments };
      this.queues.set(spec.taskId, [...rows, row]);
      this.ledger.recordEntry(row.id, { taskId: spec.taskId, owner, package: checks.package, at: this.clock });
      // The change reaches the window, which sends to an idle task (and a headless host drains natively).
      if (!task.running) this.endRun(spec.taskId);
      return { ok: true, value: { id: row.id, delivery: 'queued' } };
    };
    const send = (): Reply<{ id: string; delivery: 'sent' }> => {
      // A send that fails leaves the waiting notes where they are (the native path takes them back the same way).
      const failed = this.world.failSend?.(spec.taskId, spec.text);
      if (failed) return envelope(refuse(queueCode(failed)));
      const id = this.deliver(spec.taskId, spec.text, spec.attachments);
      this.transcript.push({ taskId: spec.taskId, text: `Sent by ${checks.package}` });
      return { ok: true, value: { id: String(id), delivery: 'sent' } };
    };
    if (chosen === 'queue') return queue();
    if (chosen === 'send') return send();
    if (task.steerable === false) return envelope(unsupported('delivery'));
    this.steered.push({ taskId: spec.taskId, text: spec.text });
    this.transcript.push({ taskId: spec.taskId, text: `Steered by ${checks.package}` });
    return { ok: true, value: { id: `steer-${this.steered.length}`, delivery: 'steered' } };
  }

  /** `panda.tasks.note`: a labelled transcript line; for the model also a pending block. Starts no turn. */
  note(owner: string, checks: Checks, raw: unknown): Reply<{ id: string }> {
    const spec = admitNote(this.worldFor(owner, checks), raw);
    if (isRefusal(spec)) return envelope(spec);
    const lost = this.recheck(checks, spec.projectId, spec.forModel ? [PERMISSION, CONTEXT_PERMISSION] : [PERMISSION]);
    if (lost) return envelope(lost);
    this.transcript.push({ taskId: spec.taskId, text: `${spec.forModel ? 'Note for the model' : 'Note'} from ${checks.package}: ${spec.text.trim()}` });
    if (spec.forModel) { const added = this.ledger.addNote(spec.taskId, owner, checks.package, spec.text, this.transcript.length); if (!added.ok) return added; }
    return { ok: true, value: { id: String(this.transcript.length) } };
  }

  /** `panda.tasks.queue.*`. */
  queue(owner: string, checks: Checks, raw: unknown): Reply<Json> {
    const spec = admitQueue(this.worldFor(owner, checks), raw);
    if (isRefusal(spec)) return envelope(spec);
    const lost = this.recheck(checks, spec.projectId, [PERMISSION]);
    if (lost) return envelope(lost);
    const rows = this.rows(spec.taskId);
    const op = spec.op;
    const find = (id: string) => rows.find(row => row.id === id);
    switch (op.kind) {
      case 'list': return { ok: true, value: this.view(spec.taskId) as unknown as Json };
      case 'update': {
        const row = find(op.entry);
        if (!row) return envelope(refuse('NotFound'));
        if (op.revision !== undefined && op.revision !== revision(rows)) return envelope(refuse('StaleContext'));
        this.clock += 1; row.text = op.text; row.updatedAt = this.clock;
        this.ledger.changedEntry(row.id, checks.package);
        return { ok: true, value: null };
      }
      case 'remove': {
        if (!find(op.entry)) return envelope(refuse('NotFound'));
        this.queues.set(spec.taskId, rows.filter(row => row.id !== op.entry));
        this.ledger.forgetEntry(op.entry);
        return { ok: true, value: null };
      }
      case 'reorder': {
        const current = rows.map(row => row.id).sort();
        if (JSON.stringify(current) !== JSON.stringify([...op.entries].sort())) return envelope(refuse('StaleContext'));
        this.queues.set(spec.taskId, op.entries.map((id, index) => { const row = find(id)!; row.position = index; return row; }));
        return { ok: true, value: null };
      }
      case 'resume': this.resumed.push(spec.taskId); return { ok: true, value: null };
      case 'sendNow': {
        const row = find(op.entry);
        if (!row) return envelope(refuse('NotFound'));
        const task = this.task(spec.taskId)!;
        if (task.running) {
          if (task.team || task.steerable === false) return envelope(unsupported('delivery'));
          if (row.attachments > 0) return envelope(unsupported('attachments'));
          this.steered.push({ taskId: spec.taskId, text: row.text });
          this.transcript.push({ taskId: spec.taskId, text: `Steered by ${checks.package}` });
        } else {
          const failed = this.world.failSend?.(spec.taskId, row.text);
          if (failed) return envelope(refuse(queueCode(failed)));
          this.deliver(spec.taskId, row.text, row.raw);
          this.transcript.push({ taskId: spec.taskId, text: `Sent by ${checks.package}` });
        }
        this.queues.set(spec.taskId, rows.filter(entry => entry.id !== op.entry));
        this.ledger.forgetEntry(op.entry);
        return { ok: true, value: null };
      }
    }
  }
}

// ---- The main window -----------------------------------------------------------------------------------------------

/** What the main window supplies: it alone knows a queue's hold. */
export type MainHost = { resume: (taskId: string) => void };
let started = false;

/** Releases a held queue when a package asks (`panda.tasks.queue.resume`), as the user's Resume button does. */
export async function startRuntimeTasksMessages(host: MainHost): Promise<void> {
  if (started) return;
  started = true;
  const { subscribe, preview } = await import('../bridge');
  const resume = (event: { taskId: string }) => {
    // The browser preview records what reached the window, for the spec.
    if (preview) ((window as unknown as { __runtimeQueueResumed?: string[] }).__runtimeQueueResumed ??= []).push(event.taskId);
    try { host.resume(event.taskId); } catch { /* the task is gone */ }
  };
  // The browser preview has no service: the spec delivers a resume through this seam.
  if (preview) (window as unknown as Record<string, unknown>).__runtimeQueueResume = { resume };
  try { await subscribe('extensions-runtime-queue-resume', resume); } catch { /* no events */ }
}

/** Test seam: forget the started flags so a spec can start the window half again. */
export function resetRuntimeTasksMessages(): void { started = false; mounted = false; }

/** Puts the package name after the text of every queued row a package added. Idempotent: it only touches a row whose chip
 * is missing or out of date, so the queue's own redraws never loop with it. */
export function decorateQueue(root: ParentNode, entries: OriginSnapshot['entries']): number {
  let changed = 0;
  for (const row of root.querySelectorAll<HTMLElement>('.queue-row[data-queue-id]')) {
    const origin = entries[row.dataset.queueId ?? ''];
    const existing = row.querySelector<HTMLElement>('.runtime-queue-origin');
    if (!origin) { if (existing) { existing.remove(); changed += 1; } continue; }
    const label = origin.changedBy ? `${origin.package}, edited by ${origin.changedBy}` : origin.package;
    if (existing && existing.dataset.queueOrigin === origin.owner && existing.textContent === origin.package && existing.title === `Queued by ${label}`) continue;
    existing?.remove();
    const chip = row.ownerDocument.createElement('span');
    chip.className = 'runtime-queue-origin'; chip.dataset.queueOrigin = origin.owner; chip.textContent = origin.package;
    chip.title = `Queued by ${label}`;
    (row.querySelector('.queue-text') ?? row).after(chip);
    changed += 1;
  }
  return changed;
}

let mounted = false;
/** Keeps the queue chips equal to the host's ledger: read now, whenever the native side says it moved, and whenever the
 * queue redraws. A preview window has no service, so its ledger stays empty unless the spec fills it. */
export async function mountMessageOrigins(): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, subscribe, preview } = await import('../bridge');
  await import('./runtime-tasks-messages.css');
  let entries: OriginSnapshot['entries'] = {};
  const paint = () => { decorateQueue(document, entries); };
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; paint(); }); };
  const observer = new MutationObserver(schedule);
  for (const selector of ['#composer-area', '.conversation-pane']) { const node = document.querySelector(selector); if (node) observer.observe(node, { childList: true, subtree: true }); }
  const read = async () => {
    try { entries = (await call<OriginSnapshot>('extensions_runtime_message_origins')).entries; } catch { return; }
    paint();
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeMessageOrigins = { set: (next: OriginSnapshot['entries']) => { entries = next; paint(); } };
  try { await subscribe('extensions-runtime-message-origins', () => { void read(); }); } catch { /* read once below */ }
  await read();
}
