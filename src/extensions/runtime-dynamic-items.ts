// Scoped live contributions of background services (`ui.dynamic`, runtime phase R2, slice R0205).
//
// The native rules live in src-tauri/src/extensions/runtime_dynamic_items.rs; this file mirrors them with no I/O for the
// browser preview and the deterministic checks of tests/extensions-runtime-dynamic-items.spec.ts, and it is also what the
// interface runs: `mergeLayer` lays the run-time layer the host sends over the manifest snapshot (manager.ts), so every
// host that reads `extensionsSnapshot()` and the catalog see live items, and `shown` decides which scoped item a window
// shows. Everything here is for predictability and fault isolation, never for trust (ADR-0005).
import { validateContract, type Json } from './contracts';
import type { ExtensionSnapshot } from './manager';

export const PERMISSION = 'ui.dynamic';
export const MAX_ITEMS = 128;
export const MAX_UPDATES_PER_SECOND = 20;
export const MARKS_LOCATION = 'panda.sidebar.task.marks';
export const PATCH_FIELDS = ['text', 'badge', 'icon', 'tone', 'tooltip', 'progress', 'enabled', 'visible', 'args', 'items', 'title', 'controls', 'toolbar'] as const;
export const VIEW_FIELDS = ['title', 'text', 'controls', 'toolbar'] as const;
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
const ARGS_BYTES = 4096, TOOLTIP_CHARS = 1024;

export type Scope = { taskId: string } | { projectId: string };
export type Kind = 'menu' | 'command' | 'view' | 'slashCommand';
type Definition = Record<string, Json>;
export type OwnerLayer = { menus: Definition[]; commands: Definition[]; views: Definition[]; slashCommands: Definition[]; overrides: Record<string, Definition> };
export type Layer = { revision: number; owners: Record<string, OwnerLayer> };
export type Shown = { taskId: string | null; projectId: string | null };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: '$'; ids: [] } };

/** What the app answers about the world; the spec gives fixed answers. */
export type Checks = { granted: boolean; manifest: { contributes?: Record<string, { id?: string; command?: string }[] | undefined> }; scopeExists: (scope: Scope) => boolean; version: string; nowMs: number };

const BUCKET: Record<Kind, 'menus' | 'commands' | 'views' | 'slashCommands'> = { menu: 'menus', command: 'commands', view: 'views', slashCommand: 'slashCommands' };
const KINDS = Object.keys(BUCKET) as Kind[];
const failure = (code: string): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code, path: '$', ids: [] } });
const record = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const owns = (owner: string, id: string) => id.startsWith(`${owner}/`) && id.length > owner.length + 1;
const bytes = (value: Json) => new TextEncoder().encode(JSON.stringify(value)).length;

export function parseScope(raw: unknown): Scope | null {
  if (!record(raw) || Object.keys(raw).length !== 1) return null;
  if (identifier(raw.taskId)) return { taskId: raw.taskId };
  if (identifier(raw.projectId)) return { projectId: raw.projectId };
  return null;
}
const sameScope = (a?: Scope, b?: Scope) => JSON.stringify(a) === JSON.stringify(b);

/** `tone`, `tooltip`, `progress`, `args`, `enabled`, `visible`: the shapes shared by registrations and patches. */
function checkFields(object: Record<string, Json>): string | null {
  for (const [key, value] of Object.entries(object)) {
    if (key === 'tone' && value !== null && !(TONES as readonly string[]).includes(value as string)) return 'InvalidShape';
    if (key === 'tooltip' && value !== null) { if (typeof value !== 'string') return 'InvalidShape'; if ([...value].length > TOOLTIP_CHARS) return 'LimitExceeded'; }
    if (key === 'progress' && value !== null && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100)) return 'InvalidShape';
    if (key === 'args' && value !== null && bytes(value) > ARGS_BYTES) return 'LimitExceeded';
    if ((key === 'enabled' || key === 'visible') && !(value === null || typeof value === 'boolean' || record(value))) return 'InvalidShape';
  }
  return null;
}

/** The same validators the manifest goes through, for one definition owned by `owner`. */
function validate(kind: Kind, owner: string, checks: Checks, definition: Definition): string | null {
  const registration = { extensionId: owner, version: checks.version, activationId: 'runtime-item' };
  const result = kind === 'menu' ? validateContract('contribution', { schemaVersion: 1, owner: registration, definition })
    : kind === 'command' ? validateContract('command', { schemaVersion: 1, owner: registration, definition, capability: 'ui.contribute', contexts: ['project'], inputSchema: { type: 'null' }, outputSchema: { type: 'null' } })
    : validateContract(kind === 'view' ? 'view' : 'slashCommand', definition);
  return result.ok ? null : result.error.code;
}

