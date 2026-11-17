/**
 * Dynamic provider state published by a package's service (`panda.providers.update`, runtime slice R0806): the
 * webview's read of the native owner (`src-tauri/src/extensions/runtime_provider_state.rs`, IPC
 * `extensions_provider_state`, `extensions_provider_action`) and the labelled preview stand-in of its rules.
 *
 * A package provider is declared once in the manifest. Its service publishes what is true now: readiness, the signed-in
 * account's label, the models the account may use and its limits. One overlay per provider feeds every reader (the
 * model picker, the readiness line, the usage view and the `limits`/`accounts` resources), so they cannot disagree.
 * A signed-out or unavailable readiness empties the account, the models and the limits in the same step. The overlay
 * goes when the service stops. Publishing never starts a package (there is no warm spare). No field can carry a
 * credential: the shapes are strict and every text is bounded. The module has no top-level browser import, so the roster
 * code and Node tests can use `applyProviderState`; the bridge is loaded only by the two readers.
 */
import type { Provider } from '../types';
import type { ProviderMetadata } from './provider-state';

export const PROVIDER_STATE_PERMISSION = 'ui.dynamic';
export type ReadinessState = 'ready' | 'signedOut' | 'unavailable';
export type PublishedModel = { id: string; name: string; efforts: string[]; contextWindow?: number; speedTiers?: { id: string; name: string; description?: string }[] };
export type PublishedWindow = { id: string; label: string; usedPercent: number; resetsAt?: string };
export type PublishedLimits = { windows: PublishedWindow[]; credits?: unknown };
export type ProviderStateUpdate = {
  readiness?: { state: ReadinessState; reason: string };
  account?: { label: string } | null;
  models?: PublishedModel[];
  limits?: PublishedLimits | null;
};
export type PublishedProvider = {
  id: string; owner: string; readiness: { state: ReadinessState; reason: string } | null; account: { label: string } | null;
  models: PublishedModel[] | null; limits: PublishedLimits | null; updates: number; rejected: number;
};
export type ProviderStateProjection = { schemaVersion: 1; revision: number; providers: PublishedProvider[]; recorder: { what: string; provider: string; detail: string }[] };
export const EMPTY_PROVIDER_STATE: ProviderStateProjection = Object.freeze({ schemaVersion: 1, revision: 0, providers: [], recorder: [] }) as ProviderStateProjection;

const MAX_MODELS = 32, MAX_WINDOWS = 16, MAX_CREDITS = 2048;
const control = /[\u0000-\u001f\u007f]/;
const token = (text: unknown, max: number): text is string => typeof text === 'string' && text.length > 0 && text.length <= max && /^[a-z][a-z0-9-]*$/.test(text);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= max && !control.test(value);
const object = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('InvalidShape');
  return value as Record<string, unknown>;
};
const fail = (): never => { throw new Error('InvalidShape'); };

