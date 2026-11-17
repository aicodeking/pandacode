// The settled workspace settings (`workspace.settings`, runtime phase R4, slice R0407).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_settings.rs; the first half of this file mirrors
// them with no I/O for the browser preview and the deterministic checks of tests/extensions-runtime-workspace-settings.spec.ts.
// The second half is what the main window runs: it publishes the values its own storage holds, applies a package's change
// (storage first, then an event the surface reacts to, then the acknowledgement) and never lets the window's older value
// overwrite a change it has not applied yet. Everything here is for predictability and fault isolation, never for trust
// (ADR-0005): a package that holds `workspace.settings` is never asked again per action. Telemetry, routing, the GitHub
// switch, safe mode, updates, trust, pairing and remote access are not keys: they answer `NotFound`.
import { call, subscribe } from '../bridge';
import type { Json } from './contracts';
import { DEFAULT_SORT, PER_PROJECT, PROJECT_ORDER_KEY, SORT_KEY, readProjectOrder } from '../sidebar-sort';

export const PERMISSION = 'workspace.settings';
export const KEYS = ['sidebar.sort', 'sidebar.filter', 'sidebar.scope', 'sidebar.order', 'view.open', 'tiles.layout', 'find.query', 'projects.search', 'tokenSaver', 'council', 'team.profiles', 'widgets', 'machines.orchestration', 'appearance.compact', 'appearance.theme'] as const;
export const FAMILIES = ['bot:', 'channel:'] as const;
/** What is deliberately not a key, and why. */
export const EXCLUDED: readonly (readonly [string, string])[] = [
  ['telemetry', 'rules of the original project: no telemetry'], ['routing', 'rules of the original project: no traffic before opt-in'],
  ['github', "rules of the original project: the GitHub switch is the user's"], ['safeMode', 'recovery'], ['updates', 'recovery'],
  ['trust', "recovery: trust in an extension is the user's record"], ['pairing', 'pairing a machine stays with the user'],
  ['remoteAccess', 'granting remote access stays with the user'], ['credentials', 'ADR-0006: a held credential is never handed to a package'],
];
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;
export const MAX_FAMILY_ENTRIES = 1024;
const MAX_IDS = 512, MAX_TEXT = 512;

export type Code = 'NotFound' | 'StaleContext' | 'PermissionDenied' | 'InvalidShape' | 'LimitExceeded' | 'UnsupportedCapability' | 'HostUnavailable';
export type Refusal = { code: Code; path: string; ids: string[] };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: Code; path: string; ids: string[] } };
const failure = (code: Code, path = '$'): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code, path, ids: [] } });

