import './agent-usage.css';
import { call, preview } from './bridge';
import { escape, icon } from './dom';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { Provider, ProviderId } from './types';
import { usageHeatmap } from './usage-heatmap';
import { averageLimit, calendarFor, summarize, type Ledger, type PromptActivity, type Range, type Summary } from './usage-ledger';
import { agentCostStrip, renderAgents, renderCostDetails, renderCostHero, renderLimitHero, type AgentLimit, type CostState } from './usage-overview';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string | null;
  detail?: string | null;
}
export interface AgentUsage {
  provider: ProviderId;
  status: 'ready' | 'unavailable' | 'signedOut' | 'error' | 'unsupported';
  windows: UsageWindow[];
  plan?: string | null;
  message?: string | null;
  checkedAt: number;
  stale: boolean;
  source?: string | null;
  dashboardUrl?: string | null;
}

const help = 'Reads account limits from your locally configured agent accounts. Requests go directly to the provider or its CLI, never through PandaCode servers. No prompts are sent. Results are cached for one minute; Refresh is limited to once every ten seconds per provider. Some providers do not expose their limits. Usage is shared with other apps using the same account.';
const STATUS: Record<AgentUsage['status'], string> = { ready: '', unavailable: 'Unavailable', signedOut: 'Sign-in needed', error: 'Unavailable', unsupported: 'Not exposed' };
const RANGES: [Range, string][] = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const shortNames: Partial<Record<ProviderId, string>> = { claude: 'Claude', glm: 'GLM', mimo: 'MiMo', kimi: 'Kimi', grok: 'Grok', pi: 'Pi', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo', omp: 'omp', 'github-copilot': 'Copilot', muse: 'Muse' };
type Tab = 'overview' | ProviderId;

function validWindows(result: AgentUsage | undefined): UsageWindow[] {
  return result?.windows.filter(window => Number.isFinite(window.usedPercent)) ?? [];
}
function peak(result: AgentUsage | undefined): number | null {
  const windows = validWindows(result);
  return windows.length ? Math.min(100, Math.max(0, ...windows.map(window => window.usedPercent))) : null;
}
function pricingNote(ledger: Ledger): string {
  const when = ledger.pricing.fetchedAt ? new Date(ledger.pricing.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return { live: `Prices: LiteLLM public price list, updated ${when}.`, saved: `Prices: saved LiteLLM price list from ${when}.`, bundled: 'Prices: the list bundled with PandaCode (offline).' }[ledger.pricing.source];
}

/** Keeps keyboard focus on the same control when a section re-renders. */
function preserveFocus(container: HTMLElement, render: () => void): void {
  const active = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
  const key = active && (['provider', 'breakdown'] as const).find(name => active.dataset[name] !== undefined);
  const value = key ? active!.dataset[key] : undefined;
  render();
  if (key && value !== undefined) container.querySelector<HTMLElement>(`[data-${key}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

/** Only mounted on demand. Each provider settles independently; native code owns caching. */
export function mountAgentUsage(host: HTMLElement, providers: Provider[]): () => void {
  let disposed = false, pending = false;
  const installed = providers.filter(provider => provider.installed);
  const nameOf = (id: ProviderId) => providers.find(provider => provider.id === id)?.name ?? id;
  const limits = new Map<ProviderId, AgentUsage>();
  const cards = new Map<ProviderId, HTMLElement>();
  let ledger: Ledger | null = null, ledgerError: string | null = null, ledgerPending = false, prompts: PromptActivity | null = null;
  let range: Range = 'month', breakdown: 'model' | 'day' = 'model', tab: Tab = 'overview';
  let summaryCache: { ledger: Ledger; range: Range; summary: Summary } | null = null;

  host.classList.add('agent-usage');
  const tabs = [{ id: 'overview' as Tab, label: 'Overview', logo: icon('activity') }, ...installed.map(provider => ({ id: provider.id as Tab, label: shortNames[provider.id] ?? provider.name, logo: providerLogo(provider.id) }))];
  host.innerHTML = `<div class="usage-toolbar"><div class="usage-tabs" role="tablist" aria-label="Usage views">${tabs.map(entry => `<button type="button" role="tab" id="usage-tab-${entry.id}" aria-controls="usage-panel-${entry.id}" aria-selected="${entry.id === 'overview'}" tabindex="${entry.id === 'overview' ? 0 : -1}" data-tab="${entry.id}" aria-label="${escape(entry.label)}" title="${escape(entry.label)}">${entry.logo}<span>${escape(entry.label)}</span></button>`).join('')}</div>
      <button type="button" class="icon-button usage-refresh" aria-label="Refresh usage" title="Refresh">${icon('refresh')}</button></div>
    <div class="usage-panel usage-overview" role="tabpanel" id="usage-panel-overview" aria-labelledby="usage-tab-overview">
      <div class="usage-heroes"><div class="usage-hero usage-cost-hero"></div><div class="usage-hero usage-limit-hero"></div></div>
      <div class="usage-range-row"><span class="usage-caption">Agents ${infoMark(help, 'About agent usage')}</span><div class="usage-segmented usage-range" role="group" aria-label="Period">${RANGES.map(([id, label]) => `<button type="button" data-range="${id}" aria-pressed="${id === range}">${label}</button>`).join('')}</div></div>
      <div class="usage-agents"></div><div class="usage-cost-details"></div>
    </div><p class="usage-footer" role="status"></p>${preview ? '<p class="usage-preview">Browser preview · sample limits and costs</p>' : ''}`;
  const toolbarTabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const overview = host.querySelector<HTMLElement>('.usage-overview')!;
  const costHero = host.querySelector<HTMLElement>('.usage-cost-hero')!;
  const limitHero = host.querySelector<HTMLElement>('.usage-limit-hero')!;
  const agentList = host.querySelector<HTMLElement>('.usage-agents')!;
  const details = host.querySelector<HTMLElement>('.usage-cost-details')!;
  const rangeGroup = host.querySelector<HTMLElement>('.usage-range')!;
  const refresh = host.querySelector<HTMLButtonElement>('.usage-refresh')!;
  const footer = host.querySelector<HTMLElement>('.usage-footer')!;
  for (const provider of installed) {
    const card = document.createElement('section'); card.className = 'usage-panel usage-card'; card.hidden = true;
    card.id = `usage-panel-${provider.id}`; card.setAttribute('role', 'tabpanel'); card.setAttribute('aria-label', provider.name);
    card.innerHTML = `<header class="usage-card-heading">${providerLogo(provider.id)}<h3>${escape(provider.name)}</h3><span class="usage-plan"></span></header><div class="usage-card-body" role="status">Checking limits…</div><div class="usage-card-cost"></div><div class="usage-card-calendar"></div>`;
    host.insertBefore(card, footer); cards.set(provider.id, card);
  }
  if (!installed.length) agentList.innerHTML = `<div class="usage-empty">${icon('activity')}<p>No installed agents found.</p><button class="secondary-button" data-action="settings">Open Settings</button></div>`;

  function costState(): CostState {
    if (ledgerError) return { kind: 'error', message: ledgerError };
    if (!ledger) return { kind: 'pending' };
    if (summaryCache?.ledger !== ledger || summaryCache.range !== range) summaryCache = { ledger, range, summary: summarize(ledger, range) };
    return { kind: 'ready', summary: summaryCache.summary, tracked: ledger.sources.filter(source => source.files > 0).map(source => source.provider), pricing: pricingNote(ledger) };
  }
  function agentLimits(): AgentLimit[] {
    return installed.map(provider => {
      const result = limits.get(provider.id);
      return { provider: provider.id, name: provider.name, peak: peak(result), state: result ? (result.stale ? 'Saved snapshot' : STATUS[result.status] || 'No limits reported') : 'Checking…' };
    });
  }
  function renderLimits(): void {
    const rows = agentLimits();
    renderLimitHero(limitHero, rows, averageLimit(rows.flatMap(row => row.peak === null ? [] : [row.peak])), installed.length - limits.size);
  }
  function renderOverview(): void {
    const cost = costState();
    renderLimits();
    renderCostHero(costHero, cost);
    if (installed.length) preserveFocus(agentList, () => renderAgents(agentList, agentLimits(), cost));
    preserveFocus(details, () => renderCostDetails(details, cost, nameOf, breakdown));
    const breakdownSwitch = details.querySelector<HTMLElement>('.usage-breakdown-switch');
    if (breakdownSwitch) trackSegment(breakdownSwitch, breakdownSwitch.querySelector<HTMLElement>('[aria-pressed="true"]'));
    for (const [id, card] of cards) card.querySelector<HTMLElement>('.usage-card-cost')!.innerHTML = agentCostStrip(id, cost);
  }
  function renderCalendars(): void {
    for (const [id, card] of cards) {
      const slot = card.querySelector<HTMLElement>('.usage-card-calendar')!;
      const calendar = calendarFor(id, ledger, prompts);
      if (!calendar) { slot.innerHTML = ledger || prompts ? '<p class="usage-calendar-empty">No activity recorded for this agent yet.</p>' : ''; continue; }
      const heatmap = usageHeatmap(calendar.daily, { unit: calendar.unit, label: `${nameOf(id)} daily ${calendar.unit}` });
      if (calendar.unit === 'prompts') heatmap.querySelector('.heatmap-heading h3')?.insertAdjacentHTML('beforeend', ` ${infoMark('This agent does not keep token logs PandaCode can read, so the calendar counts prompts you sent from PandaCode.', 'About this calendar')}`);
      slot.replaceChildren(heatmap);
    }
  }

  function select(next: Tab, focus = false): void {
    tab = next;
    toolbarTabs.forEach(button => { const on = button.dataset.tab === next; button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; });
    overview.hidden = next !== 'overview';
    for (const [id, card] of cards) card.hidden = id !== next;
    const current = toolbarTabs.find(button => button.dataset.tab === next)!;
    trackSegment(current.parentElement as HTMLElement, current);
    current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) current.focus();
  }

  async function loadLimits(force: boolean): Promise<void> {
    let next = 0;
    // A slow account cannot hold up the others. Bound parallel work in the UI as well
    // as the native cache, and stop starting requests as soon as this view is closed.
    async function worker(): Promise<void> {
      while (!disposed && next < installed.length) {
        const provider = installed[next++];
        let result: AgentUsage;
        try {
          result = await call<AgentUsage>('agent_usage', { provider: provider.id, refresh: force });
          if (!result || result.provider !== provider.id || !Array.isArray(result.windows)) throw new Error('Invalid usage result');
        } catch {
          result = { provider: provider.id, status: 'error', windows: [], checkedAt: Date.now(), stale: false, message: 'Could not read limits. Try Refresh.' };
        }
        if (disposed) return;
        limits.set(provider.id, result);
        renderCard(cards.get(provider.id)!, provider, result);
        renderLimits();
        preserveFocus(agentList, () => renderAgents(agentList, agentLimits(), costState()));
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, installed.length) }, worker));
  }
  async function loadLedger(force: boolean): Promise<void> {
    if (ledgerPending) return;
    ledgerPending = true;
    try {
      const [nextLedger, nextPrompts] = await Promise.all([
        call<Ledger>('usage_ledger', { refresh: force }),
        call<PromptActivity>('prompt_activity').catch(() => null),
      ]);
      if (disposed) return;
      if (!nextLedger || !Array.isArray(nextLedger.rows) || !Array.isArray(nextLedger.models)) throw new Error('Invalid usage estimate');
      ledger = nextLedger; prompts = nextPrompts; ledgerError = null;
    } catch (cause) {
      if (disposed) return;
      ledgerError = ledger ? null : cause instanceof Error && cause.message ? cause.message : 'Could not read local agent logs.';
    } finally { ledgerPending = false; }
    renderOverview(); renderCalendars();
  }
  async function load(force: boolean): Promise<void> {
    if (pending || disposed || !installed.length) return;
    pending = true; refresh.disabled = true; refresh.setAttribute('aria-busy', 'true');
    footer.textContent = 'Checking account limits…';
    const estimate = loadLedger(force);
    await loadLimits(force);
    if (disposed) return;
    pending = false; refresh.disabled = false; refresh.removeAttribute('aria-busy');
    footer.textContent = 'Updated on demand';
    await estimate;
  }

  function click(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const tabButton = target?.closest<HTMLButtonElement>('[role="tab"]');
    if (tabButton && toolbarTabs.includes(tabButton)) { select(tabButton.dataset.tab as Tab); return; }
    const row = target?.closest<HTMLButtonElement>('.usage-agent-row');
    if (row) { select(row.dataset.provider as ProviderId, true); return; }
    const rangeButton = target?.closest<HTMLButtonElement>('[data-range]');
    if (rangeButton && rangeButton.dataset.range !== range) {
      range = rangeButton.dataset.range as Range;
      rangeGroup.querySelectorAll('[data-range]').forEach(button => button.setAttribute('aria-pressed', String(button === rangeButton)));
      trackSegment(rangeGroup, rangeButton); renderOverview(); return;
    }
    const breakdownButton = target?.closest<HTMLButtonElement>('[data-breakdown]');
    if (breakdownButton && breakdownButton.dataset.breakdown !== breakdown) { breakdown = breakdownButton.dataset.breakdown as 'model' | 'day'; renderOverview(); }
  }
  function keydown(event: KeyboardEvent): void {
    const index = toolbarTabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? toolbarTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + toolbarTabs.length) % toolbarTabs.length;
    select(toolbarTabs[next].dataset.tab as Tab, true);
  }
  const reload = () => { void load(true); };
  host.addEventListener('click', click);
  host.addEventListener('keydown', keydown);
  refresh.addEventListener('click', reload);
  refresh.disabled = !installed.length;
  renderOverview();
  select(tab);
  trackSegment(rangeGroup, rangeGroup.querySelector<HTMLElement>('[aria-pressed="true"]'));
  void load(false);
  return () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('keydown', keydown); refresh.removeEventListener('click', reload); cards.clear(); };
}

function renderCard(card: HTMLElement, provider: Provider, result: AgentUsage): void {
  const plan = card.querySelector<HTMLElement>('.usage-plan')!;
  plan.textContent = result.plan ?? ''; plan.title = result.plan ?? '';
  const windows = validWindows(result);
  const body = card.querySelector<HTMLElement>('.usage-card-body')!;
  body.removeAttribute('role');
  const status = result.stale ? 'Saved snapshot' : STATUS[result.status] ?? 'Unavailable';
  card.classList.toggle('usage-stale', result.stale);
  body.innerHTML = `${windows.length ? `<div class="usage-windows">${windows.map(window => renderWindow(provider, window)).join('')}</div>` : ''}
    ${status || result.message || !windows.length ? `<div class="usage-notice">${status ? `<span class="usage-state">${escape(status)}</span>` : ''}${result.message ? `<p>${escape(result.message)}</p>` : !windows.length ? '<p>This account did not report any usage windows.</p>' : ''}</div>` : ''}
    <div class="usage-card-footer"><span>${result.checkedAt > 0 ? `${result.stale ? 'Last success' : 'Checked'} ${escape(new Date(result.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}</span>${result.source ? infoMark(result.source, `${provider.name} usage source`) : ''}${dashboardLink(result.dashboardUrl)}</div>`;
}

function renderWindow(provider: Provider, window: UsageWindow): string {
  const value = Math.min(100, Math.max(0, window.usedPercent));
  const tone = value >= 95 ? 'exhausted' : value >= 80 ? 'high' : 'normal';
  const reset = window.resetsAt ? new Date(window.resetsAt) : null;
  const validReset = reset && Number.isFinite(reset.getTime()) ? reset : null;
  const detail = [window.detail, validReset ? `Resets ${validReset.toLocaleString()}` : ''].filter(Boolean).join('. ');
  return `<div class="usage-window" data-tone="${tone}"><div class="usage-window-heading"><span>${escape(window.label)}</span><strong>${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}% used</strong></div><div class="usage-track" role="progressbar" aria-label="${escape(`${provider.name} · ${window.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${value}% used"><span style="width:${value}%"></span></div><div class="usage-reset"><span>${validReset ? resetLabel(validReset) : 'Reset time not reported'}</span>${detail ? infoMark(detail, `${provider.name} ${window.label} details`) : ''}</div></div>`;
}

function resetLabel(reset: Date): string {
  const minutes = Math.ceil((reset.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return 'Reset due · refresh to check';
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `Resets ${reset.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

function dashboardLink(value?: string | null): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return `<button type="button" class="usage-dashboard" data-action="open-url" data-url="${escape(url.href)}">View account ${icon('forward')}</button>`;
  } catch { return ''; }
}
