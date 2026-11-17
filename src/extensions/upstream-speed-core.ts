/** Provider speed tiers (upstream 0.3.128), pure part: the one place that decides which speed choices the model
 * picker draws. A model lists its own `speedTiers` (a built-in harness, or an extension harness that declares them in
 * its package); the user may hide or reorder the optional ones per model, and "Standard" and the saved choice never
 * hide. Saving is the picker's own (`onSpeedSelect`); this module owns the choice list, its arrangement and the
 * captured revision that turns a stale action into a refusal. With no package, nothing hidden or in safe mode it
 * returns exactly the upstream list. New runtime abilities (provider state, the warm-spare opt-in) belong to the
 * owning runtime tasks (R0806, R0807); nothing here reads a credential or runs a package. */

import type { ExtensionSnapshot } from './manager';

export const SPEED_LOCATION = 'panda.composer.model.speed';
/** Standard speed is the empty choice; it is always listed first and never hides. */
export const STANDARD_SPEED = '';
export type SpeedChoice = { id: string; name: string; description: string };
export type SpeedView = { choices: SpeedChoice[]; hidden: string[]; revision: string };
export type SpeedDeps = {
  safe: () => boolean;
  order: (location: string, ids: readonly string[]) => string[];
  isHidden: (id: string) => boolean;
};

/** Two independent 32-bit hashes, so the layout id stays lowercase hex however odd the model id is. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 0x01000193) >>> 0; b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b) >>> 0; b = (b ^ (b >>> 13)) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/** The layout id of one tier of one model: `speed-` and a fingerprint, because layout ids are lowercase words while
 * provider and model IDs may hold any separator. The catalog row's label carries the readable names. */
export const speedItemId = (provider: string, model: string, tier: string) => `${SPEED_LOCATION}/speed-${fingerprint(JSON.stringify([provider, model, tier]))}`;

/** The upstream list: Standard, the model's tiers, and a saved tier the catalog no longer lists (still shown as chosen). */
export function speedChoices(tiers: readonly SpeedChoice[], chosen: string | null): SpeedChoice[] {
  const listed = [...tiers];
  if (chosen && !listed.some(tier => tier.id === chosen)) listed.push({ id: chosen, name: chosen, description: '' });
  return [{ id: STANDARD_SPEED, name: 'Standard', description: "The model's standard speed." }, ...listed];
}

/** Order-sensitive digest so a changed list is a changed revision without leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };

/** The arranged choices for a model: Standard first, then the user's order; hidden tiers leave the list. */
export function speedView(provider: string, model: string, tiers: readonly SpeedChoice[], chosen: string | null, deps: SpeedDeps): SpeedView {
  const all = speedChoices(tiers, chosen);
  const optional = all.filter(choice => choice.id !== STANDARD_SPEED);
  const ids = optional.map(choice => speedItemId(provider, model, choice.id));
  const safe = deps.safe();
  const arranged = safe ? ids : deps.order(SPEED_LOCATION, ids);
  const byItem = new Map(optional.map(choice => [speedItemId(provider, model, choice.id), choice] as const));
  const ordered = arranged.map(id => byItem.get(id)).filter((choice): choice is SpeedChoice => Boolean(choice));
  // Anything the arrangement did not name keeps its upstream place after the ones it did.
  for (const choice of optional) if (!ordered.includes(choice)) ordered.push(choice);
  const hidden = safe ? [] : ordered.filter(choice => choice.id !== chosen && deps.isHidden(speedItemId(provider, model, choice.id))).map(choice => choice.id);
  const choices = [all[0], ...ordered.filter(choice => !hidden.includes(choice.id))];
  return { choices, hidden, revision: digest(JSON.stringify([provider, model, safe, choices.map(choice => choice.id), hidden])) };
}

/** Catalog rows for the user's hide/reorder controls: the tiers declared by enabled package harnesses (none in safe mode). */
export function declaredSpeedItems(snapshot: Pick<ExtensionSnapshot, 'safeMode' | 'packages'>) {
  if (snapshot.safeMode) return [];
  type Declared = { id: string; name: string; models?: { id: string; name: string; speedTiers?: { id: string; name: string }[] }[] };
  return snapshot.packages.filter(item => item.enabled).flatMap(item => ((item.manifest.contributes as { providers?: Declared[] }).providers ?? []).flatMap(provider =>
    (provider.models ?? []).flatMap(model => (model.speedTiers ?? []).map(tier => ({ id: speedItemId(provider.id, model.id, tier.id), owner: item.manifest.id, version: item.manifest.version, label: `${provider.name}: ${model.name} — ${tier.name}` })))));
}

/** What a speed action captured when the picker drew it. */
export type SpeedContext = { provider: string; model: string; tier: string | null; revision: string };
export const captureSpeed = (view: SpeedView, provider: string, model: string, tier: string | null): SpeedContext => ({ provider, model, tier, revision: view.revision });
/** A captured action is stale when the task's model or the arranged list changed since it was drawn. */
export const speedStale = (captured: SpeedContext, live: { provider: string; model: string; revision: string }) =>
  captured.provider !== live.provider || captured.model !== live.model || captured.revision !== live.revision;