function parseModel(model: unknown): PublishedModel {
  const item = object(model, ['id', 'name', 'efforts', 'contextWindow', 'speedTiers']);
  if (typeof item.id !== 'string' || !item.id || new TextEncoder().encode(item.id).length > 200 || control.test(item.id) || !text(item.name, 256)) fail();
  const efforts = item.efforts;
  if (!Array.isArray(efforts) || efforts.length > 8 || efforts.some(effort => !token(effort, 40))) fail();
  const clean: PublishedModel = { id: item.id as string, name: item.name as string, efforts: [...(efforts as string[])] };
  if (item.contextWindow !== undefined) {
    if (!Number.isInteger(item.contextWindow) || (item.contextWindow as number) < 1 || (item.contextWindow as number) > 10_000_000) fail();
    clean.contextWindow = item.contextWindow as number;
  }
  if (item.speedTiers !== undefined) {
    if (!Array.isArray(item.speedTiers) || item.speedTiers.length > 8) fail();
    clean.speedTiers = (item.speedTiers as unknown[]).map(tier => {
      const entry = object(tier, ['id', 'name', 'description']);
      if (!token(entry.id, 40) || !text(entry.name, 256)) fail();
      if (entry.description !== undefined && (typeof entry.description !== 'string' || [...entry.description].length > 256 || control.test(entry.description))) fail();
      return entry.description === undefined ? { id: entry.id as string, name: entry.name as string } : { id: entry.id as string, name: entry.name as string, description: entry.description as string };
    });
    if (new Set(clean.speedTiers.map(tier => tier.id)).size !== clean.speedTiers.length) fail();
  }
  return clean;
}
function parseLimits(limits: unknown): PublishedLimits {
  const item = object(limits, ['windows', 'credits']);
  if (!Array.isArray(item.windows) || item.windows.length > MAX_WINDOWS) fail();
  const windows = (item.windows as unknown[]).map((window): PublishedWindow => {
    const entry = object(window, ['id', 'label', 'usedPercent', 'resetsAt']);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(entry.id) || !text(entry.label, 120)) fail();
    if (typeof entry.usedPercent !== 'number' || !(entry.usedPercent >= 0 && entry.usedPercent <= 100)) fail();
    if (entry.resetsAt !== undefined && !text(entry.resetsAt, 64)) fail();
    return entry.resetsAt === undefined ? { id: entry.id as string, label: entry.label as string, usedPercent: entry.usedPercent as number } : { id: entry.id as string, label: entry.label as string, usedPercent: entry.usedPercent as number, resetsAt: entry.resetsAt as string };
  });
  if (new Set(windows.map(window => window.id)).size !== windows.length) fail();
  if (item.credits !== undefined && JSON.stringify(item.credits).length > MAX_CREDITS) throw new Error('LimitExceeded');
  return item.credits === undefined ? { windows } : { windows, credits: item.credits };
}
/** Strict validation of one `providers.update` state, the twin of the native parser. Throws the native error codes. */
export function parseProviderUpdate(raw: unknown): ProviderStateUpdate {
  const item = object(raw, ['readiness', 'account', 'models', 'limits']);
  if (!Object.keys(item).length) fail();
  const clean: ProviderStateUpdate = {};
  if (item.readiness !== undefined) {
    const readiness = object(item.readiness, ['state', 'reason']);
    if (!['ready', 'signedOut', 'unavailable'].includes(String(readiness.state)) || !text(readiness.reason, 256)) fail();
    clean.readiness = { state: readiness.state as ReadinessState, reason: readiness.reason as string };
  }
  if (item.account !== undefined) {
    if (item.account === null) clean.account = null;
    else { const account = object(item.account, ['label']); if (!text(account.label, 120)) fail(); clean.account = { label: account.label as string }; }
  }
  if (item.models !== undefined) {
    if (!Array.isArray(item.models) || item.models.length > MAX_MODELS) fail();
    clean.models = (item.models as unknown[]).map(parseModel);
    if (new Set(clean.models.map(model => model.id)).size !== clean.models.length) fail();
  }
  if (item.limits !== undefined) clean.limits = item.limits === null ? null : parseLimits(item.limits);
  return clean;
}

/** Reads the owner of a provider id (`publisher.extension/local`), or `null` when it is not a package provider. */
export function ownerOf(id: string): string | null { return /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/[a-z][a-zA-Z0-9._-]*$/.test(id) && id.length <= 200 && !id.startsWith('panda.') ? id.split('/')[0] : null; }

type Entry = { owner: string; readiness?: { state: ReadinessState; reason: string }; account?: string | null; models?: PublishedModel[]; limits?: PublishedLimits | null; updates: number; rejected: number };
export type UpdateContext = { granted: boolean; declared: boolean };

/** The overlay store: a labelled stand-in for the native one (`runtime_provider_state.rs`), with the same rules. */
export function createProviderStatePreview() {
  const entries = new Map<string, Entry>();
  const recorder: ProviderStateProjection['recorder'] = [];
  let revision = 0;
  const note = (what: string, provider: string, detail: string) => { if (recorder.length >= 64) recorder.shift(); recorder.push({ what, provider, detail }); };
  const clearOwner = (owner: string, reason: string): boolean => {
    const gone = [...entries].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
    for (const id of gone) { entries.delete(id); note('clear', id, reason); }
    if (gone.length) revision++;
    return gone.length > 0;
  };
  return {
    /** `panda.providers.update(id, state)` of a service. The caller is always `service`; a panel answers `UnsupportedCapability`. */
    update(owner: string, id: string, state: unknown, context: UpdateContext, caller: 'service' | 'panel' = 'service'): number {
      if (caller !== 'service') throw new Error('UnsupportedCapability');
      if (!context.granted) throw new Error('PermissionDenied');
      if (!context.declared || ownerOf(id) !== owner) throw new Error('NotFound');
      let parsed: ProviderStateUpdate;
      try { parsed = parseProviderUpdate(state); } catch (error) {
        const entry = entries.get(id) ?? { owner, updates: 0, rejected: 0 }; entry.rejected++; entries.set(id, entry);
        note('rejected', id, (error as Error).message); throw error;
      }
      const entry = entries.get(id) ?? { owner, updates: 0, rejected: 0 };
      entry.owner = owner;
      if (parsed.readiness && parsed.readiness.state !== 'ready') { entry.account = null; entry.models = []; entry.limits = null; }
      else {
        if (parsed.account !== undefined) entry.account = parsed.account === null ? null : parsed.account.label;
        if (parsed.models !== undefined) entry.models = parsed.models;
        if (parsed.limits !== undefined) entry.limits = parsed.limits;
      }
      if (parsed.readiness) entry.readiness = parsed.readiness;
      entry.updates++; entries.set(id, entry); revision++;
      note('update', id, entry.readiness?.state ?? 'manifest');
      return revision;
    },
    clearOwner,
    /** Every package `allowed` refuses (a revoked grant, disable, safe mode) loses its overlay. */
    sweep(allowed: (owner: string) => boolean, reason: string): boolean {
      let moved = false;
      for (const owner of new Set([...entries.values()].map(entry => entry.owner))) if (!allowed(owner)) moved = clearOwner(owner, reason) || moved;
      return moved;
    },
    projection(): ProviderStateProjection {
      return {
        schemaVersion: 1, revision, recorder: [...recorder],
        providers: [...entries].map(([id, entry]) => ({ id, owner: entry.owner, readiness: entry.readiness ?? null, account: typeof entry.account === 'string' ? { label: entry.account } : null, models: entry.models ?? null, limits: entry.limits ?? null, updates: entry.updates, rejected: entry.rejected })),
      };
    },
    reset(): void { entries.clear(); recorder.length = 0; revision = 0; },
  };
}

