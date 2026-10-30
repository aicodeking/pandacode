import type { ContextUsage, Provider, ProviderId, ProviderModel } from './types';
import { advertisedModelsOnly, compatibleModel, fallbackModel, modelChoices, tokenCount } from './model-catalog';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { showPopover, hidePopover } from './popover-motion';
import { trackSegment } from './motion';

/** A named agent team from Settings, offered beside the models. `detail` is one line ("lead · N workers"); `roster` its harnesses. */
export type PickerTeam = { id: string; name: string; detail: string; provider: ProviderId; roster?: ProviderId[]; selected: boolean };
/** A named connection from Settings: its harness's models listed again under its name. */
export type PickerConnection = { id: string; name: string; provider: ProviderId; openaiCompatible?: { modelId: string } | null };
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
const WIDTH = 460;
const HEIGHT = 440;
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
const includes = (values: string[], query: string) => values.some(value => value.toLowerCase().includes(query));
let pickerCount = 0;

/** A rail entry: Recent, Teams, or one harness (or named connection of a harness). */
type Group = { key: string; provider: Provider; connection: PickerConnection | null; name: string; locked: boolean; unavailable: boolean };
type Row = { group: Group; model: ProviderModel; custom?: boolean };

/** A transient picker with local state and listeners released on dismissal. */
export function openModelPicker(options: ModelPickerOptions): () => void {
  const { anchor, current, canSwitchProvider, onSelect, onEffortSelect, loadModels, onClose } = options;
  let providers = options.providers.map(provider => ({ ...provider, models: [...provider.models] }));
  const teams = options.teams ?? [];
  const connections = options.connections ?? [];
  const currentConnection = options.currentConnection ?? null;
  const teamSelected = teams.some(team => team.selected);
  const catalogErrors = new Map<ProviderId, string>();
  const catalogLoading = new Set<ProviderId>();
  const uid = `model-menu-${++pickerCount}`;
  const panel = document.createElement('section');
  panel.className = 'model-menu floating-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Harness and model');
  panel.innerHTML = `<div class="model-menu-search">${icon('search')}<input type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${uid}-list" aria-label="Search harnesses and models" autocomplete="off" spellcheck="false" maxlength="200"></div><div class="model-menu-body"><div class="model-menu-rail" role="tablist" aria-orientation="vertical" aria-label="Harnesses"></div><div class="model-menu-list" id="${uid}-list" role="listbox" aria-label="Models"></div></div><p class="model-menu-catalog-error" role="status" hidden></p><p class="model-menu-error" role="alert" hidden></p><div class="model-menu-settings" hidden></div><p class="model-menu-pending" role="status" hidden>Applying…</p>`;
  const search = panel.querySelector<HTMLInputElement>('input')!;
  const rail = panel.querySelector<HTMLElement>('.model-menu-rail')!;
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
  let activeKey = '';
  let positionFrame = 0;
  let listMarkup = '';
  let railMarkup = '';
  let settingsKey = '';
  let pendingEffort: string | null | undefined;
  let hoveredEffort: string | null | undefined;
  let view = teamSelected ? 'teams' : currentConnection ? `c:${currentConnection}` : `h:${current.provider}`;

  function restoreFocus(): void {
    let target: HTMLElement | null = anchor.isConnected ? anchor : null;
    if (!target && anchorId) target = document.getElementById(anchorId);
    if (!target && anchorAction) target = document.querySelector<HTMLElement>(`[data-action="${CSS.escape(anchorAction)}"]`);
    target?.focus({ preventScroll: true });
  }

  function close(shouldRestoreFocus = true): void {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(positionFrame);
    document.removeEventListener('pointerdown', onOutside, true);
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
    const room = below ? viewportTop + height - rect.bottom - gap - padding : height - padding * 2;
    // A fixed height keeps the panel still while the rail switches harnesses.
    const panelHeight = Math.max(120, Math.min(HEIGHT, room));
    panel.style.width = `${Math.max(0, Math.min(WIDTH, width - padding * 2))}px`;
    panel.style.height = panel.style.maxHeight = `${panelHeight}px`;
    // Prefer the space above the composer; clamp when the window is short.
    const left = Math.max(viewportLeft + padding, Math.min(rect.left, viewportLeft + width - panel.offsetWidth - padding));
    const top = Math.max(viewportTop + padding, Math.min(below ? rect.bottom + gap : rect.top - panelHeight - gap, viewportTop + height - panelHeight - padding));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.dataset.placement = below ? 'below' : 'above';
    syncRailFade();
  }

  function schedulePosition(): void {
    if (!positionFrame && !closed) positionFrame = requestAnimationFrame(position);
  }

  // ----- Data -----

  /** Uninstalled harnesses stay out of the picker unless the task already uses one. */
  function groups(): Group[] {
    return providers.filter(provider => provider.installed || provider.id === current.provider).flatMap(provider => [null, ...connections.filter(c => c.provider === provider.id && !c.openaiCompatible)].map(connection => ({
      key: connection ? `c:${connection.id}` : `h:${provider.id}`, provider, connection, name: connection?.name ?? provider.name,
      locked: !canSwitchProvider && provider.id !== current.provider, unavailable: !provider.installed,
    })));
  }
  const models = (group: Group) => group.connection?.openaiCompatible ? [compatibleModel(group.connection.openaiCompatible)] : modelChoices(group.provider.id, group.provider.models, group.provider.id === current.provider ? current.model : '');
  const isCurrent = (row: Row) => !teamSelected && !row.custom && row.group.provider.id === current.provider && row.model.id === (current.model || 'default') && (row.group.connection?.id ?? null) === currentConnection;

  /** Default plus the most recent models, padded from the catalog, when the caller asks for a short list. */
  function shortList(provider: ProviderId, all: ProviderModel[]): ProviderModel[] {
    const recent = options.recent?.(provider);
    if (!recent) return all;
    const byId = new Map(all.map(model => [model.id, model]));
    const first = [...(provider === current.provider ? [current.model] : []), ...recent, ...storedRecent(provider)].filter(id => id !== 'default' && byId.has(id));
    const ids = [...new Set([...first, ...all.map(model => model.id).filter(id => id !== 'default')])].slice(0, RECENT_LIMIT);
    return [byId.get('default')!, ...ids.map(id => byId.get(id)!)];
  }

  /** The current pick, then each harness's latest stored picks, newest harness first. */
  function recentRows(all: Group[]): Row[] {
    const plain = all.filter(group => !group.connection && !group.locked && !group.unavailable);
    const stored = plain.map(group => ({ group, ids: storedRecent(group.provider.id) }));
    const picks: [Group | undefined, string][] = [[all.find(group => group.key === (currentConnection ? `c:${currentConnection}` : `h:${current.provider}`)), current.model],
      ...stored.flatMap(({ group, ids }) => ids.slice(0, 1).map(id => [group, id] as [Group, string])), ...stored.flatMap(({ group, ids }) => ids.slice(1).map(id => [group, id] as [Group, string]))];
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const [group, id] of picks) {
      const model = group && id !== 'default' ? models(group).find(model => model.id === id) : undefined;
      if (!group || !model || seen.has(`${group.key}|${id}`)) continue;
      seen.add(`${group.key}|${id}`);
      rows.push({ group, model });
    }
    return rows.slice(0, RECENT_LIMIT);
  }

  // ----- Rendering -----

  function teamLogos(team: PickerTeam): string {
    const roster = [...new Set(team.roster?.length ? team.roster : [team.provider])].slice(0, 3);
    return `<span class="model-menu-stack">${roster.map(id => providerLogo(id)).join('')}</span>`;
  }

  function teamRow(team: PickerTeam): string {
    return `<button type="button" role="option" tabindex="-1" class="model-menu-option model-menu-team${team.selected ? ' model-menu-current' : ''}" data-team="${escape(team.id)}" data-provider="team" data-model="${escape(team.id)}" data-available="true" aria-label="${escape(`Agent team · ${team.name}`)}" title="${escape(`${team.name} · ${team.detail}`)}" ${team.selected ? 'aria-current="true"' : ''}>${teamLogos(team)}<span class="model-menu-name">${escape(team.name)}</span><span class="model-menu-meta">${escape(team.detail)}</span>${team.selected ? icon('check', 'model-menu-check') : ''}</button>`;
  }

  /** One line: name left, context (or the harness in mixed lists) right, a check on the current model. */
  function modelRow(row: Row, mixed: boolean, query: string): string {
    const { group, model, custom } = row;
    const disabled = group.locked || group.unavailable;
    const selected = isCurrent(row);
    const accessible = custom ? `Use "${model.id}" with ${group.name}` : `${group.name} · ${model.name}`;
    const context = model.contextWindow ? tokenCount(model.contextWindow) : '';
    const title = [model.contextWindow ? `${context} context` : '', model.description || (model.name !== model.id && model.id !== 'default' ? model.id : '')].filter(Boolean).join(' · ');
    const meta = mixed ? group.name : context;
    const name = custom ? `Use “${escape(query)}”` : escape(model.name);
    return `<button type="button" role="option" tabindex="-1" class="model-menu-option${selected ? ' model-menu-current' : ''}${custom ? ' model-menu-custom' : ''}" data-provider="${group.provider.id}" data-model="${escape(model.id)}"${group.connection ? ` data-connection="${escape(group.connection.id)}"` : ''} data-available="${!disabled}" aria-label="${escape(accessible)}" title="${escape(custom ? accessible : title)}" ${selected ? 'aria-current="true"' : ''} ${disabled ? 'aria-disabled="true" disabled' : ''}>${mixed ? providerLogo(group.provider.id) : ''}<span class="model-menu-name" title="${custom ? escape(query) : escape(model.name)}">${name}</span>${meta ? `<span class="model-menu-meta">${escape(meta)}</span>` : ''}${selected ? icon('check', 'model-menu-check') : custom ? icon('plus', 'model-menu-check') : ''}</button>`;
  }

  function heading(logo: string, name: string, status = ''): string {
    return `<div class="model-menu-group-heading">${logo}<h3>${escape(name)}</h3>${status}</div>`;
  }

  function railItem(key: string, logo: string, name: string, count: string, classes: string, selected: boolean, label = name): string {
    return `<button type="button" role="tab" class="model-menu-tab${classes}" data-view="${escape(key)}" aria-selected="${selected}" aria-controls="${uid}-list" aria-label="${escape(label)}" title="${escape(name)}" tabindex="${key === view ? 0 : -1}">${logo}<span class="model-menu-tab-label">${escape(name)}</span><span class="model-menu-count">${escape(count)}</span></button>`;
  }

  function renderChoices(): void {
    if (closed) return;
    const query = search.value.trim();
    const normalized = query.toLowerCase();
    const all = groups();
    const recent = recentRows(all);
    const railKeys = [...(recent.length ? ['recent'] : []), ...(teams.length ? ['teams'] : []), ...all.map(group => group.key)];
    if (!railKeys.includes(view)) view = railKeys.find(key => key === `h:${current.provider}`) ?? railKeys.find(key => key.startsWith('h:') || key.startsWith('c:')) ?? railKeys[0] ?? '';
    const matchedTeams = query ? teams.filter(team => includes([team.name, team.detail, 'team'], normalized)) : teams;
    const namedHarness = all.some(group => [group.provider.id, group.provider.name, group.name].some(name => name.toLowerCase() === normalized));
    const hits = new Map<string, Row[]>();
    if (query) for (const group of all) {
      const groupMatches = includes([group.provider.id, group.provider.name, group.name], normalized);
      hits.set(group.key, models(group).filter(model => groupMatches || includes([model.id, model.name], normalized)).map(model => ({ group, model })));
    }
    search.placeholder = `Search ${new Set(all.flatMap(group => models(group).map(model => `${group.provider.id}:${model.id}`))).size} models, ${all.filter(group => !group.connection).length} harnesses…`;

    // Rail: a tab per view; while searching it is a hit map.
    const inUse = (key: string) => !teamSelected && key === (currentConnection ? `c:${currentConnection}` : `h:${current.provider}`);
    let railHtml = '';
    if (recent.length) railHtml += railItem('recent', icon('undo'), 'Recent', '', query ? ' is-dim' : '', !query && view === 'recent');
    if (teams.length) railHtml += railItem('teams', icon('worktree'), 'Teams', String(query ? matchedTeams.length || '' : teams.length), `${teamSelected ? ' has-current' : ''}${query && !matchedTeams.length ? ' is-dim' : ''}`, !query && view === 'teams', `Teams, ${teams.length}`);
    if (all.length) railHtml += '<div class="model-menu-rail-heading" role="presentation">Harnesses</div>';
    railHtml += all.map(group => {
      const count = query ? hits.get(group.key)!.length : 0;
      const classes = `${group.connection ? ' is-connection' : ''}${inUse(group.key) ? ' has-current' : ''}${group.locked || group.unavailable || (query && !count) ? ' is-dim' : ''}`;
      return railItem(group.key, providerLogo(group.provider.id), group.name, count ? String(count) : '', classes, !query && view === group.key);
    }).join('');
    if (railHtml !== railMarkup) {
      rail.innerHTML = railHtml;
      railMarkup = railHtml;
      if (query) rail.querySelector('.model-menu-count:not(:empty)')?.parentElement?.scrollIntoView({ block: 'nearest' });
    }

    // List: the viewed harness, Recent, Teams, or flat search results.
    let markup = '';
    let total = 0;
    if (query) {
      total += matchedTeams.length;
      markup += matchedTeams.map(teamRow).join('');
      const rows = all.flatMap(group => hits.get(group.key)!);
      total += rows.length;
      if (!total) markup += '<p class="model-menu-empty">No matching models.</p>';
      markup += rows.map(row => modelRow(row, true, query)).join('');
      // One custom ID row: the viewed harness, else the current one, unless the query names a harness or an existing model.
      const takesCustom = (group?: Group): group is Group => Boolean(group) && !group!.connection?.openaiCompatible && !advertisedModelsOnly(group!.provider.id) && !group!.locked && !group!.unavailable && !models(group!).some(model => [model.id, model.name].some(value => value.toLowerCase() === normalized));
      const viewed = all.find(group => group.key === view);
      const custom = namedHarness ? undefined : [viewed, all.find(group => group.key === `h:${current.provider}`)].find(takesCustom);
      if (custom) { total++; markup += modelRow({ group: custom, model: fallbackModel(custom.provider.id, query), custom: true }, true, query); }
    } else if (view === 'recent') {
      total = recent.length;
      markup = heading(icon('undo'), 'Recent') + recent.map(row => modelRow(row, true, '')).join('');
    } else if (view === 'teams') {
      total = teams.length;
      markup = heading(icon('worktree'), 'Agent teams', '<span>Lead and workers</span>') + teams.map(teamRow).join('');
    } else {
      const group = all.find(group => group.key === view);
      if (group) {
        const visible = group.provider.id === 'openai-compatible' || group.connection?.openaiCompatible ? models(group) : shortList(group.provider.id, models(group));
        total = visible.length;
        const status = group.locked ? '<span>New task required</span>' : group.unavailable ? '<span>Unavailable</span>' : `<span data-catalog-loading="${group.provider.id}" hidden>Loading…</span>`;
        markup = heading(providerLogo(group.provider.id), group.name, status) + visible.map(model => modelRow({ group, model }, false, '')).join('');
        if (!visible.length && group.provider.id === 'openai-compatible') markup += '<p class="model-menu-empty">Enter your server’s Base URL in Settings → Providers to find models.</p>';
      }
    }
    if (providersStatus) markup = `<button type="button" role="option" tabindex="-1" class="model-menu-option" data-available="false" disabled>${icon('monitor')}<span class="model-menu-name">${escape(providersStatus)}</span></button>`;
    else if (!total) markup = '<p class="model-menu-empty">No matching models.</p>';
    // Loading and saving are in-place updates: retain rows and scroll position.
    const changed = markup !== listMarkup;
    if (changed) { list.innerHTML = markup; listMarkup = markup; }
    // Typing clears the active row even when the list is unchanged; pick one again.
    if (changed || !enabledButtons().some(button => optionKey(button) === activeKey)) {
      const buttons = enabledButtons();
      const next = buttons.find(button => optionKey(button) === activeKey) ?? (query ? buttons[0] : buttons.find(button => button.getAttribute('aria-current') === 'true') ?? buttons[0]);
      setActive(next);
    }
    list.querySelectorAll<HTMLElement>('[data-catalog-loading]').forEach(status => { status.hidden = !catalogLoading.has(status.dataset.catalogLoading as ProviderId); });
    catalogError.hidden = catalogErrors.size === 0;
    catalogError.textContent = catalogErrors.size ? `Could not load models for ${providers.filter(provider => catalogErrors.has(provider.id)).map(provider => { const reason = catalogErrors.get(provider.id)?.replace(/\.$/, ''); return reason ? `${provider.name} (${reason})` : provider.name; }).join(', ')}. You can enter model IDs for agents that support custom models.` : '';
    updateControls();
    position();
  }

  /** A fade at the rail's bottom edge while more harnesses sit below the fold. */
  function syncRailFade(): void {
    rail.classList.toggle('has-more', rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1);
  }

  function enabledButtons(): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>('.model-menu-option:not(:disabled)')];
  }

  function setActive(button?: HTMLButtonElement): void {
    list.querySelectorAll('.model-menu-option').forEach((row, index) => {
      row.id ||= `${uid}-option-${index}`;
      row.setAttribute('aria-selected', String(row === button));
      row.classList.toggle('model-menu-active', row === button);
    });
    if (!button) { activeKey = ''; search.removeAttribute('aria-activedescendant'); return; }
    activeKey = optionKey(button);
    search.setAttribute('aria-activedescendant', button.id);
    button.scrollIntoView({ block: 'nearest' });
  }

  function moveActive(step: number | 'first' | 'last'): void {
    const buttons = enabledButtons();
    if (!buttons.length) return;
    const index = buttons.findIndex(button => optionKey(button) === activeKey);
    const next = step === 'first' ? 0 : step === 'last' ? buttons.length - 1 : index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
    setActive(buttons[next]);
  }

  function showView(key: string, focusTab = false): void {
    view = key;
    activeKey = '';
    if (search.value) search.value = '';
    renderChoices();
    if (focusTab) rail.querySelector<HTMLElement>(`[data-view="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    rail.querySelector(`[data-view="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function stepView(step: number | 'first' | 'last', focusTab: boolean): void {
    const keys = [...rail.querySelectorAll<HTMLElement>('[role="tab"]')].map(tab => tab.dataset.view!);
    if (!keys.length) return;
    const index = keys.indexOf(view);
    const next = step === 'first' ? 0 : step === 'last' ? keys.length - 1 : (index + step + keys.length) % keys.length;
    showView(keys[next], focusTab);
  }

  // ----- Effort -----

  function currentModel(): { provider?: Provider; model: ProviderModel } {
    const provider = providers.find(provider => provider.id === current.provider);
    const endpoint = connections.find(c => c.id === currentConnection)?.openaiCompatible;
    if (endpoint) return { provider, model: compatibleModel(endpoint) };
    return { provider, model: modelChoices(current.provider, provider?.models ?? [], current.model).find(model => model.id === current.model) ?? fallbackModel(current.provider, current.model) };
  }

  function renderSettings(): void {
    const { provider, model } = currentModel();
    const efforts = [...(model.reasoningEfforts ?? [])];
    const chosen = pendingEffort !== undefined ? pendingEffort : current.reasoningEffort ?? null;
    // A saved level the catalog no longer lists still shows as chosen.
    if (chosen && !efforts.some(effort => effort.id === chosen)) efforts.push({ id: chosen, name: chosen, description: '' });
    const canSetEffort = Boolean(onEffortSelect && efforts.length);
    settings.hidden = !canSetEffort && !teamSelected;
    const disabled = pending || !provider?.installed;
    const defaultEffort = efforts.find(effort => effort.id === model.defaultReasoningEffort);
    const choices = [{ id: '', name: 'Default', description: `Use the harness's saved setting.${defaultEffort ? ` Reported model default: ${defaultEffort.name}.` : ''}` }, ...efforts];
    const markup = teamSelected
      ? '<div class="model-menu-effort-row"><span class="model-menu-effort-label">Effort</span><span class="model-menu-effort-note">Set per worker</span></div>'
      : canSetEffort ? `<div class="model-menu-effort-row"><span class="model-menu-effort-label" id="${uid}-effort">Effort</span><div class="model-menu-effort" role="radiogroup" aria-labelledby="${uid}-effort">${choices.map(effort => `<button type="button" role="radio" data-effort="${escape(effort.id)}" title="${escape(effort.description || effort.name)}"${effort.id && effort.id === model.defaultReasoningEffort ? ' data-model-default=""' : ''}>${escape(effort.name)}</button>`).join('')}</div></div><p class="model-menu-effort-hint"></p>` : '';
    if (markup !== settingsKey) {
      const focused = settings.contains(document.activeElement);
      settings.innerHTML = markup;
      settingsKey = markup;
      if (focused) (settings.querySelector<HTMLElement>('.selected') ?? search).focus({ preventScroll: true });
    }
    const group = settings.querySelector<HTMLElement>('.model-menu-effort');
    if (!group) return;
    let selected: HTMLElement | null = null;
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => {
      const on = button.dataset.effort === (chosen ?? '');
      if (on) selected = button;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('selected', on);
      button.tabIndex = on ? 0 : -1;
      button.disabled = disabled;
    });
    group.setAttribute('aria-disabled', String(disabled));
    trackSegment(group, selected);
    const shown = hoveredEffort !== undefined ? hoveredEffort : chosen;
    const hint = settings.querySelector<HTMLElement>('.model-menu-effort-hint')!;
    const text = choices.find(effort => effort.id === (shown ?? ''))?.description ?? '';
    if (hint.textContent !== text) hint.textContent = text;
  }

  function updateControls(): void {
    panel.setAttribute('aria-busy', String(pending));
    pendingStatus.hidden = !pending;
    list.querySelectorAll<HTMLButtonElement>('.model-menu-option[data-available="true"]').forEach(button => { button.disabled = pending; });
    renderSettings();
  }

  async function saveEffort(effort: string | null): Promise<void> {
    const provider = providers.find(provider => provider.id === current.provider);
    if (pending || closed || !onEffortSelect || !provider?.installed) return;
    const supported = provider.models.find(model => model.id === current.model)?.reasoningEfforts ?? [];
    if (effort !== null && !supported.some(choice => choice.id === effort)) {
      if (effort === current.reasoningEffort) return;
      error.textContent = 'This reasoning effort is no longer available. Choose another level.';
      error.hidden = false;
      renderSettings();
      return;
    }
    if (effort === (current.reasoningEffort ?? null)) { renderSettings(); return; }
    const focused = settings.contains(document.activeElement);
    pending = true;
    pendingEffort = effort;
    error.hidden = true;
    updateControls();
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
        // A disabled control loses focus during the save; leave deliberate navigation alone.
        if (focused && (document.activeElement === document.body || settings.contains(document.activeElement))) (settings.querySelector<HTMLElement>('.selected') ?? search).focus({ preventScroll: true });
      }
    }
  }

  // ----- Selection and events -----

  async function select(button: HTMLButtonElement): Promise<void> {
    if (pending || closed || button.disabled) return;
    pending = true;
    error.hidden = true;
    updateControls();
    try {
      if (button.dataset.team) await options.onTeamSelect?.(button.dataset.team);
      else {
        await onSelect(button.dataset.provider as ProviderId, button.dataset.model!, button.dataset.connection ?? null);
        rememberRecent(button.dataset.provider as ProviderId, button.dataset.model!);
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
    // The trigger's own click toggles the picker.
    if (target && !panel.contains(target) && !anchor.contains(target)) close(false);
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    // The first Esc clears the query; the next closes.
    if (search.value) { search.value = ''; activeKey = ''; renderChoices(); search.focus({ preventScroll: true }); return; }
    close();
  }

  /** Tab cycles search → rail → effort inside the picker and never leaves it. */
  function cycleFocus(back: boolean): void {
    const stops = [search, rail.querySelector<HTMLElement>('[tabindex="0"]'), settings.hidden ? null : settings.querySelector<HTMLElement>('.selected:not(:disabled)')].filter((stop): stop is HTMLElement => Boolean(stop));
    const index = stops.findIndex(stop => stop.contains(document.activeElement));
    stops[(index + (back ? -1 : 1) + stops.length) % stops.length].focus({ preventScroll: true });
  }

  search.addEventListener('input', () => { activeKey = ''; renderChoices(); });
  rail.addEventListener('scroll', syncRailFade, { passive: true });
  rail.addEventListener('click', event => {
    const tab = (event.target as Element).closest<HTMLElement>('[role="tab"]');
    if (tab) { showView(tab.dataset.view!); search.focus({ preventScroll: true }); }
  });
  settings.addEventListener('click', event => {
    const radio = (event.target as Element).closest<HTMLButtonElement>('[role="radio"]');
    if (radio && !radio.disabled) void saveEffort(radio.dataset.effort || null);
  });
  settings.addEventListener('pointerover', event => {
    const radio = (event.target as Element).closest<HTMLElement>('[role="radio"]');
    hoveredEffort = radio ? radio.dataset.effort || null : undefined;
    renderSettings();
  });
  settings.addEventListener('pointerleave', () => { hoveredEffort = undefined; renderSettings(); });
  list.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('.model-menu-option');
    if (button) void select(button);
  });
  list.addEventListener('pointermove', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('.model-menu-option');
    if (button && !pending && !button.disabled && !button.classList.contains('model-menu-active')) setActive(button);
  });
  panel.addEventListener('click', event => event.stopPropagation());
  panel.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    const key = event.key;
    if (key === 'Tab') { event.preventDefault(); cycleFocus(event.shiftKey); return; }
    // Typing always goes to search.
    if (target !== search && key.length === 1 && key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) { search.focus({ preventScroll: true }); return; }
    const radio = target.closest<HTMLButtonElement>('[role="radio"]');
    if (radio) {
      const radios = [...settings.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const index = radios.indexOf(radio);
      const next = key === 'ArrowRight' || key === 'ArrowDown' ? Math.min(radios.length - 1, index + 1) : key === 'ArrowLeft' || key === 'ArrowUp' ? Math.max(0, index - 1) : key === 'Home' ? 0 : key === 'End' ? radios.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      if (pending || radio.disabled) return;
      radios[next].focus({ preventScroll: true });
      void saveEffort(radios[next].dataset.effort || null);
      return;
    }
    if (target.closest('[role="tab"]')) {
      const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'Home' ? 'first' : key === 'End' ? 'last' : null;
      if (step !== null) { event.preventDefault(); stepView(step, true); }
      else if (key === 'Enter' || key === 'ArrowRight') { event.preventDefault(); search.focus({ preventScroll: true }); }
      return;
    }
    if (target !== search) return;
    if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); moveActive(key === 'ArrowDown' ? 1 : -1); }
    else if (key === 'Home' || key === 'End') { event.preventDefault(); moveActive(key === 'Home' ? 'first' : 'last'); }
    else if ((key === 'ArrowLeft' || key === 'ArrowRight') && !search.value) { event.preventDefault(); stepView(key === 'ArrowRight' ? 1 : -1, false); }
    else if (key === 'Enter') {
      event.preventDefault();
      const button = enabledButtons().find(button => optionKey(button) === activeKey);
      if (button) void select(button);
    }
  });

  anchor.setAttribute('aria-expanded', 'true');
  // Keep a picker opened from a modal inside that modal's interactive top layer.
  (anchor.closest('dialog[open]') ?? document.body).append(panel);
  renderChoices();
  showPopover(panel, anchor);
  search.focus({ preventScroll: true });
  rail.querySelector('[tabindex="0"]')?.scrollIntoView({ block: 'nearest' });
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
