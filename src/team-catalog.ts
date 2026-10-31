/* The model lists behind an automatic team and Settings → Model routing. */
import type { WorkerProfile } from './architect-types';
import type { ProviderId, ProviderModel } from './types';

/** Native validation counts UTF-8 bytes, so a long CJK name must be cut by bytes, not UTF-16 units. */
export function clipBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const char of text) {
    if (encoder.encode(out + char).length > max) break;
    out += char;
  }
  return out;
}

/** Native accepts up to this many catalog entries. */
export const CATALOG_MAX = 1000;
export const ROSTER_MAX = 24, ROSTER_PER_HARNESS = 6;
export interface CatalogHarness { id: ProviderId; name: string; models: readonly Pick<ProviderModel, 'id' | 'name'>[] }

/** Every model of every harness (deduped by provider + model), ordered round-robin across
 * harnesses so the cap never drops a harness entirely. `roster` is the short list the lead sees:
 * the first few models of each harness, with the same ids as the catalog. */
export function buildTeamCatalog(harnesses: readonly CatalogHarness[]): { roster: WorkerProfile[]; catalog: WorkerProfile[] } {
  const seen = new Set<string>(), taken = new Set<string>();
  const lists = harnesses.map(harness => harness.models.filter(model => {
    const key = `${harness.id}\u0000${model.id}`;
    if (!model.id || seen.has(key)) return false;
    seen.add(key); return true;
  }));
  const profiles = new Map<string, WorkerProfile>();
  const catalog: WorkerProfile[] = [];
  for (let position = 0; catalog.length < CATALOG_MAX && lists.some(list => position < list.length); position++) {
    harnesses.forEach((harness, index) => {
      const model = lists[index][position];
      if (!model || catalog.length >= CATALOG_MAX) return;
      const base = `${harness.id}-${model.id}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+$/, '').slice(0, 72) || harness.id;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 72 - String(n).length - 1)}-${n}`;
      taken.add(id);
      const profile: WorkerProfile = { id, name: clipBytes(`${model.name} · ${harness.name}`, 80), provider: harness.id, model: model.id, reasoningEffort: null };
      profiles.set(`${harness.id}\u0000${model.id}`, profile);
      catalog.push(profile);
    });
  }
  const roster: WorkerProfile[] = [];
  harnesses.forEach((harness, index) => {
    for (const model of lists[index].slice(0, ROSTER_PER_HARNESS)) {
      const profile = profiles.get(`${harness.id}\u0000${model.id}`);
      if (profile && roster.length < ROSTER_MAX) roster.push(profile);
    }
  });
  return { roster, catalog };
}

/** A harness with more than this many models (not counting `default`) offers teams only its most recent ones. */
export const TEAM_LIMIT = 10;
/** Models a user may add for teams per harness. */
export const ADDED_MAX = 50;
export interface TeamLimit { recent: readonly string[]; added: readonly string[]; unlimited?: boolean }
export interface LimitedModels<M> { models: M[]; recent: Set<string>; total: number; limited: boolean }

/** Long catalogs shrink to the `TEAM_LIMIT` most recent models in the catalog (`recent` is newest first)
 * plus every added model; `default` always stays. Short catalogs and `unlimited` ones pass through. */
export function limitTeamModels<M extends { id: string }>(models: readonly M[], { recent, added, unlimited = false }: TeamLimit): LimitedModels<M> {
  const ids = new Set(models.map(m => m.id).filter(id => id && id !== 'default'));
  if (unlimited || ids.size <= TEAM_LIMIT) return { models: [...models], recent: new Set(), total: ids.size, limited: false };
  const latest = new Set([...new Set(recent)].filter(id => ids.has(id)).slice(0, TEAM_LIMIT));
  const keep = new Set([...latest, ...added]);
  return { models: models.filter(m => m.id === 'default' || keep.has(m.id)), recent: latest, total: ids.size, limited: true };
}

/** Fired on `window` with the provider id when its added models change. */
export const TEAM_MODELS_EVENT = 'pandacode:team-models';
let recency: { used(id: ProviderId): readonly string[]; unlimited(id: ProviderId): boolean } = { used: () => [], unlimited: () => false };
/** main.ts hands over task recency (models by last prompt) and OpenCode's saved-selection flag. */
export function setTeamRecency(source: typeof recency): void { recency = source; }
function storedIds(key: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200) : [];
  } catch { return []; }
}
const addedKey = (id: ProviderId) => `pandacode.team-models.added.${id}`;
export const addedTeamModels = (id: ProviderId): string[] => storedIds(addedKey(id)).slice(0, ADDED_MAX);
export function setAddedTeamModels(id: ProviderId, models: readonly string[]): void {
  localStorage.setItem(addedKey(id), JSON.stringify([...new Set(models)].slice(0, ADDED_MAX)));
  window.dispatchEvent(new CustomEvent(TEAM_MODELS_EVENT, { detail: id }));
}
/** The models of `id` teams may use: recent tasks first, then the model picker's recent list. */
export function teamModels<M extends { id: string }>(id: ProviderId, models: readonly M[]): LimitedModels<M> {
  return limitTeamModels(models, { recent: [...recency.used(id), ...storedIds(`pandacode.recent-models.${id}`)], added: addedTeamModels(id), unlimited: recency.unlimited(id) });
}

/** Installed harnesses with their discovered models (falling back to the built-in list), limited by `teamModels`. */
export async function installedCatalog(providers: readonly { id: ProviderId; name: string; installed: boolean; models: ProviderModel[] }[], loadModels: (id: ProviderId) => Promise<ProviderModel[]>) {
  const installed = providers.filter(p => p.installed);
  const loaded = await Promise.allSettled(installed.map(p => loadModels(p.id)));
  return buildTeamCatalog(installed.map((p, i) => ({ id: p.id, name: p.name, models: teamModels(p.id, loaded[i].status === 'fulfilled' ? loaded[i].value : p.models).models })));
}
