/** Host-only core Settings bindings: sections, rows, page headers and dialogs never cross the package boundary. */
import { isImeKey } from '../dom';
import { openChoiceMenu } from '../choice-menu';
import { SECTIONS, type SettingsPage, type SettingsSection } from '../settings-sections';
import { createSettingsPresentation, snapshotSettings, SETTINGS_ENTRY_CONTROLS, type SettingsAction, type SettingsCorePage, type SettingsPresentation } from './settings-core';
import { applySettingsPresentation, settingsProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
import { SETTINGS_CONTROLS_LOCATION, SETTINGS_CORE_CONTROLS, SETTINGS_PINNED_SECTIONS, SETTINGS_SECTIONS_LOCATION } from './surfaces';

/** The original node of each eligible control, inside its own page panel (references, not new rendered actions). */
const CONTROL_NODES: Readonly<Record<string, string>> = {
  'compact-mode': '#compact-mode', 'expand-tool-activity': '#expand-tool-activity', 'toggle-theme': '[data-action=toggle-theme]', 'daily-wallpapers': '#daily-wallpapers',
  'default-provider': '#default-provider', 'default-model': '#default-model', 'agent-updates': '[data-action=agent-updates]', 'refresh-agents': '.settings-refresh',
  'agent-integrations': '[data-action=agent-integrations]', 'jev-settings': '[data-action=jev-settings]', support: '[data-action=support]',
};
const LABELS: Readonly<Record<string, string>> = Object.fromEntries(SETTINGS_CORE_CONTROLS.map(([id, label]) => [id, label]));
const CORE_PAGES = new Set<string>(SECTIONS.flatMap(section => section.pages.map(page => page.id)));

export function mountSettingsAdoption(options: {
  root: HTMLElement;
  /** The page shown now (core or extension-owned). */
  shown: () => SettingsPage | undefined;
  open: (section: SettingsSection) => void;
  project: () => string | undefined;
  notify: (message: string) => void;
}) {
  const { root } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>(), actionCleanups = new Map<string, () => void>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, closeChoice: (() => void) | undefined, closeContext: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const panel = (page: string) => root.querySelector<HTMLElement>(`#${CSS.escape(`settings-panel-${page}`)}`);
  const control = (id: string, page: string) => panel(page)?.querySelector<HTMLElement>(CONTROL_NODES[id]) ?? null;
  /** A row hides and moves as one: its label and info mark travel with the control. */
  const row = (node: HTMLElement) => node.closest<HTMLElement>('.setting-row') ?? node;
  const sectionTabs = () => SECTIONS.map(section => [`${SETTINGS_SECTIONS_LOCATION}/${section.id}`, root.querySelector<HTMLElement>(`.settings-nav-list > [data-section="${CSS.escape(section.id)}"]:not([data-extension-settings-page])`)] as const);
  const controlRows = () => SETTINGS_CORE_CONTROLS.map(([id, , page]) => { const node = control(id, page); return [`${SETTINGS_CONTROLS_LOCATION}/${id}`, node && row(node)] as const; });
  const shownSection = () => { const page = options.shown(); return SECTIONS.find(section => section.pages.some(item => item.id === page))?.id; };

  function authority() {
    const provider = settingsProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider && root.dataset.settingsProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  function presentation(): SettingsPresentation {
    const shown = options.shown(), page = (shown && CORE_PAGES.has(shown) ? shown : 'extension') as SettingsCorePage | 'extension', auth = authority(), project = options.project() ?? '';
    const sections = sectionTabs().map(([id, tab]) => ({ id: id.slice(SETTINGS_SECTIONS_LOCATION.length + 1), pinned: Object.hasOwn(SETTINGS_PINNED_SECTIONS, id.slice(SETTINGS_SECTIONS_LOCATION.length + 1)), hidden: Boolean(tab?.hasAttribute('data-layout-hidden')) }));
    const controls = page === 'extension' ? [] : SETTINGS_CORE_CONTROLS.filter(([, , owner]) => owner === page).flatMap(([id]) => {
      const node = control(id, page); if (!node) return [];
      return [{ id: handle(`control:${page}:${id}`), controlId: id, page, enabled: !(node as HTMLButtonElement).disabled, hidden: row(node).hasAttribute('data-layout-hidden') }];
    });
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: project ? handle(`project:${project}`) : '', page, section: page === 'extension' ? 'extension' : shownSection() ?? 'extension', revision: 0, visible: !disposed && root.isConnected && !root.hidden && Boolean(shown && panel(shown) && !panel(shown)!.hidden), focused: root.contains(document.activeElement), busy: choosing || Boolean(document.querySelector('dialog[open]')), offline: !navigator.onLine, safeMode: extensionsSnapshot().safeMode, sections, controls: controls.slice(0, 64), truncated: controls.length > 64 };
    const next = JSON.stringify([{ ...value, focused: false }, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotSettings({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; preference and external entries need a fresh host choice. */
  function execute(action: SettingsAction, alive: () => boolean) {
    const node = control(action.controlId, action.page); if (!node) return;
    if (!SETTINGS_ENTRY_CONTROLS.includes(action.controlId)) { node.click(); return; }
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: node, title: 'Extension requested a Settings action', items: [{ id: 'continue', label: `Continue: ${LABELS[action.controlId] ?? action.controlId}`, icon: 'settings' }], onSelect: id => {
      if (id === 'continue' && alive()) { closeChoice?.(); node.click(); }
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createSettingsPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.page === action.page && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility, applied in place: nodes, listeners and pending edits stay. Safe mode restores the built-in layout. */
  function applyLayout() {
    const safe = extensionsSnapshot().safeMode, selected = shownSection(), focused = document.activeElement as HTMLElement | null;
    const tabs = sectionTabs(), rows = controlRows();
    applyControlOrder(SETTINGS_SECTIONS_LOCATION, tabs, safe); applyControlOrder(SETTINGS_CONTROLS_LOCATION, rows, safe);
    let lost = false;
    for (const [id, tab] of tabs) {
      if (!tab) continue;
      const section = id.slice(SETTINGS_SECTIONS_LOCATION.length + 1);
      // A pinned section never hides, and the section being read stays listed until another is chosen.
      const hidden = !safe && !Object.hasOwn(SETTINGS_PINNED_SECTIONS, section) && section !== selected && layout.isHidden(id, layoutProject());
      if (hidden && tab.contains(focused)) lost = true;
      tab.toggleAttribute('data-layout-hidden', hidden); tab.inert = hidden;
    }
    for (const [id, node] of rows) {
      if (!node) continue;
      const hidden = !safe && layout.isHidden(id, layoutProject());
      if (hidden && node.contains(focused)) lost = true;
      node.toggleAttribute('data-layout-hidden', hidden); node.inert = hidden;
    }
    if (lost) root.querySelector<HTMLElement>('.settings-nav-list > [aria-selected="true"]')?.focus({ preventScroll: true });
  }
  function refresh() {
    if (disposed) return;
    closeContext?.(); closeContext = undefined;
    if (!applySettingsPresentation(root)) options.notify('Settings presentation failed. Built-in Settings remain active.');
    applyLayout();
  }
  /** Context for contributed page and section actions. Empty ids are omitted: the public context rejects empty text. */
  function actionContext(page: string, kind: 'page' | 'section' = 'page') {
    const project = options.project();
    return { ...(project ? { projectId: project } : {}), revision: presentation().revision, selection: { kind: 'settings-page', ids: [kind === 'page' ? page : `section:${page}`] } };
  }
  /** The page header accessory: shared contributed actions next to the original heading, mounted with the page. */
  function mountActions(page: SettingsPage) {
    const head = panel(page)?.querySelector<HTMLElement>('.settings-panel-head');
    if (!head || actionCleanups.has(page) || !CORE_PAGES.has(page)) return;
    actionCleanups.set(page, mountExtensionActions(head, 'panda.settings.actions', () => actionContext(page), options.notify, undefined, () => !disposed));
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLElement>('.settings-nav-list > [role="tab"]'); if (!tab || !root.contains(tab)) return;
    // With nothing contributed here the section list keeps its zero-extension behavior: no new menu.
    const snapshot = extensionsSnapshot();
    if (!snapshot.packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === 'panda.settings.context'))) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const section = tab.dataset.section as SettingsSection, label = tab.textContent?.trim() || section;
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(tab, 'panda.settings.context', actionContext(section, 'section'), { title: `${label} section`, items: [{ id: 'open', label: `Open ${label}`, icon: 'forward' }], onSelect: id => { if (id === 'open' && !disposed) options.open(section); }, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => !disposed && tab.isConnected, onClose: () => { closeContext = undefined; } });
  }
  root.addEventListener('contextmenu', openContext); root.addEventListener('keydown', openContext);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, refresh, mountActions, applyLayout,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); closeContext?.(); actionCleanups.forEach(cleanup => cleanup()); actionCleanups.clear();
      stopExtensions(); stopLayout(); root.removeEventListener('contextmenu', openContext); root.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh);
      delete root.dataset.settingsProvider;
    },
  };
}
