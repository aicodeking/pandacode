/**
 * What the model picker lists, cached so it opens at once: each harness's models (refreshed on demand, never polled)
 * and the team library (refreshed behind each open, replaced by team saves).
 */
import { call } from './bridge';
import type { TeamLibrary } from './architect-types';
import type { ProviderId, ProviderModel } from './types';

/* ----- Model catalogs: answered from cache, refreshed on demand, never polled ----- */
const CATALOG_TTL_MS = 5 * 60 * 1000;
/** A failed refresh with an older list keeps showing that list and is not asked again for this long. */
const CATALOG_RETRY_MS = 30 * 1000;
/** `failure`: the refresh behind this (older) list failed; it is not asked again until `expires`. */
const catalogs = new Map<ProviderId, { expires: number; models?: ProviderModel[]; pending?: Promise<ProviderModel[]>; failure?: Error }>();
export function clearCatalogs(id?: ProviderId): void { if (id) catalogs.delete(id); else catalogs.clear(); }
export function hasCatalog(id: ProviderId): boolean { return catalogs.has(id); }
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
/** A harness's models: a fresh cached list at once; an expired one at once too while `fetch` refreshes it behind
 *  (`onFresh` hears the newer list, or why it failed); else the first fetch. `landed` applies each list that arrives
 *  for the current entry. With no older list, a failure is not cached: the next ask retries. */
export function loadCatalog(id: ProviderId, fetch: () => Promise<ProviderModel[]>, landed: (models: ProviderModel[]) => void,
  onFresh?: (update: ProviderModel[] | Error) => void): Promise<ProviderModel[]> {
  const entry = catalogs.get(id) ?? { expires: 0 };
  if (!entry.pending && (entry.models === undefined || entry.expires <= Date.now())) {
    entry.expires = Date.now() + CATALOG_TTL_MS;
    catalogs.set(id, entry);
    entry.pending = fetch().then(models => {
      if (catalogs.get(id) === entry) {
        entry.models = models; entry.pending = undefined; entry.failure = undefined;
        landed(models);
      }
      return models;
    }).catch(error => {
      if (catalogs.get(id) === entry) {
        entry.pending = undefined;
        if (entry.models !== undefined) { entry.expires = Date.now() + CATALOG_RETRY_MS; entry.failure = asError(error); }
        else catalogs.delete(id);
      }
      throw error;
    });
  }
  if (entry.models !== undefined) {
    // Every overlapping open gets the saved list now and the shared refresh's outcome later.
    if (entry.pending) entry.pending.then(
      models => { if (catalogs.get(id) === entry) onFresh?.(models); },
      error => { if (catalogs.get(id) === entry) onFresh?.(asError(error)); });
    else {
      const failure = entry.failure;
      if (failure && onFresh) queueMicrotask(() => { if (catalogs.get(id) === entry) onFresh(failure); });
    }
    return Promise.resolve(entry.models);
  }
  return entry.pending!;
}

/* ----- The picker's team library: opened from cache, refreshed behind ----- */
let teamLibrary: TeamLibrary | null = null;
let teamLibraryVersion = 0;
let teamLibraryLoad: Promise<TeamLibrary | null> | undefined;
/** A failed load is not retried by hover preloading for this long (an open still asks). */
const TEAM_LIBRARY_RETRY_MS = 30 * 1000;
let teamLibraryFailedAt = 0;
export function refreshTeamLibrary(): Promise<TeamLibrary | null> {
  const version = teamLibraryVersion;
  // A team saved while this load was out wins over the older answer.
  return teamLibraryLoad ??= call<TeamLibrary>('architect_profiles').then(library => { if (version === teamLibraryVersion) teamLibrary = library; return teamLibrary; })
    .catch(() => { teamLibraryFailedAt = Date.now(); return teamLibrary; }).finally(() => { teamLibraryLoad = undefined; });
}
/** The cached library at once (refreshing it behind), or the first load. */
export function pickerTeamLibrary(): Promise<TeamLibrary | null> {
  const known = teamLibrary, refreshed = refreshTeamLibrary();
  return known ? Promise.resolve(known) : refreshed;
}
// Team saves hand over the saved library: TEAMS_CHANGED_EVENT in team-profiles.ts, named here rather than imported so
// that module (and its menus) stays out of the entry bundle.
window.addEventListener('pandacode:teams-changed', event => {
  const library = (event as CustomEvent<TeamLibrary | undefined>).detail;
  if (library) { teamLibraryVersion += 1; teamLibrary = library; }
});
/** Readies the picker before it is asked for: its module and the team library. Catalogs wait for an open: they start CLIs. */
export function warmModelPicker(): void {
  void import('./model-picker').catch(() => undefined);
  if (!teamLibrary && Date.now() - teamLibraryFailedAt >= TEAM_LIBRARY_RETRY_MS) void refreshTeamLibrary();
}
