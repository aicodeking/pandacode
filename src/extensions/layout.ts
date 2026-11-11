/** Presentation preferences only. Separate records isolate corruption and scoped resets from core data. */
export const LAYOUT_KEY = 'pandacode.extensions.layout.v1';
export const SIDEBAR = 'panda.sidebar';
type Overlay = { schemaVersion: 1; visibility: Record<string, boolean>; extensionLayoutsEnabled: boolean };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const defaults = (): Overlay => ({ schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true });
const validId = (id: string) => id.length <= 160 && (id === SIDEBAR || /^(?:panda\.[a-z0-9.-]+|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\/[a-z][a-z0-9-]*$/.test(id));
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
      const result: Overlay = { schemaVersion: 1, visibility: { ...value.visibility }, extensionLayoutsEnabled: value.extensionLayoutsEnabled };
      cache.set(name, result); return result;
    } catch { diagnostic = 'Invalid or unavailable layout preferences: using the last valid layout or built-in defaults. Stored data is retained.'; return cache.get(name) ?? defaults(); }
  };
  const write = (value: Overlay, projectId?: string) => {
    // A failed save never claims persistence or mutates the last valid record.
    const encoded = JSON.stringify(value);
    if (Object.keys(value.visibility).length > 2000 || encoded.length > 256 * 1024) throw new Error('Layout preference limit exceeded');
    storage.setItem(key(projectId), encoded); cache.set(key(projectId), value);
    listeners.forEach(listener => listener());
  };
  return {
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
