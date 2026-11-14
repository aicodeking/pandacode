/** JSON-only captured action dock and team progress admission; placement, motion, team state, workers, approvals and
 * Stop stay in the host. */
import { validateContract } from './contracts.ts';
import { DOCK_CONTROLS, DOCK_PINNED_CONTROLS, DOCK_PROTECTED, TEAM_PARTS, TEAM_PINNED_PARTS, type DockGroupId } from './surfaces.ts';
export type DockControl = typeof DOCK_CONTROLS[number][0] | 'team-toggle' | 'team-open' | 'worker-open' | 'workers-more';
export type DockWorkerStatus = 'queued' | 'running' | 'waiting' | 'parked' | 'completed' | 'failed' | 'stopped' | 'paused' | 'skipped';
export type DockPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; team: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; row: boolean; flyout: boolean;
  progress: boolean; status: 'none' | 'ready' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'interrupted';
  running: number; attention: number; failed: number; total: number;
  groups: readonly Readonly<{ id: DockGroupId; shown: boolean }>[];
  workers: readonly Readonly<{ id: string; status: DockWorkerStatus; attention: boolean }>[];
  controls: readonly Readonly<{ id: string; controlId: DockControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type DockAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; team: string; revision: number; control: string; controlId: DockControl; resource: string; requestId: string }>;
export type DockAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type DockAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Running the project's script starts a process: it runs only after a fresh host user choice. */
export const DOCK_ENTRY_CONTROLS: readonly DockControl[] = ['run'];
/** Controls of the open task's team: they need a team in both snapshots, and the captured one. */
export const TEAM_CONTROLS: readonly DockControl[] = ['team-toggle', 'team-open', 'worker-open', 'workers-more'];

/** One explicit entry per member of the ledger's `panda.agents` family, plus the flyout and status group the dock
 * names. Each entry lists its public locations, the operations it supports and the reason for each it does not;
 * members led by another task carry that task. */
export type DockRegistryEntry = Readonly<{ member: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; reason?: string; lead?: string }>;
export const DOCK_REGISTRY: readonly DockRegistryEntry[] = Object.freeze([
  { member: 'dock', locations: ['panda.actionDock', 'panda.actionDock.controls', 'panda.actionDock.actions', 'panda.actionDock.protected'], controls: DOCK_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'none', reason: `Dock items have no context menu of their own; contributed dock actions are panda.actionDock.actions. ${Object.entries(DOCK_PINNED_CONTROLS).map(([id, why]) => `${id}: ${why}`).join(' ')}` },
  { member: 'flyout', locations: ['panda.agents.actions'], controls: ['agents'], order: true, hide: true, actions: true, context: 'none', reason: 'The flyout opens and pins through the original Agents item; its team, subagent and lineage panels are T56F.' },
  { member: 'status', locations: ['panda.actionDock', 'panda.status.items'], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T56G', reason: 'The status group stays last in the dock; its update prompt and contributed status items are the status family (T56G).' },
  { member: 'team', locations: ['panda.team.controls', 'panda.team.actions', 'panda.team.context'], controls: [...TEAM_PARTS.map(([id]) => id), 'team-toggle', 'team-open', 'worker-open', 'workers-more'], order: true, hide: true, actions: true, context: 'panda.team.context', reason: `${Object.entries(TEAM_PINNED_PARTS).map(([id, why]) => `${id}: ${why}`).join(' ')} ${DOCK_PROTECTED.slice(0, 4).map(([, label, why]) => `${label}: ${why}`).join(' ')}` },
  { member: 'subagents', locations: [], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T56F', reason: 'Subagent roster and lineage views are assigned to T56F.' },
  { member: 'profiles', locations: [], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T56F', reason: 'Team profile roster views are assigned to T56F.' },
  { member: 'widget', locations: [], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T57', reason: 'The running agents widget is an auxiliary-window lifecycle assigned to T57.' },
  { member: 'usage', locations: [], controls: [], order: false, hide: false, actions: false, context: 'none', lead: 'T56G', reason: 'Cached harness usage is assigned to T56G.' },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'team', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotDock(props: DockPresentation): DockPresentation {
  if (!validateContract('dockPresentation', props).ok) throw Error('Invalid action dock presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length || new Set(props.workers.map(worker => worker.id)).size !== props.workers.length) throw Error('Duplicate action dock handle');
  // Progress is permissioned: without it no status, count or worker crosses the boundary.
  if (!props.progress && (props.status !== 'none' || props.workers.length || props.running || props.attention || props.failed || props.total)) throw Error('Unpermissioned team progress');
  return freeze(structuredClone(props));
}
export function createDockPresentation(props: DockPresentation, owner: string, current: () => DockPresentation, authority: () => DockAuthority, dispatch: (action: DockAction) => void, applied = new Set<string>()) {
  const captured = snapshotDock(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): DockAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('dockAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as DockAction, live = current();
    // Switching task, a team change, a new worker or status, a redraw or a hidden dock is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, a pending host choice or a thread switch keeps its input: nothing acts until it ends.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    // A team control acts on the captured team only: never on another task's team or one that has gone.
    if (TEAM_CONTROLS.includes(action.controlId) && (!captured.team || action.resource === '')) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (DOCK_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
