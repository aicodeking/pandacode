import './motion.css';
import './tray-popover.css';
import { accentTokens } from './palette-core';
import { CLASSIC } from './palette';
import { parseHex } from './color';
import { call, preview } from './bridge';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import type { AgentUsage } from './agent-usage';
import type { ProviderId } from './types';

/* The menu bar popover: a slim list of running, waiting and finished tasks plus plan usage. */
interface TrayTask { id: string; title: string; project: string; provider: ProviderId; at: number; failed?: boolean }
interface TraySnapshot { running: TrayTask[]; waiting: TrayTask[]; finished: TrayTask[]; usage: AgentUsage[]; checking: boolean }

const NAMES: Partial<Record<ProviderId, string>> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', opencode: 'OpenCode', kilo: 'Kilo', antigravity: 'Antigravity', grok: 'Grok', mimo: 'MiMo', deepseek: 'DeepSeek', pi: 'Pi', cline: 'Cline', muse: 'Muse', commandcode: 'Command Code', omp: 'Oh My Pi', 'github-copilot': 'Copilot' };
const root = document.documentElement;

function refreshTheme(): void {
  try { root.dataset.theme = localStorage.getItem('pandacode.theme') === 'light' ? 'light' : 'dark'; } catch { /* Default to dark. */ }
  // The classic accent lives in the workspace stylesheet; derive it here instead.
  if (!root.style.getPropertyValue('--accent')) {
    for (const [name, value] of Object.entries(accentTokens(parseHex(CLASSIC)!.rgb, root.dataset.theme as 'light' | 'dark'))) root.style.setProperty(name, value);
  }
}
refreshTheme();
// The workspace changed light/dark or its palette: start over with the new colors.
window.addEventListener('storage', event => { if (event.key === 'pandacode.theme' || event.key === 'pandacode.palette') location.reload(); });

const host = document.querySelector<HTMLDivElement>('#app')!;
host.innerHTML = `<main class="tray" aria-label="PandaCode"><header class="tray-header"><img class="tray-mark" src="/icon.svg" alt=""><strong>PandaCode</strong><span class="tray-summary"></span><button type="button" class="tray-icon-button tray-open-app" aria-label="Open PandaCode" title="Open PandaCode">${icon('external')}</button></header><div class="tray-body"></div><footer class="tray-footer"><button type="button" class="tray-open-app">Open PandaCode</button><button type="button" class="tray-quit">Quit</button></footer></main>`;
const body = host.querySelector<HTMLDivElement>('.tray-body')!;
const summary = host.querySelector<HTMLSpanElement>('.tray-summary')!;
let snapshot: TraySnapshot | null = null;

function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${Math.floor(minutes / 1440)}d`;
}
function resetLabel(value?: string | null): string {
  const reset = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(reset)) return '';
  const left = reset - Date.now();
  return left <= 0 ? 'reset due' : left < 86_400_000 ? `resets in ${duration(left)}` : `resets ${new Date(reset).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
const tone = (value: number) => value >= 95 ? 'exhausted' : value >= 80 ? 'high' : 'normal';
const name = (id: string) => NAMES[id as ProviderId] ?? id;

function row(task: TrayTask, kind: 'running' | 'waiting' | 'finished'): string {
  const elapsed = duration(Date.now() - task.at);
  const sub = [task.project, kind === 'finished' ? (elapsed === 'now' ? 'just now' : `${elapsed} ago`) : elapsed].filter(Boolean).join(' · ');
  const status = kind === 'running' ? '<span class="tray-spinner" aria-label="Running"></span>'
    : kind === 'waiting' ? '<span class="tray-pill">Respond</span>'
    : task.failed ? `<span class="tray-result failed" aria-label="Failed">${icon('close')}</span>` : `<span class="tray-result" aria-label="Done">${icon('check')}</span>`;
  return `<button type="button" class="tray-row" data-id="${escape(task.id)}"><span class="tray-logo">${providerLogo(task.provider)}</span><span class="tray-text"><span class="tray-title">${escape(task.title || 'Untitled task')}</span><span class="tray-sub">${escape(sub)}</span></span>${status}</button>`;
}

function usageBlock(usage: AgentUsage): string {
  const windows = usage.windows.map(window => {
    const value = Math.min(100, Math.max(0, window.usedPercent));
    const reset = resetLabel(window.resetsAt);
    return `<div class="tray-window" data-tone="${tone(value)}"><span class="tray-window-label">${escape(window.label)}</span><span class="tray-bar" role="progressbar" aria-label="${escape(`${name(usage.provider)} ${window.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value)}"><span style="width:${value}%"></span></span><span class="tray-percent">${Math.round(value)}%</span>${reset ? `<span class="tray-reset">${escape(reset)}</span>` : ''}</div>`;
  }).join('');
  const plan = usage.plan ? `<span class="tray-chip">${escape(usage.plan)}</span>` : '';
  const stale = usage.stale ? '<span class="tray-stale">stale</span>' : '';
  return `<div class="tray-usage"><div class="tray-usage-head"><span class="tray-logo">${providerLogo(usage.provider)}</span><span>${escape(name(usage.provider))}</span>${plan}${stale}</div>${windows}</div>`;
}

