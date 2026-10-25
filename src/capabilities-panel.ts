import './capabilities-panel.css';
import { preview } from './bridge';
import { escape, icon } from './dom';
import { t } from './i18n.ts';

export type CapabilityHarness = { id: string; name: string };
export type CapabilityEntry = { harness: string; kind: string; name: string; state: string; source: string; command: string | null };
export type CapabilityMatrixRow = { kind: string; name: string; states: { harness: string; state: string }[] };
export type CapabilityInventory = { harnesses: CapabilityHarness[]; entries: CapabilityEntry[]; matrix: CapabilityMatrixRow[]; warnings: string[] };
export type CacheAlignment = {
  taskProvider: string | null;
  harnesses: {
    id: string; name: string; instructionDelivery: string; state: string; cacheTokens: string;
    cacheReadTokens: number | null; cacheCreationTokens: number | null; cacheTokenSource: string;
  }[];
};
export type CapabilityCall = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const tokenCount = (value: number | null) => value == null ? '—' : new Intl.NumberFormat().format(value);
const deliveryLabel = (value: string) => value === 'cachedSystemPrompt'
  ? t('Cached system prompt')
  : value === 'messageInjection'
    ? t('Message injection')
    : value;

function inventoryTable(data: CapabilityInventory | null, loading: boolean, failed: boolean): string {
  if (loading) return `<p class="capabilities-table-status" role="status">${t('Reading local harness metadata…')}</p>`;
  if (failed) return `<p class="capabilities-table-status" role="alert">${t('Could not read the capability inventory. Try refreshing.')}</p>`;
  if (!data?.harnesses.length) return `<p class="capabilities-table-status">${t('No installed harnesses were found.')}</p>`;
  if (!data.matrix.length) return `<p class="capabilities-table-status">${t('No commands, integrations, hooks, plugins, or skills were discovered.')}</p>`;

  const entryByKey = new Map(data.entries.map(entry => [entry.harness + '\u0000' + entry.kind + '\u0000' + entry.name, entry]));
  const headings = data.harnesses.map(harness => `<th scope="col">${escape(harness.name)}</th>`).join('');
  const rows = data.matrix.map(row => {
    const states = row.states.map(cell => {
      const entry = entryByKey.get(cell.harness + '\u0000' + row.kind + '\u0000' + row.name);
      const command = entry?.command ? `<small class="capabilities-command">${escape(entry.command)}</small>` : '';
      const source = entry ? `<small class="capabilities-source">${escape(entry.source)}</small>` : '';
      const label = cell.state === 'native' ? t('Native') : cell.state === 'discovered' ? t('Discovered') : t('Missing');
      return `<td><span class="capabilities-state" data-state="${escape(cell.state)}">${label}</span>${command}${source}</td>`;
    }).join('');
    return `<tr><th scope="row"><span>${escape(row.name)}</span><small>${escape(row.kind)}</small></th>${states}</tr>`;
  }).join('');
  return `<div class="capabilities-table-scroll"><table class="capabilities-table" aria-label="${t('Capability alignment')}">
    <thead><tr><th scope="col">${t('Capability')}</th>${headings}</tr></thead><tbody>${rows}</tbody>
  </table></div>${data.warnings.length ? `<p class="capabilities-table-status" role="status">${escape(data.warnings.join(' '))}</p>` : ''}`;
}

