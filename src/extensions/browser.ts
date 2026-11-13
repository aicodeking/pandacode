/** JSON-only Browser presentation; guest, navigation and attachments stay host-owned. */
import { validateContract } from './contracts.ts';
export type BrowserPresentation = Readonly<{ contractVersion: 1; context: string; guest: string; project: string; session: string; revision: number; url: string; home: boolean; loading: boolean; busy: boolean; watching: boolean; visible: boolean; embedded: boolean; canGoBack: boolean; canGoForward: boolean; picking: boolean; picked: Readonly<{ tag: string; text: string }> }>;
export type BrowserAction = Readonly<{ contractVersion: 1; context: string; guest: string; project: string; session: string; revision: number; controlId: 'navigate' | 'back' | 'forward' | 'reload' | 'pick' | 'capture' | 'test' | 'close' | 'home' | 'watch-jev' | 'refresh-ports'; value: string; requestId: string }>;
export type BrowserAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type BrowserAuthority = { owner: string; active: boolean; granted: boolean };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotBrowser(props: BrowserPresentation): BrowserPresentation {
  if (!validateContract('browserPresentation', props).ok) throw Error('Invalid Browser presentation');
  return freeze(structuredClone(props));
}
export function createBrowserPresentation(props: BrowserPresentation, owner: string, current: () => BrowserPresentation, authority: () => BrowserAuthority, dispatch: (action: BrowserAction) => void, applied = new Set<string>()) {
  const captured = snapshotBrowser(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): BrowserAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('browserAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as BrowserAction, live = current();
    if ((['context', 'guest', 'project', 'session', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.busy) return { ok: false, reason: 'Busy' };
    if (action.controlId !== 'navigate' && action.value) return { ok: false, reason: 'InvalidArguments' };
    if (live.watching && !['test', 'close', 'refresh-ports'].includes(action.controlId) || !live.embedded && !['navigate', 'close', 'refresh-ports'].includes(action.controlId) || live.home && ['back', 'forward', 'reload', 'pick', 'capture'].includes(action.controlId) || action.controlId === 'back' && !live.canGoBack || action.controlId === 'forward' && !live.canGoForward || live.loading && ['pick', 'capture'].includes(action.controlId)) return { ok: false, reason: 'UnsupportedCapability' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
