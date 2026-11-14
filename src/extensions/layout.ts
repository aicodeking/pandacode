/** Presentation preferences only. Separate records isolate corruption and scoped resets from core data. */
import { actionLocations, reorder, type Placement } from './ordering.ts';
import { isExtensionInspectorView } from '../inspector-tabs.ts';
const layoutLocations = [...actionLocations, 'panda.inspector.views'];
export const LAYOUT_KEY = 'pandacode.extensions.layout.v1';
export const SIDEBAR = 'panda.sidebar';
type Overlay = { schemaVersion: 1; visibility: Record<string, boolean>; extensionLayoutsEnabled: boolean; orders: Record<string, string[]>; selected: Record<string, string> };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const defaults = (): Overlay => ({ schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} });
// Core locations include camel-case families (actionDock, githubHub); package identities stay lowercase.
const validId = (id: string) => id.length <= 160 && (id === SIDEBAR || /^(?:panda\.[a-zA-Z0-9.-]+|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\/[a-z][a-z0-9-]*$/.test(id));
export function createLayoutStore(storage: Storage) {
  const cache = new Map<string, Overlay>(), listeners = new Set<() => void>();
  let diagnostic = '';
  const key = (projectId?: string) => projectId ? `${LAYOUT_KEY}.project.${encodeURIComponent(projectId)}` : LAYOUT_KEY;
  const read = (projectId?: string): Overlay => {
    const name = key(projectId);
    try {
      const raw = storage.getItem(name);
      if (raw === null) return defaults();
      if (raw.length > 256 * 1024) throw new Error('Oversized overlay');
      const value = JSON.parse(raw);
      if (!value || value.schemaVersion !== 1 || typeof value.extensionLayoutsEnabled !== 'boolean' || !value.visibility || typeof value.visibility !== 'object' || Array.isArray(value.visibility) || Object.keys(value.visibility).length > 2000 || Object.entries(value.visibility).some(([id, visible]) => !validId(id) || typeof visible !== 'boolean')) throw new Error('Invalid overlay');
      const orders = value.orders ?? {}, selected = value.selected ?? {};
      for (const record of [orders, selected]) if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(location => !layoutLocations.includes(location))) throw new Error('Invalid layout location');
      if (Object.values(orders).some(ids => !Array.isArray(ids) || ids.length > 2000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !validId(id))) || Object.values(selected).some(id => typeof id !== 'string' || !validId(id))) throw new Error('Invalid ordering');
      const result: Overlay = { schemaVersion: 1, visibility: { ...value.visibility }, extensionLayoutsEnabled: value.extensionLayoutsEnabled, orders, selected };
      cache.set(name, result); return result;
    } catch { diagnostic = 'Invalid or unavailable layout preferences: using the last valid layout or built-in defaults. Stored data is retained.'; return cache.get(name) ?? defaults(); }
  };
  const write = (value: Overlay, projectId?: string) => {
    // A failed save never claims persistence or mutates the last valid record.
    const encoded = JSON.stringify(value);
    if (Object.keys(value.visibility).length > 2000 || Object.values(value.orders).some(ids => ids.length > 2000 || new Set(ids).size !== ids.length) || encoded.length > 256 * 1024) throw new Error('Layout preference limit exceeded');
    storage.setItem(key(projectId), encoded); cache.set(key(projectId), value);
    listeners.forEach(listener => listener());
  };
  return {
    order(location: string, ids: readonly string[], projectId?: string): string[] {
      let result = [...ids];
      for (const overlay of [read(), ...(projectId ? [read(projectId)] : [])]) {
        const saved = overlay.orders[location];
        if (saved) result = [...saved.filter(id => ids.includes(id)), ...result.filter(id => !saved.includes(id))];
      }
      return result;
    },
    move(location: string, ids: readonly string[], operation: Placement, projectId?: string) {
      if (!layoutLocations.includes(location) || ids.some(id => !validId(id) || location === 'panda.inspector.views' && !isExtensionInspectorView(id))) throw new Error('Unsupported placement; only compatible controls or extension inspector tabs can reorder');
      const current = read(projectId), ordered = reorder(ids, operation);
      // Keep missing extension IDs dormant, including across edits while disabled.
      let index = 0;
      const retained = (current.orders[location] ?? []).map(id => ids.includes(id) ? ordered[index++] : id);
      const combined = [...retained, ...ordered.slice(index)];
      write({ ...current, orders: { ...current.orders, [location]: combined } }, projectId);
    },
    selected(location: string) { return read().selected[location]; },
    select(location: string, id: string) {
      if (!actionLocations.includes(location) || !validId(id)) throw new Error('Invalid layout selection');
      const current = read(); write({ ...current, extensionLayoutsEnabled: true, selected: { ...current.selected, [location]: id } });
    },
    isHidden(id: string, projectId?: string): boolean {
      const global = read(), project = projectId ? read(projectId) : undefined;
      return (project?.visibility[id] ?? global.visibility[id] ?? true) === false;
    },
    setVisible(id: string, visible: boolean, projectId?: string) {
      if (!validId(id) || typeof visible !== 'boolean') throw new Error('Invalid layout item');
      const current = read(projectId); write({ ...current, visibility: { ...current.visibility, [id]: visible } }, projectId);
    },
    resetProject(projectId: string) { if (!projectId) throw new Error('Project required'); write(defaults(), projectId); },
    resetGlobal() { write(defaults()); },
    disableExtensionLayouts() { write({ ...read(), extensionLayoutsEnabled: false }); },
    extensionLayoutsEnabled: () => read().extensionLayoutsEnabled,
    diagnostic: () => diagnostic,
    refresh() { listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
