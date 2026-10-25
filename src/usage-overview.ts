import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { ProviderId } from './types';
import { costChart } from './usage-cost-chart';
import { formatShare, formatTokens, formatUsd, RANGE_LABEL, type Summary } from './usage-ledger';

export interface AgentLimit { provider: ProviderId; name: string; peak: number | null; state: string; }
export type CostState = { kind: 'pending' } | { kind: 'error'; message: string } | { kind: 'ready'; summary: Summary; tracked: ProviderId[]; pricing: string };

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const TRACKED_LOGS = 'Claude Code and Codex';

export function tone(value: number): 'exhausted' | 'high' | 'normal' { return value >= 95 ? 'exhausted' : value >= 80 ? 'high' : 'normal'; }

/** A ring for the average of each agent's most-used limit window. */
export function renderLimitHero(host: HTMLElement, limits: readonly AgentLimit[], average: number | null, pending: number): void {
  const reporting = limits.filter(limit => limit.peak !== null).length;
  const value = average ?? 0;
  const circumference = 2 * Math.PI * 26;
  const caption = average === null
    ? pending ? t('Checking account limits…') : t('No agent reported a limit.')
    : reporting === 1
      ? t`Across 1 agent${pending ? t` · ${pending} still checking` : ''}`
      : t`Across ${reporting} agents${pending ? t` · ${pending} still checking` : ''}`;
  host.dataset.tone = tone(value);
  host.innerHTML = `<svg class="usage-ring" viewBox="0 0 64 64" role="img" aria-label="${average === null ? t('Average limit use unavailable') : t`Average limit use ${percent.format(value)}%`}">
      <circle cx="32" cy="32" r="26" class="usage-ring-track"/>
      <circle cx="32" cy="32" r="26" class="usage-ring-value" stroke-dasharray="${((Math.min(100, value) / 100) * circumference).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 32 32)"/>
    </svg>
    <div class="usage-hero-copy"><span class="usage-hero-label">${t('Average limit use ')}${infoMark(t('The average of each agent’s most-used limit window, such as a 5-hour or weekly window. Agents that do not report limits are left out.'), t('About average limit use'))}</span>
      <strong class="usage-hero-value">${average === null ? '—' : `${percent.format(value)}%`}</strong><small>${escape(caption)}</small></div>`;
}

/** Agents in one list: color key for the chart, limit, and estimated cost. Each row opens that agent's tab. */
export function renderAgents(host: HTMLElement, limits: readonly AgentLimit[], cost: CostState): void {
  const summary = cost.kind === 'ready' ? cost.summary : null;
  const total = summary?.totals.cost ?? 0;
  const byProvider = new Map(summary?.agents.map(agent => [agent.provider, agent]));
  const order = [...limits].sort((a, b) => (byProvider.get(b.provider)?.cost ?? -1) - (byProvider.get(a.provider)?.cost ?? -1));
  host.innerHTML = order.map(limit => {
    const agent = byProvider.get(limit.provider);
    const tracked = cost.kind === 'ready' && cost.tracked.includes(limit.provider);
    const amount = agent ? formatUsd(agent.cost) : tracked ? '$0.00' : '';
    const detail = agent
      ? `${t`${formatShare(agent.cost, total)} of cost`} · ${t`${formatTokens(agent.tokens)} tokens`}${agent.sessions ? ` · ${agent.sessions === 1 ? t`1 session` : t`${agent.sessions} sessions`}` : ''}`
      : tracked ? t('No usage in this period') : t('Cost not tracked');
    const peak = limit.peak === null ? `<span class="usage-agent-limit" data-state="none">${escape(limit.state)}</span>`
      : `<span class="usage-agent-limit" data-tone="${tone(limit.peak)}"><span class="usage-mini-track"><span style="width:${Math.min(100, limit.peak)}%"></span></span>${percent.format(limit.peak)}%</span>`;
    return `<button type="button" class="usage-agent-row" data-provider="${limit.provider}" aria-label="${escape(`${limit.name}. ${amount ? t`${amount} estimated. ` : ''}${detail}. ${limit.peak === null ? limit.state : t`${percent.format(limit.peak)}% of limit used`}. ${t('Open details')}`)}">
      <span class="usage-agent-dot" data-provider="${limit.provider}" aria-hidden="true"></span>${providerLogo(limit.provider)}
      <span class="usage-agent-copy"><strong>${escape(limit.name)}</strong><small>${escape(detail)}</small></span>
      ${peak}<span class="usage-agent-cost">${escape(amount)}</span>${icon('chevron', 'usage-agent-chevron')}</button>`;
  }).join('');
}