/** The effective value of a declared definition with its overrides: `null` clears a field. */
export function effective(declared: Definition, overrides?: Definition): Definition {
  const value: Definition = { ...declared };
  for (const [key, patch] of Object.entries(overrides ?? {})) { if (patch === null) delete value[key]; else value[key] = patch; }
  return value;
}

interface Item { kind: Kind; declared: Definition; scope?: Scope }
interface OwnerState { items: Map<string, Item>; overrides: Map<string, Definition>; window: number[]; pending: Map<string, Definition> }

/** Every owner's run-time layer; an owner exists here only while its service runs. */
export class DynamicItems {
  private owners = new Map<string, OwnerState>();
  private revision_ = 0;
  revision() { return this.revision_; }
  count(owner: string) { return this.owners.get(owner)?.items.size ?? 0; }
  pending(owner: string) { return this.owners.get(owner)?.pending.size ?? 0; }
  private state(owner: string): OwnerState {
    let state = this.owners.get(owner);
    if (!state) { state = { items: new Map(), overrides: new Map(), window: [], pending: new Map() }; this.owners.set(owner, state); }
    return state;
  }

  /** `panda.ui.register`: answers `{ id }`. */
  register(owner: string, checks: Checks, raw: unknown): Reply<{ id: string }> {
    if (!checks.granted) return failure('PermissionDenied');
    if (!record(raw)) return failure('InvalidShape');
    const kind = raw.kind as Kind;
    if (!KINDS.includes(kind) || !identifier(raw.id)) return failure('InvalidShape');
    const id = raw.id;
    if (!owns(owner, id)) return failure('PermissionDenied');
    const scope = raw.scope === undefined ? undefined : parseScope(raw.scope);
    if (scope === null) return failure('InvalidShape');
    const { kind: _kind, scope: _scope, ...definition } = raw;
    const bad = checkFields(definition);
    if (bad) return failure(bad);
    if (['enabled', 'visible'].some(key => definition[key] === null)) return failure('InvalidShape');
    const all = Object.values(checks.manifest.contributes ?? {}).flatMap(list => list ?? []);
    if (all.some(entry => entry.id === id)) return failure('Conflict');
    const state = this.state(owner);
    if (kind === 'menu') {
      const command = String(definition.command ?? '');
      const known = (checks.manifest.contributes?.commands ?? []).some(entry => entry.id === command) || state.items.get(command)?.kind === 'command';
      if (!known) return failure('UnknownReference');
    }
    const invalid = validate(kind, owner, checks, definition);
    if (invalid) return failure(invalid);
    if (scope && !checks.scopeExists(scope)) return failure('NotFound');
    if (state.items.has(id)) return failure('Conflict');
    if (state.items.size >= MAX_ITEMS) return failure('LimitExceeded');
    state.items.set(id, { kind, declared: definition, scope });
    this.revision_ += 1;
    return { ok: true, value: { id } };
  }

  /** `RuntimeItem.update` and `panda.ui.update`: a live item of the owner, or an item of its own manifest. */
  update(owner: string, checks: Checks, id: string, patch: unknown): Reply<null> { return this.change(owner, checks, id, patch, false); }
  /** `panda.ui.updateView`: `title`, `text`, `controls` and `toolbar` of a view of the owner. */
  updateView(owner: string, checks: Checks, id: string, patch: unknown): Reply<null> { return this.change(owner, checks, id, patch, true); }

  private target(owner: string, checks: Checks, id: string): { kind: Kind; declared: Definition } | null {
    const live = this.owners.get(owner)?.items.get(id);
    if (live) return live;
    for (const [bucket, kind] of [['menus', 'menu'], ['views', 'view']] as const) {
      const found = (checks.manifest.contributes?.[bucket] ?? []).find(entry => entry.id === id);
      if (found) return { kind, declared: found as Definition };
    }
    return null;
  }
  private static fold(overrides: Definition, patch: Definition) {
    for (const [key, value] of Object.entries(patch)) { if (value === null && (key === 'enabled' || key === 'visible')) delete overrides[key]; else overrides[key] = value; }
  }
  private change(owner: string, checks: Checks, id: string, patch: unknown, viewOnly: boolean): Reply<null> {
    if (!checks.granted) return failure('PermissionDenied');
    if (!record(patch) || Object.keys(patch).length === 0) return failure('InvalidShape');
    const bad = checkFields(patch);
    if (bad) return failure(bad);
    if (!owns(owner, id)) return failure('PermissionDenied');
    const found = this.target(owner, checks, id);
    if (!found) return failure('NotFound');
    const allowed: readonly string[] = found.kind === 'view' ? VIEW_FIELDS : PATCH_FIELDS;
    if ((viewOnly && found.kind !== 'view') || !['menu', 'view'].includes(found.kind) || Object.keys(patch).some(key => !allowed.includes(key))) return failure('InvalidShape');
    const state = this.state(owner);
    state.window = state.window.filter(at => checks.nowMs - at < 1000);
    // Past 20 applied updates in a second the latest value of each field waits for room.
    if (state.window.length >= MAX_UPDATES_PER_SECOND) { state.pending.set(id, { ...(state.pending.get(id) ?? {}), ...patch }); return { ok: true, value: null }; }
    const overrides = { ...(state.overrides.get(id) ?? {}) };
    DynamicItems.fold(overrides, patch);
    const invalid = validate(found.kind, owner, checks, effective(found.declared, overrides));
    if (invalid) return failure(invalid);
    state.window.push(checks.nowMs);
    state.overrides.set(id, overrides);
    this.revision_ += 1;
    return { ok: true, value: null };
  }

