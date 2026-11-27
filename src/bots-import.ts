import { escape, isImeKey } from './dom';
import { errorText } from './error-text';

type Action = 'created' | 'updated' | 'unchanged' | 'failed';
interface BotChange { kind: string; name: string; status: Action; }
interface BotDiff { name: string; status: Action; changes: BotChange[]; error?: string; }
interface WebLink { channelId: string; url: string; }
interface ImportReport {
  lines: string[];
  addedChannels: { id: string; bot: string; kind: string; label: string }[];
  failed: number;
  bots: BotDiff[];
  links: WebLink[];
}
interface BundleOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  changed(): Promise<void>;
  close(): void;
}

function parseBundle(text: string): string {
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('This file is not valid JSON. Choose a bots.json bundle.'); }
  if (!doc || typeof doc !== 'object' || !('bots' in doc) || !Array.isArray((doc as { bots: unknown }).bots)) {
    throw new Error('This bundle must contain a bots list.');
  }
  return text;
}

function reportHtml(report: ImportReport, applied: boolean): string {
  const labels: Record<Action, string> = applied
    ? { created: 'Created', updated: 'Updated', unchanged: 'Unchanged', failed: 'Failed' }
    : { created: 'Create', updated: 'Update', unchanged: 'Unchanged', failed: 'Fail' };
  const failures = report.bots.filter(bot => bot.status === 'failed' && bot.error);
  const failed = failures.length ? `<div class="bots-error" role="alert"><strong>${failures.length} bot${failures.length === 1 ? '' : 's'} could not ${applied ? 'import' : 'be imported'}</strong><ul>${failures.map(bot => `<li><strong>${escape(bot.name)}</strong>: ${escape(bot.error!)}</li>`).join('')}</ul></div>` : '';
  const changes = (bot: BotDiff) => bot.changes.length
    ? `<ul>${bot.changes.map(change => `<li>${escape(change.kind)} · ${escape(change.name)} · ${labels[change.status]}</li>`).join('')}</ul>`
    : '';
  return `${failed}<ul aria-label="${applied ? 'Import results' : 'Bundle preview'}">${report.bots.map(bot => `<li><strong>${escape(bot.name)}</strong> · ${labels[bot.status]}${changes(bot)}</li>`).join('')}</ul>${!report.bots.length && !failed.length ? '<p>No bots in this bundle.</p>' : ''}`;
}

export async function exportBots(call: BundleOptions['call']): Promise<void> {
  const doc = await call<unknown>('bots_export', {});
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'bots.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountBotsImport(host: HTMLElement, options: BundleOptions): () => void {
  let doc: string | null = null, report: ImportReport | null = null;
  let source = '', error = '', busy = false, applied = false, disposed = false;
  let links: WebLink[] = [];
  const abort = new AbortController();

  function render(): void {
    if (disposed) return;
    host.innerHTML = `<div class="bots-form"><h3>${applied ? 'Import results' : 'Import bots'}</h3>
      <p>Choose a JSON bundle or paste a direct URL. Review the changes before importing.</p>
      ${error ? `<div class="bots-error" role="alert">${escape(error)}</div>` : ''}
      ${busy ? '<p role="status">Working…</p>' : ''}
      ${report ? `<section aria-label="Review bundle"><p>${escape(source)}</p>${reportHtml(report, applied)}</section>` : ''}
      ${links.length ? `<div><p>Web chat links</p><ul>${links.map(link => `<li><label class="bots-field">${escape(link.channelId)}<input readonly aria-label="Web chat link" value="${escape(link.url)}"></label></li>`).join('')}</ul></div>` : ''}
      ${!applied ? `<div><button type="button" class="secondary-button" data-bundle="file" ${busy ? 'disabled' : ''}>Choose file…</button><input type="file" hidden accept=".json,application/json" data-bundle-file></div>
      <p class="bots-hint">A bundle URL can be fetched by an agent with shell access, but this window cannot open one: paste it into a terminal with <code>pandacode serve --import-bots &lt;(curl -s URL)</code>, or download the JSON and choose it above.</p>` : ''}
      ${report && !applied ? '<p>Import applies the changes listed above. Bots with failures may be skipped; other bots can still import.</p>' : ''}
      <div class="dialog-footer"><button type="button" class="secondary-button" data-bundle="close" ${busy ? 'disabled' : ''}>${applied ? 'Done' : 'Cancel'}</button><button type="button" class="secondary-button" data-bundle="export" ${busy ? 'disabled' : ''}>Export bots</button>
      ${report && !applied ? `<button type="button" class="primary-button" data-bundle="apply" ${busy || !report.bots.some(bot => bot.status !== 'unchanged') ? 'disabled' : ''}>Import${report.failed ? ' the other bots' : ' bots'}</button>` : ''}</div></div>`;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    busy = true; error = ''; render();
    try { await action(); }
    catch (cause) { error = errorText(cause); }
    finally { busy = false; render(); }
  }

  async function preview(text: string, name: string): Promise<void> {
    const bundle = parseBundle(text);
    const next = await options.call<ImportReport>('bots_import_preview', { doc: bundle });
    if (disposed) return;
    doc = bundle; report = next; source = name;
  }

  const click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-bundle]') : null;
    if (!button || busy || button.disabled) return;
    event.stopPropagation();
    if (button.dataset.bundle === 'close') options.close();
    else if (button.dataset.bundle === 'file') host.querySelector<HTMLInputElement>('[data-bundle-file]')?.click();
    else if (button.dataset.bundle === 'export') void run(() => exportBots(options.call));
    else if (button.dataset.bundle === 'apply' && doc && report && !applied) {
      const reviewed = doc;
      void run(async () => {
        const result = await options.call<ImportReport>('bots_import', { doc: reviewed });
        if (disposed) return;
        applied = true; report = result; links = result.links;
        await options.changed();
      });
    }
  };
  const change = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-bundle-file]') || busy) return;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    doc = null; report = null;
    void run(async () => { await preview(await file.text(), file.name); });
  };
  const submit = (event: SubmitEvent) => {
    if (event.target instanceof HTMLFormElement) { event.preventDefault(); event.stopPropagation(); }
  };
  const keys = (event: KeyboardEvent) => {
    if (isImeKey(event) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); }
  };
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  host.addEventListener('submit', submit);
  host.addEventListener('keydown', keys);
  render();
  host.querySelector<HTMLElement>('[data-bundle=file]')?.focus();
  return () => {
    disposed = true; abort.abort();
    host.removeEventListener('click', click); host.removeEventListener('change', change);
    host.removeEventListener('submit', submit); host.removeEventListener('keydown', keys);
  };
}