const KEYS = ['id', 'owner', 'readiness', 'account', 'models', 'limits', 'updates', 'rejected'];
/** Strict reader: a shape this build does not know is empty state, never partially trusted. */
export function parseProviderStateProjection(value: unknown): ProviderStateProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || !Number.isInteger(root.revision) || !Array.isArray(root.providers) || !Array.isArray(root.recorder)) return EMPTY_PROVIDER_STATE;
  for (const item of root.providers as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || typeof item.owner !== 'string' || Object.keys(item).some(key => !KEYS.includes(key))) return EMPTY_PROVIDER_STATE;
  }
  return root as unknown as ProviderStateProjection;
}
export async function loadProviderStates(): Promise<ProviderStateProjection> {
  try { const { call } = await import('../bridge'); return parseProviderStateProjection(await call<unknown>('extensions_provider_state')); } catch { return EMPTY_PROVIDER_STATE; }
}
/** The command a provider's Sign in (`signIn`) or Sign out (`signOut`) action runs, resolved by the host (main window). */
export async function providerActionCommand(provider: string, action: 'signIn' | 'signOut'): Promise<string | null> {
  try { const { call } = await import('../bridge'); return (await call<{ command?: string }>('extensions_provider_action', { provider, action }))?.command ?? null; } catch { return null; }
}

/**
 * Main window: keeps the webview's copy of the published state current. The native roster (list_providers, the model
 * picker's catalog) already follows the host overlay; this mirror feeds `packageHarnesses` (the extension roster of the
 * header and the preview), which is republished when the state moves.
 */
export async function mountProviderStateSync(): Promise<void> {
  const [{ subscribe }, manager, harnesses, state] = await Promise.all([import('../bridge'), import('./manager'), import('./harnesses'), import('./provider-state')]);
  let reading = false, again = false;
  const read = async (): Promise<void> => {
    if (reading) { again = true; return; }
    reading = true;
    try { do { again = false; setProviderStates(await loadProviderStates()); state.setPackageProviders(harnesses.packageHarnesses(manager.extensionsSnapshot())); } while (again); } finally { reading = false; }
  };
  try { await subscribe('extensions-provider-state', () => { void read(); }); } catch { /* read once below */ }
  await read();
}

// The webview's copy of the published state, the one `packageHarnesses` applies. Native sets it from the IPC read when
// the host says it moved; the preview sets it from its stand-in.
let current: ProviderStateProjection = EMPTY_PROVIDER_STATE;
const listeners = new Set<() => void>();
export function setProviderStates(projection: ProviderStateProjection): void { current = projection; for (const listener of [...listeners]) listener(); }
export function providerStates(): ProviderStateProjection { return current; }
export function onProviderStatesChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** The provider with its published readiness, account, limits and models applied (what the picker and readiness line show). */
export function applyProviderState(provider: Provider, projection: ProviderStateProjection = current): Provider {
  const published = projection.providers.find(item => item.id === provider.id);
  if (!published) return provider;
  const metadata = { ...(provider.metadata as ProviderMetadata) } as ProviderMetadata & { account?: { label: string }; limits?: PublishedLimits };
  if (published.readiness) metadata.readiness = { ...published.readiness };
  if (published.account) metadata.account = published.account; else delete metadata.account;
  if (published.limits) metadata.limits = published.limits; else delete metadata.limits;
  const models = published.models ? published.models.map(model => ({
    id: model.id, name: model.name, description: '', reasoningEfforts: model.efforts.map(id => ({ id, name: id, description: '' })), defaultReasoningEffort: null,
    contextWindow: model.contextWindow ?? null, speedTiers: (model.speedTiers ?? []).map(tier => ({ id: tier.id, name: tier.name, description: tier.description ?? '' })),
  })) : provider.models;
  return { ...provider, metadata, models, installed: metadata.readiness.state === 'ready' };
}
