/** Captured side-conversation admission. No draft, transcript or permission payload. */
import { validateContract } from './contracts.ts';
export type BtwControl = 'new' | 'open' | 'close' | 'focus' | 'send' | 'steer' | 'stop' | 'model' | 'queue-edit' | 'queue-save' | 'queue-cancel' | 'queue-remove' | 'queue-send' | 'queue-steer' | 'queue-resume' | 'insert';
export type BtwPresentation = Readonly<{ contractVersion: 1; window: string; context: string; project: string; main: string; side: string; revision: number; visible: boolean; busy: boolean; running: boolean; waiting: boolean; draft: boolean; messages: readonly string[]; queues: readonly string[]; controls: readonly BtwControl[] }>;
export type BtwAction = Readonly<{ contractVersion: 1; window: string; context: string; project: string; main: string; side: string; revision: number; controlId: BtwControl; resource: string; requestId: string }>;
export type BtwAuthority = { owner: string; active: boolean; content: boolean; taskControl: boolean };
export type BtwAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotBtw(props: BtwPresentation): BtwPresentation {
  if (!validateContract('btwPresentation', props).ok || props.main === props.side || !props.main) throw Error('Invalid BTW presentation');
  return freeze(structuredClone(props));
}
export function createBtwPresentation(props: BtwPresentation, owner: string, current: () => BtwPresentation, authority: () => BtwAuthority, dispatch: (action: BtwAction) => void, applied = new Set<string>()) {
  const captured = snapshotBtw(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): BtwAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('btwAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as BtwAction, live = current();
    if ((['window', 'context', 'project', 'main', 'side', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible || live.main === live.side) return { ok: false, reason: 'StaleContext' };
    if (!live.controls.includes(action.controlId) || !captured.controls.includes(action.controlId)) return { ok: false, reason: 'UnsupportedCapability' };
    if (['send', 'steer', 'stop', 'queue-save', 'queue-remove', 'queue-send', 'queue-steer', 'queue-resume', 'insert'].includes(action.controlId) && !auth.taskControl || action.controlId === 'insert' && !auth.content) return { ok: false, reason: 'PermissionDenied' };
    const resources = action.controlId === 'insert' ? 'messages' : action.controlId.startsWith('queue-') && action.controlId !== 'queue-resume' ? 'queues' : undefined;
    if (resources ? !captured[resources].includes(action.resource) || !live[resources].includes(action.resource) : action.resource !== '') return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy) return { ok: false, reason: 'Busy' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