const ident = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && [...text].length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
export const familyOf = (key: string): (typeof FAMILIES)[number] | null => FAMILIES.find(prefix => key.startsWith(prefix) && ident(key.slice(prefix.length))) ?? null;
export const isKey = (key: string): boolean => (KEYS as readonly string[]).includes(key) || familyOf(key) !== null;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const oneOf = (value: unknown, options: readonly string[]): Code | null => typeof value === 'string' && options.includes(value) ? null : 'InvalidShape';
const numberIn = (value: unknown, options: readonly number[]) => typeof value === 'number' && options.includes(value);
const textValue = (value: unknown, limit: number): Code | null => typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) ? 'InvalidShape' : [...value].length > limit ? 'LimitExceeded' : null;
function idList(value: unknown, limit: number): Code | null {
  if (!Array.isArray(value)) return 'InvalidShape';
  if (value.length > limit) return 'LimitExceeded';
  const seen = new Set<string>();
  for (const item of value) { if (!ident(item) || seen.has(item)) return 'InvalidShape'; seen.add(item); }
  return null;
}
function deep(value: unknown, level: number): boolean {
  if (level > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every(item => deep(item, level + 1));
  if (isObject(value)) return Object.values(value).every(item => deep(item, level + 1));
  return true;
}
const onlyFields = (value: unknown, allowed: readonly string[], required: readonly string[] = []): Code | null =>
  isObject(value) && Object.keys(value).every(name => allowed.includes(name)) && required.every(name => name in value) ? null : 'InvalidShape';

/** What `key` takes: `null` when the value is fine, else the refusal code (mirrors `validate`). */
export function validateSetting(key: string, value: unknown): Code | null {
  if ((JSON.stringify(value) ?? '').length > MAX_VALUE_BYTES || !deep(value, 0)) return 'LimitExceeded';
  if (familyOf(key)) {
    const bad = onlyFields(value, ['pinned', 'order']); if (bad) return bad;
    const map = value as Record<string, unknown>;
    if ('pinned' in map && typeof map.pinned !== 'boolean') return 'InvalidShape';
    if ('order' in map && map.order !== null && !(Number.isInteger(map.order) && (map.order as number) >= 0 && (map.order as number) < 100_000)) return 'InvalidShape';
    return null;
  }
  const map = value as Record<string, unknown>;
  switch (key) {
    case 'sidebar.sort': return onlyFields(value, ['tasks', 'projects', 'group'], ['tasks', 'projects', 'group']) ?? oneOf(map.tasks, ['manual', 'recent', 'created']) ?? oneOf(map.projects, ['recent', 'added', 'name', 'manual']) ?? oneOf(map.group, ['project', 'flat']);
    case 'sidebar.scope': return Number.isInteger(value) && numberIn(value, PER_PROJECT) ? null : 'InvalidShape';
    case 'sidebar.filter': return textValue(value, 128);
    case 'sidebar.order': return idList(value, MAX_IDS);
    case 'view.open': return oneOf(value, ['conversation', 'board', 'github']);
    case 'tiles.layout': return idList(value, 6);
    case 'find.query': case 'projects.search': return textValue(value, MAX_TEXT);
    case 'tokenSaver': {
      const bad = onlyFields(value, ['defaults', 'threads']); if (bad) return bad;
      return ('defaults' in map && map.defaults !== null && !isObject(map.defaults)) || ('threads' in map && !isObject(map.threads)) ? 'InvalidShape' : null;
    }
    case 'council': {
      const bad = onlyFields(value, ['target', 'maxRounds', 'reviewers', 'newThreads']); if (bad) return bad;
      return ('target' in map && !numberIn(map.target, [7, 8, 8.5, 9, 9.5, 10])) || ('maxRounds' in map && !numberIn(map.maxRounds, [3, 5, 10, 25])) || ('reviewers' in map && !numberIn(map.reviewers, [0, 2, 3, 4, 5])) || ('newThreads' in map && typeof map.newThreads !== 'boolean') ? 'InvalidShape' : null;
    }
    case 'team.profiles': case 'widgets': case 'machines.orchestration': return isObject(value) ? null : 'InvalidShape';
    case 'appearance.compact': return typeof value === 'boolean' ? null : 'InvalidShape';
    case 'appearance.theme': return oneOf(value, ['light', 'dark']);
    default: return 'NotFound';
  }
}

// ---- The store (mirror of `WorkspaceSettings`) ---------------------------------------------------------------------

type Entry = { value: Json; revision: number; applied: boolean; by: string | null };
export type Pending = { key: string; value: Json; revision: number; by: string | null };
export type Change = { key: string; revision: number; storeRevision: number };

export class WorkspaceSettingsStore {
  private entries = new Map<string, Entry>();
  private storeRevision = 0;
  get revision() { return this.storeRevision; }
  list(): string[] { return [...KEYS, ...[...this.entries.keys()].filter(key => familyOf(key))]; }
  get(key: string): { key: string; value: Json; revision: number } {
    if (!isKey(key)) throw new StoreError('NotFound', key);
    const entry = this.entries.get(key);
    if (entry) return { key, value: entry.value, revision: entry.revision };
    if ((KEYS as readonly string[]).includes(key)) return { key, value: null, revision: 0 };
    throw new StoreError('NotFound', key);
  }
  /** A package's write; `stillGranted` is asked right before it lands. `null` when nothing changed. */
  set(key: string, value: Json, revision: number | undefined, by: string, stillGranted: () => boolean = () => true): Change | null {
    if (!isKey(key)) throw new StoreError('NotFound', key);
    const current = this.entries.get(key);
    if (familyOf(key) && !current) throw new StoreError('NotFound', key);
    const invalid = validateSetting(key, value); if (invalid) throw new StoreError(invalid, key);
    if (revision !== undefined && revision !== (current?.revision ?? 0)) throw new StoreError('StaleContext', key);
    if (!stillGranted()) throw new StoreError('PermissionDenied', PERMISSION);
    if (current && JSON.stringify(current.value) === JSON.stringify(value)) return null;
    const next = (current?.revision ?? 0) + 1;
    this.storeRevision += 1;
    this.entries.set(key, { value, revision: next, applied: false, by });
    return { key, revision: next, storeRevision: this.storeRevision };
  }
  /** The window's values (and gone bots or channels). A package change that is not applied yet is kept. */
  publish(values: Record<string, Json>, forget: readonly string[] = []): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!isKey(key) || validateSetting(key, value)) continue;
      const entry = this.entries.get(key);
      if (entry && (!entry.applied || JSON.stringify(entry.value) === JSON.stringify(value))) continue;
      if (!entry && familyOf(key) && [...this.entries.keys()].filter(name => familyOf(name)).length >= MAX_FAMILY_ENTRIES) continue;
      this.entries.set(key, { value, revision: (entry?.revision ?? 0) + 1, applied: true, by: null });
      changed.push(key);
    }
    for (const key of forget) if (familyOf(key) && this.entries.delete(key)) changed.push(key);
    if (changed.length) this.storeRevision += 1;
    return changed;
  }
  pending(): { schemaVersion: 1; revision: number; pending: Pending[] } {
    const pending = [...this.entries].filter(([, entry]) => !entry.applied).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entry]) => ({ key, value: entry.value, revision: entry.revision, by: entry.by }));
    return { schemaVersion: 1, revision: this.storeRevision, pending };
  }
  ack(key: string, revision: number): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.revision !== revision || entry.applied) return false;
    entry.applied = true; return true;
  }
}
class StoreError extends Error { readonly code: Code; readonly path: string; constructor(code: Code, path: string) { super(code); this.code = code; this.path = path; } }
const refusalOf = (error: unknown): Reply<never> => error instanceof StoreError ? failure(error.code, error.path) : failure('HostUnavailable');

