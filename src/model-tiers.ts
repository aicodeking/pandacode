/* Settings → Agent teams → Model routing → Rank models: a tier list that Panda Router weighs most. */
import './model-tiers.css';
import { escape, icon } from './dom';
import { openChoiceMenu } from './choice-menu';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import { CATALOG_MAX, teamModels, TEAM_MODELS_EVENT } from './team-catalog';
import type { Exclusions, Unhealthy } from './model-routing';
import type { ProviderId, ProviderModel } from './types';

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';
export type Tiers = Record<string, Tier>;
export interface TierModel { key: string; name: string; cardId: string | null; providers: ProviderId[]; rated: boolean }
export interface ModelTiersOptions {
  providers: { id: ProviderId; name: string; installed: boolean; models: ProviderModel[] }[];
  loadModels(provider: ProviderId): Promise<ProviderModel[]>;
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  fail(cause: unknown): void;
}

const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];
/** Row order for arrow keys; `null` is the Unranked tray. */
const ROWS: (Tier | null)[] = [...TIERS, null];
const HELP = 'Your tiers weigh most in Panda Router\'s picks: a ranked model\'s chance of success is 70% its tier and 30% the router\'s own rating, so a higher tier is usually tried first. Unranked models keep the router\'s own rating.';
const UNRATED = 'Panda Router has no rating for this model. Ranking it lets the router use it.';
/** Pointer travel before a press becomes a drag. */
const DRAG_SLOP = 4;
const rowName = (tier: Tier | null) => tier ? `tier ${tier}` : 'Unranked';

export function modelTiersHtml(): string {
  return `<div class="settings-group model-tiers" role="group" aria-label="Rank models" aria-busy="true" tabindex="-1">
    <div class="setting-row"><div><strong>Rank models ${infoMark(HELP, 'About ranking models')}</strong></div>
      <div class="tier-reset-area"><button type="button" class="secondary-button tier-add" aria-haspopup="menu" hidden>Add model…</button><button type="button" class="secondary-button tier-reset" disabled>Reset</button>
        <span class="tier-reset-confirm" hidden><span>Clear all tiers?</span><button type="button" class="secondary-button tier-reset-yes">Clear tiers</button><button type="button" class="secondary-button tier-reset-no">Cancel</button></span></div></div>
    <div class="tier-list">${ROWS.map(tier => tier
      ? `<div class="tier-row" data-tier="${tier}"><div class="tier-label" aria-hidden="true">${tier}</div><div class="tier-body" role="group" aria-label="Tier ${tier}"></div></div>`
      : `<div class="tier-row tier-unranked" data-tier=""><div class="tier-tray-title" aria-hidden="true">Unranked</div><div class="tier-body" role="group" aria-label="Unranked"><p class="tier-empty">Loading…</p></div></div>`).join('')}</div>
    <p class="sr-only tier-live" aria-live="polite"></p>
  </div>`;
}

/** Mounts into the group `modelTiersHtml()` drew. Nothing loads until `setExclusions` hands over the
 * saved Models for teams set and `setHealth` the paused models; switched-off and paused models stay out.
 * Saves run one at a time with the newest tiers, and a failure of the newest save reverts to the tiers
 * native last confirmed. */
