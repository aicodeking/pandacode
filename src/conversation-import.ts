import { t } from './i18n.ts';
import './conversation-import.css';
import { escape, icon } from './dom';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import type { ProviderId, Session } from './types';

export type ImportSource = 'claude' | 'codex' | 'zcode';
export interface Importable {
  id: string;
  title: string;
  folder: string;
  updatedAt: number;
  messages: number | null;
  model: string | null;
  importedTaskId: string | null;
  unavailable: string | null;
}
export interface ImportPage { items: Importable[]; cursor: string | null; note: string | null; }
export interface ImportResult { imported: Session[]; existing: string[]; failed: { id: string; message: string }[]; }
export interface ImportOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Harnesses installed here; a source that is not installed stays listed but explains why. */
  installed: ProviderId[];
  defaultModel(provider: ImportSource): string;
  onImported(result: ImportResult): void;
  openTask(id: string): void;
}

const SOURCES: { id: ImportSource; label: string }[] = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'zcode', label: 'ZCode' }];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const MAX_SELECTION = 50;

function age(at: number, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.round((at - now) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return relative.format(Math.round(minutes / 60), 'hour');
  if (Math.abs(minutes) < 43200) return relative.format(Math.round(minutes / 1440), 'day');
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function folderName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }

/** The Import conversations window: pick a source, search, check conversations, import. */
export function mountConversationImport(host: HTMLElement, options: ImportOptions): () => void {
  let source: ImportSource = SOURCES.find(item => options.installed.includes(item.id))?.id ?? 'claude';
  let items: Importable[] = [], cursor: string | null = null, note: string | null = null;
  let loading = false, importing = false, disposed = false, request = 0, searchTimer = 0;
  const selected = new Set<string>();
  host.classList.add('conversation-import');
  host.innerHTML = `<p class="dialog-description">${t('Bring conversations you started in Claude Code or Codex into PandaCode. Each continues its own session, in the project for its folder.')}</p>
    <div class="import-controls"><div class="import-sources" role="group" aria-label="${t('Import from')}">${SOURCES.map(item => `<button type="button" data-source="${item.id}" aria-pressed="${item.id === source}">${providerLogo(item.id)}<span>${item.label}</span></button>`).join('')}</div>
      <label class="import-search">${icon('search')}<input type="search" placeholder="${t('Search conversations')}" aria-label="${t('Search conversations')}" autocomplete="off"></label></div>
    <div class="import-bar"><label class="import-all"><input type="checkbox" aria-label="${t('Select all shown conversations')}"><span>${t('Select all')}</span></label><span class="import-count" role="status"></span></div>
    <div class="import-list" role="group" aria-label="${t('Conversations')}"></div>
