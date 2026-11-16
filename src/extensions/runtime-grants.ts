/**
 * The webview's read projection of the native runtime grants, and the synthetic preview of the native store.
 *
 * The authority is native (`src-tauri/src/extensions/runtime_grants.rs`, file `extension-grants-v1/grants.json`):
 * every native call site asks it, so nothing here grants anything. The webview only reads names, scopes and state
 * (for the Extensions page and for `ui.customize`) and sends the user's changes. There is no `credentials.read`.
 */
import { call } from '../bridge';
import { MANIFEST_CAPABILITIES } from './contracts';

export type GrantScope = { projects?: string[]; toolKinds?: string[]; items?: string[] };
export type GrantTarget = { project?: string; toolKind?: string; item?: string };
export type PackageGrants = {
  id: string; version: string; declared: string[]; archived: boolean; authorized: boolean; trusted: boolean;
  grants: { permission: string; scope: GrantScope }[]; uiCustomize: boolean;
};
export type GrantsProjection = { schemaVersion: 1; available: boolean; revision: number; vocabulary: string[]; packages: PackageGrants[] };
export type GrantChange =
  | { op: 'grant' | 'narrow'; id: string; permission: string; scope?: GrantScope }
  | { op: 'revoke'; id: string; permission: string }
  | { op: 'revokeAll'; id: string };
export type GrantCheck = 'ok' | 'PermissionDenied' | 'UnsupportedCapability';

/** The decided vocabulary (fifty names), shared with the manifest validator. */
export const GRANT_PERMISSIONS: readonly string[] = MANIFEST_CAPABILITIES;
const PROJECT_SCOPED = new Set(['btw.content', 'btw.taskControl', 'connections.request', 'projects.summary', 'tasks.summary', 'projects.files.metadata', 'projects.files.read', 'projects.git.read', 'tasks.transcript.read', 'tasks.tools.read', 'events.workspace', 'tasks.start', 'tasks.message', 'tasks.draft', 'tasks.control', 'tasks.usage.read', 'harness.hooks.observe', 'harness.hooks.decide', 'harness.hooks.context', 'harness.console', 'tools.model', 'documents.editors', 'workspace.manage', 'terminals.read', 'terminals.write', 'projects.checks.run']);
const TOOL_KIND_SCOPED = new Set(['harness.hooks.decide']);
const ITEM_SCOPED = new Set(['credentials.use']);
const DIMENSIONS = [['projects', PROJECT_SCOPED, 'project'], ['toolKinds', TOOL_KIND_SCOPED, 'toolKind'], ['items', ITEM_SCOPED, 'item']] as const;

/** The scope dimensions the user can narrow for a permission (empty when it has none). */
export function scopeDimensions(permission: string): ('projects' | 'toolKinds' | 'items')[] {
  return DIMENSIONS.filter(([, scoped]) => scoped.has(permission)).map(([key]) => key);
}

