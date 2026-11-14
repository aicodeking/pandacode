/** Host-only sidebar bindings: sections, rows, header controls and menus never cross the package boundary. */
import { isImeKey } from '../dom';
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createSidebarPresentation, snapshotSidebar, SIDEBAR_ENTRY_CONTROLS, SIDEBAR_ROW_CONTROLS, type SidebarAction, type SidebarControl, type SidebarPresentation } from './sidebar-core';
import { applySidebarPresentation, sidebarProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
import { SIDEBAR_FIXED_SECTIONS, SIDEBAR_HEADER_CONTROLS, SIDEBAR_HEADER_LOCATION, SIDEBAR_PINNED_SECTIONS, SIDEBAR_PROJECT_CONTROLS, SIDEBAR_PROJECTS_LOCATION, SIDEBAR_ROW_PARTS, SIDEBAR_ROWS_LOCATION, SIDEBAR_SECTIONS, SIDEBAR_SECTIONS_LOCATION, type SidebarSectionId } from './surfaces';

/** What the last navigation draw listed, by section; computed by main.ts from its own groups. */
export type SidebarModel = { sections: readonly { id: SidebarSectionId; count: number; collapsed: boolean; hidden: boolean }[]; filtering: boolean };
export type SidebarArrangement = { order: readonly SidebarSectionId[]; hidden: ReadonlySet<SidebarSectionId> };
export type SidebarHostState = { project?: string; task?: string; group: 'project' | 'flat'; taskSort: 'manual' | 'recent' | 'created'; projectSort: 'recent' | 'added' | 'name' | 'manual'; busy: boolean };

/** The original node of each header and project-row control (references inside the sidebar, not new actions). */
const CONTROL_NODES: Readonly<Record<string, string>> = {
  'new-task': '.sidebar-actions [data-action=new-task]', 'new-chat': '.sidebar-actions [data-action=new-chat]', search: '.sidebar-actions [data-action=search]',
  'project-filter': '#project-filter', sort: '#sidebar-sort', import: '.sidebar-projects [data-action=import-conversations]', 'open-project': '.sidebar-projects [data-action=add-project]',
};
const LABELS: Readonly<Partial<Record<SidebarControl, string>>> = { 'new-task': 'New task', 'new-chat': 'New chat', 'toggle-section': 'Collapse or expand section', settle: 'Settle task', reopen: 'Reopen task' };
const SECTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(SIDEBAR_SECTIONS);
const SECTION_IDS = new Set<string>(SIDEBAR_SECTIONS.map(([id]) => id));
const MOVABLE = SIDEBAR_SECTIONS.map(([id]) => id).filter(id => !SIDEBAR_FIXED_SECTIONS[id]);
const REORDERABLE_PARTS = SIDEBAR_ROW_PARTS.filter(([, , reorderable]) => reorderable).map(([id]) => `${SIDEBAR_ROWS_LOCATION}/${id}`);
const sectionOfGroup = (group: string | undefined): SidebarSectionId | undefined => { const id = group?.startsWith('project:') ? 'project' : group; return id && SECTION_IDS.has(id) ? id as SidebarSectionId : undefined; };

export function mountSidebarAdoption(options: {
  root: HTMLElement;
  nav: HTMLElement;
  model: () => SidebarModel;
  state: () => SidebarHostState;
  /** Context for the header accessory (the same one the footer uses). */
  context: () => Record<string, Json>;
  onContextChanged: (listener: () => void) => () => void;
  /** Redraws the navigation through the original renderer. */
  rerender: () => void;
  notify: (message: string) => void;
}) {
  const { root, nav } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, closeContext: (() => void) | undefined, cached: { key: string; value: SidebarArrangement } | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const headerBindings = () => SIDEBAR_HEADER_CONTROLS.map(([id]) => [`${SIDEBAR_HEADER_LOCATION}/${id}`, root.querySelector<HTMLElement>(CONTROL_NODES[id])] as const);
  const projectBindings = () => SIDEBAR_PROJECT_CONTROLS.map(([id]) => [`${SIDEBAR_PROJECTS_LOCATION}/${id}`, root.querySelector<HTMLElement>(CONTROL_NODES[id])] as const);
  const contributes = (location: string) => extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));

  /** Section order and reversible visibility for the next draw. The section holding the open task stays listed, every
   * section shows while filtering (as collapsed ones open), pinned sections never hide and safe mode is built-in. */
  function arrange(selected: SidebarSectionId | undefined, filtering: boolean): SidebarArrangement {
    const safe = disposed || extensionsSnapshot().safeMode, project = layoutProject(), key = JSON.stringify([selected, filtering, project, safe]);
    if (cached?.key === key) return cached.value;
    const order = safe ? MOVABLE : orderedControls(SIDEBAR_SECTIONS_LOCATION, MOVABLE.map(id => `${SIDEBAR_SECTIONS_LOCATION}/${id}`), project).map(id => id.slice(SIDEBAR_SECTIONS_LOCATION.length + 1) as SidebarSectionId);
    const hidden = new Set(safe || filtering ? [] : SIDEBAR_SECTIONS.map(([id]) => id).filter(id => !SIDEBAR_PINNED_SECTIONS[id] && id !== selected && layout.isHidden(`${SIDEBAR_SECTIONS_LOCATION}/${id}`, project)));
    cached = { key, value: { order, hidden } };
    return cached.value;
  }

  function authority() {
    const provider = sidebarProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider && root.dataset.sidebarProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  function presentation(): SidebarPresentation {
    const model = options.model(), state = options.state(), auth = authority(), rowHidden = new Set((nav.dataset.rowHidden ?? '').split(' ').filter(Boolean));
    finders.clear();
    const controls: { id: string; controlId: SidebarControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    const add = (controlId: SidebarControl, key: string, resource: string, find: () => HTMLElement | null, enabled = true, hidden = false) => {
      const node = find(); if (!node) return;
      const id = handle(`control:${controlId}:${key}`); finders.set(id, find);
      controls.push({ id, controlId, resource, enabled: enabled && !(node as HTMLButtonElement).disabled && !node.hidden, hidden: hidden || Boolean(node.closest('[data-layout-hidden]')) });
    };
    for (const [id, selector] of Object.entries(CONTROL_NODES)) add(id as SidebarControl, id, '', () => root.querySelector<HTMLElement>(selector));
    add('filter-clear', 'filter', '', () => root.querySelector<HTMLElement>('.sidebar-search-clear'), model.filtering);
    for (const section of model.sections) {
      if (section.hidden) continue;
      const selector = section.id === 'completed' ? '[data-action=toggle-completed]' : `[data-action=toggle-section][data-section="${section.id}"]`;
      add('toggle-section', section.id, handle(`section:${section.id}`), () => nav.querySelector<HTMLElement>(selector), !model.filtering);
    }
    add('completed-more', 'completed', handle('section:completed'), () => nav.querySelector<HTMLElement>('[data-action=completed-more]'));
    for (const more of nav.querySelectorAll<HTMLElement>('[data-action=toggle-folder-more]')) {
      const key = more.dataset.project ?? '';
      add('folder-more', key, handle(`more:${key}`), () => [...nav.querySelectorAll<HTMLElement>('[data-action=toggle-folder-more]')].find(node => node.dataset.project === key) ?? null);
    }
    const rows: { id: string; section: SidebarSectionId; selected: boolean; pinned: boolean; unread: boolean; active: boolean; settled: boolean }[] = [];
    let truncated = false;
    for (const row of nav.querySelectorAll<HTMLElement>('.task-row')) {
      const item = row.querySelector<HTMLElement>(':scope > .task-item'), section = sectionOfGroup(row.closest<HTMLElement>('[data-thread-group]')?.dataset.threadGroup);
      if (!item?.dataset.id || !section || row.closest('[hidden]')) continue;
      if (rows.length >= 128) { truncated = true; break; }
      const task = item.dataset.id, resource = handle(`row:${task}`), within = (selector: string) => () => nav.querySelector<HTMLElement>(`#task-row-${CSS.escape(task)} > ${selector}`);
      rows.push({ id: resource, section, selected: item.classList.contains('selected'), pinned: item.dataset.pinned === 'true', unread: item.classList.contains('unread'), active: item.dataset.activity === 'active', settled: row.dataset.stage === 'completed' });
      add('select-task', task, resource, within('.task-item'));
      add('task-menu', task, resource, within('.task-actions > .task-more'), true, rowHidden.has('more'));
      const tick = row.querySelector<HTMLElement>('.task-check');
      if (tick) add(tick.dataset.action === 'sidebar-reopen' ? 'reopen' : 'settle', task, resource, within('.task-actions > .task-check'), true, rowHidden.has('settle'));
    }
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: state.task ? handle(`task:${state.task}`) : '',
      revision: 0, visible: !disposed && root.isConnected && !root.hidden, focused: root.contains(document.activeElement),
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open]')), filtering: model.filtering, safeMode: extensionsSnapshot().safeMode,
      group: state.group, taskSort: state.taskSort, projectSort: state.projectSort,
      sections: model.sections.map(section => ({ id: section.id, pinned: Boolean(SIDEBAR_PINNED_SECTIONS[section.id]), hidden: section.hidden, collapsed: section.collapsed, count: Math.min(section.count, 100000) })),
      rows, controls: controls.slice(0, 512), truncated: truncated || controls.length > 512,
    };
    const next = JSON.stringify([{ ...value, focused: false }, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotSidebar({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; creation, collapse and stage changes need a fresh host choice. */
  function execute(action: SidebarAction, alive: () => boolean) {
    const node = finders.get(action.control)?.(); if (!node) return;
    if (!SIDEBAR_ENTRY_CONTROLS.includes(action.controlId)) { node.click(); return; }
    const task = SIDEBAR_ROW_CONTROLS.includes(action.controlId) ? node.closest('.task-row')?.querySelector<HTMLElement>(':scope > .task-item') : undefined;
    choosing = true; closeChoice?.();
    // A hidden tick has no box; the choice anchors on its row instead.
    closeChoice = openChoiceMenu({ anchor: task ?? node, title: 'Extension requested a sidebar action', items: [{ id: 'continue', label: `Continue: ${LABELS[action.controlId] ?? action.controlId}`, icon: 'sidebar' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createSidebarPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility on the original header and project-row nodes, and row parts through one list
   * attribute: nodes, listeners, drag sources and focus stay. Safe mode restores the built-in layout. */
  function applyLayout() {
    const safe = disposed || extensionsSnapshot().safeMode, header = headerBindings(), projects = projectBindings();
    applyControlOrder(SIDEBAR_HEADER_LOCATION, header, safe); applyControlOrder(SIDEBAR_PROJECTS_LOCATION, projects, safe);
    if (safe) for (const [, node] of [...header, ...projects]) { if (node?.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; } }
    else applyControlVisibility([...header, ...projects], () => root.querySelector<HTMLElement>('#sidebar-filter'));
    const focused = nav.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const parts = safe ? '' : SIDEBAR_ROW_PARTS.filter(([id]) => layout.isHidden(`${SIDEBAR_ROWS_LOCATION}/${id}`, layoutProject())).map(([id]) => id).join(' ');
    const order = !safe && orderedControls(SIDEBAR_ROWS_LOCATION, REORDERABLE_PARTS)[0] === `${SIDEBAR_ROWS_LOCATION}/more` ? 'more-first' : '';
    for (const [name, value] of [['rowHidden', parts], ['rowOrder', order]] as const) if ((nav.dataset[name] ?? '') !== value) { if (value) nav.dataset[name] = value; else delete nav.dataset[name]; }
    // A row part that hid under focus hands focus to its row.
    if (focused && !focused.checkVisibility()) focused.closest('.task-row')?.querySelector<HTMLElement>(':scope > .task-item')?.focus({ preventScroll: true });
  }
  /** The section layout a draw would apply, ignoring the open task and filtering: unchanged means no redraw. */
  const sectionLayout = () => { const { order, hidden } = arrange(undefined, false); return JSON.stringify([order, [...hidden]]); };
  let drawnLayout = JSON.stringify([MOVABLE, []]);
  function refresh() {
    if (disposed) return;
    closeContext?.(); closeContext = undefined; cached = undefined; lastProject = layoutProject();
    if (!applySidebarPresentation(root)) options.notify('Sidebar presentation failed. The built-in sidebar remains active.');
    applyLayout();
    const next = sectionLayout(); if (next === drawnLayout) return;
    drawnLayout = next;
    const focused = nav.contains(document.activeElement);
    options.rerender();
    // A section that hid under focus hands focus to the open row, or to the filter.
    if (focused && !nav.contains(document.activeElement)) (nav.querySelector<HTMLElement>('.task-item.selected') ?? root.querySelector<HTMLElement>('#sidebar-filter'))?.focus({ preventScroll: true });
  }
  /** Context for contributed section actions. Empty ids are omitted: the public context rejects empty text. */
  function actionContext(section: SidebarSectionId) {
    const project = options.state().project;
    return { ...(project ? { projectId: project } : {}), revision: presentation().revision, selection: { kind: 'sidebar-section', ids: [section] } };
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (disposed || extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    const heading = event.target.closest<HTMLElement>('.section-fold, .section-toggle'); if (!heading || !nav.contains(heading)) return;
    // With nothing contributed here the headings keep their zero-extension behavior: no new menu.
    if (!contributes('panda.sidebar.context')) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const section = sectionOfGroup(heading.closest<HTMLElement>('[data-thread-group]')?.dataset.threadGroup); if (!section) return;
    const label = SECTION_LABELS[section] ?? section, open = heading.getAttribute('aria-expanded') === 'true';
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(heading, 'panda.sidebar.context', actionContext(section), { title: `${label} section`, items: [{ id: 'toggle', label: `${open ? 'Collapse' : 'Expand'} ${label}`, icon: 'chevron' }], onSelect: id => { if (id === 'toggle' && !disposed && heading.isConnected) heading.click(); }, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => !disposed && heading.isConnected, onClose: () => { closeContext = undefined; } });
  }
  nav.addEventListener('contextmenu', openContext); nav.addEventListener('keydown', openContext);
  const header = root.querySelector<HTMLElement>('.sidebar-actions');
  const stopActions = header ? mountExtensionActions(header, 'panda.sidebar.actions', options.context, options.notify, options.onContextChanged) : () => {};
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, arrange, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); closeContext?.(); stopActions(); stopExtensions(); stopLayout(); stopContext();
      nav.removeEventListener('contextmenu', openContext); nav.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh);
      cached = undefined; applyLayout(); delete root.dataset.sidebarProvider; options.rerender();
    },
  };
}
