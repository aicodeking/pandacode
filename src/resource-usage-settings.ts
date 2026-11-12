import { call, preview } from './bridge';
import { escape, icon } from './dom';
import { errorText } from './error-text';
import type { Metrics } from './types';

const megabytes = (value: number) => `${(value / 1048576).toFixed(1)} MB`;

/** Settings → About: a snapshot of PandaCode's own resource use, refreshed on demand. */
export function resourceUsageHtml(): string {
  return `<div class="settings-group settings-resources" aria-labelledby="settings-resources-heading">
    <div class="setting-row"><div><strong id="settings-resources-heading">Resource usage</strong><small>${preview ? 'Sample mode. Native memory measurements are available in the desktop app.' : 'A snapshot of the native core. The system webview and agent processes are not included in core memory.'}</small></div><button type="button" class="secondary-button settings-resources-refresh">${icon('refresh')}Refresh</button></div>
    <div class="setting-row"><div><strong>Native core memory</strong></div><span class="settings-metric" data-metric="coreRssBytes">…</span></div>
    <div class="setting-row"><div><strong>Active agents</strong></div><span class="settings-metric" data-metric="activeAgents">…</span></div>
    <div class="setting-row"><div><strong>Open terminals</strong></div><span class="settings-metric" data-metric="activeTerminals">…</span></div>
    <div class="setting-row"><div><strong>Local database</strong></div><span class="settings-metric" data-metric="databaseBytes">…</span></div>
  </div>`;
}

function format(key: keyof Metrics, metrics: Metrics): string {
  if (key === 'coreRssBytes' || key === 'databaseBytes') return preview ? '—' : megabytes(metrics[key]);
  return String(metrics[key]);
}

export function mountResourceUsage(host: HTMLElement): () => void {
  const button = host.querySelector<HTMLButtonElement>('.settings-resources-refresh')!;
  const cells = [...host.querySelectorAll<HTMLElement>('[data-metric]')];
  let disposed = false;
  const refresh = async () => {
    button.disabled = true;
    try {
      const metrics = await call<Metrics>('get_metrics');
      if (disposed) return;
      for (const cell of cells) cell.textContent = format(cell.dataset.metric as keyof Metrics, metrics);
    } catch (cause) {
      console.error('Reading resource usage failed', cause);
      if (!disposed) for (const cell of cells) cell.innerHTML = `<span title="${escape(errorText(cause))}">Unavailable</span>`;
    } finally {
      if (!disposed) button.disabled = false;
    }
  };
  const click = () => { void refresh(); };
  button.addEventListener('click', click);
  void refresh();
  return () => { disposed = true; button.removeEventListener('click', click); };
}
