import './slash-commands.css';
import { icon } from './dom';
import { t } from './i18n.ts';
import { providerLogo } from './provider-logos';
import { hidePopover, showPopover } from './popover-motion';
import type { ProviderId } from './types';

export interface SlashCommand { id: string; name: string; description: string; argumentHint?: string; kind: 'prompt' | 'action' | 'unsupported'; source: string; reason?: string; }
type Catalog = { commands: SlashCommand[]; warnings: string[] };
type Options = { contextKey(): string; snapshot?(): Promise<Catalog>; load(force: boolean): Promise<Catalog>; select(command: SlashCommand): void; provider?(): ProviderId };
type Token = { start: number; end: number; query: string };
const cacheLifetime = 30_000;
let nextPickerId = 0;

/** Completion inserts text only. The caller dispatches a command on a later send. */
export function mountSlashCommands(textarea: HTMLTextAreaElement, options: Options): { refresh(force?: boolean): void; dispose(): void } {
  const panel = document.createElement('section');
  panel.className = 'slash-menu floating-menu';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t('Slash commands'));
  panel.innerHTML = `<header class="slash-menu-header"><span class="slash-menu-logo"></span><strong>${t('Commands')}</strong><button type="button" class="icon-button" aria-label="${t('Refresh commands')}" title="${t('Refresh commands')}">${icon('refresh')}</button></header><div class="slash-menu-list" id="slash-commands-${++nextPickerId}" role="listbox" aria-label="${t('Available commands')}"></div><p class="slash-menu-status" role="status" aria-live="polite"></p><p class="slash-menu-warning"></p><footer class="slash-menu-footer"><span>${t('↑ ↓ navigate')}</span><span>${t('Tab or ↵ insert')}</span></footer>`;
  const list = panel.querySelector<HTMLElement>('.slash-menu-list')!;
  const status = panel.querySelector<HTMLElement>('.slash-menu-status')!;
  const warning = panel.querySelector<HTMLElement>('.slash-menu-warning')!;
  const refreshButton = panel.querySelector<HTMLButtonElement>('button')!;
  const attributes = new Map(['role', 'aria-autocomplete', 'aria-haspopup', 'aria-controls', 'aria-expanded', 'aria-activedescendant'].map(name => [name, textarea.getAttribute(name)]));
  const rows = new Map<string, HTMLButtonElement>();
  let commands: SlashCommand[] = [], warnings: string[] = [], visibleCommands: SlashCommand[] = [];
  let context = options.contextKey(), loadedAt = 0, loading = false, slow = false, loadError = '';
  let active = '', opened = false, disposed = false, composing = false, dismissed = '', generation = 0, positionFrame = 0;

  function token(): Token | undefined {
    if (textarea.disabled || textarea.readOnly || composing || document.activeElement !== textarea) return;
    const match = /^(\s*)(\/[^\s]*)/.exec(textarea.value);
    if (!match) return;
    const start = match[1].length, end = start + match[2].length;
    if (textarea.selectionStart < start + 1 || textarea.selectionEnd > end) return;
    return { start, end, query: match[2].slice(1).toLocaleLowerCase() };
  }
  function restoreAttributes(): void {
    for (const [name, value] of attributes) {
      if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value);
    }
  }
  function close(suppress = false): void {
    if (suppress) dismissed = textarea.value;
    if (!opened) return;
    opened = false; cancelAnimationFrame(positionFrame); positionFrame = 0;
    restoreAttributes(); hidePopover(panel);
  }
  function position(): void {
    positionFrame = 0;
    if (!opened || disposed) return;
    if (!textarea.isConnected) { close(); return; }
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12, topEdge = (viewport?.offsetTop ?? 0) + 12;
    const width = Math.max(0, (viewport?.width ?? innerWidth) - 24), height = Math.max(0, (viewport?.height ?? innerHeight) - 24);
    const composer = textarea.closest('.composer') ?? textarea;
    const rect = composer.getBoundingClientRect();
    const above = rect.top - topEdge - 8;
    panel.style.width = `${Math.min(420, width)}px`;
    panel.style.maxHeight = `${Math.min(420, above >= 140 ? above : height)}px`;
    panel.style.left = `${Math.max(leftEdge, Math.min(rect.left, leftEdge + width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(rect.top - panel.offsetHeight - 8, topEdge + height - panel.offsetHeight))}px`;
    panel.dataset.placement = 'above';
  }
  function schedulePosition(event?: Event): void {
    if (event?.target instanceof Node && panel.contains(event.target)) return;
    if (opened && !positionFrame) positionFrame = requestAnimationFrame(position);
  }
  function setActive(id: string, scroll = false): void {
    active = id;
    for (const [key, row] of rows) row.setAttribute('aria-selected', String(key === id && !row.hidden));
    const row = rows.get(id);
    if (row && !row.hidden) {
      textarea.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else textarea.removeAttribute('aria-activedescendant');
  }
  function render(): void {
    if (!opened) return;
    const query = token()?.query ?? '';
    const matches = commands.filter(command => command.name.slice(1).toLocaleLowerCase().startsWith(query));
    visibleCommands = matches.slice(0, 80);
    const visible = new Set(visibleCommands.map(command => command.id));
    for (const [id, row] of rows) row.hidden = !visible.has(id);
    let previous: HTMLElement | null = null;
    for (const command of visibleCommands) {
      let row = rows.get(command.id);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1; row.className = 'slash-menu-option';
        row.id = `${list.id}-option-${rows.size}`; row.dataset.commandId = command.id; row.setAttribute('role', 'option');
        const copy = document.createElement('span'); copy.className = 'slash-menu-copy';
        const title = document.createElement('span'); title.className = 'slash-menu-title';
        const name = document.createElement('strong'); name.textContent = command.name;
        title.append(name);
        if (command.argumentHint) { const hint = document.createElement('span'); hint.textContent = command.argumentHint; title.append(hint); }
        // Descriptions come from Rust (ours) or the harness (data): t() passes unknown ones through.
        const description = document.createElement('small'); description.textContent = command.kind === 'unsupported' ? command.reason || t('This command is not available in the app yet.') : t(command.description);
        copy.append(title, description);
        const source = document.createElement('span'); source.className = 'slash-menu-source'; source.textContent = command.source; source.title = command.source;
        row.append(copy, source); row.disabled = command.kind === 'unsupported'; row.setAttribute('aria-disabled', String(row.disabled));
        rows.set(command.id, row);
      }
      row.hidden = false;
      const next: ChildNode | null = previous ? previous.nextSibling : list.firstChild;
      if (next !== row) list.insertBefore(row, next);
      previous = row;
    }
    const enabled = visibleCommands.filter(command => command.kind !== 'unsupported');
    setActive(enabled.some(command => command.id === active) ? active : enabled[0]?.id ?? '');
    refreshButton.disabled = loading;
    refreshButton.setAttribute('aria-label', loadError ? t('Retry commands') : t('Refresh commands'));
    refreshButton.title = loadError ? t('Retry commands') : t('Refresh commands');
    list.setAttribute('aria-busy', String(loading && !commands.length));
    const count = `${visibleCommands.length}${matches.length > visibleCommands.length ? t` of ${matches.length}` : ''}`;
    status.textContent = loading ? `${slow ? t('Waiting for the harness to start…') : t('Loading commands…')}${commands.length ? t(' Available commands can be used now.') : ''}` : loadError || (!matches.length ? query ? t`Unknown command /${query}. Refresh commands or edit the name.` : t('No commands are available for this agent.') : matches.length === 1 ? t`${count} command` : t`${count} commands`);
    warning.hidden = !warnings.length;
    warning.textContent = warnings.slice(0, 3).join('\n');
    position();
  }
  async function load(force = false): Promise<void> {
    if (disposed || loading || !force && loadedAt && Date.now() - loadedAt < cacheLifetime) return;
    const ticket = ++generation, key = context;
    loading = true; slow = false; loadError = ''; render();
    const current = (): boolean => !disposed && ticket === generation && key === options.contextKey();
    const accept = (result: Catalog): void => {
      const seen = new Set<string>();
      commands = result.commands.filter(command => {
        if (!command.id || seen.has(command.id) || !/^\/[^\s/]+$/.test(command.name)) return false;
        seen.add(command.id); return true;
      }).slice(0, 1000);
      warnings = result.warnings;
      rows.clear(); list.replaceChildren();
    };
    const slowTimer = window.setTimeout(() => { if (current()) { slow = true; render(); } }, 4_000);
    let timeoutTimer = 0;
    try {
      const discovery = async (): Promise<Catalog> => {
        if (!loadedAt && options.snapshot) {
          try {
            const snapshot = await options.snapshot();
            if (current() && loading) { accept(snapshot); render(); }
          } catch { /* Discovery can still succeed if the snapshot is unavailable. */ }
        }
        if (!current() || !loading) return { commands: [], warnings: [] };
        return options.load(force);
      };
      const result = await Promise.race([discovery(), new Promise<never>((_, reject) => {
        timeoutTimer = window.setTimeout(() => reject(new Error(t('Command discovery took too long. Retry to load harness commands.'))), 75_000);
      })]);
      if (!current()) return;
      accept(result); loadedAt = Date.now();
    } catch (error) {
      if (!current()) return;
      loadError = error instanceof Error ? error.message : String(error);
      loadedAt = Date.now();
    } finally {
      window.clearTimeout(slowTimer); window.clearTimeout(timeoutTimer);
      if (current()) { loading = false; render(); }
    }
  }
  function refresh(force = false): void {
    if (disposed) return;
    if (force) { generation++; loadedAt = 0; loading = false; }
    const key = options.contextKey();
    if (key !== context) {
      context = key; generation++; loadedAt = 0; loading = false; loadError = ''; active = '';
      commands = []; warnings = []; rows.clear(); list.replaceChildren(); dismissed = '';
      panel.querySelector('.slash-menu-logo')!.innerHTML = options.provider ? providerLogo(options.provider()) : icon('command');
    }
    const current = token();
    if (!current || dismissed === textarea.value) { close(); return; }
    if (!opened) {
      opened = true;
      textarea.setAttribute('role', 'combobox'); textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-haspopup', 'listbox');
      textarea.setAttribute('aria-expanded', 'true'); textarea.setAttribute('aria-controls', list.id);
      panel.querySelector('.slash-menu-logo')!.innerHTML = options.provider ? providerLogo(options.provider()) : icon('command');
      (textarea.closest('dialog[open]') ?? document.body).append(panel);
      render(); showPopover(panel, textarea);
    } else render();
    // Runtime changes already refreshed the harness metadata. Only the explicit
    // refresh button asks discovery to start a new provider process.
    void load();
  }
  function choose(command: SlashCommand): void {
    const current = token();
    if (!current || command.kind === 'unsupported' || options.contextKey() !== context) return;
    const rest = textarea.value.slice(current.end).replace(/^\s+/, '');
    const prefix = textarea.value.slice(0, current.start) + command.name + ' ';
    textarea.value = prefix + rest;
    textarea.setSelectionRange(prefix.length, prefix.length);
    close(); textarea.dispatchEvent(new Event('input', { bubbles: true }));
    options.select(command);
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing || composing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const enabled = visibleCommands.filter(command => command.kind !== 'unsupported');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const current = enabled.findIndex(command => command.id === active);
      if (enabled.length) setActive(enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length].id, true);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.key === 'Tab' && !enabled.length) { close(true); return; }
      event.preventDefault(); event.stopPropagation();
      const selected = enabled.find(command => command.id === active);
      if (selected) choose(selected);
      else if (!loading) status.textContent = visibleCommands[0]?.reason || t('Choose an available command or edit the name before sending.');
    }
  }
  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && event.target !== textarea && !panel.contains(event.target)) close(true);
  }
  function blur(event: FocusEvent): void { if (!(event.relatedTarget instanceof Node && panel.contains(event.relatedTarget))) close(); }
  function input(): void { dismissed = ''; refresh(); }
  function focus(): void { dismissed = ''; refresh(); }
  function compositionStart(): void { composing = true; close(); }
  function compositionEnd(): void { composing = false; input(); }
  function refreshEvent(): void { refresh(); }
  function click(event: MouseEvent): void {
    const target = (event.target as Element).closest<HTMLElement>('[data-command-id]');
    const command = commands.find(command => command.id === target?.dataset.commandId);
    if (command) choose(command);
  }
  panel.addEventListener('pointerdown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); });
  panel.addEventListener('click', click);
  refreshButton.addEventListener('click', () => { void load(true); });
  textarea.addEventListener('input', input); textarea.addEventListener('focus', focus); textarea.addEventListener('blur', blur);
  textarea.addEventListener('keydown', keydown); textarea.addEventListener('click', refreshEvent); textarea.addEventListener('keyup', refreshEvent);
  textarea.addEventListener('compositionstart', compositionStart); textarea.addEventListener('compositionend', compositionEnd);
  document.addEventListener('selectionchange', refreshEvent); document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', schedulePosition); window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition); window.visualViewport?.addEventListener('scroll', schedulePosition);
  const resize = new ResizeObserver(() => schedulePosition()); resize.observe(textarea.closest('.composer') ?? textarea);
  refresh();
  return { refresh, dispose() {
    if (disposed) return;
    disposed = true; generation++; close(); resize.disconnect();
    textarea.removeEventListener('input', input); textarea.removeEventListener('focus', focus); textarea.removeEventListener('blur', blur);
    textarea.removeEventListener('keydown', keydown); textarea.removeEventListener('click', refreshEvent); textarea.removeEventListener('keyup', refreshEvent);
    textarea.removeEventListener('compositionstart', compositionStart); textarea.removeEventListener('compositionend', compositionEnd);
    document.removeEventListener('selectionchange', refreshEvent); document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', schedulePosition); window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition); window.visualViewport?.removeEventListener('scroll', schedulePosition);
    rows.clear(); commands = []; warnings = [];
  } };
}
