// Editor tabs in the inspector: files opened from the Files tree, search, or file links each get
// a tab in the inspector's Open files view, kept per task, so the conversation stays in sight.
import './file-tabs.css';
import { renderDocument } from './document-viewer';
import { escape, fileIcon, icon } from './dom';
import { isPreviewableFile } from './file-links';
import type { OfficeKind } from './office-viewer';
import { applyDocumentPresentation } from './extensions/replacement';
import { createDocumentPresentation, type DocumentPresentation, type DocumentAction } from './extensions/documents';
import type { ViewerControl } from './extensions/document-controls';
import { onExtensionsChanged, extensionsSnapshot } from './extensions/manager';
import { applyControlOrder, applyControlVisibility, layout } from './extensions/layout-host';
import { mountExtensionActions } from './extensions/header';
import { openContextActions } from './extensions/context-actions';

type Context = { projectId: string; sessionId?: string };
/** `source` shows a viewer-handled file (e.g. an SVG) as text. */
type Tab = { id: string; documentId: string; path: string; context: Context; content?: string | ArrayBuffer; reads?: number; source?: boolean; used?: number };
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
type Thread = { workspace: string; tabs: Tab[]; active: string };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** Attaching only applies to the task shown, so the host decides. */
  canAttach(context: Context): boolean;
  attach(path: string): void;
  preview(path: string, context: Context): Promise<void>;
  notify(text: string): void;
  report(error: unknown): void;
  /** Where focus goes when the last file tab closes from the keyboard. */
  focusConversation(): void;
  /** The shown task's last tab closed, so the host can leave the Open files view. */
  emptied(): void;
};

