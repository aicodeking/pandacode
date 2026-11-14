/** Design metadata/actions never convey frame, selector, HTML or comment content authority. */
import { validateContract } from './contracts.ts';
export type DesignControl = 'comment' | 'in' | 'out' | 'fit' | 'refresh' | 'pan' | 'select' | 'draft' | 'save' | 'cancel' | 'resolve' | 'reopen' | 'delete' | 'compose';
export type DesignPresentation = Readonly<{ contractVersion: 1; context: string; project: string; session: string; revision: number; selection: string; visible: boolean; busy: boolean; loading: boolean; error: string; commenting: boolean; draft: boolean; artboards: readonly Readonly<{ id: string; revision: string; label: string }>[]; comments: readonly Readonly<{ id: string; revision: string; artboard: string; status: 'open' | 'resolved' }>[]; controls: readonly Readonly<{ id: DesignControl; enabled: boolean }>[] }>;
export type DesignAction = Readonly<{ contractVersion: 1; context: string; project: string; session: string; revision: number; selection: string; artboard: string; comment: string; resourceRevision: string; controlId: DesignControl; value: string; x: number; y: number; requestId: string }>;
export type DesignAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type DesignAuthority = { owner: string; active: boolean; granted: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotDesign(props: DesignPresentation): DesignPresentation {
  if (!validateContract('designPresentation', props).ok) throw Error('Invalid Design presentation');
  return freeze(structuredClone(props));
}
export function createDesignPresentation(props: DesignPresentation, owner: string, current: () => DesignPresentation, authority: () => DesignAuthority, dispatch: (action: DesignAction) => void, applied = new Set<string>()) {
  const captured = snapshotDesign(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): DesignAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('designAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as DesignAction, live = current();
    if ((['context', 'project', 'session', 'revision', 'selection'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy || live.loading) return { ok: false, reason: 'Busy' };
    if (!live.controls.find(control => control.id === action.controlId)?.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (['resolve', 'reopen', 'delete'].includes(action.controlId)) {
      const target = captured.comments.find(c => c.id === action.comment), now = live.comments.find(c => c.id === action.comment);
      if (!target || !now || target.artboard !== action.artboard || now.artboard !== action.artboard || target.revision !== action.resourceRevision || now.revision !== action.resourceRevision) return { ok: false, reason: 'StaleContext' };
      if (action.controlId === 'resolve' && now.status !== 'open' || action.controlId === 'reopen' && now.status !== 'resolved') return { ok: false, reason: 'UnsupportedCapability' };
    } else if (action.controlId === 'select') {
      const target = captured.artboards.find(b => b.id === action.artboard), now = live.artboards.find(b => b.id === action.artboard);
      if (action.comment || !target || !now || target.revision !== action.resourceRevision || now.revision !== action.resourceRevision) return { ok: false, reason: 'StaleContext' };
    } else if (action.artboard || action.comment || action.resourceRevision) return { ok: false, reason: 'InvalidArguments' };
    if (action.controlId === 'pan' ? !['left', 'right', 'up', 'down'].includes(action.value) : action.value !== '') return { ok: false, reason: 'InvalidArguments' };
    if (action.controlId !== 'select' && (action.x !== 0 || action.y !== 0)) return { ok: false, reason: 'InvalidArguments' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