export const UNAVAILABLE_GRANTS: GrantsProjection = Object.freeze({ schemaVersion: 1, available: false, revision: 0, vocabulary: [...GRANT_PERMISSIONS], packages: [] }) as GrantsProjection;

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function parseScope(value: unknown): GrantScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).some(key => !['projects', 'toolKinds', 'items'].includes(key))) return null;
  for (const key of ['projects', 'toolKinds', 'items']) if (key in scope && !isStrings(scope[key])) return null;
  return scope as GrantScope;
}
/** Strict reader: any shape this build does not know is reported as unavailable, never partially trusted. */
export function parseGrants(value: unknown): GrantsProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || typeof root.revision !== 'number' || !isStrings(root.vocabulary) || !Array.isArray(root.packages)) return UNAVAILABLE_GRANTS;
  const packages: PackageGrants[] = [];
  for (const item of root.packages as Record<string, unknown>[]) {
    const grants = Array.isArray(item?.grants) ? (item.grants as Record<string, unknown>[]).map(grant => ({ permission: grant?.permission, scope: parseScope(grant?.scope) })) : null;
    if (!item || typeof item.id !== 'string' || typeof item.version !== 'string' || !isStrings(item.declared) || typeof item.archived !== 'boolean' || typeof item.authorized !== 'boolean' || typeof item.trusted !== 'boolean' || typeof item.uiCustomize !== 'boolean'
      || !grants || grants.some(grant => typeof grant.permission !== 'string' || !GRANT_PERMISSIONS.includes(grant.permission) || !grant.scope)) return UNAVAILABLE_GRANTS;
    packages.push({ id: item.id, version: item.version, declared: item.declared, archived: item.archived, authorized: item.authorized, trusted: item.trusted, grants: grants as PackageGrants['grants'], uiCustomize: item.uiCustomize });
  }
  return { schemaVersion: 1, available: root.available, revision: root.revision, vocabulary: root.vocabulary, packages };
}
export async function loadRuntimeGrants(): Promise<GrantsProjection> {
  try { return parseGrants(await call<unknown>('extensions_runtime_grants')); } catch { return UNAVAILABLE_GRANTS; }
}
/** The user's change (the Extensions page, R0101B). Rejects with the native error code; the store is unchanged then. */
export async function changeRuntimeGrant(request: GrantChange): Promise<GrantsProjection> {
  return parseGrants(await call<unknown>('extensions_runtime_grant', { request }));
}
/** True when the package may customize layouts now: declared, granted and not archived or untrusted. */
export function uiCustomizeGranted(projection: GrantsProjection, id: string): boolean {
  return projection.available && projection.packages.some(item => item.id === id && item.uiCustomize);
}
export function grantOf(projection: GrantsProjection, id: string, permission: string): GrantScope | undefined {
  const item = projection.packages.find(candidate => candidate.id === id);
  return item?.authorized ? item.grants.find(grant => grant.permission === permission)?.scope : undefined;
}

/** The part of `extensions_snapshot` the store reads. */
export type SyncSnapshot = { safeMode?: boolean; packages: { manifest: { id: string; version: string; permissions?: string[]; requiredCapabilities?: string[] }; enabled: boolean; executable?: { digest: string; trusted: boolean } | null }[] };
type Rec = { version: string; declared: string[]; digest: string | null; trustedDigest: string | null; archived: boolean; grants: Record<string, GrantScope> };
type Stored = { schemaVersion: 1; revision: number; packages: Record<string, Rec> };
const authorized = (record: Rec) => !record.archived && (record.digest === null || record.digest === record.trustedDigest);
const within = (allowed: string[] | undefined, value: string | undefined) => allowed === undefined || (value !== undefined && allowed.includes(value));
function scopeError(permission: string, scope: GrantScope): string | null {
  if (!GRANT_PERMISSIONS.includes(permission)) return 'UnsupportedCapability';
  for (const [key, scoped] of DIMENSIONS) {
    const set = scope[key]; if (set === undefined) continue;
    if (!scoped.has(permission) || set.length === 0 || set.length > 256 || set.some(entry => !entry || entry.length > 256)) return 'InvalidArguments';
  }
  return null;
}
const subset = (old: string[] | undefined, next: string[] | undefined) => old === undefined || (next !== undefined && next.every(entry => old.includes(entry)));

/**
 * Synthetic stand-in for the native store, labelled as such: same vocabulary, scope rules, narrowing, trust and
 * archive semantics, persisted in the preview's localStorage so a reload is the preview's restart. The native Rust
 * tests own the authority; `tests/fixtures/extensions/runtime-grants/scenario.json` drives both.
 */
