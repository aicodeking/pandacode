/** JSON-only captured admission for the Workspace view menu, the sidebar Sort and view menu and the Filter projects menu.
 * Switching the view, changing the sort or the tasks per section and filtering by a project run the original handlers in
 * main.ts; project names, paths and the user's search text never cross the boundary. */
import { validateContract } from './contracts.ts';
import { WINDOW_MENUS_ENTRIES, WINDOW_MENUS_PINNED, WINDOW_MENUS_PROTECTED, WINDOW_MENUS_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured control ids (`windowMenusControlId`). */
export const WINDOW_MENUS_CONTROL_IDS = ['view-open', 'sort-set', 'scope-set', 'filter-set'] as const;
export type WindowMenusControl = typeof WINDOW_MENUS_CONTROL_IDS[number];
export type WindowMenusOpen = 'none' | 'view' | 'sort' | 'filter';
/** `view`, `sort` and `filter` are opaque handles of what is in use: the open view, the sort with its count and the
 * project filter. `menu` is the host menu that is open. */
export type WindowMenusPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; view: string; sort: string; filter: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; menu: WindowMenusOpen;
  controls: readonly Readonly<{ id: string; controlId: WindowMenusControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type WindowMenusAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; view: string; sort: string; filter: string; revision: number; control: string; controlId: WindowMenusControl; resource: string; requestId: string }>;
export type WindowMenusAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type WindowMenusAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** The view, the sort, the tasks per section and the project filter are host settings: a package request changes one
 * only after a fresh host user choice bound to the same window state, and it runs the original handler once. */
export const WINDOW_MENUS_CHOICE_CONTROLS: readonly string[] = ['view-open', 'sort-set', 'scope-set', 'filter-set'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check. */
export const WINDOW_MENUS_PROTECTED_CONTROLS = ['view-hide-current', 'sort-reorder', 'project-actions', 'project-remove', 'project-add', 'github-enable'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.menus.workspace-view`, `.sort`, `.project-filter`). */
export type WindowMenusRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const protectedReason = (...ids: string[]) => WINDOW_MENUS_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
const pinnedReason = (location: string) => Object.entries(WINDOW_MENUS_PINNED).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`).join(' ');
const entryIds = (location: keyof typeof WINDOW_MENUS_ENTRIES) => WINDOW_MENUS_ENTRIES[location].map(([id]) => id);
export const WINDOW_MENUS_REGISTRY: readonly WindowMenusRegistryEntry[] = Object.freeze([
  { member: 'panda.menus.workspace-view', source: 'src/main.ts', locations: ['panda.workspace.view.menu', WINDOW_MENUS_PROTECTED_LOCATION], controls: entryIds('panda.workspace.view.menu'), order: true, hide: true, actions: true, context: 'panda.workspace.view.menu', selection: 'workspace-view', reason: `Contributed items, including a contributed main view that opens through the existing view navigation, appear beside Conversation, Board and GitHub, and the other views hide and reorder; the captured context names the window and revision. ${protectedReason('view-current', 'view-change', 'view-github')}` },
  { member: 'panda.menus.sort', source: 'src/main.ts', locations: ['panda.sidebar.sort.menu', WINDOW_MENUS_PROTECTED_LOCATION], controls: entryIds('panda.sidebar.sort.menu'), order: true, hide: true, actions: true, context: 'panda.sidebar.sort.menu', selection: 'sidebar-sort', reason: `Contributed items appear in Sort and view, and the other sorts and counts hide and reorder; the selected sort and count are host settings saved per window. ${pinnedReason('panda.sidebar.sort.menu')} ${protectedReason('sort-selected', 'sort-change')}` },
  { member: 'panda.menus.project-filter', source: 'src/main.ts', locations: ['panda.projects.filter.menu', WINDOW_MENUS_PROTECTED_LOCATION], controls: [], order: false, hide: false, actions: true, context: 'panda.projects.filter.menu', selection: 'project-filter', reason: `Contributed items appear in the searchable Filter projects menu; the projects keep the projects list's order and the selection stays a host setting. ${pinnedReason('panda.projects.filter.menu')} ${protectedReason('filter-selected', 'filter-change', 'filter-project-actions')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'view', 'sort', 'filter', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotWindowMenus(props: WindowMenusPresentation): WindowMenusPresentation {
  if (!validateContract('windowMenusPresentation', props).ok) throw Error('Invalid window menus presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate window menus handle');
  return freeze(structuredClone(props));
}
export function createWindowMenusControls(props: WindowMenusPresentation, owner: string, current: () => WindowMenusPresentation, authority: () => WindowMenusAuthority, dispatch: (action: WindowMenusAction) => void, applied = new Set<string>()) {
  const captured = snapshotWindowMenus(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): WindowMenusAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((WINDOW_MENUS_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('windowMenusAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as WindowMenusAction, live = current();
    // Another view, sort, count or filter, a redraw or a hidden trigger is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open menu, another dialog or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (WINDOW_MENUS_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
