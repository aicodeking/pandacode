import './agent-usage.css';
import { accountSignedOut, accountEmail, accountStatusIcon, accountPlan, accountWindows, meterTone, resetsAt, type PoolMember } from './account-status';
import { call, preview } from './bridge';
import type { ConnectionSnapshot } from './connections';
import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { Provider, ProviderId } from './types';
import { usageHeatmap } from './usage-heatmap';
import { clockLabel, fixButton, printedReset, statusLabel, type UsageAction } from './usage-labels';
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
  email?: string | null;
  plan?: string | null;
  message?: string | null;
  checkedAt: number;
  stale: boolean;
  source?: string | null;
  dashboardUrl?: string | null;
  /** When Refresh may ask a rate-limited service again (ms since the epoch). */
  retryAt?: number | null;
  /** When an automatic check (opening this panel) will ask it again. */
  autoRetryAt?: number | null;
  /** What fixes an error, when the backend knows: press Refresh, open Claude Code, unlock the Keychain, wait out a rate limit, update Claude Code, or note a non-subscription connection. */
  action?: UsageAction | null;
}
const help = 'Reads account limits from your locally configured agent accounts. Requests go directly to the provider or its CLI, never through PandaCode servers. No prompts are sent. Results are cached for one minute; Refresh asks each provider again at most every ten seconds. It asks right away when the last answer was a locked or blocked Keychain, or a check that took too long. Some providers do not expose their limits. Usage is shared with other apps using the same account.';
/** When a rate-limited provider is asked again: Refresh after `retryAt`, opening the panel after `autoRetryAt`. */
export function retryText(result: Pick<AgentUsage, 'retryAt' | 'autoRetryAt'> & { action?: UsageAction | null }, now = Date.now()): string {
  const manual = result.retryAt ?? 0;
  const automatic = result.autoRetryAt ?? 0;
  // A login only the user can fix (sign in, or a switch that is off): no times.
  if ((manual <= now && automatic <= now) || result.action === 'claude' || result.action === 'settings') return '';
  // An expired login Claude Code couldn't refresh: nothing retries in the background.
  if (result.action === 'expired' && automatic > now) return `Opening this panel after ${clockLabel(automatic, now)} will ask Claude Code again${manual > now ? '' : ', or press Refresh'}.`;
  const refresh = manual > now ? `Press Refresh after ${clockLabel(manual, now)} to check again` : 'Press Refresh to check again';
  return automatic > Math.max(manual, now) ? `${refresh}; opening this panel checks on its own after ${clockLabel(automatic, now)}.` : `${refresh}.`;
}
const RANGES: [Range, string][] = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const shortNames: Partial<Record<ProviderId, string>> = { claude: 'Claude', glm: 'GLM', mimo: 'MiMo', alibaba: 'Alibaba', kimi: 'Kimi', grok: 'Grok', pi: 'Pi', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo', omp: 'omp', 'github-copilot': 'Copilot', muse: 'Muse', devin: 'Devin', zcode: 'ZCode', hermes: 'Hermes', cursor: 'Cursor' };
type Tab = 'overview' | ProviderId;
/** Harnesses whose accounts can be pooled; `account_pool_status` reads their login files for the email and plan. */
const POOLED: ProviderId[] = ['claude', 'codex'];
interface Account { usage?: AgentUsage; member?: PoolMember; }

function validWindows(result: AgentUsage | undefined): UsageWindow[] {
  return result?.windows.filter(window => Number.isFinite(window.usedPercent)) ?? [];
}
function peak(result: AgentUsage | undefined): number | null {
  const windows = validWindows(result);
  return windows.length ? Math.min(100, Math.max(0, ...windows.map(window => window.usedPercent))) : null;
}
/** Why an IPC read failed: the native side rejects with its error string, the preview with an Error. */
function reason(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return typeof cause === 'string' && cause.trim() ? cause.trim() : fallback;
}
/** The windows an account shows: for pooled harnesses the same two as Settings → Providers, labelled the same way. */
function shownWindows(provider: ProviderId, result: AgentUsage | undefined): UsageWindow[] {
  return POOLED.includes(provider) ? accountWindows(result) : validWindows(result);
}
const SIGNED_OUT = 'Sign in from Settings → Providers.';
function signedOutResult(provider: ProviderId): AgentUsage {
  return { provider, status: 'signedOut', windows: [], plan: null, message: SIGNED_OUT, checkedAt: 0, stale: false };
}
function renderSignedOut(scope: HTMLElement): void {
  const body = scope.querySelector<HTMLElement>('.usage-card-body')!;
  delete body.dataset.loading;
  body.removeAttribute('role');
  body.innerHTML = `<div class="usage-notice usage-signed-out"><p>${escape(SIGNED_OUT)}</p><button type="button" class="secondary-button" data-action="settings-page" data-id="providers">Open Settings</button></div>`;
}
function renderSameLogin(scope: HTMLElement, name: string): void {
  const body = scope.querySelector<HTMLElement>('.usage-card-body')!;
  delete body.dataset.loading;
  body.removeAttribute('role');
  body.innerHTML = `<p class="usage-same-login">Same login as ${escape(name)}. Its usage is shown there.</p>`;
}
function accountHeading(id: string, name: string): string {
  return `<div class="usage-account-heading" data-account="${escape(id)}"><div class="usage-account-title"><h4${id ? '' : ' class="usage-connection-default"'} data-setup-name="${escape(name)}">${escape(name)}</h4><p class="usage-account-who"></p></div><div class="usage-account-meta"><span class="usage-pool-chip"></span><span class="usage-account-summary"></span></div></div>`;
}
function pricingNote(ledger: Ledger): string {
  const when = ledger.pricing.fetchedAt ? new Date(ledger.pricing.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return { live: t`Prices: LiteLLM public price list, updated ${when}.`, saved: t`Prices: saved LiteLLM price list from ${when}.`, bundled: t('Prices: the list bundled with PandaCode (offline).') }[ledger.pricing.source];
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
  const accounts = new Map<string, Account>();
  let ledger: Ledger | null = null, ledgerError: string | null = null, ledgerPending = false, prompts: PromptActivity | null = null;
  let range: Range = 'month', breakdown: 'model' | 'day' = 'model', tab: Tab = 'overview';
  let summaryCache: { ledger: Ledger; range: Range; summary: Summary } | null = null;

  host.classList.add('agent-usage');
  const tabs = [{ id: 'overview' as Tab, label: t('Overview'), logo: icon('activity') }, ...installed.map(provider => ({ id: provider.id as Tab, label: shortNames[provider.id] ?? provider.name, logo: providerLogo(provider.id) }))];
  host.innerHTML = `<div class="usage-toolbar"><div class="usage-tabs" role="tablist" aria-label="${t('Usage views')}">${tabs.map(entry => `<button type="button" role="tab" id="usage-tab-${entry.id}" aria-controls="usage-panel-${entry.id}" aria-selected="${entry.id === 'overview'}" tabindex="${entry.id === 'overview' ? 0 : -1}" data-tab="${entry.id}" aria-label="${escape(entry.label)}" title="${escape(entry.label)}">${entry.logo}<span>${escape(entry.label)}</span></button>`).join('')}</div>
      <button type="button" class="icon-button usage-refresh" aria-label="${t('Refresh usage')}" title="${t('Refresh')}">${icon('refresh')}</button></div>
    <div class="usage-panel usage-overview" role="tabpanel" id="usage-panel-overview" aria-labelledby="usage-tab-overview">
      <div class="usage-heroes"><div class="usage-hero usage-cost-hero"></div><div class="usage-hero usage-limit-hero"></div></div>
      <div class="usage-range-row"><span class="usage-caption">${t('Agents ')}${infoMark(help, t('About agent usage'))}</span><div class="usage-segmented usage-range" role="group" aria-label="${t('Period')}">${RANGES.map(([id, label]) => `<button type="button" data-range="${id}" aria-pressed="${id === range}">${label}</button>`).join('')}</div></div>
      <div class="usage-agents"></div><div class="usage-cost-details"></div>
    </div><p class="usage-footer" role="status"></p>${preview ? `<p class="usage-preview">${t('Browser preview · sample limits and costs')}</p>` : ''}`;
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
    card.innerHTML = `<header class="usage-card-heading">${providerLogo(provider.id)}<h3>${escape(provider.name)}</h3>${POOLED.includes(provider.id) ? '' : '<span class="usage-plan"></span>'}<span class="usage-card-checked"></span></header>${POOLED.includes(provider.id) ? accountHeading('', 'Default setup') : ''}<div class="usage-card-body" role="status" data-loading="true">Checking limits…</div><div class="usage-card-cost"></div><div class="usage-card-calendar"></div>`;
    host.insertBefore(card, footer); cards.set(provider.id, card);
  }
  // Named connections (issue #137): each is read through its own config folder and environment.
  const snapshotReady = call<ConnectionSnapshot>('connections_list');
  const connectionsReady = snapshotReady.then(snapshot => {
    if (disposed) return [];
    const named = snapshot.connections.filter(c => cards.has(c.provider));
    for (const connection of named) {
      const card = cards.get(connection.provider)!;
      if (!card.querySelector('.usage-account-heading[data-account=""]')) card.querySelector('.usage-card-body')!.insertAdjacentHTML('beforebegin', accountHeading('', 'Default setup'));
      card.querySelector<HTMLElement>('.usage-connection-default')!.hidden = false;
      const section = document.createElement('section'); section.className = 'usage-connection'; section.dataset.connection = connection.id; section.setAttribute('aria-label', connection.name);
      section.innerHTML = `${accountHeading(connection.id, connection.name)}<div class="usage-card-body" role="status" data-loading="true">Checking limits…</div>`;
      card.querySelector('.usage-card-cost')!.before(section);
      renderAccount(connection.provider, '');
    }
    for (const provider of POOLED) if (cards.has(provider)) renderAccount(provider, '');
    return named;
  }).catch(() => []);
  // Email, plan, sign-in and pool state per account: read locally on mount and Refresh. Signed-out accounts skip agent_usage.
  const memberGeneration = new Map<ProviderId, number>();
  const readMembers = (provider: ProviderId): Promise<PoolMember[]> => {
    const generation = (memberGeneration.get(provider) ?? 0) + 1;
    memberGeneration.set(provider, generation);
    return call<PoolMember[]>('account_pool_status', { provider })
      .then(members => memberGeneration.get(provider) === generation && Array.isArray(members) ? members : [])
      .catch(() => [] as PoolMember[]);
  };
  const membersReady = new Map(POOLED.filter(provider => cards.has(provider)).map(provider => [provider, readMembers(provider)]));
  async function refreshMembers(): Promise<void> {
    await Promise.all(POOLED.filter(provider => cards.has(provider)).map(async provider => {
      const request = readMembers(provider);
      membersReady.set(provider, request);
      const members = await request;
      if (disposed) return;
      for (const key of [...accounts.keys()]) if (key.startsWith(`${provider}/`)) accounts.delete(key);
      for (const member of members) {
        accounts.set(`${provider}/${member.id}`, { member });
        renderAccount(provider, member.id);
      }
    }));
  }
  const memberOf = async (provider: ProviderId, id: string) => (await membersReady.get(provider))?.find(member => member.id === id);
  const signedOut = async (provider: ProviderId, id: string) => (await memberOf(provider, id))?.signedIn === false;
  for (const [provider, members] of membersReady) {
    void Promise.all([connectionsReady, members]).then(([, members]) => {
      if (disposed) return;
      for (const member of members) { accounts.set(`${provider}/${member.id}`, { ...accounts.get(`${provider}/${member.id}`), member }); renderAccount(provider, member.id); }
    }).catch(() => undefined);
  }
  function renderAccount(provider: ProviderId, id: string): void {
    const heading = cards.get(provider)?.querySelector<HTMLElement>(`.usage-account-heading[data-account="${CSS.escape(id)}"]`);
    if (!heading) return;
    const { usage, member } = accounts.get(`${provider}/${id}`) ?? {};
    heading.querySelector('.usage-account-who')!.toggleAttribute('data-identity-unknown', !accountEmail(member, usage));
    heading.querySelector('.usage-account-who')!.textContent = accountEmail(member, usage) || (accountSignedOut(member, usage) ? 'Not signed in' : 'Email not available');
    const title = heading.querySelector<HTMLElement>('h4')!;
    title.textContent = [title.dataset.setupName, accountPlan(member, usage)].filter(Boolean).join(' · ');
    heading.querySelector('.usage-account-summary')!.textContent = '';
    const status = heading.querySelector<HTMLElement>('.usage-pool-chip')!;
    if (member) {
      const template = document.createElement('template');
      template.innerHTML = accountStatusIcon(member, usage, 'usage-pool-chip');
      const next = template.content.firstElementChild!;
      for (const attribute of [...status.attributes]) if (!next.hasAttribute(attribute.name)) status.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) status.setAttribute(attribute.name, attribute.value);
      status.innerHTML = next.innerHTML;
    }
  }
  function setUsage(provider: ProviderId, id: string, usage: AgentUsage): void {
    accounts.set(`${provider}/${id}`, { ...accounts.get(`${provider}/${id}`), usage });
    renderAccount(provider, id);
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
      return { provider: provider.id, name: provider.name, peak: peak(result), state: result ? (statusLabel(result) || 'No limits reported') : 'Checking…' };
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
      if (!calendar) { slot.innerHTML = ledger || prompts ? `<p class="usage-calendar-empty">${t('No activity recorded for this agent yet.')}</p>` : ''; continue; }
      const heatmap = usageHeatmap(calendar.daily, { unit: calendar.unit, label: calendar.unit === 'prompts' ? t`${nameOf(id)} daily prompts` : t`${nameOf(id)} daily tokens` });
      if (calendar.unit === 'prompts') heatmap.querySelector('.heatmap-heading h3')?.insertAdjacentHTML('beforeend', ` ${infoMark(t('This agent does not keep token logs PandaCode can read, so the calendar counts prompts you sent from PandaCode.'), t('About this calendar'))}`);
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

  /** Claude cards still checking, by setup (`''` or a connection id): one poll serves them all (`agent_usage_asking_claude`), at once and then each second. */
  const waiting = new Map<string, (answer: ClaudeWaiting) => void>();
  let waitTimer = 0;
  async function pollWaiting(): Promise<void> {
    const answers = await call<Record<string, ClaudeWaiting>>('agent_usage_asking_claude', { connections: [...waiting.keys()] }).catch(() => null);
    if (!answers || disposed) return;
    for (const [id, show] of waiting) if (answers[id]) show(answers[id]);
  }
  /** While a Claude card waits it shows its saved reading, and says "Asking Claude Code…" once PandaCode runs Claude Code for the check. */
  function watchAsking(provider: Provider, scope: HTMLElement, connection = '', dir?: string): () => void {
    if (provider.id !== 'claude') return () => {};
    const body = scope.querySelector<HTMLElement>('.usage-card-body')!;
    waiting.set(connection, answer => showWaiting(scope, body, provider, answer, dir));
    if (!waitTimer) { waitTimer = window.setInterval(() => void pollWaiting(), 1000); void pollWaiting(); }
    return () => { waiting.delete(connection); if (!waiting.size) { window.clearInterval(waitTimer); waitTimer = 0; } };
  }
  /** One provider's default setup: read, then shown. */
  async function loadDefault(provider: Provider, force: boolean): Promise<void> {
    if (await signedOut(provider.id, '')) {
      if (disposed) return;
      limits.set(provider.id, signedOutResult(provider.id));
      renderSignedOut(cards.get(provider.id)!); setUsage(provider.id, '', signedOutResult(provider.id)); renderLimits();
      preserveFocus(agentList, () => renderAgents(agentList, agentLimits(), costState()));
      return;
    }
    const stop = watchAsking(provider, cards.get(provider.id)!);
    let result: AgentUsage;
    try {
      result = await call<AgentUsage>('agent_usage', { provider: provider.id, refresh: force });
      if (!result || result.provider !== provider.id || !Array.isArray(result.windows)) throw new Error('Invalid usage result');
    } catch (cause) {
      result = { provider: provider.id, status: 'error', windows: [], checkedAt: Date.now(), stale: false, message: reason(cause, 'Could not read limits. Try Refresh.') };
    } finally { stop(); }
    if (disposed) return;
    limits.set(provider.id, result);
    renderCard(cards.get(provider.id)!, provider, result, await memberOf(provider.id, ''));
    if (disposed) return;
    setUsage(provider.id, '', result);
    renderLimits();
    preserveFocus(agentList, () => renderAgents(agentList, agentLimits(), costState()));
  }
  /** One named connection: read through its own setup, then shown in its section. */
  async function loadConnection(provider: Provider, connection: { id: string; name: string }, named: { id: string; name: string }[], force: boolean): Promise<void> {
    const section = cards.get(provider.id)?.querySelector<HTMLElement>(`.usage-connection[data-connection="${CSS.escape(connection.id)}"]`);
    if (!section) return;
    if (await signedOut(provider.id, connection.id)) { if (!disposed) { renderSignedOut(section); setUsage(provider.id, connection.id, signedOutResult(provider.id)); } return; }
    // A same-login connection is the other account under another name: its usage is shown there, so it is not read twice.
    const twin = (await memberOf(provider.id, connection.id))?.sameAs;
    if (twin != null) { if (!disposed) renderSameLogin(section, twin ? named.find(other => other.id === twin)?.name ?? twin : 'Default setup'); return; }
    const dir = (connection as { configDir?: string | null }).configDir ?? undefined;
    const stop = watchAsking({ ...provider, name: connection.name }, section, connection.id, dir);
    let result: AgentUsage;
    try {
      result = await call<AgentUsage>('agent_usage', { provider: provider.id, refresh: force, connection: connection.id });
      if (!result || !Array.isArray(result.windows)) throw new Error('Invalid usage result');
    } catch (cause) {
      result = { provider: provider.id, status: 'error', windows: [], checkedAt: Date.now(), stale: false, message: reason(cause, 'Could not read limits. Try Refresh.') };
    } finally { stop(); }
    const member = await memberOf(provider.id, connection.id);
    if (!disposed) { renderCard(section, { ...provider, name: connection.name }, result, member, dir); setUsage(provider.id, connection.id, result); }
  }
  async function loadLimits(force: boolean): Promise<void> {
    let next = 0;
    // A slow account cannot hold up the others. Bound parallel work in the UI as well
    // as the native cache, and stop starting requests as soon as this view is closed.
    async function worker(): Promise<void> {
      while (!disposed && next < installed.length) await loadDefault(installed[next++], force);
    }
    await Promise.all(Array.from({ length: Math.min(3, installed.length) }, worker));
    const named = await connectionsReady;
    for (const connection of named) {
      if (disposed) return;
      await loadConnection(installed.find(item => item.id === connection.provider)!, connection, named, force);
    }
  }
  /** A card's own Refresh: just that setup, whatever else is still loading. */
  async function refreshCard(button: HTMLButtonElement): Promise<void> {
    const card = button.closest<HTMLElement>('.usage-card');
    const provider = installed.find(item => cards.get(item.id) === card);
    if (!provider || button.disabled) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Refreshing…';
    const scope = button.closest<HTMLElement>('.usage-connection');
    const body = (scope ?? card!).querySelector<HTMLElement>('.usage-card-body')!;
    body.dataset.loading = 'true';
    if (!scope) { await loadDefault(provider, true); return; }
    const named = await connectionsReady;
    const connection = named.find(item => item.id === scope.dataset.connection);
    if (connection) { await loadConnection(provider, connection, named, true); return; }
    // The connection is gone: nothing to read, so the card is as it was.
    button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Refresh';
    delete body.dataset.loading;
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
      ledgerError = ledger ? null : cause instanceof Error && cause.message ? cause.message : t('Could not read local agent logs.');