  /** Applies the updates that waited for room in the rate window. Answers `true` when something changed. */
  tick(owner: string, checks: Checks): boolean {
    const state = this.owners.get(owner);
    if (!state) return false;
    state.window = state.window.filter(at => checks.nowMs - at < 1000);
    let changed = false;
    while (state.window.length < MAX_UPDATES_PER_SECOND && state.pending.size) {
      const [id, patch] = state.pending.entries().next().value as [string, Definition];
      state.pending.delete(id);
      const found = this.target(owner, checks, id);
      if (!found) continue;
      const overrides = { ...(state.overrides.get(id) ?? {}) };
      DynamicItems.fold(overrides, patch);
      if (validate(found.kind, owner, checks, effective(found.declared, overrides))) continue;
      state.window.push(checks.nowMs);
      state.overrides.set(id, overrides);
      changed = true;
    }
    if (changed) this.revision_ += 1;
    return changed;
  }

  /** `RuntimeItem.dispose`: a handle that is gone answers `NotFound`, never a second success. */
  dispose(owner: string, checks: Checks, id: string): Reply<null> {
    if (!checks.granted) return failure('PermissionDenied');
    if (!owns(owner, id)) return failure('PermissionDenied');
    const state = this.owners.get(owner);
    if (!state?.items.delete(id)) return failure('NotFound');
    state.overrides.delete(id); state.pending.delete(id);
    this.revision_ += 1;
    return { ok: true, value: null };
  }

  /** The service stopped (disable, uninstall, update, trust loss, safe mode, crash): the manifest values return. */
  clear(owner: string) { if (this.owners.delete(owner)) this.revision_ += 1; }
  /** A task or project is gone: the items bound to it go with it. Answers how many were removed. */
  forgetScope(gone: Scope): number {
    let removed = 0;
    for (const state of this.owners.values()) {
      for (const [id, item] of [...state.items]) if (sameScope(item.scope, gone)) { state.items.delete(id); state.overrides.delete(id); state.pending.delete(id); removed += 1; }
    }
    if (removed) this.revision_ += 1;
    return removed;
  }

  /** The host's layer: per owner each kind's effective definitions (with `scope`) and the manifest items' overrides. */
  snapshot(): Layer {
    const owners: Record<string, OwnerLayer> = {};
    for (const [owner, state] of this.owners) {
      const entry: OwnerLayer = { menus: [], commands: [], views: [], slashCommands: [], overrides: {} };
      for (const [id, item] of state.items) entry[BUCKET[item.kind]].push({ ...effective(item.declared, state.overrides.get(id)), ...(item.scope ? { scope: item.scope } : {}) });
      for (const [id, overrides] of state.overrides) if (!state.items.has(id)) entry.overrides[id] = overrides;
      owners[owner] = entry;
    }
    return { revision: this.revision_, owners };
  }
}

/** A `ui` request of a service: `{ op: 'register' | 'update' | 'updateView' | 'dispose', ... }`. Answers the broker envelope. */
export function serve(items: DynamicItems, owner: string, checks: Checks, params: { op?: string; id?: string; item?: unknown; patch?: unknown }): Reply {
  const id = typeof params.id === 'string' ? params.id : '';
  switch (params.op) {
    case 'register': return items.register(owner, checks, params.item);
    case 'update': return items.update(owner, checks, id, params.patch);
    case 'updateView': return items.updateView(owner, checks, id, params.patch);
    case 'dispose': return items.dispose(owner, checks, id);
    default: return failure('InvalidShape');
  }
}

// ---- The interface: the host's layer over the manifest snapshot -------------------------------------------------

