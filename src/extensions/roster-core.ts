/** JSON-only captured agent roster admission (docs/extensions/agent-roster.md); child state, streams, lineage,
 * profiles, the widget's preference and its pinned window stay in the host. */
import { validateContract } from './contracts.ts';
import { ROSTER_CONTROLS, ROSTER_PINNED_CONTROLS, ROSTER_PROTECTED } from './surfaces.ts';
export type RosterControl = 'subagents' | 'subagent-open' | 'subagents-back' | 'subagents-close' | 'subagents-retry' | 'profile-picker' | 'profile-select' | 'profile-manage' | 'profile-create' | 'profile-update' | 'widget' | 'widget-open';
export type RosterChildStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
export type RosterPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; profile: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; view: 'closed' | 'list' | 'detail'; child: string; setup: boolean; widget: boolean; widgetOpen: boolean;
  progress: boolean; running: number;
  children: readonly Readonly<{ id: string; parent: string; status: RosterChildStatus; active: boolean }>[];
  agents: readonly Readonly<{ id: string; status: 'running' | 'waiting' }>[];
  controls: readonly Readonly<{ id: string; controlId: RosterControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type RosterAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; profile: string; revision: number; control: string; controlId: RosterControl; resource: string; requestId: string }>;
export type RosterAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type RosterAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Applying a profile replaces the setup form and Update overwrites a saved profile: both run only after a fresh host choice. */
export const ROSTER_ENTRY_CONTROLS: readonly RosterControl[] = ['profile-select', 'profile-update'];
/** Controls that act on one captured resource (a child of the open task, a saved profile, a running task). */
export const ROSTER_RESOURCE_CONTROLS: readonly RosterControl[] = ['subagent-open', 'profile-select', 'widget-open'];

/** One entry per roster member of the ledger's `panda.agents` family: its public locations, the controls and captured
 * actions it supports and the reason for each operation it does not. */
export type RosterRegistryEntry = Readonly<{ member: 'subagents' | 'profiles' | 'widget'; locations: readonly string[]; parts: readonly string[]; actions: readonly RosterControl[]; order: boolean; hide: boolean; context: string; recipe: boolean; reason: string; lead?: string }>;
const parts = (member: string) => ROSTER_CONTROLS.filter(([, , owner]) => owner === member).map(([id]) => id);
const pinned = (member: string) => parts(member).filter(id => ROSTER_PINNED_CONTROLS[id]).map(id => `${id}: ${ROSTER_PINNED_CONTROLS[id]}`).join(' ');
const protectedReason = (...ids: string[]) => ROSTER_PROTECTED.filter(([id]) => ids.includes(id)).map(([, label, why]) => `${label}: ${why}`).join(' ');
export const ROSTER_REGISTRY: readonly RosterRegistryEntry[] = Object.freeze([
  { member: 'subagents', locations: ['panda.roster', 'panda.roster.controls', 'panda.roster.context', 'panda.roster.protected'], parts: parts('subagents'), actions: ['subagents', 'subagent-open', 'subagents-back', 'subagents-close', 'subagents-retry'], order: true, hide: false, context: 'panda.roster.context', recipe: true, reason: `${pinned('subagents')} Rows move only with the running-first recipe. ${protectedReason('lineage', 'stream', 'stop')}` },
  { member: 'profiles', locations: ['panda.roster.controls', 'panda.roster.protected'], parts: parts('profiles'), actions: ['profile-picker', 'profile-select', 'profile-manage', 'profile-create', 'profile-update'], order: true, hide: true, context: 'none', recipe: false, reason: `${pinned('profiles')} Profiles have no context menu or recipe: they live in the team setup form. ${protectedReason('profile-delete')}` },
  { member: 'widget', locations: ['panda.roster.controls', 'panda.roster.protected'], parts: parts('widget'), actions: ['widget', 'widget-open'], order: true, hide: true, context: 'none', recipe: false, lead: 'T57', reason: `${pinned('widget')} The main-window widget is panda.roster; its pinned auxiliary window, pin and unpin are the window family (T57). ${protectedReason('widget-window', 'widget-preferences')}` },
].map(entry => Object.freeze(entry)) as RosterRegistryEntry[]);

/** The `running-first` recipe: working and waiting children first, start order kept inside each group. */
export function runningFirst(rows: readonly { id: string; active: boolean }[]): string[] {
  return [...rows.filter(row => row.active), ...rows.filter(row => !row.active)].map(row => row.id);
}

const CAPTURED = ['window', 'context', 'project', 'task', 'profile', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotRoster(props: RosterPresentation): RosterPresentation {
  if (!validateContract('rosterPresentation', props).ok) throw Error('Invalid agent roster presentation');
  if ([props.controls, props.children, props.agents].some(list => new Set(list.map(item => item.id)).size !== list.length)) throw Error('Duplicate agent roster handle');
  // Child and running-agent data are permissioned: without it no child, status or count crosses the boundary.
  if (!props.progress && (props.children.length || props.agents.length || props.running)) throw Error('Unpermissioned agent roster data');
  return freeze(structuredClone(props));
}
export function createRosterPresentation(props: RosterPresentation, owner: string, current: () => RosterPresentation, authority: () => RosterAuthority, dispatch: (action: RosterAction) => void, applied = new Set<string>()) {
  const captured = snapshotRoster(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): RosterAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('rosterAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as RosterAction, live = current();
    // Switching task, another profile, a new child or status, opening a child or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, a pending host choice, a pending profile save or an open profile menu keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    // A child acts only under its captured parent task; a resource control always names its resource.
    if (ROSTER_RESOURCE_CONTROLS.includes(action.controlId) && action.resource === '' || action.controlId === 'subagent-open' && !captured.task) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (ROSTER_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