function cacheTable(data: CacheAlignment | null, loading: boolean, failed: boolean): string {
  if (loading) return `<p class="capabilities-table-status" role="status">${t('Reading cache alignment…')}</p>`;
  if (failed) return `<p class="capabilities-table-status" role="alert">${t('Could not read cache alignment. Try refreshing.')}</p>`;
  if (!data?.harnesses.length) return `<p class="capabilities-table-status">${t('No installed harnesses were found.')}</p>`;
  const rows = data.harnesses.map(harness => {
    const observed = harness.cacheTokens === 'observed';
    const stateLabel = harness.state === 'supported' ? t('Supported') : harness.state === 'partial' ? t('Partial') : harness.state;
    const read = observed ? tokenCount(harness.cacheReadTokens) : t('Not exposed');
    const created = observed ? tokenCount(harness.cacheCreationTokens) : t('Not exposed');
    return `<tr>
      <th scope="row">${escape(harness.name)}</th>
      <td>${escape(deliveryLabel(harness.instructionDelivery))}</td>
      <td><span class="capabilities-state" data-state="${escape(harness.state)}">${escape(stateLabel)}</span></td>
      <td><span class="capabilities-token-label" title="${escape(harness.cacheTokenSource)}">${observed ? t('Observed') : t('Not exposed')}</span><span class="capabilities-token-value">${escape(read)}</span></td>
      <td><span class="capabilities-token-label" title="${escape(harness.cacheTokenSource)}">${observed ? t('Observed') : t('Not exposed')}</span><span class="capabilities-token-value">${escape(created)}</span></td>
    </tr>`;
  }).join('');
  return `<div class="capabilities-table-scroll"><table class="capabilities-table capabilities-cache-table" aria-label="${t('Cache alignment')}">
    <thead><tr><th scope="col">${t('Harness')}</th><th scope="col">${t('Stable instructions')}</th><th scope="col">${t('Alignment')}</th><th scope="col">${t('Cache reads')}</th><th scope="col">${t('Cache creation')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** Read-only Settings panel for local CLI capabilities and prompt-cache alignment. */
export function mount(host: HTMLElement, call: CapabilityCall, taskId?: string): () => void {
  let inventory: CapabilityInventory | null = null;
  let cache: CacheAlignment | null = null;
  let loading = true;
  let inventoryFailed = false;
  let cacheFailed = false;
  let disposed = false;
  let request = 0;
  const args = taskId ? { taskId } : {};
  const draw = () => {
    if (disposed) return;
    host.innerHTML = `<div class="settings-group capabilities-panel" aria-labelledby="capabilities-heading">
      <div class="capabilities-panel-head"><div><strong id="capabilities-heading">${t('Capability and cache alignment')}</strong><small>${t('Read-only metadata from local harness configs and recorded usage.')}</small></div>
        <button type="button" class="secondary-button capabilities-refresh" ${loading ? 'disabled' : ''}>${icon('refresh')}${t('Refresh')}</button>
      </div>
      <section class="capabilities-section" aria-labelledby="capabilities-inventory-heading">
        <h3 id="capabilities-inventory-heading">${t('Capability inventory')}</h3>
        ${inventoryTable(inventory, loading && !inventory, inventoryFailed)}
      </section>
      <section class="capabilities-section" aria-labelledby="capabilities-cache-heading">
        <h3 id="capabilities-cache-heading">${t('Cache alignment')}</h3>
        ${cacheTable(cache, loading && !cache, cacheFailed)}
        <p class="capabilities-note">${preview ? t('Browser preview values are samples.') : t('Counts are observed from local usage records.')} ${t('No prompt text or cache key is shown.')}</p>
      </section>
    </div>`;
  };
  const refresh = async () => {
    if (disposed || loading && (inventory || cache)) return;
    loading = true;
    inventoryFailed = false;
    cacheFailed = false;
    const current = ++request;
    draw();
    const results = await Promise.allSettled([
      call<CapabilityInventory>('capabilities_inventory', args),
      call<CacheAlignment>('cache_alignment', args),
    ]);
    if (disposed || current !== request) return;
    if (results[0].status === 'fulfilled') inventory = results[0].value;
    else inventoryFailed = true;
    if (results[1].status === 'fulfilled') cache = results[1].value;
    else cacheFailed = true;
    loading = false;
    draw();
  };
  const onClick = (event: MouseEvent) => {
    if ((event.target as Element | null)?.closest('.capabilities-refresh')) void refresh();
  };
  host.addEventListener('click', onClick);
  draw();
  void refresh();
  return () => {
    disposed = true;
    request++;
    host.removeEventListener('click', onClick);
  };
}

