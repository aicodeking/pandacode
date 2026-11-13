/** The inspector's open views as a tab strip: which tabs are open, in what
 * order, and which one is selected. Pure helpers plus a localStorage round trip. */

export type BuiltinInspectorView = 'changes' | 'files' | 'search' | 'browser' | 'pull' | 'simulator' | 'vm' | 'design' | 'btw';
declare const extensionViewId: unique symbol;
export type ExtensionInspectorView = string & { readonly [extensionViewId]: true };
export type InspectorView = BuiltinInspectorView | ExtensionInspectorView;
export type InspectorTabs = { open: InspectorView[]; selected: InspectorView };

/** Every view in the order the "+" menu lists them. */
export const INSPECTOR_VIEWS: readonly BuiltinInspectorView[] = ['files', 'search', 'changes', 'browser', 'pull', 'simulator', 'vm', 'design', 'btw'];
export const INSPECTOR_TABS_KEY = 'pandacode.inspector.tabs';
export const DEFAULT_INSPECTOR_TABS: InspectorTabs = { open: ['changes'], selected: 'changes' };

export function isExtensionInspectorView(value: unknown): value is ExtensionInspectorView {
  return typeof value === 'string' && value.length <= 160 && !value.startsWith('panda.') && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(value);
}

/** Drops invalid/repeated IDs and unavailable built-ins; valid extension intent stays dormant. */
export function normalizeTabs(value: unknown, available: readonly InspectorView[] = INSPECTOR_VIEWS): InspectorTabs {
  const raw = value && typeof value === 'object' ? value as { open?: unknown; selected?: unknown } : {};
  const open = Array.isArray(raw.open) ? [...new Set(raw.open.slice(0, 256).filter((view): view is InspectorView => isExtensionInspectorView(view) || INSPECTOR_VIEWS.includes(view as BuiltinInspectorView) && available.includes(view as InspectorView)))] : [];
  if (!open.length) return { open: [...DEFAULT_INSPECTOR_TABS.open], selected: DEFAULT_INSPECTOR_TABS.selected };
  return { open, selected: open.includes(raw.selected as InspectorView) ? raw.selected as InspectorView : open[0] };
}

/** Presentation never mutates persisted intent. Missing/hidden extensions cannot blank the shell. */
export function resolveTabs(tabs: InspectorTabs, available: readonly InspectorView[] = INSPECTOR_VIEWS): InspectorTabs {
  const open = tabs.open.filter(view => available.includes(view));
  if (isExtensionInspectorView(tabs.selected) && !open.includes(tabs.selected)) {
    if (!open.includes('changes')) open.unshift('changes');
    return { open, selected: 'changes' };
  }
  if (!open.length) return { open: ['changes'], selected: 'changes' };
  return { open, selected: open.includes(tabs.selected) ? tabs.selected : open[0] };
}

/** Adds the view as the last tab when it is missing, and selects it. */
export function openTab(tabs: InspectorTabs, view: InspectorView): InspectorTabs {
  return { open: tabs.open.includes(view) ? tabs.open : [...tabs.open, view], selected: view };
}

/** Closes a tab; a closed selected tab hands the selection to its right neighbour, else its left. The last tab stays. */
export function closeTab(tabs: InspectorTabs, view: InspectorView): InspectorTabs {
  const index = tabs.open.indexOf(view);
  if (index < 0 || tabs.open.length < 2) return tabs;
  const open = tabs.open.filter(item => item !== view);
  return { open, selected: tabs.selected === view ? open[Math.min(index, open.length - 1)] : tabs.selected };
}

/** Views that can still be opened from the "+" menu, in menu order. */
export function closedViews(tabs: InspectorTabs, available: readonly InspectorView[] = INSPECTOR_VIEWS): InspectorView[] {
  return available.filter(view => !tabs.open.includes(view));
}

/** The view a task without its own panel state opens on: the selected tab, except the
 * browser, whose page belongs to one task; then Changes, or the first other open tab. */
export function threadDefault(tabs: InspectorTabs, available: readonly InspectorView[] = INSPECTOR_VIEWS): InspectorView {
  tabs = resolveTabs(tabs, available);
  if (tabs.selected !== 'browser') return tabs.selected;
  return tabs.open.includes('changes') ? 'changes' : tabs.open.find(view => view !== 'browser') ?? 'changes';
}

export function sameTabs(a: InspectorTabs, b: InspectorTabs): boolean {
  return a.selected === b.selected && a.open.length === b.open.length && a.open.every((view, index) => view === b.open[index]);
}

export function loadTabs(storage: Pick<Storage, 'getItem'>, available?: readonly InspectorView[]): InspectorTabs {
  try { return normalizeTabs(JSON.parse(storage.getItem(INSPECTOR_TABS_KEY) ?? 'null'), available); }
  catch { return normalizeTabs(null, available); }
}

export function saveTabs(storage: Pick<Storage, 'setItem'>, tabs: InspectorTabs): void {
  try { storage.setItem(INSPECTOR_TABS_KEY, JSON.stringify(tabs)); } catch { /* the strip still works for this launch */ }
}
