/** JSON-only captured admission for the transcript extras: a sent message's attachment chips, thread find, a turn's
 * changes card and footer, and the usage-limit card. Attachment contents, the find text, diffs, the limit and
 * connection changes stay in the host. */
import { validateContract } from './contracts.ts';
import { THREAD_ATTACHMENTS_CONTROLS, THREAD_FIND_CONTROLS, THREAD_CHANGES_CONTROLS, THREAD_LIMIT_CONTROLS, THREAD_EXTRAS_PINNED, THREAD_EXTRAS_FIXED, THREAD_EXTRAS_PROTECTED, THREAD_ATTACHMENTS_LOCATION, THREAD_FIND_LOCATION, THREAD_CHANGES_LOCATION, THREAD_LIMIT_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured transcript-extras control ids (`threadExtrasControlId`). */
export const THREAD_EXTRAS_CONTROL_IDS = ['attachment-open', 'find-previous', 'find-next', 'find-close', 'changes-open', 'changes-file', 'changes-run', 'limit-continue', 'limit-switch', 'limit-dismiss', 'limit-resume'] as const;
export type ThreadExtrasControl = typeof THREAD_EXTRAS_CONTROL_IDS[number];
export type ThreadExtrasPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean;
  /** How many attachment chips the open thread shows; never their names, paths or contents. */
  attachments: number;
  /** The find bar is open over this thread; never its text or matches. */
  find: boolean;
  /** Opaque handles of the turns whose changes card or footer shows. */
  turns: readonly string[];
  /** The usage-limit card shows; `provider` is the limited harness's opaque handle ('' without one). */
  limited: boolean; provider: string;
  controls: readonly Readonly<{ id: string; controlId: ThreadExtrasControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type ThreadExtrasAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: ThreadExtrasControl; resource: string; requestId: string }>;
export type ThreadExtrasAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type ThreadExtrasAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Controls that open something outside the transcript, run the project's script or change the limit or the task's
 * connection: each runs its original handler only after a fresh host user choice. The others step or close find or open
 * the host's own diff viewer, and the user acts there. */
export const THREAD_EXTRAS_CHOICE_CONTROLS: readonly ThreadExtrasControl[] = ['attachment-open', 'changes-run', 'limit-continue', 'limit-switch', 'limit-dismiss', 'limit-resume'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. */
export const THREAD_EXTRAS_PROTECTED_CONTROLS = ['attachment-read', 'attachment-reveal', 'find-set-query', 'find-read-matches', 'changes-read-diff', 'limit-set', 'limit-assign-connection', 'limit-switch-provider'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.thread.attachments`, `.find`, `.changes`,
 * `.usage-limit`), with its public locations, the operations it supports and the reason for each it does not. */
export type ThreadExtrasRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const reasons = (location: string) => [...new Set(Object.entries({ ...THREAD_EXTRAS_PINNED, ...THREAD_EXTRAS_FIXED }).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`))].join(' ');
const protectedReason = (...ids: string[]) => THREAD_EXTRAS_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const THREAD_EXTRAS_REGISTRY: readonly ThreadExtrasRegistryEntry[] = Object.freeze([
  { member: 'panda.thread.attachments', source: 'src/message-attachments.ts', locations: ['panda.thread.attachments.actions', THREAD_ATTACHMENTS_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION], controls: THREAD_ATTACHMENTS_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.thread.attachments.actions', selection: 'message-attachment', reason: `Chips of one kind hide and reorder together; every chip still opens its own attachment through the original handler, after a fresh host choice when a package asks. ${protectedReason('attachment-content')}` },
  { member: 'panda.thread.find', source: 'src/thread-find.ts', locations: ['panda.thread.find.actions', THREAD_FIND_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION], controls: THREAD_FIND_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.thread.find.actions', selection: 'find', reason: `${reasons(THREAD_FIND_LOCATION)} Contributed actions mount after the field without moving focus; stepping or closing never takes the field's text or composition. ${protectedReason('find-input')}` },
  { member: 'panda.thread.changes', source: 'src/turn-changes.ts', locations: ['panda.thread.changes.actions', THREAD_CHANGES_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION], controls: THREAD_CHANGES_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.thread.changes.actions', selection: 'turn-changes', reason: `${reasons(THREAD_CHANGES_LOCATION)} Run needs a fresh host choice. ${protectedReason('diff-content')}` },
  { member: 'panda.thread.usage-limit', source: 'src/usage-limit.ts', locations: ['panda.thread.usage-limit.actions', THREAD_LIMIT_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION], controls: THREAD_LIMIT_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.thread.usage-limit.actions', selection: 'usage-limit', reason: `${reasons(THREAD_LIMIT_LOCATION)} Continue, Continue on <connection>, Dismiss and Resume at reset need a fresh host choice. ${protectedReason('limit-state', 'connection-assign')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotThreadExtras(props: ThreadExtrasPresentation): ThreadExtrasPresentation {
  if (!validateContract('threadExtrasPresentation', props).ok) throw Error('Invalid thread extras presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate thread extras handle');
  return freeze(structuredClone(props));
}
export function createThreadExtrasControls(props: ThreadExtrasPresentation, owner: string, current: () => ThreadExtrasPresentation, authority: () => ThreadExtrasAuthority, dispatch: (action: ThreadExtrasAction) => void, applied = new Set<string>()) {
  const captured = snapshotThreadExtras(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): ThreadExtrasAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((THREAD_EXTRAS_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('threadExtrasAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as ThreadExtrasAction, live = current();
    // Switching task, a new turn, another query, a changed limit or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, menu, IME composition in the find field or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (THREAD_EXTRAS_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