export function mountModelTiers(group: HTMLElement, options: ModelTiersOptions): { dispose(): void; setExclusions(next: Exclusions): void; setHealth(list: Unhealthy[]): void } {
  const list = group.querySelector<HTMLElement>('.tier-list')!, live = group.querySelector<HTMLElement>('.tier-live')!;
  const reset = group.querySelector<HTMLButtonElement>('.tier-reset')!, confirm = group.querySelector<HTMLElement>('.tier-reset-confirm')!;
  let disposed = false, loaded = false, models: TierModel[] = [], saved: Tiers = {}, shown: Tiers = {};
  let version = 0, sent = 0, chain = Promise.resolve(), poolTicket = 0, lastPool = '', loadError = '';
  let exclusions: Exclusions | null = null, paused: Unhealthy[] | null = null;
  let held: { key: string; from: Tier | null; at: Tier | null } | null = null;
  // A live pointer drag holds renders until it ends, so the dragged chip is never replaced under it.
  let dragging = false, renderLater = false;
  let closeMenu: (() => void) | null = null;
  const add = group.querySelector<HTMLButtonElement>('.tier-add')!;
  let harnessModels = installedModels(options);
  // Add model… shows once a harness's catalog is long enough to be limited.
  const showAdd = () => void harnessModels.then(({ limited }) => { if (!disposed) add.hidden = limited.length === 0; });
  showAdd();

  const placeOf = (key: string): Tier | null => held?.key === key ? held.at : shown[key] ?? null;
  const nameOf = (key: string) => models.find(m => m.key === key)?.name ?? key;
  const announce = (text: string) => { live.textContent = text; };
  const chip = (m: TierModel) => {
    const tier = placeOf(m.key), unrated = m.rated ? '' : ', unrated';
    return `<span class="tier-chip-wrap" data-key="${escape(m.key)}"${held?.key === m.key ? ' data-held' : ''}>`
      + `<button type="button" class="tier-chip" data-key="${escape(m.key)}" aria-pressed="${held?.key === m.key}" aria-label="${escape(m.name)}, ${rowName(tier)}${unrated}"${loaded ? '' : ' disabled'}>`
      + `<span class="tier-logos">${m.providers.map(p => providerLogo(p, 'tier-logo')).join('')}</span><span class="tier-name">${escape(m.name)}</span>`
      + (m.rated ? '' : `<span class="tier-unrated" data-tip="${escape(UNRATED)}" aria-hidden="true"></span>`) + '</button>'
      + `<button type="button" class="tier-chip-menu" data-key="${escape(m.key)}" aria-haspopup="menu" aria-label="Move ${escape(m.name)} to…"${loaded ? '' : ' disabled'}>${icon('more')}</button></span>`;
  };
  const render = () => {
    if (dragging) { renderLater = true; return; }
    const focused = document.activeElement instanceof HTMLElement && group.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.key, focusClass = focused?.className;
    group.setAttribute('aria-busy', String(!loaded));
    reset.disabled = !loaded || Object.keys(shown).length === 0;
    list.querySelectorAll<HTMLElement>('.tier-row').forEach(row => {
      const tier = (row.dataset.tier || null) as Tier | null;
      const chips = models.filter(m => placeOf(m.key) === tier).map(chip).join('');
      const error = tier || !loadError ? '' : `<p class="tier-empty tier-error" role="alert">Models could not load: ${escape(loadError)} <button type="button" class="secondary-button tier-retry">Retry</button></p>`;
      row.querySelector('.tier-body')!.innerHTML = error + (chips || (tier || loadError ? '' : `<p class="tier-empty">${loaded ? 'Every model is ranked.' : 'Loading…'}</p>`));
    });
    if (focusKey && focusClass) list.querySelector<HTMLElement>(`.${focusClass.split(' ')[0]}[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  };

  const flush = async () => {
    if (sent === version || disposed) return;
    const mine = sent = version;
    try {
      saved = await options.call<Tiers>('model_routing_set_tiers', { tiers: { ...shown } });
      if (mine === version && !disposed) { shown = saved; render(); }
    } catch (cause) {
      if (disposed) return;
      if (mine === version) { shown = saved; render(); announce('Your tiers could not be saved.'); }
      options.fail(cause);
    }
  };
  const save = (next: Tiers) => {
    if (!loaded) return;
    shown = next; version++; render();
    chain = chain.then(flush);
  };
  // Dropping a chip on its own row saves and announces nothing.
  const move = (key: string, tier: Tier | null) => {
    if ((shown[key] ?? null) === tier) { render(); return; }
    const { [key]: _, ...rest } = shown;
    save(tier ? { ...rest, [key]: tier } : rest);
    announce(`${nameOf(key)} moved to ${rowName(tier)}.`);
  };
  const focusChip = (key: string, part: 'tier-chip' | 'tier-chip-menu') => list.querySelector<HTMLElement>(`.${part}[data-key="${CSS.escape(key)}"]`)?.focus();

  // Keyboard: Enter/Space picks a chip up, ↑/↓ or S/A/B/C/D/U carry it, Enter/Space drops, Escape puts it back.
  list.addEventListener('keydown', event => {
    const button = (event.target as Element).closest<HTMLElement>('.tier-chip');
    if (!button || !loaded) return;
    const key = button.dataset.key!;
    if (!held || held.key !== key) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      held = { key, from: shown[key] ?? null, at: shown[key] ?? null };
      render();
      announce(`Picked up ${nameOf(key)} in ${rowName(held.from)}. Use the up and down arrows or S, A, B, C, D or U to move it, Enter to drop, Escape to cancel.`);
      return;
    }
    const letter = event.key.length === 1 ? event.key.toUpperCase() : '';
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (step || 'SABCDU'.includes(letter) && letter) {
      event.preventDefault();
      held = { ...held, at: step ? ROWS[Math.min(ROWS.length - 1, Math.max(0, ROWS.indexOf(held.at) + step))] : letter === 'U' ? null : letter as Tier };
      render();
      announce(`${nameOf(key)}: ${rowName(held.at)}.`);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const at = held.at; held = null; move(key, at);
    } else if (event.key === 'Escape') {
      // Keeps Settings open.
      event.preventDefault(); event.stopPropagation();
      const from = held.from; held = null; render();
      announce(`${nameOf(key)} stays in ${rowName(from)}.`);
    }
  });
  list.addEventListener('focusout', event => {
    if (!held || (event.relatedTarget instanceof Element && event.relatedTarget.closest(`[data-key="${CSS.escape(held.key)}"]`))) return;
    // Re-rendering moves focus to the new copy of the chip; only a real leave cancels.
    queueMicrotask(() => { if (held && !list.querySelector(`.tier-chip[data-key="${CSS.escape(held.key)}"]`)?.matches(':focus')) { held = null; render(); } });
  });

  // Pointer drag: the chip follows the pointer and the row under it lights up.
  list.addEventListener('pointerdown', event => {
    const button = (event.target as Element).closest<HTMLElement>('.tier-chip');
    if (!button || !loaded || event.button !== 0) return;
    const key = button.dataset.key!, wrap = button.parentElement!, startX = event.clientX, startY = event.clientY;
    let target: HTMLElement | null = null;
    const onMove = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      dragging = true; wrap.dataset.dragging = '';
      wrap.style.translate = `${e.clientX - startX}px ${e.clientY - startY}px`;
      const row = document.elementsFromPoint(e.clientX, e.clientY).filter(el => !wrap.contains(el)).map(el => el.closest<HTMLElement>('.tier-row')).find(r => r && list.contains(r)) ?? null;
      if (row !== target) { target?.removeAttribute('data-drop'); target = row; target?.setAttribute('data-drop', ''); }
    };
    const onEnd = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onEnd); window.removeEventListener('pointercancel', onEnd);
      target?.removeAttribute('data-drop');
      delete wrap.dataset.dragging; wrap.style.translate = '';
      const dropped = dragging && target && e.type === 'pointerup';
      dragging = false;
      if (dropped) move(key, (target!.dataset.tier || null) as Tier | null);
      else if (renderLater) render();
      renderLater = false;
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onEnd); window.addEventListener('pointercancel', onEnd);
  });

  list.addEventListener('click', event => {
    if ((event.target as Element).closest('.tier-retry')) { loadError = ''; render(); group.focus(); loadPool(); return; }
    const trigger = (event.target as Element).closest<HTMLElement>('.tier-chip-menu');
    if (!trigger || !loaded) return;
    const key = trigger.dataset.key!, current = shown[key] ?? null;
    let moved: string | null = null;
    closeMenu?.();
    closeMenu = openChoiceMenu({
      anchor: trigger, title: `Move ${nameOf(key)} to`,
      items: ROWS.map(tier => ({ id: tier ?? 'U', label: tier ? `Tier ${tier}` : 'Unranked', selected: tier === current })),
      onSelect: id => { moved = key; move(key, id === 'U' ? null : id as Tier); },
      // The trigger was redrawn in the chip's new row; focus that copy.
      onClose: () => { closeMenu = null; if (moved) focusChip(moved, 'tier-chip-menu'); moved = null; },
    });
  });

  reset.addEventListener('click', () => { reset.hidden = true; confirm.hidden = false; confirm.querySelector<HTMLElement>('.tier-reset-no')!.focus(); });
  const endReset = () => { confirm.hidden = true; reset.hidden = false; render(); };
  confirm.querySelector('.tier-reset-no')!.addEventListener('click', () => { endReset(); reset.focus(); });
  // Reset is disabled now, so focus lands on the first chip, else the group.
  confirm.querySelector('.tier-reset-yes')!.addEventListener('click', () => {
    save({}); announce('All tiers cleared.'); endReset();
    (list.querySelector<HTMLElement>('.tier-chip') ?? group).focus();
  });

  // The pool follows Models for teams and model health; a newer pool replaces an older one still loading.
  const loadPool = () => {
    if (!exclusions || !paused || disposed) return;
    const off = exclusions, down = paused;
    const fingerprint = JSON.stringify([off, down.map(h => `${h.provider}\n${h.providerDown ? '' : h.model}`).sort()]);
    if (fingerprint === lastPool) return;
    lastPool = fingerprint;
    const ticket = ++poolTicket;
    void (async () => {
      try {
        // Native drops `default` entries that resolve to no card; resolved ones join their model's chip.
        const pool = (await harnessModels).pool.filter(m => !off.providers.includes(m.provider) && !off.models.some(x => x.provider === m.provider && x.model === m.model)
          && !down.some(h => h.provider === m.provider && (h.providerDown || h.model === m.model))).slice(0, CATALOG_MAX);
        const [rows, tiers] = await Promise.all([options.call<TierModel[]>('model_routing_tier_models', { pool }), loaded ? null : options.call<Tiers>('model_routing_tiers')]);
        if (disposed || ticket !== poolTicket) return;
        models = rows; held = null; loadError = '';
        if (tiers) { saved = shown = tiers; loaded = true; }
        render();
        if (document.activeElement === group) (list.querySelector<HTMLElement>('.tier-chip') ?? group).focus();
      } catch (cause) {
        if (disposed || ticket !== poolTicket) return;
        // Retry reloads the same pool.
        loadError = cause instanceof Error ? cause.message : String(cause); lastPool = ''; render();
      }
    })();
  };
  // Models added for teams join the pool; a ranked model that left it keeps its tier.
  const onAdded = () => {
    if (disposed) return;
    harnessModels = installedModels(options); lastPool = ''; showAdd(); loadPool();
  };
  window.addEventListener(TEAM_MODELS_EVENT, onAdded);
  add.addEventListener('click', () => void harnessModels.then(({ limited }) => {
    if (disposed || !limited.length) return;
    closeMenu?.();
    let picked: ProviderId | null = null;
    closeMenu = openChoiceMenu({
      anchor: add, title: 'Add a model from', actions: true,
      items: limited.map(p => ({ id: p.id, label: p.name, provider: p.id })),
      onSelect: id => { picked = id as ProviderId; },
      onClose: () => {
        closeMenu = null;
        const id = picked; picked = null;
        if (!id) return;
        void import('./team-model-add').then(({ openAddTeamModels }) => openAddTeamModels({ provider: id, name: limited.find(p => p.id === id)!.name, loadModels: options.loadModels, trigger: () => add }));
      },
    });
  }));
  const setExclusions = (next: Exclusions) => { exclusions = next; loadPool(); };
  const setHealth = (list: Unhealthy[]) => { paused = list; loadPool(); };

  render();
  return { dispose: () => { disposed = true; closeMenu?.(); window.removeEventListener(TEAM_MODELS_EVENT, onAdded); }, setExclusions, setHealth };
}

/** Each installed harness's discovered models (its built-in list when discovery fails) that teams use, as tier pool
 * entries, and the harnesses whose long catalogs are limited. */
async function installedModels(options: ModelTiersOptions): Promise<{ pool: { provider: ProviderId; model: string; name: string }[]; limited: { id: ProviderId; name: string }[] }> {
  const installed = options.providers.filter(p => p.installed);
  const loaded = await Promise.allSettled(installed.map(p => options.loadModels(p.id)));
  const teams = installed.map((p, i) => teamModels(p.id, loaded[i].status === 'fulfilled' && loaded[i].value.length ? loaded[i].value : p.models));
  return {
    pool: installed.flatMap((p, i) => teams[i].models.filter(m => m.id).map(m => ({ provider: p.id, model: m.id, name: m.name }))),
    limited: installed.filter((_, i) => teams[i].limited).map(p => ({ id: p.id, name: p.name })),
  };
}
