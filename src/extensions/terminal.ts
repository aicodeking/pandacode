/** JSON-only Terminal metadata/actions. PTY content, input and ownership are not delegated. */
import { validateContract } from './contracts.ts';
export type TerminalPresentation = Readonly<{ contractVersion: 1; context: string; group: string; project: string; session: string; revision: number; selected: string; focused: string; visible: boolean; busy: boolean; tabs: readonly Readonly<{ id: string; title: string; ready: boolean; exited: boolean }>[] }>;
export type TerminalAction = Readonly<{ contractVersion: 1; context: string; group: string; project: string; session: string; revision: number; tab: string; controlId: 'new' | 'select' | 'close' | 'minimize'; requestId: string }>;
export type TerminalAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type TerminalAuthority = { owner: string; active: boolean; granted: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotTerminal(props: TerminalPresentation): TerminalPresentation {
  if (!validateContract('terminalPresentation', props).ok) throw Error('Invalid Terminal presentation');
  return freeze(structuredClone(props));
}
export function createTerminalPresentation(props: TerminalPresentation, owner: string, current: () => TerminalPresentation, authority: () => TerminalAuthority, dispatch: (action: TerminalAction) => void, applied = new Set<string>()) {
  const captured = snapshotTerminal(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): TerminalAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('terminalAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as TerminalAction, live = current();
    if ((['context', 'group', 'project', 'session', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy) return { ok: false, reason: 'Busy' };
    if (['select', 'close'].includes(action.controlId) ? !captured.tabs.some(tab => tab.id === action.tab) : action.tab !== '') return { ok: false, reason: 'InvalidArguments' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
