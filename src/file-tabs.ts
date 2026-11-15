import './file-tabs.css';
import { renderDocument } from './document-viewer';
import { escape, fileIcon, icon, isImeKey } from './dom';
import { createFileWindow } from './file-window';
import { isPreviewableFile } from './file-links';
import type { OfficeKind } from './office-viewer';
import { errorText } from './error-text';
import type { CodeSelection, SelectedCode } from './diff-viewer';

type Context = { projectId: string; sessionId?: string };
/** `source` shows a viewer-handled file (e.g. an SVG) as text. */
type Tab = { path: string; context: Context; content?: string | ArrayBuffer; reads?: number; source?: boolean; used?: number; draft?: string; editing?: boolean; saving?: boolean; stamp?: string; error?: string; editorKey?: string };
/** Document bytes kept for tabs not on screen, across all tasks; evicted tabs read their file again when shown. */
const DOCUMENT_CACHE_BYTES = 64 * 1024 * 1024;
/** PDF, Word, spreadsheet and image files arrive as bytes and draw in their own lazily loaded viewer. */
const officeKind = (path: string): OfficeKind | undefined =>
  /\.pdf$/i.test(path) ? 'pdf' : /\.docx$/i.test(path) ? 'docx' : /\.(?:xlsx|xlsm|xls|ods)$/i.test(path) ? 'sheet' : /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path) ? 'image' : undefined;
const sameContent = (a: Tab['content'], b: Tab['content']): boolean => {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
type Thread = { workspace: string; tabs: Tab[]; active: string; visible: boolean };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** Attaching only applies to the task shown, so the host decides. */
  canAttach(context: Context): boolean;
  attach(path: string): void;
  preview(path: string, context: Context): Promise<void>;
  notify(text: string): void;
  report(error: unknown): void;
  selection(request: CodeSelection & { context: Context; path: string; unsaved: boolean }): Promise<void>;
  /** Where focus goes when the last file tab closes from the keyboard. */
  focusConversation(): void;
  changed(): void;
};

