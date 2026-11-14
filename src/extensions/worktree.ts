/** JSON-only captured branch/worktree admission; create/switch/cleanup policy and confirmations stay in the host. */
import { validateContract } from './contracts.ts';
export type WorktreeControl = 'branch-menu' | 'switch-default' | 'switch-other' | 'worktree-attach' | 'worktree-new' | 'worktree-merge' | 'worktree-remove' | 'worktree-recreate' | 'settle-task' | 'copy-path' | 'open-pull' | 'open-url' | 'cleanup-cancel';
export type WorktreePending = 'none' | 'switch' | 'create' | 'merge' | 'cleanup' | 'recreate';
export type WorktreePresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; repository: string; branch: string; base: string; worktree: string; revision: number; checkout: 'local' | 'worktree' | 'missing' | 'remote' | 'none'; visible: boolean; loading: boolean; busy: boolean; running: boolean; offline: boolean; error: boolean; detached: boolean; branchName: string; pending: WorktreePending; form: 'none' | 'attach' | 'new'; cleanup: 'none' | 'complete' | 'remove'; linked: Readonly<{ issue: boolean; pull: boolean }>; truncated: boolean; controls: readonly Readonly<{ id: string; controlId: WorktreeControl; resource: string; enabled: boolean }>[] }>;
export type WorktreeAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; repository: string; branch: string; base: string; worktree: string; revision: number; control: string; resource: string; controlId: WorktreeControl; requestId: string }>;
export type WorktreeAuthority = { owner: string; active: boolean; granted: boolean; branchControl: boolean; userChoice: boolean };
export type WorktreeAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Checkout, task-stage and cleanup changes need separate host-user consent. */
export const WORKTREE_CONSENT_CONTROLS: readonly WorktreeControl[] = ['switch-default', 'worktree-merge', 'worktree-remove', 'worktree-recreate', 'settle-task', 'cleanup-cancel'];
/** Direct mutations, clipboard and external entries also run only after a fresh host user choice. */
export const WORKTREE_ENTRY_CONTROLS: readonly WorktreeControl[] = ['switch-default', 'worktree-merge', 'worktree-recreate', 'settle-task', 'copy-path', 'open-url'];
/** Only these reach the network; local git controls keep working offline. */
export const WORKTREE_NETWORK_CONTROLS: readonly WorktreeControl[] = ['open-pull', 'open-url'];
const CAPTURED = ['window', 'context', 'project', 'task', 'repository', 'branch', 'base', 'worktree', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotWorktree(props: WorktreePresentation): WorktreePresentation {
  if (!validateContract('worktreePresentation', props).ok) throw Error('Invalid branch and worktree presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate branch and worktree control');
  return freeze(structuredClone(props));
}
export function createWorktreePresentation(props: WorktreePresentation, owner: string, current: () => WorktreePresentation, authority: () => WorktreeAuthority, dispatch: (action: WorktreeAction) => void, applied = new Set<string>()) {
  const captured = snapshotWorktree(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): WorktreeAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('worktreeAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as WorktreeAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (WORKTREE_NETWORK_CONTROLS.includes(action.controlId) && live.offline) return { ok: false, reason: 'Offline' };
    // An open host dialog keeps its pending inputs: only its own cancel may act while it is up.
    const cancelling = action.controlId === 'cleanup-cancel' && live.cleanup !== 'none' && live.pending === 'none';
    if (live.busy && !cancelling) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (WORKTREE_CONSENT_CONTROLS.includes(action.controlId) && !auth.branchControl || WORKTREE_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
