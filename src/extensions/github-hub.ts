/** JSON-only captured GitHub hub admission; original host policy remains authoritative. */
import { validateContract } from './contracts.ts';
export type GithubHubControl = 'repo' | 'tab' | 'refresh' | 'other' | 'clone' | 'open' | 'task' | 'review' | 'pull-menu' | 'runs' | 'issue-thread' | 'solve' | 'fix' | 'details' | 'workflow' | 'clear' | 'repo-filter' | 'query' | 'event' | 'pull' | 'latest' | 'compose';
export type GithubHubRow = Readonly<{ id: string; kind: 'repo' | 'thread' | 'pull' | 'issue' | 'run'; title: string; revision: number; attempt: number; expanded: boolean; loading: boolean; error: boolean }>;
export type GithubHubPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; repository: string; project: string; tab: string; revision: number; visible: boolean; loading: boolean; busy: boolean; offline: boolean; error: boolean; query: string; filter: string; truncated: boolean; rows: readonly GithubHubRow[]; controls: readonly Readonly<{ id: string; controlId: GithubHubControl; resource: string; attempt: number; enabled: boolean }>[] }>;
export type GithubHubAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; repository: string; project: string; tab: string; revision: number; control: string; resource: string; attempt: number; controlId: GithubHubControl; value: string; requestId: string }>;
export type GithubHubAuthority = { owner: string; active: boolean; granted: boolean; taskControl: boolean; userChoice: boolean };
export type GithubHubAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotGithubHub(props: GithubHubPresentation): GithubHubPresentation {
  if (!validateContract('githubHubPresentation', props).ok) throw Error('Invalid GitHub hub presentation');
  if (new Set(props.rows.map(row => row.id)).size !== props.rows.length || new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate GitHub hub resource');
  return freeze(structuredClone(props));
}
export function createGithubHubPresentation(props: GithubHubPresentation, owner: string, current: () => GithubHubPresentation, authority: () => GithubHubAuthority, dispatch: (action: GithubHubAction) => void, applied = new Set<string>(), validValue: (action: GithubHubAction) => boolean = () => true) {
  const captured = snapshotGithubHub(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): GithubHubAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('githubHubAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as GithubHubAction, live = current();
    if ((['window', 'context', 'repository', 'project', 'tab', 'revision'] as const).some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (live.offline) return { ok: false, reason: 'Offline' };
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.attempt !== action.attempt || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (['review', 'issue-thread', 'solve', 'fix', 'workflow', 'compose'].includes(action.controlId) && !auth.taskControl || ['clone', 'open'].includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (!['repo-filter', 'query', 'event', 'pull', 'latest'].includes(action.controlId) && action.value) return { ok: false, reason: 'InvalidArguments' };
    if (action.controlId === 'latest' && !['true', 'false'].includes(action.value) || !validValue(action)) return { ok: false, reason: 'InvalidArguments' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