/** The service-side call, as `serve` answers it: `{ok, value}` or the refusal envelope. */
export function serveSetting(store: WorkspaceSettingsStore, granted: () => boolean, params: Record<string, unknown>, owner: string): Reply {
  if (!granted()) return failure('PermissionDenied', PERMISSION);
  try {
    switch (params.op) {
      case 'list': return { ok: true, value: store.list() };
      case 'get': if (typeof params.key !== 'string') return failure('InvalidShape'); return { ok: true, value: store.get(params.key) };
      case 'set': {
        if (typeof params.key !== 'string' || !('value' in params) || Object.keys(params).some(name => !['op', 'key', 'value', 'revision'].includes(name))) return failure('InvalidShape');
        const revision = params.revision === undefined || params.revision === null ? undefined : params.revision;
        if (revision !== undefined && !(Number.isInteger(revision) && (revision as number) >= 0)) return failure('InvalidShape');
        store.set(params.key, params.value as Json, revision as number | undefined, owner, granted);
        return { ok: true, value: null };
      }
      default: return failure('InvalidShape');
    }
  } catch (error) { return refusalOf(error); }
}

// ---- The window: storage adapters ---------------------------------------------------------------------------------

type Families = { bots: readonly string[]; channels: readonly string[] };
type Adapter = { read(storage: Storage, families: Families): Json | undefined; write(storage: Storage, value: Json, key: string): void };
const text = (storage: Storage, key: string) => { try { return storage.getItem(key); } catch { return null; } };
const json = (storage: Storage, key: string): unknown => { try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; } };
const put = (storage: Storage, key: string, value: string | null) => { try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* This session keeps it. */ } };
const ids = (storage: Storage, key: string): string[] => { const value = json(storage, key); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; };
const pick = (value: unknown, names: readonly string[]): Record<string, Json> | undefined => {
  if (!isObject(value)) return undefined;
  const out: Record<string, Json> = {};
  for (const name of names) if (name in value) out[name] = value[name] as Json;
  return out;
};
const PINS_KEY = 'pandacode.botsPinned', ORDER_KEY = 'pandacode.botsOrder';

