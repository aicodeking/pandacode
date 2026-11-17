/**
 * Speed tiers and warm spares of declared package harnesses (runtime slice R0807).
 *
 * The authority is native (`src-tauri/src/extensions/runtime_provider_speed.rs`, IPC `extensions_provider_speed`,
 * `extensions_provider_speed_optin`). This module is its webview side and the browser preview's labelled stand-in: the
 * same pure rules (a tier survives only while the selected model lists it; the spare key ignores model, effort and
 * tier), a stand-in spare registry with the same counters and attributed events, and the opt-in control of the
 * Extensions page. The preview starts no process: a "spare" there is a record, never an executable.
 *
 * Defaults and conditions are the native ones: demand only; a package takes part only when its provider declares
 * `launch.warmSpare`, the user opted it in (bound to the installed executable digest) and it is enabled, trusted and
 * ready. No secret value is ever part of a record or a projection.
 */
import { call } from '../bridge';
import { escape } from '../dom';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Tier { id: string; name?: string }
export interface Model { id: string; speedTiers?: Tier[] }
export const IDLE_SECONDS = 600;
export const LIMIT = 2;
export const RECORDER = 128;

export interface Selection { model: string; effort: string | null; tier: string | null; droppedTier: string | null }

/** The tier a send carries: the saved one only while the selected model still lists it (a model switch drops a stale one). */
export function selection(model: string, effort: string | null, saved: string | null | undefined, models: readonly Model[]): Selection {
  const listed = models.find(entry => entry.id === model)?.speedTiers?.some(tier => tier.id === saved) === true;
  return { model, effort, tier: saved && listed ? saved : null, droppedTier: saved && !listed ? saved : null };
}
/** The `_meta.pandacode` object of `session/new`. */
export const launchMeta = (owner: string, picked: Selection): Json => ({ extension: owner, model: picked.model, effort: picked.effort, speedTier: picked.tier });
/** The tier the picker may persist: none (standard speed) or one listed by that model; otherwise `Choose a valid speed.` */
export function validatedTier(models: readonly Model[], model: string, tier: string | null): string | null {
  if (tier === null) return null;
  if (!models.find(entry => entry.id === model)?.speedTiers?.some(entry => entry.id === tier)) throw new Error('Choose a valid speed.');
  return tier;
}

export interface Resolved { program: string; arguments: string[]; env: Record<string, string> }
/** What shapes the process; models, efforts and tiers are deliberately absent. */
export const spareKey = (provider: string, digest: string, resolved: Resolved, cwd: string): string =>
  JSON.stringify({ provider, digest, program: resolved.program, arguments: resolved.arguments, env: resolved.env, cwd });

/** What a prewarm is allowed to see: the facts the native `warm_context` reads. */
export interface WarmContext { enabled: boolean; trusted: boolean; declared: boolean; ready: boolean; digest: string; key: string; startAhead?: boolean }
export interface Counters { spawns: number; warmStarted: number; warmAdopted: number; warmDiscarded: number; warmFailed: number }
export interface SpeedEvent { seq: number; extension: string; what: string; [key: string]: Json | undefined }

type Spare = { owner: string; key: string; born: number; generation: number; pid: number };

