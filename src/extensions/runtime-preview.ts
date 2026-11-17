// Browser preview of a background service (runtime phase R2, slice R0208).
//
// PREVIEW EVIDENCE, NOT NATIVE: this runner loads a known fixture ES module (a registry the caller hands in, one dynamic
// `import()` per entry: no dynamic code from text of any kind, as the app CSP requires) and gives it a `panda` object
// made only of the browser twins of the native slices, so the observable answers (revisions, grants, failures, the
// order of events, disposal) match the installed service while no native code, process or file is ever reached. A
// package installed natively is qualified by the native tests; everything this file reports carries `column: 'preview'`.
//
// Twins driven here (never copied): runtime-workspace-events (R0202), runtime-content-resources (R0203),
// runtime-usage-resources (R0204), runtime-dynamic-items (R0205), runtime-dialog-navigation (R0206),
// runtime-notifications (R0207). The B1 fake daemon (tests/fixtures/extensions/backends/core/fake-daemon.mjs) is the
// replaced backend: its browser-importable core answers `panda.daemon`. Later namespaces extend `buildPanda` with short
// edits, never a second runner. Everything here is for predictability and fault isolation, never for trust (ADR-0005).
import type { Json } from './contracts';
import type { DialogDefinition } from './dialog-state';
import { DialogSlots, checkReveal, type DialogAnswer, type RevealTarget, type World as RevealWorld } from './runtime-dialog-navigation';
import { DynamicItems, serve as serveItems, type Scope } from './runtime-dynamic-items';
import { Notices, serve as serveNotices, type NoticeSnapshot } from './runtime-notifications';
import { query as queryContent, settingsGet, settingsRevision, type Gate as ContentGate, type SettingsPackage, type Store } from './runtime-content-resources';
import { query as queryUsage, type World as UsageWorld } from './runtime-usage-resources';
import { TaskStarter, PERMISSION as TASKS_START_PERMISSION, type StartWorld } from './runtime-tasks-start';
import { WorkspaceEvents, eventFrame, type Envelope } from './runtime-workspace-events';

/** Every report of this runner is of this column; the receipt keeps preview, native fixtures and installed apart. */
export const COLUMN = 'preview' as const;
export const SERVICE_PERMISSION = 'runtime.service';
export const EVENTS_PERMISSION = 'events.workspace';
export const NOTIFY_PERMISSION = 'ui.notify';
export const DYNAMIC_PERMISSION = 'ui.dynamic';

export type ServiceState = 'stopped' | 'running' | 'failed';
export type StopReason = 'stop' | 'disable' | 'trust' | 'safeMode' | 'update' | 'failed';

/** What a service module exports: the same `service(panda, lifetime)` entry the native host calls. */
export interface ServiceModule { service?: (panda: PreviewPanda, lifetime: PreviewLifetime) => unknown }
/** The known fixture modules, by the manifest's `runtime.entrypoint`. Nothing outside this table can run. */
export type Loaders = Readonly<Record<string, () => Promise<ServiceModule>>>;

/** The failure a rejected call raises in the service: the same `code` the native envelope carries. */
export class PandaError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PandaError'; }
}

export interface PreviewLifetime {
  /** Registers cleanup that runs when the service stops, newest first; a throwing cleanup never blocks the rest. */
  onStop(cleanup: () => void | Promise<void>): void;
  setStatus(status: { text?: string; tone?: string }): void;
  readonly stopped: Promise<StopReason>;
}

type Disposer = () => void;
/** What a command handler of the service receives: the same two fields the native duplex channel hands over. */
export type CommandHandler = (context: { commandId: string; args: unknown }) => unknown;
export interface PreviewPanda {
  /** The package's own `runCommand` commands, answered inside the service (R0201's duplex channel in the preview). */
  readonly commands: { register(id: string, handler: CommandHandler): { dispose(): void } };
  readonly settings: { get(params: unknown): Promise<unknown> };
  readonly events: { on(kind: string, handler: (envelope: Envelope) => void): Disposer };
  readonly context: { query(params: unknown): Promise<unknown> };
  readonly usage: { query(params: unknown): Promise<unknown> };
  readonly ui: {
    notify(notice: unknown): Promise<unknown>;
    withdraw(key: string): Promise<null>;
    register(item: unknown): Promise<{ id: string }>;
    update(id: string, patch: unknown): Promise<null>;
    updateView(id: string, patch: unknown): Promise<null>;
    dispose(id: string): Promise<null>;
    showDialog(dialog: DialogDefinition): Promise<DialogAnswer>;
    reveal(target: unknown): Promise<null>;
  };
  /** `panda.tasks.start` (R0401): refusals are the frozen ones and create no task. */
  readonly tasks: { start(options: unknown): Promise<unknown> };
  readonly daemon: {
    request(op: string, params?: unknown): Promise<unknown>;
    subscribe(topic: string, handler: (frame: { event: string; seq: number; data: unknown }) => void): Promise<Disposer>;
  };
}