export function createFileTabs(deps: Deps) {
  const pane = document.querySelector<HTMLElement>('#file-panel')!;
  const strip = pane.querySelector<HTMLElement>('#file-tabs')!;
  const view = pane.querySelector<HTMLElement>('#file-view')!;
  const threads = new Map<string, Thread>();
  let key = '', workspace = '';
  let disposeOffice = () => {};
  let tick = 0;
  let revision = 0;
  let documentContext = crypto.randomUUID();
  let rendered: Tab | undefined, renderedContent: Tab['content'];
  let viewerControls: ViewerControl[] = [];
  let disposeActions = () => {};
  /** Actions project just their captured tab/control, so public DTO limits never cap the
   * built-in tab count or the original spreadsheet's sheet count. */
  const presentation = (target?: Tab, allowedControls?: readonly string[]): DocumentPresentation => {
    const tabs = (thread()?.tabs ?? []).filter(tab => !target || tab === target);
    const focusedPath = document.activeElement?.closest<HTMLElement>('.file-tab')?.dataset.tab;
    const focusedTab = thread()?.tabs.find(tab => tab.path === focusedPath);
    return { contractVersion: 1, context: documentContext, revision,
      selected: tabs.includes(current()!) ? current()!.id : '',
      focused: strip.contains(document.activeElement) ? focusedTab?.id ?? '' : view.contains(document.activeElement) ? current()?.documentId ?? '' : '',
      visible: pane.checkVisibility() && !pane.closest('[inert]'),
      tabs: tabs.map(tab => ({ id: tab.id, documentId: tab.documentId, label: name(tab.path), controls: [
        { id: 'select', label: 'Select', enabled: true }, { id: 'close', label: 'Close', enabled: true },
        ...(tab === current() ? [
          { id: 'attach', label: 'Attach', enabled: deps.canAttach(tab.context) },
          { id: 'copy', label: 'Copy file', enabled: typeof tab.content === 'string' },
          { id: 'preview', label: 'Preview in browser', enabled: isPreviewableFile(tab.path) },
          ...viewerControls.map(control => ({ id: control.id, label: control.label, enabled: true, ...(control.node.hasAttribute('aria-pressed') ? { selected: control.node.getAttribute('aria-pressed') === 'true' } : {}) })),
        ] : []),
      ].filter(control => !allowedControls || allowedControls.includes(control.id)) })),
    };
  };
  function perform(action: DocumentAction): void {
    const tab = thread()?.tabs.find(tab => tab.id === action.tabId); if (!tab) return;
    if (action.controlId === 'select') { activate(tab.path); return; }
    if (action.controlId === 'close') { close(tab.path); return; }
    if (tab !== current()) return;
    if (action.controlId === 'attach') { deps.attach(tab.path); deps.focusConversation(); }
    else if (action.controlId === 'preview') void deps.preview(tab.path, tab.context).catch(deps.report);
    else if (action.controlId === 'copy' && typeof tab.content === 'string') void navigator.clipboard.writeText(tab.content).then(() => deps.notify('File copied'), deps.report);
    else viewerControls.find(control => control.id === action.controlId)?.run();
  }
  const dispatch = (tab: Tab, controlId: string) => {
    const currentProps = () => presentation(tab, [controlId]);
    const props = currentProps(), instance = createDocumentPresentation(props, currentProps, () => true, perform);
    try { return instance.dispatch({ contractVersion: 1, context: props.context, revision: props.revision, tabId: tab.id, documentId: tab.documentId, controlId }); }
    finally { instance.dispose(); }
  };
  function refreshPresentation(): void {
    applyDocumentPresentation(pane);
    const bindings: (readonly [string, HTMLElement])[] = viewerControls.filter(control => !control.id.startsWith('sheet-')).map(control => [`panda.documents.viewer/${control.id}`, control.node] as const);
    const sheets = viewerControls.find(control => control.id.startsWith('sheet-'))?.node.parentElement;
    if (sheets) bindings.push(['panda.documents.viewer/sheet', sheets]);
    for (const action of ['preview', 'copy', 'attach']) {
      const node = view.querySelector<HTMLElement>(`.file-view-header [data-file-tab="${action}"]`);
      if (node) bindings.push([`panda.documents.actions/${action}`, node]);
    }
    applyControlOrder('panda.documents.viewer', bindings.filter(([id]) => id.startsWith('panda.documents.viewer/')));
    applyControlOrder('panda.documents.actions', bindings.filter(([id]) => id.startsWith('panda.documents.actions/')));
    if (!extensionsSnapshot().safeMode) applyControlVisibility(bindings, () => strip.querySelector<HTMLElement>('[aria-selected="true"]'));
    const tabBindings = [...strip.querySelectorAll<HTMLElement>('.file-tab')].flatMap(tab => ['select', 'close'].map(action => [`panda.documents.tabs/${action}`, tab.querySelector<HTMLElement>(`[data-file-tab="${action}"]`)] as const));
    applyControlOrder('panda.documents.tabs', tabBindings);
    if (!extensionsSnapshot().safeMode) applyControlVisibility(tabBindings, () => view.querySelector<HTMLElement>('button:not([inert])') ?? null);
  }
  onExtensionsChanged(refreshPresentation);
  layout.subscribe(refreshPresentation);
  window.addEventListener('pandacode-components-change', refreshPresentation);

  const thread = (): Thread | undefined => threads.get(key);
  const current = (): Tab | undefined => thread()?.tabs.find(tab => tab.path === thread()!.active);
  const name = (path: string) => path.split('/').pop() ?? path;

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
    const focused = document.activeElement, onStrip = strip.contains(focused);
    draw();
    const now = document.activeElement;
    if (!onStrip && !(focused && pane.contains(focused) && (!now || now === document.body || now.closest('[inert]')))) return;
    const tab = strip.hidden ? null : strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) tab.focus(); else deps.focusConversation();
  }

  function draw(): void {
    revision++;
    const entry = thread(), active = current();
    // Re-reading the file on screen keeps the reader's place in it.
    const scroll = active && view.dataset.path === active.path ? view.querySelector('.file-view-body')?.scrollTop ?? 0 : 0;
    view.dataset.path = active?.path ?? '';
    const unchanged = active === rendered && active?.content === renderedContent;
    strip.hidden = !entry?.tabs.length;
    view.hidden = !active;
    if (!entry?.tabs.length) { disposeActions(); disposeOffice(); disposeOffice = () => {}; rendered = undefined; viewerControls = []; strip.innerHTML = ''; view.innerHTML = ''; refreshPresentation(); return; }
    const tabButton = (path: string, label: string, glyph: string) => {
      const selected = entry.active === path;
      return `<div class="file-tab${selected ? ' selected' : ''}" role="presentation" data-tab="${escape(path)}"><button role="tab" aria-selected="${selected}" aria-controls="file-view" tabindex="${selected ? 0 : -1}" data-file-tab="select" title="${escape(path)}">${glyph}<span>${escape(label)}</span></button><button class="icon-button" tabindex="-1" data-file-tab="close" aria-label="Close ${escape(label)}" title="Close (Delete)">${icon('close')}</button></div>`;
    };
    strip.innerHTML = entry.tabs.map(tab => tabButton(tab.path, name(tab.path), fileIcon(name(tab.path), false))).join('');
    if (unchanged) { refreshPresentation(); return; }
    disposeActions(); disposeOffice(); disposeOffice = () => {}; viewerControls = [];
    rendered = active; renderedContent = active?.content;
    if (!active) { view.innerHTML = ''; return; }
    const attach = deps.canAttach(active.context) ? `<button data-file-tab="attach">${icon('attach')} Attach</button>` : '';
    const preview = isPreviewableFile(active.path) ? `<button class="icon-button" data-file-tab="preview" aria-label="Preview in browser" title="Preview in browser">${icon('globe')}</button>` : '';
    view.innerHTML = `<div class="file-view-header"><span class="file-view-path" title="${escape(active.path)}">${escape(active.path)}</span><div class="file-preview-actions">${preview}${typeof active.content === 'object' ? '' : `<button class="icon-button" data-file-tab="copy" aria-label="Copy file" title="Copy file">${icon('copy')}</button>`}${attach}</div></div><div class="file-view-body"></div>`;
    const body = view.querySelector<HTMLElement>('.file-view-body')!;
    const context = { ...active.context, selection: { kind: 'file', ids: [active.id, active.documentId] }, revision };
    disposeActions = mountExtensionActions(view.querySelector<HTMLElement>('.file-preview-actions')!, 'panda.documents.actions', () => ({ ...context, revision }), deps.notify);
    refreshPresentation();
    const controlsChanged = (controls: ViewerControl[]) => { if (current() !== active || !body.isConnected) return; viewerControls = controls; revision++; refreshPresentation(); };
    if (active.content === undefined) { body.innerHTML = '<div class="inspector-empty" role="status">Loading file…</div>'; return; }
    if (typeof active.content === 'string') {
      renderDocument(body, active.path, active.content, path => deps.call<string>('workspace_image', { ...active.context, path }), controlsChanged);
      body.scrollTop = scroll;
      return;
    }
    const bytes = active.content, kind = officeKind(active.path)!;
    let disposed = false;
    disposeOffice = () => { disposed = true; };
    void import('./office-viewer').then(({ renderOffice }) => renderOffice(body, kind, bytes, active.path, controlsChanged)).then(dispose => {
      // The tab may have been switched or closed while the viewer was drawing.
      if (disposed || !body.isConnected) { dispose(); return; }
      disposeOffice = dispose; body.scrollTop = scroll;
    }).catch(error => {
      if (!disposed && body.isConnected) body.innerHTML = `<div class="inspector-empty" role="alert">This file could not be opened: ${escape(error instanceof Error ? error.message : String(error))}</div>`;
    });
  }

  /** Reads the tab's file; a reply for a tab that is no longer shown only fills its cache. */
  async function load(tab: Tab): Promise<void> {
    const read = tab.reads = (tab.reads ?? 0) + 1;
    try {
      const content = officeKind(tab.path) && !tab.source
        ? await deps.call<ArrayBuffer>('read_document_file', { ...tab.context, path: tab.path })
        : await deps.call<string>('read_file', { ...tab.context, path: tab.path });
      // An older reply arriving after a newer one must not put stale text back.
      if (read !== tab.reads || sameContent(content, tab.content)) return;
      tab.content = content;
      if (current() === tab) render(); else trim();
    } catch (error) {
      if (read !== tab.reads) return;
      const owner = [...threads.values()].find(entry => entry.tabs.includes(tab));
      if (!owner) return;
      close(tab.path, owner);
      deps.report(error);
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
    entry.tabs = entry.tabs.filter(tab => tab.path !== path);
    if (entry.active === path) entry.active = (entry.tabs[index] ?? entry.tabs[index - 1])?.path ?? '';
    if (entry !== thread()) return;
    if (!entry.tabs.length) deps.emptied();
    render(); const tab = current(); if (tab) void load(tab);
  }

  strip.addEventListener('click', event => {
    const control = (event.target as Element).closest<HTMLElement>('[data-file-tab]'); if (!control) return;
    const path = control.closest<HTMLElement>('.file-tab')!.dataset.tab!;
    const tab = thread()?.tabs.find(tab => tab.path === path); if (tab) dispatch(tab, control.dataset.fileTab === 'close' ? 'close' : 'select');
  });
  const contextMenu = (event: MouseEvent | KeyboardEvent) => {
    if (event instanceof KeyboardEvent && !(event.key === 'F10' && event.shiftKey || event.key === 'ContextMenu')) return;
    const anchor = (event.target as Element).closest<HTMLElement>('[data-file-tab="select"]');
    const path = anchor?.closest<HTMLElement>('.file-tab')?.dataset.tab;
    const tab = thread()?.tabs.find(tab => tab.path === path); if (!anchor || !tab) return;
    event.preventDefault();
    const controls = ['select', 'close', 'attach', 'copy', 'preview'];
    const currentProps = () => presentation(tab, controls);
    const props = currentProps(), captured = createDocumentPresentation(props, currentProps, () => true, perform);
    openContextActions(anchor, 'panda.documents.context', { ...tab.context, selection: { kind: 'file', ids: [tab.id, tab.documentId] }, revision: props.revision }, {
      title: name(tab.path), notify: deps.notify, items: props.tabs.find(item => item.id === tab.id)!.controls.filter(control => ['select', 'close', 'attach', 'copy', 'preview'].includes(control.id) && control.enabled).map(control => ({ id: control.id, label: control.label })),
      onSelect: controlId => { const result = captured.dispatch({ contractVersion: 1, context: props.context, revision: props.revision, tabId: tab.id, documentId: tab.documentId, controlId }); if (!result.ok) deps.notify(result.reason); },
      isAlive: () => currentProps().revision === props.revision && currentProps().visible,
    });
  };
  strip.addEventListener('contextmenu', contextMenu);
  strip.addEventListener('keydown', contextMenu);
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
    dispatch(tab, action);
  });

  return {
    /**
     * Shows a task's tabs. Tabs opened in another workspace (the task changed project or worktree) are dropped,
     * and tabs opened with no task open never carry over to the next view without one.
     */
    show(id: string, nextWorkspace: string): void {
      if (id !== key || nextWorkspace !== workspace) documentContext = crypto.randomUUID();
      key = id; workspace = nextWorkspace;
      const entry = threads.get(key);
      if (!id || (entry && entry.workspace !== workspace)) threads.delete(key);
      render();
      const tab = current(); if (tab) void load(tab);
    },
    open(path: string, context: Context, source = false): void {
      let entry = thread();
      if (!entry) { entry = { workspace, tabs: [], active: '' }; threads.set(key, entry); }
      const fresh: Tab = { id: crypto.randomUUID(), documentId: crypto.randomUUID(), path, context: { ...context }, ...(source ? { source } : {}) };
      const existing = entry.tabs.find(tab => tab.path === path);
      if (!existing) entry.tabs = [...entry.tabs, fresh];
      else if (Boolean(existing.source) !== source) { fresh.id = existing.id; fresh.documentId = existing.documentId; entry.tabs = entry.tabs.map(tab => tab === existing ? fresh : tab); }
      activate(path);
    },
    /** Re-reads the file on screen, e.g. after an agent run may have changed it. */
    // Documents can be tens of megabytes, so they are re-read only when their tab is opened again.
    reload(): void { const tab = current(); if (tab && (tab.source || !officeKind(tab.path))) void load(tab); },
    forget(id: string): void { threads.delete(id); if (id === key) render(); },
    get active(): string { return thread()?.active ?? ''; },
    get count(): number { return thread()?.tabs.length ?? 0; },
  };
}
