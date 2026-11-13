/** Captured Search metadata/actions. No matching source content or query backend. */
import { validateContract } from './contracts.ts';
export type SearchResult = Readonly<{ id: string; path: string; line: number; collapsed: boolean }>;
export type SearchPresentation = Readonly<{ contractVersion: 1; context: string; project: string; revision: number; query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; loading: boolean; error: boolean; visible: boolean; selected: string; results: readonly SearchResult[]; next: string; truncated: boolean }>;
export type SearchAction = Readonly<{ contractVersion: 1; context: string; project: string; revision: number; query: string; resultId: string; controlId: 'query' | 'submit' | 'matchCase' | 'wholeWord' | 'regex' | 'open' | 'collapse'; value: string; requestId: string }>;
export type SearchAuthority = { owner: string; granted: boolean; metadata: boolean; active: boolean };
export type SearchAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotSearch(props: SearchPresentation): SearchPresentation {
  if (!validateContract('searchPresentation', props).ok) throw Error('Invalid Search presentation');
  return freeze(structuredClone(props));
}
export function createSearchPresentation(props: SearchPresentation, owner: string, current: () => SearchPresentation, authority: () => SearchAuthority, dispatch: (action: SearchAction) => void, applied = new Set<string>()) {
  const captured = snapshotSearch(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): SearchAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('searchAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as SearchAction, live = current();
    if (action.context !== captured.context || live.context !== captured.context || action.project !== captured.project || live.project !== captured.project || action.revision !== captured.revision || live.revision !== captured.revision || action.query !== captured.query || live.query !== captured.query || !live.visible || !captured.visible) return { ok: false, reason: 'StaleContext' };
    if (action.resultId) {
      if (!auth.metadata) return { ok: false, reason: 'PermissionDenied' };
      if (!captured.results.some(item => item.id === action.resultId) || !live.results.some(item => item.id === action.resultId)) return { ok: false, reason: 'StaleContext' };
      if (!['open', 'collapse'].includes(action.controlId) || action.value) return { ok: false, reason: 'InvalidArguments' };
    } else if (['open', 'collapse'].includes(action.controlId) || action.controlId !== 'query' && action.value) return { ok: false, reason: 'InvalidArguments' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