/** The shape of B1's browser-importable core (`createDaemon`): the preview never sees more than this. */
export interface DaemonCore {
  request(op: string, params?: Record<string, unknown>): unknown;
  control(path: string, params?: Record<string, unknown>): unknown;
}
export type DaemonFactory = (emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => void) => DaemonCore;

/** Grants the host holds for the package: a permission maps to every project (`true`) or to the projects it covers. */
export type Grants = Map<string, true | ReadonlySet<string>>;

export interface PreviewManifest {
  id: string; version: string; name?: string;
  runtime?: { kind?: string; entrypoint?: string; service?: { start?: string } };
  contributes?: Record<string, { id?: string; command?: string }[] | undefined>;
}

export interface PreviewOptions {
  manifest: PreviewManifest;
  loaders: Loaders;
  grants: Grants;
  /** Injected clock (ms). Defaults to a counter the caller advances with `tick`. */
  now?: () => number;
  settings?: SettingsPackage[];
  store?: Store;
  usage?: UsageWorld;
  daemon?: DaemonFactory;
  reveal?: Pick<RevealWorld, 'views' | 'settingsPages' | 'taskExists' | 'projectDir' | 'fileExists'>;
  /** The world a `tasks.start` runs in (projects, catalog, worktrees, paired targets); absent: every start is `UnsupportedCapability`. */
  tasksStart?: StartWorld;
  scopes?: { tasks: readonly string[]; projects: readonly string[] };
  enabled?: boolean;
  safeMode?: boolean;
}

export type Step = { column: typeof COLUMN; at: number; step: string; code?: string; detail?: string };
const NO_STORE: Store = { tasks: [], messages: [], changes: [], revision: 0 };
const NO_USAGE: UsageWorld = { tasks: [], ledger: [], readings: {}, connectionReadings: {}, connections: [], app: {}, services: [] };

const isFailure = (value: unknown): value is { code: string } => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string' && !('ok' in value) && Object.keys(value).length === 1;
const unwrap = <T>(reply: { ok: true; value: T } | { ok: false; error: { code: string } }): T => { if (!reply.ok) throw new PandaError(reply.error.code); return reply.value; };

export class RuntimePreview {
  readonly column = COLUMN;
  readonly events = new WorkspaceEvents();
  readonly notices = new Notices();
  readonly items = new DynamicItems();
  readonly dialogs = new DialogSlots();
  readonly starter: TaskStarter | null;
  readonly steps: Step[] = [];
  readonly revealed: RevealTarget[] = [];
  readonly status: { text?: string; tone?: string } = {};
  readonly faults: string[] = [];
  state: ServiceState = 'stopped';
  stopReason: StopReason | null = null;
  starts = 0;
  private generation = 0;
  private clock = 0;
  private cleanups: Array<() => void | Promise<void>> = [];
  private commandHandlers = new Map<string, CommandHandler>();
  private handlers = new Map<string, Set<(envelope: Envelope) => void>>();
  private topics = new Map<string, Set<(frame: { event: string; seq: number; data: unknown }) => void>>();
  private daemonCore: DaemonCore | null = null;
  private ended: ((reason: StopReason) => void) | null = null;
  private grantsMap: Grants;
  private options: PreviewOptions;

  constructor(options: PreviewOptions) {
    this.options = options;
    this.grantsMap = options.grants;
    this.starter = options.tasksStart ? new TaskStarter(options.tasksStart) : null;
    this.events.setGate((_owner, _version, project) => this.holds(EVENTS_PERMISSION, project));
  }

  get owner() { return this.options.manifest.id; }
  private get version() { return this.options.manifest.version; }
  private get packageName() { return this.options.manifest.name ?? this.options.manifest.id; }
  private now() { return this.options.now ? this.options.now() : this.clock; }
  /** Advances the default clock (ignored with an injected one). */
  tick(ms: number) { this.clock += ms; return this.clock; }
  private step(step: string, code?: string, detail?: string) { this.steps.push({ column: COLUMN, at: this.now(), step, ...(code ? { code } : {}), ...(detail ? { detail } : {}) }); }