/** Where a window is looking. A scoped item shows only where its task or project is in view; a mark of a task shows on
 * that task's row (the sidebar places it by `scope`), whatever task the window shows. */
export function scopeVisible(item: Definition, shown: Shown): boolean {
  const scope = parseScope(item.scope);
  if (!scope) return true;
  if (item.location === MARKS_LOCATION) return true;
  return 'taskId' in scope ? shown.taskId === scope.taskId : shown.projectId === scope.projectId;
}

/** The manifest snapshot with the host's run-time layer laid over it: live items appended (a scoped one only where its
 * scope is in view), overrides applied to the manifest items of the owner, `scope` kept for the hosts that place by it.
 * Only an enabled package with a layer changes; with no layer the snapshot is returned as it is. */
export function mergeLayer<T extends ExtensionSnapshot>(value: T, layer: Layer | null, shown: Shown): T {
  if (!layer || value.safeMode || !Object.keys(layer.owners).length) return value;
  const packages = value.packages.map(item => {
    const owned = item.enabled ? layer.owners[item.manifest.id] : undefined;
    if (!owned) return item;
    const contributes: Record<string, unknown> = { ...item.manifest.contributes };
    const lay = (bucket: 'menus' | 'commands' | 'views' | 'slashCommands') => {
      const own = ((contributes[bucket] ?? []) as Definition[]).map(entry => typeof entry.id === 'string' && owned.overrides[entry.id] ? effective(entry, owned.overrides[entry.id]) : entry);
      const live = owned[bucket].filter(entry => scopeVisible(entry, shown));
      if (own.length || live.length) contributes[bucket] = [...own, ...live];
    };
    for (const bucket of ['menus', 'commands', 'views', 'slashCommands'] as const) lay(bucket);
    return { ...item, manifest: { ...item.manifest, contributes } } as typeof item;
  });
  return { ...value, packages };
}

let layer: Layer | null = null;
let shown: Shown = { taskId: null, projectId: null };
const changes = new Set<() => void>();
/** The host's layer (`extensions_runtime_items`), or `null` when no service has items. */
export function setRuntimeLayer(next: Layer | null) { layer = next && Object.keys(next.owners).length ? next : null; changes.forEach(listener => listener()); }
export function runtimeLayer(): Layer | null { return layer; }
/** The task and project this window shows (`task.shown`); a scoped item follows it. */
export function setShown(taskId: string | null, projectId: string | null) {
  if (shown.taskId === taskId && shown.projectId === projectId) return;
  shown = { taskId, projectId };
  changes.forEach(listener => listener());
}
export const shownNow = (): Shown => shown;
export function onRuntimeLayerChanged(listener: () => void): () => void { changes.add(listener); return () => { changes.delete(listener); }; }
/** What a window applies to a snapshot now. */
export const withRuntimeLayer = <T extends ExtensionSnapshot>(value: T): T => mergeLayer(value, layer, shown);

export type Mark = { owner: string; id: string; text: string; tone: string; title: string; progress?: number; command?: string };
/** The marks of one task row (`panda.sidebar.task.marks`, `presentation: "badge"`): items scoped to that task, to its
 * project, or to nothing (shown on every row). A condition that resolved to `false` hides the mark. The title carries
 * the package id, so everything an extension shows is labelled with its name. */
export function taskMarks(taskId: string, projectId: string | null, source: Layer | null = layer): Mark[] {
  const marks: Mark[] = [];
  for (const [owner, owned] of Object.entries(source?.owners ?? {})) {
    for (const menu of owned.menus) {
      if (menu.location !== MARKS_LOCATION || menu.visible === false) continue;
      const scope = parseScope(menu.scope);
      if (scope && ('taskId' in scope ? scope.taskId !== taskId : scope.projectId !== projectId)) continue;
      const text = String(menu.badge ?? menu.text ?? '');
      if (!text) continue;
      const detail = typeof menu.tooltip === 'string' ? menu.tooltip : text;
      marks.push({ owner, id: String(menu.id), text, tone: typeof menu.tone === 'string' ? menu.tone : 'neutral', title: `${owner}: ${detail}`, ...(typeof menu.progress === 'number' ? { progress: menu.progress } : {}), ...(typeof menu.command === 'string' ? { command: menu.command } : {}) });
    }
  }
  return marks;
}

/** The `args` a click hands to the command: those of the effective item (live or manifest) with that id. */
export function itemArgs(snapshot: ExtensionSnapshot, id: string): Json | undefined {
  for (const item of snapshot.packages) {
    const menu = (item.manifest.contributes.menus ?? []).find(entry => entry.id === id) as { args?: Json } | undefined;
    if (menu) return menu.args;
  }
  return undefined;
}
