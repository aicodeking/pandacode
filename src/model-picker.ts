import type { ContextUsage, Provider, ProviderId, ProviderModel } from './types';
import { fallbackModel, modelChoices, tokenCount } from './model-catalog';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { showPopover, hidePopover } from './popover-motion';

/** A named agent team from Settings, offered beside the models. */
export type PickerTeam = { id: string; name: string; detail: string; provider: ProviderId; selected: boolean };
/** A named connection from Settings: its harness's models listed again under its name. */
export type PickerConnection = { id: string; name: string; provider: ProviderId };
type ModelPickerOptions = {
  teams?: PickerTeam[];
  onTeamSelect?: (id: string) => Promise<void>;
  anchor: HTMLElement;
  providers: Provider[];
  current: { provider: ProviderId; model: string; reasoningEffort?: string | null; contextUsage?: ContextUsage | null };
  canSwitchProvider: boolean;
  connections?: PickerConnection[];
  /** The task's connection; null is the harness's own setup. */
  currentConnection?: string | null;
  onSelect: (provider: ProviderId, model: string, connection: string | null) => Promise<void>;
  onEffortSelect?: (effort: string | null) => Promise<void>;
  loadModels?: (provider: ProviderId) => Promise<ProviderModel[]>;
  /** Another computer's harnesses: the picker opens with a loading row, then lists them, or one disabled row with the error. */
  loadProviders?: () => Promise<Provider[]>;
  /** Model IDs to list first in a shortened catalog, newest first; null lists every model. Search always covers all. */
  recent?: (provider: ProviderId) => string[] | null;
  onClose?: () => void;
  placement?: 'above' | 'below';
};

const RECENT_LIMIT = 5;
const recentKey = (provider: ProviderId) => `pandacode.recent-models.${provider}`;
function storedRecent(provider: ProviderId): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(recentKey(provider)) || '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}
function rememberRecent(provider: ProviderId, model: string): void {
  if (model === 'default') return;
  try { localStorage.setItem(recentKey(provider), JSON.stringify([model, ...storedRecent(provider).filter(id => id !== model)].slice(0, RECENT_LIMIT))); } catch { /* Ordering only. */ }
}

const optionKey = (button: HTMLElement) => `${button.dataset.connection ?? ''}|${button.dataset.provider}:${button.dataset.model}`;

