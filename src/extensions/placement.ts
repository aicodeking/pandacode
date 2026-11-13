/** Host-owned presentation placement. Never serialize nodes, services or business state.
 * Move existing nodes rather than remounting: snapshot/restore loses native undo and PTY identity.
 * Keep unavailable IDs dormant rather than rewriting intent on registry/owner changes.
 */
export type PlacementContainer = { id: string; accepts: readonly string[]; parent?: string };
export type PlacementView = { id: string; contract: string; home: string };
export type ViewPlacement = { container: string; hidden: boolean };
export type PlacementState = Record<string, ViewPlacement>;
export type PlacementAction = { id: string; container?: string; hidden?: boolean };
export const PLACEMENT_KEY = 'pandacode.extensions.placement.v1';
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 160 && /^(?:panda\.[a-z0-9.-]+|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\/[a-z][a-z0-9-]*$/.test(id);
export function validatePlacements(value: unknown): value is PlacementState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256 || !Object.entries(value).every(([id, entry]) => validId(id) && entry && typeof entry === 'object' && validId(entry.container) && typeof entry.hidden === 'boolean')) return false;
  const state = value as PlacementState;
  return Object.keys(state).every(id => {
    const seen = new Set<string>(); let next: string | undefined = id;
    while (next && Object.hasOwn(state, next)) { if (seen.has(next)) return false; seen.add(next); next = state[next].container; }
    return true;
  });
}
/** Both keyboard and pointer dispatch exactly this reducer; an invalid action is atomic. */
export function reducePlacement(state: PlacementState, action: PlacementAction, views: readonly PlacementView[], containers: readonly PlacementContainer[]): PlacementState {
  const view = views.find(view => view.id === action.id);
  const previous = state[action.id] ?? { container: view?.home ?? '', hidden: false };
  const next = { container: action.container ?? previous.container, hidden: action.hidden ?? previous.hidden };
  const destination = containers.find(container => container.id === next.container);
  if (!view || !destination || !destination.accepts.includes(view.contract) || typeof next.hidden !== 'boolean') throw new Error('Incompatible view container');
  const visited = new Set([action.id]); let parent: string | undefined = next.container;
  while (parent) {
    if (visited.has(parent)) throw new Error('Cyclic view placement');
    visited.add(parent);
    parent = state[parent]?.container ?? containers.find(container => container.id === parent)?.parent;
  }
  return { ...state, [action.id]: { container: next.container, hidden: next.hidden } };
}
export function createPlacementStore(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const cache = new Map<string, PlacementState>(); const listeners = new Set<() => void>(); let diagnostic = '';
  const key = (project?: string) => project ? `${PLACEMENT_KEY}.project.${encodeURIComponent(project)}` : PLACEMENT_KEY;
  const read = (project?: string): PlacementState => {
    const name = key(project);
    try {
      const raw = storage.getItem(name); if (raw === null) return {};
      if (raw.length > 65536) throw new Error('Oversized placement');
      const record = JSON.parse(raw);
      if (record?.schemaVersion !== 1 || !validatePlacements(record.placements)) throw new Error('Invalid placement');
      cache.set(name, record.placements); return record.placements;
    } catch { diagnostic = 'Invalid placement preferences: using the last valid layout. Stored data is retained.'; return cache.get(name) ?? {}; }
  };
  const write = (state: PlacementState, project?: string) => {
    const encoded = JSON.stringify({ schemaVersion: 1, placements: state });
    if (!validatePlacements(state) || encoded.length > 65536) throw new Error('Placement limit exceeded');
    storage.setItem(key(project), encoded); cache.set(key(project), state); listeners.forEach(listener => listener());
  };
  return {
    read(project?: string) { return structuredClone({ ...read(), ...(project ? read(project) : {}) }); },
    dispatch(action: PlacementAction, views: readonly PlacementView[], containers: readonly PlacementContainer[], project?: string) {
      const effective = { ...read(), ...(project ? read(project) : {}) };
      const next = reducePlacement(effective, action, views, containers);
      write({ ...read(project), [action.id]: next[action.id] }, project);
    },
    reset(project?: string) { write({}, project); },
    restore(views: readonly PlacementView[], project?: string) {
      const next = { ...read(project) };
      for (const view of views) next[view.id] = { container: view.home, hidden: false };
      write(next, project);
    },
    diagnostic: () => diagnostic,
    refresh() { listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
