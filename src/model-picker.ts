import type { ContextUsage, Provider, ProviderId, ProviderModel } from './types';
import { t } from './i18n.ts';
import { advertisedModelsOnly, fallbackModel, modelChoices, tokenCount } from './model-catalog';
import { escape, icon, isImeKey } from './dom';
import { providerLogo } from './provider-logos';
import { showPopover, hidePopover } from './popover-motion';
import { trackSegment } from './motion';

/** A named agent team from Settings, offered beside the models. `detail` is one line ("lead · N workers"); `roster` its harnesses. */
export type PickerTeam = { id: string; name: string; detail: string; provider: ProviderId; roster?: ProviderId[]; selected: boolean };
type ModelPickerOptions = {
  teams?: PickerTeam[];
  onTeamSelect?: (id: string) => Promise<void>;
  anchor: HTMLElement;
  providers: Provider[];
  current: { provider: ProviderId; model: string; reasoningEffort?: string | null; serviceTier?: string | null; contextUsage?: ContextUsage | null };
  canSwitchProvider: boolean;
  onSelect: (provider: ProviderId, model: string) => Promise<void>;
  onEffortSelect?: (effort: string | null) => Promise<void>;
  /** A speed tier from the model's `speedTiers`; null is the standard speed. */
  onSpeedSelect?: (tier: string | null) => Promise<void>;
  loadModels?: (provider: ProviderId) => Promise<ProviderModel[]>;
  /** Another computer's harnesses: the picker opens with a loading row, then lists them, or one disabled row with the error. */
  loadProviders?: () => Promise<Provider[]>;
  /** Model IDs to list first in a shortened catalog, newest first; null lists every model. Search always covers all. */
  recent?: (provider: ProviderId) => string[] | null;
  onClose?: () => void;
  placement?: 'above' | 'below';
};

const RECENT_LIMIT = 5;
const WIDTH = 520;
const HEIGHT = 440;
/** The harness list row while `loadProviders` is out; the search field then says "Loading models…". */
const PROVIDERS_LOADING = 'Loading…';
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

const optionKey = (button: HTMLElement) => `${button.dataset.provider}:${button.dataset.model}`;
const includes = (values: string[], query: string) => values.some(value => value.toLowerCase().includes(query));
let pickerCount = 0;

/** A harness's catalog and availability. */
type Group = { key: string; provider: Provider; name: string; locked: boolean; unavailable: boolean; failure: string };
type Row = { group: Group; model: ProviderModel; custom?: boolean };
/** The settings segments: reasoning effort and speed tier. */
type Kind = 'effort' | 'speed';
type Choice = { id: string; name: string; description: string };

/** A transient picker with local state and listeners released on dismissal. */
export function openModelPicker(options: ModelPickerOptions) {
  const { anchor, current, canSwitchProvider, onSelect, onEffortSelect, onSpeedSelect, loadModels, onClose } = options;
  let providers = options.providers.map(provider => ({ ...provider, models: [...provider.models] }));
  const teams = options.teams ?? [];
  const teamSelected = teams.some(team => team.selected);
  const catalogErrors = new Map<ProviderId, string>();
  const catalogLoading = new Set<ProviderId>();
  const uid = `model-menu-${++pickerCount}`;
  const panel = document.createElement('section');
  panel.className = 'model-menu floating-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Harness and model'));
  panel.innerHTML = `<div class="model-menu-search">${icon('search')}<input type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${uid}-list" aria-label="${t('Search harnesses and models')}" autocomplete="off" spellcheck="false" maxlength="200"></div><div class="model-menu-body"><div class="model-menu-rail" role="tablist" aria-orientation="vertical" aria-label="Harnesses"></div><div class="model-menu-list" id="${uid}-list" role="listbox" aria-label="Models"></div></div><p class="model-menu-error" role="alert" hidden></p><div class="model-menu-settings" hidden></div><p class="model-menu-pending" role="status" hidden>${t('Applying…')}</p>`;
  const search = panel.querySelector<HTMLInputElement>('input')!;
  const rail = panel.querySelector<HTMLElement>('.model-menu-rail')!;
  const list = panel.querySelector<HTMLElement>('.model-menu-list')!;
  const settings = panel.querySelector<HTMLElement>('.model-menu-settings')!;
  const error = panel.querySelector<HTMLElement>('.model-menu-error')!;
  const pendingStatus = panel.querySelector<HTMLElement>('.model-menu-pending')!;
  const anchorId = anchor.id;
  const anchorAction = anchor.dataset.action;
  const originalExpanded = anchor.getAttribute('aria-expanded');
  let pending = false;
  let providersStatus = options.loadProviders ? t('Loading…') : '';
