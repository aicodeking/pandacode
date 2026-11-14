/** Captured Board admission; host task handlers retain lifecycle ownership. */
import { validateContract } from './contracts.ts';
export type BoardStage = 'pending' | 'in_progress' | 'review' | 'completed';
export type BoardControl = 'open-project' | 'add' | 'filter' | 'import' | 'open' | 'close' | 'edit' | 'start' | 'retry' | 'settle' | 'reopen';
export type BoardRow = Readonly<{ id: string; project: string; revision: number; stage: BoardStage; title: string; running: boolean; busy: boolean; archived: boolean }>;
export type BoardPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; filter: string; revision: number; visible: boolean; loading: boolean; busy: boolean; detail: boolean; importable: boolean; truncated: boolean; rows: readonly BoardRow[] }>;
export type BoardAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; filter: string; revision: number; row: string; rowProject: string; rowRevision: number; stage: BoardStage | ''; controlId: BoardControl; requestId: string }>;
export type BoardAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type BoardAuthority = { owner: string; active: boolean; granted: boolean; taskControl: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotBoard(props: BoardPresentation): BoardPresentation {
  if (!validateContract('boardPresentation', props).ok) throw Error('Invalid Board presentation');
  if (new Set(props.rows.map(row => row.id)).size !== props.rows.length) throw Error('Duplicate Board row');
  return freeze(structuredClone(props));
}
export function createBoardPresentation(props: BoardPresentation, owner: string, current: () => BoardPresentation, authority: () => BoardAuthority, dispatch: (action: BoardAction) => void, applied = new Set<string>()) {
  const captured = snapshotBoard(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): BoardAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('boardAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as BoardAction, live = current();
    if ((['window', 'context', 'project', 'task', 'filter', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy || live.loading) return { ok: false, reason: 'Busy' };
    const rowAction = ['open', 'edit', 'start', 'retry', 'settle', 'reopen'].includes(action.controlId);
    if (rowAction) {
      const row = captured.rows.find(row => row.id === action.row), now = live.rows.find(row => row.id === action.row);
      if (!row || !now || [row, now].some(row => row.project !== action.rowProject || row.revision !== action.rowRevision || row.stage !== action.stage)) return { ok: false, reason: 'StaleContext' };
      if (['edit', 'settle', 'reopen'].includes(action.controlId) && (!live.detail || live.task !== row.id)) return { ok: false, reason: 'StaleContext' };
      if (action.controlId !== 'open' && (now.running || now.busy)) return { ok: false, reason: 'Busy' };
      if ((action.controlId === 'start' && (now.stage !== 'pending' || now.archived)) || (action.controlId === 'retry' && (now.stage !== 'in_progress' || now.archived)) || (action.controlId === 'settle' && now.stage !== 'review') || (action.controlId === 'reopen' && now.stage !== 'completed') || (action.controlId === 'edit' && now.archived)) return { ok: false, reason: 'UnsupportedCapability' };
    } else if (action.row || action.rowProject || action.rowRevision !== 0 || action.stage) return { ok: false, reason: 'InvalidArguments' };
    if (action.controlId === 'import' && !live.importable || action.controlId === 'close' && !live.detail) return { ok: false, reason: 'UnsupportedCapability' };
    if (['start', 'retry', 'settle', 'reopen'].includes(action.controlId) && !auth.taskControl) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
