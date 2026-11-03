import './task-usage.css';
import { escape, icon } from './dom';
import { formatTokens, formatUsd } from './usage-ledger';
import { hidePopover, showPopover } from './popover-motion';
import type { TaskTokenUsage } from './types';

type UsageState = { kind: 'loading' } | { kind: 'ready'; value: TaskTokenUsage | null } | { kind: 'error' };
const tokens = (usage: TaskTokenUsage): number => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
const partial = (usage: TaskTokenUsage): boolean => usage.unpricedTokens > 0 || usage.missingSessions > 0;
const money = (value: number): string => value > 0 && value < 0.01 ? '<$0.01' : formatUsd(value);

function label(state: UsageState): string {
  if (state.kind === 'loading') return 'Reading usage…';
  if (state.kind === 'error' || !state.value) return 'Usage unavailable';
  const usage = state.value;
  return `${formatTokens(tokens(usage))} tokens · ${usage.costUsd === null ? 'Cost unavailable' : `${money(usage.costUsd)} est.`}${partial(usage) ? ' · Partial' : ''}`;
}

function details(state: UsageState): string {
  if (state.kind === 'loading') return '<p role="status">Reading this task’s local usage records…</p>';
  if (state.kind === 'error') return '<p role="status">Could not read this task’s usage. Close and reopen to try again.</p>';
  if (!state.value) return '<p>No usage records are available for this task yet.</p><p class="task-usage-note">Usage is currently tracked from local Codex and Claude Code logs. Other agents and work on another computer may be unavailable.</p>';
  const usage = state.value;
  const row = (name: string, value: string) => `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
  const exact = (value: number) => value.toLocaleString();
  const pricing = usage.pricing?.source === 'bundled' ? 'Bundled prices' : 'Saved prices';
  const date = usage.pricing?.fetchedAt ? ` · ${new Date(usage.pricing.fetchedAt).toLocaleDateString()}` : '';
  return `<div class="task-usage-hero"><strong>${usage.costUsd === null ? 'Unavailable' : escape(money(usage.costUsd))}</strong><span>${partial(usage) ? 'Partial estimated API cost' : 'Estimated API cost'} · USD</span></div>
    <dl class="task-usage-totals">${row('Total tokens', exact(tokens(usage)))}${row('Input (uncached)', exact(usage.input))}${row('Output', exact(usage.output))}${row('Cache reads', exact(usage.cacheRead))}${row('Cache writes', exact(usage.cacheWrite))}</dl>
    <h3>By model</h3><ul class="task-usage-models">${usage.models.map(model => `<li><div><strong>${escape(model.model)}</strong><small>${model.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${escape(exact(model.tokens))} tokens</small></div><span>${model.costUsd === null ? 'Unpriced' : escape(money(model.costUsd))}</span></li>`).join('')}</ul>
    ${usage.unpricedTokens ? `<p class="task-usage-note">${escape(exact(usage.unpricedTokens))} tokens have no known price and are excluded from the estimate.</p>` : ''}
    ${usage.missingSessions ? '<p class="task-usage-note">Some linked sessions have no local usage records. These totals are partial.</p>' : ''}
    <p class="task-usage-note">API-equivalent estimate, not a bill or subscription charge. Uses available local Codex and Claude Code logs; separate worker tasks are excluded.</p>
    <p class="task-usage-source">${escape(pricing + date)}</p>`;
}

/** One local read on visiting a task and after each response, never a polling timer. */
export function createTaskUsage(host: { call: <T>(command: string, args: Record<string, unknown>) => Promise<T> }) {
  const cache = new Map<string, UsageState>();
  const requests = new Map<string, number>();
  let current: string | null = null, panel: HTMLElement | undefined, anchor: HTMLElement | undefined;
  let cleanup: (() => void) | undefined;

  function close(restore = false): void {
    if (!panel) return;
    hidePopover(panel); panel = undefined;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restore && anchor?.isConnected) anchor.focus({ preventScroll: true });
    cleanup?.(); cleanup = undefined;
  }

  function place(): void {
    if (!panel || !anchor?.isConnected) { close(); return; }
    const rect = anchor.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width))}px`;
    panel.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;
    panel.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
  }

  function paint(): void {
    const button = document.querySelector<HTMLElement>('.task-usage-button');
    if (!button) { close(); return; }
    button.hidden = !current;
    if (!current) return;
    const state = cache.get(current) ?? { kind: 'loading' };
    button.textContent = label(state);
    button.setAttribute('aria-label', `Task usage: ${label(state)} — show breakdown`);
    button.setAttribute('aria-expanded', String(Boolean(panel)));
    button.parentElement?.classList.remove('is-empty');
    anchor = button;
    if (panel) {
      panel.querySelector('.task-usage-content')!.innerHTML = details(state);
      place();
    }
  }

  async function load(id: string): Promise<void> {
    const request = (requests.get(id) ?? 0) + 1;
    requests.set(id, request);
    if (!cache.has(id)) cache.set(id, { kind: 'loading' });
    try {
      const value = await host.call<TaskTokenUsage | null>('task_token_usage', { sessionId: id });
      if (requests.get(id) !== request) return;
      cache.set(id, { kind: 'ready', value });
    } catch {
      if (requests.get(id) !== request) return;
      cache.set(id, { kind: 'error' });
    }
    if (current === id) paint();
  }

  function render(id: string | null): void {
    if (id !== current) close();
    current = id;
    if (id && !cache.has(id)) void load(id);
    paint();
  }

  function open(button: HTMLElement): void {
    if (panel) { close(true); return; }
    if (!current) return;
    anchor = button;
    panel = document.createElement('section');
    panel.className = 'floating-menu task-usage-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'task-usage-title');
    panel.dataset.placement = 'above';
    panel.innerHTML = `<header><h2 id="task-usage-title">Task usage</h2><button type="button" class="icon-button" aria-label="Close task usage">${icon('close')}</button></header><div class="task-usage-content"></div>`;
    document.body.append(panel);
    paint(); showPopover(panel, button);
    panel.querySelector('button')!.addEventListener('click', () => close(true));
    panel.querySelector('button')!.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (panel && !panel.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); } };
    const focus = (event: FocusEvent) => { if (panel && !panel.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close(); };
    const observer = new MutationObserver(() => { if (!anchor?.isConnected) close(); });
    observer.observe(document.querySelector('#composer-area')!, { childList: true, subtree: true });
    const resize = new ResizeObserver(place);
    resize.observe(button);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    window.addEventListener('resize', place);
    cleanup = () => {
      observer.disconnect(); resize.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('resize', place);
    };
    // Reopening also picks up logs that arrived just after the response finished.
    void load(current);
  }

  return { render, open, refresh(id: string) {
    // Invalidate in-flight reads too: an older response must never restore stale totals.
    requests.set(id, (requests.get(id) ?? 0) + 1);
    if (current === id) void load(id);
    else cache.delete(id);
  } };
}