export function createRuntimeGrantsPreview(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, key = 'pandacode.preview.extensions.grants.v1') {
  const load = (): Stored => { try { const stored = JSON.parse(storage.getItem(key) ?? ''); if (stored?.schemaVersion === 1) return stored; } catch { /* a missing or damaged preview file starts empty */ } return { schemaVersion: 1, revision: 0, packages: {} }; };
  const mutate = <T>(change: (file: Stored) => T): T => {
    const file = load(), before = JSON.stringify(file.packages), value = change(file);
    if (JSON.stringify(file.packages) !== before) { file.revision += 1; storage.setItem(key, JSON.stringify(file)); }
    return value;
  };
  const register = (file: Stored, id: string, version: string, declared: string[], digest: string | null) => {
    const unknown = declared.find(name => !GRANT_PERMISSIONS.includes(name));
    if (unknown) throw new Error('UnsupportedCapability');
    const record = file.packages[id] ?? (file.packages[id] = { version, declared: [], digest, trustedDigest: null, archived: false, grants: {} });
    record.version = version; record.declared = [...new Set(declared)].sort();
    for (const name of Object.keys(record.grants)) if (!declared.includes(name)) delete record.grants[name];
    record.digest = digest; if (record.trustedDigest !== null && record.trustedDigest !== digest) record.trustedDigest = null;
  };
  const record = (file: Stored, id: string) => file.packages[id] ?? (() => { throw new Error('PermissionDenied'); })();
  const api = {
    /** Mirrors `RuntimeGrants::sync` over an `extensions_snapshot`. */
    sync(snapshot: SyncSnapshot) {
      mutate(file => {
        const present = new Set<string>();
        for (const item of snapshot.packages) {
          const digest = item.executable?.digest ?? null, declared = [...(item.manifest.permissions ?? []), ...(item.manifest.requiredCapabilities ?? [])];
          try { register(file, item.manifest.id, item.manifest.version, declared, digest); } catch { continue; }
          present.add(item.manifest.id);
          const entry = file.packages[item.manifest.id];
          entry.trustedDigest = item.executable?.trusted ? digest : null; entry.archived = !!snapshot.safeMode || item.enabled !== true;
        }
        for (const id of Object.keys(file.packages)) if (!present.has(id)) delete file.packages[id];
      });
    },
    register(id: string, version: string, declared: string[], digest: string | null) { mutate(file => register(file, id, version, declared, digest)); },
    trust(id: string, allow: boolean) { mutate(file => { const item = record(file, id); item.trustedDigest = allow ? item.digest : null; }); },
    archive(id: string, archived: boolean) { mutate(file => { record(file, id).archived = archived; }); },
    change(request: GrantChange) {
      mutate(file => {
        const item = record(file, request.id);
        if (request.op === 'revokeAll') { item.grants = {}; return; }
        if (request.op === 'revoke') { if (!GRANT_PERMISSIONS.includes(request.permission)) throw new Error('UnsupportedCapability'); delete item.grants[request.permission]; return; }
        const scope = request.scope ?? {}, error = scopeError(request.permission, scope);
        if (error) throw new Error(error);
        if (request.op === 'grant') { if (!item.declared.includes(request.permission)) throw new Error('PermissionDenied'); item.grants[request.permission] = scope; return; }
        const current = item.grants[request.permission]; if (!current) throw new Error('PermissionDenied');
        if (!DIMENSIONS.every(([key]) => subset(current[key], scope[key]))) throw new Error('InvalidArguments');
        item.grants[request.permission] = scope;
      });
    },
    check(id: string, version: string, permission: string, target: GrantTarget = {}): GrantCheck {
      if (!GRANT_PERMISSIONS.includes(permission)) return 'UnsupportedCapability';
      const item = load().packages[id], scope = item?.grants[permission];
      if (!item || item.version !== version || !authorized(item) || !scope) return 'PermissionDenied';
      return DIMENSIONS.every(([key, , field]) => within(scope[key], target[field])) ? 'ok' : 'PermissionDenied';
    },
    projection(): GrantsProjection {
      const file = load();
      return {
        schemaVersion: 1, available: true, revision: file.revision, vocabulary: [...GRANT_PERMISSIONS],
        packages: Object.keys(file.packages).sort().map(id => {
          const item = file.packages[id], ok = authorized(item);
          return { id, version: item.version, declared: [...item.declared], archived: item.archived, authorized: ok, trusted: item.digest === null || item.digest === item.trustedDigest,
            grants: Object.keys(item.grants).sort().map(permission => ({ permission, scope: structuredClone(item.grants[permission]) })), uiCustomize: ok && 'ui.customize' in item.grants };
        }),
      };
    },
    /** The preview's `extensions_runtime_grants` and `extensions_runtime_grant` commands. */
    call(command: string, args: Record<string, unknown>, snapshot: SyncSnapshot) {
      api.sync(snapshot);
      if (command === 'extensions_runtime_grant') api.change(args.request as GrantChange);
      return api.projection();
    },
  };
  return api;
}
