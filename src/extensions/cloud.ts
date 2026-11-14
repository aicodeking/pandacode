/** JSON-only captured cloud machine admission; provisioning, credentials, confirmations and native cloud policy stay in the host. */
import { validateContract } from './contracts.ts';
export type CloudControl = 'target-cloud' | 'target-setup' | 'machine-menu' | 'sync' | 'retry' | 'open' | 'stop' | 'delete' | 'delete-cancel';
export type CloudPending = 'none' | 'sync' | 'retry' | 'open' | 'stop' | 'delete';
export type CloudPresentationStage = 'none' | 'creating' | 'installing' | 'credentials' | 'uploading' | 'ready' | 'running' | 'reconnecting' | 'syncing' | 'stopped' | 'error';
export type CloudPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; machine: string; revision: number; mode: 'none' | 'choice' | 'task'; stage: CloudPresentationStage; visible: boolean; busy: boolean; pending: CloudPending; confirm: boolean; offline: boolean; error: boolean; supported: boolean; targets: number; label: string; truncated: boolean; controls: readonly Readonly<{ id: string; controlId: CloudControl; resource: string; enabled: boolean }>[] }>;
export type CloudAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; machine: string; revision: number; control: string; resource: string; controlId: CloudControl; requestId: string }>;
export type CloudAuthority = { owner: string; active: boolean; granted: boolean; cloudControl: boolean; userChoice: boolean };
export type CloudAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Choosing where the next message runs and every machine operation need separate host-user consent
 * and a fresh host choice; delete also keeps the original confirmation. */
export const CLOUD_CONSENT_CONTROLS: readonly CloudControl[] = ['target-cloud', 'sync', 'retry', 'open', 'stop', 'delete'];
/** Only these reach the provider; choosing a target, setup and the menu work offline. */
export const CLOUD_NETWORK_CONTROLS: readonly CloudControl[] = ['sync', 'retry', 'open', 'stop', 'delete'];
const CAPTURED = ['window', 'context', 'project', 'task', 'provider', 'machine', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotCloud(props: CloudPresentation): CloudPresentation {
  if (!validateContract('cloudPresentation', props).ok) throw Error('Invalid cloud machine presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate cloud machine control');
  return freeze(structuredClone(props));
}
export function createCloudPresentation(props: CloudPresentation, owner: string, current: () => CloudPresentation, authority: () => CloudAuthority, dispatch: (action: CloudAction) => void, applied = new Set<string>()) {
  const captured = snapshotCloud(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): CloudAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('cloudAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as CloudAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (CLOUD_NETWORK_CONTROLS.includes(action.controlId) && live.offline) return { ok: false, reason: 'Offline' };
    // A pending machine action or an open host dialog keeps its target: only the open confirmation's own cancel may act.
    const cancelling = action.controlId === 'delete-cancel' && live.confirm;
    if (live.busy && !cancelling) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (CLOUD_CONSENT_CONTROLS.includes(action.controlId) && (!auth.cloudControl || !auth.userChoice)) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
