/** Closed Changes recipe admission; JSON only, never Git or DOM authority. */
import { validateContract } from './contracts.ts';
export type ChangesControl = Readonly<{ id: string; label: string; enabled: boolean; selected?: boolean }>;
export type ChangesFile = Readonly<{ id: string; diffId: string; revision: number; staged: boolean; load: 'idle' | 'loading' | 'loaded' | 'error'; hunks: readonly Readonly<{ id: string; revision: number }>[]; controls: readonly ChangesControl[] }>;
export type ChangesPresentation = Readonly<{ contractVersion: 1; context: string; repository: string; revision: number; scope: 'all' | 'staged' | 'unstaged'; selected: string; focused: string; loading: boolean; error: boolean; offline: boolean; visible: boolean; pending: boolean; truncated: boolean; files: readonly ChangesFile[]; controls: readonly ChangesControl[] }>;
export type ChangesAction = Readonly<{ contractVersion: 1; context: string; repository: string; revision: number; fileId: string; diffId: string; fileRevision: number; hunkId: string; hunkRevision: number; controlId: string; requestId: string }>;
export type ChangesResult = { ok: true } | { ok: false; reason: 'InvalidArguments' | 'UnsupportedCapability' | 'StaleContext' | 'WrongOwner' | 'PermissionDenied' | 'Revoked' | 'Busy' | 'AlreadyApplied' };
export type ChangesAuthority = { owner: string; granted: boolean; active: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotChangesPresentation(props: ChangesPresentation): ChangesPresentation {
  if (!validateContract('changesPresentation', props).ok) throw Error('Invalid Changes presentation');
  return freeze(structuredClone(props));
}
export function createChangesPresentation(props: ChangesPresentation, owner: string, current: () => ChangesPresentation, authority: () => ChangesAuthority, dispatch: (action: ChangesAction) => void, applied = new Set<string>()) {
  const captured = snapshotChangesPresentation(props); let disposed = false;
  return {
    props: captured,
    dispatch(input: unknown): ChangesResult {
      const auth = authority();
      if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
      if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
      if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
      if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
      if (!validateContract('changesAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
      const action = input as ChangesAction, live = current();
      if (!action.hunkId && action.hunkRevision) return { ok: false, reason: 'InvalidArguments' };
      if (!validateContract('changesPresentation', live).ok || action.context !== captured.context || live.context !== captured.context || action.repository !== captured.repository || live.repository !== captured.repository || action.revision !== captured.revision || live.revision !== captured.revision || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
      let controls = captured.controls, latest = live.controls;
      if (action.fileId) {
        const file = captured.files.find(file => file.id === action.fileId), now = live.files.find(file => file.id === action.fileId);
        if (!file || !now || file.diffId !== action.diffId || now.diffId !== action.diffId || file.revision !== action.fileRevision || now.revision !== action.fileRevision) return { ok: false, reason: 'StaleContext' };
        if (action.hunkId && (!file.hunks.some(hunk => hunk.id === action.hunkId && hunk.revision === action.hunkRevision) || !now.hunks.some(hunk => hunk.id === action.hunkId && hunk.revision === action.hunkRevision))) return { ok: false, reason: 'StaleContext' };
        controls = file.controls; latest = now.controls;
      } else if (action.diffId || action.fileRevision || action.hunkId || action.hunkRevision) return { ok: false, reason: 'InvalidArguments' };
      // The original viewer has no hunk mutation handler. Never widen a hunk request to a file.
      if (action.hunkId || !controls.some(control => control.id === action.controlId && control.enabled) || !latest.some(control => control.id === action.controlId && control.enabled)) return { ok: false, reason: 'UnsupportedCapability' };
      if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
      if (live.pending) return { ok: false, reason: 'Busy' };
      if (live.offline || live.loading || live.error) return { ok: false, reason: 'UnsupportedCapability' };
      if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
      applied.add(action.requestId);
      dispatch(freeze(structuredClone(action))); return { ok: true };
    },
    dispose() { disposed = true; },
  };
}
