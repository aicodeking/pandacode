/** Captured JSON-only Simulator contract. Frames, input and connections remain host-owned. */
import { validateContract } from './contracts.ts';
export type SimulatorControl = 'device' | 'pose' | 'finish' | 'appearance' | 'power' | 'back' | 'recents' | 'reset' | 'home' | 'lock' | 'capture' | 'copy-axe' | 'add-duo' | 'android-setup';
export type SimulatorPresentation = Readonly<{ contractVersion: 1; context: string; project: string; session: string; device: string; platform: 'ios' | 'android' | 'none'; revision: number; visible: boolean; busy: boolean; loading: boolean; error: string; truncated: boolean; pose: string; finish: string; appearance: 'light' | 'dark'; devices: readonly Readonly<{ id: string; name: string; runtime: string; platform: 'ios' | 'android'; state: string }>[]; controls: readonly Readonly<{ id: SimulatorControl; enabled: boolean; reason: string; values: readonly string[] }>[] }>;
export type SimulatorAction = Readonly<{ contractVersion: 1; context: string; project: string; session: string; device: string; platform: SimulatorPresentation['platform']; revision: number; controlId: SimulatorControl; value: string; requestId: string }>;
export type SimulatorAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type SimulatorAuthority = { owner: string; active: boolean; granted: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotSimulator(props: SimulatorPresentation): SimulatorPresentation {
  if (!validateContract('simulatorPresentation', props).ok) throw Error('Invalid Simulator presentation');
  return freeze(structuredClone(props));
}
export function createSimulatorPresentation(props: SimulatorPresentation, owner: string, current: () => SimulatorPresentation, authority: () => SimulatorAuthority, dispatch: (action: SimulatorAction) => void, applied = new Set<string>()) {
  const captured = snapshotSimulator(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): SimulatorAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('simulatorAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as SimulatorAction, live = current();
    if ((['context', 'project', 'session', 'device', 'platform', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy || live.loading) return { ok: false, reason: 'Busy' };
    if (live.error && !['reset', 'android-setup', 'copy-axe', 'add-duo'].includes(action.controlId)) return { ok: false, reason: 'UnsupportedCapability' };
    const control = live.controls.find(control => control.id === action.controlId);
    if (!control?.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (control.values.length ? !control.values.includes(action.value) : action.value !== '') return { ok: false, reason: 'InvalidArguments' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