/** The preview's stand-in of the native registry. `clock` is injectable so expiry can be checked without waiting. */
export function createSpeedPreview(clock: () => number = () => Date.now()) {
  const optIn = new Map<string, string>();
  const spares = new Map<string, Spare | { starting: number; owner: string; key: string }>();
  const counters = new Map<string, Counters>();
  const events: SpeedEvent[] = [];
  let seq = 0, generation = 0, pids = 100;
  const count = (owner: string): Counters => { let value = counters.get(owner); if (!value) counters.set(owner, value = { spawns: 0, warmStarted: 0, warmAdopted: 0, warmDiscarded: 0, warmFailed: 0 }); return value; };
  const note = (owner: string, what: string, detail: Record<string, Json> = {}) => {
    events.push({ ...detail, seq: ++seq, extension: owner, what });
    if (events.length > RECORDER) events.shift();
  };
  const discarded = (owner: string, reason: string) => { count(owner).warmDiscarded += 1; note(owner, 'spareDiscarded', { reason }); };
  const ownerOf = (provider: string) => (/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\//.test(provider) ? provider.split('/')[0] : null);
  const readySpares = () => [...spares.entries()].filter((entry): entry is [string, Spare] => 'pid' in entry[1]);

  return {
    /** Opts a package in (the installed digest) or out (null); opt-out ends its spares. */
    setOptIn(owner: string, digest: string | null): boolean {
      const before = optIn.get(owner) ?? null;
      if (digest === null) optIn.delete(owner); else optIn.set(owner, digest);
      if (before === digest) return false;
      note(owner, digest ? 'optIn' : 'optOut');
      if (digest === null) this.discardOwner(owner, 'optOut');
      return true;
    },
    participates: (provider: string): boolean => { const owner = ownerOf(provider); return owner !== null && optIn.has(owner); },
    present: (session: string): boolean => spares.has(session),
    /** Starts (or keeps) the task's spare; nothing unless every condition holds. Returns whether a spare is now present. */
    prewarm(provider: string, session: string, context: WarmContext): boolean {
      const owner = ownerOf(provider);
      if (!owner || !this.participates(provider) || context.startAhead === false) return false;
      if (!context.enabled || !context.trusted || !context.declared || !context.ready) { this.discardSession(session, 'ineligible'); note(owner, 'spareSkipped', { provider, session }); return false; }
      if (optIn.get(owner) !== context.digest) { optIn.delete(owner); this.discardOwner(owner, 'optInRevoked'); return false; }
      const held = spares.get(session);
      if (held && held.key === context.key && held.owner === owner) return true;
      if (held) { spares.delete(session); discarded(held.owner, 'replaced'); }
      while (spares.size >= LIMIT) {
        const oldest = readySpares().sort((a, b) => a[1].born - b[1].born)[0];
        if (!oldest) break;
        spares.delete(oldest[0]); discarded(oldest[1].owner, 'replaced');
      }
      spares.set(session, { owner, key: context.key, born: clock(), generation: ++generation, pid: ++pids });
      const state = count(owner); state.spawns += 1; state.warmStarted += 1;
      note(owner, 'spareStarted', { provider, session });
      return true;
    },
    /** A send adopts the spare for exactly this launch; any other is discarded and the send starts cold. */
    take(session: string, owner: string, key: string, alive = true): boolean {
      const held = spares.get(session);
      spares.delete(session);
      if (!held) return false;
      if (!('pid' in held)) { note(held.owner, 'spareNotReady', { session }); return false; }
      const reason = held.owner !== owner ? 'foreignOwner' : held.key !== key ? 'launchChanged' : clock() - held.born >= IDLE_SECONDS * 1000 ? 'expired' : !alive ? 'exited' : null;
      if (reason) { discarded(held.owner, reason); return false; }
      count(owner).warmAdopted += 1; note(owner, 'spareAdopted', { session });
      return true;
    },
    /** A send that started its own process (no spare adopted). */
    coldStart(owner: string): void { count(owner).spawns += 1; },
    discardOwner(owner: string | null, reason = 'packageStopped'): void {
      for (const [session, held] of [...spares]) if (owner === null || held.owner === owner) { spares.delete(session); discarded(held.owner, reason); }
    },
    discardSession(session: string, reason: string): void { const held = spares.get(session); if (held) { spares.delete(session); discarded(held.owner, reason); } },
    discardAll(): void { this.discardOwner(null, 'startAheadOff'); },
    recordLaunch(owner: string, provider: string, session: string, picked: Selection, warm: boolean): void {
      if (picked.droppedTier) note(owner, 'tierDropped', { provider, session, model: picked.model, speedTier: picked.droppedTier });
      note(owner, 'launch', { provider, session, model: picked.model, effort: picked.effort, speedTier: picked.tier, warm });
    },
    recordPick(provider: string, session: string, model: string, tier: string | null): void { const owner = ownerOf(provider); if (owner) note(owner, 'tierSelected', { provider, session, model, speedTier: tier }); },
    counters: (owner: string): Counters => ({ ...count(owner) }),
    events: (): SpeedEvent[] => events.map(event => ({ ...event })),
    /** Only declaring packages; never the key or the digest. */
    projection(packages: readonly { manifest: { id: string; contributes?: { providers?: { id: string; launch?: { warmSpare?: boolean } }[] } }; enabled?: boolean; executable?: { digest: string; trusted: boolean } | null }[]): Projection {
      const rows = packages.flatMap(item => {
        const providers = (item.manifest.contributes?.providers ?? []).filter(provider => provider.launch?.warmSpare === true).map(provider => provider.id);
        if (!providers.length) return [];
        const id = item.manifest.id, state = count(id);
        return [{ id, providers, enabled: item.enabled === true, trusted: item.executable?.trusted === true, optedIn: !!item.executable && optIn.get(id) === item.executable.digest, spares: [...spares.values()].filter(held => held.owner === id).length, counters: { ...state } }];
      });
      return { schemaVersion: 1, available: true, limit: LIMIT, idleSeconds: IDLE_SECONDS, packages: rows, events: events.map(event => ({ ...event })) };
    },
  };
}

export interface Projection { schemaVersion: 1; available: boolean; limit: number; idleSeconds: number; packages: PackageRow[]; events: SpeedEvent[] }
export interface PackageRow { id: string; providers: string[]; enabled: boolean; trusted: boolean; optedIn: boolean; spares: number; counters: Counters }

export async function loadSpeed(): Promise<Projection> { return call<Projection>('extensions_provider_speed'); }
export async function setWarmSpare(id: string, enabled: boolean): Promise<Projection> { return call<Projection>('extensions_provider_speed_optin', { id, enabled }); }

/** The "Start harnesses ahead" rows of the Extensions page: one checkbox per package that declares a warm-spare harness. Default off. */
export function mountWarmSpareSettings(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '', shown: Projection | null = null;
  const draw = () => {
    if (disposed) return;
    const rows = shown?.packages ?? [];
    host.innerHTML = rows.length ? `<h3>Start harnesses ahead</h3><p>An extension harness that declares it can be started before you send, so the first reply is faster. It is off until you turn it on here, only runs while the extension is enabled and trusted, and ends when you turn it off or disable the extension. It also follows Settings → Agents → Start agents ahead.</p>
      ${rows.map(row => `<label class="setting-row" data-warm-spare="${escape(row.id)}"><input type="checkbox" data-warm-spare-id="${escape(row.id)}" ${row.optedIn ? 'checked' : ''} ${pending || !row.enabled || !row.trusted ? 'disabled' : ''}> <span>${escape(row.id)}: start ahead</span><small>${row.spares} ready · ${row.counters.warmStarted} started · ${row.counters.warmAdopted} used</small></label>`).join('')}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}` : '';
  };
  const change = async (event: Event) => {
    const box = event.target instanceof HTMLInputElement ? event.target.closest<HTMLInputElement>('[data-warm-spare-id]') : null;
    if (!box || pending) return;
    pending = true; error = ''; draw();
    try { shown = await setWarmSpare(box.dataset.warmSpareId ?? '', box.checked); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); try { shown = await loadSpeed(); } catch { /* keep the last view */ } }
    finally { pending = false; draw(); }
  };
  host.addEventListener('change', change);
  void loadSpeed().then(value => { shown = value; draw(); }).catch(() => undefined);
  return () => { disposed = true; host.removeEventListener('change', change); host.replaceChildren(); };
}