/** Where each key lives in the window. A key without an adapter is held by the settled store alone and applied live. */
const ADAPTERS: Record<string, Adapter> = {
  'sidebar.sort': {
    read: storage => { const saved = pick(json(storage, SORT_KEY), ['tasks', 'projects', 'group']) ?? {}; return { tasks: DEFAULT_SORT.tasks, projects: DEFAULT_SORT.projects, group: DEFAULT_SORT.group, ...saved }; },
    write: (storage, value) => put(storage, SORT_KEY, JSON.stringify({ ...(isObject(json(storage, SORT_KEY)) ? json(storage, SORT_KEY) as object : {}), ...(value as object) })),
  },
  'sidebar.scope': {
    read: storage => { const saved = (json(storage, SORT_KEY) as { perProject?: number } | null)?.perProject; return numberIn(saved, PER_PROJECT) ? saved as number : DEFAULT_SORT.perProject; },
    write: (storage, value) => put(storage, SORT_KEY, JSON.stringify({ ...(isObject(json(storage, SORT_KEY)) ? json(storage, SORT_KEY) as object : {}), perProject: value })),
  },
  'sidebar.filter': { read: storage => text(storage, 'pandacode.projectFilter') ?? '', write: (storage, value) => put(storage, 'pandacode.projectFilter', String(value)) },
  'sidebar.order': { read: storage => readProjectOrder(storage), write: (storage, value) => put(storage, PROJECT_ORDER_KEY, JSON.stringify(value)) },
  'view.open': { read: storage => { const view = text(storage, 'pandacode.view'); return view === 'board' || view === 'github' ? view : 'conversation'; }, write: (storage, value) => put(storage, 'pandacode.view', String(value)) },
  'tiles.layout': { read: storage => ids(storage, 'pandacode.tiles').slice(0, 6), write: (storage, value) => put(storage, 'pandacode.tiles', Array.isArray(value) && value.length > 1 ? JSON.stringify(value) : null) },
  tokenSaver: { read: storage => pick(json(storage, 'pandacode.tokenSaver'), ['defaults', 'threads']), write: (storage, value) => put(storage, 'pandacode.tokenSaver', JSON.stringify(value)) },
  council: { read: storage => pick(json(storage, 'pandacode.council'), ['target', 'maxRounds', 'reviewers', 'newThreads']), write: (storage, value) => put(storage, 'pandacode.council', JSON.stringify({ ...(isObject(json(storage, 'pandacode.council')) ? json(storage, 'pandacode.council') as object : {}), ...(value as object) })) },
  'appearance.compact': { read: storage => text(storage, 'pandacode.compact') === 'true', write: (storage, value) => put(storage, 'pandacode.compact', String(value === true)) },
  'appearance.theme': { read: storage => (text(storage, 'pandacode.theme') === 'light' ? 'light' : 'dark'), write: (storage, value) => put(storage, 'pandacode.theme', String(value)) },
};
const familyAdapter: Adapter = {
  read: () => undefined,
  write: (storage, value, key) => {
    const id = key.slice(familyOf(key)!.length), body = value as { pinned?: boolean; order?: number | null };
    if (typeof body.pinned === 'boolean') put(storage, PINS_KEY, JSON.stringify([...ids(storage, PINS_KEY).filter(item => item !== id), ...body.pinned ? [id] : []]));
    if ('order' in body) {
      const rest = ids(storage, ORDER_KEY).filter(item => item !== id);
      put(storage, ORDER_KEY, JSON.stringify(body.order === null || body.order === undefined ? rest : [...rest.slice(0, body.order), id, ...rest.slice(body.order)]));
    }
  },
};
const adapterOf = (key: string): Adapter | undefined => ADAPTERS[key] ?? (familyOf(key) ? familyAdapter : undefined);

/** What the window's storage holds for the keys it owns, plus its bots and channels. */
export function collectWorkspaceSettings(storage: Storage, families: Families = { bots: [], channels: [] }): Record<string, Json> {
  const values: Record<string, Json> = {};
  for (const [key, adapter] of Object.entries(ADAPTERS)) { const value = adapter.read(storage, families); if (value !== undefined && !validateSetting(key, value)) values[key] = value; }
  const pins = new Set(ids(storage, PINS_KEY)), order = ids(storage, ORDER_KEY);
  for (const [prefix, list] of [['bot:', families.bots], ['channel:', families.channels]] as const) {
    for (const id of list) { const at = order.indexOf(id); values[`${prefix}${id}`] = { pinned: pins.has(id), order: at < 0 ? null : at }; }
  }
  return values;
}

export const SETTING_EVENT = 'pandacode-workspace-setting';
export type AppliedSetting = { key: string; value: Json; revision: number; by: string | null };
/** Applies one package change: storage first, then the event the surface reacts to (it carries the package's name). */
export async function applyWorkspaceSetting(storage: Storage, change: AppliedSetting): Promise<boolean> {
  if (!isKey(change.key) || validateSetting(change.key, change.value)) return false;
  adapterOf(change.key)?.write(storage, change.value, change.key);
  if (change.key === 'appearance.compact') document.body.classList.toggle('compact', change.value === true);
  if (change.key === 'appearance.theme') { try { (await import('../theme')).setTheme(change.value as 'light' | 'dark'); } catch { /* The storage already holds it. */ } }
  window.dispatchEvent(new CustomEvent(SETTING_EVENT, { detail: change }));
  return true;
}