/** A transient picker with local state and listeners released on dismissal. */
export function openModelPicker(options: ModelPickerOptions): () => void {
  const { anchor, current, canSwitchProvider, onSelect, onEffortSelect, loadModels, onClose } = options;
  let providers = options.providers.map(provider => ({ ...provider, models: [...provider.models] }));
  const catalogErrors = new Map<ProviderId, string>();
  const catalogLoading = new Set<ProviderId>();
  const particles = Array.from({ length: 12 }, (_, i) => `<i style="left:${4 + i * 8}%;top:${18 + i * 29 % 58}%;--drift-duration:${2.2 + i % 4 * .4}s;--drift-delay:${-i * .37}s"></i>`).join('');
  const panel = document.createElement('section');
  panel.className = 'model-menu floating-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Harness and model');
  panel.innerHTML = `<div class="model-menu-search">${icon('search')}<input type="search" aria-label="Search harnesses and models" placeholder="Search harnesses and models…" autocomplete="off" spellcheck="false" maxlength="200"></div>${canSwitchProvider ? '' : '<p class="model-menu-note">Start a new task to switch harnesses.</p>'}<div class="model-menu-list"></div><div class="model-menu-settings" hidden></div><p class="model-menu-catalog-error" role="status" hidden></p><p class="model-menu-error" role="alert" hidden></p><p class="model-menu-pending" role="status" hidden>Applying…</p>`;
  const search = panel.querySelector<HTMLInputElement>('input')!;
  const list = panel.querySelector<HTMLElement>('.model-menu-list')!;
  const settings = panel.querySelector<HTMLElement>('.model-menu-settings')!;
  const error = panel.querySelector<HTMLElement>('.model-menu-error')!;
  const catalogError = panel.querySelector<HTMLElement>('.model-menu-catalog-error')!;
  const pendingStatus = panel.querySelector<HTMLElement>('.model-menu-pending')!;
  const anchorId = anchor.id;
  const anchorAction = anchor.dataset.action;
  const originalExpanded = anchor.getAttribute('aria-expanded');
  let pending = false;
  let providersStatus = options.loadProviders ? 'Loading…' : '';
  let closed = false;
  let pointerInside = false;
  let pointerRelease = 0;
  let activeKey = '';
  let positionFrame = 0;
  let choicesMarkup = '';
  let settingsKey = '';
  let draggingEffort = false;
  let pendingEffort: string | null | undefined;
  let displayedEfforts: NonNullable<ProviderModel['reasoningEfforts']> = [];


  function restoreFocus(): void {
    let target: HTMLElement | null = anchor.isConnected ? anchor : null;
    if (!target && anchorId) target = document.getElementById(anchorId);
    if (!target && anchorAction) target = document.querySelector<HTMLElement>(`[data-action="${CSS.escape(anchorAction)}"]`);
    target?.focus({ preventScroll: true });
  }

  function close(shouldRestoreFocus = true): void {
    if (closed) return;
    closed = true;
    clearTimeout(pointerRelease);
    cancelAnimationFrame(positionFrame);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('pointerup', onPointerEnd, true);
    document.removeEventListener('pointercancel', onPointerEnd, true);
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition);
    window.visualViewport?.removeEventListener('scroll', schedulePosition);
    hidePopover(panel);
    if (originalExpanded === null) anchor.removeAttribute('aria-expanded');
    else anchor.setAttribute('aria-expanded', originalExpanded);
    if (shouldRestoreFocus) restoreFocus();
    onClose?.();
  }

  function position(): void {
    positionFrame = 0;
    if (closed) return;
    if (!anchor.isConnected) { close(); return; }
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const padding = 12;
    const below = options.placement === 'below';
    const maxHeight = below ? Math.max(80, viewportTop + height - rect.bottom - gap - padding) : Math.max(80, height - padding * 2);
    panel.style.width = `${Math.max(0, Math.min(380, width - padding * 2))}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    const measuredHeight = panel.offsetHeight;
    // Prefer the space above the composer; clamp when the window is short.
    const left = Math.max(viewportLeft + padding, Math.min(rect.left, viewportLeft + width - panel.offsetWidth - padding));
    const top = Math.max(viewportTop + padding, Math.min(below ? rect.bottom + gap : rect.top - measuredHeight - gap, viewportTop + height - measuredHeight - padding));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.dataset.placement = below ? 'below' : 'above';
  }

  function schedulePosition(): void {
    if (!positionFrame && !closed) positionFrame = requestAnimationFrame(position);
  }

  function enabledButtons(): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  }

  function setActive(button?: HTMLButtonElement, focus = false): void {
    list.querySelectorAll('.model-menu-active').forEach(el => el.classList.remove('model-menu-active'));
    if (!button) { activeKey = ''; return; }
    activeKey = optionKey(button);
    button.classList.add('model-menu-active');
    if (focus) button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  }

  function renderSettings(): void {
    // Keep the native thumb attached to the pointer while other catalogs finish loading.
    if (draggingEffort) return;
    const provider = providers.find(provider => provider.id === current.provider);
    const model = modelChoices(current.provider, provider?.models ?? [], current.model).find(model => model.id === current.model)!;
    const efforts = model.reasoningEfforts ?? [];
    const canSetEffort = Boolean(onEffortSelect && (efforts.length || current.reasoningEffort));
    settings.hidden = !canSetEffort;
    const defaultEffort = efforts.find(effort => effort.id === model.defaultReasoningEffort);
    const defaultDescription = `Use the harness's saved settings.${defaultEffort ? ` Reported model default: ${defaultEffort.name}.` : ''}`;
    const markup = `${canSetEffort ? `<div class="effort-control">${efforts.length ? `<div class="effort-track"><span class="effort-track-background" aria-hidden="true"><span class="effort-fill"><span class="effort-particles">${particles}</span></span></span><input type="range" class="effort-range" aria-label="Reasoning effort" min="0" max="${efforts.length - 1}" step="1"></div>` : ''}<span class="effort-label"></span></div>` : ''}`;
    const key = JSON.stringify([markup, efforts]);
    if (key !== settingsKey) {
      const focused = settings.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      settings.innerHTML = markup;
      settingsKey = key;
      displayedEfforts = efforts;
      if (focused) (settings.querySelector<HTMLElement>('.effort-range') ?? search).focus({ preventScroll: true });
    }
    const chosen = pendingEffort !== undefined ? pendingEffort : current.reasoningEffort;
    const index = Math.max(0, efforts.findIndex(effort => effort.id === (chosen ?? model.defaultReasoningEffort)));
    const selected = efforts.find(effort => effort.id === chosen);
    const label = chosen ? selected?.name ?? chosen : 'Default';
    updateEffortPreview(index, label, chosen ? selected?.description ?? '' : defaultDescription);
    const range = settings.querySelector<HTMLInputElement>('.effort-range');
    if (range) range.disabled = pending || !provider?.installed;
  }

  function updateControls(): void {
    panel.setAttribute('aria-busy', String(pending));
    pendingStatus.hidden = !pending;
    list.querySelectorAll<HTMLButtonElement>('.model-menu-option[data-available="true"]').forEach(button => { button.disabled = pending; });
    renderSettings();
  }

  function updateEffortPreview(index: number, name: string, description: string): void {
    const label = settings.querySelector<HTMLElement>('.effort-label');
    const title = [name, description].filter(Boolean).join(' · ');
    if (label) {
      if (label.textContent !== name) label.textContent = name;
      label.title = title;
    }
    const range = settings.querySelector<HTMLInputElement>('.effort-range');
    if (!range) return;
    range.value = String(index);
    range.setAttribute('aria-valuetext', name);
    range.title = title;
    const progress = displayedEfforts.length > 1 ? index / (displayedEfforts.length - 1) : 1;
    settings.style.setProperty('--effort-progress', String(progress));
  }

  async function saveEffort(effort: string | null): Promise<void> {
    const provider = providers.find(provider => provider.id === current.provider);
    if (pending || closed || !onEffortSelect || !provider?.installed) return;
    const supported = provider.models.find(model => model.id === current.model)?.reasoningEfforts ?? [];
    if (effort !== null && !supported.some(choice => choice.id === effort)) {
      error.textContent = 'This reasoning effort is no longer available. Choose another level.';
      error.hidden = false;
      renderSettings();
      position();
      return;
    }
    if (effort === (current.reasoningEffort ?? null)) { renderSettings(); return; }
    const focused = settings.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    pending = true;
    pendingEffort = effort;
    error.hidden = true;
    updateControls();
    position();
    try {
      await onEffortSelect(effort);
      current.reasoningEffort = effort;
    } catch (reason) {
      if (closed) return;
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
    } finally {
      if (!closed) {
        pending = false;
        pendingEffort = undefined;
        updateControls();
        position();
        // A disabled control can lose focus during the save; leave deliberate navigation alone.
        if (focused && document.activeElement === document.body) {
          (settings.querySelector<HTMLElement>('.effort-range:not(:disabled)') ?? search).focus({ preventScroll: true });
        }
      }
    }
  }

  /** Default plus the most recent models, padded from the catalog, when the caller asks for a short list. */
  function shortList(provider: ProviderId, models: ProviderModel[]): ProviderModel[] {
    const recent = options.recent?.(provider);
    if (!recent) return models;
    const byId = new Map(models.map(model => [model.id, model]));
    const first = [...(provider === current.provider ? [current.model] : []), ...recent, ...storedRecent(provider)].filter(id => id !== 'default' && byId.has(id));
    const ids = [...new Set([...first, ...models.map(model => model.id).filter(id => id !== 'default')])].slice(0, RECENT_LIMIT);
    return [byId.get('default')!, ...ids.map(id => byId.get(id)!)];
  }
  function renderChoices(): void {
    if (closed) return;
    const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLButtonElement>('.model-menu-option') : null;
    const focusedKey = focused ? optionKey(focused) : '';
    const query = search.value.trim();
    const normalized = query.toLowerCase();
    const namedHarness = providers.some(provider => [provider.id, provider.name].some(name => name.toLowerCase() === normalized));
    let total = 0;
    const teams = (options.teams ?? []).filter(team => !query || [team.name, team.detail, 'team'].some(value => value.toLowerCase().includes(normalized)));
    const teamSelected = options.teams?.some(team => team.selected) ?? false;
    total += teams.length;
    const teamMarkup = teams.length ? `<section class="model-menu-group" aria-label="Agent teams"><div class="model-menu-group-heading"><h3>${icon('worktree')}Agent teams</h3></div>${teams.map(team => `<button type="button" class="model-menu-option model-menu-team${team.selected ? ' model-menu-current' : ''}" data-team="${escape(team.id)}" data-provider="team" data-model="${escape(team.id)}" data-available="true" aria-label="${escape(`Agent team · ${team.name}`)}" title="${escape(team.detail)}" ${team.selected ? 'aria-current="true"' : ''}>${providerLogo(team.provider)}<span class="model-menu-option-label"><span>${escape(team.name)}</span><span class="model-menu-description">${escape(team.detail)}</span></span>${team.selected ? icon('check') : ''}</button>`).join('')}</section>` : '';
    const connections = options.connections ?? [];
    const currentConnection = options.currentConnection ?? null;
    let markup = teamMarkup + providers.flatMap(provider => [null, ...connections.filter(c => c.provider === provider.id)].map(connection => ({ provider, connection }))).map(({ provider, connection }) => {
      const groupName = connection?.name ?? provider.name;
      const models = modelChoices(provider.id, provider.models, provider.id === current.provider ? current.model : '');
      const providerMatches = [provider.id, provider.name, groupName].some(name => name.toLowerCase().includes(normalized));
      const visible = query ? models.filter(model => providerMatches || [model.id, model.name, model.description].some(value => value.toLowerCase().includes(normalized))) : shortList(provider.id, models);
      const locked = !canSwitchProvider && provider.id !== current.provider;
      const unavailable = !provider.installed;
      const custom = provider.id !== 'github-copilot' && Boolean(query && !namedHarness && !models.some(model => [model.id, model.name].some(value => value.toLowerCase() === normalized)) && !locked);
      if (!visible.length && !custom) return '';
      const disabled = locked || unavailable;
      const row = (model: ProviderModel, isCustom: boolean): string => {
        total++;
        const selected = !teamSelected && provider.id === current.provider && model.id === (current.model || 'default') && (connection?.id ?? null) === currentConnection;
        const accessible = isCustom ? `Use "${model.id}" with ${groupName}` : `${groupName} · ${model.name}`;
        const detail = [model.contextWindow ? `${tokenCount(model.contextWindow)} context` : '', model.description || (model.name !== model.id && model.id !== 'default' ? model.id : '')].filter(Boolean).join(' · ');
        return `<button type="button" class="model-menu-option${selected ? ' model-menu-current' : ''}" data-provider="${provider.id}" data-model="${escape(model.id)}"${connection ? ` data-connection="${escape(connection.id)}"` : ''} data-available="${!disabled}" aria-label="${escape(accessible)}" title="${escape(detail)}" ${selected ? 'aria-current="true"' : ''} ${disabled ? 'disabled' : ''}>${providerLogo(provider.id)}<span class="model-menu-option-label">${isCustom ? `<span class="model-menu-custom-label">Use custom model</span><span>${escape(model.id)}</span>` : `<span>${escape(model.name)}</span>${detail ? `<span class="model-menu-description">${escape(detail)}</span>` : ''}`}</span>${selected ? icon('check') : isCustom ? icon('plus') : ''}</button>`;
      };
      return `<section class="model-menu-group" aria-label="${escape(groupName)}"${connection ? ` data-connection-group="${escape(connection.id)}"` : ''}><div class="model-menu-group-heading"><h3>${providerLogo(provider.id)}${escape(groupName)}</h3>${locked ? '<span>New task required</span>' : unavailable ? '<span>Unavailable</span>' : `<span data-catalog-loading="${provider.id}" hidden>Loading…</span>`}</div>${visible.map(model => row(model, false)).join('')}${custom ? row(fallbackModel(provider.id, query), true) : ''}</section>`;
    }).join('');
    if (providersStatus) markup = `<button type="button" class="model-menu-option" data-available="false" disabled>${icon('monitor')}<span class="model-menu-option-label"><span>${escape(providersStatus)}</span></span></button>`;
    else if (!total) markup = '<p class="model-menu-empty">No matching models.</p>';
    // Loading and saving are in-place updates: retain rows, focus and scroll position.
    if (markup !== choicesMarkup) {
      list.innerHTML = markup;
      choicesMarkup = markup;
      const buttons = enabledButtons();
      const restore = buttons.find(button => optionKey(button) === focusedKey);
      const next = restore ?? buttons.find(button => optionKey(button) === activeKey) ?? buttons.find(button => button.getAttribute('aria-current') === 'true') ?? buttons[0];
      setActive(next, Boolean(focused));
      if (focused && !next) search.focus({ preventScroll: true });
    }
    list.querySelectorAll<HTMLElement>('[data-catalog-loading]').forEach(status => { status.hidden = !catalogLoading.has(status.dataset.catalogLoading as ProviderId); });
    catalogError.hidden = catalogErrors.size === 0;
    catalogError.textContent = catalogErrors.size ? `Could not load models for ${providers.filter(provider => catalogErrors.has(provider.id)).map(provider => { const reason = catalogErrors.get(provider.id)?.replace(/\.$/, ''); return reason ? `${provider.name} (${reason})` : provider.name; }).join(', ')}. You can enter model IDs for agents that support custom models.` : '';
    updateControls();
    position();
  }

  async function select(button: HTMLButtonElement): Promise<void> {
    if (pending || closed || button.disabled) return;
    pending = true;
    error.hidden = true;
    updateControls();
    position();
    try {
      if (button.dataset.team) await options.onTeamSelect?.(button.dataset.team);
      else {
        await onSelect(button.dataset.provider as ProviderId, button.dataset.model!, button.dataset.connection ?? null);
        if (options.recent) rememberRecent(button.dataset.provider as ProviderId, button.dataset.model!);
      }
      close();
    } catch (reason) {
      if (closed) return;
      pending = false;
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
      renderChoices();
      search.focus({ preventScroll: true });
    }
  }

  function onOutside(event: PointerEvent): void {
    const target = event.target as Node | null;
    // Keep trigger focus from closing the menu before its click can toggle it.
    // Keyboard focus still dismisses normally when tabbing out of the picker.
    if (target && anchor.contains(target)) { clearTimeout(pointerRelease); pointerInside = true; return; }
    if (target && !panel.contains(target)) close(false);
  }

  function onPointerEnd(): void {
    clearTimeout(pointerRelease);
    // WebKit may move focus to the modal between pointerdown and click. Keep
    // the option alive until its click has selected the model.
    pointerRelease = window.setTimeout(() => { pointerInside = false; }, 0);
  }
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  search.addEventListener('input', renderChoices);
  settings.addEventListener('pointerdown', event => {
    const range = event.target as HTMLInputElement;
    if (event.button === 0 && event.isPrimary && range.matches('.effort-range') && !range.disabled && !pending) {
      draggingEffort = true;
      // Let the native thumb own capture; overriding it prevents dragging in WebKit.
    }
  });
  settings.addEventListener('input', event => {
    const range = event.target as HTMLInputElement;
    if (!range.matches('.effort-range') || pending) return;
    const effort = displayedEfforts[Number(range.value)];
    if (effort) updateEffortPreview(Number(range.value), effort.name, effort.description);
  });
  settings.addEventListener('change', event => {
    const range = event.target as HTMLInputElement;
    if (!range.matches('.effort-range')) return;
    draggingEffort = false;
    const effort = displayedEfforts[Number(range.value)];
    if (effort) void saveEffort(effort.id);
  });
  settings.addEventListener('pointerup', event => {
    if (!draggingEffort) return;
    draggingEffort = false;
    const effort = displayedEfforts[Number((event.target as HTMLInputElement).value)];
    // A tap on the current thumb still chooses that explicit level from Default.
    if (effort) void saveEffort(effort.id);
  });
  settings.addEventListener('pointercancel', () => { draggingEffort = false; renderSettings(); });
  settings.addEventListener('keydown', event => {
    const range = event.target as HTMLInputElement;
    if (!range.matches('.effort-range') || pending || range.disabled) return;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? displayedEfforts.length - 1 : -1;
    // Native ranges emit no change when Home/End already points at the endpoint.
    if (index >= 0 && index === Number(range.value)) {
      event.preventDefault();
      const effort = displayedEfforts[index];
      if (effort) void saveEffort(effort.id);
    }
  });
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const button = (event.target as Element).closest<HTMLButtonElement>('.model-menu-option');
    if (button) void select(button);
  });
  panel.addEventListener('pointerdown', () => { clearTimeout(pointerRelease); pointerInside = true; }, true);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  panel.addEventListener('pointermove', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('.model-menu-option');
    if (button && !pending && !button.disabled && !button.classList.contains('model-menu-active')) setActive(button);
  });
  panel.addEventListener('keydown', event => {
    if (settings.contains(event.target as Node)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = enabledButtons();
      if (!buttons.length) return;
      const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = focused < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1 : (focused + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      setActive(buttons[next], true);
    } else if (event.key === 'Enter' && document.activeElement === search) {
      event.preventDefault();
      const button = enabledButtons().find(button => optionKey(button) === activeKey);
      if (button) void select(button);
    }
  });

  panel.addEventListener('focusout', event => {
    // Moving on with Tab must not send focus back to the trigger.
    if (pointerInside || pending || closed) return;
    if (event.relatedTarget && !panel.contains(event.relatedTarget as Node)) close(false);
  });

  anchor.setAttribute('aria-expanded', 'true');
  // Keep a picker opened from a modal inside that modal's interactive top layer.
  (anchor.closest('dialog[open]') ?? document.body).append(panel);
  renderChoices();
  showPopover(panel, anchor);
  search.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onEscape, true);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  function loadCatalogs(): void {
    if (!loadModels) return;
    for (const provider of providers) {
      if (!provider.installed || !canSwitchProvider && provider.id !== current.provider) continue;
      catalogLoading.add(provider.id);
      void Promise.resolve().then(() => loadModels(provider.id)).then(models => {
        if (closed) return;
        provider.models = models;
      }).catch(reason => { if (!closed) catalogErrors.set(provider.id, reason instanceof Error ? reason.message : String(reason ?? '')); }).finally(() => {
        if (closed) return;
        catalogLoading.delete(provider.id);
        renderChoices();
      });
    }
    renderChoices();
  }
  if (options.loadProviders) {
    renderChoices();
    void options.loadProviders().then(found => {
      if (closed) return;
      providers = found.map(provider => ({ ...provider, models: [...provider.models] }));
      providersStatus = providers.length ? '' : 'No harnesses on this computer';
      loadCatalogs();
    }).catch(failure => {
      if (closed) return;
      providersStatus = failure instanceof Error ? failure.message : String(failure);
      renderChoices();
    });
  } else loadCatalogs();
  return () => close();
}