function totalsGrid(summary: Summary): string {
  const totals = summary.totals;
  const cells = [
    [t('Processed tokens'), formatTokens(totals.tokens)], [t('Cached input'), formatTokens(totals.cacheRead)], [t('Uncached input'), formatTokens(totals.input + totals.cacheWrite)],
    [t('Output'), formatTokens(totals.output)], [t('Cache savings'), formatUsd(totals.savings)],
  ];
  return `<dl class="usage-totals">${cells.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
}

function breakdownTable(summary: Summary, by: 'model' | 'day'): string {
  const total = summary.totals.cost;
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const rows = by === 'model'
    ? summary.models.map(row => `<tr><th scope="row">${providerLogo(row.provider)}<span>${escape(row.model)}</span>${row.priced ? '' : `<small>${t('unpriced')}</small>`}</th><td>${row.priced ? formatUsd(row.cost) : '—'}</td><td>${formatShare(row.cost, total)}</td><td>${formatTokens(row.tokens)}</td></tr>`)
    : [...summary.dailyCost].reverse().filter(day => day.tokens > 0).map(day => {
      const [y, m, d] = day.date.split('-').map(Number);
      return `<tr><th scope="row"><span>${escape(date.format(new Date(y, m - 1, d)))}</span></th><td>${formatUsd(day.cost)}</td><td>${formatShare(day.cost, total)}</td><td>${formatTokens(day.tokens)}</td></tr>`;
    });
  return `<table class="usage-breakdown"><thead><tr><th scope="col">${by === 'model' ? t('Model') : t('Day')}</th><th scope="col">${t('Cost')}</th><th scope="col">${t('Share')}</th><th scope="col">${t('Tokens')}</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="4" class="usage-breakdown-empty">${t('No usage in this period.')}</td></tr>`}</tbody></table>`;
}

/** The cost headline for the selected range; the chart, totals, and breakdown follow it. */
export function renderCostHero(host: HTMLElement, cost: CostState): void {
  const about = t`Estimated from token counts in ${TRACKED_LOGS} logs on this computer, read when this window opens. Only counts are kept and nothing is uploaded. Priced at standard API rates (batch, priority, and fast-mode pricing excluded); subscriptions bill differently.`;
  const label = `<span class="usage-hero-label">${t('Estimated API cost ')}${infoMark(cost.kind === 'ready' ? `${about} ${cost.pricing}` : about, t('About estimated API cost'))}</span>`;
  if (cost.kind === 'pending') { host.innerHTML = `${label}<strong class="usage-hero-value usage-hero-pending">$—</strong><small role="status">${t('Reading local agent logs…')}</small>`; return; }
  if (cost.kind === 'error') { host.innerHTML = `${label}<strong class="usage-hero-value">—</strong><small role="alert">${escape(cost.message)}</small>`; return; }
  const { summary } = cost;
  const unpriced = summary.totals.unpricedTokens / (summary.totals.tokens || 1);
  const notes = [summary.sessions === 1 ? t`1 session` : t`${summary.sessions} sessions`, RANGE_LABEL[summary.range].toLowerCase()];
  if (unpriced > 0) notes.push(t`excludes ${formatShare(summary.totals.unpricedTokens, summary.totals.tokens)} unpriced tokens`);
  host.innerHTML = `${label}<strong class="usage-hero-value">${formatUsd(summary.totals.cost)}</strong><small>${escape(notes.join(' · '))}</small>`;
}

export function renderCostDetails(host: HTMLElement, cost: CostState, names: (id: ProviderId) => string, breakdown: 'model' | 'day'): void {
  if (cost.kind !== 'ready') { host.replaceChildren(); return; }
  const { summary } = cost;
  if (!summary.totals.tokens) {
    host.innerHTML = `<p class="usage-cost-empty">${cost.tracked.length ? t`No ${TRACKED_LOGS} usage in this period.` : t`No ${TRACKED_LOGS} logs were found on this computer.`}</p>`;
    return;
  }
  const chart = document.createElement('section'); chart.className = 'usage-section usage-chart-section';
  chart.innerHTML = `<h3>${summary.range === 'year' ? t('Weekly cost') : t('Daily cost')}</h3>`;
  chart.append(costChart({ series: summary.series.map(line => ({ ...line, name: names(line.provider) })), buckets: summary.buckets }));
  const totals = document.createElement('section'); totals.className = 'usage-section';
  totals.innerHTML = `<h3>${t('Totals')}</h3>${totalsGrid(summary)}`;
  const table = document.createElement('section'); table.className = 'usage-section usage-breakdown-section';
  table.innerHTML = `<header class="usage-section-heading"><h3>${t('Breakdown')}</h3><div class="usage-segmented usage-breakdown-switch" role="group" aria-label="${t('Break down by')}">
      <button type="button" data-breakdown="model" aria-pressed="${breakdown === 'model'}">${t('Model')}</button><button type="button" data-breakdown="day" aria-pressed="${breakdown === 'day'}">${t('Day')}</button></div></header>
    <div class="usage-breakdown-scroll">${breakdownTable(summary, breakdown)}</div>`;
  host.replaceChildren(chart, totals, table);
}

/** Per-agent cost strip inside an agent tab. */
export function agentCostStrip(provider: ProviderId, cost: CostState): string {
  if (cost.kind !== 'ready' || !cost.tracked.includes(provider)) return '';
  const agent = cost.summary.agents.find(entry => entry.provider === provider);
  const models = cost.summary.models.filter(model => model.provider === provider);
  const stats = agent
    ? [[formatUsd(agent.cost), t('Estimated API cost')], [formatTokens(agent.tokens), t('Tokens')], [formatTokens(agent.cacheRead), t('Cached input')], [String(agent.sessions), agent.sessions === 1 ? t('Session') : t('Sessions')]]
    : [['$0.00', t('Estimated API cost')]];
  return `<section class="usage-section usage-agent-cost-section"><h3>${escape(RANGE_LABEL[cost.summary.range])}</h3>
    <dl class="usage-totals usage-totals-compact">${stats.map(([value, label]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
    ${models.length ? `<ul class="usage-model-list">${models.map(model => `<li><span>${escape(model.model)}</span><span>${model.priced ? formatUsd(model.cost) : t('unpriced')}</span><span>${formatTokens(model.tokens)}</span></li>`).join('')}</ul>` : ''}</section>`;
}