  /** Does the package hold `permission` (for `project`; `null` asks whether it holds it at all)? Rechecked on every call. */
  holds(permission: string, project: string | null = null): boolean {
    if (this.options.safeMode || this.options.enabled === false) return false;
    const grant = this.grantsMap.get(permission);
    if (!grant) return false;
    return grant === true || project === null || grant.has(project);
  }
  private gate: ContentGate = (_owner, _version, permission, project) => this.holds(permission, project);

  // ---- grants ---------------------------------------------------------------------------------------------------

  /** The user revokes a permission (or narrows it to projects). The service keeps running unless it needs the permission. */
  async revoke(permission: string, keep?: ReadonlySet<string>): Promise<void> {
    if (keep) this.grantsMap.set(permission, keep); else this.grantsMap.delete(permission);
    this.step('revoke', undefined, permission);
    if (permission === SERVICE_PERMISSION && !this.holds(SERVICE_PERMISSION)) { await this.stop('trust'); return; }
    this.sweep();
  }
  grant(permission: string, to: true | ReadonlySet<string> = true) { this.grantsMap.set(permission, to); this.step('grant', undefined, permission); }
  /** Disable, enable and safe mode follow the same rule as the native owner: a service never outlives its package state. */
  async setEnabled(enabled: boolean): Promise<void> { this.options.enabled = enabled; if (!enabled) await this.stop('disable'); }
  async setSafeMode(on: boolean): Promise<void> { this.options.safeMode = on; if (on) await this.stop('safeMode'); }
  /** Drops what a permission the package no longer holds had produced. */
  private sweep() {
    if (!this.holds(NOTIFY_PERMISSION)) this.notices.sweep(() => false, 'revoked-or-disabled');
    if (!this.holds(DYNAMIC_PERMISSION)) { this.items.clear(this.owner); this.dialogs.cancelOwner(this.owner); }
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  /** Loads the entrypoint's registered module and runs its `service`. Never throws: a failure is the answer. */
  async start(): Promise<{ ok: true } | { ok: false; code: string }> {
    if (this.state === 'running') return { ok: false, code: 'Conflict' };
    const manifest = this.options.manifest;
    if (this.options.safeMode || this.options.enabled === false) return this.fail('HostUnavailable');
    if (!this.holds(SERVICE_PERMISSION)) return this.fail('PermissionDenied');
    if (manifest.runtime?.service?.start !== 'onEnable') return this.fail('UnsupportedCapability');
    const loader = manifest.runtime?.entrypoint === undefined ? undefined : Object.hasOwn(this.options.loaders, manifest.runtime.entrypoint) ? this.options.loaders[manifest.runtime.entrypoint] : undefined;
    if (!loader) return this.fail('NotFound');
    let module: ServiceModule;
    try { module = await loader(); } catch { return this.fail('HostUnavailable'); }
    if (typeof module.service !== 'function') return this.fail('InvalidShape');
    this.generation += 1;
    this.starts += 1;
    this.state = 'running'; this.stopReason = null;
    this.events.attach(this.owner, this.version, this.generation);
    this.daemonCore = this.options.daemon ? this.options.daemon((topic, frame) => this.topics.get(topic)?.forEach(handler => this.safely(() => handler(frame)))) : null;
    const stopped = new Promise<StopReason>(resolve => { this.ended = resolve; });
    const lifetime: PreviewLifetime = { onStop: cleanup => { this.cleanups.push(cleanup); }, setStatus: status => { Object.assign(this.status, status); }, stopped };
    this.step('start');
    try { await module.service(this.buildPanda(), lifetime); } catch (error) {
      const code = error instanceof PandaError ? error.code : 'HostUnavailable';
      await this.stop('failed');
      this.state = 'failed';
      this.step('failed', code);
      return { ok: false, code };
    }
    return { ok: true };
  }
  private fail(code: string): { ok: false; code: string } { this.step('refused', code); return { ok: false, code }; }

  /** Disposes everything the service produced, in order: calls, events, dialogs, items, notices, topics, then its own cleanups. */
  async stop(reason: StopReason = 'stop'): Promise<boolean> {
    if (this.state !== 'running') return false;
    this.state = 'stopped'; this.stopReason = reason;
    this.events.detach(this.owner, this.generation);
    this.handlers.clear(); this.topics.clear(); this.commandHandlers.clear();
    this.dialogs.cancelOwner(this.owner);
    this.items.clear(this.owner);
    this.notices.clear(this.owner, `service-${reason}`);
    this.daemonCore = null;
    for (const cleanup of this.cleanups.reverse()) { try { await cleanup(); } catch (error) { this.faults.push(String(error)); } }
    this.cleanups = [];
    this.ended?.(reason); this.ended = null;
    this.step('stop', undefined, reason);
    return true;
  }

  private safely(run: () => void) { try { run(); } catch (error) { this.faults.push(String(error)); } }

  // ---- host side ------------------------------------------------------------------------------------------------

  /** The app reports one event: queued under the native rules (gate, bound, kinds), then delivered in order. */
  publish(raw: unknown, only: string | null = null): { queued: number; dropped: number } | { code: 'InvalidShape' } {
    const outcome = this.events.publish(raw, only, this.now());
    this.pump();
    return outcome;
  }
  /** Delivers queued frames to the service's handlers; a throwing handler is recorded and never stops the others. */
  private pump() {
    for (let envelope = this.events.nextFrame(this.owner); envelope; envelope = this.events.nextFrame(this.owner)) {
      const frame = eventFrame(envelope).event;
      this.step('event', undefined, `${frame.kind}#${frame.sequence}`);
      for (const handler of [...(this.handlers.get(frame.kind) ?? [])]) this.safely(() => handler(frame));
    }
  }
  /** The user saves a settings page: the stored values change, the revision follows, and only this package hears of it. */
  setSettings(page: string, values: Record<string, Json>) {
    const pack = this.options.settings?.find(item => item.id === this.owner);
    if (!pack) return null;
    pack.stored[page] = values;
    const revision = settingsRevision(values);
    this.publish({ kind: 'settings.changed', page, revision }, this.owner);
    return revision;
  }
  /** The workspace changed (a message, a task): resource revisions move, so a held cursor goes stale. */
  touchStore() { const store = this.options.store; if (store) store.revision += 1; return store?.revision ?? 0; }
  /** A click on a menu item, a table row or a shortcut of one of the package's commands: runs the handler the service registered. */
  async invoke(id: string, args: unknown = null): Promise<unknown> {
    this.requireRunning();
    const handler = this.commandHandlers.get(id);
    if (!handler) { this.step('command', 'NotFound', id); throw new PandaError('NotFound'); }
    this.step('command', undefined, id);
    return handler({ commandId: id, args });
  }
  /** The interface answers the dialog the service asked for. */
  answerDialog(id: string, answer: unknown) { return this.dialogs.answer(id, answer); }
  dismissNotice(key: string) { return this.notices.dismiss(this.owner, key); }
  noticeSnapshot(): NoticeSnapshot { return this.notices.snapshot(); }
  /** The host's live layer (what the interface would merge into the manifest snapshot). */
  layer() { return this.items.snapshot(); }
  /** Pushes a B1 control (signal, issue edits) through the replaced backend. */
  daemonControl(path: string, params: Record<string, unknown> = {}) { return this.daemonCore?.control(path, params) ?? null; }

  // ---- the service's panda --------------------------------------------------------------------------------------

  private requireRunning() { if (this.state !== 'running') throw new PandaError('HostUnavailable'); }
  private call<T>(name: string, run: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try { this.requireRunning(); const value = run(); this.step(name); resolve(value); } catch (error) { this.step(name, error instanceof PandaError ? error.code : 'HostUnavailable'); reject(error); }
    });
  }
  private checks() {
    const scopes = this.options.scopes ?? { tasks: [], projects: [] };
    return {
      granted: this.holds(DYNAMIC_PERMISSION),
      manifest: { contributes: this.options.manifest.contributes },
      scopeExists: (scope: Scope) => ('taskId' in scope ? scopes.tasks.includes(scope.taskId) : scopes.projects.includes(scope.projectId)),
      version: this.version, nowMs: this.now(),
    };
  }
  private buildPanda(): PreviewPanda {
    const owner = this.owner;
    const out = <T>(value: T | { code: string }): T => { if (isFailure(value)) throw new PandaError(value.code); return value as T; };
    const world: Required<PreviewOptions>['reveal'] = this.options.reveal ?? { views: [], settingsPages: [], taskExists: () => false, projectDir: () => null, fileExists: () => false };
    const subscribe = (topic: string, handler: (frame: { event: string; seq: number; data: unknown }) => void): Disposer => {
      let set = this.topics.get(topic);
      if (!set) { set = new Set(); this.topics.set(topic, set); }
      set.add(handler);
      return () => { set.delete(handler); };
    };
    return {
      commands: { register: (id, handler) => {
        this.requireRunning();
        const own = (this.options.manifest.contributes?.commands ?? []).some(entry => entry.id === id);
        const code = !own ? 'UnknownReference' : this.commandHandlers.has(id) ? 'Conflict' : null;
        if (code) { this.step('commands.register', code, id); throw new PandaError(code); }
        this.commandHandlers.set(id, handler);
        this.step('commands.register', undefined, id);
        return { dispose: () => { if (this.commandHandlers.get(id) === handler) this.commandHandlers.delete(id); } };
      } },
      // A package reads its own settings page with no permission, as native does; the page must exist and be enabled.
      settings: { get: params => this.call('settings.get', () => out(settingsGet(this.options.settings ?? [], owner, params))) },
      events: { on: (kind, handler) => {
        this.requireRunning();
        const code = this.events.subscribe(owner, kind);
        if (code) { this.step('events.on', code); throw new PandaError(code); }
        let set = this.handlers.get(kind);
        if (!set) { set = new Set(); this.handlers.set(kind, set); }
        set.add(handler);
        this.step('events.on', undefined, kind);
        return () => { set.delete(handler); if (set.size === 0) { this.handlers.delete(kind); this.events.unsubscribe(owner, kind); } };
      } },
      context: { query: params => this.call('context.query', () => out(queryContent(this.gate, this.options.store ?? NO_STORE, owner, this.version, params))) },
      usage: { query: params => this.call('usage.query', () => out(queryUsage(this.gate, this.options.usage ?? NO_USAGE, owner, this.version, params))) },
      ui: {
        notify: notice => this.call('ui.notify', () => unwrap(serveNotices(this.notices, owner, { granted: this.holds(NOTIFY_PERMISSION), package: this.packageName, nowMs: this.now() }, { op: 'notify', notice }))),
        withdraw: key => this.call('ui.withdraw', () => unwrap(serveNotices(this.notices, owner, { granted: this.holds(NOTIFY_PERMISSION), package: this.packageName, nowMs: this.now() }, { op: 'withdraw', key })) as null),
        register: item => this.call('ui.register', () => unwrap(serveItems(this.items, owner, this.checks(), { op: 'register', item })) as { id: string }),
        update: (id, patch) => this.call('ui.update', () => unwrap(serveItems(this.items, owner, this.checks(), { op: 'update', id, patch })) as null),
        updateView: (id, patch) => this.call('ui.updateView', () => unwrap(serveItems(this.items, owner, this.checks(), { op: 'updateView', id, patch })) as null),
        dispose: id => this.call('ui.dispose', () => unwrap(serveItems(this.items, owner, this.checks(), { op: 'dispose', id })) as null),
        showDialog: async dialog => {
          this.requireRunning();
          if (!this.holds(DYNAMIC_PERMISSION)) { this.step('ui.showDialog', 'PermissionDenied'); throw new PandaError('PermissionDenied'); }
          const begun = this.dialogs.begin(owner, dialog);
          if (!begun.ok) { this.step('ui.showDialog', begun.error.code); throw new PandaError(begun.error.code); }
          this.step('ui.showDialog', undefined, begun.value.id);
          return begun.value.answer;
        },
        reveal: target => this.call('ui.reveal', () => {
          const checked = unwrap(checkReveal(owner, { granted: this.holds(DYNAMIC_PERMISSION), ...world }, target)) as RevealTarget;
          this.revealed.push(checked);
          return null;
        }),
      },
      tasks: { start: options => this.call('tasks.start', () => {
        if (!this.starter) throw new PandaError('UnsupportedCapability');
        return unwrap(this.starter.start(owner, { granted: project => this.holds(TASKS_START_PERMISSION, project), package: this.packageName }, options));
      }) },
      daemon: {
        request: (op, params) => this.call('daemon.request', () => {
          if (!this.daemonCore) throw new PandaError('HostUnavailable');
          try { return this.daemonCore.request(op, (params ?? {}) as Record<string, unknown>); } catch (error) { throw new PandaError((error as { code?: string }).code ?? 'HostUnavailable'); }
        }),
        subscribe: async (topic, handler) => {
          await this.call('daemon.subscribe', () => {
            if (!this.daemonCore) throw new PandaError('HostUnavailable');
            try { this.daemonCore.request('subscribe', { topic }); } catch (error) { throw new PandaError((error as { code?: string }).code ?? 'HostUnavailable'); }
          });
          return subscribe(topic, handler);
        },
      },
    };
  }
}

export const createRuntimePreview = (options: PreviewOptions) => new RuntimePreview(options);

/** How a report of this runner is labelled in the receipt: preview, never native or installed. */
export const evidenceLabel = (): { column: typeof COLUMN; native: false; installed: false; note: string } => ({ column: COLUMN, native: false, installed: false, note: 'Browser preview of a fixture module with replaced backends; native installation is qualified by the native tests.' });
