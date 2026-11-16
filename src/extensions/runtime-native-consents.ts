/**
 * Migration of the legacy API-1 consents into native grants, and the synthetic preview of the native migration.
 *
 * The authority is native (`src-tauri/src/extensions/runtime_native_consents.rs`): it adopts the persisted
 * private-storage consent and the transient per-handle consents into `RuntimeGrants` in one write, never turns a
 * denial or a missing decision into a grant, and never undoes a later revoke. The legacy call sites keep their previous
 * prompt until a package holds the grant (`gate`). This module mirrors those rules over the preview grants store so the
 * browser suites run the same fixture (`tests/fixtures/extensions/runtime-native-consents/scenario.json`).
 */
import { call } from '../bridge';
import { createRuntimeGrantsPreview, GRANT_PERMISSIONS, grantOf, parseGrants, type GrantScope, type GrantsProjection, type SyncSnapshot } from './runtime-grants';

/** The permission each legacy consent family maps to: context, files, Git, jobs, connections, services, storage. */
export const LEGACY_PERMISSIONS = ['projects.summary', 'tasks.summary', 'harnesses.inventory', 'connections.summary', 'jobs.summary', 'projects.files.metadata', 'projects.files.read', 'projects.git.read', 'tools.execute', 'connections.request', 'services.call', 'storage.private'] as const;
const PROJECT_SCOPED = new Set(['projects.summary', 'tasks.summary', 'connections.request', 'projects.files.metadata', 'projects.files.read', 'projects.git.read']);

export type LegacyConsent = { id: string; permission: string; project?: string; allow: boolean };
export type MigrationReport = { schemaVersion: 1; adopted: { id: string; permission: string }[]; skipped: number; grants: GrantsProjection };
export type Gate = 'granted' | 'prompt';
export type ConsentSnapshot = { safeMode?: boolean; packages: (SyncSnapshot['packages'][number] & { storageGranted?: boolean })[] };

const legacy = (permission: string) => (LEGACY_PERMISSIONS as readonly string[]).includes(permission) && GRANT_PERMISSIONS.includes(permission);

/** The persisted storage decisions of a snapshot: an allow only for a declared `storage.private` the user consented to. */
export function persistedStorage(snapshot: ConsentSnapshot): LegacyConsent[] {
  return snapshot.packages.filter(item => item.storageGranted === true && [...(item.manifest.permissions ?? []), ...(item.manifest.requiredCapabilities ?? [])].includes('storage.private'))
    .map(item => ({ id: item.manifest.id, permission: 'storage.private', allow: true }));
}

/** Allows only; one scope per package and permission; a project-narrowable permission keeps the projects it was consented in. */
export function fold(consents: LegacyConsent[]): { entries: { id: string; permission: string; scope: GrantScope }[]; skipped: number } {
  const folded = new Map<string, { id: string; permission: string; projects: Set<string> | null }>();
  let skipped = 0;
  for (const consent of consents) {
    if (!legacy(consent.permission)) throw new Error(`UnsupportedCapability: ${consent.permission}`);
    if (!consent.allow) { skipped += 1; continue; }
    const key = `${consent.id}\u0000${consent.permission}`;
    if (PROJECT_SCOPED.has(consent.permission)) {
      if (!consent.project) { skipped += 1; continue; }
      const entry = folded.get(key) ?? { id: consent.id, permission: consent.permission, projects: new Set<string>() };
      entry.projects?.add(consent.project); folded.set(key, entry);
    } else folded.set(key, { id: consent.id, permission: consent.permission, projects: null });
  }
  return { entries: [...folded.values()].sort((a, b) => (a.id + a.permission).localeCompare(b.id + b.permission)).map(entry => ({ id: entry.id, permission: entry.permission, scope: entry.projects ? { projects: [...entry.projects].sort() } : {} })), skipped };
}

/** Runs the native migration (repeatable) and answers its report. */
export async function migrateNativeConsents(): Promise<MigrationReport | null> {
  try {
    const value = await call<Record<string, unknown>>('extensions_runtime_native_consents');
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.adopted) || typeof value.skipped !== 'number') return null;
    return { schemaVersion: 1, adopted: value.adopted as MigrationReport['adopted'], skipped: value.skipped, grants: parseGrants(value.grants) };
  } catch { return null; }
}

/**
 * The checker a legacy call site asks. `prompt` is the previous behavior (ask per handle); `granted` means the package
 * holds the native grant for this project, so it is never asked. A permission outside the legacy families is rejected.
 */
export function gate(projection: GrantsProjection, id: string, version: string, permission: string, project?: string): Gate {
  if (!legacy(permission)) throw new Error('UnsupportedCapability');
  const item = projection.available ? projection.packages.find(candidate => candidate.id === id) : undefined;
  const scope = item?.version === version ? grantOf(projection, id, permission) : undefined;
  if (!scope) return 'prompt';
  return !scope.projects || (project !== undefined && scope.projects.includes(project)) ? 'granted' : 'prompt';
}
export const allows = (projection: GrantsProjection, id: string, version: string, permission: string, project: string | undefined, handleConsent: boolean) => gate(projection, id, version, permission, project) === 'granted' || handleConsent;

/**
 * Synthetic stand-in for `extensions_runtime_native_consents`, over the preview grants store. The adopted marker is
 * kept beside the store so a reload is the preview's restart; the native Rust tests own the authority.
 */
export function createNativeConsentsPreview(grants = createRuntimeGrantsPreview(), storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, key = 'pandacode.preview.extensions.grants.migrated.v1') {
  const load = (): Record<string, string[]> => { try { const value = JSON.parse(storage.getItem(key) ?? ''); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* starts empty */ } return {}; };
  return {
    migrate(snapshot: ConsentSnapshot, transient: LegacyConsent[] = []): MigrationReport {
      grants.sync(snapshot);
      const { entries, skipped } = fold([...persistedStorage(snapshot), ...transient]);
      const marks = load(), projection = grants.projection(), adopted: { id: string; permission: string }[] = [];
      for (const entry of entries) {
        const item = projection.packages.find(candidate => candidate.id === entry.id);
        if (!item?.declared.includes(entry.permission)) continue;
        const done = new Set(marks[entry.id] ?? []);
        if (done.has(entry.permission)) continue;
        done.add(entry.permission); marks[entry.id] = [...done].sort();
        if (item.grants.some(grant => grant.permission === entry.permission)) continue;
        grants.change({ op: 'grant', id: entry.id, permission: entry.permission, scope: entry.scope }); adopted.push({ id: entry.id, permission: entry.permission });
      }
      for (const id of Object.keys(marks)) if (!projection.packages.some(item => item.id === id)) delete marks[id];
      storage.setItem(key, JSON.stringify(marks));
      return { schemaVersion: 1, adopted, skipped: skipped + entries.length - adopted.length, grants: grants.projection() };
    },
    call(_command: string, snapshot: SyncSnapshot): MigrationReport { return this.migrate(snapshot as ConsentSnapshot); },
  };
}