export type SyncOptions = { storage?: Storage; families?: () => Families; intervalMs?: number };
/** The main window's half: applies pending package changes (at start, on the event) and publishes what its storage holds. */
export async function startWorkspaceSettingsSync(options: SyncOptions = {}): Promise<() => void> {
  const storage = options.storage ?? localStorage;
  let published = '', known = new Set<string>(), busy = false, again = false, disposed = false;
  const applyPending = async () => {
    const reply = await call<{ pending: AppliedSetting[] }>('extensions_workspace_settings_pending');
    // A change that cannot be applied here is acknowledged too, so it is not offered again on every pass.
    for (const change of reply.pending) { await applyWorkspaceSetting(storage, change); await call('extensions_workspace_settings_ack', { key: change.key, revision: change.revision }); }
  };
  const publish = async () => {
    const values = collectWorkspaceSettings(storage, options.families?.());
    const body = JSON.stringify(values);
    if (body === published) return;
    const family = new Set(Object.keys(values).filter(key => familyOf(key)));
    const forget = [...known].filter(key => !family.has(key));
    await call('extensions_workspace_settings_publish', { values, forget });
    published = body; known = family;
  };
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { do { again = false; await applyPending(); await publish(); } while (again && !disposed); } catch { /* The next change tries again. */ } finally { busy = false; }
  };
  const stop = await subscribe('extensions-workspace-setting', () => { void run(); });
  const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void run(); }, options.intervalMs ?? 1500);
  void run();
  return () => { disposed = true; window.clearInterval(timer); stop(); };
}

// ---- Preview stand-in ------------------------------------------------------------------------------------------------

/** Preview state: one store, the owners that hold the permission, and the preview window's own listeners. */
type PreviewState = { store: WorkspaceSettingsStore; granted: Set<string>; installed: Set<string>; emit?: (name: string, payload: unknown) => void };
let preview: PreviewState | undefined;
const previewState = (): PreviewState => preview ??= { store: new WorkspaceSettingsStore(), granted: new Set(), installed: new Set() };
/** Lets the preview deliver `extensions-workspace-setting` to the sync (set by `src/extensions/preview.ts`). */
export function previewWorkspaceSettingsNotifier(emit: (name: string, payload: unknown) => void): void { previewState().emit = emit; }

/**
 * The preview's IPC for the commands of this slice. `extensions_workspace_settings_service` is the service call as the
 * host answers it; `extensions_workspace_settings_preview` is the test hook (grant, revoke, install, uninstall).
 */
export function previewWorkspaceSettings(command: string, args: Record<string, unknown>): unknown {
  const state = previewState();
  switch (command) {
    case 'extensions_workspace_settings_publish': return state.store.publish((args.values ?? {}) as Record<string, Json>, (args.forget ?? []) as string[]);
    case 'extensions_workspace_settings_pending': return state.store.pending();
    case 'extensions_workspace_settings_ack': return state.store.ack(String(args.key), Number(args.revision));
    case 'extensions_workspace_settings_service': {
      const owner = String(args.owner ?? '');
      const granted = () => state.installed.has(owner) && state.granted.has(owner);
      const reply = serveSetting(state.store, granted, (args.params ?? {}) as Record<string, unknown>, owner);
      if (reply.ok && (args.params as { op?: string } | undefined)?.op === 'set') state.emit?.('extensions-workspace-setting', { key: (args.params as { key: string }).key });
      return reply;
    }
    case 'extensions_workspace_settings_preview':
      switch (args.op) {
        case 'install': state.installed.add(String(args.owner)); return null;
        case 'uninstall': state.installed.delete(String(args.owner)); return null;
        case 'grant': state.granted.add(String(args.owner)); return null;
        case 'revoke': state.granted.delete(String(args.owner)); return null;
        case 'state': return { revision: state.store.revision, keys: state.store.list(), pending: state.store.pending().pending.length };
        default: throw new Error('InvalidArguments');
      }
    default: throw new Error('Unsupported extension preview command.');
  }
}

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('workspace-settings')) {
  (globalThis as { __workspaceSettings?: unknown }).__workspaceSettings = { call: (command: string, args?: Record<string, unknown>) => call(command, args ?? {}), start: startWorkspaceSettingsSync };
}