export function createFileTabs(deps: Deps) {
  const pane = document.querySelector<HTMLElement>('#file-panel')!;
  const strip = pane.querySelector<HTMLElement>('#file-tabs')!;
  const view = pane.querySelector<HTMLElement>('#file-view')!;
  document.querySelector('.workspace')!.append(pane);
  const threads = new Map<string, Thread>();
  let key = '', workspace = '';
  let disposeOffice = () => {};
  let tick = 0, selectionBusy = false;
  let selectedCode: SelectedCode | undefined, questionCode: SelectedCode | undefined;
  const floating = createFileWindow(pane, () => { const entry = thread(); if (entry) entry.visible = false; render(); }, deps.focusConversation);

  const thread = (): Thread | undefined => threads.get(key);
  const current = (): Tab | undefined => thread()?.tabs.find(tab => tab.path === thread()!.active);
  const name = (path: string) => path.split('/').pop() ?? path;
  const dirty = (tab: Tab) => tab.draft !== undefined && tab.draft !== tab.content;
  const matches = (tab: Tab, context: Context, path: string) => tab.context.projectId === context.projectId && tab.context.sessionId === context.sessionId && (tab.path === path || tab.path.startsWith(path + '/'));

  /** Keeps the shown tab's bytes and the most recently shown background documents that fit the cache. */
  function trim(): void {
    const shown = current();
    let budget = DOCUMENT_CACHE_BYTES;
    const cached = [...threads.values()].flatMap(entry => entry.tabs)
      .filter(tab => tab !== shown && typeof tab.content === 'object')
      .sort((a, b) => (b.used ?? 0) - (a.used ?? 0));
    for (const tab of cached) {
      budget -= (tab.content as ArrayBuffer).byteLength;
      if (budget < 0) tab.content = undefined;
    }
  }

  /** Redraws the strip and view; focus that was on the strip, or that the file view just made inert, lands on the selected tab. */
  function render(): void {
    const shown = current(); if (shown) shown.used = ++tick;
    trim();
    const focused = document.activeElement, onStrip = strip.contains(focused), inView = view.contains(focused);
    draw();
    deps.changed();
    if (pane.hidden) return;
    const now = document.activeElement;
    if (inView && (!now || now === document.body)) { pane.focus({ preventScroll: true }); return; }
    if (!onStrip && !(focused && pane.contains(focused) && (!now || now === document.body || now.closest('[inert]')))) return;
    const tab = strip.hidden ? null : strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) tab.focus(); else deps.focusConversation();
  }

  function draw(): void {
    const entry = thread(), active = current();
    selectedCode = questionCode = undefined;
    if (entry?.visible && active) floating.show(); else floating.hide();
    // Re-reading the file on screen keeps the reader's place in it.
    const scroll = active && view.dataset.path === active.path ? view.querySelector('.file-view-body')?.scrollTop ?? 0 : 0;
    view.dataset.path = active?.path ?? '';
    disposeOffice(); disposeOffice = () => {};
    strip.hidden = !entry?.tabs.length;
    view.hidden = !active || !entry?.visible;
    if (!entry?.tabs.length) { strip.innerHTML = ''; view.innerHTML = ''; return; }
    const tabButton = (path: string, label: string, glyph: string) => {
      const selected = entry.active === path;
      return `<div class="file-tab${selected ? ' selected' : ''}" role="presentation" data-tab="${escape(path)}"><button role="tab" aria-selected="${selected}" aria-controls="file-view" tabindex="${selected ? 0 : -1}" data-file-tab="select" title="${escape(path)}">${glyph}<span>${escape(label)}</span></button><button class="icon-button" tabindex="-1" data-file-tab="close" aria-label="Close ${escape(name(path))}" title="Close (Delete)">${icon('close')}</button></div>`;
    };
    strip.innerHTML = entry.tabs.map(tab => tabButton(tab.path, name(tab.path) + (dirty(tab) ? ' ●' : ''), fileIcon(name(tab.path), false))).join('');
    if (!active || !entry.visible) { view.innerHTML = ''; return; }
    const attach = deps.canAttach(active.context) ? `<button data-file-tab="attach">${icon('attach')} Attach</button>` : '';
    const preview = isPreviewableFile(active.path) ? `<button class="icon-button" data-file-tab="preview" aria-label="Preview in browser" title="Preview in browser">${icon('globe')}</button>` : '';
    const editor = typeof active.content === 'string' ? `<button data-file-tab="save"${active.saving || !dirty(active) ? ' disabled' : ''}>${active.saving ? 'Saving…' : 'Save'}</button><button data-file-tab="discard"${active.saving || !dirty(active) ? ' disabled' : ''}>Discard</button><button data-file-tab="${active.editing ? 'reader' : 'edit'}">${active.editing ? 'Preview' : 'Edit'}</button>` : '';
    view.innerHTML = `<div class="file-view-header"><span class="file-view-path" title="${escape(active.path)}">${escape(active.path)}</span><div class="file-preview-actions">${editor}${preview}${typeof active.content === 'object' ? '' : `<button class="icon-button" data-file-tab="copy" aria-label="Copy file" title="Copy file">${icon('copy')}</button>`}${attach}</div></div>${active.editing && typeof active.content === 'string' ? '<div class="file-selection-actions"><span data-selection-lines>Select code to ask or fix</span><button data-file-tab="ask" disabled>Ask model</button><button data-file-tab="fix" disabled>Fix selection</button></div><form class="file-selection-form" aria-label="Ask about selected code" hidden><input aria-label="Question about selected code" placeholder="Ask about this code…" maxlength="2000"><button type="submit">Send question</button><button type="button" data-file-tab="cancel-question">Cancel</button><small role="alert" hidden></small></form>' : ''}<div class="file-view-body"></div>`;
    const body = view.querySelector<HTMLElement>('.file-view-body')!;
    if (active.error) { body.innerHTML = `<div class="inspector-empty" role="alert">${escape(active.error)}<button data-file-tab="external">Open in Default App</button></div>`; return; }
    if (active.editing && typeof active.content === 'string') {
      body.classList.add('file-editor');
      body.innerHTML = '<div class="inspector-empty" role="status">Opening editor…</div>';
      let disposed = false, dispose = () => {};
      disposeOffice = () => { disposed = true; dispose(); };
      active.editorKey ??= crypto.randomUUID();
      void import('./diff-viewer').then(({ mountCodeEditor }) => {
        if (disposed) return;
        return mountCodeEditor(body, active.path, active.draft ?? active.content as string, active.editorKey!, content => { active.draft = content; syncControls(); }, selection => { if (current() === active) { selectedCode = selection; syncSelection(); } });
      }).then(editor => {
        if (!editor) return;
        if (disposed || !body.isConnected) { editor.dispose(); return; }
        dispose = editor.dispose;
        if (document.activeElement === pane) editor.focus();
      }).catch(error => { if (!disposed && body.isConnected) { body.textContent = 'Unable to open the editor. Use Preview to read this file.'; deps.report(error); } });
      return;
    }
    if (active.content === undefined) { body.innerHTML = '<div class="inspector-empty" role="status">Loading file…</div>'; return; }
    if (typeof active.content === 'string') {
      disposeOffice = renderDocument(body, active.path, active.draft ?? active.content, path => deps.call<string>('workspace_image', { ...active.context, path }));
      body.scrollTop = scroll;
      return;
    }
    const bytes = active.content, kind = officeKind(active.path)!;
    let disposed = false;
    disposeOffice = () => { disposed = true; };
    void import('./office-viewer').then(({ renderOffice }) => renderOffice(body, kind, bytes, active.path)).then(dispose => {
      // The tab may have been switched or closed while the viewer was drawing.
      if (disposed || !body.isConnected) { dispose(); return; }
      disposeOffice = dispose; body.scrollTop = scroll;
    }).catch(error => {
      if (!disposed && body.isConnected) body.innerHTML = `<div class="inspector-empty" role="alert">This file could not be opened: ${escape(errorText(error))}</div>`;
    });
  }

  /** Reads the tab's file; a reply for a tab that is no longer shown only fills its cache. */
  async function load(tab: Tab): Promise<void> {
    if (tab.saving || dirty(tab)) return;
    const read = tab.reads = (tab.reads ?? 0) + 1;
    try {
      const stamp = await deps.call<string>('workspace_file_stamp', { ...tab.context, path: tab.path });
      if (read !== tab.reads || dirty(tab)) return;
      tab.stamp = stamp;
      const content = officeKind(tab.path) && !tab.source
        ? await deps.call<ArrayBuffer>('read_document_file', { ...tab.context, path: tab.path })
        : await deps.call<string>('read_file', { ...tab.context, path: tab.path });
      // An older reply arriving after a newer one must not put stale text back.
      if (read !== tab.reads || dirty(tab)) return;
      tab.stamp = stamp; tab.error = undefined;
      if (sameContent(content, tab.content)) return;
      tab.editorKey = crypto.randomUUID();
      if (typeof content === 'string') tab.editing ??= true;
      tab.content = content;
      if (current() === tab) render(); else trim();
    } catch (error) {
      if (read !== tab.reads) return;
      const owner = [...threads.values()].find(entry => entry.tabs.includes(tab));
      if (!owner) return;
      tab.error = errorText(error);
      if (current() === tab) render();
    }
  }

  function activate(path: string): void {
    const entry = thread(); if (!entry) return;
    entry.active = path; render();
    const tab = current(); if (tab) void load(tab);
  }

  function close(path: string, entry = thread()): void {
    if (!entry) return;
    const index = entry.tabs.findIndex(tab => tab.path === path); if (index < 0) return;
    if (dirty(entry.tabs[index]) || entry.tabs[index].saving) { deps.notify('Save or discard edits before closing this file.'); return; }
    entry.tabs = entry.tabs.filter(tab => tab.path !== path);
    if (entry.active === path) entry.active = (entry.tabs[index] ?? entry.tabs[index - 1])?.path ?? '';
    if (entry !== thread()) return;
    render(); const tab = current(); if (tab) void load(tab);
  }

  function syncControls(): void {
    const tab = current(); if (!tab) return;
    const save = view.querySelector<HTMLButtonElement>('[data-file-tab="save"]');
    if (save) { save.disabled = Boolean(tab.saving) || !dirty(tab); save.textContent = tab.saving ? 'Saving…' : 'Save'; }
    const discard = view.querySelector<HTMLButtonElement>('[data-file-tab="discard"]');
    if (discard) discard.disabled = Boolean(tab.saving) || !dirty(tab);
    syncSelection();
    for (const entry of thread()?.tabs ?? []) {
      const label = strip.querySelector<HTMLElement>(`[data-tab="${CSS.escape(entry.path)}"] [role="tab"]>span`);
      if (label) label.textContent = name(entry.path) + (dirty(entry) ? ' ●' : '');
    }
  }

  function syncSelection(): void {
    const ask = view.querySelector<HTMLButtonElement>('[data-file-tab="ask"]'), fix = view.querySelector<HTMLButtonElement>('[data-file-tab="fix"]');
    const tab = current();
    if (ask) ask.disabled = selectionBusy || !selectedCode;
    if (fix) { fix.disabled = selectionBusy || !selectedCode; fix.textContent = tab && dirty(tab) ? 'Save & fix' : 'Fix selection'; }
    const label = view.querySelector<HTMLElement>('[data-selection-lines]');
    if (label) label.textContent = selectedCode ? `Lines ${selectedCode.startLine}–${selectedCode.endLine}` : 'Select code to ask or fix';
  }

  async function requestSelection(action: 'ask' | 'fix', selection: SelectedCode | undefined): Promise<void> {
    const tab = current(), form = view.querySelector<HTMLFormElement>('.file-selection-form');
    if (!tab || !form || !selection || selectionBusy) return;
    const input = form.querySelector<HTMLInputElement>('input')!, alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    selectionBusy = true; syncSelection(); form.querySelectorAll('button').forEach(button => button.disabled = true); alert.hidden = true;
    try {
      if (selection.buffer !== (tab.draft ?? tab.content)) throw new Error('The code changed after selection. Highlight it again.');
      if (action === 'fix' && dirty(tab)) {
        if (!await save(tab)) throw new Error('The file could not be saved. No fix request was sent.');
        if (dirty(tab) || tab.content !== selection.buffer) throw new Error('The file changed while saving. Highlight it again.');
      }
      await deps.selection({ ...selection, action, question: input.value.trim(), context: { ...tab.context }, path: tab.path, unsaved: dirty(tab) });
      form.hidden = true;
      if (action === 'ask' && current() === tab) { const entry = thread(); if (entry) entry.visible = false; render(); deps.focusConversation(); }
    } catch (error) {
      if (form.isConnected) { form.hidden = false; alert.textContent = error instanceof Error ? error.message : String(error); alert.hidden = false; }
      else deps.report(error);
    } finally { selectionBusy = false; form.querySelectorAll('button').forEach(button => button.disabled = false); syncSelection(); }
  }
  view.addEventListener('pointerdown', event => { if (event.button === 0 && (event.target as Element).closest('[data-file-tab="ask"],[data-file-tab="fix"]')) event.preventDefault(); });
  view.addEventListener('submit', event => { if (!(event.target as Element).matches('.file-selection-form')) return; event.preventDefault(); event.stopPropagation(); void requestSelection('ask', questionCode); });
  view.addEventListener('keydown', event => {
    const form = (event.target as Element).closest<HTMLFormElement>('.file-selection-form');
    if (!form) return;
    if (event.key === 'Enter' && isImeKey(event)) { event.preventDefault(); event.stopPropagation(); }
    if (event.key === 'Escape' && !isImeKey(event)) { event.preventDefault(); event.stopPropagation(); form.hidden = true; view.querySelector<HTMLElement>('[data-file-tab="ask"]')?.focus(); }
  });

  async function save(tab: Tab): Promise<boolean> {
    if (tab.saving || typeof tab.content !== 'string') return false;
    if (!dirty(tab)) return true;
    tab.saving = true;
    const content = tab.draft!;
    syncControls();
    try {
      await deps.call('write_workspace_file', { ...tab.context, path: tab.path, content, expected: tab.content });
      tab.content = content; if (tab.draft === content) tab.draft = undefined; tab.stamp = undefined;
      deps.notify('File saved');
      return true;
    } catch (error) { deps.report(error); return false; }
    finally { tab.saving = false; syncControls(); }
  }

  pane.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || isImeKey(event)) return;
    if (event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); const tab = current(); if (tab) void save(tab); }
    if (event.key.toLowerCase() === 'w') { event.preventDefault(); event.stopPropagation(); const tab = current(); if (tab) close(tab.path); }
  });

  strip.addEventListener('click', event => {
    const control = (event.target as Element).closest<HTMLElement>('[data-file-tab]'); if (!control) return;
    const path = control.closest<HTMLElement>('.file-tab')!.dataset.tab!;
    if (control.dataset.fileTab === 'close') close(path); else activate(path);
  });
  // Middle-click closes a file tab, as in editors.
  strip.addEventListener('auxclick', event => {
    const path = (event.target as Element).closest<HTMLElement>('.file-tab')?.dataset.tab;
    if (event.button === 1 && path) { event.preventDefault(); close(path); }
  });
  strip.addEventListener('keydown', event => {
    const entry = thread();
    if (!entry || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key) || !(event.target as Element).matches('[role="tab"]')) return;
    event.preventDefault();
    if (event.key === 'Delete') { if (entry.active) close(entry.active); return; }
    const order = entry.tabs.map(tab => tab.path), index = order.indexOf(entry.active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
    activate(order[next]);
  });
  view.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLElement>('[data-file-tab]')?.dataset.fileTab, tab = current();
    if (!action || !tab) return;
    if (action === 'edit' || action === 'reader') { tab.editing = action === 'edit'; tab.reads = (tab.reads ?? 0) + 1; render(); if (tab.editing) pane.focus({ preventScroll: true }); }
    if (action === 'discard' && !tab.saving) { tab.draft = undefined; tab.editorKey = crypto.randomUUID(); render(); void load(tab); }
    if (action === 'save') void save(tab);
    if (action === 'ask' && selectedCode) { questionCode = selectedCode; const form = view.querySelector<HTMLFormElement>('.file-selection-form')!; form.hidden = false; form.querySelector<HTMLInputElement>('input')!.focus(); }
    if (action === 'fix') void requestSelection('fix', selectedCode);
    if (action === 'cancel-question') view.querySelector<HTMLFormElement>('.file-selection-form')!.hidden = true;
    if (action === 'external') void deps.call('open_workspace_file', { ...tab.context, path: tab.path }).catch(deps.report);
    // Attaching is the first step of writing about the file, so focus goes to the prompt beside it.
    if (action === 'attach') { deps.attach(tab.path); deps.focusConversation(); }
    if (action === 'preview') void deps.preview(tab.path, tab.context).catch(deps.report);
    if (action === 'copy' && typeof tab.content === 'string') void navigator.clipboard.writeText(tab.draft ?? tab.content).then(() => deps.notify('File copied'), deps.report);
  });

  return {
    /**
     * Shows a task's tabs. Tabs opened in another workspace (the task changed project or worktree) are dropped,
     * and tabs opened with no task open never carry over to the next view without one.
     */
    show(id: string, nextWorkspace: string): void {
      key = id; workspace = nextWorkspace;
      const entry = threads.get(key);
      if (!id || (entry && entry.workspace !== workspace)) threads.delete(key);
      render();
      const tab = current(); if (tab) void load(tab);
    },
    open(path: string, context: Context, source = false): void {
      let entry = thread();
      if (!entry) { entry = { workspace, tabs: [], active: '', visible: true }; threads.set(key, entry); }
      entry.visible = true;
      const fresh: Tab = { path, context: { ...context }, ...(source ? { source } : {}) };
      const existing = entry.tabs.find(tab => tab.path === path);
      if (!existing) entry.tabs = [...entry.tabs, fresh];
      else if (Boolean(existing.source) !== source) {
        if (dirty(existing) || existing.saving) { deps.notify('Save or discard edits before changing the file view.'); activate(path); return; }
        entry.tabs = entry.tabs.map(tab => tab === existing ? fresh : tab);
      }
      activate(path);
      pane.focus({ preventScroll: true });
    },
    /** Re-reads the file on screen, e.g. after an agent run may have changed it. */
    reload(): void {
      const entry = thread(), tab = current(); if (!entry || !tab || tab.saving || dirty(tab)) return;
      const path = tab.path;
      void deps.call<string>('workspace_file_stamp', { ...tab.context, path: tab.path }).then(stamp => {
        if (entry.tabs.includes(tab) && tab.path === path && stamp !== tab.stamp) void load(tab);
      }, () => { if (entry.tabs.includes(tab) && tab.path === path && tab.stamp) close(tab.path, entry); });
    },
    hasChanges(context: Context, path: string): boolean { return [...threads.values()].some(entry => entry.tabs.some(tab => matches(tab, context, path) && (dirty(tab) || tab.saving))); },
    remap(context: Context, path: string, next?: string): void {
      for (const entry of threads.values()) for (const tab of [...entry.tabs]) {
        if (!matches(tab, context, path)) continue;
        if (next === undefined) close(tab.path, entry);
        else { const renamed = next + tab.path.slice(path.length); if (entry.active === tab.path) entry.active = renamed; tab.path = renamed; tab.editorKey = crypto.randomUUID(); tab.reads = (tab.reads ?? 0) + 1; }
      }
      render();
    },
    forget(id: string): void { threads.delete(id); if (id === key) render(); },
    toggle(): void { const entry = thread(); if (entry?.tabs.length) { entry.visible = !entry.visible; render(); } },
    get visible(): boolean { return Boolean(thread()?.visible && thread()?.tabs.length); },
    get active(): string { return thread()?.active ?? ''; },
    get count(): number { return thread()?.tabs.length ?? 0; },
  };
}
