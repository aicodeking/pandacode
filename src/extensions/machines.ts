/** JSON-only captured execution target and machine coordination admission; remote starts, pairing,
 * link/access consent, owner placement and native remote policy stay in the host. */
import { validateContract } from './contracts.ts';
export type MachinesControl = 'computer-menu' | 'target-local' | 'target-device' | 'target-setup' | 'reconnect' | 'start-retry' | 'start-dismiss' | 'behind-cancel' | 'link-open' | 'link-decline' | 'link-cancel' | 'lineage-open' | 'lineage-stop' | 'stop-all';
export type MachinesPending = 'none' | 'checking' | 'starting' | 'reconnecting' | 'error';
export type MachinesPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; host: string; revision: number; mode: 'none' | 'choice' | 'task'; visible: boolean; busy: boolean; pending: MachinesPending; behind: boolean; linking: boolean; offline: boolean; hostOffline: boolean; missing: boolean; signedIn: boolean; orchestration: boolean; requests: number; threads: number; running: number; label: string; truncated: boolean; controls: readonly Readonly<{ id: string; controlId: MachinesControl; resource: string; enabled: boolean }>[] }>;
export type MachinesAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; host: string; revision: number; control: string; resource: string; controlId: MachinesControl; requestId: string }>;
export type MachinesAuthority = { owner: string; active: boolean; granted: boolean; machineControl: boolean; userChoice: boolean };
export type MachinesAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Choosing where the next message runs, retrying a remote start, answering an agent's link request and
 * stopping a launched thread need separate host-user consent and a fresh host choice. */
export const MACHINES_CONSENT_CONTROLS: readonly MachinesControl[] = ['target-local', 'target-device', 'start-retry', 'link-decline', 'lineage-stop', 'stop-all'];
/** Only these reach the relay or another computer; menus, choices, dialogs and opening a thread work offline. */
export const MACHINES_NETWORK_CONTROLS: readonly MachinesControl[] = ['reconnect', 'start-retry', 'link-decline', 'lineage-stop', 'stop-all'];
/** The open host dialog's own cancel is the only control admitted while the host is busy. */
const CANCELS: Readonly<Partial<Record<MachinesControl, 'behind' | 'linking'>>> = { 'behind-cancel': 'behind', 'link-cancel': 'linking' };
const CAPTURED = ['window', 'context', 'project', 'task', 'host', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotMachines(props: MachinesPresentation): MachinesPresentation {
  if (!validateContract('machinesPresentation', props).ok) throw Error('Invalid machine presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate machine control');
  return freeze(structuredClone(props));
}
export function createMachinesPresentation(props: MachinesPresentation, owner: string, current: () => MachinesPresentation, authority: () => MachinesAuthority, dispatch: (action: MachinesAction) => void, applied = new Set<string>()) {
  const captured = snapshotMachines(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): MachinesAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('machinesAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as MachinesAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (MACHINES_NETWORK_CONTROLS.includes(action.controlId) && live.offline) return { ok: false, reason: 'Offline' };
    // A pending start, reconnect or open host dialog keeps its target: only that dialog's own cancel may act.
    const cancel = CANCELS[action.controlId], cancelling = Boolean(cancel && live[cancel]);
    if (live.busy && !cancelling) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (MACHINES_CONSENT_CONTROLS.includes(action.controlId) && (!auth.machineControl || !auth.userChoice)) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