function render(): void {
  if (!snapshot) return;
  const { running, waiting, finished, usage, checking } = snapshot;
  const parts = [running.length && `${running.length} running`, (waiting.length + finished.length) && `${waiting.length + finished.length} to review`].filter(Boolean);
  summary.textContent = parts.length ? parts.join(' · ') : 'All quiet';
  const sections = ([['Running', running, 'running'], ['Needs you', waiting, 'waiting'], ['Finished', finished, 'finished']] as const)
    .filter(([, tasks]) => tasks.length)
    .map(([label, tasks, kind]) => `<section class="tray-section"><h2>${label}</h2>${tasks.map(task => row(task, kind)).join('')}</section>`).join('');
  const usageBody = usage.length ? usage.map(usageBlock).join('') : `<p class="tray-quiet">${checking ? 'Checking plan limits…' : 'No plan limits reported.'}</p>`;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.id;
  body.innerHTML = `${sections || '<p class="tray-quiet tray-empty">No agents running.</p>'}<section class="tray-section tray-plan"><h2>Plan usage<button type="button" class="tray-icon-button tray-refresh${checking ? ' checking' : ''}" aria-label="Refresh usage" title="Refresh usage"${checking ? ' aria-busy="true"' : ''}>${icon('refresh')}</button></h2>${usageBody}</section>`;
  if (focused) body.querySelector<HTMLElement>(`.tray-row[data-id="${CSS.escape(focused)}"]`)?.focus();
  void call('tray_resize', { height: Math.ceil(host.querySelector('.tray')!.getBoundingClientRect().height) }).catch(() => undefined);
}

async function load(): Promise<void> {
  try { snapshot = await call<TraySnapshot>('tray_snapshot'); render(); }
  catch (error) { body.innerHTML = `<p class="tray-quiet">${escape(String(error))}</p>`; }
}

host.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) return;
  if (target.classList.contains('tray-row')) void call('tray_open', { sessionId: target.dataset.id });
  else if (target.classList.contains('tray-refresh')) { if (snapshot) { snapshot = { ...snapshot, checking: true }; render(); } void call('tray_refresh_usage'); }
  else if (target.classList.contains('tray-open-app')) void call('tray_show_app');
  else if (target.classList.contains('tray-quit')) void call('tray_quit');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { void call('tray_hide'); return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...body.querySelectorAll<HTMLElement>('.tray-row')];
  if (!rows.length) return;
  event.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
  rows[next].focus();
});

if (preview) void import('./preview').then(({ listen }) => listen('tray-changed', () => void load()));
else void import('@tauri-apps/api/event').then(({ listen }) => listen('tray-changed', () => void load()));
void load();
