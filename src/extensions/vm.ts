/** Captured VM metadata and actions; native connections, frames and input stay host-owned. */
import { validateContract } from './contracts.ts';
export type VmControl = 'select' | 'new' | 'delete' | 'setup' | 'desktop' | 'power' | 'suspend' | 'input' | 'share';
export type VmPresentation = Readonly<{ contractVersion: 1; context: string; project: string; session: string; machine: string; connection: string; platform: 'local' | 'cloud' | 'none'; revision: number; visible: boolean; busy: boolean; loading: boolean; error: string; truncated: boolean; share: boolean; machines: readonly Readonly<{ id: string; connection: string; name: string; detail: string; platform: 'local' | 'cloud'; running: boolean }>[]; controls: readonly Readonly<{ id: VmControl; enabled: boolean; reason: string; values: readonly string[] }>[] }>;
export type VmAction = Readonly<{ contractVersion: 1; context: string; project: string; session: string; machine: string; connection: string; platform: VmPresentation['platform']; revision: number; controlId: VmControl; value: string; requestId: string }>;
export type VmAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type VmAuthority = { owner: string; active: boolean; granted: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotVm(props: VmPresentation): VmPresentation {
  if (!validateContract('vmPresentation', props).ok) throw Error('Invalid VM presentation');
  return freeze(structuredClone(props));
}
export function createVmPresentation(props: VmPresentation, owner: string, current: () => VmPresentation, authority: () => VmAuthority, dispatch: (action: VmAction) => void, applied = new Set<string>()) {
  const captured = snapshotVm(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): VmAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('vmAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as VmAction, live = current();
    if ((['context', 'project', 'session', 'machine', 'connection', 'platform', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy || live.loading) return { ok: false, reason: 'Busy' };
    const control = live.controls.find(control => control.id === action.controlId);
    if (!control?.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (control.values.length ? !control.values.includes(action.value) : action.value !== '') return { ok: false, reason: 'InvalidArguments' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
