// Ordered, scoped workspace events for background services (`events.workspace`, runtime phase R2, slice R0202).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_events.rs; this file mirrors them with no I/O
// for the browser preview and for the deterministic checks of tests/extensions-runtime-workspace-events.spec.ts.
// Everything here is for predictability and fault isolation, never for trust: envelopes carry ids only, an event of a
// project outside the grant is never queued, at most 256 events wait per service, and on overflow the oldest are
// dropped and one `gap` follows. `sequence` is assigned when an envelope leaves the queue, so a consumer sees every
// number once, in order.

export const QUEUE_LIMIT = 256;
export const PERMISSION = 'events.workspace';
export const KINDS = [
  'task.created', 'task.removed', 'task.shown', 'task.stopped', 'task.idle', 'task.compacted',
  'turn.started', 'turn.finished', 'turn.failed', 'project.opened', 'project.closed', 'settings.changed', 'app.focus',
] as const;
export type WorkspaceEventKind = typeof KINDS[number];
export type Starter = 'user' | 'bot' | 'schedule' | 'team' | { readonly package: string };
export type WorkspaceEvent =
  | { readonly kind: 'task.created'; readonly taskId: string; readonly projectId: string; readonly harness: string; readonly startedBy: Starter }
  | { readonly kind: 'task.removed' | 'task.idle' | 'task.compacted'; readonly taskId: string; readonly projectId: string }
  | { readonly kind: 'task.shown'; readonly windowId: string; readonly taskId: string | null; readonly projectId: string | null }
  | { readonly kind: 'task.stopped'; readonly taskId: string; readonly projectId: string; readonly by: 'user' | { readonly package: string } }
  | { readonly kind: 'turn.started' | 'turn.finished' | 'turn.failed'; readonly taskId: string; readonly projectId: string; readonly index: number }
  | { readonly kind: 'project.opened' | 'project.closed'; readonly projectId: string }
  | { readonly kind: 'settings.changed'; readonly page: string; readonly revision: number }
  | { readonly kind: 'app.focus'; readonly focused: boolean };
export type Envelope = { readonly schemaVersion: 1; readonly kind: WorkspaceEventKind | 'gap'; readonly sequence: number; readonly at: number } & Record<string, unknown>;
export type EventCode = 'InvalidShape' | 'PermissionDenied' | 'HostUnavailable';
export type Published = { queued: number; dropped: number };
/** `project === null` asks whether the package holds the permission at all. */
export type Gate = (owner: string, version: string, project: string | null) => boolean;

type Check = (value: unknown) => boolean;
const identifier: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\p{Cc}/u.test(value);
const nullable: Check = value => value === null || identifier(value);
const natural: Check = value => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const packageOnly = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && identifier((value as Record<string, unknown>).package);
const starter: Check = value => ['user', 'bot', 'schedule', 'team'].includes(value as string) || packageOnly(value);
const stopper: Check = value => value === 'user' || packageOnly(value);
const task: Array<[string, Check]> = [['taskId', identifier], ['projectId', identifier]];
const SHAPES: Record<WorkspaceEventKind, Array<[string, Check]>> = {
  'task.created': [['taskId', identifier], ['projectId', identifier], ['harness', identifier], ['startedBy', starter]],
  'task.removed': task, 'task.idle': task, 'task.compacted': task,
  'task.shown': [['windowId', identifier], ['taskId', nullable], ['projectId', nullable]],
  'task.stopped': [['taskId', identifier], ['projectId', identifier], ['by', stopper]],
  'turn.started': [...task, ['index', natural]], 'turn.finished': [...task, ['index', natural]], 'turn.failed': [...task, ['index', natural]],
  'project.opened': [['projectId', identifier]], 'project.closed': [['projectId', identifier]],
  'settings.changed': [['page', identifier], ['revision', natural]],
  'app.focus': [['focused', value => typeof value === 'boolean']],
};

/** `true` for one of the thirteen kinds or `gap`. */
export const subscribable = (kind: string) => kind === 'gap' || (KINDS as readonly string[]).includes(kind);

