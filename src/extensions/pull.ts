/** JSON-only captured Pull request admission; original merge confirmation and GitHub policy stay in the host. */
import { validateContract } from './contracts.ts';
export type PullControl = 'overview' | 'commits' | 'files' | 'checks' | 'check' | 'review' | 'conflicts' | 'link' | 'file' | 'refresh' | 'unlink' | 'merge-start' | 'merge-method' | 'merge-cancel';
export type PullSection = 'overview' | 'commits' | 'files';
export type PullFile = Readonly<{ id: string; path: string; additions: number; deletions: number; expanded: boolean; loading: boolean; error: boolean }>;
export type PullPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; repository: string; pull: string; base: string; head: string; section: PullSection; revision: number; visible: boolean; loading: boolean; busy: boolean; offline: boolean; error: boolean; state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown'; merge: 'unavailable' | 'idle' | 'confirm' | 'merging'; method: 'squash' | 'merge' | 'rebase'; checks: boolean; title: string; truncated: boolean; files: readonly PullFile[]; controls: readonly Readonly<{ id: string; controlId: PullControl; resource: string; enabled: boolean }>[] }>;
export type PullAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; repository: string; pull: string; base: string; head: string; section: PullSection; revision: number; control: string; resource: string; controlId: PullControl; requestId: string }>;
export type PullAuthority = { owner: string; active: boolean; granted: boolean; pullControl: boolean; userChoice: boolean };
export type PullAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Task-link and merge-state changes need separate host-user consent; external entries a fresh host choice. */
export const PULL_CONSENT_CONTROLS: readonly PullControl[] = ['unlink', 'merge-start', 'merge-cancel'];
export const PULL_ENTRY_CONTROLS: readonly PullControl[] = ['link', 'check', 'review'];
const CAPTURED = ['window', 'context', 'project', 'task', 'repository', 'pull', 'base', 'head', 'section', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotPull(props: PullPresentation): PullPresentation {
  if (!validateContract('pullPresentation', props).ok) throw Error('Invalid Pull request presentation');
  if (new Set(props.files.map(file => file.id)).size !== props.files.length || new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate Pull request resource');
  return freeze(structuredClone(props));
}
export function createPullPresentation(props: PullPresentation, owner: string, current: () => PullPresentation, authority: () => PullAuthority, dispatch: (action: PullAction) => void, applied = new Set<string>()) {
  const captured = snapshotPull(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): PullAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('pullAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as PullAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.offline) return { ok: false, reason: 'Offline' };
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (PULL_CONSENT_CONTROLS.includes(action.controlId) && !auth.pullControl || PULL_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
