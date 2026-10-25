import './file-mentions.css';
import { t } from './i18n.ts';
import { fileIcon, icon } from './dom';
import { hidePopover, showPopover } from './popover-motion';
import type { FileEntry } from './types';

/** A row in the picker: a project file, or another reference with its own insertion text. */
export type MentionEntry = FileEntry & { mention?: string; detail?: string; icon?: string };
type Options = {
  contextKey(): string;
  search(query: string): Promise<MentionEntry[]>;
  select?(file: MentionEntry): void;
};
type Token = { start: number; end: number; query: string };
let pickerId = 0;

/** Plain references survive draft edits and work across harnesses without loading file contents. */
export function fileMention(path: string): string {
  return '@' + (/^[\p{L}\p{N}_./-]+$/u.test(path) ? path : JSON.stringify(path));
}

function mentionToken(textarea: HTMLTextAreaElement): Token | undefined {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) return;
  const before = textarea.value.slice(0, caret);
  // An email address or package@version is ordinary text, not a file mention. macOS smart quotes
  // can curl the quotes around a finished `@"path with spaces"`, so curly quotes delimit it too.
  const match = /(?:^|[\s([{])(@(?:["\u201C](?:[^"\u201C\u201D\\\r\n]|\\.)*|[^\s"\u201C\u201D@()[\]{},;]*))$/.exec(before);
  if (!match) return;
  const raw = match[1], start = caret - raw.length;
  let end = caret, query = raw.slice(1);
  if (/^@["\u201C]/.test(raw)) {
    query = raw.slice(2);
    try { query = JSON.parse('"' + query + '"'); } catch { /* A partially typed escape is still searchable. */ }
    let escaped = false;
    while (end < textarea.value.length && !/[\r\n]/.test(textarea.value[end])) {
      const next = textarea.value[end++];
      if (!escaped && (next === '"' || next === '\u201D')) break;
      escaped = !escaped && next === '\\';
    }
  } else {
    end += /^[^\s"\u201C\u201D@()[\]{},;]*/.exec(textarea.value.slice(caret))![0].length;
  }
  return query.length <= 256 ? { start, end, query } : undefined;
}

export function mountFileMentions(textarea: HTMLTextAreaElement, options: Options): { refresh(): void; dispose(): void } {
  const panel = document.createElement('section');
  panel.className = 'file-mention-menu floating-menu';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t('Mention a file'));
  panel.innerHTML = `<header>${icon('file')}<strong>${t('Project files')}</strong><span>@</span></header><div class="file-mention-list" id="file-mentions-${++pickerId}" role="listbox" aria-label="${t('Project files')}"></div><p class="file-mention-status" role="status" aria-live="polite"></p><footer><span>${t('↑ ↓ navigate')}</span><span>${t('Tab or ↵ mention')}</span></footer>`;
  const list = panel.querySelector<HTMLElement>('.file-mention-list')!;
  const status = panel.querySelector<HTMLElement>('.file-mention-status')!;
  const original = new Map(['role', 'aria-autocomplete', 'aria-haspopup', 'aria-controls', 'aria-expanded', 'aria-activedescendant'].map(name => [name, textarea.getAttribute(name)]));
  const listeners = new AbortController(), signal = listeners.signal;
  const rows = new Map<string, HTMLButtonElement>();
  // Only a handful of queries from the current composer are retained; native discovery
  // caches the bounded file index so keystrokes do not repeatedly walk the checkout.
  const cache = new Map<string, { files: MentionEntry[]; at: number }>();
  let context = '', query: string | undefined, files: MentionEntry[] = [], active = '';
  let opened = false, disposed = false, composing = false, loading = false, dismissed = '';
  let generation = 0, searchTimer = 0, positionFrame = 0, rowId = 0, error = '';

  function token(): Token | undefined {
    if (composing || textarea.disabled || textarea.readOnly || document.activeElement !== textarea || !textarea.getClientRects().length) return;
    return mentionToken(textarea);
  }
  function invalidate(): void { generation++; clearTimeout(searchTimer); searchTimer = 0; loading = false; query = undefined; }
  function close(suppress = false): void {
    if (suppress) dismissed = textarea.value;
    invalidate();
    if (!opened) return;
    opened = false; cancelAnimationFrame(positionFrame); positionFrame = 0;
    // A slash-command picker may have claimed this same textarea in this event.
    if (textarea.getAttribute('aria-controls') === list.id) {
      for (const [name, value] of original) {
        if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value);
      }
    }
    hidePopover(panel);
  }
  function position(): void {
    positionFrame = 0;
    if (!opened) return;
    if (!textarea.isConnected || !textarea.getClientRects().length) { close(); return; }
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 12, top = (viewport?.offsetTop ?? 0) + 12;
    const width = Math.max(0, (viewport?.width ?? innerWidth) - 24), height = Math.max(0, (viewport?.height ?? innerHeight) - 24);
    const anchor = textarea.closest('.composer, .launcher-compose') ?? textarea;
    const rect = anchor.getBoundingClientRect(), above = rect.top - top - 8, below = top + height - rect.bottom - 8;
    const placement = above >= Math.min(240, height / 2) || above >= below ? 'above' : 'below';
    const room = placement === 'above' ? above : below;
    panel.style.width = `${Math.min(400, width)}px`;
    panel.style.maxHeight = `${Math.min(380, Math.max(120, room), height)}px`;
    panel.style.left = `${Math.max(left, Math.min(rect.left, left + width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(top, Math.min(placement === 'above' ? rect.top - panel.offsetHeight - 8 : rect.bottom + 8, top + height - panel.offsetHeight))}px`;
    panel.dataset.placement = placement;
  }
  function schedulePosition(event?: Event): void {
    if (event?.target instanceof Node && panel.contains(event.target)) return;
    if (opened && !positionFrame) positionFrame = requestAnimationFrame(position);
  }
  function setActive(path: string, scroll = false): void {
    active = path;
    for (const [key, row] of rows) row.setAttribute('aria-selected', String(key === path));
    const row = rows.get(path);
    if (row && !loading) {
      textarea.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else textarea.removeAttribute('aria-activedescendant');
  }
  function render(): void {
    if (!opened) return;
    const visible = new Set(files.map(file => file.path));
    for (const [path, row] of rows) if (!visible.has(path)) { row.remove(); rows.delete(path); }
    for (const [index, file] of files.entries()) {
      let row = rows.get(file.path);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1;
        row.className = 'file-mention-option'; row.dataset.filePath = file.path;
        row.setAttribute('role', 'option'); row.id = `${list.id}-option-${++rowId}`; row.title = file.path;
        const copy = document.createElement('span'), name = document.createElement('strong'), directory = document.createElement('small');
        name.textContent = file.isDir ? file.name + '/' : file.name; directory.textContent = file.detail ?? (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : t('Project root'));
        copy.append(name, directory); row.innerHTML = file.icon ? icon(file.icon) : fileIcon(file.name, file.isDir); row.append(copy); rows.set(file.path, row);
        if (file.mention) row.classList.add('file-mention-reference');
        if (file.isDir) row.classList.add('file-mention-folder');
      }
      row.disabled = loading;
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    }
    setActive(visible.has(active) ? active : files[0]?.path ?? '');
    list.setAttribute('aria-busy', String(loading));
    const references = files.filter(file => file.mention).length, folders = files.filter(file => file.isDir && !file.mention).length, plain = files.length - references - folders;
    panel.querySelector('header strong')!.textContent = references ? t('Files and GitHub') : t('Project files');
    status.textContent = loading ? t('Searching…') : error || (!files.length ? t('No matching files in this project.') : [plain ? plain === 40 ? t`Top ${plain} files` : plain === 1 ? t`${plain} file` : t`${plain} files` : '', folders ? folders === 1 ? t`${folders} folder` : t`${folders} folders` : '', references ? t`${references} on GitHub` : ''].filter(Boolean).join(' · '));
    position();
  }
  async function search(value: string, ticket: number, key: string): Promise<void> {
    searchTimer = 0;
    try {
      const result = await options.search(value);
      if (disposed || !opened || ticket !== generation || key !== options.contextKey()) return;
      const seen = new Set<string>();
      // Folders are offered as `@path/` so an agent can be pointed at an area of the checkout.
      files = result.filter(file => {
        if (!file.path || seen.has(file.path)) return false;
        seen.add(file.path); return true;
      }).slice(0, 50);
      cache.delete(value); cache.set(value, { files, at: Date.now() });
      if (cache.size > 12) cache.delete(cache.keys().next().value!);
    } catch (cause) {
      if (disposed || ticket !== generation || key !== options.contextKey()) return;
      files = []; error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!disposed && ticket === generation && key === options.contextKey()) { loading = false; render(); }
    }
  }
  function refresh(): void {
    if (disposed) return;
    const key = options.contextKey();
    if (key !== context) { close(); context = key; cache.clear(); files = []; active = ''; error = ''; dismissed = ''; }
    const current = key ? token() : undefined;
    if (!current || dismissed === textarea.value) { close(); return; }
    const entering = !opened;
    if (entering) {
      opened = true;
      textarea.setAttribute('role', 'combobox'); textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-haspopup', 'listbox');
      textarea.setAttribute('aria-expanded', 'true'); textarea.setAttribute('aria-controls', list.id);
      (textarea.closest('dialog[open]') ?? document.body).append(panel);
    }
    if (query !== current.query) {
      invalidate(); query = current.query; error = '';
      const cached = cache.get(query);
      if (cached && Date.now() - cached.at < 5000) files = cached.files;
      else {
        loading = true;
        const ticket = generation, value = query;
        searchTimer = window.setTimeout(() => void search(value, ticket, key), 110);
      }
    }
    render();
    if (entering) showPopover(panel, textarea);
  }
  function choose(path: string): void {
    const current = token(), file = files.find(item => item.path === path);
    if (!current || !file || loading || context !== options.contextKey()) return;
    const reference = file.mention ?? fileMention(file.isDir ? file.path.replace(/\/?$/, '/') : file.path);
    const suffix = textarea.value.slice(current.end);
    const insertion = reference + (/^\s/.test(suffix) ? '' : ' ');
    if (textarea.maxLength >= 0 && textarea.value.length - (current.end - current.start) + insertion.length > textarea.maxLength) {
      status.textContent = t('There is not enough room for this reference. Shorten your message first.'); return;
    }
    textarea.setRangeText(insertion, current.start, current.end, 'end');
    if (/^\s/.test(suffix)) textarea.setSelectionRange(current.start + reference.length + 1, current.start + reference.length + 1);
    close(); textarea.dispatchEvent(new Event('input', { bubbles: true }));
    options.select?.(file);
  }
  function keydown(event: KeyboardEvent): void {
    if (!opened || composing || event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!loading && files.length) {
        const index = files.findIndex(file => file.path === active);
        setActive(files[(index + (event.key === 'ArrowDown' ? 1 : -1) + files.length) % files.length].path, true);
      }
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.key === 'Tab' && !files.length && !loading) { close(true); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (!loading && active) choose(active);
    }
  }
  const input = () => { dismissed = ''; refresh(); };
  textarea.addEventListener('input', input, { signal }); textarea.addEventListener('focus', input, { signal });
  textarea.addEventListener('keydown', keydown, { signal, capture: true });
  for (const name of ['click', 'keyup']) textarea.addEventListener(name, refresh, { signal });
  textarea.addEventListener('blur', () => close(), { signal });
  textarea.addEventListener('compositionstart', () => { composing = true; close(); }, { signal });
  textarea.addEventListener('compositionend', () => { composing = false; input(); }, { signal });
  document.addEventListener('selectionchange', refresh, { signal });
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && event.target !== textarea && !panel.contains(event.target)) close(true);
  }, { signal, capture: true });
  panel.addEventListener('pointerdown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); }, { signal });
  panel.addEventListener('click', event => {
    const path = (event.target as Element).closest<HTMLElement>('[data-file-path]')?.dataset.filePath;
    if (path) choose(path);
  }, { signal });
  window.addEventListener('resize', schedulePosition, { signal }); window.addEventListener('scroll', schedulePosition, { signal, capture: true });
  window.visualViewport?.addEventListener('resize', schedulePosition, { signal }); window.visualViewport?.addEventListener('scroll', schedulePosition, { signal });
  const resize = new ResizeObserver(() => schedulePosition()); resize.observe(textarea);
  refresh();
  return { refresh, dispose() {
    if (disposed) return;
    close(); disposed = true; listeners.abort(); resize.disconnect(); cache.clear(); rows.clear(); files = [];
  } };
}