/** Checks what the app reports: exactly the fields of the kind, ids only. Answers the kind and its project. */
export function validate(raw: unknown): { kind: WorkspaceEventKind; project: string | null } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const object = raw as Record<string, unknown>;
  const kind = object.kind as WorkspaceEventKind;
  if (typeof kind !== 'string' || !Object.hasOwn(SHAPES, kind)) return null;
  const spec = SHAPES[kind];
  if (Object.keys(object).length !== spec.length + 1 || !spec.every(([name, check]) => Object.hasOwn(object, name) && check(object[name]))) return null;
  return { kind, project: typeof object.projectId === 'string' ? object.projectId : null };
}

interface Queued { kind: WorkspaceEventKind; project: string | null; at: number; body: Record<string, unknown> }
interface Subscription { version: string; generation: number; kinds: Set<string>; queue: Queued[]; dropped: number; droppedAt: number; next: number }

/** Every service's subscription and queue; a service exists here only while its process runs. */
export class WorkspaceEvents {
  private services = new Map<string, Subscription>();
  private gate: Gate | null = null;
  /** Without a gate nothing is delivered. */
  setGate(gate: Gate) { this.gate = gate; }

  attach(owner: string, version: string, generation: number) {
    this.services.set(owner, { version, generation, kinds: new Set(), queue: [], dropped: 0, droppedAt: 0, next: 0 });
  }
  /** A newer generation of the same package is left alone. */
  detach(owner: string, generation: number) { if (this.services.get(owner)?.generation === generation) this.services.delete(owner); }
  listeners(owner: string) { return this.services.get(owner)?.kinds.size ?? 0; }
  pending(owner: string) { return this.services.get(owner)?.queue.length ?? 0; }
  attached() { return this.services.size; }

  subscribe(owner: string, kind: string): EventCode | null {
    if (!subscribable(kind)) return 'InvalidShape';
    const sub = this.services.get(owner);
    if (!sub) return 'HostUnavailable';
    if (!this.gate?.(owner, sub.version, null)) return 'PermissionDenied';
    sub.kinds.add(kind);
    return null;
  }
  /** The last handler of `kind` was disposed; events of it already queued are discarded. */
  unsubscribe(owner: string, kind: string): EventCode | null {
    const sub = this.services.get(owner);
    if (!sub) return 'HostUnavailable';
    sub.kinds.delete(kind);
    sub.queue = sub.queue.filter(queued => queued.kind !== kind);
    return null;
  }

  /** Reports one event; `only` limits it to one package (a package's own settings change). */
  publish(raw: unknown, only: string | null, at: number): Published | { code: 'InvalidShape' } {
    const checked = validate(raw);
    if (!checked) return { code: 'InvalidShape' };
    const { kind: _kind, ...body } = raw as Record<string, unknown>;
    const outcome = { queued: 0, dropped: 0 };
    for (const [owner, sub] of this.services) {
      if ((only !== null && only !== owner) || !sub.kinds.has(checked.kind)) continue;
      if (!this.gate?.(owner, sub.version, checked.project)) continue;
      if (sub.queue.length >= QUEUE_LIMIT) { sub.queue.shift(); sub.dropped += 1; sub.droppedAt = at; outcome.dropped += 1; }
      sub.queue.push({ kind: checked.kind, project: checked.project, at, body });
      outcome.queued += 1;
    }
    return outcome;
  }

  /** The next envelope for `owner`, or `null`. A pending loss comes first, as one `gap` when the service listens to it. */
  nextFrame(owner: string): Envelope | null {
    const sub = this.services.get(owner);
    if (!sub) return null;
    if (sub.dropped > 0) {
      const dropped = sub.dropped; sub.dropped = 0;
      if (sub.kinds.has('gap')) { sub.next += 1; return { schemaVersion: 1, kind: 'gap', sequence: sub.next, at: sub.droppedAt, dropped }; }
    }
    for (let queued = sub.queue.shift(); queued; queued = sub.queue.shift()) {
      if (!sub.kinds.has(queued.kind) || !this.gate?.(owner, sub.version, queued.project)) continue;
      sub.next += 1;
      return { schemaVersion: 1, kind: queued.kind, sequence: sub.next, at: queued.at, ...queued.body };
    }
    return null;
  }
}

/** The host to service frame of one envelope: one way, ordered by the pipe, never answered. */
export const eventFrame = (envelope: Envelope) => ({ event: envelope });
