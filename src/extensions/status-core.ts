/** JSON-only captured cached usage, status and progress admission (docs/extensions/status.md); usage reads, the update
 * prompt, notices and their Undo, snapshots and test reports stay in the host. */
import { validateContract } from './contracts.ts';
import { STATUS_CONTROLS, STATUS_PINNED_CONTROLS, STATUS_PROTECTED } from './surfaces.ts';
export type StatusControl = 'usage-open' | 'usage-tab' | 'usage-details' | 'usage-range' | 'usage-breakdown' | 'usage-refresh'
  | 'progress-expand' | 'progress-collapse' | 'progress-prev' | 'progress-next' | 'progress-play' | 'progress-marks' | 'progress-compare' | 'progress-enlarge' | 'progress-thumb'
  | 'jev-open';
export type StatusUsageRead = 'checking' | 'ready' | 'unavailable' | 'signedOut' | 'error' | 'unsupported';
export type StatusJev = 'none' | 'testing' | 'passed' | 'failed' | 'finished' | 'stopped' | 'attention';
export type StatusPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; range: 'week' | 'month' | 'year'; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean;
  usage: boolean; tab: 'closed' | 'overview' | 'provider'; breakdown: 'model' | 'day'; loading: boolean;
  update: boolean; toast: 'hidden' | 'notice' | 'undo' | 'action'; pip: 'hidden' | 'collapsed' | 'expanded'; jev: boolean;
  inventory: boolean;
  providers: readonly Readonly<{ id: string; provider: string; status: StatusUsageRead; peak: number; stale: boolean }>[];
  progress: boolean; iterations: number; iteration: number; jevStatus: StatusJev;
  controls: readonly Readonly<{ id: string; controlId: StatusControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type StatusAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; range: 'week' | 'month' | 'year'; revision: number; control: string; controlId: StatusControl; resource: string; requestId: string }>;
export type StatusAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type StatusAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Refresh asks the providers again (through the native cache and its per-provider limit): it runs only after a fresh host choice. */
export const STATUS_ENTRY_CONTROLS: readonly StatusControl[] = ['usage-refresh'];
/** Controls that act on one captured resource (a tab or harness, a period, a breakdown, an iteration). */
export const STATUS_RESOURCE_CONTROLS: readonly StatusControl[] = ['usage-tab', 'usage-details', 'usage-range', 'usage-breakdown', 'progress-thumb'];

/** One entry per member of the ledger's `panda.status` family plus the `usage` member of `panda.agents`: its public
 * locations, the layout parts and captured actions it supports and the reason for each operation it does not. */
export type StatusRegistryEntry = Readonly<{ member: 'items' | 'toast' | 'progress' | 'jev' | 'usage'; family: 'panda.status' | 'panda.agents'; locations: readonly string[]; parts: readonly string[]; actions: readonly StatusControl[]; order: boolean; hide: boolean; context: string; recipe: boolean; reason: string }>;
const parts = (member: string) => STATUS_CONTROLS.filter(([, , owner]) => owner === member).map(([id]) => id);
const pinned = (member: string) => parts(member).filter(id => STATUS_PINNED_CONTROLS[id]).map(id => `${id}: ${STATUS_PINNED_CONTROLS[id]}`).join(' ');
const protectedReason = (...ids: string[]) => STATUS_PROTECTED.filter(([id]) => ids.includes(id)).map(([, label, why]) => `${label}: ${why}`).join(' ');
export const STATUS_REGISTRY: readonly StatusRegistryEntry[] = Object.freeze([
  { member: 'items', family: 'panda.status', locations: ['panda.status.items', 'panda.status.protected'], parts: parts('items'), actions: [], order: false, hide: false, context: 'none', recipe: false, reason: `Contributed status items keep the existing panda.status.items slot (contribute, hide, show, reorder) beside the prompt; the prompt itself has no layout part, action or recipe. ${protectedReason('update')}` },
  { member: 'toast', family: 'panda.status', locations: ['panda.status.protected'], parts: parts('toast'), actions: [], order: false, hide: false, context: 'none', recipe: false, reason: `A notice is transient live feedback about the user's own work: it never hides, moves or exposes its text; the presentation carries only its kind. ${protectedReason('toast-undo', 'toast-action')}` },
  { member: 'progress', family: 'panda.status', locations: ['panda.status', 'panda.status.controls', 'panda.status.protected'], parts: parts('progress'), actions: ['progress-expand', 'progress-collapse', 'progress-prev', 'progress-next', 'progress-play', 'progress-marks', 'progress-compare', 'progress-enlarge', 'progress-thumb'], order: true, hide: true, context: 'none', recipe: false, reason: `The pill and card have no context menu (a right press is the corner drag's); the large view's accessory band is panda.dialog.progress-lightbox.actions. Collapse (and Escape) is the card's way out and stays put. ${protectedReason('progress-clear')}` },
  { member: 'jev', family: 'panda.status', locations: ['panda.status'], parts: parts('jev'), actions: ['jev-open'], order: false, hide: false, context: 'none', recipe: false, reason: 'The Jev entry is the conversation\'s only way to the task\'s browser test reports and live test status: it never hides, has no sibling to reorder and no context menu; its report stays host-drawn.' },
  { member: 'usage', family: 'panda.agents', locations: ['panda.status', 'panda.status.controls', 'panda.status.context', 'panda.status.protected', 'panda.dialog.usage.actions', 'panda.sidebar.footer'], parts: parts('usage'), actions: ['usage-open', 'usage-tab', 'usage-details', 'usage-range', 'usage-breakdown', 'usage-refresh'], order: true, hide: true, context: 'panda.status.context', recipe: true, reason: `${pinned('usage')} The period and breakdown switches redraw with the overview and are actions, not layout parts. ${protectedReason('usage-reads', 'usage-account')}` },
].map(entry => Object.freeze(entry)) as StatusRegistryEntry[]);

const CAPTURED = ['window', 'context', 'project', 'task', 'provider', 'range', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotStatus(props: StatusPresentation): StatusPresentation {
  if (!validateContract('statusPresentation', props).ok) throw Error('Invalid status presentation');
  if ([props.controls, props.providers].some(list => new Set(list.map(item => item.id)).size !== list.length)) throw Error('Duplicate status handle');
  // Harness and task data are permissioned: without them no read, percent, iteration or test status crosses the boundary.
  if (!props.inventory && props.providers.length) throw Error('Unpermissioned usage data');
  if (!props.progress && (props.iterations || props.iteration || props.jevStatus !== 'none')) throw Error('Unpermissioned task feedback');
  return freeze(structuredClone(props));
}
export function createStatusPresentation(props: StatusPresentation, owner: string, current: () => StatusPresentation, authority: () => StatusAuthority, dispatch: (action: StatusAction) => void, applied = new Set<string>()) {
  const captured = snapshotStatus(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): StatusAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('statusAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as StatusAction, live = current();
    // Switching task, another tab or period, a new iteration, a settled read or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // Another open dialog, a pending host choice or the Clear confirmation keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    // A resource control always names its resource; an iteration acts only under its captured task.
    if (STATUS_RESOURCE_CONTROLS.includes(action.controlId) && action.resource === '' || action.controlId === 'progress-thumb' && !captured.task) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (STATUS_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
