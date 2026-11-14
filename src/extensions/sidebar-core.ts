/** JSON-only captured sidebar admission; grouping, sorting, selection and every task handler stay in the host. */
import { validateContract } from './contracts.ts';
import { SIDEBAR_FIXED_SECTIONS, SIDEBAR_HEADER_CONTROLS, SIDEBAR_PINNED_SECTIONS, SIDEBAR_PROJECT_CONTROLS, SIDEBAR_PROTECTED, SIDEBAR_ROW_PARTS, SIDEBAR_SECTIONS, type SidebarSectionId } from './surfaces.ts';
export type SidebarControl = 'new-task' | 'new-chat' | 'search' | 'project-filter' | 'sort' | 'import' | 'open-project' | 'filter-clear' | 'toggle-section' | 'completed-more' | 'folder-more' | 'select-task' | 'task-menu' | 'settle' | 'reopen';
export type SidebarPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; focused: boolean; busy: boolean; filtering: boolean; safeMode: boolean;
  group: 'project' | 'flat'; taskSort: 'manual' | 'recent' | 'created'; projectSort: 'recent' | 'added' | 'name' | 'manual';
  sections: readonly Readonly<{ id: SidebarSectionId; pinned: boolean; hidden: boolean; collapsed: boolean; count: number }>[];
  rows: readonly Readonly<{ id: string; section: SidebarSectionId; selected: boolean; pinned: boolean; unread: boolean; active: boolean; settled: boolean }>[];
  controls: readonly Readonly<{ id: string; controlId: SidebarControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type SidebarAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: SidebarControl; resource: string; requestId: string }>;
export type SidebarAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type SidebarAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Task creation, a saved collapse preference and a stage change run only after a fresh host user choice. */
export const SIDEBAR_ENTRY_CONTROLS: readonly SidebarControl[] = ['new-task', 'new-chat', 'toggle-section', 'settle', 'reopen'];
/** Controls that act on one task row: the resource is that row, never the selected task. */
export const SIDEBAR_ROW_CONTROLS: readonly SidebarControl[] = ['select-task', 'task-menu', 'settle', 'reopen'];

/** One explicit entry per member of the ledger's `panda.sidebar` family, plus the sort/view row it names. Each
 * entry lists its public locations, the operations it supports and the reason for each one it does not. */
export type SidebarRegistryEntry = Readonly<{ member: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; reason?: string; lead?: string }>;
export const SIDEBAR_REGISTRY: readonly SidebarRegistryEntry[] = Object.freeze([
  { member: 'header', locations: ['panda.sidebar.header', 'panda.sidebar.actions'], controls: SIDEBAR_HEADER_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'none' },
  { member: 'footer', locations: ['panda.sidebar.footer'], controls: ['support', 'usage', 'settings', 'star', 'theme'], order: true, hide: true, actions: false, context: 'none', reason: 'Existing M1 footer adapter: contributed buttons, menus and dialogs plus core order/visibility; its core buttons are public commands, not captured row actions.' },
  { member: 'projects', locations: ['panda.sidebar.projects'], controls: SIDEBAR_PROJECT_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'none' },
  { member: 'filter', locations: ['panda.sidebar', 'panda.sidebar.protected'], controls: ['filter-clear'], order: true, hide: false, actions: true, context: 'none', reason: SIDEBAR_PROTECTED[0][2] },
  { member: 'sort', locations: ['panda.sidebar.projects'], controls: ['sort'], order: true, hide: true, actions: true, context: 'none', reason: 'The sort and view menu sets host preferences; its radio rows are one preference each and stay host-drawn.' },
  { member: 'sections', locations: ['panda.sidebar.sections', 'panda.sidebar.rows', 'panda.sidebar.context'], controls: [...SIDEBAR_SECTIONS.map(([id]) => id), ...SIDEBAR_ROW_PARTS.map(([id]) => id)], order: true, hide: true, actions: true, context: 'panda.sidebar.context', reason: [...Object.entries(SIDEBAR_PINNED_SECTIONS), ...Object.entries(SIDEBAR_FIXED_SECTIONS)].map(([id, why]) => `${id}: ${why}`).join(' ') },
  { member: 'project.context', locations: ['panda.sidebar.project.context'], controls: ['new', 'collapse', 'reveal', 'remove'], order: true, hide: true, actions: false, context: 'panda.sidebar.project.context', reason: 'Existing captured project-row menu (projectId and project selection); its rows run the original folder handlers.' },
  { member: 'task.context', locations: ['panda.sidebar.task.context'], controls: ['pin', 'up', 'down', 'beside', 'rename', 'wake', 'unread', 'branch-task', 'copy-branch', 'copy-path', 'copy-id', 'stage', 'delete'], order: true, hide: true, actions: true, context: 'panda.sidebar.task.context', reason: 'Existing captured task-row menu (clicked task, never a later selection); task-menu opens it from a captured action.' },
  { member: 'bots', locations: [], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T56I', reason: 'Bot and shared-channel rows (src/sidebar-bots.ts) are bot/channel objects, not task rows; their dialogs are panda.dialog accessories and the list is assigned to the controls audit.' },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotSidebar(props: SidebarPresentation): SidebarPresentation {
  if (!validateContract('sidebarPresentation', props).ok) throw Error('Invalid sidebar presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length || new Set(props.rows.map(row => row.id)).size !== props.rows.length) throw Error('Duplicate sidebar handle');
  return freeze(structuredClone(props));
}
export function createSidebarPresentation(props: SidebarPresentation, owner: string, current: () => SidebarPresentation, authority: () => SidebarAuthority, dispatch: (action: SidebarAction) => void, applied = new Set<string>()) {
  const captured = snapshotSidebar(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): SidebarAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('sidebarAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as SidebarAction, live = current();
    // Switching task or project, a redraw that changed sections or rows, or a hidden sidebar is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // A drag, a pending reorder, an open host dialog or a pending host choice keeps its input: nothing acts until it ends.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    // A row control acts on a row that is still listed in both snapshots, never on whatever row is selected now.
    if (SIDEBAR_ROW_CONTROLS.includes(action.controlId) && (!captured.rows.some(row => row.id === action.resource) || !live.rows.some(row => row.id === action.resource))) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (SIDEBAR_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
